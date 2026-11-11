#!/usr/bin/env node
// Code-structure scan of real file changes → code.structure events (JSONL on stdout or --out <store>).
//   structure <repo> [--range A..B | --worktree] [--project name] [--session id] [--out store.jsonl]
// For each changed JavaScript file it reads the before/after text from git (in memory only), parses both
// with Tree-sitter, and emits one code.structure event carrying the delta, touched structures and names.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { structureDiff, structureClassifications, supportsPath, touchedByLines, changedLinesFromHunks } from "../src/codeStructure.js";
import { makeEvent } from "../../event-engine/src/schema.js";
import { stableId } from "../../event-engine/src/ids.js";
import { EventStore } from "../../event-engine/src/store.js";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const repo = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true) || process.cwd();
const project = flag("project") || path.basename(path.resolve(repo));
const range = flag("range");
const git = (...args) => { const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`); return r.stdout; };
const show = (rev, p) => { const r = spawnSync("git", ["-C", repo, "show", `${rev}:${p}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };

let changes; // [{ path, before(), after(), ts, commit }]
if (range) {
  const [from, to] = range.split("..");
  const files = git("diff", "--name-status", from, to).split("\n").filter(Boolean).map((l) => { const [st, ...p] = l.split("\t"); return { status: st[0], path: p[p.length - 1] }; });
  const ts = new Date(git("log", "-1", "--format=%aI", to).trim()).toISOString();
  changes = files.filter((f) => supportsPath(f.path)).map((f) => ({ path: f.path, before: () => (f.status === "A" ? null : show(from, f.path)), after: () => (f.status === "D" ? null : show(to, f.path)), ts, commit: git("rev-parse", "--short", to).trim() }));
} else {
  const files = git("status", "--porcelain=v1").split("\n").filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || "M", path: l.slice(3).trim() }));
  changes = files.filter((f) => supportsPath(f.path)).map((f) => ({ path: f.path, before: () => (f.status.includes("?") || f.status === "A" ? null : show("HEAD", f.path)), after: () => (fs.existsSync(path.join(repo, f.path)) ? fs.readFileSync(path.join(repo, f.path), "utf8") : null), ts: new Date().toISOString(), commit: null }));
}

const hunks = (c) => { const args = range ? ["diff", "-U0", range.split("..")[0], range.split("..")[1], "--", c.path] : ["diff", "-U0", "--", c.path]; const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : ""; };

const events = [];
for (const c of changes) {
  const after = c.after();
  const diff = await structureDiff(c.before(), after);
  const lines = changedLinesFromHunks(hunks(c));
  const enclosing = after != null && lines.length ? await touchedByLines(after, lines) : [];
  const cls = structureClassifications(diff);
  for (const t of enclosing) if (!cls.some((x) => x.scheme === "code-structure" && x.value === t.kind)) cls.push({ scheme: "code-structure", value: t.kind, basis: "observed", confidence: 0.9, by: "tree-sitter:enclosing" });
  events.push(makeEvent({
    id: stableId("evt", "structure", project, c.commit || "worktree", c.path, c.ts), ts: c.ts, source: "parser", kind: "code.structure",
    session: { id: flag("session") || `git:${project}`, project }, actor: { type: "system" }, parent: c.commit ? { commit: c.commit } : undefined,
    payload: { path: c.path, delta: diff.delta, touched: diff.touched, named: diff.named, changedLines: lines.length, enclosing: enclosing.map((t) => ({ kind: t.kind, name: t.name, hits: t.hits })), nodesBefore: diff.nodesBefore, nodesAfter: diff.nodesAfter, parseErrors: diff.parseErrors },
    classification: cls,
    provenance: { observed: true, adapter: "tree-sitter-javascript@0.25", confidence: diff.parseErrors ? 0.7 : 0.95 },
  }));
}
const out = flag("out");
if (out) { const store = new EventStore(out); const n = store.append(events); console.log(`${events.length} code.structure events (${n} new) → ${out}`); }
else for (const e of events) console.log(JSON.stringify(e));
if (!events.length) console.error(`no JavaScript changes found in ${repo}${range ? " " + range : " (worktree)"}`);
