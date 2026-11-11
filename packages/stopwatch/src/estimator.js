// ETA estimator (Stopwatch & ETA v0.2). Pure and source-independent.
//
// Everything is in ACTIVE time (waits, pauses and unknown time excluded), because that is what the stopwatch
// measures and what history records.
//
// Inputs
//   features  { type, model, regime, size }   known at task start only (never outcome-derived: no tool mix, no
//             test results), so history and live tasks are described the same way
//   declared  { p50Min, p90Min, calls } | null   an estimate someone declared at the start
//   progress  { activeMs, calls }               observed so far
//   history   [{ id, features, declared, actualActiveMs, actualCalls, endedAt }]  completed tasks only, and the
//             caller is responsible for passing only tasks that ended BEFORE this one started (no leakage)
//
// Method (first that applies)
//   declared-calibrated  declared p50 × ratio samples r = actual / declared from comparable history
//   reference-class      actual active durations of comparable history tasks
//   prior                declared p50 × a fixed wide log-normal ratio band (no comparable history yet), low confidence
//   insufficient-data    nothing declared and too little history: no number is produced
// Comparable = the narrowest stratum with at least `minN` tasks, backing off:
//   type+model+regime → type+regime → type → regime → all
// Progress
//   remaining quantiles are taken from the samples still ABOVE the elapsed active time (the conditional
//   distribution), so the remaining estimate grows on heavy tails instead of counting down to zero. When fewer
//   than `minTail` samples exceed elapsed time the task is "beyond-history": a lower bound only, no p50.
//   With declared calls and enough calls done, the per-call pace of THIS task gives a second estimate of the
//   remaining time that is blended in (weight = share of declared calls done, at most 0.6).

export const ESTIMATOR_VERSION = "eta-0.2.0";

export const STRATA_VARIANTS = {
  base: [["type", "model", "regime"], ["type", "regime"], ["type"], ["regime"], []],
  size: [["type", "model", "regime"], ["type", "regime"], ["type"], ["size", "regime"], ["regime"], []],
  model: [["type", "model", "regime"], ["type", "regime"], ["type"], ["model", "regime"], ["regime"], []],
  sizeModel: [["type", "model", "regime"], ["type", "regime"], ["type"], ["size", "model", "regime"], ["size", "regime"], ["regime"], []],
};
const DEFAULTS = { minN: 6, minTail: 3, priorSigma: 0.75, callsBlendMax: 0.6, minCallsForPace: 5, highN: 30, mediumN: 12, strata: STRATA_VARIANTS.base };

export function estimate({ features = {}, declared = null, progress = {}, history = [], calibration = null, options = {} } = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined)) };
  const elapsedMs = Number.isFinite(progress.activeMs) ? Math.max(0, progress.activeMs) : 0;
  const p50Decl = num(declared?.p50Min ?? declared?.minutes);
  const done = history.filter((h) => Number.isFinite(h.actualActiveMs) && h.actualActiveMs > 0);

  let method, samples = null, stratum = null, n = 0;
  if (p50Decl != null && p50Decl > 0) {
    const withDecl = done.filter((h) => num(h.declared?.p50Min ?? h.declared?.minutes) > 0);
    const pick = pickStratum(withDecl, features, o.minN, o.strata);
    if (pick) {
      method = "declared-calibrated"; stratum = pick.stratum; n = pick.rows.length;
      samples = pick.rows.map((h) => p50Decl * 60000 * (h.actualActiveMs / (num(h.declared.p50Min ?? h.declared.minutes) * 60000)));
    } else {
      method = "prior"; n = withDecl.length;
      samples = lognormalGrid(p50Decl * 60000, o.priorSigma, 41);
    }
  } else {
    const pick = pickStratum(done, features, o.minN, o.strata);
    if (pick) { method = "reference-class"; stratum = pick.stratum; n = pick.rows.length; samples = pick.rows.map((h) => h.actualActiveMs); }
    else return { version: ESTIMATOR_VERSION, state: "insufficient-data", method: "none", n: done.length, need: o.minN, elapsedMs, remaining: null, total: null, confidence: "none", note: `no declared estimate and fewer than ${o.minN} comparable completed tasks` };
  }

  samples.sort((a, b) => a - b);
  const tail = samples.filter((s) => s > elapsedMs);
  let state = "estimating", remaining, total;
  if (tail.length >= o.minTail) {
    total = { p10: quantile(tail, 0.1), p50: quantile(tail, 0.5), p90: quantile(tail, 0.9) };
    remaining = { p10: total.p10 - elapsedMs, p50: total.p50 - elapsedMs, p90: total.p90 - elapsedMs };
  } else {
    state = "beyond-history"; total = { p10: null, p50: null, p90: null };
    remaining = { p10: 0, p50: null, p90: null };
  }

  // Pace blend from this task's own progress against declared calls.
  let pace = null;
  const calls = num(declared?.calls), doneCalls = progress.calls || 0;
  if (state === "estimating" && calls > 0 && doneCalls >= o.minCallsForPace && elapsedMs > 0) {
    const msPerCall = elapsedMs / doneCalls;
    const left = Math.max(0, calls - doneCalls) * msPerCall;
    const w = Math.min(o.callsBlendMax, doneCalls / calls);
    if (left > 0) {
      const blend = (q) => Math.exp((1 - w) * Math.log(Math.max(1, q)) + w * Math.log(left));
      remaining = { p10: blend(remaining.p10), p50: blend(remaining.p50), p90: blend(remaining.p90) }; // monotone in q: order kept
      total = { p10: elapsedMs + remaining.p10, p50: elapsedMs + remaining.p50, p90: elapsedMs + remaining.p90 };
      pace = { msPerCall: Math.round(msPerCall), callsLeft: Math.max(0, calls - doneCalls), weight: round2(w) };
    }
  }

  return {
    version: ESTIMATOR_VERSION, state, method, stratum, n, elapsedMs, remaining: roundQ(remaining), total: roundQ(total), pace,
    confidence: confidenceOf(method, n, calibration, o, total?.p10 > 0 && total?.p90 > 0 ? total.p90 / total.p10 : null),
    note: noteOf(method, stratum, n, state),
  };
}

// Confidence is earned, never asserted: sample size, measured interval coverage (the ranges have proven honest in
// backtests) AND a usefully narrow range (p90/p10 of the total). A calibrated but very wide range is "low".
export function confidenceOf(method, n, calibration, o = DEFAULTS, spread = null) {
  if (method === "none") return "none";
  if (method === "prior") return "low";
  const cov = calibration?.coverage80;
  const covOk = cov != null && calibration.n >= 10 && cov >= 0.65 && cov <= 0.95;
  if (spread == null || spread > 6) return "low";
  if (n >= o.highN && covOk && spread <= 3) return "high";
  if (n >= o.mediumN && covOk) return "medium";
  return "low";
}

export function pickStratum(rows, features, minN, strata = DEFAULTS.strata) {
  for (const keys of strata) {
    if (keys.some((k) => features[k] == null)) continue;
    const sel = rows.filter((h) => keys.every((k) => h.features?.[k] === features[k]));
    if (sel.length >= minN) return { stratum: keys.length ? keys.map((k) => `${k}=${features[k]}`).join(" ") : "all", rows: sel };
  }
  return null;
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Deterministic log-normal quantile grid around a median (used only for the labelled prior).
export function lognormalGrid(median, sigma, k) {
  const out = [];
  for (let i = 1; i <= k; i++) out.push(median * Math.exp(sigma * probit(i / (k + 1))));
  return out;
}
function probit(p) { // Acklam's rational approximation, |error| < 1.2e-9
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function noteOf(method, stratum, n, state) {
  const base = method === "declared-calibrated" ? `declared estimate calibrated on ${n} tasks (${stratum})`
    : method === "reference-class" ? `${n} comparable completed tasks (${stratum})`
    : method === "prior" ? `declared estimate with a wide default band (only ${n} calibrated tasks)` : "";
  return state === "beyond-history" ? `${base}; already longer than nearly all of them: lower bound only` : base;
}
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;
function roundQ(q) { if (!q) return q; const r = {}; for (const k of Object.keys(q)) r[k] = q[k] == null ? null : Math.max(0, Math.round(q[k])); return r; }
