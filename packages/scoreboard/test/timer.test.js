// TIMER (formerly SHOT CLOCK; design decision 2026-11-13) = the waiting-on-you clock. Counts up from 0:00 only while
// Claude is blocked on the owner; dark for Claude-side waits, with no task open and after the final horn. It shares
// the GAME CLOCK's pause signal: the TIMER runs exactly when the GAME CLOCK is stopped for the owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { Board } from "../src/board.js";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");
let n = 0;
const S = { id: "sess-tm", project: "proj" };
const ev = (t, kind, extra = {}) => { const { actor = { type: "main" }, payload, parent, task, source = "claude-hooks", durationMs, observed = true } = extra; return makeEvent({ id: `evt_tm_${String(++n).padStart(6, "0")}`, ts: T0 + t * 1000, source, kind, session: S, actor, parent, task, payload, durationMs, provenance: { observed, adapter: "test", confidence: 1 } }); };
const at = (t) => T0 + t * 1000;
const tool = (t, name = "Edit", dur = 0) => ev(t, "tool.result", { payload: { tool: name }, parent: { toolUseId: `tu${t}` }, durationMs: dur });
const human = { type: "human" };
const snap = (b, t) => b.snapshot("sess-tm", at(t));
const marked = () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: human, payload: { promptLen: 500 } }));
  b.apply(ev(1, "task.start", { source: "marks", actor: human, task: { id: "T1", title: "x" } }));
  b.apply(ev(2, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 30 } }));
  b.apply(tool(10));
  return b;
};
// Every kind of stop in one marked task: approval, question, rate limit, stall, the owner's move between turns, horn.
function scenario() {
  const b = marked();
  const steps = [
    [60, ev(60, "notification", { payload: { kind: "permission_prompt" } })], // approval: owner
    [120, tool(120, "Bash")], // approved, tool started
    [150, ev(150, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" } })], // question: owner
    [300, ev(300, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" }, durationMs: 150e3 })],
    [310, tool(310)],
    [320, ev(320, "api.error", { source: "claude-transcript", actor: { type: "system" }, payload: { error: "rate_limit", status: 429, resetsAt: "2026-11-13T13:00:00.000Z", endsTurn: true } })], // Claude-side
    [900, ev(900, "notification", { payload: { kind: "quota_auto_resume_fired" } })],
    [910, tool(910, "Bash")],
    [920, tool(920)], // then 15 min of silence: a stall (Claude-side)
    [1900, tool(1900)],
    [1910, ev(1910, "turn.stop")], // the marked task stays open: the owner's move
    [2100, ev(2100, "prompt.submit", { actor: human, payload: { promptLen: 80 } })],
    [2110, tool(2110)],
    [2200, ev(2200, "task.end", { source: "marks", actor: human, task: { id: "T1" } })], // final horn
  ];
  return { b, steps };
}

test("TIMER runs exactly when the GAME CLOCK is stopped for the owner, and never otherwise (shared pause signal)", () => {
  const { b, steps } = scenario();
  let i = 0, ran = 0, darkWhileStopped = 0;
  for (let t = 11; t <= 2300; t++) {
    while (i < steps.length && steps[i][0] <= t) b.apply(steps[i++][1]);
    const s = snap(b, t);
    const stoppedForUser = !!s.game.stopped?.forUser;
    assert.equal(s.timer.running, stoppedForUser, `t=${t}: TIMER ${s.timer.running ? "runs" : "dark"} but GAME CLOCK ${stoppedForUser ? "stopped for the owner" : JSON.stringify(s.game.stopped)}`);
    if (s.timer.running) { ran++; assert.equal(s.task.live, true); }
    if (s.game.stopped && !stoppedForUser) darkWhileStopped++;
  }
  assert.ok(ran > 300, `the TIMER ran during the owner waits (${ran} s)`);
  assert.ok(darkWhileStopped > 500, `and stayed dark through Claude-side stops (${darkWhileStopped} s)`);
});

test("approval: counts up from 0:00, says APPROVAL NEEDED; resets and goes dark the moment the tool starts", () => {
  const b = marked();
  b.apply(ev(60, "notification", { payload: { kind: "permission_prompt" } }));
  let s = snap(b, 61); assert.equal(s.timer.running, true); assert.equal(s.timer.kind, "approval"); assert.equal(s.timer.waitingMs, 1e3, "counting from 0:00 at the request");
  s = snap(b, 95); assert.equal(s.timer.waitingMs, 35e3, "counts up second by second");
  b.apply(tool(120, "Bash"));
  s = snap(b, 121); assert.equal(s.timer.running, false); assert.equal(s.timer.note, "not waiting on you");
  b.apply(ev(130, "notification", { payload: { kind: "permission_prompt" } }));
  assert.equal(snap(b, 131).timer.waitingMs, 1e3, "a new request starts again from 0:00");
});

test("question and the owner's move: QUESTION while asked; YOUR TURN after a Stop inside an open task; a new prompt ends it", () => {
  const b = marked();
  b.apply(ev(30, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" } }));
  let s = snap(b, 40); assert.equal(s.timer.kind, "question"); assert.equal(s.timer.request, "question");
  b.apply(ev(50, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" }, durationMs: 20e3 }));
  assert.equal(snap(b, 51).timer.running, false, "answered: dark");
  b.apply(tool(60)); b.apply(ev(70, "turn.stop"));
  s = snap(b, 100); assert.equal(s.task.live, true, "the marked task is still open"); assert.equal(s.timer.kind, "owner"); assert.equal(s.timer.waitingMs, 30e3);
  b.apply(ev(130, "prompt.submit", { actor: human, payload: { promptLen: 40 } }));
  assert.equal(snap(b, 131).timer.running, false, "new prompt: dark");
});

test("dark for Claude-side waits (rate limit, API error, stall), with no task open, and after the final horn", () => {
  const b = marked();
  b.apply(ev(60, "api.error", { source: "claude-transcript", actor: { type: "system" }, payload: { error: "rate_limit", status: 429, endsTurn: true } }));
  let s = snap(b, 120); assert.equal(s.game.stopped.kind, "rate_limit"); assert.equal(s.timer.running, false);
  b.apply(tool(200)); b.apply(tool(210));
  s = snap(b, 210 + 11 * 60); assert.equal(s.game.stopped.state, "unknown", "stall"); assert.equal(s.timer.running, false);
  b.apply(ev(1000, "task.end", { source: "marks", actor: human, task: { id: "T1" } }));
  s = snap(b, 1010); assert.equal(s.game.mode, "final"); assert.equal(s.timer.running, false); assert.equal(s.timer.note, "no task open");
  // an ordinary turn period ends at its Stop: no task is open afterwards, so the TIMER is dark
  const u = new Board(); u.apply(ev(0, "prompt.submit", { actor: human, payload: { promptLen: 200 } })); u.apply(tool(10)); u.apply(ev(20, "turn.stop"));
  assert.equal(snap(u, 60).timer.running, false);
  assert.equal(new Board().snapshot("none", at(1)).timer.running, false);
});

// Regressions.
const subActor = { type: "subagent", agentId: "ag1", agentType: "implementer" };
test("a subagent's approval is decided by that subagent's next tool, not left running for its whole run", () => {
  const b = marked();
  b.apply(ev(20, "agent.start", { actor: subActor, parent: { toolUseId: "tuA" } }));
  b.apply(ev(60, "permission.request", { actor: subActor, payload: { tool: "Bash" } }));
  assert.equal(snap(b, 70).timer.kind, "approval");
  b.apply(ev(90, "tool.result", { actor: subActor, payload: { tool: "Bash" }, parent: { toolUseId: "s1", agentId: "ag1" }, durationMs: 5e3 }));
  const s = snap(b, 100);
  assert.equal(s.timer.running, false, "approved: dark"); assert.equal(s.timeouts.value, 0);
  assert.equal(s.game.stopped, null, "and the game clock runs again");
});

test("a parallel tool that began before the request does not end the approval", () => {
  const b = marked();
  b.apply(ev(60, "permission.request", { payload: { tool: "Bash" } }));
  b.apply(ev(90, "tool.result", { payload: { tool: "Read" }, parent: { toolUseId: "par" }, durationMs: 80e3 })); // began at 10
  let s = snap(b, 100);
  assert.equal(s.timer.running, true, "still waiting for the owner"); assert.equal(s.timer.waitingMs, 40e3); assert.equal(s.timeouts.value, 1);
  b.apply(ev(130, "tool.result", { payload: { tool: "Bash" }, parent: { toolUseId: "b1" }, durationMs: 10e3 })); // approved at ~120
  s = snap(b, 131);
  assert.equal(s.timer.running, false); assert.equal(s.timeouts.value, 0);
});

test("the TIMER does not reset when the kind of owner wait changes without an answer; a denial ends the approval", () => {
  const b = marked();
  b.apply(ev(60, "notification", { payload: { kind: "permission_prompt" } }));
  b.apply(ev(80, "tool.call", { payload: { tool: "ExitPlanMode" }, parent: { toolUseId: "p1" } }));
  let s = snap(b, 100);
  assert.equal(s.timer.running, true); assert.equal(s.timer.waitingMs, 40e3, "counted from the first owner wait, not from the change");
  const d = marked();
  d.apply(ev(60, "permission.request", { payload: { tool: "Bash" } }));
  d.apply(ev(70, "permission.denied", { payload: { tool: "Bash" } }));
  d.apply(ev(75, "turn.stop"));
  s = snap(d, 90);
  assert.equal(s.timer.kind, "owner", "after a denial and a Stop it is the owner's move, not an approval");
});

test("plan approval reads as an approval; an ended session is not waiting on anyone", () => {
  const b = marked();
  b.apply(ev(30, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" } }));
  b.apply(ev(40, "tool.call", { payload: { tool: "ExitPlanMode" }, parent: { toolUseId: "p1" } }));
  assert.equal(snap(b, 50).timer.request, "plan-approval", "the newest matching request, not the oldest");
  b.apply(ev(60, "session.end", { payload: { reason: "other" } }));
  const s = snap(b, 70);
  assert.equal(s.timer.running, false); assert.equal(s.game.stopped?.forUser ?? false, false, "both sides of the shared signal");
});
