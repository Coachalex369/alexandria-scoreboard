// Scoreboard board model. Browser-safe, UI-independent, pure: events in (alexandria.event/1 records from any
// adapter), a snapshot out. Every field in the snapshot carries a `basis`:
//   observed    taken directly from events whose provenance.observed is true
//   inferred    derived by a rule (turn completion, agent end from its tool result, question at the end of a reply)
//   predicted   from history (game clock, shot clock)
//   unavailable the information does not exist in the stream; the UI shows question marks / dark digits, never a guess
//
// Game structure (design decision 2026-11-12): the GAME is a Claude Code session; a PERIOD is one turn (the owner's
// prompt → Claude stops). Long follow-up prompts no longer start anything new: every owner prompt is the next period.
// Explicit task marks (sb-mark) still define tasks that span turns.
//
// Scoreboard mapping (see docs/SCORING.md):
//   WINS        shared team score of the session (main + subagents), by tier (scoring.js)          observed/inferred
//   GAME CLOCK  estimated time LEFT in the current period, never time spent (design decision 2026-11-13): counts
//               down in active time from the best available estimate (low confidence = labelled estimate + range),
//               stops during waits, adjusts only visibly on new evidence, at 0:00 OVERTIME lights and it resets and counts down; unknown when
//               there is no estimate                                                                 predicted
//   TIMER       (formerly SHOT CLOCK; design decision 2026-11-13) counts UP from 0:00 only while Claude is blocked on
//               the owner: approval, question / plan approval / input, or the owner's move inside an open task.
//               Same signal as the GAME CLOCK's stop-for-the-owner (userWaitOf), so one runs exactly when the
//               other is stopped for the owner. Dark otherwise.                                       observed/inferred
//   (agent ETA) remaining time of the subagent expected to deliver next: kept as data (snapshot.shot), not on the board
//   FOULS       unresolved meaningful problems in the session's repository (resolved ones kept apart) observed/inferred
//   VERIFIED    currently valid passing checks in the session's repository                          observed
//   TIMEOUTS    outstanding owner-attention requests (approvals, questions, plan approvals, inputs)  observed/inferred
//   AGENTS      running subagents; the main thread is shown separately                             observed/inferred
//   PERIOD      turn number in the session                                                         observed
//   STOPWATCH   active / waiting:<kind> / paused / unknown partition of the period's wall time    observed+inferred
import { PredictionLog } from "./eta.js";
import { Stopwatch } from "../../stopwatch/src/stopwatch.js";
import { estimate, ESTIMATOR_VERSION } from "../../stopwatch/src/estimator.js";
import { Scoring, EDIT_TOOLS, DOC_EXTS, sigKinds, winSummary } from "./scoring.js";

export const PHASES = ["PLAN", "RESEARCH", "BUILD", "TEST", "REVIEW", "COMMIT", "WAIT", "IDLE", "DONE"];
const OP_PHASE = { read: "RESEARCH", search: "RESEARCH", browse: "RESEARCH", plan: "PLAN", delegate: "PLAN", edit: "BUILD", create: "BUILD", run: "BUILD", test: "TEST", build: "BUILD", commit: "COMMIT", publish: "COMMIT", ask: "WAIT", schedule: "PLAN", review: "REVIEW", other: null };
const REVIEW_AGENTS = new Set(["reviewer", "code-review", "security-review"]);
const QUIET_END_REASONS = new Set(["clear", "logout", "prompt_input_exit", "other"]);
const OWNER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const ELICIT_OPEN = new Set(["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);
const ELICIT_CLOSE = new Set(["elicitation_complete", "elicitation_response"]);

// Complexity known at the start of a period: the length of the prompt (never anything outcome-derived).
// A marked task ended without completing: explicit ok:false, or an outcome word meaning failure (trimmed, any case,
// US and UK spellings). Used by the horn, the win and the ticker alike.
export const FAILED_OUTCOME = /^(fail|failed|failure|error|errored|abandon|abandoned|cancel|canceled|cancelled|abort|aborted|incomplete|not[ -]?complete|not[ -]?done|unfinished|blocked|skipped)$/i;
export function isFailedOutcome(p) { return p?.ok === false || FAILED_OUTCOME.test(String(p?.outcome ?? "").trim()); }
export function sizeBucket(promptLen) { if (promptLen == null) return null; return promptLen < 300 ? "xs" : promptLen < 1000 ? "s" : promptLen < 3000 ? "m" : "l"; }

// Clock rules. GAME CLOCK (design decision 2026-11-13, supersedes "countdown only when well supported"): any usable
// estimate starts a countdown; below countdownConfidence it is labelled an estimate and carries a p10–p90 range.
// The target is re-set only when the estimate's evidence changes (gameEvidence), never merely because time passed
// (the estimator's remaining time is conditional on elapsed time, so re-estimating every tick would stop the clock
// from running down); a re-set of at least adjustMinMs is recorded and shown for adjustShowMs. Agent estimates
// (SHOT CLOCK) need their own type's history.
export const ATTENTION_STALE_MS = 12 * 3600e3;
export const CLOCK_RULES = { countdownConfidence: ["high", "medium"], adjustMinMs: 15e3, adjustShowMs: 30e3, overtimeMinStepMs: 30e3, agentMinN: 6, agentCountdownN: 12, agentCountdownSpread: 3, agentMinTail: 3 };
// Waits that block Claude on the OWNER. Claude-side stops (rate limit, API error, external, declared pause, stall)
// are deliberately absent: they stop the GAME CLOCK but never run the TIMER.
export const USER_WAIT_KINDS = new Set(["approval", "question", "owner"]);
// The ONE signal shared by the GAME CLOCK (stopped.forUser) and the TIMER (running): never compute either separately.
export function userWaitSince(timeline, fallback) {
  let since = fallback;
  for (let i = timeline.length - 1; i >= 0; i--) { const g = timeline[i]; if (g.state === "waiting" && USER_WAIT_KINDS.has(g.kind)) since = g.from; else break; }
  return since;
}
export function userWaitOf(sw, live) { return live && sw && sw.state === "waiting" && USER_WAIT_KINDS.has(sw.kind) ? { kind: sw.kind, since: sw.since, basis: sw.basis } : null; }
// What the game-clock estimate is based on. Elapsed time is deliberately NOT part of it.
export function gameEvidence(v2, declared) {
  return [v2.method, v2.stratum ? [].concat(v2.stratum).join("+") : "", v2.n, declared?.p50Min ?? declared?.minutes ?? "", declared?.p90Min ?? "", declared?.calls ?? "", v2.pace ? "pace" : ""].join("|");
}

export class Board {
  constructor({ briefLength = 300, gapMs = 2 * 3600e3, idleMs = 90e3, staleSessionMs = 30 * 60e3, agentActiveMs = 45e3, agentLostMs = 20 * 60e3, focusHoldMs = 60e3, maxLog = 80, history = [], taskHistory = [], agentHistory = [], stallMs = 10 * 60e3, onTaskComplete = null, recordHistory = true } = {}) {
    this.opts = { briefLength, gapMs, idleMs, staleSessionMs, agentActiveMs, agentLostMs, focusHoldMs, maxLog, stallMs };
    this.sessions = new Map();
    this.predictions = new PredictionLog(history);
    this.taskHistory = [...taskHistory]; // completed period/task records (ledger + backfill): the calibration store
    this.historyIds = new Set(this.taskHistory.map((r) => r.id));
    this.agentHistory = [...agentHistory]; // completed subagents { type, model, durationMs, endedAt }: shot-clock history
    this.agentHistoryIds = new Set(this.agentHistory.map((r) => r.id));
    this.onTaskComplete = onTaskComplete;
    this.recordHistory = recordHistory; // false in the page: the server's ledger is the one source of history
    this.calibration = null;
    this.scoring = new Scoring();
    this.alerts = [];
    this.seen = new Set();
    this.count = 0;
    this.autoFocus = null;
  }

  session(id, project) {
    if (!this.sessions.has(id)) this.sessions.set(id, {
      id, project: project || null, start: null, end: null, endReason: null, lastEventTs: null, lastMainTs: null,
      tasks: [], current: null, agents: new Map(), openTools: new Map(), stops: 0, prompts: 0, periods: 0, lastStop: null, explicitMarks: false,
      log: [], synthetic: false, recentOps: [], model: null, modelBasis: "unavailable", rateLimit: null,
      identity: {}, attention: new Map(), idle: null, wins: [], processGone: null,
    });
    const s = this.sessions.get(id); if (project) s.project = project; return s; // latest working directory wins
  }
  scopeKey(s) { return s.identity.repoKey || s.identity.regRepoKey || `session:${s.id}`; }

  newTask(s, { id, title, start, basis, promptLen = null, kind = "turn", resumed = false }) {
    if (s.current && !s.current.end) this.finishTask(s, s.current, s.lastStop && s.lastStop > s.current.start ? s.lastStop : start, "superseded");
    const t = { id, title: title || null, start, end: null, basis, kind, resumed, period: s.periods, toolCalls: 0, mainCalls: 0, failures: 0, testsFailed: 0, testsPassed: 0, commits: 0, edits: 0, codeEdits: 0, waits: 0, waitingMs: 0, waitSince: null, turns: 0, lastStop: null, estimate: null, agents: [], completedAgents: 0, lastTestOk: null, promptLen,
      sw: new Stopwatch({ stallMs: this.opts.stallMs }), models: {}, type: null, size: sizeBucket(promptLen), modelAtStart: s.model, session: s.id, project: s.project, predictionAtStart: null, predictionAtEstimate: null, endReason: null, target: null };
    t.sw.push({ ts: start, type: "start", basis: basis === "observed" ? "declared" : "inferred" });
    s.tasks.push(t); s.current = t; return t;
  }

  finishTask(s, t, endTs, reason) {
    if (t.end) return null;
    t.end = endTs; t.endReason = reason; t.sw.push({ ts: endTs, type: "end" });
    if (s.current === t) s.current = null;
    const rec = taskRecord(t, Date.parse(endTs));
    if (!this.historyIds.has(rec.id)) { this.historyIds.add(rec.id); if (this.recordHistory) this.taskHistory.push(rec); if (this.onTaskComplete) this.onTaskComplete(rec); }
    return rec;
  }

  setHistory(records) { this.taskHistory = [...records]; this.historyIds = new Set(this.taskHistory.map((r) => r.id)); for (const s of this.sessions.values()) for (const t of s.tasks) if (t.end) this.historyIds.add(`${s.id}:${t.id}`); }
  setAgentHistory(records) { this.agentHistory = [...records]; this.agentHistoryIds = new Set(this.agentHistory.map((r) => r.id)); }
  features(t) { return { type: t.type || null, model: t.modelAtStart || null, regime: regimeOf(t), size: t.size }; }

  // History usable for a period: completed before it started (no leakage) and of the same regime family, so periods
  // are never calibrated against the old multi-turn "brief" records.
  historyFor(t) { const start = t.start, reg = regimeOf(t); return this.taskHistory.filter((h) => h.id !== t.id && h.calibratable !== false && h.endedAt && h.endedAt < start && (h.features?.regime || "brief") === reg); }

  predict(t, nowMs) {
    const totals = t.sw.totals(nowMs);
    return estimate({ features: this.features(t), declared: t.estimate, progress: { activeMs: totals.activeMs, calls: t.toolCalls }, history: this.historyFor(t), calibration: this.calibration });
  }

  // Marked tasks and open periods of quiet sessions end once the session has been silent for gapMs.
  finalizeStale(nowMs) {
    const out = [];
    for (const s of this.sessions.values()) {
      const t = s.current; if (!t || t.end || t.basis === "observed") continue;
      if (s.lastEventTs && nowMs - Date.parse(s.lastEventTs) > this.opts.gapMs) out.push(this.finishTask(s, t, s.lastStop && s.lastStop > t.start ? s.lastStop : s.lastEventTs, "session-quiet"));
    }
    return out.filter(Boolean);
  }

  sig(t, sig) { if (t && !t.end) t.sw.push(sig); }

  // Activity after a stop without a new prompt (background agent results, auto-resume) continues as a resumed period.
  ensureTurn(s, e, ms) {
    const t = s.current && !s.current.end ? s.current : null;
    if (t || s.explicitMarks) return t;
    if (s.lastStop && ms <= Date.parse(s.lastStop) + 1000) return null; // late facts of the period that just ended
    if (!s.periods) s.periods = 1;
    const nt = this.newTask(s, { id: `turn_${e.id}`, start: e.ts, basis: "inferred", resumed: true });
    nt.predictionAtStart = this.predict(nt, ms); return nt;
  }

  apply(e) {
    if (this.seen.has(e.id)) return null; this.seen.add(e.id); this.count++;
    const s = this.session(e.session.id, e.session.project);
    if (e.provenance?.synthetic || e.source === "synthetic") s.synthetic = true;
    if (e.kind !== "state.change" || e.payload?.change !== "registry") s.lastEventTs = !s.lastEventTs || e.ts > s.lastEventTs ? e.ts : s.lastEventTs;
    if (e.actor?.type === "main" || e.actor?.type === "human") s.lastMainTs = e.ts;
    const ms = Date.parse(e.ts);
    let t = s.current && !s.current.end ? s.current : null;
    const op = e.classification?.find((c) => c.scheme === "operation")?.value || null;
    const sub = e.actor?.type === "subagent";

    switch (e.kind) {
      case "session.start": s.start = s.start || e.ts; if (e.payload?.model) this.setModel(s, e.payload.model, "observed", e.ts); break;
      case "session.end": {
        s.end = e.ts; s.endReason = e.payload?.reason || null;
        this.sig(t, { ts: e.ts, type: "turn.close", basis: "observed" });
        const reason = e.payload?.reason || "unknown";
        if (t) this.raise(e, "termination", `session ended (${reason}) with a period open`, s, QUIET_END_REASONS.has(reason));
        this.closeAttention(s, () => true, e.ts, "session ended");
        if (t && t.basis !== "observed") this.finishTask(s, t, e.ts, "session-end");
        this.record(s, e, `session end · ${reason}`);
        break;
      }
      case "state.change": this.applyStateChange(s, e, t); break;
      case "task.start": {
        s.explicitMarks = true;
        const id = e.task?.id || e.id;
        // A period opened by the prompt a moment before the mark is the same work: adopt it.
        if (t && t.basis === "inferred" && t.toolCalls === 0 && ms - Date.parse(t.start) < 120e3) { t.id = id; t.title = e.task?.title || t.title; t.basis = "observed"; t.kind = "marked"; for (const a of s.agents.values()) if (a.taskId && !s.tasks.some((x) => x.id === a.taskId)) a.taskId = id; }
        else this.newTask(s, { id, title: e.task?.title, start: e.ts, basis: "observed", kind: "marked" });
        const cur = s.current;
        if (cur && e.payload?.type) cur.type = String(e.payload.type).slice(0, 32);
        if (cur && e.payload?.model) { cur.modelAtStart = String(e.payload.model).slice(0, 48); }
        if (cur) cur.predictionAtStart = this.predict(cur, ms);
        this.record(s, e, `task start · ${e.task?.title || id}`);
        break;
      }
      case "task.estimate": {
        const tt = s.tasks.find((x) => x.id === e.task?.id) || t;
        if (tt) {
          tt.estimate = { ...e.payload, at: e.ts, basis: "declared" }; this.predictions.onEstimate(e, tt);
          if (e.payload?.type && !tt.type) tt.type = String(e.payload.type).slice(0, 32);
          if (!tt.end) tt.predictionAtEstimate = this.predict(tt, ms);
          this.record(s, e, `estimate · ${fmtEstimate(e.payload)}`);
        }
        break;
      }
      case "task.end": {
        const tt = s.tasks.find((x) => x.id === e.task?.id) || t;
        if (tt && !tt.end) {
          const workMs = tt.sw.totals(ms).activeMs;
          const failed = isFailedOutcome(e.payload);
          tt.outcome = failed ? "failed" : "complete";
          this.finishTask(s, tt, e.ts, "marked");
          this.predictions.onTaskEnd(e, tt, workMs);
          if (!failed) this.scoreWin(s, { key: `task:${s.id}:${tt.id}`, kind: "task", ts: e.ts, explicit: true, observedDeliverable: true, label: tt.title || tt.id, basis: "observed" });
          if (failed) this.raise(e, "task-ended", `task ended · not complete · ${tt.title || tt.id}`, s); // no horn (design decision 2026-11-13)
          else this.raise(e, "completed", `task complete · ${tt.title || tt.id}`, s);
          this.record(s, e, `task ${failed ? "ended (not complete)" : "complete"} · ${tt.title || tt.id}`);
        }
        break;
      }
      case "task.pause": case "task.resume": {
        const tt = s.tasks.find((x) => x.id === e.task?.id) || t;
        this.sig(tt, { ts: e.ts, type: e.kind === "task.pause" ? "pause" : "resume", basis: "declared" });
        this.record(s, e, `${e.kind === "task.pause" ? "paused" : "resumed"}${e.payload?.reason ? " · " + String(e.payload.reason).slice(0, 40) : ""}`);
        break;
      }
      case "wait.begin": case "wait.end": {
        const tt = s.tasks.find((x) => x.id === e.task?.id) || t;
        this.sig(tt, { ts: e.ts, type: e.kind, kind: e.payload?.kind || "external", key: e.payload?.key || null, basis: "declared" });
        this.record(s, e, `${e.kind === "wait.begin" ? "wait" : "wait over"} · ${e.payload?.kind || "external"}`);
        break;
      }
      case "prompt.submit": {
        s.prompts++; s.periods++; s.rateLimit = null; s.idle = null; s.lastPromptTs = e.ts;
        this.closeAttention(s, () => true, e.ts, "owner replied");
        if (!s.explicitMarks) { const nt = this.newTask(s, { id: `turn_${e.id}`, start: e.ts, basis: "inferred", promptLen: e.payload?.promptLen ?? null }); nt.predictionAtStart = this.predict(nt, ms); }
        const cur = s.current && !s.current.end ? s.current : null;
        if (cur) { cur.turns++; cur.promptLen = e.payload?.promptLen ?? cur.promptLen; this.sig(cur, { ts: e.ts, type: "wait.end", basis: "observed" }); this.sig(cur, { ts: e.ts, type: "turn.open", basis: "observed" }); }
        this.record(s, e, `period ${s.periods} · prompt${e.payload?.promptLen != null ? " · " + e.payload.promptLen + " chars" : ""}`);
        break;
      }
      case "turn.stop":
        if (sub) break; // a subagent's stop is not the main turn ending
        s.stops++; s.lastStop = e.ts;
        this.closeAttention(s, (a) => a.key === "approval", e.ts, "turn ended");
        if (t) {
          t.lastStop = e.ts; this.sig(t, { ts: e.ts, type: "turn.close", basis: e.provenance?.observed === false ? "inferred" : "observed" });
          if (t.edits > 0 || t.commits > 0) this.scoreWin(s, { key: `turn:${s.id}:${t.id}`, kind: "turn", ts: e.ts, observedDeliverable: false, label: `period ${t.period || s.periods} · ${t.edits} file change${t.edits === 1 ? "" : "s"}${t.commits ? ` · ${t.commits} commit${t.commits === 1 ? "" : "s"}` : ""}`, basis: "inferred" });
          if (t.basis !== "observed") this.finishTask(s, t, e.ts, "turn-end");
          this.raise(e, "turn", "turn complete · back to the owner", s, true);
        }
        break;
      case "api.error": {
        const rl = e.payload?.error === "rate_limit";
        this.sig(t, { ts: e.ts, type: "wait.begin", kind: rl ? "rate_limit" : "api_error", basis: "observed" });
        if (e.payload?.endsTurn !== false) this.sig(t, { ts: e.ts, type: "turn.close", basis: "observed" });
        if (rl) s.rateLimit = { since: e.ts, resetsAt: e.payload?.resetsAt || s.rateLimit?.resetsAt || null, type: e.payload?.rateLimitType || null };
        this.raise(e, rl ? "rate-limit" : "api-error", rl ? `rate limited${e.payload?.resetsAt ? " · resets " + e.payload.resetsAt.slice(11, 16) + " UTC" : ""}` : `turn stopped · API error ${e.payload?.error || ""}`, s);
        this.record(s, e, `api error · ${e.payload?.error || "?"}${e.payload?.status ? " " + e.payload.status : ""}`);
        break;
      }
      case "permission.request": {
        // Claude Code also raises a permission request when it shows the owner a question or a plan: that is a question.
        const q = OWNER_TOOLS.has(e.payload?.tool);
        // One question is one request: if its tool call was already seen, the permission path adds nothing.
        if (q && [...s.attention.keys()].some((k) => k.startsWith("ask:"))) { this.sig(t, { ts: e.ts, type: "wait.begin", kind: "question", basis: "observed" }); break; }
        this.openAttention(s, e, { key: "approval", agentId: sub ? e.actor?.agentId || null : null, kind: q ? (e.payload.tool === "ExitPlanMode" ? "plan-approval" : "question") : "approval", basis: "observed", label: q ? (e.payload.tool === "ExitPlanMode" ? "plan approval" : "question for the owner") : `approval · ${e.payload?.tool || "tool"}` });
        this.sig(t, { ts: e.ts, type: "wait.begin", kind: q ? "question" : "approval", basis: "observed" });
        break;
      }
      case "permission.denied": this.closeAttention(s, (a) => a.key === "approval", e.ts, "denied"); this.sig(t, { ts: e.ts, type: "wait.end", kind: "approval", basis: "observed" }); this.record(s, e, `permission denied · ${e.payload?.tool || "?"}`); break;
      case "model.response": {
        if (sub) { const a = s.agents.get(e.actor.agentId); if (a && e.payload?.model) { a.model = e.payload.model; a.modelBasis = "observed"; } }
        else if (e.payload?.model) this.setModel(s, e.payload.model, "observed", e.ts);
        if (t && e.payload?.model) { const m = (t.models[e.payload.model] ||= { responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }); m.responses++; for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) m[k] += e.payload[k] || 0; }
        this.sig(t, { ts: e.ts, type: "activity", basis: "observed" });
        break;
      }
      case "model.switch": if (e.payload?.toModel) this.setModel(s, e.payload.toModel, "observed", e.ts); this.record(s, e, `model → ${e.payload?.toModel || "?"}`); break;
      case "context.compact": this.sig(t, { ts: e.ts, type: "activity", basis: "observed" }); if (e.payload?.phase !== "begin") this.record(s, e, `context compacted${e.payload?.trigger ? " · " + e.payload.trigger : ""}`); break;
      case "tool.call": {
        s.openTools.set(e.parent?.toolUseId || e.id, e);
        const tool = e.payload?.tool;
        // The same question may already be open through the permission path: replace it by the precise tool-call entry.
        if (OWNER_TOOLS.has(tool) && !sub) { const pending = s.attention.get("approval"); if (pending && (pending.kind === "question" || pending.kind === "plan-approval")) s.attention.delete("approval"); }
        if (OWNER_TOOLS.has(tool) && !sub) this.openAttention(s, e, { key: `ask:${e.parent?.toolUseId || e.id}`, kind: tool === "ExitPlanMode" ? "plan-approval" : "question", basis: "observed", label: tool === "ExitPlanMode" ? "plan approval" : "question for the owner" });
        // The clock stops while the dialog is open, not only afterwards from the result's run time (design decision
        // 2026-11-13: the game clock pauses during approvals and never jumps silently). The result closes this key.
        if (OWNER_TOOLS.has(tool) && !sub) this.sig(t, { ts: e.ts, type: "wait.begin", kind: "question", key: e.parent?.toolUseId || e.id, basis: "observed" });
        break;
      }
      case "tool.result": case "tool.failure": this.applyToolResult(s, e, op, sub, ms); break;
      case "agent.start": {
        t = sub || !t ? this.ensureTurn(s, e, ms) || t : t;
        const a = { id: e.actor.agentId, type: e.actor.agentType || e.payload?.agentType || null, model: e.actor.model || null, modelBasis: e.actor.model ? (e.actor.modelConfidence || "declared") : "unknown", start: e.ts, end: null, endBasis: null, parentToolUseId: e.parent?.toolUseId || null, parentAgentId: e.parent?.parentAgentId || null, toolCalls: 0, edits: 0, lastSeen: e.ts, lastTool: null, label: e.payload?.label || null, taskId: t?.id || null, target: null };
        s.agents.set(a.id, a); if (t) t.agents.push(a.id);
        this.sig(t, { ts: e.ts, type: "span.begin", key: a.id, basis: "observed" });
        if (REVIEW_AGENTS.has(a.type)) this.pushOp(s, "review");
        this.record(s, e, `agent start · ${a.type || "agent"}${a.model ? " · " + a.model : ""}`);
        break;
      }
      case "agent.stop": {
        const a = s.agents.get(e.actor.agentId);
        if (a && !a.end) { this.endAgent(s, a, e.ts, "observed"); this.agentDelivered(s, a, e.ts, "observed"); }
        this.record(s, e, `agent done · ${a?.type || short(e.actor.agentId)}`);
        break;
      }
      case "notification": {
        const k = e.payload?.kind;
        if (k === "permission_prompt" && [...s.attention.values()].some((a) => a.kind === "question" || a.kind === "plan-approval")) { this.sig(t, { ts: e.ts, type: "wait.begin", kind: "question", basis: "observed" }); } // the dialog of an open question
        else if (k === "permission_prompt") { this.openAttention(s, e, { key: "approval", kind: "approval", basis: "observed", label: "permission required" }); this.sig(t, { ts: e.ts, type: "wait.begin", kind: "approval", basis: "observed" }); this.raise(e, "permission", "permission required", s); }
        else if (k === "idle_prompt" || k === "idle") { s.idle = s.idle || e.ts; this.sig(t, { ts: e.ts, type: "turn.close", basis: "inferred" }); }
        else if (ELICIT_OPEN.has(k)) { this.openAttention(s, e, { key: `elicit:${k}`, kind: "input", basis: "observed", label: k.replace(/_/g, " ") }); this.sig(t, { ts: e.ts, type: "wait.begin", kind: "question", key: k, basis: "observed" }); this.record(s, e, `notification · ${k}`); }
        else if (ELICIT_CLOSE.has(k)) { this.closeAttention(s, (a) => a.key.startsWith("elicit:"), e.ts, k); this.sig(t, { ts: e.ts, type: "wait.end", kind: "question", basis: "observed" }); this.record(s, e, `notification · ${k}`); }
        else if (k === "quota_auto_resume_fired") { this.sig(t, { ts: e.ts, type: "wait.end", kind: "rate_limit", basis: "observed" }); this.sig(t, { ts: e.ts, type: "turn.open", basis: "observed" }); s.rateLimit = null; this.record(s, e, "rate limit over · auto-resumed"); }
        else if (k) this.record(s, e, `notification · ${k}`);
        break;
      }
      case "test.run": {
        const ok = e.payload?.ok === true;
        if (t) { if (ok) t.testsPassed++; else t.testsFailed++; t.lastTestOk = ok; }
        if (e.source !== "claude-hooks") this.sig(t, { ts: ms, sinceTs: e.payload?.durationMs ? ms - e.payload.durationMs : ms, type: "activity", basis: "observed" });
        this.pushOp(s, "test");
        const label = String(e.payload?.label || e.payload?.framework || "tests").slice(0, 40);
        this.scoring.checkRun(this.scopeKey(s), { key: label, label, kind: "test", ok, ts: e.ts, session: s.id, agentId: e.actor?.agentId || null, counts: { passed: e.payload?.passed ?? null, failed: e.payload?.failed ?? null } });
        const total = (e.payload?.passed ?? 0) + (e.payload?.failed ?? 0);
        if (!ok) this.raise(e, "test-failure", `tests failed · ${e.payload?.failed ?? "?"} of ${total}`, s);
        this.record(s, e, `tests ${ok ? "pass" : "FAIL"} · ${e.payload?.passed ?? "?"} passed · ${e.payload?.failed ?? "?"} failed`);
        break;
      }
      case "git.commit": {
        if (this.scoring.seenCommit(e.payload?.hash)) break; // one commit scores once, in whichever session saw it first
        t = this.ensureTurn(s, e, ms) || t;
        if (t) t.commits++;
        this.pushOp(s, "commit"); this.sig(t, { ts: e.ts, type: "activity", basis: "observed" });
        const hash = String(e.payload?.hash || "").slice(0, 12);
        this.scoreWin(s, { key: `commit:${hash || e.id}`, kind: "commit", ts: e.ts, observedDeliverable: true, label: `commit ${hash}`, basis: e.payload?.attribution === "inferred" ? "inferred" : "observed", agentId: e.actor?.agentId || null });
        this.record(s, e, `commit · ${hash} · ${e.payload?.files ?? "?"} files`);
        break;
      }
      default: break;
    }
    return s;
  }

  applyToolResult(s, e, op, sub, ms) {
    s.openTools.delete(e.parent?.toolUseId);
    const tool = e.payload?.tool;
    const failed = e.kind === "tool.failure" || e.payload?.failed === true;
    const interrupted = e.payload?.interrupted === true;
    const t = (!sub ? this.ensureTurn(s, e, ms) : null) || (s.current && !s.current.end ? s.current : null);
    const dur = Math.max(0, e.durationMs || 0), began = ms - dur;
    if (t && !sub && OWNER_TOOLS.has(tool)) this.sig(t, { ts: ms, type: "wait.end", kind: "question", key: e.parent?.toolUseId || e.id, basis: "observed" }); // closes the tool.call wait (also for transcript results)
    if (t) {
      if (!sub && (e.payload?.ownerWaitMs != null || (OWNER_TOOLS.has(tool) && e.source !== "claude-transcript"))) {
        const w = e.payload?.ownerWaitMs ?? dur; const key = e.parent?.toolUseId || e.id; // the tool's run time IS the owner answering
        if (w > 0) { this.sig(t, { ts: ms - w, type: "wait.begin", kind: "question", key, basis: "observed" }); this.sig(t, { ts: ms, type: "wait.end", kind: "question", key, basis: "observed" }); }
        this.sig(t, { ts: ms, type: "wait.end", kind: "question", basis: "observed" }); // the answer also ends a question opened by the permission path
      } else if (!sub && e.payload?.approvalWaitMs != null) {
        const key = e.parent?.toolUseId || e.id;
        if (e.payload.approvalWaitMs > 0) { this.sig(t, { ts: ms - e.payload.approvalWaitMs, type: "wait.begin", kind: "approval", key, basis: "inferred" }); this.sig(t, { ts: ms, type: "wait.end", kind: "approval", key, basis: "inferred" }); }
      } else {
        if (!sub) for (const k of ["question", "rate_limit", "api_error"]) this.sig(t, { ts: began, type: "wait.end", kind: k, basis: "observed" }); // a main-thread tool running means nothing is pending
        if (this.approvalDecidedBy(s, e, sub, began)) this.sig(t, { ts: began, type: "wait.end", kind: "approval", basis: "observed" });
        if (!sub) this.sig(t, { ts: began, type: "turn.open", basis: "inferred" });
        this.sig(t, { ts: ms, sinceTs: began, type: "activity", basis: "observed" });
        if (sub) this.sig(t, { ts: ms, type: "span.touch", key: e.actor.agentId });
      }
    }
    // Owner attention: the answered question closes; any main-thread result means a pending approval was decided.
    if (e.parent?.toolUseId) this.closeAttention(s, (a) => a.key === `ask:${e.parent.toolUseId}`, e.ts, "answered");
    if (this.approvalDecidedBy(s, e, sub, began)) this.closeAttention(s, (a) => a.key === "approval", e.ts, "decided"); // a parallel tool that began earlier decides nothing
    if (!sub) s.rateLimit = null;
    if (t) { t.toolCalls++; if (!sub) t.mainCalls++; if (failed) t.failures++; }
    const a = e.actor?.agentId ? s.agents.get(e.actor.agentId) : null;
    if (a) { a.toolCalls++; a.lastSeen = e.ts; a.lastTool = tool || null; }
    if (op) this.pushOp(s, op);
    const scope = this.scopeKey(s);
    const who = { session: s.id, agentId: e.actor?.agentId || null };

    // Code changes stale the scope's passing checks (documentation edits do not).
    if (EDIT_TOOLS.has(tool) && !failed) {
      if (t) t.edits++; if (a) a.edits++;
      const ext = e.payload?.ext || null;
      if (!ext || !DOC_EXTS.has(ext)) { if (t) t.codeEdits++; this.scoring.codeChange(scope, e.ts, { ...who, what: `${tool}${ext ? " " + ext : ""}` }); }
    }
    const kinds = sigKinds(e.payload?.signatures?.length ? e.payload.signatures : e.payload?.signature ? [e.payload.signature] : []);
    if (kinds.mutating && !failed) this.scoring.codeChange(scope, e.ts, { ...who, what: kinds.mutating });
    // A failing test command whose output was not parsed (the failure hook carries no output) is still a failed check.
    // A failed chain carries no per-segment exit status: blame a check only when it is the only check in the chain.
    const ambiguous = failed && kinds.test && kinds.build;
    if (kinds.test && failed && !interrupted && !ambiguous) this.scoring.checkRun(scope, { key: kinds.test, label: kinds.test, kind: "test", ok: false, ts: e.ts, ...who });
    if (kinds.build && !interrupted && !ambiguous) this.scoring.checkRun(scope, { key: kinds.build, label: kinds.build, kind: "build", ok: !failed, ts: e.ts, ...who });
    if (ambiguous && !interrupted) this.record(s, e, `chained checks failed · ${kinds.build} / ${kinds.test} · which one is not observable (no foul)`);

    // Subagent delivery through the Agent tool's result.
    if (tool === "Agent" && !sub) {
      const ag = this.agentForResult(s, e, ms, dur, { includeEnded: failed && !interrupted });
      if (ag) { ag.parentToolUseId = ag.parentToolUseId || e.parent?.toolUseId || null; if (e.payload?.subagentType && !ag.type) ag.type = e.payload.subagentType; if (e.payload?.subagentModel && !ag.model) { ag.model = e.payload.subagentModel; ag.modelBasis = "declared"; } }
      const type = e.payload?.subagentType || ag?.type || "agent";
      if (failed && !interrupted) {
        if (ag) { if (!ag.end) this.endAgent(s, ag, e.ts, "inferred", { failedRun: true }); else { this.agentHistory = this.agentHistory.filter((h) => h.id !== `${s.id}:${ag.id}`); } this.scoring.revoke(`agent:${s.id}:${ag.id}`, "Agent tool reported failure"); }
        this.scoring.openFoul(scope, { key: `agent:${type}:${e.parent?.toolUseId || e.id}`, kind: "subagent-failure", label: `${type} did not deliver`, ts: e.ts, ...who, basis: "observed" });
      } else if (!failed && ag && !ag.end) { this.endAgent(s, ag, e.ts, "inferred"); this.agentDelivered(s, ag, e.ts, "inferred"); }
    }
    if (failed && !interrupted && (kinds.test || kinds.build || tool === "Agent")) this.record(s, e, `${kinds.test ? "test command" : kinds.build ? "build command" : "subagent"} failed · ${kinds.test || kinds.build || e.payload?.subagentType || tool}${e.actor?.agentId ? " · agent " + short(e.actor.agentId) : ""}`);
  }

  // The subagent an Agent tool result belongs to: same type, started inside the call, and the call lasted (nearly) its
  // whole life so far (a background launch returns at once and must not end the agent).
  // A failed call may belong to an agent that already reported its stop (the failure comes after it): includeEnded.
  agentForResult(s, e, ms, dur, { includeEnded = false } = {}) {
    const type = e.payload?.subagentType || null;
    const cands = [...s.agents.values()].filter((a) => {
      if (e.parent?.toolUseId && a.parentToolUseId === e.parent.toolUseId) return true;
      if ((a.end && (!includeEnded || a.parentToolUseId || a.endBasis === "lost")) || (type && a.type && a.type !== type)) return false;
      const st = Date.parse(a.start); const life = ms - st;
      return st >= ms - dur - 5000 && life >= 10e3 && dur >= 0.9 * life; // a launch that returns within seconds is a background agent: never ended by it
    });
    return cands.sort((x, y) => (x.start || "").localeCompare(y.start || ""))[0] || null;
  }
  endAgent(s, a, ts, basis, { failedRun = false } = {}) {
    a.end = ts; a.endBasis = basis; a.lastSeen = a.lastSeen > ts ? a.lastSeen : ts;
    const tt = s.tasks.find((x) => x.id === a.taskId);
    if (tt) { tt.completedAgents++; this.sig(tt, { ts, type: "span.end", key: a.id, basis }); }
    const rec = { id: `${s.id}:${a.id}`, type: a.type || null, model: a.model || null, durationMs: Math.max(0, Date.parse(ts) - Date.parse(a.start)), endedAt: ts, endBasis: basis, session: s.id };
    if (basis !== "lost" && !failedRun && !this.agentHistoryIds.has(rec.id)) { this.agentHistoryIds.add(rec.id); this.agentHistory.push(rec); if (this.agentHistory.length > 2000) this.agentHistory.shift(); }
  }
  agentDelivered(s, a, ts, basis) {
    const scope = this.scopeKey(s);
    this.scoreWin(s, { key: `agent:${s.id}:${a.id}`, kind: "subagent", ts, observedDeliverable: true, agentId: a.id, label: `${a.type || "subagent"} delivered`, basis });
    if (a.type) this.scoring.resolveMatching(scope, `agent:${a.type}:`, { ts, by: `${a.type} delivered`, basis: "inferred", session: s.id });
  }
  scoreWin(s, w) {
    const win = this.scoring.win(s, { ...w, scopeKey: this.scopeKey(s) });
    if (win) { this.raise({ ts: w.ts }, "win", `${win.tier === "probable" ? "probable " : ""}win · ${win.label}`, s, true); this.record(s, { ts: w.ts, kind: "win" }, `WIN (${win.tier}) · ${win.label}`); }
    return win;
  }

  applyStateChange(s, e, t) {
    const p = e.payload || {};
    if (p.change === "identity") {
      for (const k of ["folder", "repo", "repoKey", "branch", "title", "custom"]) if (k in p) s.identity[k] = p[k];
    } else if (p.change === "registry") {
      s.identity.regName = p.name || null; s.identity.regCustom = p.custom || null; s.identity.regRepo = p.repo || null; s.identity.regRepoKey = p.repoKey || null; s.identity.regStatus = p.status || null;
      if (p.alive === false && !s.processGone && !s.end) { s.processGone = e.ts; this.closeAttention(s, () => true, e.ts, "process ended"); for (const a of s.agents.values()) if (!a.end) this.endAgent(s, a, a.lastSeen || e.ts, "lost"); this.record(s, e, "Claude Code process is no longer running"); }
      if (p.alive === true) s.processGone = null;
    } else if (p.change === "attention") {
      if (p.state === "open") this.openAttention(s, e, { key: p.kind === "question-in-reply" ? "reply" : `x:${e.parent?.toolUseId || e.id}`, kind: p.kind === "question-in-reply" ? "question" : p.kind || "question", basis: e.provenance?.observed === false ? "inferred" : "observed", label: p.kind === "question-in-reply" ? "reply ends with a question" : p.kind || "attention" });
      else if (p.state === "closed") this.closeAttention(s, (a) => a.key === `ask:${e.parent?.toolUseId}` || a.key === `x:${e.parent?.toolUseId}`, e.ts, "answered");
    }
  }

  // A tool result decides a pending approval only if it began after the request (a parallel tool that began earlier
  // decides nothing) and comes from the agent that asked: the main thread, or that subagent. With no approval open
  // the main thread's result also clears any approval wait opened by a notification alone.
  approvalDecidedBy(s, e, sub, began) {
    const a = s.attention.get("approval");
    if (!a) return !sub;
    if (began < Date.parse(a.since) - 1000) return false;
    if (a.kind !== "approval") return !sub; // a question through the permission path: decided by the main thread
    return sub ? !!a.agentId && a.agentId === e.actor?.agentId : !a.agentId;
  }
  openAttention(s, e, { key, kind, basis, label, agentId = null }) {
    if (s.attention.has(key) || s.end || s.processGone) return;
    // Transcript facts arrive a few seconds after the hooks: never reopen what was already answered, and never open a
    // request older than the owner's latest prompt (the prompt answered it).
    if (s.closedKeys?.has(key) || (s.lastPromptTs && e.ts < s.lastPromptTs)) return;
    s.attention.set(key, { key, kind, basis, label, since: e.ts, agentId });
    this.raise(e, "attention", `needs you · ${label}`, s, basis === "inferred");
    this.record(s, e, `attention · ${label}${basis === "inferred" ? " (inferred)" : ""}`);
  }
  closeAttention(s, pred, ts, why) {
    for (const [k, a] of [...s.attention]) if (pred(a)) { s.attention.delete(k); if (k !== "approval" && k !== "reply") { (s.closedKeys ||= new Set()).add(k); if (s.closedKeys.size > 500) s.closedKeys.delete(s.closedKeys.values().next().value); } s.log.push({ ts, kind: "attention", text: `attention cleared · ${a.label} · ${why}`, actor: "system", agentId: null, observed: true }); }
  }

  setModel(s, model, basis, ts) { if (typeof model !== "string" || model === "<synthetic>") return; s.model = model; s.modelBasis = basis; s.modelSince = ts; const t = s.current; if (t && !t.end && !t.modelAtStart) t.modelAtStart = model; }
  pushOp(s, op) { s.recentOps.push(op); if (s.recentOps.length > 8) s.recentOps.shift(); }
  record(s, e, text) { s.log.push({ ts: e.ts, kind: e.kind, text, actor: e.actor?.type, agentId: e.actor?.agentId || null, observed: e.provenance?.observed !== false }); if (s.log.length > this.opts.maxLog) s.log.shift(); }
  raise(e, kind, text, s, quiet = false) { this.alerts.push({ ts: e.ts, kind, text, session: s.id, project: s.project, label: sessionLabel(s).text, quiet }); if (this.alerts.length > 200) this.alerts.shift(); }
  takeAlerts() { const a = this.alerts; this.alerts = []; return a; }

  // The session the board shows. A pinned session always wins. Otherwise follow the most recently active session, but
  // hold the current one while it is still busy (no flipping between concurrent terminals every few seconds).
  focusSession(pinned = null, nowMs = null) {
    if (pinned && this.sessions.has(pinned)) return pinned;
    const now = nowMs ?? this.latestTs();
    let best = null; for (const s of this.sessions.values()) if (!best || (s.lastEventTs || "") > (best.lastEventTs || "")) best = s;
    const cur = this.autoFocus ? this.sessions.get(this.autoFocus) : null;
    if (cur && best && cur !== best && !cur.end && !cur.processGone && cur.lastEventTs && now - Date.parse(cur.lastEventTs) < this.opts.focusHoldMs) return cur.id;
    this.autoFocus = best?.id || null; return this.autoFocus;
  }
  latestTs() { let m = 0; for (const s of this.sessions.values()) if (s.lastEventTs) m = Math.max(m, Date.parse(s.lastEventTs)); return m || Date.now(); }
  // Sessions to cycle through: live ones first (not ended, seen in the stale window), most recent first.
  cycleList(nowMs = this.latestTs()) { return this.sessionList(nowMs).filter((x) => x.status !== "ended" && x.status !== "stale"); }

  sessionList(nowMs) {
    return [...this.sessions.values()].map((s) => { const lab = sessionLabel(s); return { id: s.id, project: s.project, label: lab.text, labelSource: lab.source, repo: s.identity.repo || s.identity.regRepo || null, branch: s.identity.branch || null, lastEventTs: s.lastEventTs, status: sessionStatus(s, nowMs, this.opts), periods: s.periods, tasks: s.tasks.length, agents: [...s.agents.values()].filter((a) => agentState(a, nowMs, this.opts, s) === "active" || agentState(a, nowMs, this.opts, s) === "running").length, attention: [...s.attention.values()].map((a) => ({ kind: a.kind, label: a.label, since: a.since, basis: a.basis })), wins: winSummary(s.wins).total, synthetic: s.synthetic }; })
      .sort((a, b) => (b.lastEventTs || "").localeCompare(a.lastEventTs || ""));
  }

  // ---- clocks ----
  // Time LEFT only. The countdown runs on active time, so it stops whenever the stopwatch is not active (approval,
  // question, rate limit, API error, external wait, declared pause, or a stall) and resumes with the work.
  gameClock(t, live, nowMs, alive = true) {
    if (!t) return { mode: "unknown", basis: "unavailable", note: "no period" };
    if (!live) return { mode: "final", basis: "observed", remainingMs: 0, adjustments: t.adjustments?.length || 0, note: "period over" };
    const sw = t.sw.totals(nowMs);
    const active = sw.activeMs;
    // Active time can change retroactively: a tool that ran silently past the stall limit turns that "unknown" time
    // into active time when its result arrives; a wait learned only from a result removes active time. Either way
    // the clock would jump, so the change beyond what the wall clock allows is recorded as a visible adjustment.
    const prev = t.clockLast;
    if (t.target && prev && nowMs >= prev.nowMs) {
      const dActive = active - prev.active, dWall = nowMs - prev.nowMs;
      const extra = dActive > dWall ? dActive - dWall : dActive < 0 ? dActive : 0;
      if (Math.abs(extra) >= CLOCK_RULES.adjustMinMs) {
        const before = t.target.activeMs - prev.active;
        (t.adjustments ||= []).push({ at: new Date(nowMs).toISOString(), activeAt: active, fromMs: before, toMs: before - extra, deltaMs: -extra, reason: extra > 0 ? "long silent tool run counted" : "wait found afterwards" });
      }
    }
    t.clockLast = nowMs >= (prev?.nowMs ?? -Infinity) ? { nowMs, active } : prev;
    const v2 = this.predict(t, nowMs);
    const r = v2?.remaining;
    if (r?.p50 != null && v2.state === "estimating") {
      const evidence = gameEvidence(v2, t.estimate);
      if (!t.target || t.target.evidence !== evidence) {
        const est = !CLOCK_RULES.countdownConfidence.includes(v2.confidence);
        const next = { activeMs: active + r.p50, loActiveMs: est ? active + r.p10 : null, hiActiveMs: est ? active + r.p90 : null, durMs: r.p50, loDurMs: r.p10 ?? null, hiDurMs: r.p90 ?? null, overtime: t.target?.overtime || 0, at: new Date(nowMs).toISOString(), confidence: v2.confidence, method: v2.method, n: v2.n, evidence };
        if (!t.target) t.target = next;
        else {
          const before = t.target.activeMs - active, delta = r.p50 - before;
          if (Math.abs(delta) >= CLOCK_RULES.adjustMinMs) {
            (t.adjustments ||= []).push({ at: next.at, activeAt: active, fromMs: before, toMs: r.p50, deltaMs: delta, reason: adjustReason(t.target, next) });
            t.target = next;
          } else { // same time within the threshold: keep the countdown, refresh what the label says about it
            const keep = t.target.activeMs - next.activeMs;
            t.target = { ...next, activeMs: t.target.activeMs, loActiveMs: next.loActiveMs != null ? next.loActiveMs + keep : null, hiActiveMs: next.hiActiveMs != null ? next.hiActiveMs + keep : null, at: t.target.at };
          }
        }
      }
    }
    // OVERTIME (design decision 2026-11-13): at 0:00 the OVERTIME lamp lights and the clock resets to the estimator's
    // remaining-time p50 and counts down again. Without a fresh estimate it resets to the lower bound of the last known
    // range (labelled EST). It never shows a negative time and never counts up.
    if (t.target && t.target.activeMs - active <= 0) {
      const tg = t.target, fresh = r?.p50 != null && r.p50 > 0 && v2.state === "estimating";
      const raw = fresh ? r.p50 : tg.loDurMs > 0 ? tg.loDurMs : tg.durMs > 0 ? tg.durMs : 60e3;
      const step = Math.max(raw, CLOCK_RULES.overtimeMinStepMs); // never a reset loop of a few seconds at 0:00
      const floored = step > raw;
      // the range shown must contain the step actually counted down (a floored step is never shown as a 0-0 range)
      const lo = floored ? step : fresh ? r.p10 : step;
      const hi = floored ? Math.max(step, r?.p90 ?? 0) : fresh ? r.p90 : tg.hiDurMs > step ? tg.hiDurMs : null;
      const est = !fresh || floored || !CLOCK_RULES.countdownConfidence.includes(v2.confidence);
      t.target = { ...tg, activeMs: active + step, loActiveMs: est ? active + Math.max(0, lo ?? step) : null, hiActiveMs: est && hi != null ? active + hi : est ? active + step : null,
        durMs: step, loDurMs: fresh ? r.p10 : tg.loDurMs, hiDurMs: fresh ? r.p90 : tg.hiDurMs, confidence: fresh ? v2.confidence : tg.confidence, overtime: (tg.overtime || 0) + 1,
        reset: floored ? "minimum step" : fresh ? "re-estimated" : "lower bound", at: new Date(nowMs).toISOString(), ...(fresh ? { evidence: gameEvidence(v2, t.estimate) } : {}) };
    }
    const stopped = sw.state !== "active" ? { state: sw.state, kind: sw.kind, forUser: !!userWaitOf(sw, alive) } : null;
    if (!t.target) return { mode: "unknown", basis: "unavailable", stopped, confidence: v2?.confidence || "none", n: v2?.n ?? 0, note: v2?.note || "insufficient data" };
    const tg = t.target, remainingMs = tg.activeMs - active;
    const last = t.adjustments?.at(-1);
    const adjustment = last && active - last.activeAt < CLOCK_RULES.adjustShowMs ? last : null; // shown for adjustShowMs of RUNNING clock
    const estimate = tg.loActiveMs != null;
    const range = estimate ? { loMs: Math.max(0, tg.loActiveMs - active), hiMs: Math.max(0, tg.hiActiveMs - active) } : null;
    const overtime = tg.overtime || 0;
    const common = { basis: "predicted", target: tg, confidence: tg.confidence, estimate, range, stopped, adjustment, adjustments: t.adjustments?.length || 0, overtime, reset: overtime ? tg.reset : null };
    return { mode: "countdown", remainingMs: Math.max(0, remainingMs), ...common, note: `${overtime ? "overtime · " : ""}${estimate ? `estimate · ${tg.confidence} confidence` : `${tg.confidence} confidence`}` };
  }

  agentEstimate(a, nowMs) {
    const elapsed = Math.max(0, nowMs - Date.parse(a.start));
    if (a.target) return countdown(a.target.atMs - nowMs, elapsed, a.target, "established countdown");
    const same = this.agentHistory.filter((h) => a.type && h.type === a.type && h.endedAt < a.start && h.durationMs > 0).map((h) => h.durationMs);
    if (same.length < CLOCK_RULES.agentMinN) return { mode: "unknown", basis: "unavailable", elapsedMs: elapsed, n: same.length, note: `${same.length} completed ${a.type || "untyped"} agents in history (need ${CLOCK_RULES.agentMinN})` };
    const tail = same.filter((d) => d > elapsed).sort((x, y) => x - y);
    if (tail.length < CLOCK_RULES.agentMinTail) return { mode: "unknown", basis: "unavailable", elapsedMs: elapsed, n: same.length, note: `already longer than nearly all ${a.type} agents: lower bound only` };
    const q = (p) => quantile(tail, p) - elapsed;
    const p10 = Math.max(0, q(0.1)), p50 = Math.max(0, q(0.5)), p90 = Math.max(0, q(0.9));
    const spread = quantile(tail, 0.9) / Math.max(1, quantile(tail, 0.1));
    if (same.length >= CLOCK_RULES.agentCountdownN && spread <= CLOCK_RULES.agentCountdownSpread) { a.target = { atMs: nowMs + p50, at: new Date(nowMs).toISOString(), n: same.length }; return countdown(p50, elapsed, a.target, `${a.type} history n ${same.length}`); }
    return { mode: "range", basis: "predicted", p10, p50, p90, elapsedMs: elapsed, n: same.length, confidence: "low", note: `${a.type} history n ${same.length}, spread ${spread.toFixed(1)}x` };
  }

  shotClock(s, nowMs) {
    const running = [...s.agents.values()].filter((a) => { const st = agentState(a, nowMs, this.opts, s); return st === "active" || st === "running"; });
    if (!running.length) return { mode: "unknown", basis: "unavailable", note: "no subagent running", agentId: null };
    const ests = running.map((a) => ({ a, est: this.agentEstimate(a, nowMs) }));
    const rank = (x) => x.est.mode === "countdown" || x.est.mode === "overtime" ? x.est.remainingMs : x.est.mode === "range" ? x.est.p50 : Infinity;
    ests.sort((x, y) => rank(x) - rank(y) || (x.a.start || "").localeCompare(y.a.start || ""));
    const pick = ests[0];
    return { ...pick.est, agentId: pick.a.id, agentType: pick.a.type, running: running.length, label: `${pick.a.type || "agent"}${pick.a.model ? " · " + pick.a.model : ""}` };
  }

  snapshot(sessionId, nowMs = Date.now()) {
    const s = this.sessions.get(sessionId);
    if (!s) return emptySnapshot(nowMs);
    const t = s.current && !s.current.end ? s.current : lastTask(s);
    const live = !!t && !t.end;
    const status = sessionStatus(s, nowMs, this.opts);
    const endMs = t ? (live ? nowMs : Date.parse(t.end)) : null;
    const sw = t ? t.sw.totals(endMs) : null;
    const workMs = sw ? sw.activeMs : null;
    const estimate = t?.estimate || null;
    const eta = live && estimate ? this.predictions.etaFor(t, workMs) : null;
    const v2 = live ? this.predict(t, nowMs) : null;
    const swWaiting = live && sw.state === "waiting" ? { kind: sw.kind, since: new Date(sw.since).toISOString(), forMs: Math.max(0, nowMs - sw.since), basis: sw.basis } : null;
    const attention = [...s.attention.values()].sort((a, b) => a.since.localeCompare(b.since));
    const phase = attention.length ? { word: "WAIT", basis: attention.some((a) => a.basis === "observed") ? "observed" : "inferred", note: `needs you · ${attention[0].label}` } : swWaiting ? { word: "WAIT", basis: swWaiting.basis === "observed" ? "observed" : "inferred", note: `waiting · ${swWaiting.kind}` } : phaseOf(s, t, status, nowMs);
    const agents = [...s.agents.values()].map((a) => agentView(a, nowMs, this.opts, s));
    const running = agents.filter((a) => a.state === "active" || a.state === "running");
    const lastActor = lastActive(s, agents);
    const scope = this.scopeKey(s);
    const sc = this.scoring.scopes.get(scope);
    const checks = sc ? [...sc.checks.values()] : [];
    const valid = checks.filter((c) => c.state === "pass" && !c.staleSince);
    const fouls = this.scoring.unresolved(scope);
    const wins = winSummary(s.wins);
    const lab = sessionLabel(s);
    const alive = !s.end && !s.processGone;
    const game = this.gameClock(t, live, nowMs, alive);
    const uw = userWaitOf(sw, live && alive);
    const since = uw ? userWaitSince(t.sw.timeline(nowMs), uw.since) : null;
    // F6: the request that matches the wait, newest first (not the oldest open entry)
    const fits = uw?.kind === "approval" ? (a) => a.kind === "approval" : (a) => a.kind === "question" || a.kind === "plan-approval" || a.kind === "input";
    const req = uw && uw.kind !== "owner" ? [...attention].reverse().find(fits) : null;
    const timer = uw
      ? { running: true, kind: uw.kind, request: req?.kind || null, since: new Date(since).toISOString(), waitingMs: Math.max(0, nowMs - since), basis: uw.basis }
      : { running: false, kind: null, note: !live ? "no task open" : "not waiting on you" };
    const shot = this.shotClock(s, nowMs);
    const mainState = s.end || s.processGone ? "ended" : attention.length ? "waiting" : live ? (status === "active" ? "active" : "running") : "idle";
    return {
      session: { id: s.id, project: s.project, label: lab.text, labelSource: lab.source, repo: s.identity.repo || s.identity.regRepo || null, branch: s.identity.branch || null, scope, status, synthetic: s.synthetic, start: s.start, end: s.end, endReason: s.endReason, processGone: s.processGone, lastEventTs: s.lastEventTs, tasks: s.tasks.length, periods: s.periods },
      task: t ? { id: t.id, title: t.title, basis: t.basis, kind: t.kind, resumed: t.resumed, start: t.start, end: t.end, endReason: t.endReason || null, outcome: t.outcome || null, live, turns: t.turns, toolCalls: t.toolCalls, mainCalls: t.mainCalls, edits: t.edits, codeEdits: t.codeEdits, estimate, agents: t.agents.length, completedAgents: t.completedAgents } : null,
      wins: field(wins.total, wins.total ? (wins.probable === wins.total ? "inferred" : "observed") : "observed", `${wins.sure} verified/confirmed · ${wins.unverified} unverified · ${wins.probable} probable`),
      winDetail: { ...wins, list: s.wins.slice(-30).reverse() },
      // HOME shows the team's wins; GUEST the declared remaining scope (question marks when there is none).
      home: field(wins.total, "observed", "wins · team score of this session"),
      guest: estimate?.calls != null ? field(Math.max(0, estimate.calls - (t?.toolCalls || 0)), "predicted", `declared estimate of ${estimate.calls} calls`) : field(null, "unavailable", "scope unknown · no declared estimate"),
      period: s.periods ? field(s.periods, "observed", t?.resumed && live ? "turn in this session · resumed without a prompt" : "turn in this session") : field(null, "unavailable", "no turn yet"),
      phase: field(phase.word, phase.basis, phase.note),
      game,
      // time LEFT only (design decision 2026-11-13); time spent stays in stopwatch data for estimation, never displayed
      gameClock: game.mode === "countdown" ? field(game.remainingMs, "predicted", game.note) : game.mode === "final" ? field(0, "observed", game.note) : field(null, "unavailable", game.note || ""),
      stopwatch: sw ? { state: sw.state, kind: sw.kind, since: sw.since != null ? new Date(sw.since).toISOString() : null, basis: sw.basis, activeMs: sw.activeMs, observedActiveMs: sw.observedActiveMs, waitingMs: sw.waitingMs, byKind: sw.byKind, pausedMs: sw.pausedMs, unknownMs: sw.unknownMs, wallMs: sw.wallMs } : null,
      etaV2: v2 ? { ...v2, displayMin: v2.remaining?.p50 != null ? Math.ceil(v2.remaining.p50 / 60000) : null } : null,
      shot,
      timer,
      shotClock: shot.mode === "countdown" || shot.mode === "overtime" ? field(shot.remainingMs, "predicted", shot.note) : shot.mode === "range" ? field(shot.p50, "predicted", shot.note) : field(null, "unavailable", shot.note),
      model: s.model ? field(s.model, s.modelBasis, "main thread · from transcript / session start") : field(null, "unavailable", "model not yet observed"),
      tokens: t ? tokenTotals(t.models) : null,
      rateLimit: s.rateLimit,
      eta,
      fouls: field(fouls.length, fouls.some((f) => f.basis === "inferred") ? "inferred" : "observed", fouls.length ? fouls.map((f) => f.label).slice(0, 3).join(" · ") : "no unresolved problems"),
      foulDetail: { unresolved: fouls, resolved: sc ? sc.resolved.slice(-20).reverse() : [] },
      bonus: fouls.length >= 5,
      verified: field(valid.length, "observed", valid.length ? valid.map((c) => c.label).join(" · ") : checks.some((c) => c.staleSince) ? "checks are stale after later code changes" : checks.length ? "latest checks failed" : "no checks observed in this repository"),
      checks: checks.map((c) => ({ ...c, status: c.state === "fail" ? "failed" : c.staleSince ? "stale" : "valid" })),
      tests: valid.some((c) => c.kind === "test") ? field("PASS", "observed", "a test check is valid") : checks.some((c) => c.kind === "test" && c.state === "fail") ? field("FAIL", "observed", "a test check failed") : field(null, "unavailable", "no valid test evidence"),
      timeouts: field(attention.length, attention.length && attention.every((a) => a.basis === "inferred") ? "inferred" : "observed", attention.length ? attention.map((a) => a.label).join(" · ") : "nothing waiting for you"),
      attention,
      idle: s.idle ? { since: s.idle, forMs: Math.max(0, nowMs - Date.parse(s.idle)) } : null,
      waiting: attention.length ? { kind: attention[0].kind, since: attention[0].since, forMs: Math.max(0, nowMs - Date.parse(attention[0].since)), basis: attention[0].basis } : swWaiting,
      main: { state: mainState, model: s.model },
      player: field(running.length, "observed", `${running.length} subagent${running.length === 1 ? "" : "s"} running · main ${mainState}`),
      possession: lastActor?.side || null,
      lastActor,
      agents,
      openTools: s.openTools.size,
      log: s.log.slice(-this.opts.maxLog),
      predictions: this.predictions.history.filter((p) => p.session === s.id),
      calibration: this.predictions.calibration(),
      now: nowMs,
    };
  }
}

function adjustReason(prev, next) {
  if (prev.method !== next.method) return `method ${prev.method} → ${next.method}`;
  if (prev.n !== next.n) return `history n ${prev.n} → ${next.n}`;
  const a = prev.evidence.split("|"), b = next.evidence.split("|");
  if (a.slice(3, 6).join("|") !== b.slice(3, 6).join("|")) return "declared estimate changed";
  if (a[6] !== b[6]) return "pace of this task";
  return "new evidence";
}
function countdown(remainingMs, elapsedMs, target, note) {
  return remainingMs >= 0 ? { mode: "countdown", basis: "predicted", remainingMs, elapsedMs, target, note } : { mode: "overtime", basis: "predicted", remainingMs, overtimeMs: -remainingMs, elapsedMs, target, note: "past the established estimate · overtime" };
}
function quantile(sorted, p) { if (!sorted.length) return null; const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); }
function regimeOf(t) { return t.kind === "turn" ? "turn" : t.basis === "observed" ? "marked" : "brief"; }

// Display label from the best available evidence (sessionFacts.js LABEL_ORDER).
export function sessionLabel(s) {
  const id = s.identity || {};
  if (id.custom || id.regCustom) return { text: id.custom || id.regCustom, source: "custom" };
  if (id.title) return { text: id.title, source: "title" };
  if (id.repo) return { text: id.branch && !/^(main|master)$/.test(id.branch) ? `${id.repo} · ${id.branch}` : id.repo, source: "repo" };
  if (id.regName) return { text: id.regName, source: "registry" };
  if (s.project) return { text: s.project, source: "folder" };
  return { text: String(s.id).slice(0, 8), source: "id" };
}

export function field(value, basis, note = "") { return { value, basis, note }; }
function emptySnapshot(nowMs) {
  const u = field(null, "unavailable", "no session");
  const unk = { mode: "unknown", basis: "unavailable", note: "no session" };
  return { session: null, task: null, wins: field(0, "observed", ""), winDetail: { total: 0, sure: 0, confirmed: 0, verified: 0, unverified: 0, probable: 0, revoked: 0, list: [] }, home: u, guest: u, period: u, phase: field("IDLE", "observed", "no events"), game: unk, gameClock: u, shot: { ...unk, agentId: null }, shotClock: u, timer: { running: false, kind: null, note: "no session" }, eta: null, stopwatch: null, etaV2: null, model: u, tokens: null, rateLimit: null, fouls: field(0, "observed", ""), foulDetail: { unresolved: [], resolved: [] }, bonus: false, timeouts: field(0, "observed", ""), attention: [], idle: null, waiting: null, verified: field(0, "observed", ""), checks: [], tests: u, main: { state: "idle", model: null }, player: field(0, "observed", "no actor"), possession: null, lastActor: null, agents: [], openTools: 0, log: [], predictions: [], calibration: { n: 0, k: 1 }, now: nowMs };
}
function lastTask(s) { return s.tasks.length ? s.tasks[s.tasks.length - 1] : null; }
function short(id) { return String(id || "").slice(0, 8); }
function fmtEstimate(p) { if (!p) return ""; const parts = []; if (p.p50Min != null) parts.push(`${p.p50Min} min`); else if (p.minutes != null) parts.push(`${p.minutes} min`); if (p.p90Min != null) parts.push(`p90 ${p.p90Min}`); if (p.calls != null) parts.push(`${p.calls} calls`); return parts.join(" · "); }

export function tokenTotals(models = {}) {
  const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, responses: 0, byModel: models };
  for (const m of Object.values(models)) for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "responses"]) out[k] += m[k] || 0;
  return out;
}

// The completed period/task record stored in the calibration ledger. Content-free: ids, counts, durations (no labels).
export function taskRecord(t, endMs) {
  const sw = t.sw.totals(endMs);
  return {
    schema: "alexandria.task/1", id: `${t.session}:${t.id}`, taskId: t.id, session: t.session, project: t.project, title: t.title, basis: t.basis,
    features: { type: t.type || null, model: t.modelAtStart || null, regime: regimeOf(t), size: t.size },
    declared: t.estimate ? { p50Min: t.estimate.p50Min ?? t.estimate.minutes ?? null, p90Min: t.estimate.p90Min ?? null, calls: t.estimate.calls ?? null } : null,
    startedAt: t.start, endedAt: t.end, endReason: t.endReason, resumed: !!t.resumed,
    actualActiveMs: sw.activeMs, observedActiveMs: sw.observedActiveMs, waitingMs: sw.waitingMs, waitByKind: sw.byKind, pausedMs: sw.pausedMs, unknownMs: sw.unknownMs, wallMs: sw.wallMs,
    actualCalls: t.toolCalls, mainCalls: t.mainCalls, turns: t.turns, agents: t.agents.length, failures: t.failures, testsPassed: t.testsPassed, testsFailed: t.testsFailed, commits: t.commits, edits: t.edits,
    tokens: tokenTotals(t.models),
    // Calibrates future estimates only when work was observed in it.
    calibratable: (t.toolCalls > 0 || tokenTotals(t.models).responses > 0) && sw.activeMs >= 30e3,
    predictionAtStart: slimPrediction(t.predictionAtStart), predictionAtEstimate: slimPrediction(t.predictionAtEstimate), estimatorVersion: ESTIMATOR_VERSION,
  };
}
function slimPrediction(p) { if (!p) return null; return { method: p.method, state: p.state, stratum: p.stratum || null, n: p.n, confidence: p.confidence, p10: p.total?.p10 ?? null, p50: p.total?.p50 ?? null, p90: p.total?.p90 ?? null }; }

export function taskWorkMs(t, nowMs) {
  const end = t.end ? Date.parse(t.end) : nowMs;
  let waiting = t.waitingMs; if (!t.end && t.waitSince) waiting += Math.max(0, nowMs - Date.parse(t.waitSince));
  return Math.max(0, end - Date.parse(t.start) - waiting);
}

export function sessionStatus(s, nowMs, { idleMs, staleSessionMs }) {
  if (s.end || s.processGone) return "ended";
  const since = s.lastEventTs ? nowMs - Date.parse(s.lastEventTs) : Infinity;
  if (s.attention?.size && since <= ATTENTION_STALE_MS) return "waiting"; // an unanswered request keeps a session up for 12 h
  if (since > staleSessionMs) return "stale";
  if (since > idleMs) return "idle";
  return "active";
}

// Phase word from recent operations (inferred). Facts override it: no period → IDLE, period over → DONE.
export function phaseOf(s, t, status, nowMs) {
  if (!t) return { word: "IDLE", basis: "observed", note: "no period" };
  if (t.end) return { word: "DONE", basis: t.basis === "observed" ? "observed" : "inferred", note: t.basis === "observed" ? "task.end mark" : "turn ended" };
  if (status === "idle" || status === "stale") return { word: "IDLE", basis: "observed", note: `no events for ${Math.round((nowMs - Date.parse(s.lastEventTs)) / 1000)} s` };
  const ops = s.recentOps.slice(-5);
  if (!ops.length) return { word: "PLAN", basis: "inferred", note: "no tool operations yet" };
  const last = OP_PHASE[ops[ops.length - 1]];
  if (last === "TEST" || last === "COMMIT" || last === "REVIEW") return { word: last, basis: "inferred", note: `last operation ${ops[ops.length - 1]}` };
  const tally = {}; for (const o of ops) { const w = OP_PHASE[o]; if (w) tally[w] = (tally[w] || 0) + 1; }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return { word: best ? best[0] : "BUILD", basis: "inferred", note: `recent operations: ${ops.join(", ")}` };
}

// completed (stop seen, or its Agent result returned) · lost (no stop and no activity for agentLostMs, or the session
// ended) · active (seen in the last agentActiveMs) · running.
export function agentState(a, nowMs, { agentActiveMs, agentLostMs }, s = null) {
  if (a.end) return a.endBasis === "lost" ? "lost" : "completed";
  if (s && (s.end || s.processGone)) return "lost";
  const sinceSeen = nowMs - Date.parse(a.lastSeen || a.start);
  if (sinceSeen > agentLostMs) return "lost";
  return sinceSeen <= agentActiveMs ? "active" : "running";
}
export function agentView(a, nowMs, opts, s = null) {
  const state = agentState(a, nowMs, opts, s);
  const endMs = a.end ? Date.parse(a.end) : state === "lost" ? Date.parse(a.lastSeen || a.start) : nowMs;
  return { id: a.id, type: a.type, model: a.model, modelBasis: a.modelBasis, state, endBasis: a.endBasis, start: a.start, end: a.end, durationMs: Math.max(0, endMs - Date.parse(a.start)), toolCalls: a.toolCalls, edits: a.edits, wins: s ? s.wins.filter((w) => w.agentId === a.id && !w.revoked).length : 0, lastSeen: a.lastSeen, lastTool: a.lastTool, parentToolUseId: a.parentToolUseId, parentAgentId: a.parentAgentId, label: a.label, taskId: a.taskId };
}

function lastActive(s, agents) {
  const running = agents.filter((a) => a.state === "active" || a.state === "running").sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  const mainTs = s.lastMainTs || "";
  if (running.length && (running[0].lastSeen || "") > mainTs) return { side: "guest", label: `${running[0].type || "agent"}${running[0].model ? " · " + running[0].model : ""}`, agentId: running[0].id, basis: "observed" };
  if (s.lastMainTs) return { side: "home", label: "main thread", agentId: null, basis: "observed" };
  return null;
}
