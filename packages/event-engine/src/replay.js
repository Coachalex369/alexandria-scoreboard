// Replays a sorted list of events on a scaled clock. Browser-safe (no Node imports); UI-independent.
// Listeners receive { event, index, total, elapsedMs, remainingEvents }. Supports pause/resume/seek/speed.
//
//   const r = new Replayer(events, { speed: 20 });
//   r.on("event", ({ event }) => ...); r.on("done", () => ...); r.start();
export class Replayer {
  constructor(events, { speed = 1, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.events = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    this.speed = speed;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.index = 0;
    this.listeners = { event: [], done: [], state: [] };
    this.state = "idle"; // idle | playing | paused | done
    this.timer = null;
    this.t0 = this.events.length ? Date.parse(this.events[0].ts) : 0; // recording time of the first event
    this.virtual = this.t0; // current position in recording time
    this.wallAnchor = null;
  }

  on(name, fn) { this.listeners[name].push(fn); return this; }
  emit(name, arg) { for (const fn of this.listeners[name]) fn(arg); }
  setState(s) { this.state = s; this.emit("state", s); }

  get duration() { return this.events.length ? Date.parse(this.events[this.events.length - 1].ts) - this.t0 : 0; }
  get position() { return this.virtual - this.t0; }

  start() { if (this.state === "playing") return; this.wallAnchor = this.now(); this.setState("playing"); this.schedule(); }
  pause() { if (this.state !== "playing") return; this.advanceVirtual(); this.clearTimer(this.timer); this.timer = null; this.setState("paused"); }
  resume() { if (this.state !== "paused") return; this.wallAnchor = this.now(); this.setState("playing"); this.schedule(); }
  setSpeed(speed) { this.advanceVirtual(); this.speed = speed; if (this.state === "playing") { this.clearTimer(this.timer); this.wallAnchor = this.now(); this.schedule(); } }

  // Jump to a recording offset (ms from the first event). Events before it are emitted immediately in order.
  seek(offsetMs) {
    const target = this.t0 + Math.max(0, offsetMs);
    if (target < this.virtual) { this.index = 0; }
    while (this.index < this.events.length && Date.parse(this.events[this.index].ts) <= target) this.deliver();
    this.virtual = target; this.wallAnchor = this.now();
    if (this.state === "playing") { this.clearTimer(this.timer); this.schedule(); }
  }

  advanceVirtual() { if (this.wallAnchor != null) { this.virtual += (this.now() - this.wallAnchor) * this.speed; this.wallAnchor = this.now(); } }

  deliver() {
    const event = this.events[this.index];
    this.emit("event", { event, index: this.index, total: this.events.length, elapsedMs: Date.parse(event.ts) - this.t0, remainingEvents: this.events.length - this.index - 1 });
    this.index++;
  }

  schedule() {
    if (this.index >= this.events.length) { this.setState("done"); this.emit("done", { total: this.events.length }); return; }
    this.advanceVirtual();
    const next = Date.parse(this.events[this.index].ts);
    const waitMs = Math.max(0, (next - this.virtual) / this.speed);
    this.timer = this.setTimer(() => {
      this.advanceVirtual();
      while (this.index < this.events.length && Date.parse(this.events[this.index].ts) <= this.virtual) this.deliver();
      this.schedule();
    }, waitMs);
  }

  // Synchronous full replay (tests, batch analysis): emits everything in order, no timers.
  drain() { while (this.index < this.events.length) this.deliver(); this.setState("done"); this.emit("done", { total: this.events.length }); }
}

// Tracks live state from an event stream: sessions, open tasks, running tools, agents, waits.
// This is the shared model every experience (Scoreboard, workflow views) reads.
export class LiveState {
  constructor() { this.sessions = new Map(); }
  session(id, project) {
    if (!this.sessions.has(id)) this.sessions.set(id, { id, project, tasks: new Map(), agents: new Map(), openTools: new Map(), waiting: null, lastEventTs: null, toolCalls: 0, stops: 0 });
    return this.sessions.get(id);
  }
  apply(e) {
    const s = this.session(e.session.id, e.session.project);
    s.lastEventTs = e.ts;
    switch (e.kind) {
      case "task.start": s.tasks.set(e.task?.id || e.id, { id: e.task?.id || e.id, title: e.task?.title, start: e.ts, end: null, estimate: null, toolCalls: 0 }); break;
      case "task.estimate": { const t = s.tasks.get(e.task?.id); if (t) t.estimate = e.payload; break; }
      case "task.end": { const t = s.tasks.get(e.task?.id); if (t) t.end = e.ts; break; }
      case "tool.call": s.openTools.set(e.parent?.toolUseId || e.id, e); break;
      case "tool.result": case "tool.failure": {
        s.openTools.delete(e.parent?.toolUseId); s.toolCalls++;
        if (e.actor.type === "main") for (const t of s.tasks.values()) if (!t.end) t.toolCalls++;
        if (e.actor.agentId && s.agents.has(e.actor.agentId)) s.agents.get(e.actor.agentId).toolCalls++;
        if (s.waiting && s.waiting.kind === "permission") s.waiting = null;
        break;
      }
      case "agent.start": s.agents.set(e.actor.agentId, { id: e.actor.agentId, type: e.actor.agentType, model: e.actor.model, start: e.ts, end: null, parentToolUseId: e.parent?.toolUseId, toolCalls: 0 }); break;
      case "agent.stop": { const a = s.agents.get(e.actor.agentId); if (a) a.end = e.ts; break; }
      case "notification": if (e.payload?.kind === "permission_prompt" || e.payload?.kind === "idle_prompt") s.waiting = { kind: e.payload.kind === "permission_prompt" ? "permission" : "idle", since: e.ts }; break;
      case "prompt.submit": s.waiting = null; break;
      case "turn.stop": s.stops++; break;
      default: break;
    }
    return s;
  }
  runningAgents(sessionId) { const s = this.sessions.get(sessionId); return s ? [...s.agents.values()].filter((a) => !a.end) : []; }
  openTasks(sessionId) { const s = this.sessions.get(sessionId); return s ? [...s.tasks.values()].filter((t) => !t.end) : []; }
}
