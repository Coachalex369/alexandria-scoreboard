# Privacy, security, copyright and dependency licensing

## Privacy

- **Collected:** timestamps, event kinds, session/prompt/tool-use/agent ids, project folder name, tool
  names, tool durations, prompt *length*, subagent type and declared model, notification kind, git
  hashes/paths/line counts, test counts, parser counts and identifier names.
- **Never collected:** prompt text, tool inputs (commands, file contents, URLs), tool outputs, assistant
  messages, notification text, transcript paths, environment variables, credentials. The schema validator
  rejects payload keys that would carry content; the hook logger was verified with marker strings.
- **Storage:** JSONL files under the user's home (`~/.claude/eta/events.jsonl`, repo `demo/recordings/`).
  Nothing is sent anywhere. Sharing a recording is a deliberate file hand-off by the user.
- **Logger v5 (2026-11-12)** adds the lowercased extension of an edited file (`.md`, never the name or path) and
  registers PreToolUse only for AskUserQuestion/ExitPlanMode (tool name and id only).
- **Session facts (2026-11-12).** The local server reads Claude Code transcripts and `~/.claude/sessions/*.json` in
  memory to name sessions (Claude Code's own session title or a name the owner gave it), find the git root of the
  working directory, notice questions as they open and decide whether a reply ends with a question. Only the repo
  folder name, a short path hash, the branch, the label, tool names/ids and yes/no flags leave that code; the label is
  shown in the local UI and never written to the ledger or any file.
- **Identifier names from Tree-sitter** (function/class/test names) are the one semi-sensitive item; they
  are needed for the Workflow view. A per-project `redactNames` option is an easy addition if required.

## Security

- The hook command is `node <fixed path>` with a 5 s timeout, exits 0 with empty stdout, never blocks or
  injects context; it reads stdin only. To roll back, remove the hook entries from `~/.claude/settings.json` (the installer prints the exact rollback command and keeps a backup).
- No package in this repo opens network connections. The demo server binds 127.0.0.1 only and serves the
  repository root read-only.
- The only third-party runtime code is Tree-sitter WASM (sandboxed by design) and the JavaScript grammar.
  The runtime dependency set is small; see `THIRD_PARTY_NOTICES.md`.

## Copyright

- No copyrighted music, melodies, recordings or sound assets are used or reproduced; the audio is
  synthesized from scales at run time. Team "color presets" for the Scoreboard must stay colors only (no
  logos, names or trademarks).
- Ideas such as two clocks, log-median calibration and p50/p90 ranges are standard techniques and are re-implemented
  here; no third-party code was copied.

## Dependency licences

| Package | Version | Licence | Use |
|---|---|---|---|
| web-tree-sitter | 0.27.2 | MIT | parser runtime (WASM) |
| tree-sitter-javascript | 0.25.0 | MIT | JavaScript grammar (WASM shipped in the package) |
| node-addon-api, node-gyp-build | transitive | MIT | pulled by the grammar's native binding metadata; not built or used |

Electron (MIT) is the desktop runtime, and electron-builder (MIT) is a build tool that is not distributed. See
`THIRD_PARTY_NOTICES.md` for the full list of shipped components and their licences.
