import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeEvent, validateEvent, SCHEMA } from "../src/schema.js";
import { stableId, newId } from "../src/ids.js";
import { EventStore } from "../src/store.js";
import { Replayer, LiveState } from "../src/replay.js";
import { linkTasks, waitingMs, paceStats } from "../src/tasks.js";
import { parseHookLog } from "../src/adapters/claudeHooks.js";
import { parseGitLog, commitsToEvents } from "../src/adapters/git.js";
import { parseTestOutput, testRunEvent, ghRunToEvent } from "../src/adapters/testOutput.js";

const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ev = (kind, s, extra = {}) => makeEvent({ id: newId(), ts: at(s), source: "synthetic", kind, session: { id: "S1", project: "demo" }, actor: { type: "main" }, ...extra });

test("schema: builder produces valid facts and the validator rejects raw content", () => {
  const e = ev("tool.result", 1, { payload: { tool: "Bash" }, durationMs: 120 });
  assert.equal(e.schema, SCHEMA);
  assert.deepEqual(validateEvent(e), []);
  assert.ok(validateEvent({ ...e, kind: "nope" }).length > 0);
  assert.ok(validateEvent({ ...e, payload: { stdout: "secret output" } }).some((m) => /stdout/.test(m)));
  assert.ok(validateEvent({ ...e, classification: [{ scheme: "work-category", value: "testing", basis: "guess", confidence: 0.5 }] }).length > 0);
});

test("ids: stableId is deterministic and distinct per input; newId is unique", () => {
  assert.equal(stableId("evt", "a", 1), stableId("evt", "a", 1));
  assert.notEqual(stableId("evt", "a", 1), stableId("evt", "a", 2));
  const ids = new Set(Array.from({ length: 500 }, () => newId()));
  assert.equal(ids.size, 500);
});

test("store: appends, persists to JSONL, dedupes by id across reloads", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ee-")), "store.jsonl");
  const s1 = new EventStore(file);
  const a = ev("session.start", 0), b = ev("tool.result", 5, { payload: { tool: "Read" } });
  assert.equal(s1.append([a, b]), 2);
  assert.equal(s1.append([a]), 0, "duplicate ignored");
  const s2 = new EventStore(file);
  assert.equal(s2.events.length, 2);
  assert.equal(s2.append([b]), 0);
  assert.equal(s2.stats().byKind["tool.result"], 1);
});

test("replay: drain emits in time order; timed replay honours speed with a fake clock", () => {
  const events = [ev("tool.result", 10, { payload: { tool: "Edit" } }), ev("session.start", 0), ev("tool.result", 4, { payload: { tool: "Read" } })];
  const seen = [];
  const r = new Replayer(events);
  r.on("event", ({ event }) => seen.push(event.kind + "@" + event.ts));
  r.drain();
  assert.deepEqual(seen.map((s) => s.split("@")[1]), [at(0), at(4), at(10)]);
  assert.equal(r.state, "done");

  // fake timers: a 10 s recording at speed 5 should take 2 s of wall time
  let now = 0; const timers = [];
  const r2 = new Replayer(events, { speed: 5, now: () => now, setTimer: (fn, ms) => { timers.push({ fn, due: now + ms }); return timers.length; }, clearTimer: () => {} });
  const got = [];
  r2.on("event", ({ event }) => got.push(event.ts));
  r2.start();
  let guard = 0;
  while (r2.state === "playing" && guard++ < 20) { const t = timers.shift(); now = Math.max(now, t.due); t.fn(); }
  assert.deepEqual(got, [at(0), at(4), at(10)]);
  assert.ok(now >= 2000 && now <= 2100, `wall time ${now}ms for a 10s recording at 5x`);
});

test("live state: open tools, agents and waiting are tracked; subagent stop does not end the task", () => {
  const live = new LiveState();
  const session = { id: "S1", project: "demo" };
  const mk = (kind, s, extra) => makeEvent({ id: newId(), ts: at(s), source: "synthetic", kind, session, actor: { type: "main" }, ...extra });
  live.apply(mk("task.start", 0, { task: { id: "T1", title: "x" } }));
  live.apply(mk("tool.call", 1, { parent: { toolUseId: "tu1" }, payload: { tool: "Agent" } }));
  live.apply(mk("agent.start", 2, { actor: { type: "subagent", agentId: "A1", agentType: "implementer", model: "claude-sonnet-5-5" }, parent: { toolUseId: "tu1" } }));
  assert.equal(live.runningAgents("S1").length, 1);
  live.apply(mk("agent.stop", 30, { actor: { type: "subagent", agentId: "A1" } }));
  assert.equal(live.runningAgents("S1").length, 0);
  assert.equal(live.openTasks("S1").length, 1, "task still open after the subagent stopped");
  live.apply(mk("notification", 31, { payload: { kind: "permission_prompt" } }));
  assert.equal(live.sessions.get("S1").waiting.kind, "permission");
  live.apply(mk("tool.result", 40, { parent: { toolUseId: "tu1" }, payload: { tool: "Agent" } }));
  assert.equal(live.sessions.get("S1").waiting, null);
  live.apply(mk("task.end", 41, { task: { id: "T1" } }));
  assert.equal(live.openTasks("S1").length, 0);
});

test("tasks: explicit marks define tasks exactly; inferred tasks split on long prompts; waits are subtracted", () => {
  const session = { id: "S1", project: "demo" };
  const mk = (kind, s, extra) => makeEvent({ id: newId(), ts: at(s), source: "marks", kind, session, actor: { type: "main" }, ...extra });
  const marked = [
    mk("task.start", 0, { task: { id: "T1", title: "first" } }), mk("tool.result", 10, { payload: { tool: "Read" } }),
    mk("tool.call", 20, { payload: { tool: "AskUserQuestion" } }), mk("tool.result", 80, { payload: { tool: "AskUserQuestion" } }),
    mk("task.end", 100, { task: { id: "T1" } }),
  ];
  const t = linkTasks(marked);
  assert.equal(t.length, 1); assert.equal(t[0].basis, "observed"); assert.equal(t[0].wallMs, 100e3); assert.equal(t[0].waitingMs, 60e3); assert.equal(t[0].workMs, 40e3); assert.equal(t[0].toolCalls, 2);

  const human = (s, len) => makeEvent({ id: newId(), ts: at(s), source: "claude-hooks", kind: "prompt.submit", session, actor: { type: "human" }, payload: { promptLen: len } });
  const inferred = linkTasks([human(0, 800), mk("tool.result", 30, { payload: { tool: "Edit" } }), mk("turn.stop", 60), human(70, 20), mk("tool.result", 90, { payload: { tool: "Edit" } }), mk("turn.stop", 100), human(200, 900), mk("turn.stop", 260)]);
  assert.equal(inferred.length, 2, "short follow-up continues the task; a new brief starts another");
  assert.equal(inferred[0].basis, "inferred"); assert.equal(inferred[0].toolCalls, 2); assert.equal(inferred[0].wallMs, 100e3);
  assert.equal(waitingMs([]), 0);
  const pace = paceStats(marked);
  assert.equal(pace.calls, 2); assert.equal(pace.medianGapMs, 70e3);
});

test("claude-hooks adapter: maps hook events to facts, links subagents, keeps no text", () => {
  const log = [
    { ts: at(0), ev: "SessionStart", sid: "S9", proj: "demo-shop-app", source: "startup", hookMs: 9 },
    { ts: at(1), ev: "UserPromptSubmit", sid: "S9", pid: "P1", proj: "demo-shop-app", perm: "auto", promptLen: 71, hookMs: 8 },
    { ts: at(5), ev: "PostToolUse", sid: "S9", pid: "P1", proj: "demo-shop-app", tool: "Bash", tuid: "tu1", durMs: 1815, hookMs: 8 },
    { ts: at(6), ev: "SubagentStart", sid: "S9", pid: "P1", proj: "demo-shop-app", agent: "A7", agentType: "implementer", hookMs: 7 },
    { ts: at(7), ev: "PostToolUse", sid: "S9", pid: "P1", proj: "demo-shop-app", agent: "A7", agentType: "implementer", tool: "Edit", tuid: "tu2", durMs: 40, hookMs: 7 },
    { ts: at(8), ev: "SubagentStop", sid: "S9", pid: "P1", proj: "demo-shop-app", agent: "A7", agentType: "implementer", hookMs: 7 },
    { ts: at(9), ev: "Stop", sid: "S9", pid: "P1", proj: "demo-shop-app", stopHookActive: false, hookMs: 8 },
  ].map((o) => JSON.stringify(o)).join("\n");
  const events = parseHookLog(log, { file: "t.jsonl" });
  assert.equal(events.length, 7);
  assert.deepEqual(events.map((e) => e.kind), ["session.start", "prompt.submit", "tool.result", "agent.start", "tool.result", "agent.stop", "turn.stop"]);
  assert.equal(events[2].durationMs, 1815);
  assert.equal(events[2].classification.find((c) => c.scheme === "operation").value, "run");
  assert.equal(events[4].actor.type, "subagent"); assert.equal(events[4].actor.agentId, "A7"); assert.equal(events[4].parent.agentId, "A7");
  assert.equal(events[1].actor.type, "human"); assert.equal(events[1].payload.promptLen, 71);
  for (const e of events) assert.deepEqual(validateEvent(e), []);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(parseHookLog(log, { file: "t.jsonl" })[0].id, events[0].id, "ids are stable across re-ingest");
});

test("git adapter: parses numstat records and classifies changed paths", () => {
  const text = "\x1eabc123\x1f2026-11-08T10:00:00+00:00\x1fClaude\x1ffix thing\x1fdef456\n5\t2\tsrc/server/app.js\n10\t0\ttest/app.test.js\n-\t-\tpublic/logo.png\n";
  const commits = parseGitLog(text);
  assert.equal(commits.length, 1); assert.equal(commits[0].files.length, 3); assert.equal(commits[0].files[2].added, null);
  const events = commitsToEvents(commits, { project: "demo-shop-app" });
  assert.equal(events.length, 4);
  assert.equal(events[0].kind, "git.commit"); assert.equal(events[0].payload.added, 15);
  const testChange = events.find((e) => e.payload?.path === "test/app.test.js");
  assert.ok(testChange.classification.some((c) => c.scheme === "work-category" && c.value === "testing"));
  assert.ok(testChange.classification.some((c) => c.scheme === "language" && c.value === "javascript" && c.basis === "observed"));
  for (const e of events) assert.deepEqual(validateEvent(e), []);
});

test("test-output adapter: recognizes node:test, Godot, jest, TAP, harness totals; gh runs become build events", () => {
  assert.deepEqual(parseTestOutput("ℹ tests 5\nℹ pass 464\nℹ fail 0\nℹ skipped 0\nℹ duration_ms 9210.4"), { framework: "node:test", passed: 464, failed: 0, skipped: 0, durationMs: 9210, exitCode: null, ok: true });
  assert.equal(parseTestOutput("TOTAL: 5091 passed, 0 failed").passed, 5091);
  assert.equal(parseTestOutput("Tests:       2 failed, 10 passed, 12 total").failed, 2);
  assert.equal(parseTestOutput("ok 1 a\nnot ok 2 b\nok 3 c").failed, 1);
  assert.equal(parseTestOutput("TOTAL PASS=120 FAIL=3 scripts_with_problems=1 (of 9)").ok, false);
  assert.equal(parseTestOutput("garbage", { exitCode: 0 }).ok, true);
  const e = testRunEvent({ ts: at(0), session: { id: "S1", project: "demo" }, result: parseTestOutput("TOTAL: 1 passed, 0 failed"), label: "godot" });
  assert.equal(e.kind, "test.run"); assert.equal(e.payload.ok, true);
  const b = ghRunToEvent({ databaseId: 1, status: "completed", conclusion: "success", createdAt: at(0), updatedAt: at(150), jobs: [{ steps: [{ name: "Run tests", conclusion: "success" }] }] }, { project: "pp" });
  assert.equal(b.kind, "build.run"); assert.equal(b.durationMs, 150e3); assert.equal(b.actor.type, "ci");
});
