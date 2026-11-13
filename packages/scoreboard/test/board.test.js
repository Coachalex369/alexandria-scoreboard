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

test("every owner prompt opens a period; HOME shows wins, not tool calls; subagent calls count in the period", () => {
  const b = new Board();
  b.apply(ev(0, "session.start"));
  b.apply(ev(1, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 900 } }));
  b.apply(tool(10, "Read", { op: "read" })); b.apply(tool(20, "Edit"));
  b.apply(ev(25, "agent.start", { actor: sub, parent: { toolUseId: "tu-agent" } }));
  b.apply(tool(30, "Bash", { actor: sub, parent: { toolUseId: "tu30", agentId: "agent-1" } }));
  const s = b.snapshot("sess-1", now(31));
  assert.equal(s.task.basis, "inferred"); assert.equal(s.task.kind, "turn");
  assert.equal(s.home.value, 0, "no win yet: the period has not ended"); assert.equal(s.task.toolCalls, 3);
  assert.equal(s.task.mainCalls, 2);
  assert.equal(s.guest.basis, "unavailable", "no estimate → GUEST dark, never a guess");
  assert.equal(s.shotClock.basis, "unavailable", "no agent history → shot clock unknown");
  assert.equal(s.period.value, 1);
  assert.equal(s.player.value, 1); assert.equal(s.main.state, "active");
  assert.equal(s.possession, "guest", "the subagent was the last actor");
  assert.equal(s.agents[0].type, "implementer"); assert.equal(s.agents[0].state, "active"); assert.equal(s.agents[0].toolCalls, 1);
});

test("explicit marks define the task, the estimate lights GUEST, a low-confidence game clock shows a range, task.end is a confirmed win", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 500 } }));
  b.apply(ev(2, "task.start", { source: "marks", actor: { type: "human" }, task: { id: "T1", title: "Build it" } }));
  b.apply(ev(3, "task.estimate", { source: "marks", observed: false, task: { id: "T1" }, payload: { p50Min: 10, p90Min: 20, calls: 8, basis: "declared" } }));
  assert.equal(b.sessions.get("sess-1").tasks.length, 1, "the period from the prompt is adopted by the mark, not duplicated");
  for (let i = 0; i < 5; i++) b.apply(tool(10 + i * 10, "Edit"));
  let s = b.snapshot("sess-1", now(5 * 60));
  assert.equal(s.task.id, "T1"); assert.equal(s.task.basis, "observed"); assert.equal(s.task.title, "Build it");
  assert.equal(s.guest.value, 3); assert.equal(s.guest.basis, "predicted");
  // no calibration history → the declared estimate with the labelled wide prior: low confidence → a countdown that is
  // labelled an estimate and carries its range (design decision 2026-11-13)
  assert.equal(s.etaV2.method, "prior"); assert.equal(s.etaV2.confidence, "low");
  assert.equal(s.game.mode, "countdown"); assert.equal(s.game.estimate, true); assert.equal(s.game.confidence, "low");
  assert.ok(s.game.range.loMs <= s.game.remainingMs && s.game.remainingMs <= s.game.range.hiMs);
  assert.ok(s.game.remainingMs > 2 * 60000 && s.game.remainingMs < 12 * 60000, `remaining within a plausible band, got ${s.game.remainingMs}`);
  assert.equal(s.eta.k, 1);
  b.apply(ev(6 * 60, "model.response", { source: "claude-transcript", payload: { model: "claude-opus-5-5", outputTokens: 10 } }));
  b.apply(ev(12 * 60, "task.end", { source: "marks", actor: { type: "human" }, task: { id: "T1" } }));
  s = b.snapshot("sess-1", now(13 * 60));
  assert.equal(s.phase.value, "DONE"); assert.equal(s.task.live, false);
  assert.equal(s.game.mode, "final", "finished tasks have no ETA"); assert.equal(s.gameClock.value, 0, "the clock shows 0:00, never the time spent");
  assert.equal(s.wins.value, 1); assert.equal(s.winDetail.confirmed, 1);
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

test("outstanding approvals and questions are TIMEOUTS; they stop the game clock and clear when decided or answered", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(tool(10, "Edit"));
  b.apply(ev(20, "notification", { payload: { kind: "permission_prompt" } }));
  let s = b.snapshot("sess-1", now(80));
  assert.equal(s.waiting.kind, "approval"); assert.equal(s.timeouts.value, 1); assert.equal(s.phase.value, "WAIT"); assert.equal(s.session.status, "waiting");
  assert.ok(Math.abs(s.stopwatch.activeMs - 20000) < 10, `active time stopped at 20 s, got ${s.stopwatch.activeMs}`);
  assert.ok(Math.abs(s.stopwatch.wallMs - 80000) < 10, "wall time keeps running");
  assert.ok(b.takeAlerts().some((a) => a.kind === "permission"));
  b.apply(tool(90, "Edit"));
  s = b.snapshot("sess-1", now(100));
  assert.equal(s.waiting, null); assert.equal(s.timeouts.value, 0, "decided → removed"); assert.ok(Math.abs(s.stopwatch.activeMs - 30000) < 10, `70 s of waiting excluded, got ${s.stopwatch.activeMs}`);
  b.apply(ev(110, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "ask1" } }));
  s = b.snapshot("sess-1", now(120)); assert.equal(s.waiting.kind, "question"); assert.equal(s.timeouts.value, 1);
  b.apply(ev(130, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "ask1" } }));
  s = b.snapshot("sess-1", now(131)); assert.equal(s.waiting, null); assert.equal(s.timeouts.value, 0);
});

test("a subagent's tool result does not clear a permission wait on the main thread", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(ev(1, "agent.start", { actor: sub }));
  b.apply(ev(5, "notification", { payload: { kind: "permission_prompt" } }));
  b.apply(tool(8, "Read", { actor: sub, parent: { toolUseId: "x", agentId: "agent-1" } }));
  assert.equal(b.snapshot("sess-1", now(9)).waiting.kind, "approval");
});

test("fouls: failed checks only (harmless tool failures excluded), resolved by a later pass and kept in history; commits are not checks", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  for (let i = 0; i < 4; i++) b.apply(ev(10 + i, "tool.failure", { payload: { tool: "Bash", failed: true, signature: "grep" }, parent: { toolUseId: `f${i}` } }));
  b.apply(ev(20, "tool.failure", { payload: { tool: "Bash", failed: true, signature: "npm run build", interrupted: true }, parent: { toolUseId: "int" } }));
  b.apply(ev(30, "test.run", { source: "tests", payload: { framework: "node:test", passed: 10, failed: 2, ok: false, label: "npm test" } }));
  let s = b.snapshot("sess-1", now(31));
  assert.equal(s.fouls.value, 1, "only the failed test run; grep misses and the interrupted build are not fouls"); assert.equal(s.bonus, false);
  assert.equal(s.tests.value, "FAIL"); assert.equal(s.phase.value, "TEST"); assert.equal(s.verified.value, 0);
  assert.ok(b.takeAlerts().some((a) => a.kind === "test-failure"));
  b.apply(ev(40, "test.run", { source: "tests", payload: { framework: "node:test", passed: 12, failed: 0, ok: true, label: "npm test" } }));
  b.apply(ev(50, "git.commit", { source: "git", actor: { type: "human" }, payload: { hash: "abc123", files: 3 } }));
  s = b.snapshot("sess-1", now(51));
  assert.equal(s.fouls.value, 0); assert.equal(s.foulDetail.resolved.length, 1); assert.equal(s.foulDetail.resolved[0].resolvedBy, "npm test passed");
  assert.equal(s.tests.value, "PASS"); assert.equal(s.verified.value, 1, "one valid check; the commit is not a check"); assert.equal(s.phase.value, "COMMIT");
  assert.equal(s.wins.value, 1); assert.equal(s.winDetail.verified, 1, "the commit landed while a check was valid and nothing was unresolved");
});

test("agent.stop delivers a subagent win but never ends the period; turn.stop ends it quietly; session end with an open period raises termination", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(ev(1, "agent.start", { actor: sub }));
  b.apply(ev(60, "agent.stop", { actor: sub }));
  let s = b.snapshot("sess-1", now(61));
  assert.equal(s.task.live, true); assert.equal(s.agents[0].state, "completed"); assert.equal(s.player.value, 0);
  assert.equal(s.wins.value, 1); assert.equal(s.winDetail.unverified, 1); assert.equal(s.agents[0].wins, 1);
  b.apply(ev(70, "turn.stop"));
  const a1 = b.takeAlerts(); assert.ok(a1.every((a) => a.kind !== "completed")); assert.ok(a1.some((a) => a.kind === "turn" && a.quiet));
  assert.equal(b.snapshot("sess-1", now(71)).task.live, false, "the period ended with the turn");
  b.apply(ev(75, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 40 } }));
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

test("every prompt is the next period, long or short; a turn that changed files is a win", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  b.apply(tool(10, "Edit")); b.apply(ev(20, "turn.stop"));
  b.apply(ev(30, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 20 } }));
  b.apply(tool(40, "Read", { op: "read" })); b.apply(ev(50, "turn.stop"));
  let s = b.snapshot("sess-1", now(51)); assert.equal(s.period.value, 2); assert.equal(s.session.tasks, 2);
  assert.equal(s.wins.value, 1, "the read-only period is not a win"); assert.equal(s.winDetail.probable, 1, "no check evidence → probable, never confirmed");
  b.apply(ev(60, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 5000 } }));
  s = b.snapshot("sess-1", now(61)); assert.equal(s.period.value, 3, "a long follow-up does not reset the period"); assert.equal(s.wins.value, 1);
  b.apply(ev(70, "turn.stop"));
  b.apply(ev(70 + 3 * 3600, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 10 } }));
  assert.equal(b.snapshot("sess-1", now(71 + 3 * 3600)).period.value, 4);
});

test("idle and stale session states, phase IDLE, focus follows the most recent session, duplicates ignored", () => {
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 400 } }));
  const dup = tool(5, "Edit"); b.apply(dup); b.apply(dup);
  assert.equal(b.snapshot("sess-1", now(6)).task.toolCalls, 1);
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

test("a commit seen by the v4 hook and by the git poller is one win; different hashes are separate wins; chained commits count", () => {
  const commit = (t, hash, source) => ev(t, "git.commit", { source, payload: source === "git" ? { hash, files: 2 } : { hash, via: "hook" } });
  const b = new Board();
  b.apply(ev(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 500 } }));
  b.apply(commit(5, "a1b2c3d4e5f6", "claude-hooks"));
  b.apply(commit(8, "A1B2C3D4E5F6", "git"));
  assert.equal(b.snapshot("sess-1", now(9)).wins.value, 1, "hook + poller with the same hash = one commit");
  b.apply(commit(10, "a1b2c3d4", "claude-hooks"));
  assert.equal(b.snapshot("sess-1", now(11)).wins.value, 1, "a prefix of a seen hash is the same commit");
  b.apply(commit(12, "ffffffffffff", "git"));
  assert.equal(b.snapshot("sess-1", now(13)).wins.value, 2, "a different hash is a second commit");
  b.apply(tool(14, "Bash", { op: "other" }));
  b.apply(commit(15, "0123456789ab", "claude-hooks"));
  assert.equal(b.snapshot("sess-1", now(16)).wins.value, 3, "the chained commit is counted");
  b.apply(ev(17, "git.commit", { payload: {} })); b.apply(ev(18, "git.commit", { payload: {} }));
  const s = b.snapshot("sess-1", now(19));
  assert.equal(s.wins.value, 5, "commits without a hash count once each"); assert.equal(s.verified.value, 0, "commits are never verification");
  assert.equal(s.winDetail.unverified, 5);
  // the same commit seen in another session does not score twice
  b.apply(ev(20, "git.commit", { source: "git", payload: { hash: "ffffffffffff" }, session: { id: "sess-2", project: "demo-proj" } }));
  assert.equal(b.snapshot("sess-2", now(21)).wins.value, 0);
});
