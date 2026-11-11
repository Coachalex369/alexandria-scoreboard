// Transcript adapter: content-free extraction, rate limits, waits, subagents, supplement mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, parseSubagentTranscript, newTranscriptState, finishTranscript, isHumanPrompt } from "../src/adapters/claudeTranscript.js";

const SECRET = "TEST-SECRET-PLACEHOLDER";
const sid = "abcdef12-0000-0000-0000-000000000000";
const line = (o) => JSON.stringify({ sessionId: sid, cwd: "C:/work/myproj", ...o });
const asst = (ts, id, content, extra = {}) => line({ type: "assistant", timestamp: ts, uuid: `u-${ts}`, message: { id, model: "claude-opus-5-5", role: "assistant", content, stop_reason: extra.stop || "tool_use", usage: { input_tokens: 3, output_tokens: 70, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 } }, ...extra.top });
const user = (ts, content, extra = {}) => line({ type: "user", timestamp: ts, uuid: `u-${ts}`, message: { role: "user", content }, ...extra });

const transcript = [
  user("2026-11-10T10:00:00.000Z", `Please deploy with token ${SECRET} and fix everything`, { origin: { kind: "human" } }),
  asst("2026-11-10T10:00:05.000Z", "m1", [{ type: "text", text: `thinking about ${SECRET}` }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: `echo ${SECRET}` } }]),
  user("2026-11-10T10:00:15.000Z", [{ type: "tool_result", tool_use_id: "tu1", content: `${SECRET} output` }]),
  asst("2026-11-10T10:00:20.000Z", "m2", [{ type: "tool_use", id: "tu2", name: "AskUserQuestion", input: { questions: [SECRET] } }]),
  user("2026-11-10T10:02:20.000Z", [{ type: "tool_result", tool_use_id: "tu2", content: SECRET }]),
  asst("2026-11-10T10:02:30.000Z", "m3", [{ type: "tool_use", id: "tu3", name: "Bash", input: { command: "rm -rf x" } }]),
  user("2026-11-10T10:03:30.000Z", [{ type: "tool_result", tool_use_id: "tu3", content: "ok" }], { permissionDecision: { source: "user" } }),
  line({ type: "assistant", timestamp: "2026-11-10T10:04:00.000Z", uuid: "err1", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: { resetsAt: 1762772400, rateLimitType: "five_hour" }, message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: `API Error: ${SECRET}` }] } }),
  line({ type: "system", subtype: "turn_duration", timestamp: "2026-11-10T10:04:01.000Z", uuid: "td1", durationMs: 241000 }),
  line({ type: "system", subtype: "compact_boundary", timestamp: "2026-11-10T10:05:00.000Z", uuid: "cb1", content: SECRET, compactMetadata: { trigger: "auto" } }),
  user("2026-11-10T10:06:00.000Z", "<system-reminder>not a prompt</system-reminder>"),
].join("\n");

test("full mode: prompt length only, tool durations, owner and approval waits, rate limit with reset, no content anywhere", () => {
  const st = newTranscriptState();
  const evs = parseTranscript(transcript, { sessionId: sid, state: st }).concat(finishTranscript(st));
  const json = JSON.stringify(evs);
  assert.ok(!json.includes("MARKER"), "no prompt, tool input, output or error text leaks");
  assert.ok(!json.includes("rm -rf"));
  const kinds = evs.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "prompt.submit").length, 1, "system reminders are not prompts");
  const p = evs.find((e) => e.kind === "prompt.submit"); assert.equal(p.payload.promptLen, `Please deploy with token ${SECRET} and fix everything`.length); assert.equal(p.session.project, "myproj");
  const tools = evs.filter((e) => e.kind === "tool.result");
  assert.equal(tools[0].durationMs, 10000);
  assert.equal(tools[1].payload.ownerWaitMs, 120000); assert.equal(tools[1].durationMs, 0);
  assert.equal(tools[2].payload.approvalWaitMs, 60000); assert.equal(tools[2].payload.ownerApproved, true);
  const err = evs.find((e) => e.kind === "api.error");
  assert.equal(err.payload.error, "rate_limit"); assert.equal(err.payload.status, 429); assert.equal(err.payload.resetsAt, "2025-11-10T11:00:00.000Z"); assert.equal(err.payload.rateLimitType, "five_hour");
  assert.equal(evs.filter((e) => e.kind === "model.response").length, 3, "one per message id, synthetic error messages excluded");
  assert.equal(evs.find((e) => e.kind === "model.response").payload.cacheReadTokens, 900);
  assert.equal(evs.find((e) => e.kind === "turn.stop").durationMs, 241000);
  assert.equal(evs.find((e) => e.kind === "context.compact").payload.trigger, "auto");
});

test("supplement mode emits only what hooks lack (model responses, API errors, compaction)", () => {
  const evs = parseTranscript(transcript, { sessionId: sid, mode: "supplement" });
  assert.deepEqual([...new Set(evs.map((e) => e.kind))].sort(), ["api.error", "context.compact", "model.response"]);
});

test("tailing in chunks gives the same events as one parse (state carries tool_use timestamps and seen messages)", () => {
  const lines = transcript.split("\n");
  const whole = parseTranscript(transcript, { sessionId: sid, state: newTranscriptState() }).map((e) => e.id);
  const st = newTranscriptState();
  const a = parseTranscript(lines.slice(0, 4).join("\n"), { sessionId: sid, state: st, lineOffset: 0 });
  const b = parseTranscript(lines.slice(4).join("\n"), { sessionId: sid, state: st, lineOffset: 4 });
  assert.deepEqual([...a, ...b].map((e) => e.id), whole);
});

test("subagent files give agent.start/stop with the observed model and calls", () => {
  const sub = [
    line({ type: "user", timestamp: "2026-11-10T10:00:10.000Z", message: { role: "user", content: SECRET } }),
    asst("2026-11-10T10:00:12.000Z", "s1", [{ type: "tool_use", id: "a1", name: "Read", input: { file_path: SECRET } }]).replace("claude-opus-5-5", "claude-sonnet-5-5"),
    user("2026-11-10T10:00:20.000Z", [{ type: "tool_result", tool_use_id: "a1", content: SECRET }]),
  ].join("\n");
  const evs = parseSubagentTranscript(sub, { sessionId: sid, agentId: "agent1", meta: { agentType: "implementer", toolUseId: "tuX", finished: true } });
  assert.ok(!JSON.stringify(evs).includes("MARKER"));
  assert.equal(evs[0].kind, "agent.start"); assert.equal(evs[0].payload.model, "claude-sonnet-5-5"); assert.equal(evs[0].parent.toolUseId, "tuX");
  assert.equal(evs.at(-1).kind, "agent.stop"); assert.equal(evs.at(-1).payload.calls, 1);
  assert.equal(evs.find((e) => e.kind === "tool.result").actor.model, "claude-sonnet-5-5");
});

test("human prompt detection skips tool results, meta, sidechains and harness text", () => {
  assert.equal(isHumanPrompt({ type: "user", message: { content: "hello" } }), true);
  assert.equal(isHumanPrompt({ type: "user", isMeta: true, message: { content: "hello" } }), false);
  assert.equal(isHumanPrompt({ type: "user", isSidechain: true, message: { content: "hello" } }), false);
  assert.equal(isHumanPrompt({ type: "user", origin: { kind: "agent" }, message: { content: "hello" } }), false);
  assert.equal(isHumanPrompt({ type: "user", message: { content: "<task-notification>done</task-notification>" } }), false);
});
