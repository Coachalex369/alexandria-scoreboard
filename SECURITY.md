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

### The 3.2.1 fix was incomplete: here-doc content could still be recorded (fixed in Alexandria Protocol 3.2.2)

- **Affected versions published here:** the Alexandria collector in Alexandria Protocol **3.1.1**, **3.2.0** and
  **3.2.1**. The 3.2.1 fix below did not cover two cases.
- **What still happened in 3.2.1:**
  - a here-doc inside a double-quoted command substitution whose text contains an odd number of double quotes, for
    example `git commit -m "$(cat <<'EOF' … EOF)"` with a `"` in the message (the way Claude Code writes commit
    messages);
  - a here-doc with a backslash-escaped delimiter (`<<\EOF`).

  In both cases the collector could record the first words of lines of the written text in the `segs` field of its
  log, as if they were command names.
- **Exposure:** unchanged from the advisory below: the log (`~/.claude/eta/events.jsonl`) stays on your machine; neither
  the collector nor the app transmits it.
- **Fix in 3.2.2:** commands are read by a new context-aware scanner, and privacy no longer depends on that parsing being
  exact. A recorded command signature now contains only allowlisted words: the program name from a list of known
  executables, the second word from a list of permitted subcommands for that program, and a `run` script name from a
  list of common script names. Anything else is written as `cmd`. When the app reads an existing log, signatures written
  by older collectors pass through the same rules, so words recorded earlier are not shown. Names of MCP servers that
  are not on a short list of public servers are written as `mcp__other__other`.

What to do, two separate steps (the same as below):

1. **Stop future recording: install the fixed collector** from this version
   (`node tools/install-collector-v3.mjs --apply`). Installing it does **not** change anything already written to your
   log.
2. **Decide about the existing log.** Words recorded before the update remain in `~/.claude/eta/events.jsonl` until you
   remove them (the app no longer displays them). Deleting the file clears them but also deletes all recorded activity
   history; keeping it keeps your history and the recorded words, which never leave your machine.

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
