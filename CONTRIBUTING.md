# Contributing to Alexandria Scoreboard

Thank you for your interest. Issues and pull requests are welcome.

## Before you start

- Open an issue to discuss larger changes first.
- Requirements: Node.js 22+, Windows 10/11 for the desktop shell (the browser version runs wherever Node does).
- `npm install`, then `npm test`: all tests must pass before a pull request.

## Shared protocol files

`collector/`, `packages/event-engine/`, `packages/taxonomy/`, `fixtures/` and `tools/install-collector-v3.mjs` are a
vendored copy of the Alexandria Protocol (version in `PROTOCOL_VERSION.json`). The test suite fails if they are edited
here; propose protocol changes in an issue instead.

## Privacy rules for contributions

- Never commit real Claude Code session data, transcripts, hook logs, screenshots of real sessions, personal paths or
  credentials. Use the synthetic recordings in `demo/recordings/` and fictional project names in tests and examples.
- The collector must stay content-free: timings, ids, tool names, counts and lengths only.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0 (see `LICENSE`).
