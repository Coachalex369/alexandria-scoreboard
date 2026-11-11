import { test } from "node:test";
import assert from "node:assert/strict";
import { PredictionLog } from "../src/eta.js";
import { AlertPolicy } from "../src/alerts.js";
import { FONT, glyph, fitNumber, fitClock, fitText, COLS, ROWS } from "../src/digits.js";

const est = (log, id, p50, ts = "2026-11-09T10:00:00.000Z", calls = null) => log.onEstimate({ ts, session: { id: "s", project: "p" }, payload: { p50Min: p50, p90Min: p50 * 2, calls } }, { id, title: id, toolCalls: 0 });
const end = (log, id, actualMin, calls = 10) => log.onTaskEnd({ ts: "2026-11-09T11:00:00.000Z" }, { id, toolCalls: calls }, actualMin * 60000);

test("bias k is identity until three completed predictions, then exp(−median log ratio), clamped", () => {
  const log = new PredictionLog();
  assert.equal(log.biasK(), 1);
  est(log, "a", 20); end(log, "a", 10);   // ratio 2
  est(log, "b", 30); end(log, "b", 10);   // ratio 3
  assert.equal(log.biasK(), 1, "two samples: still identity");
  est(log, "c", 40); end(log, "c", 10);   // ratio 4 → median 3 → k = 1/3
  assert.ok(Math.abs(log.biasK() - 1 / 3) < 1e-9);
  const c = log.calibration(); assert.equal(c.n, 3); assert.equal(c.medianRatio, 3); assert.equal(c.within2x, 1);
  for (const id of ["d", "e", "f", "g"]) { est(log, id, 100); end(log, id, 1); }
  assert.equal(log.biasK(), 0.25, "clamped at 0.25");
});

test("the k applied at estimate time is kept for the open task; ETA counts down work time and reports overdue", () => {
  const log = new PredictionLog();
  for (const [id, p50, act] of [["a", 20, 10], ["b", 20, 10], ["c", 20, 10]]) { est(log, id, p50); end(log, id, act); }
  assert.equal(log.biasK(), 0.5);
  const rec = est(log, "open", 30, "2026-11-09T12:00:00.000Z", 50);
  assert.equal(rec.k, 0.5); assert.equal(rec.etaMinApplied, 15);
  const task = { id: "open", estimate: { p50Min: 30, p90Min: 60, calls: 50 }, toolCalls: 0 };
  let e = log.etaFor(task, 5 * 60000);
  assert.equal(e.remainingMs, 10 * 60000); assert.equal(e.overdueMs, 0); assert.equal(e.p90RemainingMs, 25 * 60000); assert.match(e.note, /bias 0.50/);
  e = log.etaFor(task, 20 * 60000);
  assert.equal(e.remainingMs, 0); assert.equal(e.overdueMs, 5 * 60000);
  assert.equal(log.etaFor({ id: "x", estimate: null }, 0), null, "no estimate → no ETA");
  assert.equal(log.etaFor({ id: "x", estimate: { calls: 5 } }, 0), null, "calls alone give no time estimate");
});

test("re-estimating an open task replaces its open record; history seeds from a previous run", () => {
  const log = new PredictionLog([{ taskId: "old", session: "s", completedAt: "x", errorRatio: 2, p50Min: 2, actualWorkMin: 1 }]);
  est(log, "t", 10); est(log, "t", 12);
  assert.equal(log.history.filter((r) => r.taskId === "t").length, 1);
  assert.equal(log.history[0].taskId, "old"); assert.equal(log.calibration().n, 1);
});

test("alert policy suppresses repeats, spaces sounds, keeps quiet alerts silent, caps the visible list", () => {
  const p = new AlertPolicy({ repeatMs: 10000, minSoundGapMs: 2500, maxVisible: 3 });
  const a = (kind, text = kind, quiet = false, session = "s") => ({ ts: "2026-11-09T10:00:00.000Z", kind, text, session, project: "p", quiet });
  let r = p.decide([a("permission"), a("permission"), a("test-failure", "tests failed · 2 of 10"), a("turn", "turn complete", true)], 1000);
  assert.equal(r.visible.length, 3, "duplicate suppressed; quiet alert still visible");
  assert.deepEqual(r.sounds, ["whistle"], "second sound inside the gap is dropped; quiet alerts never sound");
  r = p.decide([a("permission")], 5000); assert.equal(r.visible.length, 0, "same alert again within 10 s is suppressed");
  r = p.decide([a("completed", "task complete · T")], 5000); assert.deepEqual(r.sounds, ["horn"]);
  r = p.decide([a("permission")], 20000); assert.equal(r.visible.length, 1); assert.equal(r.visible[0].level, "attention");
  r = p.decide([a("x1"), a("x2"), a("x3"), a("x4")], 30000); assert.equal(r.visible.length, 3, "capped at maxVisible, newest kept"); assert.equal(r.visible[2].kind, "x4");
});

test("dot-matrix font covers digits, letters and punctuation with 5×7 glyphs", () => {
  for (const ch of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ -:./+!?·") {
    const g = glyph(ch); assert.equal(g.length, ROWS, `${ch} rows`); for (const row of g) assert.match(row, new RegExp(`^[01]{${COLS}}$`), `${ch} row ${row}`);
  }
  assert.equal(glyph("b"), FONT.B, "lower case maps to upper"); assert.equal(glyph("€"), FONT["?"], "unknown glyph falls back to ?");
});

test("display fitting: right-aligned numbers, caps, dashes for unavailable, clocks roll to hours", () => {
  assert.equal(fitNumber(7, 3), "  7"); assert.equal(fitNumber(1234, 3), "999"); assert.equal(fitNumber(null, 3), "---"); assert.equal(fitNumber(-4, 2), " 0"); assert.equal(fitNumber(null, 2, { dashes: false }), "  ");
  assert.deepEqual(fitClock(5 * 60000 + 7000), { text: " 5:07", hours: false });
  assert.deepEqual(fitClock(59 * 60000 + 59000), { text: "59:59", hours: false });
  assert.deepEqual(fitClock(3600000 + 2 * 60000), { text: " 1:02", hours: true });
  assert.deepEqual(fitClock(null), { text: "--:--", hours: false });
  assert.equal(fitText("build · main", 8), "BUILD · ");
});
