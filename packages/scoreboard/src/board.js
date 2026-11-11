// Scoreboard board model. Browser-safe, UI-independent, pure: events in (alexandria.event/1 records from any
// adapter), a snapshot out. Every field in the snapshot carries a `basis`:
//   observed    taken directly from events whose provenance.observed is true
//   inferred    derived by a rule (task boundaries without marks, phase word from recent operations)
//   predicted   from a declared estimate (shot clock, remaining work)
//   unavailable the information does not exist in the stream; the UI shows dark digits, never a guess
//
// Scoreboard mapping (see docs/SCOREBOARD.md):
//   HOME        completed tool calls in the current task (main thread + subagents)                  observed
//   GUEST       remaining tool calls = declared estimate.calls − completed; dark without an estimate  predicted
//   PERIOD      turn number inside the current task (prompt → stop cycles)                          observed
//   PHASE word  PLAN / RESEARCH / BUILD / TEST / REVIEW / COMMIT / WAIT / IDLE from recent operations inferred
//   GAME CLOCK  working time of the current task: wall time minus owner waits; stops while waiting   observed
//   SHOT CLOCK  minutes left until the declared estimate (bias-corrected when history allows)        predicted
//   FOULS       tool failures + failed test runs; BONUS lamp at 5                                    observed
//   TIMEOUTS    owner waits taken (permission prompts, questions, idle prompts); lamp while waiting   observed
//   PLAYER      running agents and the most recently active actor                                    observed
//   VERIFIED    passing test runs + commits during the task                                          observed
//   STOPWATCH   (v0.2) active / waiting:<kind> / paused / unknown partition of the task's wall time   observed+inferred
//   ETA RANGE   (v0.2) p10–p90 remaining active time, method, confidence, or "insufficient data"   predicted
//   MODEL       main-thread model from transcripts / SessionStart / model switches                  observed
import { PredictionLog } from "./eta.js";
import { Stopwatch } from "../../stopwatch/src/stopwatch.js";
import { estimate, ESTIMATOR_VERSION } from "../../stopwatch/src/estimator.js";

export const PHASES = ["PLAN", "RESEARCH", "BUILD", "TEST", "REVIEW", "COMMIT", "WAIT", "IDLE", "DONE"];
const OP_PHASE = { read: "RESEARCH", search: "RESEARCH", browse: "RESEARCH", plan: "PLAN", delegate: "PLAN", edit: "BUILD", create: "BUILD", run: "BUILD", test: "TEST", build: "BUILD", commit: "COMMIT", publish: "COMMIT", ask: "WAIT", schedule: "PLAN", review: "REVIEW", other: null };
const REVIEW_AGENTS = new Set(["reviewer", "code-review", "security-review"]);
const QUIET_END_REASONS = new Set(["clear", "logout", "prompt_input_exit", "other"]);
const OWNER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// Complexity known at the start of an inferred brief: the length of the brief (never anything outcome-derived).
export function sizeBucket(promptLen) { if (promptLen == null) return null; return promptLen < 300 ? "xs" : promptLen < 1000 ? "s" : promptLen < 3000 ? "m" : "l"; }

export class Board {
  constructor({ briefLength = 300, gapMs = 2 * 3600e3, idleMs = 90e3, staleSessionMs = 30 * 60e3, agentActiveMs = 45e3, maxLog = 80, history = [], taskHistory = [], stallMs = 10 * 60e3, onTaskComplete = null, recordHistory = true } = {}) {
    this.opts = { briefLength, gapMs, idleMs, staleSessionMs, agentActiveMs, maxLog, stallMs };
    this.sessions = new Map();
    this.predictions = new PredictionLog(history);
    this.taskHistory = [...taskHistory]; // completed task records (ledger + backfill): the calibration store
    this.historyIds = new Set(this.taskHistory.map((r) => r.id));
    this.onTaskComplete = onTaskComplete;
    this.recordHistory = recordHistory; // false in the page: the server's ledger is the one source of history
    this.calibration = null; // measured metrics (coverage) from the evaluator, used for confidence
    this.alerts = []; // raised alert records, newest last; the UI takes and clears them
    this.seen = new Set();
    this.count = 0;
  }

  session(id, project) {
    if (!this.sessions.has(id)) this.sessions.set(id, {
      id, project: project || null, start: null, end: null, endReason: null, lastEventTs: null, lastMainTs: null,
      tasks: [], current: null, agents: new Map(), openTools: new Map(), waiting: null, stops: 0, prompts: 0, lastStop: null, explicitMarks: false,
      log: [], synthetic: false, recentOps: [], model: null, modelBasis: "unavailable", rateLimit: null,
    });
    const s = this.sessions.get(id); if (project) s.project = project; return s; // latest working directory wins
  }

  newTask(s, { id, title, start, basis, promptLen = null }) {
    if (s.current && !s.current.end) this.finishTask(s, s.current, s.lastStop && s.lastStop > s.current.start ? s.lastStop : start, "superseded");
    const t = { id, title: title || null, start, end: null, basis, toolCalls: 0, mainCalls: 0, failures: 0, testsFailed: 0, testsPassed: 0, commits: 0, waits: 0, waitingMs: 0, waitSince: null, turns: 0, lastStop: null, estimate: null, agents: [], completedAgents: 0, lastTestOk: null, promptLen,
      sw: new Stopwatch({ stallMs: this.opts.stallMs }), models: {}, type: null, size: sizeBucket(promptLen), modelAtStart: s.model, session: s.id, project: s.project, predictionAtStart: null, predictionAtEstimate: null, endReason: null };
    t.sw.push({ ts: start, type: "start", basis: basis === "observed" ? "declared" : "inferred" });
    s.tasks.push(t); s.current = t; return t;
  }

  // Close a task: the stopwatch stops at `endTs`, a completed record goes to the calibration store.
  finishTask(s, t, endTs, reason) {
    if (t.end) return null;
    t.end = endTs; t.endReason = reason; t.sw.push({ ts: endTs, type: "end" });
    if (s.current === t) s.current = null;
    const rec = taskRecord(t, Date.parse(endTs));
    if (!this.historyIds.has(rec.id)) { this.historyIds.add(rec.id); if (this.recordHistory) this.taskHistory.push(rec); if (this.onTaskComplete) this.onTaskComplete(rec); }
    return rec;
  }

  setHistory(records) { this.taskHistory = [...records]; this.historyIds = new Set(this.taskHistory.map((r) => r.id)); for (const s of this.sessions.values()) for (const t of s.tasks) if (t.end) this.historyIds.add(`${s.id}:${t.id}`); }
  features(t) { return { type: t.type || null, model: t.modelAtStart || null, regime: t.basis === "observed" ? "marked" : "brief", size: t.size }; }

  // History usable for a task: completed before it started (the same no-leakage rule as the evaluator).
  historyFor(t) { const start = t.start; return this.taskHistory.filter((h) => h.id !== t.id && h.calibratable !== false && h.endedAt && h.endedAt < start); }

  predict(t, nowMs) {
    const totals = t.sw.totals(nowMs);
    return estimate({ features: this.features(t), declared: t.estimate, progress: { activeMs: totals.activeMs, calls: t.toolCalls }, history: this.historyFor(t), calibration: this.calibration });
  }

  // Inferred tasks of quiet sessions end at their last stop once the session has been silent for gapMs (backfill and
  // long-running servers); marked tasks stay open until their task.end mark.
  finalizeStale(nowMs) {
    const out = [];
    for (const s of this.sessions.values()) {
      const t = s.current; if (!t || t.end || t.basis === "observed") continue;
      if (s.lastEventTs && nowMs - Date.parse(s.lastEventTs) > this.opts.gapMs) out.push(this.finishTask(s, t, s.lastStop && s.lastStop > t.start ? s.lastStop : s.lastEventTs, "session-quiet"));
    }
    return out.filter(Boolean);
  }

  sig(t, sig) { if (t && !t.end) t.sw.push(sig); }

  apply(e) {
    if (this.seen.has(e.id)) return null; this.seen.add(e.id); this.count++;
    const s = this.session(e.session.id, e.session.project);
    if (e.provenance?.synthetic || e.source === "synthetic") s.synthetic = true;
    s.lastEventTs = e.ts;
    if (e.actor?.type === "main" || e.actor?.type === "human") s.lastMainTs = e.ts;
    const t = s.current && !s.current.end ? s.current : null;
    const ms = Date.parse(e.ts);
    const op = e.classification?.find((c) => c.scheme === "operation")?.value || null;

    const isMain = e.actor?.type === "main" || e.actor?.type === "human";
    switch (e.kind) {
      case "session.start": s.start = s.start || e.ts; if (e.payload?.model) this.setModel(s, e.payload.model, "observed", e.ts); break;
      case "session.end": {
        this.closeWait(s, t, ms); s.end = e.ts; s.endReason = e.payload?.reason || null;
        this.sig(t, { ts: e.ts, type: "turn.close", basis: "observed" });
        const reason = e.payload?.reason || "unknown";
        if (t) this.raise(e, "termination", `session ended (${reason}) with a task open`, s, QUIET_END_REASONS.has(reason));
        this.record(s, e, `session end · ${reason}`);
        break;
      }
      case "task.start": {
        s.explicitMarks = true;
        const id = e.task?.id || e.id;
        // A brief already inferred from the prompt (prompt.submit a moment before the mark) is the same task: adopt it.
        if (t && t.basis === "inferred" && t.toolCalls === 0 && ms - Date.parse(t.start) < 120e3) { t.id = id; t.title = e.task?.title || t.title; t.basis = "observed"; for (const a of s.agents.values()) if (a.taskId && !s.tasks.some((x) => x.id === a.taskId)) a.taskId = id; }
        else this.newTask(s, { id, title: e.task?.title, start: e.ts, basis: "observed" });
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
          this.closeWait(s, tt, ms);
          const workMs = tt.sw.totals(ms).activeMs;
          this.finishTask(s, tt, e.ts, "marked");
          this.predictions.onTaskEnd(e, tt, workMs);
          this.raise(e, "completed", `task complete · ${tt.title || tt.id}`, s);
          this.record(s, e, `task complete · ${tt.title || tt.id}`);
        }
        break;
      }
      case "task.pause": case "task.resume": {
        const tt = s.tasks.find((x) => x.id === e.task?.id) || t;
        this.sig(tt, { ts: e.ts, type: e.kind === "task.pause" ? "pause" : "resume", basis: "declared" });
        this.record(s, e, `${e.kind === "task.pause" ? "paused" : "resumed"}${e.payload?.reason ? " · " + String(e.payload.reason).slice(0, 40) : ""}`);
        break;
      }
      case "wait.begin": case "wait.end": { // declared external waits (CI, deploy queue, review) from marks
        const tt = s.tasks.find((x) => x.id === e.task?.id) || t;
        this.sig(tt, { ts: e.ts, type: e.kind, kind: e.payload?.kind || "external", key: e.payload?.key || null, basis: "declared" });
        this.record(s, e, `${e.kind === "wait.begin" ? "wait" : "wait over"} · ${e.payload?.kind || "external"}`);
        break;
      }
      case "prompt.submit": {
        s.prompts++; this.closeWait(s, t, ms); s.rateLimit = null;
        if (!s.explicitMarks) {
          const long = (e.payload?.promptLen || 0) >= this.opts.briefLength;
          const gap = s.lastStop ? ms - Date.parse(s.lastStop) : 0;
          if (!t || long || gap > this.opts.gapMs) { const nt = this.newTask(s, { id: `task_${e.id}`, title: null, start: e.ts, basis: "inferred", promptLen: e.payload?.promptLen ?? null }); nt.predictionAtStart = this.predict(nt, ms); }
        }
        const cur = s.current && !s.current.end ? s.current : null;
        if (cur) { cur.turns++; cur.promptLen = e.payload?.promptLen ?? null; this.sig(cur, { ts: e.ts, type: "wait.end", basis: "observed" }); this.sig(cur, { ts: e.ts, type: "turn.open", basis: "observed" }); }
        this.record(s, e, `prompt · ${e.payload?.promptLen != null ? e.payload.promptLen + " chars" : ""}`);
        break;
      }
      case "turn.stop":
        if (e.actor?.type === "subagent") break; // a subagent's stop is not the main turn ending
        s.stops++; s.lastStop = e.ts;
        if (t) { t.lastStop = e.ts; this.sig(t, { ts: e.ts, type: "turn.close", basis: e.provenance?.observed === false ? "inferred" : "observed" }); this.raise(e, "turn", "turn complete · back to you", s, true); }
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
      case "permission.request":
        this.openWait(s, t, "permission", e); this.sig(t, { ts: e.ts, type: "wait.begin", kind: "approval", basis: "observed" });
        break;
      case "permission.denied": this.record(s, e, `permission denied · ${e.payload?.tool || "?"}`); break;
      case "model.response": {
        if (e.actor?.type === "subagent") { const a = s.agents.get(e.actor.agentId); if (a && e.payload?.model) { a.model = e.payload.model; a.modelBasis = "observed"; } }
        else if (e.payload?.model) this.setModel(s, e.payload.model, "observed", e.ts);
        if (t && e.payload?.model) { const m = (t.models[e.payload.model] ||= { responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }); m.responses++; for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) m[k] += e.payload[k] || 0; }
        this.sig(t, { ts: e.ts, type: "activity", basis: "observed" });
        break;
      }
      case "model.switch": if (e.payload?.toModel) this.setModel(s, e.payload.toModel, "observed", e.ts); this.record(s, e, `model → ${e.payload?.toModel || "?"}`); break;
      case "context.compact": this.sig(t, { ts: e.ts, type: "activity", basis: "observed" }); if (e.payload?.phase !== "begin") this.record(s, e, `context compacted${e.payload?.trigger ? " · " + e.payload.trigger : ""}`); break;
      case "tool.call": s.openTools.set(e.parent?.toolUseId || e.id, e); if (e.payload?.tool === "AskUserQuestion") this.openWait(s, t, "question", e); break;
      case "tool.result": case "tool.failure": {
        s.openTools.delete(e.parent?.toolUseId);
        const dur = Math.max(0, e.durationMs || 0), began = ms - dur;
        const tool = e.payload?.tool;
        if (t) {
          const sub = e.actor?.type === "subagent";
          if (!sub && (e.payload?.ownerWaitMs != null || (OWNER_TOOLS.has(tool) && e.source !== "claude-transcript"))) {
            // the tool's own run time IS the owner answering (AskUserQuestion, plan approval)
            const w = e.payload?.ownerWaitMs ?? dur; const key = e.parent?.toolUseId || e.id;
            if (w > 0) { this.sig(t, { ts: ms - w, type: "wait.begin", kind: "question", key, basis: "observed" }); this.sig(t, { ts: ms, type: "wait.end", kind: "question", key, basis: "observed" }); }
          } else if (!sub && e.payload?.approvalWaitMs != null) {
            const key = e.parent?.toolUseId || e.id;
            if (e.payload.approvalWaitMs > 0) { this.sig(t, { ts: ms - e.payload.approvalWaitMs, type: "wait.begin", kind: "approval", key, basis: "inferred" }); this.sig(t, { ts: ms, type: "wait.end", kind: "approval", key, basis: "inferred" }); }
          } else {
            // duration_ms excludes permission time, so a pending approval ended when this tool began executing
            if (!sub) for (const k of ["approval", "rate_limit", "api_error"]) this.sig(t, { ts: began, type: "wait.end", kind: k, basis: "observed" });
            if (!sub) { this.sig(t, { ts: began, type: "turn.open", basis: "inferred" }); }
            this.sig(t, { ts: ms, sinceTs: began, type: "activity", basis: "observed" });
            if (sub) this.sig(t, { ts: ms, type: "span.touch", key: e.actor.agentId });
          }
        }
        if (s.waiting && s.waiting.kind === "permission" && e.actor.type !== "subagent") this.closeWait(s, t, ms);
        if (tool === "AskUserQuestion") this.closeWait(s, t, ms);
        if (!e.actor || e.actor.type !== "subagent") s.rateLimit = null;
        const failed = e.kind === "tool.failure" || e.payload?.failed === true;
        if (t) { t.toolCalls++; if (e.actor.type === "main") t.mainCalls++; if (failed) t.failures++; }
        if (failed) this.record(s, e, `tool failure · ${e.payload?.tool || "?"}${e.actor.agentId ? " · agent " + short(e.actor.agentId) : ""}`);
        const a = e.actor.agentId ? s.agents.get(e.actor.agentId) : null;
        if (a) { a.toolCalls++; a.lastSeen = e.ts; a.lastTool = e.payload?.tool || null; }
        if (op) this.pushOp(s, op);
        // The Agent tool's result carries the declared subagent type/model for the agent it spawned.
        if (e.payload?.tool === "Agent" && e.payload?.subagentType && e.parent?.toolUseId) {
          const ag = [...s.agents.values()].find((x) => x.parentToolUseId === e.parent.toolUseId);
          if (ag) { ag.type = ag.type || e.payload.subagentType; if (e.payload.subagentModel && !ag.model) { ag.model = e.payload.subagentModel; ag.modelBasis = "declared"; } }
        }
        break;
      }
      case "agent.start": {
        const a = { id: e.actor.agentId, type: e.actor.agentType || e.payload?.agentType || null, model: e.actor.model || null, modelBasis: e.actor.model ? (e.actor.modelConfidence || "declared") : "unknown", start: e.ts, end: null, parentToolUseId: e.parent?.toolUseId || null, parentAgentId: e.parent?.parentAgentId || null, toolCalls: 0, lastSeen: e.ts, lastTool: null, label: e.payload?.label || null, taskId: t?.id || null };
        s.agents.set(a.id, a); if (t) t.agents.push(a.id);
        this.sig(t, { ts: e.ts, type: "span.begin", key: a.id, basis: "observed" });
        if (REVIEW_AGENTS.has(a.type)) this.pushOp(s, "review");
        this.record(s, e, `agent start · ${a.type || "agent"}${a.model ? " · " + a.model : ""}`);
        break;
      }
      case "agent.stop": {
        const a = s.agents.get(e.actor.agentId);
        if (a && !a.end) { a.end = e.ts; a.lastSeen = e.ts; const tt = s.tasks.find((x) => x.id === a.taskId); if (tt) { tt.completedAgents++; this.sig(tt, { ts: e.ts, type: "span.end", key: a.id, basis: "observed" }); } }
        this.record(s, e, `agent done · ${a?.type || short(e.actor.agentId)}`);
        break;
      }
      case "notification": {
        const k = e.payload?.kind;
        if (k === "permission_prompt") { this.openWait(s, t, "permission", e); this.sig(t, { ts: e.ts, type: "wait.begin", kind: "approval", basis: "observed" }); this.raise(e, "permission", "permission required", s); }
        else if (k === "idle_prompt" || k === "idle") { this.openWait(s, t, "idle", e); this.sig(t, { ts: e.ts, type: "turn.close", basis: "inferred" }); } // no-op when the Stop was seen
        else if (k === "elicitation_dialog" || k === "elicitation_url_dialog" || k === "agent_needs_input") { this.sig(t, { ts: e.ts, type: "wait.begin", kind: "question", key: k, basis: "observed" }); this.record(s, e, `notification · ${k}`); }
        else if (k === "elicitation_complete" || k === "elicitation_response") { this.sig(t, { ts: e.ts, type: "wait.end", kind: "question", basis: "observed" }); this.record(s, e, `notification · ${k}`); }
        else if (k === "quota_auto_resume_fired") { this.sig(t, { ts: e.ts, type: "wait.end", kind: "rate_limit", basis: "observed" }); this.sig(t, { ts: e.ts, type: "turn.open", basis: "observed" }); s.rateLimit = null; this.record(s, e, "rate limit over · auto-resumed"); }
        else if (k) this.record(s, e, `notification · ${k}`);
        break;
      }
      case "test.run": {
        const ok = e.payload?.ok === true;
        if (t) { if (ok) t.testsPassed++; else t.testsFailed++; t.lastTestOk = ok; }
        // a marked/CLI test run is execution evidence over its reported duration
        if (e.source !== "claude-hooks") this.sig(t, { ts: ms, sinceTs: e.payload?.durationMs ? ms - e.payload.durationMs : ms, type: "activity", basis: "observed" });
        this.pushOp(s, "test");
        const total = (e.payload?.passed ?? 0) + (e.payload?.failed ?? 0);
        if (!ok) this.raise(e, "test-failure", `tests failed · ${e.payload?.failed ?? "?"} of ${total}`, s);
        this.record(s, e, `tests ${ok ? "pass" : "FAIL"} · ${e.payload?.passed ?? "?"} passed · ${e.payload?.failed ?? "?"} failed`);
        break;
      }
      case "git.commit": { if (this.dupCommit(s, e.payload?.hash)) break; if (t) t.commits++; this.pushOp(s, "commit"); this.sig(t, { ts: e.ts, type: "activity", basis: "observed" }); this.record(s, e, `commit · ${e.payload?.hash || ""} · ${e.payload?.files ?? "?"} files`); break; }
      default: break;
    }
    return s;
  }

  setModel(s, model, basis, ts) { if (typeof model !== "string" || model === "<synthetic>") return; s.model = model; s.modelBasis = basis; s.modelSince = ts; const t = s.current; if (t && !t.end && !t.modelAtStart) t.modelAtStart = model; }
  // The git poller (12 hex) and the v4 hook (up to 12 hex) can both report one commit: same commit when one hash is a prefix of the other.
  dupCommit(s, hash) {
    if (typeof hash !== "string" || !hash) return false;
    const h = hash.toLowerCase(); const seen = s.commitHashes || (s.commitHashes = []);
    for (const x of seen) if (x.startsWith(h) || h.startsWith(x)) return true;
    seen.push(h); if (seen.length > 500) seen.shift(); return false;
  }
  pushOp(s, op) { s.recentOps.push(op); if (s.recentOps.length > 8) s.recentOps.shift(); }
  openWait(s, t, kind, e) {
    if (s.waiting && s.waiting.kind === kind) return;
    if (s.waiting) this.closeWait(s, t, Date.parse(e.ts));
    s.waiting = { kind, since: e.ts }; if (t) { t.waits++; t.waitSince = e.ts; }
    this.record(s, e, `wait · ${kind}`);
  }
  closeWait(s, t, nowMs) {
    if (!s.waiting) return;
    const since = Date.parse(s.waiting.since);
    if (t && t.waitSince) { t.waitingMs += Math.max(0, nowMs - since); t.waitSince = null; }
    s.waiting = null;
  }
  record(s, e, text) { s.log.push({ ts: e.ts, kind: e.kind, text, actor: e.actor?.type, agentId: e.actor?.agentId || null, observed: e.provenance?.observed !== false }); if (s.log.length > this.opts.maxLog) s.log.shift(); }
  raise(e, kind, text, s, quiet = false) { this.alerts.push({ ts: e.ts, kind, text, session: s.id, project: s.project, quiet }); if (this.alerts.length > 200) this.alerts.shift(); }
  takeAlerts() { const a = this.alerts; this.alerts = []; return a; }

  // The session the board shows: the one with the most recent event, unless the caller pins one.
  focusSession(pinned = null) {
    if (pinned && this.sessions.has(pinned)) return pinned;
    let best = null; for (const s of this.sessions.values()) if (!best || (s.lastEventTs || "") > (best.lastEventTs || "")) best = s;
    return best?.id || null;
  }

  sessionList(nowMs) {
    return [...this.sessions.values()].map((s) => ({ id: s.id, project: s.project, lastEventTs: s.lastEventTs, status: sessionStatus(s, nowMs, this.opts), tasks: s.tasks.length, agents: [...s.agents.values()].filter((a) => !a.end).length, synthetic: s.synthetic }))
      .sort((a, b) => (b.lastEventTs || "").localeCompare(a.lastEventTs || ""));
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
    const elapsedMs = t ? endMs - Date.parse(t.start) : null;
    const estimate = t?.estimate || null;
    const eta = live && estimate ? this.predictions.etaFor(t, workMs) : null;
    const v2 = live ? this.predict(t, nowMs) : null;
    const swWaiting = live && sw.state === "waiting" ? { kind: sw.kind, since: new Date(sw.since).toISOString(), forMs: Math.max(0, nowMs - sw.since), basis: sw.basis } : null;
    const remainingCalls = estimate?.calls != null ? Math.max(0, estimate.calls - (t?.toolCalls || 0)) : null;
    const phase = swWaiting ? { word: "WAIT", basis: swWaiting.basis === "observed" ? "observed" : "inferred", note: `waiting · ${swWaiting.kind}` } : phaseOf(s, t, status, nowMs);
    const agents = [...s.agents.values()].map((a) => agentView(a, nowMs, this.opts));
    const running = agents.filter((a) => a.state !== "completed");
    const lastActor = lastActive(s, agents);
    const fouls = t ? t.failures + t.testsFailed : 0;
    return {
      session: { id: s.id, project: s.project, status, synthetic: s.synthetic, start: s.start, end: s.end, endReason: s.endReason, lastEventTs: s.lastEventTs, tasks: s.tasks.length },
      task: t ? { id: t.id, title: t.title, basis: t.basis, start: t.start, end: t.end, live, turns: t.turns, toolCalls: t.toolCalls, mainCalls: t.mainCalls, estimate, agents: t.agents.length, completedAgents: t.completedAgents } : null,
      home: t ? field(t.toolCalls, "observed", "completed tool calls in this task") : field(null, "unavailable", "no task observed"),
      guest: remainingCalls != null ? field(remainingCalls, "predicted", `declared estimate of ${estimate.calls} calls`) : field(null, "unavailable", "scope unknown · no declared estimate"),
      period: t ? field(Math.max(1, t.turns || 1), "observed", "turn within the task") : field(null, "unavailable", "no task"),
      phase: field(phase.word, phase.basis, phase.note),
      gameClock: t ? field(workMs, "observed", live ? (swWaiting ? `stopped · waiting (${swWaiting.kind})` : sw.state === "paused" ? "stopped · paused" : sw.state === "unknown" ? "stopped · no signal (unknown time not counted)" : "running · active time, waits excluded") : "final active time") : field(null, "unavailable", "no task"),
      stopwatch: sw ? { state: sw.state, kind: sw.kind, since: sw.since != null ? new Date(sw.since).toISOString() : null, basis: sw.basis, activeMs: sw.activeMs, observedActiveMs: sw.observedActiveMs, waitingMs: sw.waitingMs, byKind: sw.byKind, pausedMs: sw.pausedMs, unknownMs: sw.unknownMs, wallMs: sw.wallMs } : null,
      etaV2: v2 ? { ...v2, displayMin: v2.remaining?.p50 != null ? Math.ceil(v2.remaining.p50 / 60000) : null } : null,
      model: s.model ? field(s.model, s.modelBasis, "main thread · from transcript / session start") : field(null, "unavailable", "model not yet observed"),
      tokens: t ? tokenTotals(t.models) : null,
      rateLimit: s.rateLimit,
      elapsed: t ? field(elapsedMs, "observed", "wall time since task start") : field(null, "unavailable", "no task"),
      // v0.2: the shot clock shows the calibrated p50 of REMAINING active time (conditional on time already spent),
      // never a bare countdown; dark when the estimator has no basis ("insufficient data") or only a lower bound.
      shotClock: v2 && v2.remaining?.p50 != null ? field(v2.remaining.p50, "predicted", v2.note)
        : field(null, "unavailable", !t ? "no task" : !live ? "task finished" : v2?.state === "beyond-history" ? "beyond history · lower bound only" : v2?.note || "insufficient data"),
      eta,
      fouls: field(fouls, "observed", `${t?.failures || 0} tool failures · ${t?.testsFailed || 0} failed test runs`),
      bonus: fouls >= 5,
      timeouts: field(t ? t.waits : 0, "observed", "owner waits taken in this task"),
      // The stopwatch's wait (approval, question, owner, rate limit …) wins; the legacy notification wait remains for
      // sessions without an open task.
      waiting: swWaiting || (s.waiting ? { kind: s.waiting.kind, since: s.waiting.since, forMs: Math.max(0, nowMs - Date.parse(s.waiting.since)) } : null),
      verified: field(t ? t.testsPassed + t.commits : 0, "observed", `${t?.testsPassed || 0} passing test runs · ${t?.commits || 0} commits`),
      tests: t && t.lastTestOk != null ? field(t.lastTestOk ? "PASS" : "FAIL", "observed", "latest test run") : field(null, "unavailable", "no test runs observed"),
      player: field(running.length, "observed", lastActor ? lastActor.label : "no actor observed"),
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

export function field(value, basis, note = "") { return { value, basis, note }; }
function emptySnapshot(nowMs) {
  const u = field(null, "unavailable", "no session");
  return { session: null, task: null, home: u, guest: u, period: u, phase: field("IDLE", "observed", "no events"), gameClock: u, elapsed: u, shotClock: u, eta: null, stopwatch: null, etaV2: null, model: u, tokens: null, rateLimit: null, fouls: field(0, "observed", ""), bonus: false, timeouts: field(0, "observed", ""), waiting: null, verified: field(0, "observed", ""), tests: u, player: field(0, "observed", "no actor"), possession: null, lastActor: null, agents: [], openTools: 0, log: [], predictions: [], calibration: { n: 0, k: 1 }, now: nowMs };
}
function lastTask(s) { return s.tasks.length ? s.tasks[s.tasks.length - 1] : null; }
function short(id) { return String(id || "").slice(0, 8); }
function fmtEstimate(p) { if (!p) return ""; const parts = []; if (p.p50Min != null) parts.push(`${p.p50Min} min`); else if (p.minutes != null) parts.push(`${p.minutes} min`); if (p.p90Min != null) parts.push(`p90 ${p.p90Min}`); if (p.calls != null) parts.push(`${p.calls} calls`); return parts.join(" · "); }

export function tokenTotals(models = {}) {
  const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, responses: 0, byModel: models };
  for (const m of Object.values(models)) for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "responses"]) out[k] += m[k] || 0;
  return out;
}

// The completed-task record stored in the calibration ledger. Content-free: ids, names, counts, durations.
export function taskRecord(t, endMs) {
  const sw = t.sw.totals(endMs);
  return {
    schema: "alexandria.task/1", id: `${t.session}:${t.id}`, taskId: t.id, session: t.session, project: t.project, title: t.title, basis: t.basis,
    features: { type: t.type || null, model: t.modelAtStart || null, regime: t.basis === "observed" ? "marked" : "brief", size: t.size },
    declared: t.estimate ? { p50Min: t.estimate.p50Min ?? t.estimate.minutes ?? null, p90Min: t.estimate.p90Min ?? null, calls: t.estimate.calls ?? null } : null,
    startedAt: t.start, endedAt: t.end, endReason: t.endReason,
    actualActiveMs: sw.activeMs, observedActiveMs: sw.observedActiveMs, waitingMs: sw.waitingMs, waitByKind: sw.byKind, pausedMs: sw.pausedMs, unknownMs: sw.unknownMs, wallMs: sw.wallMs,
    actualCalls: t.toolCalls, mainCalls: t.mainCalls, turns: t.turns, agents: t.agents.length, failures: t.failures, testsPassed: t.testsPassed, testsFailed: t.testsFailed, commits: t.commits,
    tokens: tokenTotals(t.models),
    // A record calibrates future estimates only when work was observed in it (a brief that got no tool call and no
    // model response, or under 30 s of active time, measures nothing about task duration).
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
  if (s.end) return "ended";
  const since = s.lastEventTs ? nowMs - Date.parse(s.lastEventTs) : Infinity;
  if (since > staleSessionMs) return "stale";
  if (s.waiting) return "waiting";
  if (since > idleMs) return "idle";
  return "active";
}

// Phase word from recent operations (inferred). Facts override it: waiting → WAIT, no task → IDLE, ended → DONE.
export function phaseOf(s, t, status, nowMs) {
  if (!t) return { word: "IDLE", basis: "observed", note: "no task" };
  if (t.end) return { word: "DONE", basis: t.basis === "observed" ? "observed" : "inferred", note: t.basis === "observed" ? "task.end mark" : "last turn stopped" };
  if (s.waiting) return { word: "WAIT", basis: "observed", note: `waiting · ${s.waiting.kind}` };
  if (status === "idle" || status === "stale") return { word: "IDLE", basis: "observed", note: `no events for ${Math.round((nowMs - Date.parse(s.lastEventTs)) / 1000)} s` };
  const ops = s.recentOps.slice(-5);
  if (!ops.length) return { word: "PLAN", basis: "inferred", note: "no tool operations yet" };
  const last = OP_PHASE[ops[ops.length - 1]];
  if (last === "TEST" || last === "COMMIT" || last === "REVIEW") return { word: last, basis: "inferred", note: `last operation ${ops[ops.length - 1]}` };
  const tally = {}; for (const o of ops) { const w = OP_PHASE[o]; if (w) tally[w] = (tally[w] || 0) + 1; }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return { word: best ? best[0] : "BUILD", basis: "inferred", note: `recent operations: ${ops.join(", ")}` };
}

export function agentView(a, nowMs, { agentActiveMs }) {
  const sinceSeen = nowMs - Date.parse(a.lastSeen || a.start);
  const state = a.end ? "completed" : sinceSeen <= agentActiveMs ? "active" : "running";
  return { id: a.id, type: a.type, model: a.model, modelBasis: a.modelBasis, state, start: a.start, end: a.end, durationMs: Math.max(0, (a.end ? Date.parse(a.end) : nowMs) - Date.parse(a.start)), toolCalls: a.toolCalls, lastSeen: a.lastSeen, lastTool: a.lastTool, parentToolUseId: a.parentToolUseId, parentAgentId: a.parentAgentId, label: a.label, taskId: a.taskId };
}

function lastActive(s, agents) {
  const running = agents.filter((a) => !a.end).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  const mainTs = s.lastMainTs || "";
  if (running.length && (running[0].lastSeen || "") > mainTs) return { side: "guest", label: `${running[0].type || "agent"}${running[0].model ? " · " + running[0].model : ""}`, agentId: running[0].id, basis: "observed" };
  if (s.lastMainTs) return { side: "home", label: "main thread", agentId: null, basis: "observed" };
  return null;
}
