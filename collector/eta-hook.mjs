// Alexandria Scoreboard event logger (collector). Appends ONE compact JSON line per hook event.
// Logs timing and identifiers only: no prompt text, no tool inputs/outputs, no file contents.
//
// v2 (2026-11-08) adds two content-free fields for Bash/PowerShell tool results:
//   sig    a redacted command signature: the first token plus a second token only when it is a plain word
//          (e.g. "npm test", "git commit", "node"), never arguments, paths, URLs or values
//   tests  pass/fail COUNTS parsed from the tool's output when the signature looks like a test run
//          ({ framework, passed, failed, skipped, ok, durationMs }); the output itself is never written
// Installation is a copy to ~/.claude/eta/eta-hook.mjs (see README); the hook settings do not change.
// The helpers are exported for tests; side effects run only when the file is executed directly.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const TEST_SIG = /^(npm (test|run test[\w:-]*)|npx (jest|vitest|mocha|tap)|node --test|pnpm test|yarn test|pytest|cargo test|go test|godot|dotnet test)/i;

const COMMIT_LINE = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s/m;

export function signature(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const cdm = trimmed.match(/^cd\s+\S+\s*(?:&&|;)\s*([\s\S]+)$/); // "cd dir && real command": describe the real command
  if (cdm) return signature(cdm[1]);
  const toks = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) || [];                    // quoted executable paths stay one token
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift(); // drop VAR=value prefixes entirely
  if (!toks.length) return null;
  let tok0 = toks[0].replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|sh|ps1)$/i, ''); // basename only
  if (/[=:@]/.test(tok0)) tok0 = tok0.replace(/[=:@].*$/, '');            // never carry user:token or key=value
  tok0 = tok0.slice(0, 24) || 'cmd';
  // A second token is kept only for tools whose first argument is a subcommand (never for echo, curl, node …).
  if (tok0.toLowerCase() === 'node' && toks[1] === '--test') return 'node --test'; // test runner flag is a fixed word, never a value
  const tok1 = SUBCOMMAND_TOOLS.has(tok0.toLowerCase()) && toks[1] && /^[a-z][a-z0-9:_-]{0,23}$/i.test(toks[1]) ? toks[1] : null;
  return tok1 ? `${tok0} ${tok1}` : tok0;
}
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'go', 'dotnet', 'docker', 'gh', 'wrangler', 'cf', 'pip', 'gradle', 'make', 'kubectl', 'godot', 'render', 'flyctl', 'eas', 'gcloud', 'aws', 'az']);

// v4: split a shell command into segments on && || ; | and newlines, never inside single or double quotes.
// A tokenizer only: nothing is evaluated. Returns trimmed non-empty segments (text stays in memory; only signatures are written).
export function splitSegments(command) {
  if (typeof command !== 'string') return [];
  const segs = []; let cur = '', q = null;
  const push = () => { const t = cur.trim(); if (t) segs.push(t); cur = ''; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '|' || c === String.fromCharCode(10) || c === String.fromCharCode(13)) { push(); continue; } // newline or CR
    if (c === '&' && command[i + 1] === '&') { push(); i++; continue; }
    cur += c;
  }
  push();
  return segs;
}

// v4: one redacted signature per segment (max 8). A leading "cd dir" segment is dropped, matching how sig describes the real command.
export function segmentSignatures(command) {
  let parts = splitSegments(command);
  if (parts.length && /^cd(\s|$)/i.test(parts[0])) parts = parts.slice(1);
  return parts.map((p) => signature(p)).filter(Boolean).slice(0, 8);
}

export function outputText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp === 'object') return [resp.stdout, resp.stderr, resp.output, resp.content].filter((x) => typeof x === 'string').join('\n');
  return '';
}

export function testCounts(text) {
  if (!text) return null;
  let m, framework = null, passed = null, failed = null, skipped = null;
  if ((m = text.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/))) { framework = 'node:test'; passed = +m[1]; failed = +m[2]; const s = text.match(/ℹ skipped (\d+)/); skipped = s ? +s[1] : 0; }
  else if ((m = text.match(/Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed/))) { framework = 'jest'; failed = +(m[1] || 0); skipped = +(m[2] || 0); passed = +m[3]; }
  else if ((m = text.match(/TOTAL: (\d+) passed, (\d+) failed/))) { framework = 'godot-runner'; passed = +m[1]; failed = +m[2]; }
  else if ((m = text.match(/=+ (?:(\d+) failed, )?(\d+) passed(?:, (\d+) skipped)?[^=\n]*=+/))) { framework = 'pytest'; failed = +(m[1] || 0); passed = +m[2]; skipped = +(m[3] || 0); }
  else if ((m = text.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/))) { framework = 'cargo'; passed = +m[2]; failed = +m[3]; }
  else if (/^(ok|not ok) \d+/m.test(text)) { framework = 'tap'; passed = (text.match(/^ok \d+/gm) || []).length; failed = (text.match(/^not ok \d+/gm) || []).length; }
  if (framework == null) return null;
  const d = text.match(/duration_ms ([\d.]+)/);
  return { framework, passed, failed, skipped, ok: failed === 0, durationMs: d ? Math.round(+d[1]) : null };
}

// v4 (2026-11-10) adds chain awareness for Bash/PowerShell results, still content-free:
//   segs    redacted signatures of every segment of a chained command (&& || ; | newline, outside quotes), only when
//           there is more than one (max 8); sig keeps meaning "signature of the first segment"
//   commit  { hash } (12 hex) when a segment is "git commit" and the output holds git's success summary line; never the message
//   tests   now also parsed when any segment, not just the first, is a test run; "node --test" keeps its flag in signatures
// v3 (2026-11-10, Stopwatch & ETA v0.2) adds content-free lifecycle events for the stopwatch:
//   StopFailure        turn ended on an API error: the error TYPE only (rate_limit, overloaded, …) and an HTTP
//                      status code when error_details starts with one; never last_assistant_message or details text
//   PermissionRequest  a permission dialog opened: tool name only (never tool_input)
//   PermissionDenied   auto mode denied a call: tool name and tool_use_id (never the reason text)
//   PreCompact / PostCompact  trigger (manual | auto)
//   PostModelSwitch    from/to model ids; SessionStart carries the model id when Claude Code provides it
//   effort             the session's effort level when present (a word such as "high")
//   PostToolUseFailure is_interrupt → interrupted: true
const API_ERRORS = new Set(['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown']);
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/; // model ids, effort words, notification types: nothing else passes
const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : typeof v === 'object' && v && typeof v.id === 'string' && WORD.test(v.id) ? v.id : undefined);

// Pure: hook input → the record that gets written. Exported so the test can check it never carries content.
export function recordFor(ev, name, t0) {
  const out = { ts: new Date(t0).toISOString(), ev: name, sid: ev.session_id, v: 4 };
  if (ev.prompt_id) out.pid = ev.prompt_id;
  if (ev.cwd) out.proj = basename(ev.cwd);                 // project folder name only
  if (ev.agent_id) out.agent = ev.agent_id;                // present inside subagent runs
  if (ev.agent_type) out.agentType = ev.agent_type;
  if (ev.permission_mode) out.perm = ev.permission_mode;
  if (word(ev.effort)) out.effort = word(ev.effort);
  switch (name) {
    case 'UserPromptSubmit': out.promptLen = (ev.prompt || '').length; break;   // length only
    case 'PreToolUse': out.tool = ev.tool_name; out.tuid = ev.tool_use_id; break;
    case 'PermissionRequest': out.tool = ev.tool_name; break;                    // never tool_input / suggestions
    case 'PermissionDenied': out.tool = ev.tool_name; out.tuid = ev.tool_use_id; break; // never the reason
    case 'StopFailure': {
      out.error = API_ERRORS.has(ev.error) ? ev.error : 'unknown';
      const st = typeof ev.error_details === 'string' && ev.error_details.match(/^\s*([1-5]\d\d)\b/);
      if (st) out.status = Number(st[1]);
      break;
    }
    case 'PreCompact': case 'PostCompact': if (ev.trigger === 'manual' || ev.trigger === 'auto') out.trigger = ev.trigger; break;
    case 'PreModelSwitch': case 'PostModelSwitch': if (word(ev.from_model)) out.fromModel = word(ev.from_model); if (word(ev.to_model)) out.toModel = word(ev.to_model); break;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      out.tool = ev.tool_name; out.tuid = ev.tool_use_id;
      if (ev.duration_ms != null) out.durMs = ev.duration_ms;
      if (ev.tool_name === 'Agent' && ev.tool_input) { out.subType = ev.tool_input.subagent_type; out.subModel = ev.tool_input.model; }
      if (name === 'PostToolUseFailure') { out.failed = true; if (ev.is_interrupt === true) out.interrupted = true; }
      if ((ev.tool_name === 'Bash' || ev.tool_name === 'PowerShell') && ev.tool_input) {
        const sig = signature(ev.tool_input.command);
        if (sig) out.sig = sig;
        const segs = segmentSignatures(ev.tool_input.command);
        if (segs.length > 1) out.segs = segs;                  // v4: chain awareness; sig still describes the first segment
        const all = segs.length ? segs : sig ? [sig] : [];
        const text = outputText(ev.tool_response);
        if (all.some((x) => TEST_SIG.test(x))) { const t = testCounts(text); if (t) out.tests = t; }
        if (name === 'PostToolUse' && all.includes('git commit')) { // v4: only git's success summary line; hash only, never the message
          const m = text.match(COMMIT_LINE);
          if (m) out.commit = { hash: m[1].toLowerCase().slice(0, 12) };
        }
      }
      break;
    }
    case 'Notification': out.kind = word(ev.notification_type || ev.type); break; // e.g. permission_prompt, idle_prompt, quota_auto_resume_fired
    case 'Stop': out.stopHookActive = !!ev.stop_hook_active; break;
    case 'SubagentStart': case 'SubagentStop': break;
    case 'SessionStart': out.source = ev.source; if (word(ev.model)) out.model = word(ev.model); break;
    case 'SessionEnd': out.reason = ev.reason; break;
  }
  return out;
}

async function run() {
  const t0 = Date.now();
  let raw = '';
  try { for await (const chunk of process.stdin) raw += chunk; } catch {}
  let ev = {};
  try { ev = JSON.parse(raw || '{}'); } catch {}
  const name = ev.hook_event_name || process.argv[2] || 'unknown';
  const out = recordFor(ev, name, t0);
  out.hookMs = Date.now() - t0;
  try {
    const dir = join(homedir(), '.claude', 'eta'); mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(out) + '\n');
  } catch {}
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run();
