// Adapter: Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl and
// <session>/subagents/agent-<id>.jsonl + .meta.json) → normalized events. Node only for the file helpers; the
// parsers are pure.
//
// PRIVACY: transcripts hold prompts, code and tool output. This adapter reads them in memory and emits ONLY
// timestamps, ids, tool names, model ids, token counts, error types/status codes and prompt LENGTHS. Nothing else
// leaves this file (tests assert it with marker strings).
//
// STABILITY: the transcript format is internal to Claude Code and documented as subject to change. Every field is
// read defensively; unknown shapes are skipped, never guessed.
//
// Modes
//   "full"        everything needed to rebuild tasks from history (backfill): prompt.submit, turn.stop, tool.result
//                 with durations, waits on AskUserQuestion / user-approved permissions, model.response, api.error,
//                 context.compact, agent.start/stop from subagent files
//   "supplement"  only what the hook log lacks, for live sessions: model.response (model + tokens), api.error
//                 (rate limits with their reset time), context.compact
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeEvent } from "../schema.js";
import { stableId } from "../ids.js";
import { classifyToolEvent } from "../../../taxonomy/src/index.js";

const SKIP_PROMPT = /^<system-reminder>|^Base directory for this skill|^\[Request interrupted|^<local-command|^<command-name>|^<agent-message|^\[Subagent hand-back|^<task-notification>|^\[SYSTEM NOTIFICATION/;
const OWNER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function isHumanPrompt(o) {
  if (o.type !== "user" || o.isSidechain || o.isMeta) return false;
  if (o.origin && o.origin.kind && o.origin.kind !== "human") return false;
  const c = o.message?.content;
  let text = null;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) { if (c.some((b) => b?.type === "tool_result")) return false; const tb = c.find((b) => b?.type === "text"); if (!tb) return false; text = tb.text; }
  else return false;
  if (typeof text !== "string" || SKIP_PROMPT.test(text.trim())) return false;
  if (o.origin?.kind === "human" || o.promptSource === "typed" || o.turnOrigin === "human") return true;
  return o.origin === undefined && o.promptSource === undefined && o.turnOrigin === undefined;
}
function promptLength(o) { const c = o.message.content; return (typeof c === "string" ? c : (c.find((b) => b?.type === "text") || {}).text || "").length; }

// Parse a main-session transcript. `state` carries tool_use timestamps across tail chunks.
export function parseTranscript(text, { sessionId = null, project = null, file = "transcript.jsonl", lineOffset = 0, mode = "full", state = newTranscriptState() } = {}) {
  const out = [];
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]; if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = isoOrNull(o.timestamp); if (!ts) continue;
    const sid = o.sessionId || sessionId; if (!sid) continue;
    const session = { id: sid, project: project || (o.cwd ? path.basename(o.cwd) : null) };
    const raw = { file, line: lineOffset + idx + 1 };
    const prov = (extra = {}) => ({ observed: true, adapter: "claude-transcript@1", confidence: 1, raw, ...extra });
    if (o.isSidechain) continue; // legacy inline subagent records: subagents are read from their own files

    if (o.type === "assistant" && o.message) {
      const m = o.message;
      if (o.isApiErrorMessage) {
        const q = o.quotaLimits || {};
        const payload = { error: typeof o.error === "string" ? o.error : "unknown", endsTurn: true };
        if (Number.isFinite(o.apiErrorStatus)) payload.status = o.apiErrorStatus;
        if (Number.isFinite(q.resetsAt)) payload.resetsAt = new Date(q.resetsAt * (q.resetsAt < 1e12 ? 1000 : 1)).toISOString();
        if (typeof q.rateLimitType === "string") payload.rateLimitType = q.rateLimitType.slice(0, 32);
        out.push(makeEvent({ id: stableId("tx-err", sid, o.uuid || ts), ts, source: "claude-transcript", kind: "api.error", session, actor: { type: "system" }, payload, provenance: prov() }));
        continue;
      }
      if (typeof m.model === "string" && m.model !== "<synthetic>" && m.id && !state.seenMsg.has(m.id)) {
        state.seenMsg.add(m.id);
        state.model = m.model;
        const u = m.usage || {};
        out.push(makeEvent({ id: stableId("tx-msg", sid, m.id), ts, source: "claude-transcript", kind: "model.response", session, actor: { type: "main", model: m.model, modelConfidence: "observed" },
          payload: { model: m.model, inputTokens: n0(u.input_tokens), outputTokens: n0(u.output_tokens), cacheReadTokens: n0(u.cache_read_input_tokens), cacheWriteTokens: n0(u.cache_creation_input_tokens), stopReason: typeof m.stop_reason === "string" ? m.stop_reason : null },
          provenance: prov() }));
      }
      if (mode === "full") for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === "tool_use" && b.id) state.toolUse.set(b.id, { ts, name: b.name, subType: b.input?.subagent_type, subModel: b.input?.model });
      if (mode === "full" && m.stop_reason === "end_turn" && !state.turnDurationSeen) state.pendingEndTurn = { ts, sid, session, raw };
      continue;
    }
    if (o.type === "system" && o.subtype === "compact_boundary") {
      out.push(makeEvent({ id: stableId("tx-compact", sid, o.uuid || ts), ts, source: "claude-transcript", kind: "context.compact", session, actor: { type: "system" }, payload: { phase: "end", trigger: o.compactMetadata?.trigger === "manual" ? "manual" : o.compactMetadata?.trigger === "auto" ? "auto" : null }, provenance: prov() }));
      continue;
    }
    if (mode !== "full") continue;

    if (o.type === "system" && o.subtype === "turn_duration") {
      state.turnDurationSeen = true; state.pendingEndTurn = null;
      out.push(makeEvent({ id: stableId("tx-stop", sid, o.uuid || ts), ts, source: "claude-transcript", kind: "turn.stop", session, actor: { type: "main" }, payload: { turnDurationMs: n0(o.durationMs) }, durationMs: Number.isFinite(o.durationMs) ? o.durationMs : undefined, provenance: prov() }));
      continue;
    }
    if (o.type === "user") {
      if (isHumanPrompt(o)) {
        flushEndTurn(state, out);
        out.push(makeEvent({ id: stableId("tx-prompt", sid, o.uuid || ts), ts, source: "claude-transcript", kind: "prompt.submit", session, actor: { type: "human" }, payload: { promptLen: promptLength(o) }, provenance: prov() }));
        continue;
      }
      const c = o.message?.content;
      // The owner pressed Esc: the turn ended without a turn_duration record.
      const firstText = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => b?.type === "text")?.text : null;
      if (typeof firstText === "string" && firstText.startsWith("[Request interrupted")) {
        state.pendingEndTurn = null;
        out.push(makeEvent({ id: stableId("tx-interrupt", sid, o.uuid || ts), ts, source: "claude-transcript", kind: "turn.stop", session, actor: { type: "main" }, payload: { interrupted: true }, provenance: prov() }));
        continue;
      }
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const tu = state.toolUse.get(b.tool_use_id); if (!tu) continue;
        state.toolUse.delete(b.tool_use_id);
        const gap = Math.max(0, Date.parse(ts) - Date.parse(tu.ts));
        const ownerApproved = o.permissionDecision?.source === "user";
        const payload = { tool: tu.name || "unknown" };
        if (b.is_error === true) payload.failed = true;
        if (tu.name === "Agent" && tu.subType) { payload.subagentType = String(tu.subType).slice(0, 40); if (typeof tu.subModel === "string") payload.subagentModel = tu.subModel.slice(0, 40); }
        // Waiting the owner caused: the whole use→result gap of an owner tool, or of a call the owner approved by hand
        // (execution and approval cannot be separated in the transcript, so the conservative choice is "waiting").
        if (OWNER_TOOLS.has(tu.name)) payload.ownerWaitMs = gap;
        else if (ownerApproved) { payload.approvalWaitMs = gap; payload.ownerApproved = true; }
        out.push(makeEvent({ id: stableId("tx-tool", sid, b.tool_use_id), ts, source: "claude-transcript", kind: b.is_error === true ? "tool.failure" : "tool.result", session, actor: { type: "main" }, parent: { toolUseId: b.tool_use_id }, payload, classification: classifyToolEvent({ toolName: tu.name, signature: null }), durationMs: payload.ownerWaitMs != null || payload.approvalWaitMs != null ? 0 : gap, provenance: prov() }));
      }
    }
  }
  return out;
}

// Old transcripts have no turn_duration record: an assistant end_turn followed by the next human prompt marks the end.
function flushEndTurn(state, out) {
  const p = state.pendingEndTurn; if (!p) return; state.pendingEndTurn = null;
  out.push(makeEvent({ id: stableId("tx-endturn", p.sid, p.ts), ts: p.ts, source: "claude-transcript", kind: "turn.stop", session: p.session, actor: { type: "main" }, payload: { inferredFrom: "end_turn" }, provenance: { observed: false, adapter: "claude-transcript@1", confidence: 0.8, raw: p.raw } }));
}
export function finishTranscript(state) { const out = []; flushEndTurn(state, out); return out; }
export function newTranscriptState() { return { toolUse: new Map(), seenMsg: new Set(), model: null, turnDurationSeen: false, pendingEndTurn: null }; }

// A subagent file → agent.start / agent.stop (+ model.response, and tool.result in full mode) with the observed model.
export function parseSubagentTranscript(text, { sessionId, project = null, agentId, meta = {}, file = "agent.jsonl", mode = "full" } = {}) {
  const out = []; let first = null, last = null, model = null; const toolUse = new Map(); const seen = new Set(); let calls = 0;
  const actor = () => ({ type: "subagent", agentId, agentType: typeof meta.agentType === "string" ? meta.agentType : undefined, model: model || undefined, modelConfidence: model ? "observed" : "unknown" });
  const session = { id: sessionId, project };
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]; if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = isoOrNull(o.timestamp); if (!ts) continue;
    first = first || ts; last = ts;
    const raw = { file, line: idx + 1 };
    if (o.type === "assistant" && o.message) {
      const m = o.message;
      if (typeof m.model === "string" && m.model !== "<synthetic>") model = m.model;
      if (m.id && !seen.has(m.id) && model) {
        seen.add(m.id); const u = m.usage || {};
        out.push(makeEvent({ id: stableId("tx-amsg", sessionId, agentId, m.id), ts, source: "claude-transcript", kind: "model.response", session, actor: actor(), payload: { model, inputTokens: n0(u.input_tokens), outputTokens: n0(u.output_tokens), cacheReadTokens: n0(u.cache_read_input_tokens), cacheWriteTokens: n0(u.cache_creation_input_tokens), stopReason: typeof m.stop_reason === "string" ? m.stop_reason : null }, provenance: { observed: true, adapter: "claude-transcript@1", confidence: 1, raw } }));
      }
      for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === "tool_use" && b.id) toolUse.set(b.id, { ts, name: b.name });
    } else if (mode === "full" && o.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type !== "tool_result" || !toolUse.has(b.tool_use_id)) continue;
        const tu = toolUse.get(b.tool_use_id); toolUse.delete(b.tool_use_id); calls++;
        out.push(makeEvent({ id: stableId("tx-atool", sessionId, agentId, b.tool_use_id), ts, source: "claude-transcript", kind: b.is_error === true ? "tool.failure" : "tool.result", session, actor: actor(), parent: { toolUseId: b.tool_use_id, agentId }, payload: { tool: tu.name || "unknown", ...(b.is_error === true ? { failed: true } : {}) }, classification: classifyToolEvent({ toolName: tu.name, signature: null }), durationMs: Math.max(0, Date.parse(ts) - Date.parse(tu.ts)), provenance: { observed: true, adapter: "claude-transcript@1", confidence: 1, raw } }));
      }
    }
  }
  if (!first) return out;
  const parentToolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : undefined;
  const metaModel = typeof meta.pickedEffortModel === "string" ? meta.pickedEffortModel : null;
  if (!model && metaModel) model = metaModel;
  if (mode === "full") {
    out.unshift(makeEvent({ id: stableId("tx-astart", sessionId, agentId), ts: first, source: "claude-transcript", kind: "agent.start", session, actor: actor(), parent: parentToolUseId ? { toolUseId: parentToolUseId } : undefined, payload: { agentType: typeof meta.agentType === "string" ? meta.agentType : null, model: model || null }, provenance: { observed: true, adapter: "claude-transcript@1", confidence: 1, raw: { file, line: 1 } } }));
    if (meta.finished === true) out.push(makeEvent({ id: stableId("tx-astop", sessionId, agentId), ts: last, source: "claude-transcript", kind: "agent.stop", session, actor: actor(), payload: { calls }, provenance: { observed: true, adapter: "claude-transcript@1", confidence: 1, raw: { file, line: lines.length } } }));
  }
  return out;
}

// ---------- file helpers (Node) ----------
export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function findTranscript(sessionId, root = PROJECTS_DIR) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId || "")) return null;
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) { const f = path.join(root, d, `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}

export function listSubagents(transcriptFile) {
  const dir = path.join(path.dirname(transcriptFile), path.basename(transcriptFile, ".jsonl"), "subagents");
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => {
    const id = n.replace(/\.jsonl$/, ""); let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), "utf8")); } catch { /* no meta */ }
    return { agentId: id.replace(/^agent-/, ""), file: path.join(dir, n), meta };
  });
}

// Whole history (backfill): every main transcript plus its subagents, in full mode.
export function* readAllTranscripts(root = PROJECTS_DIR, { since = null } = {}) {
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    const pd = path.join(root, d); let files = [];
    try { if (!fs.statSync(pd).isDirectory()) continue; files = fs.readdirSync(pd).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const full = path.join(pd, f); const sid = f.replace(/\.jsonl$/, "");
      try { if (since && fs.statSync(full).mtimeMs < Date.parse(since)) continue; } catch { continue; }
      let text; try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      const state = newTranscriptState();
      const events = parseTranscript(text, { sessionId: sid, file: f, state, mode: "full" }).concat(finishTranscript(state));
      const project = events.find((e) => e.session.project)?.session.project || null;
      for (const sub of listSubagents(full)) {
        try { events.push(...parseSubagentTranscript(fs.readFileSync(sub.file, "utf8"), { sessionId: sid, project, agentId: sub.agentId, meta: sub.meta, file: path.basename(sub.file) })); } catch { /* unreadable subagent file */ }
      }
      for (const e of events) if (!e.session.project && project) e.session.project = project;
      yield { sessionId: sid, projectDir: d, events: events.sort((a, b) => a.ts.localeCompare(b.ts)) };
    }
  }
}

function isoOrNull(v) { if (typeof v !== "string") return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
const n0 = (v) => (Number.isFinite(v) ? v : 0);
