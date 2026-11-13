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

// 3.2.2: MCP server names are user-chosen and can identify clients: written only on an exact allowlist match.
export const MCP_SERVER_ALLOWLIST = new Set(['claude-in-chrome', 'playwright', 'github', 'filesystem', 'fetch', 'context7']);
export function mcpTool(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return name;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m && MCP_SERVER_ALLOWLIST.has(m[1]) ? name : 'mcp__other__other';
}

const COMMIT_LINE = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s/m;

export function signature(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const cdm = trimmed.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*([\s\S]+)$/); // "cd dir && real command" (dir may be quoted): describe the real command
  if (cdm) return signature(cdm[1]);
  const toks = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) || [];                    // quoted executable paths stay one token
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift(); // drop VAR=value prefixes entirely
  if (!toks.length) return null;
  if (/[<>]/.test(toks[0])) return 'cmd';                       // a redirection or here-doc operator is not a command name
  let tok0 = toks[0].replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|sh|ps1)$/i, ''); // basename only
  if (/[=:@]/.test(tok0)) tok0 = tok0.replace(/[=:@].*$/, '');            // never carry user:token or key=value
  tok0 = EXECUTABLE_ALLOWLIST.get(tok0.toLowerCase()) || 'cmd'; // v6: executable names only from the allowlist, anything else is "cmd"
  // A second token is kept only for tools whose first argument is a subcommand (never for echo, curl, node …).
  if (tok0.toLowerCase() === 'node' && toks[1] === '--test') return 'node --test'; // test runner flag is a fixed word, never a value
  // v6.1: for npx / pnpm dlx / yarn dlx the next non-flag word is the PACKAGE, i.e. the executable: allowlist it.
  const lc0 = tok0.toLowerCase();
  const runner = lc0 === 'npx' ? 1 : (lc0 === 'pnpm' || lc0 === 'yarn') && toks[1] === 'dlx' ? 2 : 0;
  if (runner) {
    let k = runner; while (k < toks.length && /^-/.test(toks[k])) k++;
    const pkg = toks[k] ? EXECUTABLE_ALLOWLIST.get(toks[k].replace(/^["']|["']$/g, '').toLowerCase()) : null;
    const head = runner === 2 ? `${tok0} dlx` : tok0;
    return toks[k] ? `${head} ${pkg || 'cmd'}` : head;
  }
  // Owner decision 2026-11-12: privacy rests on ALLOWLISTS, not on parsing being exact. The second word is written only
  // when it is a permitted subcommand of that tool (SECOND_WORDS); any other word becomes "cmd". A flag or path is dropped.
  const allowed = SECOND_WORDS.get(lc0);
  if (!allowed || !toks[1] || /^-/.test(toks[1])) return tok0;
  const w1 = toks[1].replace(/^["']|["']$/g, '').toLowerCase();
  const tok1 = allowed.has(w1) ? w1 : 'cmd';
  // a package-manager script name ("npm run build"): only from the script allowlist, anything else is "cmd"
  if (tok1 === 'run' && /^(npm|pnpm|yarn|bun)$/i.test(tok0)) { const s = scriptName(toks[2]); return s ? `${tok0} run ${s}` : `${tok0} run`; }
  return `${tok0} ${tok1}`;
}
// Second words permitted per tool. Lowercase. Anything else is written as "cmd".
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
export const SECOND_WORDS = new Map(Object.entries({
  git: words('status diff log show add commit push pull fetch merge rebase checkout switch branch reset restore stash tag init clone remote config rev-parse ls-files worktree cherry-pick revert blame grep mv rm clean describe shortlog bisect submodule apply am format-patch archive bundle gc fsck reflog notes show-ref for-each-ref cat-file'),
  npm: words('test run install ci i uninstall update ls list init publish pack audit exec x start version view outdated link prune dedupe cache config help rebuild t'),
  pnpm: words('test run install add remove update exec dlx build lint dev start i list why outdated store'),
  yarn: words('test run install add remove upgrade dlx build lint dev start info why workspace workspaces'),
  bun: words('test run install add remove update x build dev start'),
  cargo: words('build test run check clippy fmt add new init update doc bench publish install tree'),
  go: words('build test run vet fmt mod get install generate env version list tool'),
  dotnet: words('build test run restore publish new add clean pack format tool sln watch'),
  docker: words('build run ps images pull push compose exec logs stop start rm rmi tag login inspect network volume system buildx'),
  gh: words('pr issue repo release run workflow api auth gist browse search secret label status'),
  wrangler: words('deploy dev login whoami tail publish kv r2 d1 pages secret init types versions'),
  cf: words('deploy dev build login whoami'),
  pip: words('install uninstall list show freeze download'), pip3: words('install uninstall list show freeze download'),
  python: words('-m'), python3: words('-m'),
  make: words('all build test clean install lint check run dist release'),
  gradle: words('build test clean assemble check run tasks'), gradlew: words('build test clean assemble check run tasks'),
  mvn: words('test package install clean verify compile'),
  kubectl: words('get apply delete describe logs exec rollout config create scale port-forward'),
  flyctl: words('deploy launch status logs secrets apps ssh scale'),
  eas: words('build submit update login init'),
  gcloud: words('app run functions config auth compute projects builds'),
  aws: words('s3 lambda ec2 iam sts cloudformation configure logs dynamodb'),
  az: words('login account webapp functionapp storage group deployment'),
  render: words('deploys services blueprint login'),
  claude: words('mcp plugin config update doctor'),
}));
// Script names for `npm|pnpm|yarn|bun run <script>`: a known name, optionally with one known suffix (test:unit, build:win).
const SCRIPT_BASES = words('test build lint typecheck check dev start dist compile format e2e coverage preview deploy release package pack clean watch serve storybook docs manifest sync desktop scoreboard engine');
const SCRIPT_SUFFIXES = words('unit e2e integration watch ci prod dev win mac linux x64 arm64 zip all dir fix');
function scriptName(tok) {
  if (typeof tok !== 'string') return null;
  const m = tok.replace(/^["']|["']$/g, '').toLowerCase().match(/^([a-z0-9]+)(?:[:._-]([a-z0-9]+))?$/);
  if (!m || !SCRIPT_BASES.has(m[1])) return tok ? 'cmd' : null;
  return m[2] === undefined ? m[1] : SCRIPT_SUFFIXES.has(m[2]) ? `${m[1]}:${m[2]}` : 'cmd';
}
// Legacy parsers: a signature already stored by an older collector is passed through the same rules, so a word that
// is not allowlisted never reaches an event, fact or screen (owner decision 2026-11-12).
export function sanitizeSignature(sig) { if (typeof sig !== 'string' || !sig.trim()) return null; return signature(sig.replace(/\s+/g, ' ').trim()) || 'cmd'; }
// v6 (protocol 4.0.0): the only executable names a signature may carry. Script and tool names can identify projects or
// clients, so everything else is written as "cmd". Keys are lowercase, values the canonical spelling.
export const EXECUTABLE_ALLOWLIST = new Map(('git npm npx pnpm yarn bun node deno python python3 pip pip3 pytest cargo rustc rustup go dotnet docker gh wrangler cf make cmake ninja gradle gradlew mvn kubectl godot render flyctl eas gcloud aws az tsc eslint prettier jest vitest mocha tap bash sh zsh pwsh powershell cmd cat ls dir grep rg find head tail wc echo printf sed awk cd cp mv rm mkdir rmdir touch chmod curl wget tar zip unzip diff test which where timeout sleep ps kill tasklist taskkill tee sort uniq cut tr xargs env export set pwd type copy move del ren findstr jq ssh scp rsync ping code claude sb-mark ' +
  'Get-ChildItem Get-Content Set-Content Add-Content Select-String Test-Path Remove-Item Copy-Item Move-Item New-Item Get-Process Stop-Process Start-Process Invoke-WebRequest Invoke-RestMethod Get-Item Set-Location Get-Location Write-Output Write-Host Where-Object ForEach-Object Select-Object Sort-Object Measure-Object Out-File Out-Null Join-Path Split-Path Resolve-Path Get-Date ConvertTo-Json ConvertFrom-Json Test-Connection Get-Command').split(' ').map((n) => [n.toLowerCase(), n]));

// 4.0.0 (after two review rounds): ONE left-to-right scanner with a context stack replaces the line-based here-doc pre-pass
// and the quote splitter. Contexts: top level, '…', "…", $(…) and arithmetic ((…)); a backslash escapes the next character
// outside single quotes. A here-doc operator (`<<`, `<<-`, not `<<<`) is honoured only at top level or inside $(…) — the
// way Claude Code writes `git commit -m "$(cat <<'EOF' … EOF)"` — never inside a plain string or arithmetic. Its delimiter
// is any shell word (optional `\`, quotes removed). At the end of the line, the body lines are SKIPPED up to the delimiter
// line (exact; leading tabs stripped for <<-); an unterminated body skips the rest. A PowerShell here-string (`@'` / `@"`
// at the end of a line, outside quotes) is skipped up to its closing `'@` / `"@` line. Bodies never become segments.
// Segments split on && || ; | and newlines at top level only. `open` = the contexts did not close (untrusted split).
// A here-doc operator at str[0..]: "<<" [-] [blanks] WORD. The delimiter is the WHOLE shell word with quote removal, as
// bash does it: bare characters, '…', "…" (with \" and \\ escapes) and \x pieces are concatenated (round-3 review #1).
// Returns { len, delim, tabs } or null.
function heredocAt(str) {
  if (!str.startsWith('<<') || str[2] === '<') return null;
  let k = 2; const tabs = str[k] === '-'; if (tabs) k++;
  while (str[k] === ' ' || str[k] === '\t') k++;
  let delim = '', any = false;
  while (k < str.length) {
    const ch = str[k];
    if (/[\s;&|<>()]/.test(ch)) break;
    if (ch === "'") { const e = str.indexOf("'", k + 1); if (e < 0) return null; delim += str.slice(k + 1, e); k = e + 1; any = true; continue; }
    if (ch === '"') { let j = k + 1, part = ''; while (j < str.length && str[j] !== '"') { if (str[j] === '\\' && j + 1 < str.length) { part += str[j + 1]; j += 2; continue; } part += str[j++]; } if (j >= str.length) return null; delim += part; k = j + 1; any = true; continue; }
    if (ch === '\\') { if (k + 1 < str.length && str[k + 1] !== '\n') { delim += str[k + 1]; k += 2; any = true; continue; } break; }
    delim += ch; k++; any = true;
  }
  return any && delim ? { len: k, delim, tabs } : null;
}
function scan(command) {
  command = command.replace(/\r(?!\n)/g, '\n');          // a lone CR ends a line too (privacy: here-doc bodies end there)
  const segs = []; let cur = ''; const st = ['top']; const pending = [];
  const push = () => { const t = cur.trim(); if (t) segs.push(t); cur = ''; };
  const n = command.length; let i = 0;
  const skipLinesUntil = (from, done) => { // returns the index after the matching line, or n when none matches
    let j = from;
    while (j < n) { let e = command.indexOf('\n', j); if (e < 0) e = n; const line = command.slice(j, e).replace(/\r$/, ''); j = e + 1; if (done(line)) return j; }
    return n;
  };
  while (i < n) {
    const c = command[i], ctx = st[st.length - 1];
    if (c === '\n' || (c === '\r' && command[i + 1] === '\n')) {
      const after = i + (c === '\r' ? 2 : 1);
      if (pending.length) {
        let j = after;
        for (const h of pending.splice(0)) j = skipLinesUntil(j, (line) => (h.tabs ? line.replace(/^\t+/, '') : line) === h.delim);
        if (ctx === 'top') push(); else cur += ' ';
        i = j; continue;
      }
      if (ctx === 'top') push(); else cur += '\n';
      i = after; continue;
    }
    // Privacy over detection: a `<<WORD` inside a quoted string is not a here-doc in bash, but treating it as one only skips
    // lines (it can hide a command, never reveal content), so it is queued here too. Arithmetic ((…)) is exempt.
    if ((ctx === "'" || ctx === '"') && c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      // inside a quoted string the word ends where the string ends (its closing quote is not part of the delimiter)
      const end = command.indexOf(ctx, i + 2); const h = heredocAt(command.slice(i, end < 0 ? Math.min(n, i + 4096) : end));
      if (h) pending.push({ delim: h.delim, tabs: h.tabs });
    }
    if (ctx === "'") { cur += c; if (c === "'") st.pop(); i++; continue; }
    if (c === '\\' && command[i + 1] === '\n') { i += 2; continue; }                       // line continuation (round-3 review #2)
    if (c === '\\' && command[i + 1] === '\r' && command[i + 2] === '\n') { i += 3; continue; }
    if (c === '\\' && i + 1 < n) { cur += c + command[i + 1]; i += 2; continue; }
    if (ctx === '((') { if (c === ')' && command[i + 1] === ')') { st.pop(); cur += '))'; i += 2; continue; } cur += c; i++; continue; }
    if (ctx === '"') {
      if (c === '"') { st.pop(); cur += c; i++; continue; }
      if (c === '$' && command[i + 1] === '(') { const ar = command[i + 2] === '('; st.push(ar ? '((' : '$('); cur += ar ? '$((' : '$('; i += ar ? 3 : 2; continue; }
      cur += c; i++; continue;
    }
    // ctx is 'top' or '$('
    if (c === '$' && command[i + 1] === '(') { const ar = command[i + 2] === '('; st.push(ar ? '((' : '$('); cur += ar ? '$((' : '$('; i += ar ? 3 : 2; continue; }
    if (c === '(' && command[i + 1] === '(') { st.push('(('); cur += '(('; i += 2; continue; }
    if (ctx === '$(' && c === ')') { st.pop(); cur += c; i++; continue; }
    if (c === "'" || c === '"') { st.push(c); cur += c; i++; continue; }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      const h = heredocAt(command.slice(i, i + 4096));
      if (h) { pending.push({ delim: h.delim, tabs: h.tabs }); cur += '<<EOF'; i += h.len; continue; }
    }
    if (c === '@' && (command[i + 1] === "'" || command[i + 1] === '"') && /^[ \t]*(\r?\n|$)/.test(command.slice(i + 2))) {
      const close = command[i + 1] + '@';
      cur += '@' + command[i + 1] + close;
      let j = command.indexOf('\n', i); i = n;                 // continue right after the closing '@ / "@ (rest of that line kept)
      while (j >= 0 && j < n) {
        const start = j + 1; let e = command.indexOf('\n', start); if (e < 0) e = n;
        const line = command.slice(start, e);
        if (line.startsWith(close)) { i = start + close.length; break; }        // only at column 0, as PowerShell does (round-3 review #3)
        j = e < n ? e : -1;
      }
      continue;
    }
    if (ctx === 'top') {
      if (c === ';' || c === '|' || c === '\r') { push(); i++; continue; }
      if (c === '&' && command[i + 1] === '&') { push(); i += 2; continue; }
    }
    cur += c; i++;
  }
  push();
  return { segs, open: st.length > 1 };
}
// Kept for compatibility: the command with here-doc and here-string bodies removed (segments joined by newlines).
export function stripHeredocs(command) { const r = scan(String(command ?? '')); return { text: r.segs.join('\n'), unterminated: false }; }
function splitCore(command) { return scan(command); }
export function firstSignature(command) {
  if (typeof command !== 'string') return null;
  let parts = scan(command).segs;
  if (parts.length && /^cd(\s|$)/i.test(parts[0])) parts = parts.slice(1);
  return parts.length ? signature(parts[0]) : null;
}
export function splitSegments(command) { return typeof command === 'string' ? splitCore(command).segs : []; }

// v4: one redacted signature per segment (max 8). A leading "cd dir" segment is dropped, matching how sig describes the real command.
export function segmentSignatures(command) {
  if (typeof command !== 'string') return [];
  const core = splitCore(command);
  let parts = core.open ? core.segs.slice(0, 1) : core.segs;   // unbalanced quotes: the split is untrusted, keep the first segment only
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
    case 'PreToolUse': out.tool = mcpTool(ev.tool_name); out.tuid = ev.tool_use_id; break;
    case 'PermissionRequest': out.tool = mcpTool(ev.tool_name); break;                    // never tool_input / suggestions
    case 'PermissionDenied': out.tool = mcpTool(ev.tool_name); out.tuid = ev.tool_use_id; break; // never the reason
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
      out.tool = mcpTool(ev.tool_name); out.tuid = ev.tool_use_id;
      if (ev.duration_ms != null) out.durMs = ev.duration_ms;
      if (ev.tool_name === 'Agent' && ev.tool_input) { out.subType = ev.tool_input.subagent_type; out.subModel = ev.tool_input.model; }
      if (name === 'PostToolUseFailure') { out.failed = true; if (ev.is_interrupt === true) out.interrupted = true; }
      if ((ev.tool_name === 'Bash' || ev.tool_name === 'PowerShell') && ev.tool_input) {
        const sig = firstSignature(ev.tool_input.command);    // 3.2.2: from the scanned first segment, never the raw text
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
