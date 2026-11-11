#!/usr/bin/env node
// Calibration store tooling for Stopwatch & ETA v0.2.
//
//   node tools/sb-calibrate.js backfill [--since 2026-10-01]   rebuild completed task records from transcripts
//   node tools/sb-calibrate.js evaluate [--json]                rolling-origin backtest → calibration.json
//   node tools/sb-calibrate.js summary                          counts of the calibration store
//
// backfill runs every transcript (full mode) through the SAME Board the live view uses, so a historical task and a
// live task are measured with the same rules (owner time after Stop excluded, approvals/questions/rate limits
// excluded, stall rule). Only content-free records are written (ids, project names, counts, durations, models).
// evaluate never trains on a task that overlaps or follows the one being predicted, and never trains on the
// controlled-evaluation hold-out set (data dir eval/holdout.json).
import fs from "node:fs";
import path from "node:path";
import { readAllTranscripts } from "../packages/event-engine/src/adapters/claudeTranscript.js";
import { Board } from "../packages/scoreboard/src/board.js";
import { Ledger } from "../packages/scoreboard/src/ledger.js";
import { defaultDataDir } from "../packages/scoreboard/server.js";
import { evaluate } from "../packages/stopwatch/src/calibration.js";
import { ESTIMATOR_VERSION } from "../packages/stopwatch/src/estimator.js";
import { Stopwatch } from "../packages/stopwatch/src/stopwatch.js";
import { tokenTotals } from "../packages/scoreboard/src/board.js";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const cmd = argv[0];
const dataDir = flag("data", defaultDataDir());
const ledger = new Ledger(dataDir);

export function backfillRecords({ since = null, projectsDir, nowMs = Date.now() } = {}) {
  const all = [];
  let sessions = 0;
  for (const s of readAllTranscripts(projectsDir, { since })) { sessions++; all.push(...s.events); }
  all.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const records = [];
  const board = new Board({ onTaskComplete: (r) => records.push({ ...r, source: "transcript-backfill" }) });
  for (const e of all) board.apply(e);
  board.finalizeStale(nowMs);
  const agents = subagentRecords(all);
  return { records: [...records, ...agents, ...experimentRecords()], sessions, events: all.length, agents: agents.length };
}

// One record per finished subagent run (regime "subagent"): its own stopwatch over its tool executions and model
// responses, the observed model, the declared agent type. Used as the reference class for delegated work.
export function subagentRecords(events, { stallMs = 10 * 60e3 } = {}) {
  const runs = new Map();
  for (const e of events) {
    const id = e.actor?.type === "subagent" ? e.actor.agentId : null; if (!id) continue;
    const key = `${e.session.id}:agent:${id}`;
    const r = runs.get(key) || runs.set(key, { key, session: e.session.id, project: e.session.project, agentId: id, start: null, stop: null, type: null, model: null, calls: 0, sigs: [], models: {} }).get(key);
    if (e.kind === "agent.start") { r.start = e.ts; r.type = e.payload?.agentType || e.actor.agentType || null; r.model = e.payload?.model || e.actor.model || null; }
    else if (e.kind === "agent.stop") r.stop = e.ts;
    else if (e.kind === "tool.result" || e.kind === "tool.failure") { r.calls++; const t = Date.parse(e.ts); r.sigs.push({ ts: t, sinceTs: t - (e.durationMs || 0), type: "activity" }); }
    else if (e.kind === "model.response") { r.sigs.push({ ts: Date.parse(e.ts), type: "activity" }); const m = (r.models[e.payload.model] ||= { responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }); m.responses++; for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) m[k] += e.payload[k] || 0; if (!r.model) r.model = e.payload.model; }
  }
  const out = [];
  for (const r of runs.values()) {
    if (!r.start || !r.stop) continue; // unfinished runs are not outcomes
    const sw = new Stopwatch({ stallMs }); sw.push({ ts: r.start, type: "start" }); for (const x of r.sigs) sw.push(x); sw.push({ ts: r.stop, type: "end" });
    const t = sw.totals(Date.parse(r.stop));
    out.push({ schema: "alexandria.task/1", id: r.key, taskId: `agent:${r.agentId}`, session: r.session, project: r.project, title: null, basis: "observed",
      features: { type: r.type, model: r.model, regime: "subagent", size: null }, declared: null, startedAt: r.start, endedAt: r.stop, endReason: "agent-stop",
      actualActiveMs: t.activeMs, observedActiveMs: t.observedActiveMs, waitingMs: t.waitingMs, waitByKind: t.byKind, pausedMs: 0, unknownMs: t.unknownMs, wallMs: t.wallMs,
      actualCalls: r.calls, tokens: tokenTotals(r.models), calibratable: r.calls > 0 && t.activeMs >= 5e3, source: "transcript-backfill", estimatorVersion: ESTIMATOR_VERSION });
  }
  return out;
}

// The ten live tasks of the 2026-11-08 experiment: the only history with a DECLARED estimate next to the actual
// (measured then as wall time minus owner waits). Labelled with their own source.
export function experimentRecords(file = path.join(ROOT, "research", "data", "experiment_results.json")) {
  let rows = []; try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  return rows.filter((x) => x.done && x.workMin > 0 && x.est_raw > 0).map((x) => ({
    schema: "alexandria.task/1", id: `exp-2026-11-08:T${x.id}`, taskId: `T${x.id}`, session: "experiment-2026-11-08", project: x.project, title: null, basis: "observed",
    features: { type: String(x.category || "").split("/")[0].toLowerCase() || null, model: "claude-fable-5-1", regime: "marked", size: null },
    declared: { p50Min: x.est_raw, p90Min: x.est_hi ?? null, calls: null }, startedAt: x.start, endedAt: x.end, endReason: "marked",
    actualActiveMs: Math.round(x.workMin * 60000), waitingMs: Math.round((x.waitingMin || 0) * 60000), actualCalls: (x.mainToolCalls || 0) + (x.subagentToolCalls || 0),
    calibratable: true, source: "experiment-2026-11-08", measuredWith: "wall minus owner waits (v0.1 rule)", estimatorVersion: ESTIMATOR_VERSION,
  }));
}

export function loadHoldout(dir = dataDir) { try { return new Set(JSON.parse(fs.readFileSync(path.join(dir, "eval", "holdout.json"), "utf8")).ids || []); } catch { return new Set(); } }

export function runEvaluation(history, holdout) {
  const byRegime = {};
  for (const regime of ["brief", "subagent", "marked"]) { const h = history.filter((r) => r.features?.regime === regime); if (h.length) { const ev = evaluate(h, { holdout }); byRegime[regime] = { tasks: h.length, byCheckpoint: ev.byCheckpoint, byMethod: ev.byMethod }; } }
  const main = evaluate(history, { holdout });
  // Baseline: one global reference class, no strata, same leakage rules (what v0.2's strata must beat).
  const flat = history.map((t) => ({ ...t, features: {} }));
  const baseline = evaluate(flat, { holdout });
  return { at: new Date().toISOString(), estimatorVersion: ESTIMATOR_VERSION, tasks: history.length, heldOut: holdout.size,
    overall: main.metrics, byCheckpoint: main.byCheckpoint, byMethod: main.byMethod, byRegime,
    baseline: { overall: baseline.metrics, byCheckpoint: baseline.byCheckpoint },
    heldOutMetrics: Object.fromEntries(Object.entries(groupBy(main.predictions.filter((p) => p.heldOut), (p) => String(p.checkpoint))).map(([k, v]) => [k, summarize(v)])) };
}

function groupBy(xs, f) { const g = {}; for (const x of xs) (g[f(x)] ||= []).push(x); return g; }
function summarize(preds) { return { n: preds.length, predictions: preds.map((p) => ({ id: p.id, method: p.method, state: p.state, p10: p.p10, p50: p.p50, p90: p.p90, actualMs: p.actualMs })) }; }
const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const fx = (v) => (v == null ? "–" : v.toFixed(2));

async function main() {
  if (cmd === "backfill") {
    const t0 = Date.now();
    const { records, sessions, events } = backfillRecords({ since: flag("since") });
    ledger.writeBackfill(records);
    console.log(`backfill: ${sessions} sessions · ${events} events · ${records.length} records (incl. subagent runs and the 2026-11-08 experiment) → ${ledger.backfillFile} (${Date.now() - t0} ms)`);
    return;
  }
  if (cmd === "evaluate") {
    const history = ledger.history(); const holdout = loadHoldout();
    const r = runEvaluation(history, holdout); r.excludedNoWork = ledger.allRecords().length - history.length;
    ledger.writeCalibration(r);
    if (flag("json")) { console.log(JSON.stringify(r, null, 1)); return; }
    console.log(`evaluation · ${r.tasks} tasks (${r.heldOut} held out, ${r.excludedNoWork} excluded: no observed work) · ${r.estimatorVersion}`);
    console.log("checkpoint   n   insuff  beyond  MdALE  within2x  cover80  bias   sharp | baseline MdALE within2x cover80");
    for (const [cp, m] of Object.entries(r.byCheckpoint)) { const b = r.baseline.byCheckpoint[cp]; console.log(`${(Number(cp) * 100 + "%").padEnd(10)} ${String(m.n).padStart(4)} ${String(m.insufficient).padStart(6)} ${String(m.beyondHistory).padStart(7)}  ${fx(m.mdale).padStart(5)}  ${pct(m.within2x).padStart(7)}  ${pct(m.coverage80).padStart(7)}  ${fx(m.bias).padStart(5)}  ${fx(m.sharpness).padStart(5)} | ${fx(b.mdale).padStart(5)}  ${pct(b.within2x).padStart(7)}  ${pct(b.coverage80).padStart(7)}`); }
    for (const [rg, v] of Object.entries(r.byRegime)) { const m = v.byCheckpoint["0"]; console.log(`regime ${rg.padEnd(9)} tasks ${v.tasks} · at start: n ${m.n} MdALE ${fx(m.mdale)} within2x ${pct(m.within2x)} cover80 ${pct(m.coverage80)}`); }
    console.log(`→ ${ledger.calibrationFile}`);
    return;
  }
  if (cmd === "summary") {
    const h = ledger.history();
    const by = (f) => Object.entries(groupBy(h, f)).map(([k, v]) => `${k}:${v.length}`).join("  ");
    console.log(`history ${h.length} (live ${ledger.liveRecords().length}, backfill ${ledger.backfillRecords().length})\nregime  ${by((r) => r.features?.regime)}\nsize    ${by((r) => r.features?.size)}\nmodel   ${by((r) => r.features?.model)}`);
    return;
  }
  console.error("usage: sb-calibrate backfill [--since ISO] | evaluate [--json] | summary   (--data <dir> to override the data directory)");
  process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("tools", "sb-calibrate.js"))) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
