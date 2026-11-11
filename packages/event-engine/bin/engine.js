#!/usr/bin/env node
// Event engine CLI (UI-independent).
//   engine ingest claude-hooks <events.jsonl> --out <store.jsonl>
//   engine ingest git <repo> [--project name] [--max N] --out <store.jsonl>
//   engine ingest tests <output.txt> --session <id> --project <name> [--label x] --out <store.jsonl>
//   engine stats <store.jsonl>
//   engine tasks <store.jsonl>                      segments tasks and prints work/wait/tool counts
//   engine replay <store.jsonl> [--speed N] [--drain]  streams events to stdout on a scaled clock
import fs from "node:fs";
import path from "node:path";
import { EventStore } from "../src/store.js";
import { Replayer, LiveState } from "../src/replay.js";
import { linkTasks, paceStats } from "../src/tasks.js";
import { ingestHookLog } from "../src/adapters/claudeHooks.js";
import { ingestGit } from "../src/adapters/git.js";
import { parseTestOutput, testRunEvent } from "../src/adapters/testOutput.js";

const argv = process.argv.slice(2);
const flag = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] ?? true) : def; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["--drain"].includes(argv[i - 1])));
const [cmd, sub, target] = positional;
const min = (ms) => (ms / 60000).toFixed(1);

function main() {
  if (cmd === "ingest") {
    const out = flag("out"); if (!out) throw new Error("--out <store.jsonl> required");
    let events;
    if (sub === "claude-hooks") events = ingestHookLog(target);
    else if (sub === "git") events = ingestGit(target, { project: flag("project") || undefined, max: Number(flag("max", 200)) });
    else if (sub === "tests") {
      const text = fs.readFileSync(target, "utf8");
      const result = parseTestOutput(text, { exitCode: flag("exit") != null ? Number(flag("exit")) : null });
      events = [testRunEvent({ ts: new Date(fs.statSync(target).mtimeMs).toISOString(), session: { id: flag("session", `tests:${flag("project", "project")}`), project: flag("project", "project") }, result, label: flag("label") || path.basename(target) })];
    } else throw new Error(`unknown source ${sub}`);
    const store = new EventStore(out);
    const added = store.append(events);
    console.log(`ingested ${events.length} events (${added} new) → ${out}`);
    return;
  }
  const store = new EventStore(sub);
  if (cmd === "stats") { console.log(JSON.stringify(store.stats(), null, 2)); return; }
  if (cmd === "tasks") {
    const tasks = linkTasks(store.sorted());
    for (const t of tasks) console.log(`${t.id}  ${t.basis.padEnd(8)} start=${t.start} work=${min(t.workMs)}m wait=${min(t.waitingMs)}m tools=${t.toolCalls} agents=${t.agents.length} ${t.title ? "| " + t.title.slice(0, 60) : ""}`);
    const pace = paceStats(store.sorted());
    console.log(`\n${tasks.length} tasks; main-thread tool calls ${pace.calls}; median gap between calls ${pace.medianGapMs != null ? (pace.medianGapMs / 1000).toFixed(1) + "s" : "n/a"}`);
    return;
  }
  if (cmd === "replay") {
    const r = new Replayer(store.sorted(), { speed: Number(flag("speed", 1)) });
    const live = new LiveState();
    r.on("event", ({ event, index, total }) => { const s = live.apply(event); process.stdout.write(`${event.ts} ${String(index + 1).padStart(4)}/${total} ${event.kind.padEnd(14)} ${event.actor.type.padEnd(8)} ${event.payload?.tool || event.payload?.kind || ""}  open-tools=${s.openTools.size} agents-running=${live.runningAgents(event.session.id).length}\n`); });
    r.on("done", () => { console.log(`done: ${store.events.length} events`); });
    if (argv.includes("--drain")) r.drain(); else r.start();
    return;
  }
  console.error("usage: engine ingest <claude-hooks|git|tests> <path> --out <store> | stats <store> | tasks <store> | replay <store> [--speed N] [--drain]");
  process.exit(2);
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
