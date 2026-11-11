# ETA methodology and experimental findings

This document summarises the method and the measurements behind the estimator. The study covered four phases: a
feasibility review of available data sources, a blind historical test of Claude's own estimates, a live experiment
on ten small tasks, and a calibration backtest (`node tools/sb-calibrate.js evaluate`).

## What Anthropic provides

No task-duration dataset, no cross-user statistics, no ETA feature. Only a published median Claude Code
turn (~45 s) with a 99.9th percentile over 45 minutes. Everything usable is local: hooks (PostToolUse
`duration_ms`, SubagentStart/Stop, Notification, Stop), statusline JSON (wall and API duration), OpenTelemetry
events, transcripts. Cross-user calibration would need an Anthropic agreement that does not exist.

## Measured facts (one developer's account; your numbers will differ)

| Dataset | n | median work | p75 | p90 | notes |
|---|---|---|---|---|---|
| historical user-brief tasks (local transcripts) | 144 | 13.2 min | 29 | 59.5 | sum of turn wall time minus user waits; heavy tail to 230 min |
| historical turns | 212 | 7.1 min | 19 | 44.7 | pace ≈ 19–24 s per tool call |
| live micro-tasks (10-task experiment) | 10 | 2.9 min | 6.2 | 13.7 | pace ≈ 30 s per tool call; tool execution ≈ 20% of the clock |
| subagents | 53 | researcher 1–3 min, scout 0.1–5, implementer Sonnet 7.7, Opus 46, reviewer 12 (Opus max 239) | | | linked to parent via toolUseId |

Remaining time grows with elapsed time (heavy tail): a task already 30 min in has a median 21 min left
and a p90 of two hours. A countdown that only decrements is wrong by construction.

## Prediction accuracy

| Estimator | historical blind test (20) | live experiment (10) |
|---|---|---|
| Claude raw estimate | 2.4× too long; 6/20 within 2× | 6.1× too long; 1/10 within 2× |
| historical median by category | unbiased, 10/20 within 2×, no resolution | n/a (micro-tasks) |
| Claude × k (k fitted) | k = 0.5 → 14/20 within 2× | k ≈ 0.16–0.33 → 5–6/10 within 2× |
| 25–75% ranges as given | covered 25–55% | covered 0–50% |

Claude's estimates are consistently too long but carry ranking information on brief-sized tasks (and
little on micro-tasks, Spearman 0.28). What is mis-estimated is the *number of tool calls*, not the pace.

## Estimator v0.2 (to implement in the Scoreboard)

```
calls_est  = Claude's forecast of tool calls (asked at task start; or edits × 1.6 + checks)
pace       = rolling median seconds per main-thread tool call for this user (≈ 25 s today)
long_tools = Σ median duration of the slow commands the task will run (test suites, renders, CI), from the hook log by signature
eta0       = calls_est × pace + long_tools
k_bias     = exp(−median log(estimate / actual)) over the last 20 tasks, clamped [0.25, 4], identity until 3 samples   (a log-median rule, independently confirmed)
range      = [eta0·k × 0.4, eta0·k × 2.5]  until measured coverage justifies narrowing
live       = re-anchor on every PostToolUse: remaining = max(eta0·k − elapsed, pace × remaining_calls_est); never shrink the calibration mid-task
stalled    = no event for 3× the median duration of the running tool → "stalled", countdown stops
waiting    = permission/AskUserQuestion notification or a known external wait (CI run) → paused, reason shown
done       = main-thread Stop (or task.end mark) only; SubagentStop never completes the task
```

Two regimes must be kept apart in the calibration history: user-brief tasks (many turns, user
interaction) and autonomous micro-tasks. The Scoreboard keys `k_bias` on task-type and on whether
the user is in the loop.

## Overhead

Hook logger: ~0.25 s per tool call (Node start-up), hook body 6–16 ms, ≈ 1% of turn time; 108 events
captured in the live session with zero sensitive fields (verified with marker strings).

## Open experiments

Same-model repeatability and cross-model comparison on a fixed task set are planned (see `eval/tasks.json` and
`tools/sb-eval.js` for the harness). They have not been run; no repeatability claim is made.
