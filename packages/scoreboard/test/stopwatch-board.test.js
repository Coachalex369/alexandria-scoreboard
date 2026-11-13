// Stopwatch & ETA v0.2 on the board: waiting states, owner time, rate limits, model, records, ETA states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { parseHookLog } from "../../event-engine/src/adapters/claudeHooks.js";
import { Board } from "../src/board.js";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
let n = 0;
const S = { id: "sess-sw", project: "proj" };
const ev = (t, kind, extra = {}) => { const { actor = { type: "main" }, payload, parent, task, source = "claude-hooks", durationMs, observed = true, session = S } = extra; return makeEvent({ id: `evt_sw_${String(++n).padStart(6, "0")}`, ts: T0 + t * 1000, source, kind, session, actor, parent, task, payload, durationMs, provenance: { observed, adapter: "test", confidence: 1 } }); };
const at = (t) => T0 + t * 1000;
const prompt = (t, len = 900) => ev(t, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: len } });
const tool = (t, name = "Edit", dur = 0, extra = {}) => ev(t, "tool.result", { payload: { tool: name }, parent: { toolUseId: `tu${t}` }, durationMs: dur, ...extra });

test("a period ends at Stop: the owner's time before the next prompt is in no period; the next prompt starts a fresh clock", () => {
  const recs = [];
  const b = new Board({ onTaskComplete: (r) => recs.push(r) });
  b.apply(prompt(0)); b.apply(tool(60)); b.apply(ev(120, "turn.stop"));
  let s = b.snapshot("sess-sw", at(20 * 60));
  assert.equal(s.game.mode, "final"); assert.equal(s.stopwatch.activeMs, 120e3, "only the two minutes of the turn count"); assert.equal(s.phase.value, "DONE");
  assert.equal(recs.length, 1); assert.equal(recs[0].actualActiveMs, 120e3); assert.equal(recs[0].endReason, "turn-end"); assert.equal(recs[0].features.regime, "turn");
  b.apply(prompt(20 * 60, 40)); b.apply(tool(21 * 60));
  s = b.snapshot("sess-sw", at(22 * 60));
  assert.equal(s.stopwatch.state, "active"); assert.equal(s.stopwatch.activeMs, 120e3); assert.equal(s.period.value, 2);
});

test("a rate limit stops the clock with the reset time; work resumes when the next tool starts", () => {
  const b = new Board();
  b.apply(prompt(0)); b.apply(tool(30));
  b.apply(ev(60, "api.error", { source: "claude-transcript", actor: { type: "system" }, payload: { error: "rate_limit", status: 429, resetsAt: "2026-11-10T11:00:00.000Z", endsTurn: true } }));
  let s = b.snapshot("sess-sw", at(30 * 60));
  assert.equal(s.stopwatch.kind, "rate_limit"); assert.equal(s.rateLimit.resetsAt, "2026-11-10T11:00:00.000Z"); assert.equal(s.stopwatch.activeMs, 60e3);
  assert.ok(b.takeAlerts().some((a) => a.kind === "rate-limit"));
  b.apply(ev(31 * 60, "notification", { payload: { kind: "quota_auto_resume_fired" } })); b.apply(tool(32 * 60, "Bash", 30e3));
  s = b.snapshot("sess-sw", at(33 * 60));
  assert.equal(s.stopwatch.state, "active"); assert.equal(s.stopwatch.byKind.rate_limit, 30 * 60e3); assert.equal(s.stopwatch.activeMs, 60e3 + 2 * 60e3);
});

test("a permission request's wait ends when the approved tool started (duration_ms excludes the prompt)", () => {
  const b = new Board();
  b.apply(prompt(0)); b.apply(ev(10, "permission.request", { payload: { tool: "Bash" } }));
  assert.equal(b.snapshot("sess-sw", at(100)).stopwatch.kind, "approval");
  b.apply(tool(110, "Bash", 20e3)); // approved at ~90 s, ran 20 s
  const s = b.snapshot("sess-sw", at(120));
  assert.equal(s.stopwatch.byKind.approval, 80e3); assert.equal(s.stopwatch.activeMs, 120e3 - 80e3);
});

test("AskUserQuestion's run time is owner time; an owner-approved transcript call is approval time", () => {
  const b = new Board();
  b.apply(prompt(0)); b.apply(tool(100, "AskUserQuestion", 90e3));
  b.apply(ev(200, "tool.result", { source: "claude-transcript", payload: { tool: "Bash", approvalWaitMs: 50e3, ownerApproved: true }, parent: { toolUseId: "tx1" }, durationMs: 0 }));
  const s = b.snapshot("sess-sw", at(200));
  assert.equal(s.stopwatch.byKind.question, 90e3); assert.equal(s.stopwatch.byKind.approval, 50e3); assert.equal(s.stopwatch.activeMs, 200e3 - 140e3);
});

test("background subagents outlive the period: their work after Stop opens no period, they stay running and still deliver", () => {
  const b = new Board();
  const sub = { type: "subagent", agentId: "ag1", agentType: "implementer" };
  b.apply(prompt(0)); b.apply(ev(10, "agent.start", { actor: sub })); b.apply(ev(20, "turn.stop"));
  b.apply(tool(200, "Edit", 0, { actor: sub, parent: { toolUseId: "s1", agentId: "ag1" } }));
  let s = b.snapshot("sess-sw", at(250));
  assert.equal(s.stopwatch.activeMs, 20e3, "the period ended with the main turn"); assert.equal(s.player.value, 1); assert.equal(s.session.periods, 1);
  b.apply(ev(300, "agent.stop", { actor: sub }));
  s = b.snapshot("sess-sw", at(600));
  assert.equal(s.player.value, 0); assert.equal(s.wins.value, 1); assert.equal(s.agents[0].edits, 1);
});

test("declared pause and external waits from marks are excluded and carry the declared basis", () => {
  const b = new Board();
  b.apply(ev(0, "task.start", { source: "marks", actor: { type: "human" }, task: { id: "P1", title: "x" } }));
  b.apply(ev(60, "task.pause", { source: "marks", actor: { type: "human" }, task: { id: "P1" } }));
  b.apply(ev(120, "task.resume", { source: "marks", actor: { type: "human" }, task: { id: "P1" } }));
  b.apply(ev(180, "wait.begin", { source: "marks", actor: { type: "human" }, task: { id: "P1" }, payload: { kind: "external" } }));
  const live = b.snapshot("sess-sw", at(200)); assert.equal(live.stopwatch.kind, "external"); assert.equal(live.stopwatch.basis, "declared");
  b.apply(ev(240, "wait.end", { source: "marks", actor: { type: "human" }, task: { id: "P1" }, payload: { kind: "external" } }));
  const s = b.snapshot("sess-sw", at(300));
  assert.equal(s.stopwatch.pausedMs, 60e3); assert.equal(s.stopwatch.byKind.external, 60e3); assert.equal(s.stopwatch.activeMs, 180e3);
});

test("main-thread model comes from observed model responses; tokens accumulate per task", () => {
  const b = new Board();
  b.apply(prompt(0));
  assert.equal(b.snapshot("sess-sw", at(1)).model.basis, "unavailable");
  b.apply(ev(5, "model.response", { source: "claude-transcript", payload: { model: "claude-opus-5-5", inputTokens: 10, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 100 } }));
  b.apply(ev(9, "model.response", { source: "claude-transcript", payload: { model: "claude-opus-5-5", inputTokens: 1, outputTokens: 50 } }));
  const s = b.snapshot("sess-sw", at(10));
  assert.equal(s.model.value, "claude-opus-5-5"); assert.equal(s.model.basis, "observed");
  assert.equal(s.tokens.outputTokens, 250); assert.equal(s.tokens.cacheReadTokens, 5000); assert.equal(s.tokens.responses, 2);
});

test("ETA states: insufficient data without history; a reference-class range once history exists; completed records feed history", () => {
  const recs = [];
  const b = new Board({ onTaskComplete: (r) => recs.push(r) });
  b.apply(prompt(0)); b.apply(tool(60));
  let s = b.snapshot("sess-sw", at(61));
  assert.equal(s.etaV2.state, "insufficient-data"); assert.equal(s.etaV2.remaining, null); assert.equal(s.shotClock.basis, "unavailable");
  // eight periods of 5 active minutes each, separated by owner gaps
  for (let i = 1; i <= 8; i++) { const t0 = i * 3600; b.apply(prompt(t0)); b.apply(tool(t0 + 300)); b.apply(ev(t0 + 300, "turn.stop")); }
  b.apply(prompt(10 * 3600)); b.apply(tool(10 * 3600 + 60));
  assert.equal(recs.length, 9); assert.equal(recs[1].actualActiveMs, 300e3); assert.equal(recs[1].features.regime, "turn"); assert.equal(recs[1].features.size, "s");
  assert.ok(!JSON.stringify(recs).match(/prompt"|text"/), "records carry no content");
  s = b.snapshot("sess-sw", at(10 * 3600 + 120));
  assert.equal(s.etaV2.method, "reference-class"); assert.equal(s.etaV2.state, "estimating"); assert.ok(s.etaV2.remaining.p50 > 0 && s.etaV2.remaining.p50 <= 300e3);
  assert.ok(["low", "medium"].includes(s.etaV2.confidence));
  assert.equal(recs[8].predictionAtStart.method, "reference-class", "the ninth period was predicted from the eight before it");
  // the ninth period is open; with n 8 the confidence stays below "medium" → a labelled estimate (EST + range)
  assert.equal(s.game.mode, "countdown"); assert.equal(s.game.estimate, true, "low confidence: a labelled estimate with a range, still counting down");
});

test("finalizeStale closes a period whose Stop was never seen, at the session's last event", () => {
  const b = new Board();
  b.apply(prompt(0)); b.apply(tool(60)); // the Stop hook line is missing
  const done = b.finalizeStale(at(5 * 3600));
  assert.equal(done.length, 1); assert.equal(done[0].endedAt, new Date(at(60)).toISOString()); assert.equal(done[0].endReason, "session-quiet");
  const ok = new Board(); ok.apply(prompt(0)); ok.apply(tool(60)); ok.apply(ev(90, "turn.stop"));
  assert.equal(ok.finalizeStale(at(5 * 3600)).length, 0, "a period that ended at its Stop is already closed");
});

test("collector v3 hook lines map to stopwatch events without content", () => {
  const sid = "s3";
  const lines = [
    { ts: "2026-11-10T10:00:00.000Z", ev: "SessionStart", sid, proj: "p", v: 3, source: "startup", model: "claude-opus-5-5" },
    { ts: "2026-11-10T10:00:01.000Z", ev: "UserPromptSubmit", sid, proj: "p", v: 3, promptLen: 1200 },
    { ts: "2026-11-10T10:00:05.000Z", ev: "PermissionRequest", sid, proj: "p", v: 3, tool: "Bash" },
    { ts: "2026-11-10T10:00:30.000Z", ev: "PostToolUse", sid, proj: "p", v: 3, tool: "Bash", tuid: "t1", durMs: 5000 },
    { ts: "2026-11-10T10:01:00.000Z", ev: "StopFailure", sid, proj: "p", v: 3, error: "rate_limit", status: 429 },
  ].map((x) => JSON.stringify(x)).join("\n");
  const evs = parseHookLog(lines);
  assert.deepEqual(evs.map((e) => e.kind), ["session.start", "prompt.submit", "permission.request", "tool.result", "api.error"]);
  assert.equal(evs[0].payload.model, "claude-opus-5-5"); assert.equal(evs[4].payload.error, "rate_limit"); assert.equal(evs[4].provenance.adapter, "claude-hooks@3");
  const b = new Board(); for (const e of evs) b.apply(e);
  const s = b.snapshot(sid, Date.parse("2026-11-10T10:05:00.000Z"));
  assert.equal(s.model.value, "claude-opus-5-5"); assert.equal(s.stopwatch.kind, "rate_limit");
  assert.equal(s.stopwatch.byKind.approval, 20e3, "approval from 10:00:05 to the tool's start at 10:00:25");
  assert.equal(s.stopwatch.activeMs, 60e3 - 1e3 - 20e3);
});
