#!/usr/bin/env node
// Controlled evaluation harness for Stopwatch & ETA v0.2.
//
//   node tools/sb-eval.js register <runId>      pre-register the run's predictions (BEFORE launching it); prints the
//                                               agent description to use: "eval:<runId>"
//   node tools/sb-eval.js collect [--session S] read finished eval runs from this session's subagent transcripts
//   node tools/sb-eval.js quality <runId> <0-3> [note]   record the reviewed quality score of a run
//   node tools/sb-eval.js score [--json]        compare predictions with outcomes; repeat spread; per model
//
// Predictions are computed from the calibration store as it was at registration (history that ended before the run
// was registered; evaluation runs are added to the hold-out set so they never train anything). Three predictors:
//   declared-raw        The agent's declared p50 / p90 from eval/tasks.json, uncorrected
//   v02-declared        the v0.2 estimator given the declared estimate (calibrated by declared-vs-actual history)
//   v02-reference       the v0.2 estimator without a declaration (reference class of past subagent runs)
// Outcomes come only from the run's own transcript: agent start/stop, tool executions, model responses with token
// counts. Nothing is typed in by hand except the quality score, which is a reviewed judgement and labelled as such.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimate, ESTIMATOR_VERSION } from "../packages/stopwatch/src/estimator.js";
import { Ledger, readJsonl, writeAtomic } from "../packages/scoreboard/src/ledger.js";
import { defaultDataDir } from "../packages/scoreboard/server.js";
import { findTranscript, listSubagents, parseSubagentTranscript } from "../packages/event-engine/src/adapters/claudeTranscript.js";
import { subagentRecords } from "./sb-calibrate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const dataDir = flag("data", defaultDataDir());
const evalDir = path.join(dataDir, "eval"); fs.mkdirSync(evalDir, { recursive: true });
const F = { runs: path.join(evalDir, "runs.jsonl"), results: path.join(evalDir, "results.jsonl"), quality: path.join(evalDir, "quality.json"), holdout: path.join(evalDir, "holdout.json"), report: path.join(evalDir, "report.json") };
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "tasks.json"), "utf8"));
const MODEL_IDS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

export function predictionsFor(task, model, history, nowIso) {
  const past = history.filter((h) => h.endedAt && h.endedAt < nowIso && h.calibratable !== false);
  const features = { type: task.agent, model: MODEL_IDS[model] || model, regime: "subagent", size: null };
  const slim = (e) => ({ method: e.method, state: e.state, stratum: e.stratum || null, n: e.n, confidence: e.confidence, p10: e.total?.p10 ?? null, p50: e.total?.p50 ?? null, p90: e.total?.p90 ?? null });
  const d = task.declared;
  return {
    "declared-raw": { method: "declared-raw", state: "estimating", n: 0, confidence: "declared", p10: null, p50: d.p50Min * 60000, p90: d.p90Min != null ? d.p90Min * 60000 : null },
    "v02-declared": slim(estimate({ features, declared: { p50Min: d.p50Min, p90Min: d.p90Min }, progress: { activeMs: 0 }, history: past })),
    "v02-reference": slim(estimate({ features, declared: null, progress: { activeMs: 0 }, history: past })),
    features,
  };
}

function register(runId) {
  const plan = spec.plan.find((p) => p.run === runId); if (!plan) throw new Error(`unknown run ${runId}`);
  if (readJsonl(F.runs).some((r) => r.runId === runId)) throw new Error(`${runId} already registered`);
  const task = spec.tasks.find((t) => t.id === plan.task);
  const ledger = new Ledger(dataDir); const now = new Date().toISOString();
  const holdout = new Set(readJson(F.holdout, { ids: [] }).ids);
  const history = ledger.history().filter((h) => !holdout.has(h.id));
  const rec = { runId, task: task.id, type: task.type, agent: task.agent, model: plan.model, why: plan.why || null, registeredAt: now, estimatorVersion: ESTIMATOR_VERSION, historyN: history.length, declared: task.declared, predictions: predictionsFor(task, plan.model, history, now) };
  fs.appendFileSync(F.runs, JSON.stringify(rec) + "\n");
  console.log(`registered ${runId} · use description "eval:${runId}" · subagent_type ${task.agent} · model ${plan.model}`);
  for (const [k, p] of Object.entries(rec.predictions)) if (k !== "features") console.log(`  ${k.padEnd(14)} ${p.state.padEnd(17)} p50 ${p.p50 != null ? (p.p50 / 60000).toFixed(1) : "–"} min  [${p.p10 != null ? (p.p10 / 60000).toFixed(1) : "–"}, ${p.p90 != null ? (p.p90 / 60000).toFixed(1) : "–"}]  ${p.method} n=${p.n} ${p.stratum || ""}`);
}

// Finished eval runs in a session's subagent files → outcome records (and their agent ids join the hold-out set).
function collect() {
  const sid = flag("session", process.env.CLAUDE_CODE_SESSION_ID);
  if (!sid) throw new Error("--session <id> required (or run inside the Claude Code session that launched the runs)");
  const tx = findTranscript(sid); if (!tx) throw new Error(`no transcript for session ${sid}`);
  const runs = readJsonl(F.runs); const have = new Set(readJsonl(F.results).map((r) => r.runId));
  const holdout = readJson(F.holdout, { ids: [] });
  let added = 0;
  for (const sub of listSubagents(tx)) {
    const m = /^eval:([A-Za-z0-9-]+)$/.exec(sub.meta?.description || ""); if (!m) continue;
    const runId = m[1]; const reg = runs.find((r) => r.runId === runId); if (!reg || have.has(runId)) continue;
    const events = parseSubagentTranscript(fs.readFileSync(sub.file, "utf8"), { sessionId: sid, agentId: sub.agentId, meta: sub.meta, file: path.basename(sub.file), mode: "full" });
    const [rec] = subagentRecords(events); if (!rec) { console.log(`${runId}: not finished yet`); continue; }
    if (rec.startedAt < reg.registeredAt) { console.log(`${runId}: started before registration, rejected`); continue; }
    const result = { runId, task: reg.task, model: reg.model, observedModel: rec.features.model, agentId: sub.agentId, startedAt: rec.startedAt, endedAt: rec.endedAt, wallMs: rec.wallMs, activeMs: rec.actualActiveMs, unknownMs: rec.unknownMs, waitingMs: rec.waitingMs, calls: rec.actualCalls, tokens: rec.tokens, recordId: rec.id };
    fs.appendFileSync(F.results, JSON.stringify(result) + "\n"); have.add(runId); added++;
    if (!holdout.ids.includes(rec.id)) holdout.ids.push(rec.id);
    console.log(`${runId}: ${(rec.actualActiveMs / 60000).toFixed(1)} min active · ${rec.actualCalls} calls · ${rec.features.model} · out ${rec.tokens.outputTokens} tok`);
  }
  writeAtomic(F.holdout, JSON.stringify(holdout));
  console.log(`collected ${added} new · ${have.size} total · hold-out ${holdout.ids.length}`);
}

export function scoreRuns(runs, results, quality) {
  const rows = [];
  for (const r of results) {
    const reg = runs.find((x) => x.runId === r.runId); if (!reg) continue;
    const row = { runId: r.runId, task: r.task, model: r.model, observedModel: r.observedModel, activeMin: r.activeMs / 60000, wallMin: r.wallMs / 60000, calls: r.calls, outTokens: r.tokens?.outputTokens ?? null, inTokens: (r.tokens?.inputTokens ?? 0) + (r.tokens?.cacheReadTokens ?? 0) + (r.tokens?.cacheWriteTokens ?? 0), quality: quality[r.runId]?.score ?? null, predictions: {} };
    for (const [k, p] of Object.entries(reg.predictions)) {
      if (k === "features") continue;
      row.predictions[k] = { state: p.state, p50Min: p.p50 != null ? p.p50 / 60000 : null, logErr: p.p50 > 0 && r.activeMs > 0 ? Math.log(p.p50 / r.activeMs) : null, inRange: p.p10 != null && p.p90 != null ? r.activeMs >= p.p10 && r.activeMs <= p.p90 : null, belowP90: p.p90 != null ? r.activeMs <= p.p90 : null };
    }
    rows.push(row);
  }
  const methods = ["declared-raw", "v02-declared", "v02-reference"];
  const agg = {};
  for (const k of methods) {
    const ps = rows.map((r) => r.predictions[k]).filter(Boolean); const scored = ps.filter((p) => p.logErr != null);
    agg[k] = { runs: ps.length, scored: scored.length, insufficient: ps.filter((p) => p.state === "insufficient-data").length, mdale: med(scored.map((p) => Math.abs(p.logErr))), bias: med(scored.map((p) => p.logErr)), within2x: scored.length ? scored.filter((p) => Math.abs(p.logErr) <= Math.log(2)).length / scored.length : null, coverage80: rate(ps.map((p) => p.inRange)), belowP90: rate(ps.map((p) => p.belowP90)) };
  }
  const repeats = {};
  for (const r of rows) (repeats[`${r.task}/${r.model}`] ||= []).push(r);
  const spread = Object.fromEntries(Object.entries(repeats).filter(([, v]) => v.length > 1).map(([k, v]) => [k, { n: v.length, activeMin: v.map((x) => round(x.activeMin)), calls: v.map((x) => x.calls), maxOverMin: round(Math.max(...v.map((x) => x.activeMin)) / Math.max(1e-9, Math.min(...v.map((x) => x.activeMin)))), quality: v.map((x) => x.quality) }]));
  const byModel = {};
  for (const r of rows) { const g = (byModel[r.model] ||= { runs: 0, activeMin: [], calls: [], outTokens: [], quality: [] }); g.runs++; g.activeMin.push(r.activeMin); g.calls.push(r.calls); if (r.outTokens != null) g.outTokens.push(r.outTokens); if (r.quality != null) g.quality.push(r.quality); }
  for (const g of Object.values(byModel)) { g.medianActiveMin = round(med(g.activeMin)); g.medianCalls = med(g.calls); g.medianOutTokens = med(g.outTokens); g.meanQuality = g.quality.length ? round(g.quality.reduce((a, b) => a + b, 0) / g.quality.length) : null; }
  return { rows, aggregate: agg, repeats: spread, byModel };
}
const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rate = (bs) => { const v = bs.filter((b) => b != null); return v.length ? v.filter(Boolean).length / v.length : null; };
const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

function score() {
  const r = scoreRuns(readJsonl(F.runs), readJsonl(F.results), readJson(F.quality, {}));
  r.at = new Date().toISOString(); writeAtomic(F.report, JSON.stringify(r, null, 1));
  if (flag("json")) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log("run              model   active  calls  out-tok  q | declared-raw p50 err | v02-declared p50 err range | v02-reference p50 err range");
  for (const x of r.rows) { const f = (p) => (p.p50Min == null ? `${p.state}`.padEnd(22) : `${p.p50Min.toFixed(1).padStart(5)} ${(p.logErr >= 0 ? "+" : "") + p.logErr.toFixed(2)} ${p.inRange == null ? "" : p.inRange ? "in" : "out"}`.padEnd(22)); console.log(`${x.runId.padEnd(16)} ${x.model.padEnd(7)} ${x.activeMin.toFixed(1).padStart(6)} ${String(x.calls).padStart(6)} ${String(x.outTokens ?? "–").padStart(8)}  ${x.quality ?? "–"} | ${f(x.predictions["declared-raw"])} | ${f(x.predictions["v02-declared"])} | ${f(x.predictions["v02-reference"])}`); }
  for (const [k, a] of Object.entries(r.aggregate)) console.log(`${k.padEnd(14)} scored ${a.scored}/${a.runs} · MdALE ${a.mdale?.toFixed(2) ?? "–"} · bias ${a.bias?.toFixed(2) ?? "–"} · within 2× ${a.within2x != null ? Math.round(a.within2x * 100) + "%" : "–"} · p10–p90 coverage ${a.coverage80 != null ? Math.round(a.coverage80 * 100) + "%" : "–"} · insufficient ${a.insufficient}`);
  for (const [k, v] of Object.entries(r.repeats)) console.log(`repeat ${k}: active ${v.activeMin.join(" / ")} min · calls ${v.calls.join(" / ")} · max/min ${v.maxOverMin} · quality ${v.quality.join(" / ")}`);
  for (const [k, g] of Object.entries(r.byModel)) console.log(`model ${k}: ${g.runs} runs · median active ${g.medianActiveMin} min · median calls ${g.medianCalls} · median out tokens ${g.medianOutTokens} · mean quality ${g.meanQuality ?? "–"}`);
  console.log(`→ ${F.report}`);
}

function main() {
  const [cmd, a, b, ...rest] = argv.filter((x, i) => !x.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (cmd === "register") return register(a);
  if (cmd === "collect") return collect();
  if (cmd === "quality") { const q = readJson(F.quality, {}); const sc = Number(b); if (!(sc >= 0 && sc <= 3)) throw new Error("score 0-3"); q[a] = { score: sc, note: rest.join(" ").slice(0, 200), at: new Date().toISOString(), by: "main session review" }; writeAtomic(F.quality, JSON.stringify(q, null, 1)); console.log(`${a}: quality ${sc}`); return; }
  if (cmd === "score") return score();
  console.error("usage: sb-eval register <runId> | collect [--session S] | quality <runId> <0-3> [note] | score [--json]"); process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("tools", "sb-eval.js"))) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
