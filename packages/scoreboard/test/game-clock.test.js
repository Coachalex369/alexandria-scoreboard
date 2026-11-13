// GAME CLOCK = estimated time LEFT, never time spent (design decision 2026-11-13): counts down second by second,
// stops during waits, adjusts only visibly on new evidence, counts up in OVERTIME, shows 0:00 when the period is over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { Board, CLOCK_RULES } from "../src/board.js";
import { gameClockView, rangeWords } from "../src/clockView.js";
import { stepsLeftPulse, PULSE_CYCLE_MS, PULSE } from "../src/pulse.js";

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
  assert.ok(adj, "the adjustment is on the snapshot"); assert.equal(adj.reason, "declared estimate changed");
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

test("crossing 0:00 lights OVERTIME and resets to a fresh estimate that counts down again; never negative, never up", () => {
  const b = declared(1); // one declared minute
  b.apply(tool(5));
  const start = snap(b, 6).game;
  assert.equal(start.overtime, 0);
  let crossed = null, prev = start.remainingMs;
  for (let t = 7; t <= 600; t++) {
    if (t % 30 === 0) b.apply(tool(t));
    const g = snap(b, t).game;
    assert.equal(g.mode, "countdown", `t=${t}: always a countdown`); assert.ok(g.remainingMs >= 0, `t=${t}: never negative`);
    if (g.overtime > (crossed?.overtime ?? 0)) { assert.ok(g.remainingMs > prev, `t=${t}: the reset jumps up from 0:00`); crossed = g; }
    else if (crossed) assert.ok(g.remainingMs <= prev, `t=${t}: then counts down`);
    prev = g.remainingMs;
  }
  assert.ok(crossed, "the declared minute ran out"); assert.ok(["re-estimated", "lower bound", "minimum step"].includes(crossed.reset));
  assert.ok(crossed.remainingMs >= CLOCK_RULES.overtimeMinStepMs - 1000, "every reset is at least the minimum step");
  b.apply(ev(620, "task.end", { source: "marks", actor: human, task: { id: "T1" } }));
  const fin = snap(b, 630);
  assert.equal(fin.game.mode, "final"); assert.equal(fin.gameClock.value, 0);
});

test("without a fresh estimate the reset uses the last range's lower bound, labelled EST", () => {
  const b = declared(0.05); b.apply(tool(1)); // 3 declared seconds: the prior soon has nothing left above the elapsed time
  snap(b, 2);
  for (let t = 3; t <= 400; t++) { if (t % 20 === 0) b.apply(tool(t)); const g = snap(b, t).game; assert.ok(g.remainingMs >= 0); assert.equal(g.mode, "countdown"); }
  const g = snap(b, 400).game;
  assert.ok(g.overtime >= 1); assert.equal(g.estimate, true, "EST lamp and range note");
  assert.ok(["lower bound", "minimum step"].includes(g.reset), `fallback path, got ${g.reset}`);
  assert.ok(g.overtime < 40, `at least 30 s per reset: no reset loop (${g.overtime} resets in 400 s)`);
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

test("the GAME CLOCK digits never show a '+', a unit letter or a negative time, and never blink", () => {
  const states = [{ mode: "unknown" }, { mode: "final" }, undefined];
  for (const ms of [0, 1, 999, 1000, 59_999, 60_000, 599_000, 3_599_000, 3_600_000, 3_660_000, 99 * 3_600_000, -5_000, NaN]) for (const overtime of [0, 1, 3]) for (const estimate of [false, true]) states.push({ mode: "countdown", remainingMs: ms, overtime, estimate });
  for (const g of states) {
    const v = gameClockView(g);
    assert.ok(!/[+A-Za-z]/.test(v.text), `no + and no unit letter: ${v.text} for ${JSON.stringify(g)}`);
    assert.equal(v.flash, false, "never blinks");
    assert.match(v.text, /^(\s?\d{1,2}:\d{2}|--:--)$/, `M:SS or H:MM only: ${v.text}`);
  }
  const h = gameClockView({ mode: "countdown", remainingMs: 3_660_000, overtime: 1, estimate: true });
  assert.equal(h.text.trim(), "1:01"); assert.deepEqual(h.lamps, { overtime: true, est: true, hrs: true }, "H:MM with HRS; OVERTIME and EST lamps carry the state");
  assert.equal(gameClockView({ mode: "countdown", remainingMs: 61_000, overtime: 0 }).text.trim(), "1:01"); assert.equal(gameClockView({ mode: "countdown", remainingMs: 61_000 }).lamps.hrs, false);
});

test("STEPS LEFT pulse: two quick dim-bright pulses (~1 s), 30 s steady, repeating; steady when dark or under reduced motion", () => {
  assert.equal(PULSE_CYCLE_MS, 31_000); assert.equal(PULSE.count * PULSE.pulseMs, 1_000);
  const seq = (from, to, step) => { const out = []; for (let t = from; t < to; t += step) out.push(stepsLeftPulse(t)); return out.join(","); };
  assert.equal(seq(0, 1000, 250), "dim,bright,dim,bright", "two pulses in the first second");
  for (let t = 1000; t < 31_000; t += 250) assert.equal(stepsLeftPulse(t), "bright", `steady at ${t}`);
  assert.equal(seq(31_000, 32_000, 250), "dim,bright,dim,bright", "and again");
  assert.equal(seq(62_000, 63_000, 250), "dim,bright,dim,bright");
  for (let t = 0; t < 70_000; t += 125) { assert.equal(stepsLeftPulse(t, { reduced: true }), "bright"); assert.equal(stepsLeftPulse(t, { lit: false }), "bright"); }
});

test("app wiring: the GAME CLOCK display is never set to flash or question-mark blink", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const clockLines = src.split("\n").filter((l) => l.includes("D.clock."));
  assert.ok(clockLines.length > 0);
  for (const l of clockLines) {
    for (const m of l.matchAll(/D\.clock\.setFlash\(([^)]*)\)/g)) assert.equal(m[1].trim(), "false", l.trim());
    assert.ok(!/D\.clock\.el\.classList\.(add|toggle)\("qmark"/.test(l), l.trim());
  }
});

test("a floored overtime reset shows a range that contains the step; sub-minute ranges read UNDER 1 MIN, never 0-0", () => {
  const b = declared(0.05); b.apply(tool(1)); snap(b, 2);
  let g = null; for (let t = 3; t <= 40; t++) { g = snap(b, t).game; if (g.overtime) break; }
  assert.ok(g?.overtime >= 1, "crossed 0:00"); assert.equal(g.reset, "minimum step");
  assert.ok(g.range.loMs <= g.remainingMs && g.remainingMs <= g.range.hiMs, "the range contains what is counted down");
  assert.equal(rangeWords(g.range), "UNDER 1 MIN");
  assert.equal(rangeWords({ loMs: 0, hiMs: 0 }), "UNDER 1 MIN"); assert.equal(rangeWords({ loMs: 120e3, hiMs: 600e3 }), "2–10 MIN");
});
