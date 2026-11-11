#!/usr/bin/env node
// Collector v3 installer. Run it yourself, not through an agent: Claude Code's self-modification guard
// rightly stops an agent from editing ~/.claude/settings.json. Nothing here bypasses that guard.
//
//   node tools/install-collector-v3.mjs              dry run: checks everything, prints the plan, changes nothing
//   node tools/install-collector-v3.mjs --apply      backs up both files, installs, verifies
//   node tools/install-collector-v3.mjs --rollback <stamp>   restores the two backups taken by that --apply
//
// What --apply does, in order (it stops at the first failure, before anything is changed where possible):
//   1. probes the new collector in a scratch home with sample hook inputs (must exit 0, must write no content)
//   2. backs up ~/.claude/settings.json and ~/.claude/eta/eta-hook.mjs to ~/.claude/backups/*.pre-eta-v3-<stamp>
//   3. replaces ~/.claude/eta/eta-hook.mjs with collector/eta-hook.mjs (temp file + rename)
//   4. adds the hook events missing from settings.json (StopFailure, PermissionRequest, PermissionDenied, PreCompact,
//      PostCompact, PostModelSwitch) with the same command as the existing collector entries; every other key and
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
export const NEW_EVENTS = ["StopFailure", "PermissionRequest", "PermissionDenied", "PreCompact", "PostCompact", "PostModelSwitch"];

// Pure: settings object → { settings, added } with the missing collector events added. The command is copied from
// the existing collector entry so paths stay exactly as installed.
export function mergeHooks(settings, events = NEW_EVENTS) {
  const s = JSON.parse(JSON.stringify(settings));
  s.hooks = s.hooks || {};
  const template = s.hooks.Stop?.find((g) => g.hooks?.some((h) => /eta-hook\.mjs/.test(h.command || "")));
  if (!template) throw new Error("no existing collector entry under hooks.Stop: install the collector once first, see the README section on the collector");
  const added = [];
  for (const ev of events) {
    const groups = s.hooks[ev] || [];
    if (groups.some((g) => g.hooks?.some((h) => /eta-hook\.mjs/.test(h.command || "")))) continue; // already there
    s.hooks[ev] = [...groups, JSON.parse(JSON.stringify(template))];
    added.push(ev);
  }
  return { settings: s, added };
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

function writeAtomic(file, text) { const tmp = `${file}.v3tmp-${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--rollback") {
    const stamp = argv[1]; if (!/^\d{8}-\d{6}$/.test(stamp || "")) throw new Error("usage: --rollback <YYYYMMDD-HHMMSS>");
    const bs = path.join(P.backups, `settings.json.pre-eta-v3-${stamp}`), bh = path.join(P.backups, `eta-hook.mjs.pre-eta-v3-${stamp}`);
    for (const f of [bs, bh]) if (!fs.existsSync(f)) throw new Error(`backup missing: ${f}`);
    JSON.parse(fs.readFileSync(bs, "utf8"));
    fs.copyFileSync(bs, P.settings); fs.copyFileSync(bh, P.hook);
    console.log(`restored ${P.settings} and ${P.hook} from ${stamp}`); return;
  }
  const apply = argv.includes("--apply");
  for (const f of [P.settings, P.hook, P.source, P.fragment]) if (!fs.existsSync(f)) throw new Error(`missing: ${f}`);
  const settingsText = fs.readFileSync(P.settings, "utf8");
  const { settings, added } = mergeHooks(JSON.parse(settingsText));
  const events = probe(P.source);
  const same = fs.readFileSync(P.source, "utf8") === fs.readFileSync(P.hook, "utf8");
  console.log(`probe ok: collector v3 logged ${events.join(", ")} with no content`);
  console.log(`collector file: ${same ? "already v3" : "will be replaced"} (${P.hook})`);
  console.log(`settings: ${added.length ? "will add " + added.join(", ") : "all v3 events already present"} (${P.settings})`);
  if (!apply) { console.log("dry run: nothing changed. Re-run with --apply to install."); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  fs.mkdirSync(P.backups, { recursive: true });
  const bs = path.join(P.backups, `settings.json.pre-eta-v3-${stamp}`), bh = path.join(P.backups, `eta-hook.mjs.pre-eta-v3-${stamp}`);
  fs.copyFileSync(P.settings, bs); fs.copyFileSync(P.hook, bh);
  if (fs.readFileSync(bs, "utf8") !== settingsText) throw new Error("backup verification failed; nothing changed");
  console.log(`backups: ${bs}\n         ${bh}`);
  if (!same) writeAtomic(P.hook, fs.readFileSync(P.source, "utf8"));
  if (added.length) { const out = JSON.stringify(settings, null, 2) + "\n"; JSON.parse(out); writeAtomic(P.settings, out); }
  const check = mergeHooks(JSON.parse(fs.readFileSync(P.settings, "utf8")));
  if (check.added.length) throw new Error(`verification: ${check.added.join(",")} still missing; roll back with --rollback ${stamp}`);
  console.log(`installed collector v3. New Claude Code sessions pick up the hooks; already-open sessions may need a restart.`);
  console.log(`rollback: node tools/install-collector-v3.mjs --rollback ${stamp}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (e) { console.error(`install-collector-v3: ${e.message}`); process.exit(1); } }
