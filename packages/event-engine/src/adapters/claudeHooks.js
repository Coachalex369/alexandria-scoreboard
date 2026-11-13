// Adapter: the collector hook log (~/.claude/eta/events.jsonl) → normalized events. Node only.
// Input lines look like {"ts","ev","sid","pid","proj","perm","tool","tuid","durMs","agent","agentType","subType","subModel","kind","stopHookActive","source","reason","promptLen","failed","hookMs"}.
// Everything the hook wrote is already free of prompt text and tool inputs; we keep names, ids, lengths, durations.
import fs from "node:fs";
import { makeEvent, classification } from "../schema.js";
import { stableId } from "../ids.js";
import { classifyToolEvent } from "../../../taxonomy/src/index.js";
import { testRunEvent } from "./testOutput.js";
// 3.2.2: records written by older collectors pass through the same allowlists as the collector, so a stored signature
// or MCP tool name never reaches an event unredacted.
import { sanitizeSignature, mcpTool, KNOWN_EXTS } from "../../../../collector/eta-hook.mjs";

const KIND = { SessionStart: "session.start", SessionEnd: "session.end", UserPromptSubmit: "prompt.submit", Stop: "turn.stop", PostToolUse: "tool.result", PostToolUseFailure: "tool.failure", SubagentStart: "agent.start", SubagentStop: "agent.stop", Notification: "notification", PreToolUse: "tool.call",
  // collector v3
  StopFailure: "api.error", PermissionRequest: "permission.request", PermissionDenied: "permission.denied", PreCompact: "context.compact", PostCompact: "context.compact", PostModelSwitch: "model.switch" };

// `lineOffset` lets a tail parse an appended chunk with the same stable ids a whole-file parse would give.
export function parseHookLog(text, { file = "events.jsonl", lineOffset = 0 } = {}) {
  const out = [];
  const agentModel = new Map(); // agentId -> { type, model } learned from Agent tool calls that carried subagent_type/model
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const i = idx + lineOffset;
    if (!line.trim()) return;
    let r; try { r = JSON.parse(line); } catch { return; }
    const kind = KIND[r.ev]; if (!kind) return;
    const isSub = !!r.agent;
    const actor = isSub ? { type: "subagent", agentId: r.agent, agentType: r.agentType || agentModel.get(r.agent)?.type, model: agentModel.get(r.agent)?.model, modelConfidence: agentModel.get(r.agent)?.model ? "declared" : "unknown" }
      : kind === "prompt.submit" ? { type: "human" } : { type: "main", modelConfidence: "unknown" };
    const parent = {};
    if (r.pid) parent.promptId = r.pid;
    if (r.tuid) parent.toolUseId = r.tuid;
    if (isSub) parent.agentId = r.agent;
    const payload = {};
    let cls = [];
    if (kind === "tool.result" || kind === "tool.failure") {
      payload.tool = mcpTool(r.tool); if (r.failed) payload.failed = true;
      if (r.subType) { payload.subagentType = r.subType; payload.subagentModel = r.subModel; }
      if (r.sig) payload.signature = sanitizeSignature(r.sig); // collector v2: redacted command signature (first token + plain subcommand), never the command
      if (Array.isArray(r.segs) && r.segs.length) payload.signatures = r.segs.filter((x) => typeof x === "string").slice(0, 8).map(sanitizeSignature); // collector v4: per-segment signatures
      cls = classifyToolEvent({ toolName: mcpTool(r.tool), signature: r.sig ? sanitizeSignature(r.sig) : null });
    }
    if (kind === "prompt.submit") payload.promptLen = r.promptLen ?? null;
    if (kind === "notification") payload.kind = r.kind;
    if (kind === "turn.stop") payload.stopHookActive = !!r.stopHookActive;
    if (kind === "session.start") { payload.sourceOfStart = r.source; if (r.model) payload.model = r.model; }
    if (kind === "tool.failure" && r.interrupted) payload.interrupted = true;
    if (kind === "api.error") { payload.error = r.error || "unknown"; if (r.status) payload.status = r.status; payload.endsTurn = true; }
    if (kind === "permission.request" || kind === "permission.denied" || kind === "tool.call") payload.tool = mcpTool(r.tool); // v5: tool.call = an owner question / plan approval opening; 3.2.2: MCP names allowlisted
    if (kind === "context.compact") { payload.phase = r.ev === "PreCompact" ? "begin" : "end"; if (r.trigger) payload.trigger = r.trigger; }
    if (kind === "model.switch") { payload.fromModel = r.fromModel || null; payload.toModel = r.toModel || null; }
    if (r.effort) payload.effort = r.effort;
    if (kind === "session.end") payload.reason = r.reason;
    if (kind === "agent.start") { payload.agentType = r.agentType; if (r.agentType) agentModel.set(r.agent, { type: r.agentType, model: agentModel.get(r.agent)?.model }); }
    if (typeof r.ext === "string" && /^\.[a-z0-9]{1,7}$/.test(r.ext)) payload.ext = KNOWN_EXTS.has(r.ext) ? r.ext : ".other"; // collector v5: edited file extension only; 3.3.2: same list as the collector
    if (r.perm) payload.permissionMode = r.perm;
    payload.hookMs = r.hookMs;
    const session = { id: r.sid || "unknown", project: r.proj || null };
    const parentOrUndef = Object.keys(parent).length ? parent : undefined;
    out.push(makeEvent({
      id: stableId("evt", file, i, r.ts, r.ev, r.sid, r.tuid || "", r.agent || ""),
      ts: r.ts, source: "claude-hooks", kind, session, actor, parent: parentOrUndef,
      payload, classification: cls, durationMs: r.durMs ?? undefined,
      provenance: { observed: true, adapter: `claude-hooks@${r.v || 1}`, confidence: 1, raw: { file, line: i + 1 } },
    }));
    // collector v4: a git commit recognised from git's success line (hash only) becomes an observed git.commit event.
    if (kind === "tool.result" && r.commit?.hash) {
      out.push(makeEvent({
        id: stableId("evt", "hook-commit", r.sid || "", r.tuid || "", r.commit.hash),
        ts: r.ts, source: "claude-hooks", kind: "git.commit", session, actor, parent: parentOrUndef,
        payload: { hash: r.commit.hash, via: "hook" }, classification: [],
        provenance: { observed: true, adapter: "claude-hooks@4", confidence: 1, raw: { file, line: i + 1 } },
      }));
    }
    // collector v2: a test run recognised in a tool's output (counts only) becomes an observed test.run event.
    if (r.tests && (kind === "tool.result" || kind === "tool.failure")) {
      const result = { framework: r.tests.framework || "unknown", passed: r.tests.passed ?? null, failed: r.tests.failed ?? null, skipped: r.tests.skipped ?? null, durationMs: r.tests.durationMs ?? null, exitCode: null, ok: r.tests.ok === true };
      out.push(testRunEvent({ ts: r.ts, session, actor, parent: parentOrUndef, result, label: (r.sig && sanitizeSignature(r.sig)) || mcpTool(r.tool), source: "tests" }));
    }
  });
  return out;
}

export function ingestHookLog(file) { return parseHookLog(fs.readFileSync(file, "utf8"), { file: file.split(/[\\/]/).pop() }); }

export { classification };
