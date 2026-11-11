# Alexandria Scoreboard — operational board (`packages/scoreboard/`)

A working local Scoreboard that monitors real Claude Code activity from the collector's hook log, with a clearly
labelled demo mode. "Make the invisible work visible."

```
npm start                 →  http://127.0.0.1:4340/        (one command; no build step, no network)
npm test                  →  the full automated test suite
node tools/sb-mark.js …   →  declare task start / estimate / end and record test runs for the live session
```

## What it looks like

An older high-school gym basketball scoreboard: painted-steel blue housing, recessed black display windows,
individually lit 5×7 bulb-matrix digits (red scores, amber clocks and counters, green VERIFIED), painted white
labels, possession arrows, indicator lamps, four corner screws, a small "ALEXANDRIA LTD" maker's plate. The room
around it is dark. Beneath the board a collapsible steel "bench" panel holds the roster, events, predictions and
sessions. It is not a card dashboard.

## Mapping (every field carries a basis: observed · inferred · predicted · unavailable)

| Board field | Meaning for AI development | Basis | Dark when |
|---|---|---|---|
| **HOME** | completed tool calls in the current task (main thread + subagents) | observed | no task |
| **GUEST** | remaining tool calls = declared estimate − completed, floored at 0 | predicted | no declared estimate ("REMAINING · SCOPE UNKNOWN") |
| **GAME CLOCK** | ACTIVE time of the current task from the v0.2 stopwatch (`STOPWATCH_ETA_V02.md`): time after a turn stops (the user's move), approvals, questions, rate limits, API errors, declared pauses and external waits are excluded; silence inside an open turn beyond 10 min is `unknown`, not active | observed | no task |
| **SHOT CLOCK** | v0.2: calibrated p50 of REMAINING active time (conditional on time already spent), note shows the p10–p90 range and confidence; dark with the reason when there is no basis (`INSUFFICIENT DATA · n/6 TASKS`, `BEYOND HISTORY`) | predicted | insufficient data, beyond history, or task finished |
| **PERIOD** | turn number inside the task (prompt → stop cycles); sub-label says MARKED or INFERRED task | observed | no task |
| **FOULS** | tool failures + failed test runs; BONUS lamp at 5 | observed | — |
| **VERIFIED** | passing test runs + commits during the task; PASS/FAIL lamps show the latest test run; lamps off when no run was observed | observed | — |
| **TIMEOUTS** | user waits taken in the task (permission prompts, questions, idle prompts); WAITING lamp while one is open | observed | — |
| **PLAYER** | subagents running; sub-label names the most recently active actor and model | observed | — |
| **Possession arrows** | MAIN lit when the main thread acted last, AGENTS when a subagent did | observed | no actor |
| **Message line** | `PHASE · ACTOR`; a `?` marks an inferred phase (PLAN / RESEARCH / BUILD / TEST / REVIEW / COMMIT from the last five operations). WAIT, IDLE and DONE are facts | inferred / observed | — |
| **Lamps** | HRS (clock shows h:mm), RUNNING, TIMEOUT, IDLE (no events for 90 s; STALE after 30 min) | observed | — |

Rules that keep the numbers honest: `agent.stop` never completes a task; only `task.end` (a mark) or the turn
structure does. Nothing is predicted without a `task.estimate`. The basis legend under the board prints the basis of
each headline field at all times. Unavailable values show dim dashes, never a number.

Under the message window a stopwatch strip shows state (active / waiting:kind / paused / unknown, with basis), active vs waiting time by kind, the ETA range with method, n and confidence, the observed main-thread model and token counts.

## Data sources (live mode)

| Source | Facts it gives | How |
|---|---|---|
| Collector hook log `~/.claude/eta/events.jsonl` | sessions, prompts (length only), every tool result with duration, failures, subagent start/stop, permission and idle notifications, turn stops | `server.js` tails the file once a second and runs the existing `claude-hooks` adapter with stable ids |
| Marks `data/marks.events.jsonl` | task start/end, declared estimates (p50, p90, tool calls), recorded test runs | `tools/sb-mark.js` appends and POSTs to `/api/ingest`; the server tails the file |
| Git | commits of the project a live session works in, attributed to that session when they happen after it started | `git log` polled every 20 s for `<repo root>/<project>/.git` (roots: `SB_REPO_ROOTS`, default the home folder) |
| Collector (v3 and later) | command signature (`npm test`, `git commit`), pass/fail counts parsed from test output inside the hook, approval and rate-limit events | makes test results and waits automatic once the collector is installed |

Not observable from hooks today, shown explicitly as unknown: the main thread's model, a subagent's assignment text,
and task titles for inferred tasks. Subagent models are `declared` when the Agent call passed one.

### Concurrent sessions
Several Claude Code sessions log into the same file. The board follows the most recently active session unless one
is pinned in the SESSIONS tab. `sb-mark` targets `CLAUDE_CODE_SESSION_ID` when run inside a session, else the latest
session whose project matches the current folder, else the latest session (with a printed note).

## Demo mode

DEMO A (synthetic multi-agent, 11 min) and DEMO B (synthetic session, 10 min, failing test then fix) replay
`demo/recordings/*.events.jsonl` through the engine's `Replayer` at 1–100×. Every demo event is stamped
`provenance.synthetic`, the board shows a yellow "DEMO · SYNTHETIC DATA" ribbon and a DEMO signal lamp, the
roster says `synthetic` for models, and the bench status line names the recording. Live and demo never share a
`Board` instance; switching modes rebuilds the model. `?mode=demo:forge-demo-session` opens a demo directly.

## Alerts

| Event | Visual | Sound |
|---|---|---|
| permission prompt / AskUserQuestion | amber banner, TIMEOUT + WAITING lamps, clock stops | referee whistle |
| test run failed | red banner, FAIL lamp, foul | buzzer |
| task complete (`task.end`) | green banner, DONE | gym horn |
| session ended with a task open (abnormal reason) | red banner | buzzer (quiet for clear/logout/prompt exit) |
| turn complete | brief blue banner, log | none |

`AlertPolicy` suppresses a repeated identical alert for 10 s and spaces sounds at least 2.5 s apart. Alerts raised
while catching up on history (snapshot, or events older than 60 s) are visible but silent. Sounds come from
`src/horn.js` (synthesized, original) with their own mute (`m`), volume and test button, persisted in
localStorage. Muting never hides a banner or a lamp.

## Predictions

Only declared estimates create predictions. For each: estimate time, p50 / p90 / calls, the k applied, the ETA, and
after `task.end` the actual work time, actual calls, error ratio (estimate ÷ actual) and whether the actual fell
inside [0.4 × p50, p90]. The server persists completed records in `data/predictions.jsonl` and seeds calibration from
it on restart; k follows `ETA_METHOD.md` (exp(−median log ratio) over the last 20, clamped [0.25, 4], identity below
three samples).

## Architecture and independence

```
sources → adapters (event-engine) → alexandria.event/1 records → Board (pure) → page (DOM)
```
`src/board.js`, `src/eta.js`, `src/alerts.js` and `src/digits.js` are pure ES modules with no DOM or Node imports
(tested under node:test). `server.js` is the only Node piece: static files, the tails, the git poll, SSE
(`/api/stream`), `/api/status`, `/api/predictions`, `/api/ingest`.

## Desktop application (Windows, offline)

`desktop/main.js` is an Electron main process that starts `createScoreboardServer` in-process on a random loopback
port and opens the same page in a window; `desktop/preload.cjs` only tells the page it runs in the shell (so alert
sounds arm without a click). Nothing else changes: the browser version (`npm start`) remains the development and
test surface, and both share the data folder `~/.claude/eta/scoreboard/` (marks, predictions; `SB_DATA_DIR`
overrides) next to the hook log, so marks made by `sb-mark` show in either.

- Offline: no network calls, no auto-update, no telemetry. Development builds are unsigned (see
  `BUILDING_WINDOWS.md`).
- Menu: Scoreboard (Live / Demo A / Demo B, open data and hook-log
  folders), View (always on top, compact 70 %, zoom, full screen, reload, dev tools), Help (guide, About with the
  local port and source status). Single instance; external links open in the default browser.
- Packaging: `electron-builder` zip target for Windows x64 and ARM64, `build/icon.ico` generated by
  `tools/make-icon.js` (bulb-matrix "A" on the blue housing, no dependencies). See `BUILDING_WINDOWS.md`.
- Verification: `--smoke=<png>` loads the window, captures it from Electron and exits 0; used on both the repo run and
  the packaged exe.

## Verified

- Automated tests: board semantics (inference, marks adoption, waits stopping the clock, fouls, bonus, lamps,
  agent lifecycle, termination, idle/stale, focus, dedupe, declared models), prediction log (k, overdue, seeding),
  alert policy, bulb font and fitting, collector privacy (secrets in commands, prompts and output never written),
  signatures, test-count parsing, adapter v2 fields and stable ids, FileTail (partial lines, truncation), server
  (snapshot, live SSE, ingest, predictions persisted and restored, redirects, path traversal).
- Manual browser check: live board against a real hook log with several sessions; declared estimate lighting GUEST
  and SHOT CLOCK; demo B with ribbon, roster tree and possession arrow; mode switching; no console errors.

## Limitations and next steps

- Test results are only observed automatically when the collector (v3 or later) is installed; otherwise use
  `sb-mark tests`.
- Main-thread model and agent assignments are not in the hook data; the transcript adapter adds per-message model and
  token usage where transcripts are available.
- Commits are attributed by project name and time; a commit from another tool in the same repo during a session would
  count.
- The clock for inferred tasks starts at the prompt; the task ends at the last turn stop only when a new brief or a
  two-hour gap follows, so an inferred task can look "live" after work has stopped (the IDLE lamp and STALE word say so).
- Long-running stability: the server keeps all events in memory (~1 KB each; a day is a few hundred). A daily rollover
  is not yet implemented.
- Second-monitor mode and a signed installer are planned; see `ROADMAP.md`.
