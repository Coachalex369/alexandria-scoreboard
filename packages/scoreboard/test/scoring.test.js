// Scoring overhaul (scoring rules 2026-11-12): controlled fixtures for every scoring case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { Board, sessionLabel } from "../src/board.js";
import { scanTranscriptChunk, newFactsState, registryEvents, endsWithQuestion, gitRootOf, repoKey } from "../src/sessionFacts.js";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
let n = 0;
const at = (t) => T0 + t * 1000;
const SA = { id: "sess-A", project: "proj" }, SB = { id: "sess-B", project: "proj" };
function ev(t, kind, extra = {}) {
  const { actor = { type: "main" }, payload, parent, session = SA, observed = true, source = "claude-hooks", durationMs } = extra;
  return makeEvent({ id: `evt_sc_${String(++n).padStart(6, "0")}`, ts: at(t), source, kind, session, actor, parent, payload, durationMs, provenance: { observed, adapter: "test", confidence: 1 } });
}
const prompt = (t, session = SA, len = 400) => ev(t, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: len }, session });
const stop = (t, session = SA) => ev(t, "turn.stop", { session });
const tool = (t, name, payload = {}, extra = {}) => ev(t, "tool.result", { payload: { tool: name, ...payload }, parent: { toolUseId: `tu${t}${extra.session?.id || ""}` }, ...extra });
const fail = (t, name, payload = {}, extra = {}) => ev(t, "tool.failure", { payload: { tool: name, failed: true, ...payload }, parent: { toolUseId: `tf${t}` }, ...extra });
const tests = (t, ok, extra = {}) => ev(t, "test.run", { source: "claude-hooks", payload: { framework: "node:test", passed: ok ? 10 : 8, failed: ok ? 0 : 2, ok, label: "npm test" }, ...extra });
const identity = (t, session, repo, extra = {}) => ev(t, "state.change", { source: "claude-transcript", actor: { type: "system" }, session, payload: { change: "identity", folder: repo, repo, repoKey: `${repo}#00000001`, branch: null, title: null, custom: null, ...extra } });
const sub = (id, type = "implementer") => ({ type: "subagent", agentId: id, agentType: type });

test("VERIFIED counts valid checks; code edits stale them, documentation edits do not, a failed rerun invalidates; commits never count", () => {
  const b = new Board();
  b.apply(identity(0, SA, "repo")); b.apply(prompt(1));
  b.apply(tests(10, true));
  b.apply(ev(11, "tool.result", { payload: { tool: "Bash", signature: "npm run build" }, parent: { toolUseId: "b1" } }));
  let s = b.snapshot("sess-A", at(12)); assert.equal(s.verified.value, 2, "test + build checks");
  b.apply(tool(20, "Edit", { ext: ".md" }));
  assert.equal(b.snapshot("sess-A", at(21)).verified.value, 2, "a documentation edit keeps the evidence");
  b.apply(tool(30, "Edit", { ext: ".js" }));
  s = b.snapshot("sess-A", at(31)); assert.equal(s.verified.value, 0, "a code edit stales both checks");
  assert.deepEqual(s.checks.map((c) => c.status).sort(), ["stale", "stale"]); assert.match(s.verified.note, /stale/);
  b.apply(tests(40, true)); assert.equal(b.snapshot("sess-A", at(41)).verified.value, 1, "re-running restores that check only");
  b.apply(tool(50, "Bash", { signature: "git checkout" })); assert.equal(b.snapshot("sess-A", at(51)).verified.value, 0, "a tree-rewriting command stales");
  b.apply(tests(60, true)); b.apply(tests(70, false));
  s = b.snapshot("sess-A", at(71)); assert.equal(s.verified.value, 0); assert.equal(s.tests.value, "FAIL"); assert.equal(s.fouls.value, 1);
  b.apply(ev(80, "git.commit", { payload: { hash: "abcdef123456" } }));
  assert.equal(b.snapshot("sess-A", at(81)).verified.value, 0, "a commit is not a check");
  // v3 hook lines carry no extension: any edit is treated as a code change (conservative)
  b.apply(tests(90, true)); b.apply(tool(91, "Write")); assert.equal(b.snapshot("sess-A", at(92)).verified.value, 0);
});

test("evidence survives period boundaries and is shared by terminals in the same repository", () => {
  const b = new Board();
  b.apply(identity(0, SA, "repo")); b.apply(identity(0, SB, "repo"));
  b.apply(prompt(1)); b.apply(tests(10, false)); b.apply(stop(20));
  b.apply(prompt(30, SB));
  let sB = b.snapshot("sess-B", at(31)); assert.equal(sB.fouls.value, 1, "terminal B sees the repo's open failure");
  b.apply(tests(40, true, { session: SB }));
  sB = b.snapshot("sess-B", at(41)); const sA = b.snapshot("sess-A", at(41));
  assert.equal(sB.fouls.value, 0); assert.equal(sA.fouls.value, 0, "fixed in B, resolved for A too");
  assert.equal(sA.foulDetail.resolved[0].resolvedInSession, "sess-B"); assert.equal(sA.verified.value, 1, "A's next period still sees the valid check");
  b.apply(tool(50, "Edit", { ext: ".ts" })); // A's edit
  assert.equal(b.snapshot("sess-B", at(51)).verified.value, 0, "an edit in A stales B's evidence in the same repo");
  // a session in another repository is unaffected
  const SC = { id: "sess-C", project: "other" }; b.apply(identity(0, SC, "other")); b.apply(prompt(60, SC));
  assert.equal(b.snapshot("sess-C", at(61)).fouls.value, 0);
});

test("FOULS: harmless failures and interruptions excluded; build and subagent failures count; resolution needs evidence; history kept", () => {
  const b = new Board();
  b.apply(prompt(0));
  b.apply(fail(1, "Read")); b.apply(fail(2, "Edit")); b.apply(fail(3, "Bash", { signature: "grep" })); b.apply(fail(4, "mcp__claude-in-chrome__computer"));
  b.apply(fail(5, "Bash", { signature: "npm test", interrupted: true }));
  assert.equal(b.snapshot("sess-A", at(6)).fouls.value, 0);
  b.apply(fail(10, "Bash", { signature: "npm run build" }));
  b.apply(fail(11, "Bash", { signature: "npm test" })); // failure hook: no output, still a failed test command
  b.apply(fail(12, "Agent", { subagentType: "reviewer" }));
  let s = b.snapshot("sess-A", at(13)); assert.equal(s.fouls.value, 3);
  assert.deepEqual(s.foulDetail.unresolved.map((f) => f.kind).sort(), ["build-failure", "subagent-failure", "test-failure"]);
  b.apply(fail(14, "Bash", { signature: "npm run build" })); assert.equal(b.snapshot("sess-A", at(15)).fouls.value, 3, "a repeated failure is one foul");
  b.apply(tool(20, "Bash", { signature: "npm run build" }));
  b.apply(ev(30, "agent.start", { actor: sub("r2", "reviewer") })); b.apply(ev(40, "agent.stop", { actor: sub("r2", "reviewer") }));
  s = b.snapshot("sess-A", at(41));
  assert.equal(s.fouls.value, 1, "build fixed (observed), reviewer delivered (inferred); the test failure stays open");
  const res = Object.fromEntries(s.foulDetail.resolved.map((f) => [f.kind, f.resolutionBasis]));
  assert.deepEqual(res, { "build-failure": "observed", "subagent-failure": "inferred" });
  assert.equal(s.foulDetail.unresolved[0].kind, "test-failure");
});

test("WINS: shared team score with tiers; no duplicates; guesses never confirmed; failed deliveries revoked", () => {
  const b = new Board();
  b.apply(identity(0, SA, "repo")); b.apply(prompt(1));
  b.apply(tool(5, "Edit", { ext: ".js" })); b.apply(stop(10));
  let s = b.snapshot("sess-A", at(11)); assert.equal(s.winDetail.probable, 1, "a turn that changed files, no evidence → probable");
  b.apply(prompt(20)); b.apply(tool(25, "Edit", { ext: ".js" })); b.apply(tests(30, true)); b.apply(stop(35));
  s = b.snapshot("sess-A", at(36)); assert.equal(s.winDetail.verified, 1, "the turn ended with a valid check and nothing unresolved");
  b.apply(prompt(40)); b.apply(ev(41, "git.commit", { payload: { hash: "1111aaaa2222" } })); b.apply(ev(42, "git.commit", { source: "git", payload: { hash: "1111AAAA2222" } }));
  b.apply(ev(43, "git.commit", { payload: { hash: "1111aaaa2222" }, session: SB }));
  s = b.snapshot("sess-A", at(44)); assert.equal(s.winDetail.list.filter((w) => w.kind === "commit").length, 1, "one commit, one win, in whichever session saw it first");
  assert.equal(b.snapshot("sess-B", at(44)).wins.value, 0);
  // subagents earn their own wins
  b.apply(ev(50, "agent.start", { actor: sub("i1") })); b.apply(tool(55, "Edit", { ext: ".js" }, { actor: sub("i1"), parent: { toolUseId: "x55", agentId: "i1" } }));
  b.apply(ev(60, "agent.stop", { actor: sub("i1") })); b.apply(ev(60, "agent.stop", { actor: sub("i1") }));
  s = b.snapshot("sess-A", at(61)); const aw = s.winDetail.list.filter((w) => w.kind === "subagent");
  assert.equal(aw.length, 1); assert.equal(aw[0].agentId, "i1"); assert.equal(aw[0].tier, "unverified", "the edit staled the evidence"); assert.equal(s.agents.find((a) => a.id === "i1").wins, 1);
  // a foreground subagent that stops but whose Agent call then fails: the win is revoked, a foul opens
  b.apply(ev(70, "agent.start", { actor: sub("i2") })); b.apply(ev(80, "agent.stop", { actor: sub("i2") }));
  b.apply(ev(81, "tool.failure", { payload: { tool: "Agent", failed: true, subagentType: "implementer" }, parent: { toolUseId: "ag2" }, durationMs: 11000 }));
  s = b.snapshot("sess-A", at(82)); assert.equal(s.winDetail.revoked, 1); assert.equal(s.fouls.value, 1);
  // an explicit completion mark is the only "confirmed" tier
  b.apply(ev(90, "task.start", { source: "marks", actor: { type: "human" } , payload: {} }));
  const tid = b.sessions.get("sess-A").current.id;
  b.apply(ev(95, "task.end", { source: "marks", actor: { type: "human" }, payload: {} , parent: undefined }));
  s = b.snapshot("sess-A", at(96)); assert.equal(s.winDetail.confirmed, 1, `marked task ${tid}`);
  assert.ok(s.winDetail.list.every((w) => w.tier !== "confirmed" || w.kind === "task"), "nothing but a mark is confirmed");
});

test("TIMEOUTS: outstanding approvals, questions (hook and transcript), inferred reply questions; idle separate; late transcript facts never reopen", () => {
  const b = new Board();
  b.apply(prompt(0));
  b.apply(ev(5, "permission.request", { payload: { tool: "Bash" } }));
  b.apply(ev(6, "notification", { payload: { kind: "permission_prompt" } }));
  let s = b.snapshot("sess-A", at(7)); assert.equal(s.timeouts.value, 1, "the dialog and its notification are one request"); assert.equal(s.attention[0].kind, "approval");
  b.apply(tool(20, "Bash", {}, { durationMs: 1000 })); assert.equal(b.snapshot("sess-A", at(21)).timeouts.value, 0);
  // Claude Code raises a permission request for AskUserQuestion: it is a question
  b.apply(ev(30, "permission.request", { payload: { tool: "AskUserQuestion" } }));
  b.apply(ev(30, "tool.call", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" } }));
  s = b.snapshot("sess-A", at(31)); assert.equal(s.timeouts.value, 1, "the permission path and the tool call are ONE question");
  const b2 = new Board(); b2.apply(prompt(0)); b2.apply(ev(1, "tool.call", { payload: { tool: "ExitPlanMode" }, parent: { toolUseId: "p1" } })); b2.apply(ev(1, "permission.request", { payload: { tool: "ExitPlanMode" } }));
  assert.equal(b2.snapshot("sess-A", at(2)).timeouts.value, 1, "either order"); assert.equal(b2.snapshot("sess-A", at(2)).attention[0].kind, "plan-approval");
  assert.ok(s.attention.every((a) => a.kind === "question"));
  b.apply(ev(90, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q1" }, durationMs: 60000 }));
  assert.equal(b.snapshot("sess-A", at(91)).timeouts.value, 0);
  // the transcript reports the same question ~2 s later: never reopened
  b.apply(ev(30, "tool.call", { source: "claude-transcript", payload: { tool: "AskUserQuestion", attention: true }, parent: { toolUseId: "q1" } }));
  assert.equal(b.snapshot("sess-A", at(92)).timeouts.value, 0);
  // a reply that ends with a question (inferred) stays until the owner writes; idle notifications are not timeouts
  b.apply(stop(100));
  b.apply(ev(101, "state.change", { source: "claude-transcript", observed: false, actor: { type: "main" }, payload: { change: "attention", state: "open", kind: "question-in-reply" } }));
  b.apply(ev(160, "notification", { payload: { kind: "idle_prompt" } }));
  s = b.snapshot("sess-A", at(170)); assert.equal(s.timeouts.value, 1); assert.equal(s.timeouts.basis, "inferred"); assert.ok(s.idle, "idle shown separately"); assert.equal(s.session.status, "waiting");
  b.apply(prompt(200)); s = b.snapshot("sess-A", at(201)); assert.equal(s.timeouts.value, 0); assert.equal(s.idle, null);
  // an inferred question older than the owner's latest prompt (arrived late) is ignored
  b.apply(ev(150, "state.change", { source: "claude-transcript", observed: false, actor: { type: "main" }, payload: { change: "attention", state: "open", kind: "question-in-reply" } }));
  assert.equal(b.snapshot("sess-A", at(202)).timeouts.value, 0);
  // elicitation dialogs open and close
  b.apply(ev(210, "notification", { payload: { kind: "elicitation_dialog" } })); assert.equal(b.snapshot("sess-A", at(211)).timeouts.value, 1);
  b.apply(ev(220, "notification", { payload: { kind: "elicitation_complete" } })); assert.equal(b.snapshot("sess-A", at(221)).timeouts.value, 0);
});

test("AGENTS: main and subagents apart; missing stops become lost, not running; Agent results end foreground agents, not background launches", () => {
  const b = new Board();
  b.apply(prompt(0));
  b.apply(ev(10, "agent.start", { actor: sub("fg") }));
  b.apply(ev(12, "agent.start", { actor: sub("bg", "researcher") }));
  b.apply(ev(13, "tool.result", { payload: { tool: "Agent", subagentType: "researcher" }, parent: { toolUseId: "launch" }, durationMs: 1500 })); // background launch returns at once
  let s = b.snapshot("sess-A", at(14)); assert.equal(s.player.value, 2, "two subagents running"); assert.equal(s.main.state, "active");
  // the foreground agent's SubagentStop line is missing; its Agent result arrives covering its whole life
  b.apply(ev(70, "tool.result", { payload: { tool: "Agent", subagentType: "implementer" }, parent: { toolUseId: "fgcall" }, durationMs: 61000 }));
  s = b.snapshot("sess-A", at(71));
  const fg = s.agents.find((a) => a.id === "fg"), bg = s.agents.find((a) => a.id === "bg");
  assert.equal(fg.state, "completed"); assert.equal(fg.endBasis, "inferred"); assert.equal(bg.state, "running", "the background agent keeps running (silent for 59 s: running, not active)");
  assert.equal(s.winDetail.list.filter((w) => w.kind === "subagent").length, 1);
  // the background agent never reports a stop and goes silent: lost after 20 minutes, never 'running' forever
  s = b.snapshot("sess-A", at(12 + 21 * 60)); assert.equal(s.agents.find((a) => a.id === "bg").state, "lost"); assert.equal(s.player.value, 0);
  // the process behind the session disappears: everything open is lost and the session ends
  const b2 = new Board(); b2.apply(prompt(0)); b2.apply(ev(5, "agent.start", { actor: sub("z") }));
  b2.apply(ev(30, "state.change", { actor: { type: "system" }, source: "claude-transcript", payload: { change: "registry", name: "x", custom: null, alive: false, status: "busy", repo: null, repoKey: null, folder: "x" } }));
  s = b2.snapshot("sess-A", at(31)); assert.equal(s.session.status, "ended"); assert.equal(s.agents[0].state, "lost");
});

test("GAME CLOCK: unknown without history, a countdown when well supported, overtime once it expires; never time spent", () => {
  const b = new Board();
  b.apply(prompt(0)); b.apply(tool(30, "Read"));
  let s = b.snapshot("sess-A", at(31)); assert.equal(s.game.mode, "unknown"); assert.equal(s.game.basis, "unavailable"); assert.ok(s.stopwatch.activeMs > 0);
  // 40 tight periods of ~5 min (4:50–5:10) of the same size: enough for a confident countdown
  const hist = Array.from({ length: 40 }, (_, i) => ({ id: `h${i}`, features: { type: null, model: null, regime: "turn", size: "s" }, declared: null, actualActiveMs: 290e3 + (i % 5) * 5e3, actualCalls: 10, endedAt: new Date(T0 - 3600e3 + i * 1000).toISOString(), calibratable: true }));
  const b2 = new Board({ taskHistory: hist });
  b2.calibration = { coverage80: 0.8, n: 40 };
  b2.apply(prompt(0, SA, 500)); b2.apply(tool(60, "Edit"));
  s = b2.snapshot("sess-A", at(61));
  assert.equal(s.game.mode, "countdown"); assert.equal(s.game.target.confidence, "high");
  {
    assert.ok(s.game.remainingMs > 3 * 60e3 && s.game.remainingMs < 5 * 60e3);
    for (let t = 90; t <= 600; t += 30) b2.apply(tool(t, "Edit"));
    s = b2.snapshot("sess-A", at(601)); assert.equal(s.game.mode, "overtime", "the established countdown expired → overtime counts up"); assert.ok(s.game.overtimeMs > 0); assert.ok(s.stopwatch.activeMs >= 600e3 - 1e3);
  }
});

test("SHOT CLOCK: next subagent delivery from its own type's history only; unknown under 6, range when spread, countdown when tight, overtime after", () => {
  const mk = (type, n, base, jitter) => Array.from({ length: n }, (_, i) => ({ id: `${type}${i}`, type, durationMs: base + (i % 4) * jitter, endedAt: new Date(T0 - 7200e3 + i * 1000).toISOString() }));
  let b = new Board({ agentHistory: mk("reviewer", 5, 300e3, 10e3) });
  b.apply(prompt(0)); b.apply(ev(10, "agent.start", { actor: sub("r", "reviewer") }));
  assert.equal(b.snapshot("sess-A", at(20)).shot.mode, "unknown", "5 reviewers in history is not enough");
  b = new Board({ agentHistory: mk("reviewer", 8, 120e3, 200e3) });
  b.apply(prompt(0)); b.apply(ev(10, "agent.start", { actor: sub("r", "reviewer") }));
  let s = b.snapshot("sess-A", at(20)); assert.equal(s.shot.mode, "range"); assert.equal(s.shotClock.basis, "predicted"); assert.equal(s.shot.agentType, "reviewer");
  b = new Board({ agentHistory: [...mk("implementer", 14, 600e3, 20e3), ...mk("reviewer", 14, 120e3, 5e3)] });
  b.apply(prompt(0)); b.apply(ev(10, "agent.start", { actor: sub("i", "implementer") })); b.apply(ev(11, "agent.start", { actor: sub("r", "reviewer") }));
  s = b.snapshot("sess-A", at(20)); assert.equal(s.shot.mode, "countdown"); assert.equal(s.shot.agentType, "reviewer", "the reviewer is expected to deliver first");
  s = b.snapshot("sess-A", at(11 + 400)); assert.equal(s.shot.agentType, "reviewer"); assert.equal(s.shot.mode, "overtime");
  b.apply(ev(500, "agent.stop", { actor: sub("r", "reviewer") }));
  s = b.snapshot("sess-A", at(501)); assert.equal(s.shot.agentType, "implementer");
});

test("SESSIONS: focus holds a busy session, never leaves a pinned one; cycle list skips ended/stale; labels come from the best evidence", () => {
  const b = new Board();
  b.apply(prompt(0, SA)); b.apply(tool(5, "Read", {}, { session: SA }));
  assert.equal(b.focusSession(null, at(6)), "sess-A");
  b.apply(prompt(10, SB));
  assert.equal(b.focusSession(null, at(11)), "sess-A", "A was active 6 s ago: held, no flipping");
  assert.equal(b.focusSession(null, at(80)), "sess-B", "A quiet for over a minute: follow B");
  assert.equal(b.focusSession("sess-A", at(5000)), "sess-A", "pinned wins regardless of activity");
  b.apply(ev(20, "session.end", { session: SA, payload: { reason: "other" } }));
  assert.deepEqual(b.cycleList(at(21)).map((x) => x.id), ["sess-B"]);
  // labels: custom > title > repo > registry > folder > id
  const s = b.sessions.get("sess-B");
  assert.deepEqual(sessionLabel(s), { text: "proj", source: "folder" });
  s.identity.regName = "user-71"; assert.equal(sessionLabel(s).source, "registry");
  s.identity.repo = "alexandria-scoreboard"; s.identity.branch = "feat/x"; assert.deepEqual(sessionLabel(s), { text: "alexandria-scoreboard · feat/x", source: "repo" });
  s.identity.title = "Scoreboard overhaul"; assert.equal(sessionLabel(s).text, "Scoreboard overhaul");
  s.identity.regCustom = "my terminal"; assert.deepEqual(sessionLabel(s), { text: "my terminal", source: "custom" });
  // attention in another session is listed for the badge without changing focus
  b.apply(ev(30, "tool.call", { session: SA.id === "x" ? SA : { id: "sess-C", project: "c" }, payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "qc" } }));
  const c = b.sessionList(at(31)).find((x) => x.id === "sess-C"); assert.equal(c.attention.length, 1); assert.equal(c.status, "waiting");
  assert.equal(b.focusSession("sess-B", at(31)), "sess-B");
});

test("session facts: identity from transcripts (sticky repo, HEAD ignored, revisits re-emitted), owner questions, reply questions, no content", () => {
  const SECRET = "SECRET-CONTENT-MARKER";
  const roots = { "C:/w/repo-a": "C:/w/repo-a", "C:/w/repo-a/src": "C:/w/repo-a", "C:/w/repo-b": "C:/w/repo-b" };
  const resolveRoot = (d) => roots[d] || null;
  const line = (o) => JSON.stringify({ sessionId: "s1", ...o });
  const L = [
    line({ type: "user", cwd: "C:/w/repo-a", gitBranch: "HEAD", timestamp: "2026-11-12T10:00:00.000Z", message: { content: `please ${SECRET}` } }),
    line({ type: "ai-title", aiTitle: "Fix the parser", timestamp: "2026-11-12T10:00:01.000Z" }),
    line({ type: "assistant", cwd: "C:/w/repo-a/src", timestamp: "2026-11-12T10:00:05.000Z", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: SECRET }] } }] } }),
    line({ type: "user", cwd: "C:/notes", timestamp: "2026-11-12T10:01:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: SECRET }] } }),
    line({ type: "assistant", cwd: "C:/w/repo-b", timestamp: "2026-11-12T10:02:00.000Z", message: { content: [{ type: "text", text: `Done with ${SECRET}.\n\nShould I also publish it?` }], stop_reason: "end_turn" } }),
    line({ type: "system", subtype: "turn_duration", timestamp: "2026-11-12T10:02:01.000Z", durationMs: 100 }),
    line({ type: "assistant", cwd: "C:/w/repo-a", timestamp: "2026-11-12T10:03:00.000Z", message: { content: [{ type: "text", text: "All tests pass." }] } }),
  ].join("\n");
  const evs = scanTranscriptChunk(L, { sessionId: "s1", resolveRoot, state: newFactsState() });
  const json = JSON.stringify(evs); assert.ok(!json.includes(SECRET), "no transcript content leaves the scanner"); assert.ok(!json.includes("C:/w"), "no paths leave the scanner");
  const ids = evs.filter((e) => e.payload?.change === "identity");
  assert.deepEqual(ids.map((e) => [e.payload.repo, e.payload.folder]), [["repo-a", "repo-a"], ["repo-a", "repo-a"], ["repo-a", "src"], ["repo-a", "notes"], ["repo-b", "repo-b"], ["repo-a", "repo-a"]]);
  assert.equal(ids[0].payload.branch, null, "HEAD is not a branch name"); assert.equal(ids[1].payload.title, "Fix the parser");
  assert.equal(ids[3].payload.repo, "repo-a", "a folder outside any repo keeps the last repository");
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, "a revisit to repo-a is a new event, not a duplicate id");
  assert.ok(evs.some((e) => e.kind === "tool.call" && e.payload.tool === "AskUserQuestion" && e.parent.toolUseId === "q1"));
  assert.ok(evs.some((e) => e.payload?.change === "attention" && e.payload.state === "closed" && e.parent.toolUseId === "q1"));
  const q = evs.filter((e) => e.payload?.kind === "question-in-reply"); assert.equal(q.length, 1); assert.equal(q[0].provenance.observed, false);
});

test("endsWithQuestion looks at the closing paragraph only, ignoring code", () => {
  assert.equal(endsWithQuestion("Done.\n\nWant me to push it?"), true);
  assert.equal(endsWithQuestion("Is it ready? Yes.\n\nIt is pushed."), false);
  assert.equal(endsWithQuestion("Here:\n```js\nconst a = b ? c : d?\n```"), false);
  assert.equal(endsWithQuestion("Options:\n- **A?**\n- B\n\nWhich one do you prefer?)"), true);
  assert.equal(endsWithQuestion(""), false); assert.equal(endsWithQuestion(null), false);
});

test("registry: custom names only when the owner set them; liveness reported once per change; git roots by walking up", () => {
  const memo = new Map();
  const e1 = registryEvents([{ sessionId: "abcdef01-0000", pid: 1, alive: true, name: "user-71", nameSource: "derived", status: "busy", cwd: null }], { memo, now: "2026-11-12T10:00:00.000Z" });
  assert.equal(e1.length, 1); assert.equal(e1[0].payload.custom, null); assert.equal(e1[0].payload.name, "user-71");
  assert.equal(registryEvents([{ sessionId: "abcdef01-0000", pid: 1, alive: true, name: "user-71", nameSource: "derived", status: "busy", cwd: null }], { memo }).length, 0, "unchanged → nothing");
  const e2 = registryEvents([{ sessionId: "abcdef01-0000", pid: 1, alive: false, name: "Release work", nameSource: "user", status: "idle", cwd: null }], { memo });
  assert.equal(e2[0].payload.custom, "Release work"); assert.equal(e2[0].payload.alive, false);
  const exists = (p) => p.replace(/\\/g, "/") === "C:/w/repo/.git";
  assert.equal(gitRootOf("C:/w/repo/a/b", { exists }).replace(/\\/g, "/"), "C:/w/repo");
  assert.equal(gitRootOf("C:/elsewhere", { exists }), null);
  assert.notEqual(repoKey("C:/w/one/app"), repoKey("C:/w/two/app"), "same folder name, different repositories");
});

test("a question raised through the permission path stops the clock only until work resumes (regression: live 2026-11-12)", () => {
  const b = new Board();
  b.apply(prompt(0)); b.apply(tool(10, "Read"));
  b.apply(ev(20, "permission.request", { payload: { tool: "AskUserQuestion" } }));
  b.apply(ev(26, "notification", { payload: { kind: "permission_prompt" } })); // Claude Code notifies about the question dialog too
  let s = b.snapshot("sess-A", at(100)); assert.equal(s.stopwatch.state, "waiting"); assert.equal(s.stopwatch.kind, "question");
  assert.equal(s.timeouts.value, 1, "one question, not a question plus a permission"); assert.equal(s.stopwatch.byKind.approval || 0, 0);
  b.apply(ev(200, "tool.result", { payload: { tool: "AskUserQuestion" }, parent: { toolUseId: "q9" }, durationMs: 180000 }));
  for (let t = 260; t <= 1200; t += 60) b.apply(tool(t, "Edit", { ext: ".js" }, { durationMs: 1000 }));
  s = b.snapshot("sess-A", at(1201));
  assert.equal(s.stopwatch.state, "active"); assert.equal(s.timeouts.value, 0);
  assert.ok(s.stopwatch.activeMs > 15 * 60e3, `work after the answer counts as active, got ${Math.round(s.stopwatch.activeMs / 1000)} s`);
  assert.ok(Math.abs(s.stopwatch.byKind.question - 180e3) < 2000, `the question wait is the 3 minutes until the answer, got ${s.stopwatch.byKind.question}`);
});

test("npm run scripts are checks; chained failures blame nothing; a later pass of the same kind resolves (inferred); parallel tools do not decide an approval; failed agents stay out of shot-clock history", () => {
  const b = new Board();
  b.apply(identity(0, SA, "repo")); b.apply(prompt(1));
  b.apply(fail(5, "Bash", { signature: "npm run build" }));
  assert.equal(b.snapshot("sess-A", at(6)).fouls.value, 1, "npm run build is a build check (logger v5 keeps the script name)");
  b.apply(fail(7, "Bash", { signature: "tsc", signatures: ["tsc", "npm test"] }));
  let s = b.snapshot("sess-A", at(8)); assert.equal(s.fouls.value, 1, "tsc && npm test failing: which one failed is not observable, no new foul");
  assert.ok(s.log.some((l) => /which one is not observable/.test(l.text)));
  b.apply(ev(10, "test.run", { payload: { framework: "node:test", passed: 3, failed: 1, ok: false, label: "node --test" } }));
  b.apply(ev(20, "test.run", { payload: { framework: "node:test", passed: 4, failed: 0, ok: true, label: "npm test" } }));
  s = b.snapshot("sess-A", at(21));
  const r = s.foulDetail.resolved.find((f) => f.key === "test:node --test"); assert.ok(r); assert.equal(r.resolutionBasis, "inferred");
  // a Read that began before the approval request finishes after it: the approval is still pending
  b.apply(ev(30, "permission.request", { payload: { tool: "Bash" } }));
  b.apply(ev(32, "tool.result", { payload: { tool: "Read" }, parent: { toolUseId: "par" }, durationMs: 5000 }));
  assert.equal(b.snapshot("sess-A", at(33)).timeouts.value, 1);
  b.apply(ev(60, "tool.result", { payload: { tool: "Bash" }, parent: { toolUseId: "apr" }, durationMs: 1000 }));
  assert.equal(b.snapshot("sess-A", at(61)).timeouts.value, 0);
  // a subagent whose Agent call failed is not shot-clock history
  b.apply(ev(70, "agent.start", { actor: sub("bad", "scout") }));
  b.apply(ev(100, "tool.failure", { payload: { tool: "Agent", failed: true, subagentType: "scout" }, parent: { toolUseId: "agbad" }, durationMs: 31000 }));
  assert.equal(b.agentHistory.filter((h) => h.id.endsWith(":bad")).length, 0);
  const b2 = new Board(); b2.apply(prompt(0)); b2.apply(ev(5, "agent.start", { actor: sub("bad2", "scout") })); b2.apply(ev(40, "agent.stop", { actor: sub("bad2", "scout") }));
  assert.equal(b2.agentHistory.length, 1);
  b2.apply(ev(41, "tool.failure", { payload: { tool: "Agent", failed: true, subagentType: "scout" }, parent: { toolUseId: "agbad2" }, durationMs: 37000 }));
  assert.equal(b2.agentHistory.length, 0, "removed again when its call fails after the stop");
});

test("endsWithQuestion: only the closing line of the reply counts", () => {
  assert.equal(endsWithQuestion("Plan:\n- Is the cache warm?\n- Rebuild it.\n"), false);
  assert.equal(endsWithQuestion("Tests pass. Should I merge?\nOtherwise I stop here."), false);
  assert.equal(endsWithQuestion("Tests pass.\nShould I merge?"), true);
});

test("a single passing file never clears a red suite of the same kind; unknown counts never resolve by inference", () => {
  const b = new Board();
  b.apply(identity(0, SA, "repo")); b.apply(prompt(1));
  b.apply(ev(10, "test.run", { payload: { framework: "node:test", passed: 88, failed: 12, ok: false, label: "npm test" } }));
  b.apply(ev(20, "test.run", { payload: { framework: "node:test", passed: 5, failed: 0, ok: true, label: "node --test" } }));
  assert.equal(b.snapshot("sess-A", at(21)).fouls.value, 1, "5 passing tests do not cover a 100-test suite");
  b.apply(ev(30, "tool.failure", { payload: { tool: "Bash", failed: true, signature: "npm run test:e2e" }, parent: { toolUseId: "e2e" } }));
  b.apply(ev(40, "test.run", { payload: { framework: "node:test", passed: 200, failed: 0, ok: true, label: "npm run test:unit" } }));
  const s = b.snapshot("sess-A", at(41));
  assert.deepEqual(s.foulDetail.unresolved.map((f) => f.key), ["test:npm run test:e2e"], "the e2e failure had no counts: only its own pass resolves it");
});
