// Task segmentation and parent-child linking over a sorted event list. Browser-safe.
//
// Facts first: explicit task.start/task.end marks (from the `marks` source) define tasks exactly.
// Otherwise a task is INFERRED from prompt.submit → turn.stop boundaries: a prompt that carries a brief
// (payload.promptLen >= briefLength) or follows a long gap opens a new task; shorter prompts continue it.
// Agents are attached to the task whose window contains their start, and to the tool call that spawned them.
export function linkTasks(events, { briefLength = 300, gapMs = 2 * 3600e3 } = {}) {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const tasks = [];
  const bySession = new Map();
  const explicit = sorted.some((e) => e.kind === "task.start");

  for (const e of sorted) {
    const sid = e.session.id;
    const st = bySession.get(sid) || { current: null, lastStop: null };
    bySession.set(sid, st);
    if (explicit) {
      if (e.kind === "task.start") { st.current = { id: e.task?.id || e.id, title: e.task?.title || null, session: sid, start: e.ts, end: null, basis: "observed", events: [], agents: [], toolCalls: 0, waitingMs: 0 }; tasks.push(st.current); }
      if (e.kind === "task.end" && st.current && (!e.task?.id || e.task.id === st.current.id)) { st.current.end = e.ts; st.current.events.push(e); st.current = null; continue; }
    } else if (e.kind === "prompt.submit" && e.actor.type === "human") {
      const long = (e.payload?.promptLen || 0) >= briefLength;
      const gap = st.lastStop ? Date.parse(e.ts) - Date.parse(st.lastStop) : 0;
      if (!st.current || long || gap > gapMs) {
        if (st.current && !st.current.end) st.current.end = st.lastStop || e.ts;
        st.current = { id: `task_${e.id}`, title: e.task?.title || null, session: sid, start: e.ts, end: null, basis: "inferred", events: [], agents: [], toolCalls: 0, waitingMs: 0 };
        tasks.push(st.current);
      }
    }
    if (e.kind === "turn.stop") st.lastStop = e.ts;
    if (st.current) {
      st.current.events.push(e);
      if ((e.kind === "tool.result" || e.kind === "tool.failure") && e.actor.type === "main") st.current.toolCalls++;
      if (e.kind === "agent.start") st.current.agents.push({ id: e.actor.agentId, type: e.actor.agentType, model: e.actor.model, start: e.ts, end: null, parentToolUseId: e.parent?.toolUseId });
      if (e.kind === "agent.stop") { const a = st.current.agents.find((x) => x.id === e.actor.agentId); if (a) a.end = e.ts; }
    }
  }
  // close inferred tasks at the last stop or last event
  for (const st of bySession.values()) if (st.current && !st.current.end) st.current.end = st.lastStop || st.current.events[st.current.events.length - 1]?.ts || st.current.start;
  for (const t of tasks) {
    t.wallMs = Date.parse(t.end) - Date.parse(t.start);
    t.waitingMs = waitingMs(t.events);
    t.workMs = Math.max(0, t.wallMs - t.waitingMs);
  }
  return tasks;
}

// Waiting inside a task: time between a permission/ask notification (or an AskUserQuestion call) and the
// next main-thread activity. Facts only; a Scoreboard would also pause on external waits it knows about.
export function waitingMs(events) {
  let total = 0, since = null;
  for (const e of events) {
    const isAsk = e.kind === "tool.call" && e.payload?.tool === "AskUserQuestion";
    const isPerm = e.kind === "notification" && (e.payload?.kind === "permission_prompt" || e.payload?.kind === "idle_prompt");
    if ((isAsk || isPerm) && since == null) since = Date.parse(e.ts);
    else if (since != null && (e.kind === "tool.result" || e.kind === "prompt.submit") && e.actor.type !== "subagent") { total += Date.parse(e.ts) - since; since = null; }
  }
  return total;
}

// Tool-call pace statistics for a set of events (main thread only): median seconds per call and tool durations.
export function paceStats(events) {
  const results = events.filter((e) => (e.kind === "tool.result" || e.kind === "tool.failure") && e.actor.type === "main").sort((a, b) => a.ts.localeCompare(b.ts));
  const gaps = [];
  for (let i = 1; i < results.length; i++) { const g = Date.parse(results[i].ts) - Date.parse(results[i - 1].ts); if (g > 0 && g < 30 * 60e3) gaps.push(g); }
  const byTool = {};
  for (const r of results) if (r.durationMs != null) (byTool[r.payload?.tool || "?"] ||= []).push(r.durationMs);
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { calls: results.length, medianGapMs: med(gaps), toolMedianMs: Object.fromEntries(Object.entries(byTool).map(([k, v]) => [k, med(v)])) };
}
