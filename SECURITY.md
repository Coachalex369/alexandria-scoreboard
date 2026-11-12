# Security policy

Alexandria Scoreboard is a development preview. Security fixes are made on the `main` branch; there are no supported binary
releases yet.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on
https://github.com/Coachalex369/alexandria-scoreboard. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within
7 days.

## Scope notes

- The app runs locally and binds only to `127.0.0.1`; reports about remote exposure of the local server are in scope.
- The Alexandria collector is a Claude Code hook that must never write prompt text, code, command arguments or tool
  output to its log. Any way to make it record such content is a vulnerability.
- Unsigned local builds and Windows Smart App Control behaviour are documented limitations, not vulnerabilities.

## Advisories

### Here-doc content recorded as command signatures (fixed in Alexandria Protocol 3.2.1)

- **Affected versions published here:** the Alexandria collector in Alexandria Protocol **3.1.1** and **3.2.0**.
- **What happened:** for a Bash or PowerShell command that writes a file with a here-doc (`cat > file <<'EOF' … EOF`)
  or a PowerShell here-string (`@' … '@`), the collector split the written text line by line and could record the
  first word of those lines in the `segs` field of its log, as if they were command names. Nothing else of the written
  content was recorded.
- **Exposure:** the log (`~/.claude/eta/events.jsonl`) stays on your machine; neither the collector nor the app
  transmits it.

What to do, two separate steps:

1. **Stop future recording: install the fixed collector.** Update to this version and run
   `node tools/install-collector-v3.mjs --apply`. From then on here-doc and here-string bodies are skipped entirely.
   Installing the fix does **not** change anything already written to your log.
2. **Decide about the existing log.** Words recorded before the update remain in `~/.claude/eta/events.jsonl` until you
   remove them. Delete that file to clear them; the trade-off is that this also deletes all recorded activity history
   (the collector starts a new log with the next Claude Code event). Keeping the file keeps your history and the
   recorded words, which never leave your machine.
