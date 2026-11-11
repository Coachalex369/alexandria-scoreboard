// Stopwatch engine (Stopwatch & ETA v0.2). Pure, browser-safe, source-independent: it knows nothing about Claude
// Code, hooks or the Scoreboard. Adapters translate their sources into the generic signals below.
//
// A task's wall time is partitioned into segments, each with ONE state:
//   active             work is happening (an actor holds the turn, or there is direct evidence of execution)
//   waiting:<kind>     work is blocked on something outside the agent; never counted as active time
//                        approval   a permission decision is pending
//                        question   the agent asked the owner and waits for the answer
//                        owner      "owner" = the human user. The agent handed control back; the next move is theirs
//                        rate_limit the provider refused service until a reset
//                        api_error  the turn ended on a provider error; nothing runs until someone resumes it
//                        external   a declared external wait (CI run, deploy queue, human review)
//   paused             explicitly paused by a declared mark
//   unknown            the turn is open but nothing has been heard for longer than `stallMs`; not counted as active
//                      unless later evidence (an activity whose execution covers the gap) proves work happened
//
// Signals: { ts, type, kind?, key?, sinceTs?, basis?, actor? }   (ts / sinceTs: epoch ms or ISO strings)
//   start                  task begins; the turn is considered open from here
//   end                    task ends
//   turn.open              an actor starts working on the owner's request (a prompt, a resume)
//   turn.close             control returns to the owner (waiting:owner until the next turn.open)
//   activity               evidence of execution over [sinceTs ?? ts, ts] (a tool run with its duration, a commit)
//   span.begin / span.end  a keyed run that is active while open (a subagent); an open span lasts until the last
//                          evidence from it plus `stallMs`, so a lost stop never inflates the clock
//   wait.begin / wait.end  keyed by kind (wait.end without a kind closes every open wait)
//   pause / resume         declared pause
//
// Precedence on any instant (first match wins):
//   paused > rate_limit > api_error > approval > question > external > active(evidence) > owner > unknown(stall) > active(turn open)
// so that a declared or observed wait is never hidden by an inference, and direct evidence of work outranks the
// owner wait (background agents keep working while the owner is away).

export const WAIT_KINDS = ["approval", "question", "owner", "rate_limit", "api_error", "external"];
const RANK = { start: 0, end: 1, "turn.close": 1, "wait.end": 1, resume: 1, "span.end": 1, "turn.open": 2, "wait.begin": 2, pause: 2, "span.begin": 2, activity: 3, "span.touch": 3 };
const PRIORITY = ["paused", "rate_limit", "api_error", "approval", "question", "external", "evidence", "owner", "stall", "turn"];

export class Stopwatch {
  constructor({ stallMs = 10 * 60e3 } = {}) {
    this.stallMs = stallMs;
    this.signals = [];
    this.startMs = null; this.endMs = null;
  }

  push(sig) {
    const since = sig.sinceTs != null ? toMs(sig.sinceTs) : NaN;
    const s = { ...sig, ts: toMs(sig.ts), sinceTs: Number.isFinite(since) ? since : null, basis: sig.basis || "observed" };
    if (!Number.isFinite(s.ts)) return this;
    if (s.type === "start" && (this.startMs == null || s.ts < this.startMs)) this.startMs = s.ts;
    if (s.type === "end") this.endMs = this.endMs == null ? s.ts : Math.max(this.endMs, s.ts);
    this.signals.push(s);
    return this;
  }

  get started() { return this.startMs != null; }
  get ended() { return this.endMs != null; }

  // Layers of intervals [from, to, basis, kind] built from the signals, clipped to the task window.
  layers(nowMs) {
    const lo = this.startMs, hi = this.endMs != null ? this.endMs : nowMs;
    const L = Object.fromEntries(PRIORITY.map((p) => [p, []]));
    if (lo == null || hi <= lo) return { L, lo, hi };
    // Equal timestamps: closing signals before opening ones (a transition at one instant), so the result does not depend
    // on arrival order.
    const sigs = [...this.signals].sort((a, b) => a.ts - b.ts || RANK[a.type] - RANK[b.type]);
    // Turn layer: open from start until turn.close; reopened by turn.open. Closed time is the owner's.
    let open = true, openSince = lo, openBasis = "observed", closedSince = null, closedBasis = null;
    // Waits and pauses by key.
    const waits = new Map(); let pausedSince = null, pausedBasis = null;
    const spans = new Map(); // key -> { from, last, basis }
    // Things heard, for stall detection. A silence that ends at a boundary (a new turn.open or the task's end) rather
    // than at evidence of work is unknown for its whole length: nothing shows work happened in it.
    const evidence = [{ t: lo, boundary: false }];
    for (const s of sigs) {
      const t = clamp(s.ts, lo, hi);
      if (s.ts > hi) break;
      evidence.push({ t, boundary: s.type === "turn.open" || s.type === "end" });
      switch (s.type) {
        case "turn.open":
          if (!open) { if (closedSince != null) L.owner.push([closedSince, t, closedBasis]); open = true; openSince = t; openBasis = s.basis; closedSince = null; }
          break;
        case "turn.close":
          if (open) { L.turn.push([openSince, t, openBasis]); open = false; closedSince = t; closedBasis = s.basis; }
          break;
        case "activity": {
          const from = clamp(s.sinceTs ?? s.ts, lo, hi);
          if (t > from) L.evidence.push([from, t, s.basis]);
          if (s.sinceTs != null) evidence.push({ t: from, boundary: false });
          break;
        }
        case "span.begin": if (!spans.has(s.key ?? "_")) spans.set(s.key ?? "_", { from: t, last: t, basis: s.basis }); break;
        case "span.touch": { const sp = spans.get(s.key ?? "_"); if (sp) sp.last = Math.max(sp.last, t); break; }
        case "span.end": { const sp = spans.get(s.key ?? "_"); if (sp) { L.evidence.push([sp.from, t, sp.basis]); spans.delete(s.key ?? "_"); } break; }
        case "wait.begin": {
          const kind = WAIT_KINDS.includes(s.kind) ? s.kind : "external";
          const key = `${kind}:${s.key ?? ""}`;
          if (!waits.has(key)) waits.set(key, { kind, from: t, basis: s.basis });
          break;
        }
        case "wait.end": {
          for (const [key, w] of [...waits]) {
            if (s.kind && w.kind !== (WAIT_KINDS.includes(s.kind) ? s.kind : "external")) continue;
            if (s.key != null && key !== `${w.kind}:${s.key}`) continue;
            const end = Math.max(w.from, clamp(s.ts, lo, hi));
            L[w.kind === "owner" ? "owner" : w.kind].push([w.from, end, w.basis === "observed" && s.basis === "observed" ? "observed" : "inferred"]);
            waits.delete(key);
          }
          break;
        }
        case "pause": if (pausedSince == null) { pausedSince = t; pausedBasis = s.basis; } break;
        case "resume": if (pausedSince != null) { L.paused.push([pausedSince, t, pausedBasis]); pausedSince = null; } break;
        default: break;
      }
    }
    // Close whatever is still open at the window's end.
    if (open) L.turn.push([openSince, hi, openBasis]); else if (closedSince != null) L.owner.push([closedSince, hi, closedBasis]);
    for (const w of waits.values()) L[w.kind === "owner" ? "owner" : w.kind].push([w.from, hi, w.basis]);
    if (pausedSince != null) L.paused.push([pausedSince, hi, pausedBasis]);
    for (const sp of spans.values()) { const end = Math.min(hi, sp.last + this.stallMs); if (end > sp.from) L.evidence.push([sp.from, end, sp.basis]); }
    // Stall: inside an open turn, the part of any silence beyond stallMs is unknown (inferred).
    if (this.endMs == null) evidence.push({ t: hi, boundary: false }); // live: the open end is not a boundary yet
    evidence.sort((a, b) => a.t - b.t || (a.boundary ? 1 : 0) - (b.boundary ? 1 : 0));
    for (let i = 1; i < evidence.length; i++) {
      const gap = evidence[i].t - evidence[i - 1].t;
      if (gap > this.stallMs) L.stall.push([evidence[i].boundary ? evidence[i - 1].t : evidence[i - 1].t + this.stallMs, evidence[i].t, "inferred"]);
    }
    for (const k of PRIORITY) L[k] = mergeIntervals(L[k]);
    return { L, lo, hi };
  }

  // Segments covering [start, end || now] with state, kind and basis. Adjacent equal segments are merged.
  timeline(nowMs = Date.now()) {
    const { L, lo, hi } = this.layers(nowMs);
    if (lo == null || !(hi > lo)) return [];
    const points = new Set([lo, hi]);
    for (const k of PRIORITY) for (const [a, b] of L[k]) { points.add(a); points.add(b); }
    const pts = [...points].filter((p) => p >= lo && p <= hi).sort((a, b) => a - b);
    const idx = Object.fromEntries(PRIORITY.map((k) => [k, 0]));
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], mid = (a + b) / 2;
      let hit = null;
      for (const k of PRIORITY) {
        const arr = L[k]; let j = idx[k];
        while (j < arr.length && arr[j][1] <= mid) j++;
        idx[k] = j;
        if (j < arr.length && arr[j][0] <= mid && mid < arr[j][1]) { hit = { layer: k, basis: arr[j][2] }; break; }
      }
      // Instants covered by no layer cannot happen inside the window (turn/owner tile it), but stay safe.
      const seg = classify(hit, a, b);
      const prev = out[out.length - 1];
      if (prev && prev.state === seg.state && prev.kind === seg.kind && prev.basis === seg.basis && prev.to === a) prev.to = b;
      else out.push(seg);
    }
    return out;
  }

  totals(nowMs = Date.now()) {
    const segs = this.timeline(nowMs);
    const t = { activeMs: 0, waitingMs: 0, pausedMs: 0, unknownMs: 0, wallMs: 0, byKind: {}, observedActiveMs: 0 };
    for (const s of segs) {
      const d = s.to - s.from; t.wallMs += d;
      if (s.state === "active") { t.activeMs += d; if (s.basis === "observed") t.observedActiveMs += d; }
      else if (s.state === "waiting") { t.waitingMs += d; t.byKind[s.kind] = (t.byKind[s.kind] || 0) + d; }
      else if (s.state === "paused") t.pausedMs += d;
      else t.unknownMs += d;
    }
    const last = segs[segs.length - 1] || null;
    t.state = this.ended ? "ended" : last ? last.state : "not-started";
    t.kind = !this.ended && last ? last.kind : null;
    t.since = !this.ended && last ? last.from : null;
    t.basis = last ? last.basis : null;
    return t;
  }
}

function classify(hit, a, b) {
  if (!hit) return { from: a, to: b, state: "unknown", kind: null, basis: "inferred" };
  switch (hit.layer) {
    case "paused": return { from: a, to: b, state: "paused", kind: null, basis: hit.basis };
    case "evidence": case "turn": return { from: a, to: b, state: "active", kind: hit.layer, basis: hit.basis };
    case "stall": return { from: a, to: b, state: "unknown", kind: "stall", basis: "inferred" };
    default: return { from: a, to: b, state: "waiting", kind: hit.layer, basis: hit.basis };
  }
}

export function mergeIntervals(list) {
  const xs = list.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const iv of xs) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) { if (iv[1] > last[1]) last[1] = iv[1]; if (iv[2] !== last[2]) last[2] = "inferred"; }
    else out.push([iv[0], iv[1], iv[2]]);
  }
  return out;
}

export function toMs(v) { return typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : NaN; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
