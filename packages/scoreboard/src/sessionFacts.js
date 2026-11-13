// Session facts for the Scoreboard (Node only for the file helpers; the parser is pure).
//
// What this adds to the hook log, per session:
//   identity   where the session works and what it is called: the git root of its working directory (resolved by
//              walking up to the nearest .git, so worktrees and nested folders resolve correctly), the branch, and a
//              display label chosen from the best available evidence (see LABEL_ORDER)
//   attention  owner-attention requests as they OPEN, from the transcript: AskUserQuestion / ExitPlanMode tool calls
//              (closed by their tool result), and an INFERRED "the reply ends with a question" when a turn ends on an
//              assistant text whose last paragraph asks something (closed by the owner's next prompt)
//   process    whether the Claude Code process behind a session is still running (session registry + pid check)
//
// PRIVACY: transcripts hold prompts, code and output. They are read in memory only. What leaves this file: the repo
// folder NAME, a short hash of the repo path (to tell same-named repos apart), the branch name, the session label
// (Claude Code's own session title or the name the owner gave the session), tool names and tool-use ids, and a yes/no
// for "ends with a question". The label is shown in the local UI only and is never written to the ledger or any file.
//
// STABILITY: transcript lines and ~/.claude/sessions/<pid>.json are internal to Claude Code and may change without
// notice. Every field is read defensively; an unknown shape yields no fact, never a guess, and the label falls back
// down LABEL_ORDER to the next source that still works.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { makeEvent } from "../../event-engine/src/schema.js";
import { stableId } from "../../event-engine/src/ids.js";

export const OWNER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
// Highest first. Every source is optional; the board shows the first one present.
export const LABEL_ORDER = ["custom", "title", "repo", "registry", "folder", "id"];

// ---- git roots ----
const rootCache = new Map();
// The nearest ancestor holding .git (a directory, or a file for worktrees and submodules). null when none.
export function gitRootOf(dir, { exists = fs.existsSync } = {}) {
  if (typeof dir !== "string" || !dir) return null;
  if (rootCache.has(dir)) return rootCache.get(dir);
  let cur = path.resolve(dir), found = null;
  for (let i = 0; i < 64; i++) {
    if (exists(path.join(cur, ".git"))) { found = cur; break; }
    const up = path.dirname(cur); if (up === cur) break; cur = up;
  }
  if (exists === fs.existsSync && found) rootCache.set(dir, found); // a folder that is not a repo yet may become one (git init)
  return found;
}
// A repo key that is stable across sessions and tells apart two repos with the same folder name.
export function repoKey(root) { if (!root) return null; const norm = path.resolve(root).replace(/\\/g, "/").toLowerCase(); return `${path.basename(root)}#${crypto.createHash("sha1").update(norm).digest("hex").slice(0, 8)}`; }

// ---- transcript scanner ----
export function newFactsState() { return { cwd: null, branch: null, aiTitle: null, customTitle: null, open: new Map(), lastText: null, lastTextTs: null, askedAtStop: false, emitted: "" }; }

// The last paragraph of an assistant reply asks the owner something. Code blocks and quoted lines are ignored.
export function endsWithQuestion(text) {
  if (typeof text !== "string") return false;
  const t = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "`x`").trim();
  if (!t) return false;
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] || "";
  const lines = last.split("\n").filter((l) => l.trim() && !/^\s*>/.test(l));
  // only the closing line counts: a question mark inside a list or earlier in the paragraph does not
  return /\?\s*[*_)"'”’]*\s*$/.test((lines[lines.length - 1] || "").trim());
}

// Cheap prefilter (transcripts reach ~90 MB): parse a line only when it can carry a NEW fact.
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/, BRANCH_RE = /"gitBranch":"((?:[^"\\]|\\.)*)"/;
const unq = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
// Claude Code writes the envelope (type, cwd, gitBranch, subtype) before or after the message body (user and attachment
// lines put cwd after it), so the cheap checks look at the first and last 4 KB; tool output lines can be megabytes long.
export function mayCarryFact(line, state) {
  const head = line.length > 8192 ? line.slice(0, 4096) + line.slice(-4096) : line;
  if (state.identityPending) return true;
  if (head.includes('"ai-title"') || head.includes('"custom-title"') || head.includes('"aiTitle"') || head.includes('"customTitle"') || head.includes("turn_duration")) return true;
  const assistant = head.includes('"type":"assistant"');
  if (assistant && (line.includes('"end_turn"') || line.includes('"type":"text"') || line.includes('"tool_use"'))) return true; // a tool call clears a mid-turn text
  if (!assistant && head.includes('"type":"user"')) {
    if (state.lastText) return true;                                                         // the owner wrote, or a tool ran
    if (state.open.size && [...state.open.keys()].some((id) => line.includes(id))) return true; // an open question answered
  }
  const c = CWD_RE.exec(head); if (c && unq(c[1]) !== state.cwd) return true;
  const b = BRANCH_RE.exec(head); if (b) { const br = unq(b[1]); if ((br === "HEAD" ? null : br) !== state.branch) return true; }
  return false;
}

const isoOrNull = (v) => { if (typeof v !== "string") return null; const ms = Date.parse(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const cleanLabel = (v, max = 80) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "") || null;

// Parse a chunk of a main-session transcript; returns events. `resolveRoot(cwd)` maps a working directory to its git root.
export function scanTranscriptChunk(text, { sessionId, file = "transcript.jsonl", lineOffset = 0, state = newFactsState(), resolveRoot = (d) => gitRootOf(d) } = {}) {
  const out = [];
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line || line.length < 10) continue;
    if (!mayCarryFact(line, state)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const sid = o.sessionId || o.session_id || sessionId; if (!sid) continue;
    const ts = isoOrNull(o.timestamp) || state.lastTs || null;
    if (ts) state.lastTs = ts;
    const raw = { file, line: lineOffset + idx + 1 };
    const session = { id: sid, project: null };
    let identityChanged = false;
    if (typeof o.cwd === "string" && o.cwd && o.cwd !== state.cwd) { state.cwd = o.cwd; identityChanged = true; }
    const br = typeof o.gitBranch === "string" && o.gitBranch.length <= 120 && o.gitBranch !== "HEAD" ? o.gitBranch : null; // "HEAD" = detached or unknown
    if (typeof o.gitBranch === "string" && br !== state.branch) { state.branch = br; identityChanged = true; }
    if (o.type === "ai-title" && cleanLabel(o.aiTitle) && cleanLabel(o.aiTitle) !== state.aiTitle) { state.aiTitle = cleanLabel(o.aiTitle); identityChanged = true; }
    if ((o.type === "custom-title" || o.customTitle) && cleanLabel(o.customTitle) && cleanLabel(o.customTitle) !== state.customTitle) { state.customTitle = cleanLabel(o.customTitle); identityChanged = true; }
    if (identityChanged && !ts) state.identityPending = true; // emitted with the next timestamped line
    if ((identityChanged || state.identityPending) && ts) {
      state.identityPending = false;
      // A move into a folder outside any repository (notes, ~/.claude) keeps the last repository: edits use absolute paths,
      // so the working directory is only a proxy for where the work happens, and the last repo is the better guess.
      const root = (state.cwd ? resolveRoot(state.cwd) : null) || state.root || null;
      const payload = { change: "identity", folder: state.cwd ? path.basename(state.cwd) : null, repo: root ? path.basename(root) : null, repoKey: repoKey(root), branch: root ? state.branch : null, title: state.aiTitle, custom: state.customTitle };
      const sig = JSON.stringify(payload);
      if (sig !== state.emitted) { state.emitted = sig; out.push(makeEvent({ id: stableId("sf-id", sid, sig, ts), ts, source: "claude-transcript", kind: "state.change", session, actor: { type: "system" }, payload, provenance: { observed: true, adapter: "session-facts@1", confidence: 1, raw } })); }
      if (root) state.root = root;
    }
    if (!ts) continue;
    const content = o.message?.content;
    if (o.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_use" && b.id && OWNER_TOOLS.has(b.name) && !state.open.has(b.id)) {
          state.open.set(b.id, b.name);
          out.push(makeEvent({ id: stableId("sf-ask", sid, b.id), ts, source: "claude-transcript", kind: "tool.call", session, actor: { type: "main" }, parent: { toolUseId: b.id }, payload: { tool: b.name, attention: true }, provenance: { observed: true, adapter: "session-facts@1", confidence: 1, raw } }));
        }
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) { state.lastText = b.text.slice(-2000); state.lastTextTs = ts; }
        if (b?.type === "tool_use") { state.lastText = null; } // a tool call after the text: the text was not the closing reply
      }
      if (o.message?.stop_reason === "end_turn") state.pendingStop = ts;
      continue;
    }
    if (o.type === "user" && Array.isArray(content)) {
      for (const b of content) if (b?.type === "tool_result" && state.open.has(b.tool_use_id)) {
        const name = state.open.get(b.tool_use_id); state.open.delete(b.tool_use_id);
        out.push(makeEvent({ id: stableId("sf-ans", sid, b.tool_use_id), ts, source: "claude-transcript", kind: "state.change", session, actor: { type: "human" }, parent: { toolUseId: b.tool_use_id }, payload: { change: "attention", state: "closed", kind: name === "ExitPlanMode" ? "plan-approval" : "question" }, provenance: { observed: true, adapter: "session-facts@1", confidence: 1, raw } }));
      }
    }
    if (o.type === "user" && !o.isMeta && (typeof content === "string" || (Array.isArray(content) && content.some((b) => b?.type === "text") && !content.some((b) => b?.type === "tool_result")))) {
      state.lastText = null; state.pendingStop = null; // the owner wrote: any inferred question is answered (the board closes it on prompt.submit)
    }
    if ((o.type === "system" && o.subtype === "turn_duration") || false) {
      if (state.lastText && endsWithQuestion(state.lastText)) {
        out.push(makeEvent({ id: stableId("sf-q", sid, o.uuid || ts), ts, source: "claude-transcript", kind: "state.change", session, actor: { type: "main" }, payload: { change: "attention", state: "open", kind: "question-in-reply" }, provenance: { observed: false, adapter: "session-facts@1", confidence: 0.7, raw } }));
      }
      state.lastText = null; state.pendingStop = null;
    }
  }
  return out;
}

// ---- session registry (~/.claude/sessions/<pid>.json) ----
export const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
export function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return null; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM" ? true : false; } }
// Returns [{ sessionId, pid, alive, name, nameSource, status, cwd }] for every readable registry file; unknown shapes skipped.
export function readRegistry(dir = SESSIONS_DIR, { alive = pidAlive } = {}) {
  let names = []; try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    let o; try { o = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { continue; }
    if (!o || typeof o.sessionId !== "string" || !/^[0-9a-f-]{8,64}$/i.test(o.sessionId)) continue;
    const pid = Number.isInteger(o.pid) ? o.pid : Number(n.split(".")[0]);
    out.push({ sessionId: o.sessionId, pid, alive: alive(pid), name: cleanLabel(o.name, 60), nameSource: typeof o.nameSource === "string" ? o.nameSource.slice(0, 20) : null, status: typeof o.status === "string" ? o.status.slice(0, 20) : null, cwd: typeof o.cwd === "string" ? o.cwd : null });
  }
  return out;
}
// Registry entries → state.change events (only when something changed since the last call; `memo` carries that).
export function registryEvents(entries, { now = new Date().toISOString(), memo = new Map(), resolveRoot = (d) => gitRootOf(d) } = {}) {
  const out = [];
  for (const r of entries) {
    const custom = r.nameSource && !/^(derived|auto|default)$/i.test(r.nameSource) ? r.name : null;
    const root = r.cwd ? resolveRoot(r.cwd) : null;
    const payload = { change: "registry", name: r.name, custom, alive: r.alive, status: r.status, repo: root ? path.basename(root) : null, repoKey: repoKey(root), folder: r.cwd ? path.basename(r.cwd) : null };
    const sig = JSON.stringify(payload);
    if (memo.get(r.sessionId) === sig) continue; memo.set(r.sessionId, sig);
    out.push(makeEvent({ id: stableId("sf-reg", r.sessionId, sig, now), ts: now, source: "claude-transcript", kind: "state.change", session: { id: r.sessionId, project: null }, actor: { type: "system" }, payload, provenance: { observed: true, adapter: "session-registry@1", confidence: 0.9 } }));
  }
  return out;
}
