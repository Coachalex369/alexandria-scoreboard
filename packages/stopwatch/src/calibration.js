// Calibration and evaluation (Stopwatch & ETA v0.2). Pure.
//
// Leakage rule: a prediction for task i may only use tasks that ENDED before task i STARTED. Tasks that overlap
// task i in time (concurrent sessions) are excluded from its training set as well, and an explicit hold-out set
// (the controlled evaluation) is never used for training anything.
//
// Each task is predicted at several checkpoints of its own active time (default 0 %, 25 %, 50 %, 75 % of the
// actual), the way the board would have shown it live. Metrics per checkpoint and overall:
//   n            predictions with a number (insufficient-data and beyond-history counted separately)
//   mdale        median |ln(predicted p50 total / actual)|          (0 = perfect; ln 2 = 0.69 = off by 2×)
//   within2x     share with predicted p50 total within [actual/2, actual×2]
//   coverage80   share of actuals inside the predicted [p10, p90] total (target 0.80)
//   bias         median ln(predicted / actual)  (> 0 = estimates too long)
//   sharpness    median p90/p10 ratio (lower = narrower ranges)
import { estimate } from "./estimator.js";

export const CHECKPOINTS = [0, 0.25, 0.5, 0.75];

export function evaluate(tasks, { checkpoints = CHECKPOINTS, holdout = new Set(), options = {}, calibration = null } = {}) {
  const rows = tasks.filter((t) => Number.isFinite(t.actualActiveMs) && t.actualActiveMs > 0 && t.startedAt && t.endedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const trainable = rows.filter((t) => !holdout.has(t.id));
  const preds = [];
  for (const t of rows) {
    const train = trainable.filter((h) => h.id !== t.id && h.endedAt < t.startedAt);
    for (const cp of checkpoints) {
      const elapsed = Math.round(t.actualActiveMs * cp);
      // Calls done at a checkpoint come only from the task's own recorded progress (t.callsAt[cp]); scaling the
      // final call count would leak the outcome into the pace estimate.
      const calls = t.callsAt?.[String(cp)] ?? 0;
      const est = estimate({ features: t.features || {}, declared: t.declared || null, progress: { activeMs: elapsed, calls }, history: train, calibration, options });
      preds.push({ id: t.id, checkpoint: cp, heldOut: holdout.has(t.id), trainN: train.length, method: est.method, state: est.state, stratum: est.stratum, n: est.n, confidence: est.confidence, actualMs: t.actualActiveMs, p10: est.total?.p10 ?? null, p50: est.total?.p50 ?? null, p90: est.total?.p90 ?? null });
    }
  }
  return { predictions: preds, metrics: metrics(preds), byCheckpoint: Object.fromEntries(checkpoints.map((cp) => [String(cp), metrics(preds.filter((p) => p.checkpoint === cp))])), byMethod: groupMetrics(preds, (p) => p.method) };
}

export function metrics(preds) {
  const scored = preds.filter((p) => p.p50 > 0 && p.actualMs > 0);
  const out = { total: preds.length, n: scored.length, insufficient: preds.filter((p) => p.state === "insufficient-data").length, beyondHistory: preds.filter((p) => p.state === "beyond-history").length };
  if (!scored.length) return { ...out, mdale: null, within2x: null, coverage80: null, bias: null, sharpness: null };
  const logs = scored.map((p) => Math.log(p.p50 / p.actualMs));
  const ranged = scored.filter((p) => p.p10 > 0 && p.p90 > 0);
  return {
    ...out,
    mdale: r3(median(logs.map(Math.abs))),
    within2x: r3(scored.filter((p) => p.p50 >= p.actualMs / 2 && p.p50 <= p.actualMs * 2).length / scored.length),
    coverage80: ranged.length ? r3(ranged.filter((p) => p.actualMs >= p.p10 && p.actualMs <= p.p90).length / ranged.length) : null,
    bias: r3(median(logs)),
    sharpness: ranged.length ? r3(median(ranged.map((p) => p.p90 / p.p10))) : null,
  };
}

function groupMetrics(preds, keyFn) { const g = {}; for (const p of preds) (g[keyFn(p)] ||= []).push(p); return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, metrics(v)])); }
export function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
