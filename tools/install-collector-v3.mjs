#!/usr/bin/env node
// Collector installer. Run it yourself, not through an agent: Claude Code's self-modification guard
// rightly stops an agent from editing ~/.claude/settings.json. Nothing here bypasses that guard.
//
//   node tools/install-collector-v3.mjs              dry run: checks everything, prints the plan, changes nothing
//   node tools/install-collector-v3.mjs --apply      backs up both files, installs, verifies
//   node tools/install-collector-v3.mjs --rollback <stamp>   restores the two backups taken by that --apply
//   --force                                          allow replacing a newer installed collector (never the default)
//
// Two modes, detected automatically:
//   FIRST-TIME  no hook command mentioning eta-hook.mjs anywhere in settings.hooks (a missing settings.json counts as
//               empty): adds every event in ALL_EVENTS, pointing at ~/.claude/eta/eta-hook.mjs.
//   UPGRADE     collector hooks already exist: their command is copied, and only the missing NEW_EVENTS are added.
//
// What --apply does, in order (it stops at the first failure, before anything is changed where possible):
//   1. refuses if settings.json exists but is not valid JSON, or if the installed collector is newer (unless --force)
//   2. probes the new collector in a scratch home with sample hook inputs (must exit 0, must write no content)
//   3. backs up ~/.claude/settings.json and ~/.claude/eta/eta-hook.mjs to ~/.claude/backups/*.pre-eta-v3-<stamp>;
//      a file that did not exist is recorded with a "<name>.absent" marker, and --rollback deletes it again
//   4. replaces (or creates) ~/.claude/eta/eta-hook.mjs with collector/eta-hook.mjs (temp file + rename)
//   5. adds the missing hook events to settings.json (created if absent); hooks are never removed, every other key and
//      hook is left exactly as it was; the result is re-parsed before an atomic replace
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const P = {
  settings: path.join(HOME, ".claude", "settings.json"),
  hook: path.join(HOME, ".claude", "eta", "eta-hook.mjs"),
  backups: path.join(HOME, ".claude", "backups"),
  source: path.join(ROOT, "collector", "eta-hook.mjs"),
  fragment: path.join(ROOT, "collector", "hooks.settings-fragment.json"),
};
export const BASE_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "Notification", "SessionEnd"];
export const NEW_EVENTS = ["StopFailure", "PermissionRequest", "PermissionDenied", "PreCompact", "PostCompact", "PostModelSwitch"];
export const ALL_EVENTS = [...BASE_EVENTS, ...NEW_EVENTS];

const isCollector = (h) => /eta-hook\.mjs/.test(h?.command || "");
const hasCollector = (groups) => Array.isArray(groups) && groups.some((g) => g?.hooks?.some(isCollector));

// Pure: the hook command for a home directory (backslashes become forward slashes so it works in any shell).
export function collectorCommand(homeDir) { return `node "${String(homeDir).replace(/\\/g, "/").replace(/\/+$/, "")}/.claude/eta/eta-hook.mjs"`; }

// Pure: the record version (`v: N` in recordFor) of a collector file's text, or null.
export function collectorRecordVersion(text) { const m = /out = \{[^}]*\bv: (\d+)/.exec(text || ""); return m ? Number(m[1]) : null; }

// Pure: settings object → { settings, added, firstTime }.
// Upgrade: the command is copied from the existing collector entry so paths stay exactly as installed, and only
// NEW_EVENTS are considered. First-time (no collector hook anywhere): the template is built from homeDir and every
// event in ALL_EVENTS is added. `events` overrides the event list in either mode.
export function mergeHooks(settings, events, homeDir = os.homedir()) {
  const s = JSON.parse(JSON.stringify(settings));
  if (s.hooks === undefined) s.hooks = {};
  if (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)) throw new Error("settings.hooks is not an object; refusing to change it");
  let template = s.hooks.Stop?.find?.((g) => g?.hooks?.some(isCollector));
  if (!template) for (const groups of Object.values(s.hooks)) { template = Array.isArray(groups) ? groups.find((g) => g?.hooks?.some(isCollector)) : undefined; if (template) break; }
  const firstTime = !template;
  if (firstTime) template = { hooks: [{ type: "command", command: collectorCommand(homeDir), timeout: 5 }] };
  const list = events || (firstTime ? ALL_EVENTS : NEW_EVENTS);
  const added = [];
  for (const ev of list) {
    const groups = s.hooks[ev] || [];
    if (hasCollector(groups)) continue; // already there
    s.hooks[ev] = [...groups, JSON.parse(JSON.stringify(template))];
    added.push(ev);
  }
  return { settings: s, added, firstTime };
}

function probe(hookFile) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eta-v3-probe-"));
  const SECRET = "PROBE-SECRET-VALUE";
  const inputs = [
    { hook_event_name: "StopFailure", session_id: "probe", error: "rate_limit", error_details: "429 x", last_assistant_message: SECRET },
    { hook_event_name: "PermissionRequest", session_id: "probe", tool_name: "Bash", tool_input: { command: SECRET } },
    { hook_event_name: "PostToolUse", session_id: "probe", tool_name: "Bash", tool_use_id: "t", duration_ms: 5, tool_input: { command: `echo ${SECRET}` }, tool_response: { stdout: SECRET } },
  ];
  try {
    for (const inp of inputs) {
      const r = spawnSync(process.execPath, [hookFile], { input: JSON.stringify(inp), env: { ...process.env, USERPROFILE: scratch, HOME: scratch }, timeout: 10e3 });
      if (r.status !== 0) throw new Error(`probe: collector exited ${r.status} for ${inp.hook_event_name}`);
    }
    const log = fs.readFileSync(path.join(scratch, ".claude", "eta", "events.jsonl"), "utf8");
    if (log.includes(SECRET)) throw new Error("probe: content leaked into the log");
    if (log.trim().split("\n").length !== inputs.length) throw new Error("probe: unexpected number of log lines");
    return log.trim().split("\n").map((l) => JSON.parse(l).ev);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.v3tmp-${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

function readSettings() {
  if (!fs.existsSync(P.settings)) return { text: null, json: {} };
  const text = fs.readFileSync(P.settings, "utf8");
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${P.settings} is not valid JSON (${e.message}); nothing was changed. Fix or move that file, then run this again.`); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${P.settings} is not a JSON object; nothing was changed.`);
  return { text, json };
}

const backupOf = (name, stamp) => path.join(P.backups, `${name}.pre-eta-v3-${stamp}`);

function rollback(stamp) {
  if (!/^\d{8}-\d{6}$/.test(stamp || "")) throw new Error("usage: --rollback <YYYYMMDD-HHMMSS>");
  const items = [["settings.json", P.settings], ["eta-hook.mjs", P.hook]].map(([n, target]) => {
    const b = backupOf(n, stamp);
    if (fs.existsSync(b)) return { target, b, kind: "restore" };
    if (fs.existsSync(`${b}.absent`)) return { target, kind: "remove" };
    throw new Error(`backup missing: ${b}`);
  });
  for (const it of items) if (it.kind === "restore" && it.target === P.settings) JSON.parse(fs.readFileSync(it.b, "utf8"));
  for (const it of items) {
    if (it.kind === "restore") { fs.mkdirSync(path.dirname(it.target), { recursive: true }); fs.copyFileSync(it.b, it.target); console.log(`restored ${it.target} from ${stamp}`); }
    else { fs.rmSync(it.target, { force: true }); console.log(`removed ${it.target} (it did not exist before the install)`); }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--rollback") return rollback(argv[1]);
  const apply = argv.includes("--apply"), force = argv.includes("--force");
  for (const f of [P.source, P.fragment]) if (!fs.existsSync(f)) throw new Error(`missing: ${f}`);
  const { text: settingsText, json: settingsJson } = readSettings();
  const { settings, added, firstTime } = mergeHooks(settingsJson, undefined, HOME);
  const sourceText = fs.readFileSync(P.source, "utf8");
  const hookText = fs.existsSync(P.hook) ? fs.readFileSync(P.hook, "utf8") : null;
  const newV = collectorRecordVersion(sourceText), oldV = collectorRecordVersion(hookText);
  if (oldV !== null && newV !== null && oldV > newV && !force) throw new Error(`the installed collector is newer (record version v${oldV}) than this repository's (v${newV}); refusing to downgrade. Re-run with --force only if you really want that. Nothing was changed.`);
  const events = probe(P.source);
  const same = hookText === sourceText;
  console.log(`mode: ${firstTime ? "FIRST-TIME install (no collector hook found in settings)" : "UPGRADE (existing collector hooks found; their command is reused)"}`);
  console.log(`probe ok: collector logged ${events.join(", ")} with no content`);
  console.log(`collector file: ${hookText === null ? "will be created" : same ? "already current" : "will be replaced"} (${P.hook})`);
  console.log(`settings file: ${settingsText === null ? "does not exist, will be created" : "exists"} (${P.settings})`);
  console.log(`events to add (${added.length}): ${added.length ? added.join(", ") : "none, all already present"}`);
  if (!apply) { console.log("dry run: nothing changed. Re-run with --apply to install."); return; }
  if (same && !added.length) { console.log("nothing to do: already up to date."); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  fs.mkdirSync(P.backups, { recursive: true });
  const bs = backupOf("settings.json", stamp), bh = backupOf("eta-hook.mjs", stamp);
  for (const [b, text] of [[bs, settingsText], [bh, hookText]]) {
    if (text === null) fs.writeFileSync(`${b}.absent`, "");
    else { fs.writeFileSync(b, text); if (fs.readFileSync(b, "utf8") !== text) throw new Error("backup verification failed; nothing changed"); }
  }
  console.log(`backups: ${settingsText === null ? bs + ".absent (no previous file)" : bs}\n         ${hookText === null ? bh + ".absent (no previous file)" : bh}`);
  if (!same) writeAtomic(P.hook, sourceText);
  if (added.length) { const out = JSON.stringify(settings, null, 2) + "\n"; JSON.parse(out); writeAtomic(P.settings, out); }
  const check = mergeHooks(JSON.parse(fs.readFileSync(P.settings, "utf8")), undefined, HOME);
  if (check.added.length) throw new Error(`verification: ${check.added.join(",")} still missing; roll back with --rollback ${stamp}`);
  console.log(`installed the collector (${firstTime ? "first-time" : "upgrade"}). New Claude Code sessions pick up the hooks; already-open sessions may need a restart.`);
  console.log(`rollback: node tools/install-collector-v3.mjs --rollback ${stamp}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (e) { console.error(`install-collector-v3: ${e.message}`); process.exit(1); } }
