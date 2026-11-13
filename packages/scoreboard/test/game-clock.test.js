// GAME CLOCK = estimated time LEFT, never time spent (design decision 2026-11-13): counts down second by second,
// stops during waits, adjusts only visibly on new evidence, counts up in OVERTIME, shows 0:00 when the period is over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { Board, CLOCK_RULES } from "../src/board.js";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
let n = 0;
const S = { id: "sess-gc", project: "proj" };
const ev = (t, kind, extra = {}) => { const { actor = { type: "main" }, payload, parent, task, source = "claude-hooks", durationMs, observed = true } = extra; return makeEvent({ id: `evt_gc_${String(++n).padStart(6, "0")}`, ts: T0 + t * 1000, source, kind, session: S, actor, parent, task, payload, durationMs, provenance: { observed, adapter: "test", confidence: 1 } }); };
const at = (t) => T0 + t * 1000;
const tool = (t, name = "Edit") => ev(t, "tool.result", { payload: { tool: name }, parent: { toolUseId: `tu${t}` }, durationMs: 0 });
const human = { type: "human" };
// A period with a declared estimate and no history: the prior, low confidence → a labelled estimate with a range.
function declared(p50Min = 10) {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: human, payload: { promptLen: 500 } }));
  b.apply(ev(1, "task.start", { source: "marks", actor: human, task: { id: "T1", title: "x" } }));
  b.apply(ev(2, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min } }));
  return b;
}
const snap = (b, t) => b.snapshot("sess-gc", at(t));

test("counts DOWN second by second from the first usable estimate, even at low confidence (labelled, with a range)", () => {
  const b = declared(10); b.apply(tool(10));
  const a = snap(b, 60);
  assert.equal(a.game.mode, "countdown"); assert.equal(a.game.estimate, true); assert.equal(a.game.confidence, "low");
  assert.ok(a.game.range.loMs < a.game.remainingMs && a.game.remainingMs < a.game.range.hiMs, "p10 < p50 < p90");
  assert.equal(a.gameClock.value, a.game.remainingMs); assert.equal(a.gameClock.basis, "predicted");
  for (const dt of [1, 2, 10, 45]) {
    if (dt === 45) b.apply(tool(100));
    const z = snap(b, 60 + dt);
    assert.equal(z.game.mode, "countdown");
    assert.equal(a.game.remainingMs - z.game.remainingMs, dt * 1000, `exactly ${dt} s less after ${dt} s of work`);
    assert.equal(a.game.range.hiMs - z.game.range.hiMs, dt * 1000, "the range runs down with it");
    assert.equal(z.game.adjustment, null); assert.equal(z.game.adjustments, 0, "time passing alone never re-sets the clock");
  }
});

test("never shows time spent: no elapsed fields; unknown without an estimate; 0:00 when the period is over", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: human, payload: { promptLen: 500 } })); b.apply(tool(30));
  let s = snap(b, 40);
  assert.equal(s.game.mode, "unknown"); assert.equal(s.gameClock.value, null); assert.equal(s.gameClock.basis, "unavailable");
  assert.equal("elapsed" in s, false); assert.equal("wallElapsed" in s, false);
  assert.ok(s.stopwatch.activeMs > 0, "time spent is still measured (for estimation), just not displayed");
  b.apply(ev(50, "turn.stop"));
  s = snap(b, 60);
  assert.equal(s.game.mode, "final"); assert.equal(s.gameClock.value, 0);
  assert.equal(JSON.stringify(s.game).includes("elapsed"), false);
});

test("stops during an approval, a question and a rate limit; resumes with the work", () => {
  const b = declared(10); b.apply(tool(10));
  const base = snap(b, 60).game.remainingMs;
  b.apply(ev(60, "notification", { payload: { kind: "permission_prompt" } }));
  let s = snap(b, 120);
  assert.equal(s.game.remainingMs, base, "held for the whole approval"); assert.equal(s.game.stopped.kind, "approval");
  b.apply(tool(130, "Bash")); // approved: the tool started at 130
  s = snap(b, 140);
  assert.equal(s.game.stopped, null); assert.equal(base - s.game.remainingMs, 10e3, "only the 10 s after the approval ran off");
  b.apply(ev(150, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "ask1" } }));
  const q = snap(b, 150).game.remainingMs;
  assert.equal(snap(b, 400).game.remainingMs, q, "held while the question is open"); assert.equal(snap(b, 400).game.stopped.kind, "question");
  b.apply(ev(410, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "ask1" }, durationMs: 260e3 }));
  b.apply(tool(420));
  const r = snap(b, 430).game.remainingMs;
  b.apply(ev(430, "api.error", { source: "claude-transcript", actor: { type: "system" }, payload: { error: "rate_limit", status: 429, resetsAt: "2026-11-13T11:00:00.000Z", endsTurn: true } }));
  s = snap(b, 30 * 60);
  assert.equal(s.game.remainingMs, r, "held through the rate limit"); assert.equal(s.game.stopped.kind, "rate_limit");
});

test("a new estimate adjusts the clock visibly (shown for adjustShowMs), never silently", () => {
  const b = declared(10); b.apply(tool(10));
  const before = snap(b, 60).game.remainingMs;
  b.apply(ev(60, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 20 } }));
  const s = snap(b, 61);
  assert.equal(s.game.adjustments, 1);
  const adj = s.game.adjustment;
  assert.ok(adj, "the adjustment is on the snapshot"); assert.equal(adj.reason, "declared estimate changed"); assert.equal(adj.fromOvertime, false);
  assert.equal(adj.fromMs, before - 1000); assert.equal(adj.toMs, s.game.remainingMs); assert.ok(adj.deltaMs > 4 * 60e3, `a later estimate adds time, got ${adj.deltaMs}`);
  assert.ok(snap(b, 61 + CLOCK_RULES.adjustShowMs / 1000 - 1).game.adjustment, "still shown");
  b.apply(tool(100));
  const later = snap(b, 61 + CLOCK_RULES.adjustShowMs / 1000 + 1);
  assert.equal(later.game.adjustment, null, "the notice clears"); assert.equal(later.game.adjustments, 1, "the record stays");
  assert.equal(s.game.remainingMs - later.game.remainingMs, (CLOCK_RULES.adjustShowMs / 1000 + 1) * 1000, "and the clock runs down again from the new value");
  // re-declaring the same estimate is no new evidence: nothing moves
  b.apply(ev(200, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 20 } }));
  assert.equal(snap(b, 201).game.adjustments, 1);
});

test("at 0:00 OVERTIME counts UP from zero while work continues; a new estimate is a clearly marked CLOCK RESET", () => {
  const b = declared(1); // one declared minute
  b.apply(tool(5));
  const start = snap(b, 6).game;
  const target = start.target.activeMs;
  for (let t = 30; t <= 600; t += 30) b.apply(tool(t));
  const ot = snap(b, 600).game;
  assert.equal(ot.mode, "overtime"); assert.ok(ot.overtimeMs > 0);
  const ot2 = snap(b, 610).game;
  assert.equal(ot2.overtimeMs - ot.overtimeMs, 10e3, "counts up second by second");
  assert.equal(ot2.target.activeMs, target, "the expired estimate is not silently replaced");
  b.apply(ev(610, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 30 } }));
  const reset = snap(b, 611).game;
  assert.equal(reset.adjustment.fromOvertime, true, "shown as a clock reset");
  assert.equal(reset.mode, "countdown");
  b.apply(ev(620, "task.end", { source: "marks", actor: human, task: { id: "T1" } })); // a marked task ends with its mark
  const fin = snap(b, 630);
  assert.equal(fin.game.mode, "final"); assert.equal(fin.gameClock.value, 0);
});

// Regressions.
test("a long silent tool run that the stall rule had stopped is counted visibly when its result arrives (no silent jump)", () => {
  const b = declared(30); b.apply(tool(10));
  const a = snap(b, 500).game.remainingMs;
  const held = snap(b, 700).game;
  assert.equal(held.stopped.state, "unknown", "10 min of silence: the stall rule stops the clock");
  assert.equal(snap(b, 1000).game.remainingMs, held.remainingMs);
  b.apply(ev(1210, "tool.result", { payload: { tool: "Bash" }, parent: { toolUseId: "long1" }, durationMs: 1200e3 }));
  const g = snap(b, 1211).game;
  assert.ok(g.remainingMs < held.remainingMs - 5 * 60e3, "the tool's run time is now active time");
  assert.equal(g.adjustments, 1); assert.equal(g.adjustment.reason, "long silent tool run counted");
  assert.ok(g.adjustment.deltaMs < 0); assert.equal(g.adjustment.fromMs, held.remainingMs); assert.equal(g.adjustment.toMs - g.adjustment.fromMs, g.adjustment.deltaMs);
  assert.ok(a > held.remainingMs);
});

test("a question answered through a transcript-sourced result releases the clock (the tool.call wait never leaks)", () => {
  const b = declared(30); b.apply(tool(10));
  b.apply(ev(20, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "askT" } }));
  assert.equal(snap(b, 100).game.stopped.kind, "question");
  b.apply(ev(300, "tool.result", { source: "claude-transcript", payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "askT" }, durationMs: 280e3 }));
  const g1 = snap(b, 310).game;
  assert.equal(g1.stopped, null, "running again after the answer");
  assert.equal(g1.remainingMs - snap(b, 320).game.remainingMs, 10e3);
});

test("an adjustment made while the clock is stopped stays on show until the clock has run adjustShowMs", () => {
  const b = declared(10); b.apply(tool(10));
  snap(b, 60);
  b.apply(ev(60, "notification", { payload: { kind: "permission_prompt" } }));
  b.apply(ev(70, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 25 } }));
  assert.ok(snap(b, 71).game.adjustment);
  assert.ok(snap(b, 400).game.adjustment, "five minutes into the approval: still shown");
  b.apply(tool(410, "Bash"));
  assert.ok(snap(b, 420).game.adjustment, "10 s after resuming: still shown");
  b.apply(tool(450));
  assert.equal(snap(b, 410 + CLOCK_RULES.adjustShowMs / 1000 + 1).game.adjustment, null, "gone after the clock ran adjustShowMs");
});
