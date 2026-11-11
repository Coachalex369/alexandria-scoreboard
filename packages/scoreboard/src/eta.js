// Prediction tracking (ETA method v0.2, docs/ETA_METHOD.md), pure and browser-safe.
// A prediction exists only when a task carries a DECLARED estimate (task.estimate). Nothing here invents one.
//   record: { taskId, session, project, title, estimatedAt, p50Min, p90Min, calls, k, etaMinApplied,
//             completedAt, actualWorkMin, actualCalls, errorRatio (estimate / actual), withinRange }
// bias k = exp(−median log(estimate/actual)) over the last 20 completed predictions, clamped [0.25, 4],
// identity until 3 samples (claude-load's rule, confirmed in the 10-task experiment).
// The ETA for an open task = p50 × k − elapsed work, floored at 0 with an overdue amount.
export class PredictionLog {
  constructor(history = []) { this.history = [...history]; this.open = new Map(); }

  onEstimate(e, task) {
    const p = e.payload || {};
    const rec = { taskId: task.id, session: e.session.id, project: e.session.project || null, title: task.title || null, estimatedAt: e.ts, p50Min: num(p.p50Min ?? p.minutes), p90Min: num(p.p90Min), calls: num(p.calls), k: this.biasK(), etaMinApplied: null, completedAt: null, actualWorkMin: null, actualCalls: null, errorRatio: null, withinRange: null, basis: "declared" };
    rec.etaMinApplied = rec.p50Min != null ? round1(rec.p50Min * rec.k) : null;
    this.history = this.history.filter((r) => !(r.taskId === task.id && r.session === rec.session && !r.completedAt));
    this.open.set(task.id, rec);
    this.history.push(rec);
    return rec;
  }

  onTaskEnd(e, task, workMs) {
    const rec = this.open.get(task.id); if (!rec) return null;
    rec.completedAt = e.ts; rec.actualWorkMin = round1(workMs / 60000); rec.actualCalls = task.toolCalls;
    if (rec.p50Min != null && rec.actualWorkMin > 0) rec.errorRatio = round2(rec.p50Min / rec.actualWorkMin);
    if (rec.p50Min != null && rec.actualWorkMin != null) { const lo = rec.p50Min * 0.4, hi = Math.max(rec.p90Min ?? 0, rec.p50Min); rec.withinRange = rec.actualWorkMin >= lo && rec.actualWorkMin <= hi; }
    this.open.delete(task.id);
    return rec;
  }

  completed() { return this.history.filter((r) => r.completedAt && r.errorRatio != null); }

  biasK() {
    const done = this.completed().slice(-20);
    if (done.length < 3) return 1;
    const logs = done.map((r) => Math.log(r.errorRatio)).sort((a, b) => a - b);
    const med = logs[Math.floor(logs.length / 2)];
    return clamp(Math.exp(-med), 0.25, 4);
  }

  // ETA for an open task from its declared estimate and the work time so far. The k applied at estimate time
  // is kept for the whole task (never re-calibrated mid-task).
  etaFor(task, workMs) {
    const est = task.estimate; if (!est) return null;
    const p50 = num(est.p50Min ?? est.minutes); if (p50 == null) return null;
    const rec = this.open.get(task.id); const k = rec ? rec.k : 1;
    const targetMs = p50 * k * 60000;
    const remainingMs = targetMs - workMs;
    const p90Ms = est.p90Min != null ? est.p90Min * k * 60000 : null;
    return { remainingMs: Math.max(0, remainingMs), overdueMs: Math.max(0, -remainingMs), targetMs, p90RemainingMs: p90Ms != null ? Math.max(0, p90Ms - workMs) : null, k, p50Min: p50, p90Min: num(est.p90Min), basis: "predicted", note: k === 1 ? `declared estimate ${p50} min${est.p90Min != null ? " · p90 " + est.p90Min : ""}` : `declared ${p50} min × bias ${k.toFixed(2)}` };
  }

  calibration() {
    const done = this.completed();
    if (!done.length) return { n: 0, k: 1, within2x: null, medianRatio: null };
    const ratios = done.map((r) => r.errorRatio).sort((a, b) => a - b);
    return { n: done.length, k: this.biasK(), within2x: done.filter((r) => r.errorRatio >= 0.5 && r.errorRatio <= 2).length, medianRatio: ratios[Math.floor(ratios.length / 2)] };
  }
}

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
