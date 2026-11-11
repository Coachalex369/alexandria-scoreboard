# Stopwatch & ETA Engine v0.2

Implements ETA_METHOD.md's "estimator v0.2" with a measured
stopwatch underneath it. Engine: `packages/stopwatch/` (source-independent, browser-safe, boundary-tested). Wiring:
`packages/scoreboard/src/board.js`, `server.js`, `ledger.js`; adapters in `packages/event-engine/src/adapters/`.

## 1. What is observed and what is inferred

| State / event | Source | Basis |
|---|---|---|
| turn open (prompt submitted) | hook `UserPromptSubmit`, transcript human prompt | observed |
| turn closed, the user's move | hook `Stop`, transcript `turn_duration`, user interrupt `[Request interrupted…]` | observed |
| turn closed (old transcripts without `turn_duration`) | assistant `end_turn` before the next prompt | inferred |
| tool execution `[ts − duration_ms, ts]` | hook `PostToolUse.duration_ms` (documented to exclude permission time) | observed |
| subagent running | `SubagentStart`/`SubagentStop`, subagent transcript first/last record; a lost stop is capped at last evidence + 10 min | observed |
| approval wait | `Notification:permission_prompt`, `PermissionRequest` (collector v3) → ends when the approved tool began | observed (end derived from duration) |
| approval wait in history | transcript tool result with `permissionDecision.source = user`: the whole use→result gap (execution cannot be separated) | inferred, conservative |
| question wait | `AskUserQuestion` / `ExitPlanMode` run time; elicitation notifications | observed |
| rate limit | transcript API-error record `rate_limit` 429 with `quotaLimits.resetsAt`; hook `StopFailure` (v3); ends at the next prompt, `quota_auto_resume_fired` or the next tool start | observed |
| other API error | transcript / `StopFailure` error type | observed |
| declared pause, external wait (CI, review) | `sb-mark pause/resume`, `sb-mark wait <kind>/waited` | declared |
| unknown | an open turn with no evidence for longer than 10 min; a silence that ends at the next prompt or the task end, not at work, is unknown for its whole length | inferred |
| model | transcript assistant `message.model` (main and subagents), `SessionStart.model`, `PostModelSwitch` (v3) | observed |
| tokens | transcript `usage` per message id | observed |

Precedence on any instant: paused > rate_limit > api_error > approval > question > external > execution evidence >
user turn > unknown > turn open. Waiting time is never active time; a declared or observed wait is never hidden by an
inference; background subagent work outranks the user wait.

## 2. Elapsed-time measurement and persistence

The stopwatch is a pure interval sweep over signals, so its result does not depend on arrival order: a restarted
server that replays the append-only hook log, marks and transcripts rebuilds every open task exactly (tested).
Data directory (default `~/.claude/eta/scoreboard/`), all content-free:

- `tasks.jsonl`: completed task records, append-only, fsynced, one line per task id (replays never duplicate).
- `history.backfill.jsonl`: records rebuilt from local transcripts by `sb-calibrate backfill` (user briefs,
  subagent runs) plus the ten experiment tasks; replaced atomically.
- `checkpoint.json`: open tasks' totals, written atomically every 5 s. A task whose source log was truncated while open
  is recovered as a `partial` record, never used for calibration.
- `calibration.json`: the latest backtest; `eval/`: the controlled evaluation.

Records with no observed work (no tool call, no model response, or under 30 s active) are kept but excluded from
calibration. When the same work exists as a live record and a backfilled record, the backfilled one is dropped.

## 3. Estimator

Features known at the start only (never outcome-derived): `type` (declared with `sb-mark start --type`, or the agent
type for subagent runs), `model`, `regime` (brief / marked / subagent), `size` (brief length bucket).

1. **declared-calibrated**: declared p50 × measured actual/declared ratios of comparable history.
2. **reference-class**: actual active durations of comparable history.
3. **prior**: declared p50 with a fixed wide log-normal band, confidence low (no calibrated history yet).
4. **insufficient-data**: nothing declared and fewer than 6 comparable tasks; no number is shown.

Remaining time = quantiles of the history samples still above the elapsed active time (it grows on heavy tails; it is
not a countdown). Fewer than 3 such samples: "beyond history", lower bound only. With declared calls, this task's own
pace is blended in. Confidence: low unless the range is usefully narrow (p90/p10 ≤ 6 medium, ≤ 3 high) and backtests
show honest coverage. Strata back off type+model+regime → type+regime → type → regime → all; size/model strata were
measured and did not beat the default beyond noise (§5).

## 4. Evaluation method (no leakage)

`sb-calibrate evaluate`: rolling origin. A task is predicted only from tasks that ended before it started; overlapping
tasks and the controlled-evaluation hold-out set are never training data. Predictions are scored at 0 / 25 / 50 / 75 %
of the task's actual active time. Metrics: MdALE (median |ln(predicted p50 / actual)|; 0.69 = off by 2×), share within
2×, p10–p90 coverage (target 80 %), bias, sharpness (median p90/p10). Baseline: one global reference class.

`sb-eval`: the controlled evaluation. Predictions are written to `eval/runs.jsonl` before each run is launched; outcomes
come only from the run's own transcript; quality is a reviewed 0–3 score (3 = all acceptance criteria met, correct and
minimal; 2 = met with minor issues; 1 = partial; 0 = failed or wrong), labelled as the reviewer's judgement.

## 5. Results

All numbers were measured on one developer's data (a single account); yours will differ. Files are in `~/.claude/eta/scoreboard/`.

### 5.1 Historical backtest (rolling origin, `sb-calibrate evaluate`)

A local history of content-free records (user briefs and subagent runs rebuilt from the author's own transcripts, plus
ten tasks with declared estimates); 37 records without observed work excluded; the 16 evaluation runs predicted but never
trained on.

| Regime (at task start) | n | MdALE | within 2× | p10–p90 coverage |
|---|---|---|---|---|
| user briefs, reference class | 146 | 0.78 | 45 % | 75 % |
| subagent runs, reference class (incl. the 16 held-out eval runs) | 70 | 1.24 | 29 % | 47 % |
| declared estimates (live experiment, prior until 6 samples) | 10 | 1.31 | 10 % | 20 % |

User briefs, all checkpoints: MdALE 0.99 → 0.79 → 0.47 → 0.57 at 0 / 25 / 50 / 75 % of the task; coverage 66–70 %
until half-way, 51 % at 75 % (late in a task the conditional tail still expects more work than remains: bias +0.6).
Ranges are wide at the start (median p90/p10 ≈ 19): honest, not useful for planning a single brief, which is why the
board labels them low confidence. Strata by brief length or model did not beat one reference class beyond noise.

In that history, waits after a turn ended, rate-limit pauses and open turns with no evidence together exceeded the
active time several times over; a naive stopwatch (and the v0.1 board) would have counted much of it as work.

### 5.2 Controlled evaluation (16 runs, `sb-eval`)

Ten representative tasks on this repository (mechanic, refactor, tests, two builders, research, review, scout,
CLI flag, desktop menu), run by subagents from clean worktrees at the same base commit with identical briefs, plus
repeats (T01 Haiku, T02 Sonnet, T03 Sonnet, T04 Sonnet) and cross-model runs (T03 Haiku vs Sonnet; T04 Opus vs
Sonnet). Predictions were written before each launch from the calibration store as it was before the evaluation.

| Predictor | MdALE | bias | within 2× | p10–p90 coverage |
|---|---|---|---|---|
| Agent's declared estimate, raw | 2.49 | +2.49 (≈ 12× too long) | 0 / 16 | – |
| **v0.2 declared-calibrated** | **0.71** | +0.71 (≈ 2× too long) | **8 / 16** | **13 / 16 (81 %)** |
| v0.2 reference class (past subagent runs) | 2.49 | +2.49 | 0 / 16 | 1 / 16 |

Outcomes: active time 0.3–1.8 min per run (median 0.6), 5–15 tool calls; all 16 runs passed their acceptance check
(tests re-run by the main session in every worktree); quality 3 in 13 runs, 2 in 3 (T06 forwarder sketch omits the
session id; T08 one wrong claim; T10 inaccurate rationale after an error in the task spec).

Repeats from clean starts (active minutes): T02 Sonnet 0.32 / 0.37; T01 Haiku 0.59 / 0.72 (8 vs 15 calls, the extra
calls on environment setup); T03 Sonnet 0.54 / 0.55; T04 Sonnet 1.25 / 0.72. Spread 1.03–1.74×, quality identical.

Cross-model (where both models suit the task): T03 Haiku 0.60 vs Sonnet 0.54 / 0.55 min; T04 Opus 0.78 vs Sonnet
1.25 / 0.72 min; quality 3 in every case. With one or two runs per cell these differences are within the repeat
spread: no model ranking can be claimed from this evaluation. Token counts were recorded per run; no dollar cost is
reported because no billing data was observed.

### 5.3 What the evidence says

- Declared estimates are the strongest signal, but only after calibration: raw estimates were 12× too long here
  (2.4–6× in the earlier study); ten calibration samples cut the error to 2× with honest ranges.
- Reference classes do not transfer between populations: past delegations (median 5–9 min) said nothing useful about
  tightly briefed micro-tasks. Keep the regimes and agent types apart, and expect "low" confidence for new kinds of work.
- The 16 evaluation runs are now declared-vs-actual subagent history; once they leave the hold-out set the declared
  method for delegated micro-tasks has 26 samples instead of 10.

## 6. Known limits

- Live approval waits rely on `permission_prompt` notifications unless collector v3 or later is installed.
- Transcript formats are internal to Claude Code; the adapter reads defensively and the hooks remain primary.
- The legacy session wait still drives `sessionStatus` and some lamps; it can disagree with the stopwatch for an
  idle prompt without a task (eval run T08 inventory). The GAME CLOCK and the ETA use the stopwatch only.
- A task over its declared call budget gets no pace adjustment; the clock shows ≥ 99 hours with real minutes.
- Windows: unsigned builds can be blocked by Smart App Control; see `BUILDING_WINDOWS.md`.


## 7. Installing collector v3 or later

Claude Code blocks agents from editing `~/.claude/settings.json`, so you run the installer yourself from this repository.
The installer upgrades an existing collector entry; for a first-time install see the README ("Collector"):

```
node tools/install-collector-v3.mjs            # dry run: probe + plan, changes nothing
node tools/install-collector-v3.mjs --apply    # backups, install, verification, prints the rollback command
node tools/install-collector-v3.mjs --rollback <stamp>
```

Manual equivalent for an existing collector, if preferred:
1. `copy %USERPROFILE%\.claude\settings.json %USERPROFILE%\.claude\backups\settings.json.pre-eta-v3-manual` and the same
   for `%USERPROFILE%\.claude\eta\eta-hook.mjs`.
2. Copy `collector\eta-hook.mjs` over `%USERPROFILE%\.claude\eta\eta-hook.mjs`.
3. In `settings.json` → `hooks`, add `StopFailure`, `PermissionRequest`, `PermissionDenied`, `PreCompact`, `PostCompact`,
   `PostModelSwitch`, each with the same entry the existing `Stop` hook has (see `collector/hooks.settings-fragment.json`).
4. Start a new Claude Code session; the next hook lines in `~/.claude/eta/events.jsonl` carry `"v":3`.
Rollback: copy the two backups back.

Overhead: the six events are rare (permission dialogs, API errors, compaction, model switches); each costs one Node
start (~0.25 s). `PermissionRequest` runs before the dialog appears; the collector prints nothing, so it never
influences the permission decision.
