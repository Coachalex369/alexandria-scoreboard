#!/usr/bin/env node
// Alexandria Scoreboard local server. No dependencies, binds 127.0.0.1 only, read-only toward its sources.
//   npm run scoreboard          →  http://127.0.0.1:4340/
//
// Sources (facts, normalized through the existing adapters):
//   hook log    ~/.claude/eta/events.jsonl (collector) tailed every second   → claude-hooks adapter
//   marks       data/marks.events.jsonl (task.start / task.estimate / task.end / test.run from tools/sb-mark.js)
//   git         `git log` polled every 20 s for the git ROOTS of live sessions (resolved from each session's real
//               working directory: transcript cwd, else the session registry's launch directory; never guessed from a
//               folder name). A commit is attributed (inferred) to the session in that repository that was most
//               recently active; the board scores each commit hash once across all sessions
//   facts       transcripts + ~/.claude/sessions registry -> session identity (repo, branch, label), owner questions as
//               they open, process liveness (sessionFacts.js; content stays in memory)
// Outputs: GET /api/stream (SSE: snapshot, then events), GET /api/status, GET /api/predictions,
//          POST /api/ingest (marks/tests/manual events, appended to the marks file), static files from the repo root.
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseHookLog } from "../event-engine/src/adapters/claudeHooks.js";
import { readGitLog, parseGitLog, commitsToEvents } from "../event-engine/src/adapters/git.js";
import { assertEvent } from "../event-engine/src/schema.js";
import { Board, taskWorkMs, taskRecord } from "./src/board.js";
import { Ledger } from "./src/ledger.js";
import { scanTranscriptChunk, newFactsState, readRegistry, registryEvents, gitRootOf, repoKey, SESSIONS_DIR } from "./src/sessionFacts.js";
import { parseTranscript, parseSubagentTranscript, newTranscriptState, findTranscript, listSubagents, PROJECTS_DIR } from "../event-engine/src/adapters/claudeTranscript.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".jsonl": "application/x-ndjson", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8", ".wasm": "application/wasm", ".woff2": "font/woff2" };

// Polling tail: Windows file watching is unreliable for appended logs, so stat once a second and read new bytes.
const TAIL_SLICE = 4 * 1024 * 1024;
export class FileTail {
  // maxBytes: after startup, a large backlog (a resumed session's 90 MB transcript) is read in slices with a yield
  // between them, so the event loop (SSE, UI) never stalls. onError: a throwing consumer is logged, never fatal.
  constructor(file, onChunk, { intervalMs = 1000, maxBytes = null, onError = null } = {}) { this.file = file; this.onChunk = onChunk; this.intervalMs = intervalMs; this.offset = 0; this.line = 0; this.rest = ""; this.timer = null; this.maxBytes = maxBytes; this.onError = onError; this.pending = false; }
  readNew() {
    let st; try { st = fs.statSync(this.file); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.line = 0; this.rest = ""; this.decoder = null; } // truncated or rotated: start over
    if (st.size === this.offset) return;
    const fd = fs.openSync(this.file, "r");
    try {
      const want = st.size - this.offset; const len = this.maxBytes && want > this.maxBytes ? this.maxBytes : want;
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, this.offset); this.offset += len;
      if (len < want && !this.pending) { this.pending = true; setImmediate(() => { this.pending = false; this.readNew(); }); }
      const text = this.rest + (this.decoder ||= new StringDecoder("utf8")).write(buf); // a multi-byte character split by a slice is kept whole
      const nl = text.lastIndexOf("\n");
      if (nl < 0) { this.rest = text; return; }
      const complete = text.slice(0, nl + 1); this.rest = text.slice(nl + 1);
      const firstLine = this.line; this.line += complete.split("\n").length - 1;
      try { this.onChunk(complete, firstLine); } catch (err) { if (this.onError) this.onError(err, this.file); else throw err; }
    } finally { fs.closeSync(fd); }
  }
  start() { this.readNew(); this.timer = setInterval(() => this.readNew(), this.intervalMs); if (this.timer.unref) this.timer.unref(); return this; }
  stop() { clearInterval(this.timer); }
}

// Marks and predictions live next to the hook log by default so the browser version, the desktop app and the
// sb-mark CLI share one store that survives a fresh clone. Override with SB_DATA_DIR.
export function defaultDataDir() { return process.env.SB_DATA_DIR || path.join(os.homedir(), ".claude", "eta", "scoreboard"); }

export function createScoreboardServer({ port = 4340, hookLog = path.join(os.homedir(), ".claude", "eta", "events.jsonl"), dataDir = defaultDataDir(), repoRoots = [os.homedir()], gitPollMs = 20e3, snapshotHours = 24, git = true, log = console.log, transcripts = true, projectsDir = PROJECTS_DIR, transcriptPollMs = 2000, checkpointMs = 5000, registry = true, sessionsDir = SESSIONS_DIR, registryPollMs = 5000 } = {}) {
  // repoRoots is accepted for compatibility and no longer used: repositories come from real git roots.
  fs.mkdirSync(dataDir, { recursive: true });
  const marksFile = path.join(dataDir, "marks.events.jsonl");
  const predictionsFile = path.join(dataDir, "predictions.jsonl");
  const events = []; const byId = new Set(); const clients = new Set();
  const ledger = new Ledger(dataDir);
  const checkpointAtStart = ledger.readCheckpoint();
  const board = new Board({ history: readJsonl(predictionsFile), taskHistory: ledger.history(), onTaskComplete: (rec) => { if (ledger.append(rec)) { historyDirty = true; broadcast("task", rec); } } });
  let historyDirty = false;
  // After completions, rebuild the calibration history from the ledger (live records replace overlapping backfill).
  function refreshHistory() { if (!historyDirty) return; historyDirty = false; board.setHistory(ledger.history()); broadcast("history", { taskHistory: board.taskHistory }); }
  board.calibration = ledger.readCalibration()?.overall || null;
  const sources = { hookLog: { file: hookLog, events: 0, lastTs: null, present: fs.existsSync(hookLog) }, marks: { file: marksFile, events: 0, lastTs: null }, git: { repos: {}, events: 0, lastPoll: null, enabled: git }, transcripts: { enabled: transcripts, files: 0, events: 0, lastTs: null }, facts: { events: 0, lastTs: null }, registry: { enabled: registry, dir: sessionsDir, events: 0, lastTs: null, entries: 0 }, ledger: { file: ledger.tasksFile, live: ledger.ids.size, history: board.taskHistory.length, recovered: 0 } };
  const startedAt = new Date().toISOString();

  // Startup: every source's existing content is buffered, sorted globally and applied once, so a task is never
  // closed by the hook replay before the transcript facts (model, tokens, rate limits) of its own time arrive.
  let starting = true; const startup = [];
  function accept(list, src) {
    if (starting) { for (const e of list) startup.push([e, src]); return; }
    const fresh = [];
    for (const e of list) { if (byId.has(e.id)) continue; byId.add(e.id); events.push(e); fresh.push(e); src.events++; if (!src.lastTs || e.ts > src.lastTs) src.lastTs = e.ts; }
    if (!fresh.length) return;
    fresh.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const e of fresh) { board.apply(e); if (e.kind === "task.end") persistPredictions(); }
    refreshHistory();
    broadcast("events", fresh);
  }
  function persistPredictions() {
    const done = board.predictions.completed();
    try { fs.writeFileSync(predictionsFile, done.map((r) => JSON.stringify(r)).join("\n") + (done.length ? "\n" : "")); } catch (err) { log(`predictions not saved: ${err.message}`); }
  }

  const tailError = (err, file) => { sources.errors = (sources.errors || 0) + 1; log(`skipped a chunk of ${path.basename(file)}: ${err.message}`); };
  const hookTail = new FileTail(hookLog, (chunk, firstLine) => accept(parseHookLog(chunk, { file: path.basename(hookLog), lineOffset: firstLine }), sources.hookLog), { onError: tailError }).start();
  const marksTail = new FileTail(marksFile, (chunk) => { const out = []; for (const line of chunk.split("\n")) { if (!line.trim()) continue; try { const e = JSON.parse(line); assertEvent(e); out.push(e); } catch { /* skip bad line */ } } accept(out, sources.marks); }, { onError: (e, f) => tailError(e, f) }).start();

  // Git: the repositories live sessions work in (git roots learned from session facts), polled for new commits.
  const authors = {}; // repo key -> git user.name (memory only, never in /api/status)
  const repoPaths = new Map(); // repo key -> absolute git root (kept in memory, never sent to the page)
  const resolveRoot = (dir) => { const r = gitRootOf(dir); if (r) repoPaths.set(repoKey(r), r); return r; };
  function liveRepos() {
    const cutoff = Date.now() - 2 * 3600e3; const m = new Map();
    for (const s of board.sessions.values()) {
      const key = s.identity?.repoKey || s.identity?.regRepoKey; if (!key || s.synthetic || !s.lastEventTs || Date.parse(s.lastEventTs) < cutoff) continue;
      if (!m.has(key)) m.set(key, []); m.get(key).push(s);
    }
    return m;
  }
  function pollGit() {
    if (!git) return;
    sources.git.lastPoll = new Date().toISOString();
    for (const [key, sessions] of liveRepos()) {
      const repo = repoPaths.get(key); if (!repo) continue;
      const info = sources.git.repos[key] ||= { name: path.basename(repo), commits: 0, sessions: 0 };
      info.sessions = sessions.length;
      try {
        const since = sessions.map((s) => s.start || s.tasks[0]?.start || s.lastEventTs).filter(Boolean).sort()[0];
        if (authors[key] === undefined) { try { authors[key] = execFileSync("git", ["-C", repo, "config", "user.name"], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim() || null; } catch { authors[key] = null; } }
        const commits = parseGitLog(readGitLog(repo, { since, max: 50 })).filter((c) => c.ts >= since && (!authors[key] || c.author === authors[key] || /claude/i.test(c.author || "")));
        const evs = [];
        for (const c of commits) {
          // the session of this repository most recently active that had started by the commit (inferred attribution)
          const cand = sessions.filter((s) => (s.start || s.lastEventTs) <= c.ts).sort((a, b) => (b.lastEventTs || "").localeCompare(a.lastEventTs || ""))[0] || sessions[0];
          for (const e of commitsToEvents([c], { project: path.basename(repo), sessionId: cand.id })) if (e.kind === "git.commit") { e.payload = { ...e.payload, attribution: "inferred", repoKey: key }; evs.push(e); }
        }
        const before = sources.git.events; accept(evs, sources.git); info.commits += sources.git.events - before;
      } catch (err) { info.error = String(err.message || err).split("\n")[0].replace(/[A-Za-z]:[\\/][^\s'"]*/g, "<path>").slice(0, 120); }
    }
  }
  const gitTimer = setInterval(pollGit, gitPollMs); if (gitTimer.unref) gitTimer.unref(); setTimeout(pollGit, 1500).unref?.();

  // Transcripts (supplement mode): model ids, token counts, rate limits with reset times, compaction — the facts the
  // hook log lacks. Only for sessions seen live in the last snapshot window; content never leaves the adapter.
  const txTails = new Map(); // file -> FileTail
  const txFiles = new Map(); // session id -> transcript path | null
  function sessionsForScan() {
    if (!starting) return [...board.sessions.values()];
    const m = new Map(); for (const [e] of startup) { const cur = m.get(e.session.id); if (!cur || e.ts > cur.lastEventTs) m.set(e.session.id, { id: e.session.id, project: e.session.project || cur?.project || null, lastEventTs: e.ts, synthetic: !!(e.provenance?.synthetic || e.source === "synthetic") }); }
    return [...m.values()];
  }
  function scanTranscripts() {
    if (!transcripts) return;
    const cutoff = Date.now() - Math.max(snapshotHours, 14 * 24) * 3600e3; // sessions of the last two weeks
    for (const s of sessionsForScan()) {
      if (s.synthetic || !s.lastEventTs || Date.parse(s.lastEventTs) < cutoff) continue;
      let file = txFiles.get(s.id);
      if (file === undefined) { file = findTranscript(s.id, projectsDir); txFiles.set(s.id, file); }
      if (!file) continue;
      if (!txTails.has(file)) {
        const state = newTranscriptState(); const facts = newFactsState();
        txTails.set(file, new FileTail(file, (chunk, first) => {
          accept(parseTranscript(chunk, { sessionId: s.id, project: s.project, file: path.basename(file), lineOffset: first, mode: "supplement", state }), sources.transcripts);
          accept(scanTranscriptChunk(chunk, { sessionId: s.id, file: path.basename(file), lineOffset: first, state: facts, resolveRoot }), sources.facts);
        }, { maxBytes: starting ? null : TAIL_SLICE, onError: tailError }).start());
        sources.transcripts.files++;
      }
      for (const sub of listSubagents(file)) {
        if (txTails.has(sub.file)) continue;
        // a subagent file is re-parsed whole on growth (they are small); event ids are stable, duplicates are dropped
        txTails.set(sub.file, new FileTail(sub.file, () => { let text = ""; try { text = fs.readFileSync(sub.file, "utf8"); } catch { return; } let meta = sub.meta; try { meta = JSON.parse(fs.readFileSync(sub.file.replace(/.jsonl$/, ".meta.json"), "utf8")); } catch {} accept(parseSubagentTranscript(text, { sessionId: s.id, project: s.project, agentId: sub.agentId, meta, file: path.basename(sub.file), mode: "supplement" }), sources.transcripts); }, { onError: tailError }).start());
        sources.transcripts.files++;
      }
    }
  }
  scanTranscripts();
  const registryMemo = new Map();
  function pollRegistry() {
    if (!registry) return;
    const entries = readRegistry(sessionsDir); sources.registry.entries = entries.length;
    accept(registryEvents(entries, { memo: registryMemo, resolveRoot }), sources.registry);
  }
  pollRegistry();
  starting = false;
  for (const t of [hookTail, marksTail, ...txTails.values()]) t.maxBytes = TAIL_SLICE;
  {
    startup.sort((a, b) => a[0].ts.localeCompare(b[0].ts) || a[0].id.localeCompare(b[0].id));
    for (const [e, src] of startup) { if (byId.has(e.id)) continue; byId.add(e.id); events.push(e); src.events++; if (!src.lastTs || e.ts > src.lastTs) src.lastTs = e.ts; board.apply(e); }
    startup.length = 0; refreshHistory();
  }
  const regTimer = setInterval(pollRegistry, registryPollMs); if (regTimer.unref) regTimer.unref();
  const txTimer = setInterval(() => { scanTranscripts(); for (const t of txTails.values()) t.readNew(); }, transcriptPollMs); if (txTimer.unref) txTimer.unref();

  // Durability: open tasks' totals are checkpointed atomically; tasks the replay could not rebuild become partial records.
  const rebuilt = new Set(); for (const s of board.sessions.values()) for (const t of s.tasks) rebuilt.add(`${s.id}:${t.id}`);
  sources.ledger.recovered = ledger.recoverMissing(checkpointAtStart, rebuilt).length;
  function checkpoint() {
    const now = Date.now(); const open = [];
    for (const s of board.sessions.values()) { if (s.synthetic) continue; for (const t of s.tasks) if (!t.end) open.push({ id: `${s.id}:${t.id}`, record: taskRecord(t, now) }); }
    try { ledger.writeCheckpoint({ at: new Date(now).toISOString(), open }); sources.ledger.lastCheckpoint = new Date(now).toISOString(); } catch (err) { log(`checkpoint not saved: ${err.message}`); }
  }
  checkpoint();
  const cpTimer = setInterval(() => { board.finalizeStale(Date.now()); refreshHistory(); checkpoint(); sources.ledger.live = ledger.ids.size; sources.ledger.history = board.taskHistory.length; }, checkpointMs); if (cpTimer.unref) cpTimer.unref();

  function status() {
    const now = Date.now();
    return { ok: true, startedAt, port, root: ROOT, sources, sessions: board.sessionList(now), focus: board.focusSession(), events: events.length, calibration: board.predictions.calibration(), etaCalibration: board.calibration, clients: clients.size, mode: "live" };
  }
  function broadcast(type, data) { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
  const heartbeat = setInterval(() => broadcast("heartbeat", { ts: new Date().toISOString(), sessions: board.sessionList(Date.now()) }), 15e3); if (heartbeat.unref) heartbeat.unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // Local-only: a Host other than loopback means DNS rebinding; a foreign Origin means another web page. Both refused.
    const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) { res.writeHead(403); res.end("forbidden host"); return; }
    const origin = req.headers.origin;
    const own = server.address()?.port;
    if (origin && !new RegExp(`^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${own}$`, "i").test(origin)) { res.writeHead(403); res.end("forbidden origin"); return; }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const cutoff = new Date(Date.now() - snapshotHours * 3600e3).toISOString();
      const snap = events.filter((e) => e.ts >= cutoff || e.source === "marks" || e.source === "tests").sort((a, b) => a.ts.localeCompare(b.ts));
      res.write(`event: snapshot\ndata: ${JSON.stringify({ events: snap, status: status(), predictions: board.predictions.history, taskHistory: board.taskHistory, agentHistory: board.agentHistory, etaCalibration: board.calibration })}\n\n`);
      clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (url.pathname === "/api/status") return json(res, status());
    if (url.pathname === "/api/predictions") return json(res, { history: board.predictions.history, calibration: board.predictions.calibration() });
    if (url.pathname === "/api/tasks") return json(res, { history: board.taskHistory, live: ledger.liveRecords(), calibration: ledger.readCalibration() });
    if (url.pathname === "/api/ingest" && req.method === "POST") {
      if (req.headers["x-alexandria-ingest"] !== "1") { json(res, { ok: false, error: "missing x-alexandria-ingest header" }, 403); return; }
      let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", () => {
        try {
          const list = body.trim().startsWith("[") ? JSON.parse(body) : body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
          for (const e of list) { assertEvent(e); if (!["marks", "tests", "manual"].includes(e.source)) throw new Error(`source ${e.source} not accepted over ingest`); }
          fs.appendFileSync(marksFile, list.map((e) => JSON.stringify(e)).join("\n") + "\n"); marksTail.readNew();
          json(res, { ok: true, accepted: list.length });
        } catch (err) { json(res, { ok: false, error: err.message }, 400); }
      });
      return;
    }
    // static
    let p = decodeURIComponent(url.pathname);
    if (p === "/") { res.writeHead(302, { location: "/packages/scoreboard/" + (url.search || "") }); res.end(); return; } // relative asset paths need the real directory
    let file = path.join(ROOT, p); if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end(`not found: ${p}`); return; } res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); res.end(data); });
  });

  function close() { checkpoint(); hookTail.stop(); marksTail.stop(); for (const t of txTails.values()) t.stop(); clearInterval(gitTimer); clearInterval(heartbeat); clearInterval(txTimer); clearInterval(regTimer); clearInterval(cpTimer); for (const c of clients) c.end(); return new Promise((r) => server.close(r)); }
  const listen = () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
  return { server, listen, close, board, events, status, pollGit, marksFile, predictionsFile, taskWorkMs, ledger, checkpoint, scanTranscripts };
}

function json(res, obj, code = 200) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || process.env.SB_PORT || 4340);
  const repoRoots = (process.env.SB_REPO_ROOTS || os.homedir()).split(";").filter(Boolean);
  const app = createScoreboardServer({ port, hookLog: process.env.SB_HOOK_LOG || undefined, repoRoots });
  app.listen().then((p) => {
    const st = app.status();
    console.log(`Alexandria Scoreboard  →  http://127.0.0.1:${p}/`);
    console.log(`  hook log  ${st.sources.hookLog.file}  (${st.sources.hookLog.present ? st.sources.hookLog.events + " events loaded" : "NOT FOUND: live data unavailable until the collector writes"})`);
    console.log(`  marks     ${app.marksFile}`);
    console.log(`  git       repositories resolved from each session's working directory (polled every 20 s)`);
    console.log(`  sessions  ${st.sessions.length}  focus ${st.focus || "none"}`);
  });
}
