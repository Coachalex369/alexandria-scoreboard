import { test } from "node:test";
import assert from "node:assert/strict";
import { Stopwatch } from "../src/stopwatch.js";
import { estimate, quantile, lognormalGrid } from "../src/estimator.js";
import { evaluate, metrics } from "../src/calibration.js";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const m = (min) => T0 + min * 60e3;
const MIN = 60e3;

test("owner time between a turn close and the next turn open is waiting, not active", () => {
  const sw = new Stopwatch();
  sw.push({ ts: m(0), type: "start" }).push({ ts: m(5), type: "turn.close" }).push({ ts: m(15), type: "turn.open" }).push({ ts: m(20), type: "end" });
  const t = sw.totals(m(30));
  assert.equal(t.activeMs, 10 * MIN); assert.equal(t.byKind.owner, 10 * MIN); assert.equal(t.wallMs, 20 * MIN); assert.equal(t.state, "ended");
});

test("approval, question, rate limit and api-error waits never count as active, and the clock reports the wait", () => {
  const sw = new Stopwatch();
  sw.push({ ts: m(0), type: "start" })
    .push({ ts: m(2), type: "wait.begin", kind: "approval" }).push({ ts: m(4), type: "wait.end", kind: "approval" })
    .push({ ts: m(6), type: "wait.begin", kind: "question" }).push({ ts: m(9), type: "wait.end", kind: "question" })
    .push({ ts: m(10), type: "wait.begin", kind: "rate_limit" });
  const live = sw.totals(m(40));
  assert.equal(live.state, "waiting"); assert.equal(live.kind, "rate_limit"); assert.equal(live.since, m(10));
  assert.equal(live.activeMs, (2 + 2 + 1) * MIN); assert.equal(live.byKind.approval, 2 * MIN); assert.equal(live.byKind.question, 3 * MIN); assert.equal(live.byKind.rate_limit, 30 * MIN);
  sw.push({ ts: m(41), type: "wait.end", kind: "rate_limit" }).push({ ts: m(45), type: "end" });
  assert.equal(sw.totals(m(50)).activeMs, (5 + 4) * MIN);
});

test("silence inside an open turn becomes unknown after stallMs, and later execution evidence reclaims it", () => {
  const sw = new Stopwatch({ stallMs: 10 * MIN });
  sw.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "activity" });
  let t = sw.totals(m(31));
  assert.equal(t.state, "unknown"); assert.equal(t.activeMs, 11 * MIN); assert.equal(t.unknownMs, 20 * MIN);
  // a test suite that ran from minute 2 to minute 31 reports its duration when it finishes
  sw.push({ ts: m(31), type: "activity", sinceTs: m(2) });
  t = sw.totals(m(31)); assert.equal(t.unknownMs, 0); assert.equal(t.activeMs, 31 * MIN); assert.equal(t.state, "active");
});

test("a silence that ends at the next prompt or the task end, not at work, is unknown for its whole length", () => {
  const sw = new Stopwatch({ stallMs: 10 * MIN });
  sw.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "activity" }).push({ ts: m(300), type: "turn.open" }).push({ ts: m(302), type: "activity" }).push({ ts: m(302), type: "end" });
  const t = sw.totals(m(400));
  assert.equal(t.activeMs, 3 * MIN, "1 min before the silence + 2 min after the next prompt; no stall credit");
  assert.equal(t.unknownMs, 299 * MIN);
  const live = new Stopwatch({ stallMs: 10 * MIN }); live.push({ ts: m(0), type: "start" });
  assert.equal(live.totals(m(30)).activeMs, 10 * MIN, "live, the open end still earns stall credit until evidence decides");
});

test("a subagent span keeps the clock active while the owner is away; a lost stop is capped at last evidence + stallMs", () => {
  const sw = new Stopwatch({ stallMs: 5 * MIN });
  sw.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "span.begin", key: "a1" }).push({ ts: m(2), type: "turn.close" })
    .push({ ts: m(8), type: "span.end", key: "a1" }).push({ ts: m(12), type: "turn.open" }).push({ ts: m(13), type: "end" });
  const t = sw.totals(m(20));
  assert.equal(t.activeMs, (8 + 1) * MIN); assert.equal(t.byKind.owner, 4 * MIN);
  const lost = new Stopwatch({ stallMs: 5 * MIN });
  lost.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "span.begin", key: "a" }).push({ ts: m(1), type: "turn.close" }).push({ ts: m(3), type: "span.touch", key: "a" });
  const lt = lost.totals(m(60));
  assert.equal(lt.activeMs, (1 + 7) * MIN, "span open from 1 to 3 + 5 min cap"); assert.equal(lt.byKind.owner, 52 * MIN);
});

test("declared pause outranks everything; approval outranks concurrent execution evidence", () => {
  const sw = new Stopwatch();
  sw.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "pause", basis: "declared" }).push({ ts: m(1), type: "activity", sinceTs: m(0) }).push({ ts: m(3), type: "activity", sinceTs: m(2) }).push({ ts: m(4), type: "resume" })
    .push({ ts: m(5), type: "wait.begin", kind: "approval" }).push({ ts: m(7), type: "activity", sinceTs: m(5.5) }).push({ ts: m(6), type: "wait.end", kind: "approval" }).push({ ts: m(8), type: "end" });
  const t = sw.totals(m(9));
  assert.equal(t.pausedMs, 3 * MIN); assert.equal(t.byKind.approval, 1 * MIN); assert.equal(t.activeMs, 4 * MIN);
  const seg = sw.timeline(m(9)).find((s) => s.state === "paused"); assert.equal(seg.basis, "declared");
});

test("signal order does not matter: replaying the same signals shuffled gives identical totals (restart recovery)", () => {
  const sigs = [{ ts: m(0), type: "start" }, { ts: m(3), type: "wait.begin", kind: "approval" }, { ts: m(4), type: "wait.end", kind: "approval" }, { ts: m(9), type: "turn.close" }, { ts: m(14), type: "turn.open" }, { ts: m(15), type: "activity", sinceTs: m(14.5) }, { ts: m(30), type: "end" }];
  const a = new Stopwatch(); sigs.forEach((s) => a.push(s));
  const b = new Stopwatch(); [...sigs].reverse().forEach((s) => b.push(s));
  assert.deepEqual(a.totals(m(31)), b.totals(m(31))); assert.deepEqual(a.timeline(m(31)), b.timeline(m(31)));
});

test("waiting segments carry the basis of their evidence; an inferred end makes the segment inferred", () => {
  const sw = new Stopwatch();
  sw.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "wait.begin", kind: "approval", basis: "observed" }).push({ ts: m(2), type: "wait.end", kind: "approval", basis: "inferred" });
  const w = sw.timeline(m(3)).find((s) => s.state === "waiting"); assert.equal(w.basis, "inferred");
});

// ---------------- estimator ----------------
const hist = (n, ms, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, features: { type: "build", regime: "brief", model: "opus", ...extra.features }, declared: extra.declared ?? null, actualActiveMs: ms(i), startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-01T01:00:00.000Z" }));

test("estimator refuses to invent a number without a declared estimate or enough comparable history", () => {
  const e = estimate({ features: { type: "build", regime: "brief" }, history: hist(3, () => 10 * MIN) });
  assert.equal(e.state, "insufficient-data"); assert.equal(e.remaining, null); assert.equal(e.confidence, "none");
});

test("reference class: remaining time comes from the samples above elapsed time and GROWS on a heavy tail", () => {
  const h = hist(20, (i) => (i < 15 ? 5 : 60) * MIN); // most tasks 5 min, a quarter take an hour
  const fresh = estimate({ features: { type: "build", regime: "brief" }, history: h, progress: { activeMs: 0 } });
  const late = estimate({ features: { type: "build", regime: "brief" }, history: h, progress: { activeMs: 10 * MIN } });
  assert.equal(fresh.method, "reference-class"); assert.equal(fresh.n, 20);
  assert.ok(fresh.remaining.p50 <= 5 * MIN);
  assert.ok(late.remaining.p50 > fresh.remaining.p50, "a task past the common case has more expected time left, not less");
  assert.ok(late.remaining.p10 <= late.remaining.p50 && late.remaining.p50 <= late.remaining.p90);
});

test("beyond history: a lower bound only, no p50", () => {
  const e = estimate({ features: { type: "build", regime: "brief" }, history: hist(10, () => 5 * MIN), progress: { activeMs: 30 * MIN } });
  assert.equal(e.state, "beyond-history"); assert.equal(e.remaining.p50, null);
});

test("declared estimate: a wide labelled prior until calibrated, then scaled by measured actual/declared ratios", () => {
  const prior = estimate({ features: { type: "build", regime: "marked" }, declared: { p50Min: 20 }, history: [] });
  assert.equal(prior.method, "prior"); assert.equal(prior.confidence, "low");
  assert.ok(Math.abs(prior.total.p50 - 20 * MIN) < 0.5 * MIN); assert.ok(prior.total.p90 / prior.total.p10 > 5, "the prior band is wide");
  const h = hist(8, () => 5 * MIN, { declared: { p50Min: 20 }, features: { regime: "marked" } }); // declared 20, took 5 every time
  const cal = estimate({ features: { type: "build", regime: "marked" }, declared: { p50Min: 40 }, history: h });
  assert.equal(cal.method, "declared-calibrated"); assert.equal(cal.total.p50, 10 * MIN, "40 × measured ratio 0.25");
});

test("strata back off from the narrowest group with enough tasks", () => {
  const h = [...hist(6, () => 10 * MIN, { features: { type: "test" } }), ...hist(3, () => 99 * MIN, { features: { type: "build", model: "haiku" } })];
  const e = estimate({ features: { type: "build", regime: "brief", model: "haiku" }, history: h });
  assert.equal(e.stratum, "regime=brief"); assert.equal(e.n, 9);
});

test("declared calls blend this task's own pace into the remaining time", () => {
  const h = hist(8, () => 20 * MIN, { declared: { p50Min: 20 } });
  const slow = estimate({ features: { type: "build", regime: "brief", model: "opus" }, declared: { p50Min: 20, calls: 40 }, progress: { activeMs: 10 * MIN, calls: 10 }, history: h });
  const plain = estimate({ features: { type: "build", regime: "brief", model: "opus" }, declared: { p50Min: 20 }, progress: { activeMs: 10 * MIN }, history: h });
  assert.ok(slow.pace && slow.pace.callsLeft === 30); assert.ok(slow.remaining.p50 > plain.remaining.p50, "a quarter of the calls in half the time → more left");
});

test("quantile and prior grid are deterministic and ordered", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3); assert.equal(quantile([0, 10], 0.1), 1);
  const g = lognormalGrid(100, 0.75, 41); assert.equal(g.length, 41); assert.ok(Math.abs(g[20] - 100) < 1e-6); assert.ok(g.every((v, i) => !i || v > g[i - 1]));
});

// ---------------- evaluation ----------------
test("evaluation never trains on overlapping, later or held-out tasks", () => {
  const day = (d, h) => `2026-11-0${d}T${String(h).padStart(2, "0")}:00:00.000Z`;
  const tasks = [];
  for (let i = 0; i < 8; i++) tasks.push({ id: `a${i}`, features: { regime: "brief" }, actualActiveMs: 10 * MIN, startedAt: day(1, i), endedAt: day(1, i) .replace(":00:00", ":30:00") });
  tasks.push({ id: "hold", features: { regime: "brief" }, actualActiveMs: 1000 * MIN, startedAt: day(2, 1), endedAt: day(2, 2) });
  tasks.push({ id: "overlap", features: { regime: "brief" }, actualActiveMs: 1000 * MIN, startedAt: day(3, 1), endedAt: day(3, 5) });
  tasks.push({ id: "target", features: { regime: "brief" }, actualActiveMs: 10 * MIN, startedAt: day(3, 2), endedAt: day(3, 3) });
  const r = evaluate(tasks, { holdout: new Set(["hold"]), checkpoints: [0] });
  const p = r.predictions.find((x) => x.id === "target");
  assert.equal(p.trainN, 8, "held-out and overlapping tasks excluded"); assert.equal(p.p50, 10 * MIN);
  assert.equal(r.predictions.find((x) => x.id === "a0").state, "insufficient-data");
  assert.equal(r.predictions.find((x) => x.id === "hold").heldOut, true);
});

test("metrics: perfect predictions score zero error and full coverage", () => {
  const mm = metrics([{ p10: 5, p50: 10, p90: 20, actualMs: 10 }, { p10: 1, p50: 2, p90: 4, actualMs: 8, state: "estimating" }, { state: "insufficient-data", p50: null, actualMs: 3 }]);
  assert.equal(mm.n, 2); assert.equal(mm.insufficient, 1); assert.equal(mm.within2x, 0.5); assert.equal(mm.coverage80, 0.5); assert.equal(mm.sharpness, 4);
});

test("confidence needs sample size, measured coverage and a narrow range", async () => {
  const { confidenceOf } = await import("../src/estimator.js");
  const cal = { n: 100, coverage80: 0.8 };
  assert.equal(confidenceOf("reference-class", 200, cal, undefined, 18), "low", "calibrated but 18× wide is low");
  assert.equal(confidenceOf("reference-class", 200, cal, undefined, 2.5), "high");
  assert.equal(confidenceOf("reference-class", 200, { n: 100, coverage80: 0.4 }, undefined, 2.5), "low", "ranges that missed in backtests");
  assert.equal(confidenceOf("reference-class", 15, null, undefined, 4), "low", "medium needs measured coverage too");
  assert.equal(confidenceOf("reference-class", 15, cal, undefined, 4), "medium");
  assert.equal(confidenceOf("prior", 0, cal, undefined, 2), "low"); assert.equal(confidenceOf("none", 0, cal), "none");
});

// Regressions from the independent review (eval run T07, findings confirmed by the main session).
test("review fixes: same-instant transitions are order-independent; unlisted wait kinds close; bad sinceTs ignored; spans keep their start; mixed-basis merge is inferred", async () => {
  const { mergeIntervals } = await import("../src/stopwatch.js");
  const sigs = [{ ts: m(0), type: "start" }, { ts: m(5), type: "turn.close" }, { ts: m(5), type: "wait.end" }, { ts: m(5), type: "wait.begin", kind: "rate_limit" }, { ts: m(9), type: "wait.end", kind: "rate_limit" }, { ts: m(9), type: "turn.open" }, { ts: m(10), type: "end" }];
  const a = new Stopwatch(); sigs.forEach((s) => a.push(s)); const b = new Stopwatch(); [...sigs].reverse().forEach((s) => b.push(s));
  assert.deepEqual(a.totals(m(10)), b.totals(m(10))); assert.equal(a.totals(m(10)).byKind.rate_limit, 4 * MIN);
  const ci = new Stopwatch(); ci.push({ ts: m(0), type: "start" }).push({ ts: m(1), type: "wait.begin", kind: "ci" }).push({ ts: m(3), type: "wait.end", kind: "ci" });
  assert.equal(ci.totals(m(10)).byKind.external, 2 * MIN, "an unlisted kind is external on both ends");
  const bad = new Stopwatch(); bad.push({ ts: m(0), type: "start" }).push({ ts: m(2), type: "activity", sinceTs: "garbage" }).push({ ts: new Date(m(4)), type: "end" });
  assert.equal(bad.totals(m(5)).activeMs, 4 * MIN, "Date accepted, non-finite sinceTs treated as a point");
  const sp = new Stopwatch(); sp.push({ ts: m(0), type: "start" }).push({ ts: m(0), type: "turn.close" }).push({ ts: m(1), type: "span.begin", key: "a" }).push({ ts: m(3), type: "span.begin", key: "a" }).push({ ts: m(4), type: "span.end", key: "a" });
  assert.equal(sp.totals(m(4)).activeMs, 3 * MIN, "a repeated span.begin keeps the first start");
  assert.equal(mergeIntervals([[0, 10, "inferred"], [5, 8, "observed"]])[0][2], "inferred"); assert.equal(mergeIntervals([[0, 10, "observed"], [5, 15, "inferred"]])[0][2], "inferred");
});

test("review fix: the pace blend keeps p10 <= p50 <= p90 without clamping to a stale median", () => {
  const h = hist(8, (i) => (2 + i * 4) * MIN, { declared: { p50Min: 10 } });
  const e = estimate({ features: { type: "build", regime: "brief", model: "opus" }, declared: { p50Min: 10, calls: 200 }, progress: { activeMs: 1 * MIN, calls: 10 }, history: h });
  assert.ok(e.pace); assert.ok(e.remaining.p10 < e.remaining.p50 && e.remaining.p50 < e.remaining.p90);
  assert.ok(e.remaining.p10 > 3 * MIN, "p10 moves with the slow pace instead of being capped at the old median");
  const undef = estimate({ features: { regime: "brief" }, history: hist(8, () => MIN), options: { minN: undefined } });
  assert.equal(undef.method, "reference-class", "undefined options fall back to defaults");
});
