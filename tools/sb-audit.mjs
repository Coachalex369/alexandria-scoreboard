#!/usr/bin/env node
// Scoreboard accuracy audit: replays the real local activity (hook log, transcripts, session registry) through one
// Scoreboard checkout and measures what the board reports against ground truth taken directly from the raw logs.
// Read-only toward ~/.claude: the ledger is copied into a scratch data directory first.
//
//   node tools/sb-audit.mjs --repo <scoreboard checkout> --data <scratch dir> [--out result.json] [--label before|after]
//
// Ground truth (from raw files, independent of either board):
//   tool failures by class, AskUserQuestion/ExitPlanMode calls with their open→answer gap (transcripts), subagents with
//   and without a SubagentStop line, prompts per session, test runs (parsed counts) per session.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const repo = path.resolve(args.repo || ".");
const data = path.resolve(args.data || fs.mkdtempSync(path.join(os.tmpdir(), "sb-audit-")));
const run = args.label ?? null; // the caller's own tag (before|after), never derived from paths
const HOME = os.homedir();
const LEDGER = path.join(HOME, ".claude", "eta", "scoreboard");
// Never delete a folder the tool did not create: an existing --data folder must be empty or carry our marker file.
const MARK = path.join(data, ".sb-audit-scratch");
if (fs.existsSync(data) && fs.readdirSync(data).length && !fs.existsSync(MARK)) { console.error(`sb-audit: --data ${data} is not empty and was not created by sb-audit; refusing to clear it`); process.exit(2); }
fs.rmSync(data, { recursive: true, force: true }); fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(MARK, "");
for (const f of ["predictions.jsonl", "tasks.jsonl", "history.backfill.jsonl", "calibration.json"]) if (fs.existsSync(path.join(LEDGER, f))) fs.copyFileSync(path.join(LEDGER, f), path.join(data, f));

// ---- ground truth from the raw hook log ----
const hookLines = fs.readFileSync(path.join(HOME, ".claude", "eta", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const truth = { hookLines: hookLines.length, failures: { total: 0, interrupted: 0, test: 0, build: 0, agent: 0, other: 0 }, agentsStarted: 0, agentsWithoutStop: 0, prompts: 0, longPrompts: 0, testRuns: 0, testRunsFailed: 0, permissionRequests: 0, ownerQuestions: [] };
const TEST = /^(npm (test|run test)|npx (jest|vitest|mocha)|node --test|pytest|cargo test|go test|dotnet test)/i, BUILD = /^(npm run (build|lint|typecheck|dist)|npx (tsc|eslint|electron-builder)|tsc|cargo build|go build|dotnet build)/i;
const started = new Set(), stopped = new Set();
for (const r of hookLines) {
  if (r.ev === "PostToolUseFailure") { truth.failures.total++; const sig = r.sig || ""; if (r.interrupted) truth.failures.interrupted++; else if (r.tool === "Agent") truth.failures.agent++; else if (TEST.test(sig)) truth.failures.test++; else if (BUILD.test(sig)) truth.failures.build++; else truth.failures.other++; }
  if (r.ev === "SubagentStart") started.add(r.agent);
  if (r.ev === "SubagentStop" && r.agent) stopped.add(r.agent);
  if (r.ev === "UserPromptSubmit") { truth.prompts++; if ((r.promptLen || 0) >= 300) truth.longPrompts++; }
  if (r.tests) { truth.testRuns++; if (!r.tests.ok) truth.testRunsFailed++; }
  if (r.ev === "PermissionRequest") truth.permissionRequests++;
}
truth.agentsStarted = started.size; truth.agentsWithoutStop = [...started].filter((a) => !stopped.has(a)).length;
// owner questions from transcripts of the sessions in the hook log
const sids = new Set(hookLines.map((r) => r.sid));
const projectsDir = path.join(HOME, ".claude", "projects");
for (const dir of fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []) {
  for (const f of fs.readdirSync(path.join(projectsDir, dir)).filter((n) => n.endsWith(".jsonl") && sids.has(n.slice(0, -6)))) {
    const open = new Map();
    for (const line of fs.readFileSync(path.join(projectsDir, dir, f), "utf8").split("\n")) {
      if (!line.includes("AskUserQuestion") && !line.includes("ExitPlanMode") && !line.includes("tool_result")) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const c = o.message?.content; if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === "tool_use" && (b.name === "AskUserQuestion" || b.name === "ExitPlanMode")) open.set(b.id, { session: f.slice(0, 8), tool: b.name, openedAt: o.timestamp });
        if (b?.type === "tool_result" && open.has(b.tool_use_id)) { const q = open.get(b.tool_use_id); open.delete(b.tool_use_id); truth.ownerQuestions.push({ ...q, id: b.tool_use_id, answeredAt: o.timestamp, waitMs: Date.parse(o.timestamp) - Date.parse(q.openedAt) }); }
      }
    }
  }
}

// ---- replay through the checkout under test ----
const { createScoreboardServer } = await import(new URL(`file:///${path.join(repo, "packages/scoreboard/server.js").replace(/\\/g, "/")}`));
const t0 = Date.now();
const app = createScoreboardServer({ port: 0, dataDir: data, log: () => {} });
const startupMs = Date.now() - t0;
await app.listen();
app.pollGit?.(); await new Promise((r) => setTimeout(r, 2500));
const now = Date.now();
const st = app.status();
const b = app.board;
// Content-free output (as the privacy doc promises): no repository path or name, no session label.
const out = { run, startupMs, events: st.events, truth: { ...truth, ownerQuestions: truth.ownerQuestions.length, ownerQuestionWaitMin: truth.ownerQuestions.map((q) => Math.round(q.waitMs / 6e3) / 10) }, sessions: [], gitRepos: Object.keys(st.sources.git.repos || {}).length };
const snaps = [];
for (const s of b.sessions.values()) {
  if (s.synthetic) continue;
  const snap = b.snapshot(s.id, now);
  snaps.push(snap);
  const row = { id: s.id.slice(0, 8), status: snap.session?.status, labelSource: snap.session?.labelSource ?? "folder", tasks: s.tasks.length, periodShown: snap.period?.value ?? null, prompts: s.prompts };
  row.fouls = snap.fouls.value; row.verified = snap.verified.value; row.timeouts = snap.timeouts.value; row.home = snap.home.value;
  row.agentsShownRunning = snap.player.value;
  row.wins = snap.winDetail ? { total: snap.winDetail.total, sure: snap.winDetail.sure, unverified: snap.winDetail.unverified, probable: snap.winDetail.probable } : null;
  out.sessions.push(row);
}
// agents shown as running although their session has been silent > 30 min (the "running forever" defect)
out.agentsRunningForever = snaps.reduce((n, s) => n + s.agents.filter((a) => (a.state === "running" || a.state === "active") && now - Date.parse(a.lastSeen || a.start) > 30 * 60e3).length, 0);
out.agentsLost = snaps.reduce((n, s) => n + s.agents.filter((a) => a.state === "lost").length, 0);
out.agentsEndInferred = snaps.reduce((n, s) => n + s.agents.filter((a) => a.endBasis === "inferred").length, 0);
// live question detection: attention opened at the question (new) vs only measured after the answer (old)
const opened = [];
for (const s of b.sessions.values()) for (const l of s.log) if (/^attention · (question|plan approval)/.test(l.text)) opened.push({ session: s.id.slice(0, 8), ts: l.ts });
out.questionsOpenedLive = opened.length;
out.questionsMatched = truth.ownerQuestions.filter((q) => opened.some((o) => o.session === q.session && Math.abs(Date.parse(o.ts) - Date.parse(q.openedAt)) < 5000)).length;
// ETA accuracy at the start of each completed unit (task in the old board, period in the new), from the ledger records
const recs = b.taskHistory.filter((r) => r.predictionAtStart && r.calibratable !== false && r.startedAt >= hookLines[0].ts);
const unit = (r) => r.features?.regime || "brief";
const regimes = [...new Set(recs.map(unit))];
out.eta = {};
for (const reg of regimes) {
  const rs = recs.filter((r) => unit(r) === reg);
  const withRange = rs.filter((r) => r.predictionAtStart.p10 != null && r.predictionAtStart.p90 != null);
  const inRange = withRange.filter((r) => r.actualActiveMs >= r.predictionAtStart.p10 && r.actualActiveMs <= r.predictionAtStart.p90).length;
  const ale = withRange.filter((r) => r.predictionAtStart.p50 > 0 && r.actualActiveMs > 0).map((r) => Math.abs(Math.log(r.predictionAtStart.p50 / r.actualActiveMs))).sort((x, y) => x - y);
  out.eta[reg] = { units: rs.length, withRange: withRange.length, coverage: withRange.length ? Math.round((inRange / withRange.length) * 100) / 100 : null, mdale: ale.length ? Math.round(ale[Math.floor(ale.length / 2)] * 100) / 100 : null, within2x: ale.length ? Math.round((ale.filter((x) => x <= Math.log(2)).length / ale.length) * 100) / 100 : null, medianActiveMin: rs.length ? Math.round(rs.map((r) => r.actualActiveMs).sort((x, y) => x - y)[Math.floor(rs.length / 2)] / 6e3) / 10 : null };
}
// shot clock backtest (new board only): each completed agent predicted from earlier agents of its type, at its start
if (b.agentHistory) {
  const hist = [...b.agentHistory].sort((x, y) => x.endedAt.localeCompare(y.endedAt));
  let n = 0, unknown = 0, ranges = 0, countdowns = 0, inRange = 0;
  for (const a of hist) {
    const start = new Date(Date.parse(a.endedAt) - a.durationMs).toISOString();
    const prior = hist.filter((h) => h.type && h.type === a.type && h.endedAt < start).map((h) => h.durationMs).sort((x, y) => x - y);
    n++;
    if (prior.length < 6) { unknown++; continue; }
    const q = (p) => prior[Math.round((prior.length - 1) * p)];
    const spread = q(0.9) / Math.max(1, q(0.1));
    if (prior.length >= 12 && spread <= 3) countdowns++; else ranges++;
    if (a.durationMs >= q(0.1) && a.durationMs <= q(0.9)) inRange++;
  }
  out.shotBacktest = { agents: n, unknown, ranges, countdowns, coverageWhenShown: n - unknown ? Math.round((inRange / (n - unknown)) * 100) / 100 : null };
}
await app.close();
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
