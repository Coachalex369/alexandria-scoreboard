#!/usr/bin/env node
// Scoreboard marks: declare task boundaries, estimates and test runs for the LIVE session.
// Marks are facts the operator states; estimates are declared predictions. Nothing is inferred here.
//
//   node tools/sb-mark.js start "Build the roster panel" [--id task-x] [--minutes 25 --p90 40 --calls 60]
//   node tools/sb-mark.js estimate --minutes 25 [--p90 40] [--calls 60]        (for the current task)
//   node tools/sb-mark.js end                                                  (completes the current task → horn)
//   node tools/sb-mark.js tests -- npm test                                    (runs the command, records pass/fail counts)
//   node tools/sb-mark.js pause [--reason "lunch"] | resume                 (declared pause: the stopwatch excludes it)
//   node tools/sb-mark.js wait ci|deploy|review|external | waited             (declared external wait, excluded from active time)
//   start also takes --type <word> (task type for calibration strata) and --model <id> (the model doing the work)
//   node tools/sb-mark.js status
// Options: --session <id> --project <name> (default: the most recent session in the hook log), --server http://127.0.0.1:4340
// Marks are appended to data/marks.events.jsonl (the server tails it) and also POSTed to the server when it runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeEvent } from "../packages/event-engine/src/schema.js";
import { newId } from "../packages/event-engine/src/ids.js";
import { parseTestOutput, testRunEvent } from "../packages/event-engine/src/adapters/testOutput.js";
import { defaultDataDir } from "../packages/scoreboard/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const command = dash >= 0 ? argv.slice(dash + 1) : [];
const flag = (n, d = null) => { const i = own.indexOf(`--${n}`); return i >= 0 ? (own[i + 1] ?? true) : d; };
const positional = own.filter((a, i) => !a.startsWith("--") && !(i > 0 && own[i - 1].startsWith("--")));
const [cmd, ...rest] = positional;
const dataDir = defaultDataDir(); fs.mkdirSync(dataDir, { recursive: true });
const marksFile = path.join(dataDir, "marks.events.jsonl");
const currentFile = path.join(dataDir, "current-task.json");
const hookLog = process.env.SB_HOOK_LOG || path.join(os.homedir(), ".claude", "eta", "events.jsonl");
const serverUrl = flag("server", process.env.SB_SERVER || "http://127.0.0.1:4340");

// Which live session do marks belong to? --session wins; else the most recent hook-log session whose project is
// the current directory's name (several Claude Code sessions can log concurrently); else the most recent session.
function liveSession() {
  if (flag("session")) return { id: flag("session"), project: flag("project") || null };
  const here = path.basename(process.cwd());
  if (process.env.CLAUDE_CODE_SESSION_ID) return { id: process.env.CLAUDE_CODE_SESSION_ID, project: flag("project") || here }; // run from inside a Claude Code session
  try {
    const lines = fs.readFileSync(hookLog, "utf8").trim().split("\n");
    let fallback = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 2000); i--) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (!r.sid || r.ev === "SessionEnd") continue;
      if (r.proj === here) return { id: r.sid, project: flag("project") || r.proj };
      if (!fallback) fallback = { id: r.sid, project: flag("project") || r.proj || null };
    }
    if (fallback) { console.error(`note: no session for project "${here}" in the hook log; using the most recent session (${fallback.id.slice(0, 8)} · ${fallback.project}). Pass --session to override.`); return fallback; }
  } catch {}
  throw new Error("no live session found in the hook log; pass --session <id>");
}
function current() { try { return JSON.parse(fs.readFileSync(currentFile, "utf8")); } catch { return null; } }
// The server appends accepted events to the marks file itself; only write the file directly when it is not running.
async function emit(events) {
  let delivered = false;
  try { const r = await fetch(`${serverUrl}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events), signal: AbortSignal.timeout(1500) }); if (r.ok) delivered = true; else console.error(`server declined: ${await r.text()}`); } catch { /* server not running */ }
  if (!delivered) fs.appendFileSync(marksFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const e of events) console.log(`${e.kind}  ${e.task?.id || ""}  ${e.task?.title || ""} ${e.payload ? JSON.stringify(e.payload) : ""}`);
}
const estimatePayload = () => { const p = {}; if (flag("minutes")) p.p50Min = Number(flag("minutes")); if (flag("p90")) p.p90Min = Number(flag("p90")); if (flag("calls")) p.calls = Number(flag("calls")); p.basis = "declared"; return Object.keys(p).length > 1 ? p : null; };

async function main() {
  const now = () => new Date().toISOString();
  if (cmd === "start") {
    const session = liveSession(); const title = rest.join(" ") || null; const id = flag("id") || `task_${new Date().toISOString().slice(0, 10)}_${newId("t").slice(-6)}`;
    const startPayload = { by: "sb-mark" }; if (flag("type")) startPayload.type = String(flag("type")).slice(0, 32); if (flag("model")) startPayload.model = String(flag("model")).slice(0, 48);
    const events = [makeEvent({ id: newId("mark"), ts: now(), source: "marks", kind: "task.start", session, actor: { type: "human" }, task: { id, title }, payload: startPayload, provenance: { observed: true, adapter: "sb-mark@1", confidence: 1 } })];
    const est = estimatePayload(); if (est) events.push(makeEvent({ id: newId("mark"), ts: now(), source: "marks", kind: "task.estimate", session, actor: { type: "main", modelConfidence: "unknown" }, task: { id, title }, payload: est, provenance: { observed: false, adapter: "sb-mark@1", confidence: 1 } }));
    fs.writeFileSync(currentFile, JSON.stringify({ id, title, session, start: events[0].ts }));
    return emit(events);
  }
  if (cmd === "estimate") {
    const c = current(); if (!c) throw new Error("no current task; run `sb-mark start` first"); const est = estimatePayload(); if (!est) throw new Error("--minutes (and optionally --p90, --calls) required");
    return emit([makeEvent({ id: newId("mark"), ts: now(), source: "marks", kind: "task.estimate", session: c.session, actor: { type: "main", modelConfidence: "unknown" }, task: { id: c.id, title: c.title }, payload: est, provenance: { observed: false, adapter: "sb-mark@1", confidence: 1 } })]);
  }
  if (cmd === "end") {
    const c = current(); if (!c) throw new Error("no current task");
    fs.rmSync(currentFile, { force: true });
    return emit([makeEvent({ id: newId("mark"), ts: now(), source: "marks", kind: "task.end", session: c.session, actor: { type: "human" }, task: { id: c.id, title: c.title }, payload: { by: "sb-mark", outcome: flag("outcome", "done") }, provenance: { observed: true, adapter: "sb-mark@1", confidence: 1 } })]);
  }
  if (cmd === "tests") {
    if (!command.length) throw new Error("usage: sb-mark tests -- <command...>");
    const c = current(); const session = c?.session || liveSession();
    const started = now(); const t0 = Date.now();
    const child = spawn(command.join(" "), { shell: true, stdio: ["inherit", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", (d) => { out += d; process.stdout.write(d); }); child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    const code = await new Promise((r) => child.on("close", r));
    const result = parseTestOutput(out, { exitCode: code }); result.durationMs = result.durationMs ?? Date.now() - t0;
    const ev = testRunEvent({ ts: started, session, actor: { type: "human" }, result, label: command.slice(0, 2).join(" ") });
    if (c) ev.task = { id: c.id, title: c.title };
    await emit([ev]); process.exitCode = code;
    return;
  }
  if (cmd === "pause" || cmd === "resume" || cmd === "wait" || cmd === "waited") {
    const c = current(); if (!c) throw new Error("no current task; run `sb-mark start` first");
    const kind = cmd === "pause" ? "task.pause" : cmd === "resume" ? "task.resume" : cmd === "wait" ? "wait.begin" : "wait.end";
    const payload = { by: "sb-mark" };
    if (cmd === "pause" && flag("reason")) payload.reason = String(flag("reason")).slice(0, 40);
    if (cmd === "wait" || cmd === "waited") payload.kind = "external";
    if (cmd === "wait" && rest[0]) payload.key = String(rest[0]).slice(0, 24);
    return emit([makeEvent({ id: newId("mark"), ts: now(), source: "marks", kind, session: c.session, actor: { type: "human" }, task: { id: c.id, title: c.title }, payload, provenance: { observed: false, adapter: "sb-mark@1", confidence: 1 } })]);
  }
  if (cmd === "status") { console.log(JSON.stringify({ liveSession: liveSession(), currentTask: current(), marksFile }, null, 2)); return; }
  console.error("usage: sb-mark start <title> [--minutes N --p90 N --calls N --type W --model M] | estimate --minutes N | pause [--reason R] | resume | wait <kind> | waited | end | tests -- <cmd> | status");
  process.exit(2);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
