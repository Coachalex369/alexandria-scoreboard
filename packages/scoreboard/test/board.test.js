import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { Board, taskWorkMs } from "../src/board.js";

// Compact event factory: t = seconds after a fixed origin.
const T0 = Date.parse("2026-11-09T10:00:00.000Z");
let n = 0;
const S = { id: "sess-1", project: "demo-proj" };
function ev(t, kind, extra = {}) {
  const { actor = { type: "main", modelConfidence: "unknown" }, payload, parent, task, classification, session = S, observed = true, source = "claude-hooks", id } = extra;
  return makeEvent({ id: id || `evt_t${String(++n).padStart(5, "0")}`, ts: T0 + t * 1000, source, kind, session, actor, parent, task, payload, classification, provenance: { observed, adapter: "test", confidence: 1 } });
}
const tool = (t, name, extra = {}) => ev(t, "tool.result", { payload: { tool: name }, parent: { toolUseId: `tu${t}` }, classification: [{ scheme: "operation", value: extra.op || "edit", basis: "observed", confidence: 1, by: "t" }], ...extra });
const sub = { type: "subagent", agentId: "agent-1", agentType: "implementer", modelConfidence: "unknown" };
const now = (t) => T0 + t * 1000;

test("a brief infers a task; tool results score HOME; subagent calls count too", () => {
  const b = new Board();
  b.apply(ev(0, "session.start"));
  b.apply(ev(1, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 900 } }));
  b.apply(tool(10, "Read", { op: "read" })); b.apply(tool(20, "Edit"));
  b.apply(ev(25, "agent.start", { actor: sub, parent: { toolUseId: "tu-agent" } }));
  b.apply(tool(30, "Bash", { actor: sub, parent: { toolUseId: "tu30", agentId: "agent-1" } }));
  const s = b.snapshot("sess-1", now(31));
  assert.equal(s.task.basis, "inferred");
  assert.equal(s.home.value, 3); assert.equal(s.home.basis, "observed");
  assert.equal(s.task.mainCalls, 2);
  assert.equal(s.guest.basis, "unavailable", "no estimate → GUEST dark, never a guess");
  assert.equal(s.shotClock.basis, "unavailable");
  assert.equal(s.period.value, 1);
  assert.equal(s.player.value, 1);
  assert.equal(s.possession, "guest", "the subagent was the last actor");
  assert.equal(s.agents[0].type, "implementer"); assert.equal(s.agents[0].state, "active"); assert.equal(s.agents[0].toolCalls, 1);
});

test("explicit marks define the task, the estimate lights GUEST and the shot clock, task.end records the prediction", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 500 } }));
  b.apply(ev(2, "task.start", { source: "marks", actor: { type: "human" }, task: { id: "T1", title: "Build it" } }));
  b.apply(ev(3, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 10, p90Min: 20, calls: 8, basis: "declared" } }));
  assert.equal(b.sessions.get("sess-1").tasks.length, 1, "the inferred task from the prompt is adopted by the mark, not duplicated");
  for (let i = 0; i < 5; i++) b.apply(tool(10 + i * 10, "Edit"));
  let s = b.snapshot("sess-1", now(5 * 60));
  assert.equal(s.task.id, "T1"); assert.equal(s.task.basis, "observed"); assert.equal(s.task.title, "Build it");
  assert.equal(s.guest.value, 3); assert.equal(s.guest.basis, "predicted");
  // v0.2: no calibration history yet → the declared estimate with the labelled wide prior, conditioned on 5 min spent
  assert.equal(s.shotClock.basis, "predicted"); assert.equal(s.etaV2.method, "prior"); assert.equal(s.etaV2.confidence, "low");
  assert.ok(s.shotClock.value > 2 * 60000 && s.shotClock.value < 12 * 60000, `remaining within a plausible band, got ${s.shotClock.value}`);
  assert.ok(s.etaV2.remaining.p10 <= s.etaV2.remaining.p50 && s.etaV2.remaining.p50 <= s.etaV2.remaining.p90);
  assert.equal(s.eta.k, 1);
  b.apply(ev(6 * 60, "model.response", { source: "claude-transcript", payload: { model: "claude-opus-5-5", outputTokens: 10 } })); // v0.2: keeps the turn audible (11 silent minutes would be partly "unknown" time)
  b.apply(ev(12 * 60, "task.end", { source: "marks", actor: { type: "human" }, task: { id: "T1" } }));
  s = b.snapshot("sess-1", now(13 * 60));
  assert.equal(s.phase.value, "DONE"); assert.equal(s.task.live, false);
  assert.equal(s.shotClock.basis, "unavailable", "finished tasks have no ETA");
  const p = s.predictions[0];
  assert.equal(p.p50Min, 10); assert.equal(p.actualWorkMin, 12); assert.equal(p.errorRatio, 0.83); assert.equal(p.withinRange, true);
  const alerts = b.takeAlerts();
  assert.ok(alerts.some((a) => a.kind === "completed" && !a.quiet), "horn-worthy completion alert");
});

test("GUEST shows 0 once more calls than estimated were made, never negative", () => {
  const b = new Board();
  b.apply(ev(0, "task.start", { source: "marks", actor: { type: "human" }, task: { id: "T", title: "x" } }));
  b.apply(ev(1, "task.estimate", { source: "marks", observed: false, task: { id: "T" }, payload: { p50Min: 1, calls: 2 } }));
  for (let i = 0; i < 4; i++) b.apply(tool(10 + i, "Edit"));
  const s = b.snapshot("sess-1", now(3 * 60));
  assert.equal(s.guest.value, 0); assert.ok(s.eta.overdueMs > 0, "the declared-estimate log still reports overdue");
  // v0.2: past the declaration the shot clock shows the remaining time from the prior's tail, never a negative number
  assert.ok(s.shotClock.value == null || s.shotClock.value >= 0);
  const later = b.snapshot("sess-1", now(30 * 60));
  assert.equal(later.etaV2.state, "beyond-history", "30× the declared minute: only a lower bound"); assert.equal(later.shotClock.value, null); assert.equal(later.shotClock.basis, "unavailable");
});

test("permission waits are TIMEOUTS, stop the game clock and clear on the next main-thread tool result", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(tool(10, "Edit"));
  b.apply(ev(20, "notification", { payload: { kind: "permission_prompt" } }));
  let s = b.snapshot("sess-1", now(80));
  assert.equal(s.waiting.kind, "approval"); assert.equal(s.timeouts.value, 1); assert.equal(s.phase.value, "WAIT"); assert.equal(s.session.status, "waiting");
  assert.ok(Math.abs(s.gameClock.value - 20000) < 10, `clock stopped at 20 s, got ${s.gameClock.value}`);
  assert.ok(Math.abs(s.elapsed.value - 80000) < 10, "wall time keeps running");
  assert.ok(b.takeAlerts().some((a) => a.kind === "permission"));
  b.apply(tool(90, "Edit"));
  s = b.snapshot("sess-1", now(100));
  assert.equal(s.waiting, null); assert.ok(Math.abs(s.gameClock.value - 30000) < 10, `70 s of waiting excluded, got ${s.gameClock.value}`);
  b.apply(ev(110, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "ask1" } }));
  s = b.snapshot("sess-1", now(120)); assert.equal(s.waiting.kind, "question"); assert.equal(s.timeouts.value, 2);
  b.apply(ev(130, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "ask1" } }));
  assert.equal(b.snapshot("sess-1", now(131)).waiting, null);
});

test("a subagent's tool result does not clear a permission wait on the main thread", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(ev(1, "agent.start", { actor: sub }));
  b.apply(ev(5, "notification", { payload: { kind: "permission_prompt" } }));
  b.apply(tool(8, "Read", { actor: sub, parent: { toolUseId: "x", agentId: "agent-1" } }));
  assert.equal(b.snapshot("sess-1", now(9)).waiting.kind, "approval");
});

test("fouls: tool failures and failed test runs; BONUS at five; PASS/FAIL lamps follow the latest run", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  for (let i = 0; i < 4; i++) b.apply(ev(10 + i, "tool.failure", { payload: { tool: "Bash", failed: true }, parent: { toolUseId: `f${i}` } }));
  b.apply(ev(30, "test.run", { source: "tests", payload: { framework: "node:test", passed: 10, failed: 2, ok: false } }));
  let s = b.snapshot("sess-1", now(31));
  assert.equal(s.fouls.value, 5); assert.equal(s.bonus, true); assert.equal(s.tests.value, "FAIL"); assert.equal(s.phase.value, "TEST"); assert.equal(s.verified.value, 0);
  assert.ok(b.takeAlerts().some((a) => a.kind === "test-failure"));
  b.apply(ev(40, "test.run", { source: "tests", payload: { framework: "node:test", passed: 12, failed: 0, ok: true } }));
  b.apply(ev(50, "git.commit", { source: "git", actor: { type: "human" }, payload: { hash: "abc123", files: 3 } }));
  s = b.snapshot("sess-1", now(51));
  assert.equal(s.tests.value, "PASS"); assert.equal(s.verified.value, 2); assert.equal(s.phase.value, "COMMIT");
});

test("agent.stop never completes the task; turn.stop is quiet; session end with an open task raises termination", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(ev(1, "agent.start", { actor: sub }));
  b.apply(ev(60, "agent.stop", { actor: sub }));
  let s = b.snapshot("sess-1", now(61));
  assert.equal(s.task.live, true); assert.equal(s.agents[0].state, "completed"); assert.equal(s.player.value, 0);
  b.apply(ev(70, "turn.stop"));
  const a1 = b.takeAlerts(); assert.ok(a1.every((a) => a.kind !== "completed")); assert.ok(a1.some((a) => a.kind === "turn" && a.quiet));
  b.apply(ev(80, "session.end", { payload: { reason: "crash" } }));
  const a2 = b.takeAlerts(); assert.ok(a2.some((a) => a.kind === "termination" && !a.quiet));
  s = b.snapshot("sess-1", now(90)); assert.equal(s.session.status, "ended");
});

test("a normal exit (clear/logout) with an open task is a quiet termination", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(ev(5, "session.end", { payload: { reason: "clear" } }));
  const a = b.takeAlerts().find((x) => x.kind === "termination"); assert.ok(a && a.quiet);
});

test("a long gap or a new brief starts a new inferred task; short follow-ups continue it", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(tool(10, "Edit")); b.apply(ev(20, "turn.stop"));
  b.apply(ev(30, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 20 } }));
  b.apply(tool(40, "Edit")); b.apply(ev(50, "turn.stop"));
  let s = b.snapshot("sess-1", now(51)); assert.equal(s.session.tasks, 1); assert.equal(s.period.value, 2); assert.equal(s.home.value, 2);
  b.apply(ev(60, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 1200 } }));
  s = b.snapshot("sess-1", now(61)); assert.equal(s.session.tasks, 2); assert.equal(s.home.value, 0); assert.equal(s.period.value, 1);
  b.apply(ev(70, "turn.stop"));
  b.apply(ev(70 + 3 * 3600, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 10 } }));
  assert.equal(b.snapshot("sess-1", now(71 + 3 * 3600)).session.tasks, 3);
});

test("idle and stale session states, phase IDLE, focus follows the most recent session, duplicates ignored", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  const dup = tool(5, "Edit"); b.apply(dup); b.apply(dup);
  assert.equal(b.snapshot("sess-1", now(6)).home.value, 1);
  assert.equal(b.snapshot("sess-1", now(6)).session.status, "active");
  let s = b.snapshot("sess-1", now(200)); assert.equal(s.session.status, "idle"); assert.equal(s.phase.value, "IDLE");
  s = b.snapshot("sess-1", now(40 * 60)); assert.equal(s.session.status, "stale");
  b.apply(ev(100, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 }, session: { id: "sess-2", project: "other" } }));
  assert.equal(b.focusSession(), "sess-2"); assert.equal(b.focusSession("sess-1"), "sess-1"); assert.equal(b.focusSession("nope"), "sess-2");
  assert.equal(b.sessionList(now(101))[0].id, "sess-2");
});

test("synthetic recordings are flagged; the project follows the latest working directory", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 }, source: "synthetic", session: { id: "syn", project: "a" } }));
  b.apply(tool(1, "Edit", { session: { id: "syn", project: "b" } }));
  const s = b.snapshot("syn", now(2)); assert.equal(s.session.synthetic, true); assert.equal(s.session.project, "b");
});

test("the Agent tool's result declares the subagent model for the agent it spawned", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(ev(1, "agent.start", { actor: { type: "subagent", agentId: "A", agentType: null, modelConfidence: "unknown" }, parent: { toolUseId: "tuA" } }));
  b.apply(ev(9, "tool.result", { payload: { tool: "Agent", subagentType: "reviewer", subagentModel: "claude-opus-5-5" }, parent: { toolUseId: "tuA" } }));
  const a = b.snapshot("sess-1", now(10)).agents[0];
  assert.equal(a.type, "reviewer"); assert.equal(a.model, "claude-opus-5-5"); assert.equal(a.modelBasis, "declared");
});

test("taskWorkMs subtracts completed and ongoing waits", () => {
  const t = { start: new Date(T0).toISOString(), end: null, waitingMs: 30000, waitSince: new Date(T0 + 100000).toISOString() };
  assert.equal(taskWorkMs(t, T0 + 160000), 160000 - 30000 - 60000);
});

test("empty snapshot is honest: everything unavailable, nothing invented", () => {
  const s = new Board().snapshot("none", T0);
  assert.equal(s.session, null); assert.equal(s.home.basis, "unavailable"); assert.equal(s.shotClock.basis, "unavailable"); assert.equal(s.phase.value, "IDLE");
});

test("a commit seen by the v4 hook and by the git poller counts once; different hashes count separately; chained commits count", () => {
  const commit = (t, hash, source) => ev(t, "git.commit", { source, payload: source === "git" ? { hash, files: 2 } : { hash, via: "hook" } });
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 500 } }));
  b.apply(commit(5, "a1b2c3d4e5f6", "claude-hooks"));
  b.apply(commit(8, "A1B2C3D4E5F6", "git"));
  assert.equal(b.snapshot("sess-1", now(9)).verified.value, 1, "hook + poller with the same hash = one commit");
  b.apply(commit(10, "a1b2c3d4", "claude-hooks"));
  assert.equal(b.snapshot("sess-1", now(11)).verified.value, 1, "a prefix of a seen hash is the same commit");
  b.apply(commit(12, "ffffffffffff", "git"));
  assert.equal(b.snapshot("sess-1", now(13)).verified.value, 2, "a different hash is a second commit");
  // v4 chained `git add && git commit`: tool.result with sig "git add" plus the observed commit
  b.apply(tool(14, "Bash", { op: "other" }));
  b.apply(commit(15, "0123456789ab", "claude-hooks"));
  assert.equal(b.snapshot("sess-1", now(16)).verified.value, 3, "the chained commit is counted");
  b.apply(ev(17, "git.commit", { payload: {} })); b.apply(ev(18, "git.commit", { payload: {} }));
  assert.equal(b.snapshot("sess-1", now(19)).verified.value, 5, "commits without a hash count as before");
});
