# Scoreboard scoring and telemetry

The board represents real coding activity: what each counter counts, how sessions are identified, and the limits
of the available telemetry.
Code: `packages/scoreboard/src/board.js` (game structure, clocks, attention, agents), `src/scoring.js` (checks, fouls,
wins), `src/sessionFacts.js` (identity, live questions, process liveness), `server.js` (sources, git roots).
Fixtures: `packages/scoreboard/test/scoring.test.js`. Replaying your own hook log through a checkout: `tools/sb-audit.mjs`.
## What each counter means

| Counter | Rule | Basis |
|---|---|---|
| **WINS** (HOME digits) | Team score of the session (main thread + subagents). A win is one of: a period that changed files ended; a commit (each hash once across all sessions); a subagent delivery (its stop, or its Agent result returning); an explicit task-complete mark. Tier: **confirmed** = explicit mark only; **verified** = at that moment ≥ 1 check valid and no foul open in the repository; **unverified** = an observed deliverable without that evidence; **probable** = an inferred completion without that evidence. A subagent whose Agent call then fails has its win **revoked** (shown struck through on the score sheet). Read-only periods are not wins. | observed (commits, stops, marks) / inferred (period completion, Agent-result ends) |
| **GUEST** | Remaining calls of a declared estimate; `???` when scope is unknown. | predicted / unavailable |
| **GAME CLOCK** | Estimated time **left** in the current period, never time spent. Counts **down** second by second in active time from the best available estimate: medium/high confidence → plain countdown; low confidence → the same countdown with the **EST** lamp and the p10–p90 range in the note. It **stops** whenever the stopwatch is not active (approval, question or plan approval, rate limit, API error, external wait, declared pause, and a stall) and resumes with the work. It is re-set only when the estimate's evidence changes, never because time passed; a re-set of 15 s or more is shown for 30 s as `ADJUSTED M:SS MORE/LESS · reason`. **Overtime:** at 0:00 the **OVERTIME** lamp lights and the clock resets to the estimator's remaining-time p50 and counts down again; without a fresh estimate it resets to the lower bound of the last range (EST); every reset is at least 30 s. Never a `+`, never counting up, never negative; the digits never blink (the lamps carry the state). M:SS under an hour, H:MM with the HRS lamp from an hour. A finished period shows `0:00` FINAL; no estimate shows `--:--`. The completion horn is unchanged (main-task completion only). | predicted / unavailable |
| **SHOT CLOCK** | The running subagent expected to deliver next, from completed agents **of the same type** only. Fewer than 6 → unknown (`?`, "NO RELIABLE ETA"); spread history → `?` with the minute range in the note; ≥ 12 with p90/p10 ≤ 3 → countdown, then overtime. Never derived from the main task. | predicted / unavailable |
| **FOULS** | Unresolved meaningful problems in the session's **repository**: failed test runs (parsed, or a test command reported by the failure hook), failed build/lint/typecheck commands, failed subagent deliveries. Not fouls: failed reads/searches/edits, ad-hoc shell commands, browser automation, interrupted calls. Resolved by evidence: the same check passing later (observed); a later pass of another command of the same kind that ran at least as many tests as the failed run (inferred; never when either count is unknown); or a later delivery by a subagent of the same type (inferred). A failed chain with both a build and a test command opens no foul (which one failed is not observable). Resolved fouls move to the score sheet history. BONUS lamp at 5 open. | observed / inferred |
| **VERIFIED** | Valid passing checks in the repository: test commands and build/lint/typecheck commands, keyed by their redacted signature. A check goes **stale** after a later code change in the same repository (any session, main or subagent): an edit to a non-documentation file, or a tree-rewriting command (`git checkout/merge/rebase/reset/pull/stash…`, `sed`, `npm install`, `mv/cp/rm`…). It is **failed** when its latest run failed. Commits never count. Evidence survives period and task boundaries. | observed |
| **TIMEOUTS** | Outstanding owner-attention requests: permission dialogs, questions (`AskUserQuestion`), plan approvals (`ExitPlanMode`), input dialogs (elicitations), and **inferred** "the reply ends with a question" (closing paragraph of the final answer). Removed when answered, decided or when the owner next writes. Idle notifications are shown separately and never counted. | observed / inferred |
| **PLAYER** | Running subagents. The main thread is shown separately (`MAIN ACTIVE / WAITING / IDLE / ENDED`). An agent is completed (stop seen, or its foreground Agent result returned), **lost** (no stop and silent 20 min, or its session ended), active (seen within 45 s) or running. Lost agents are never counted as running. | observed / inferred |
| **PERIOD** | Turn number in the session (2 digits). | observed |

Attention, wins and fouls raise alerts. Alerts from the session on screen are shown as before; **owner-attention
alerts from other sessions** are shown too, labelled with that session, and the top bar shows a flashing
`⚑ … NEEDS YOU` chip that jumps to it on click. The view never switches by itself.

## Session identity and navigation

- **Repository**: the git root of the session's working directory, found by walking up to the nearest `.git` (works
  for worktrees). Source order: transcript `cwd` (follows the session), then the session registry's launch
  directory. A move into a folder outside any repository keeps the last repository. Two repositories with the same
  folder name are told apart by a short hash of their path. The old `<home>/<project>` guess is gone.
- **Label** (best evidence first): a name the owner gave the session (registry `nameSource` not "derived", or a
  transcript custom title) → Claude Code's session title (`aiTitle`) → repository (and branch, when not main/HEAD) →
  registry name → folder → session id. Every step is optional; when an undocumented field disappears the label
  falls back to the next one. The label is held in memory and shown in the local UI only.
- **Navigation**: ◀ ▶ (or ←/→) cycle the active sessions and hold the chosen one; the pin chip shows `📌 PINNED`;
  `AUTO` follows the most recently active session but holds a busy one for 60 s (no flipping between terminals).
  A pinned session is never left automatically. P toggles the pin.
- **Process liveness**: `~/.claude/sessions/<pid>.json` + a pid check. A session whose process is gone is shown as
  ended, its open requests cleared and its open agents marked lost.

## Observed, inferred, predicted

| Measurement | Observed | Inferred | Predicted |
|---|---|---|---|
| Period start/end, turn count | prompt and Stop hooks | resumed period (activity after a Stop without a prompt) | |
| Wins | commits, subagent stops, explicit marks | period completion, Agent-result ends, commit-to-session attribution from the git poller | |
| Fouls | failed checks, failed Agent calls, resolution by a passing check | resolution by a later same-type delivery | |
| Verified | check runs, edits (tool + extension), tree-rewriting commands | "stale" from a command signature (no paths) | |
| Timeouts | permission/question/plan/elicitation events | "reply ends with a question" | |
| Agents | start, stop, tool activity | end from the Agent result; lost after silence | |
| Game / shot clock | elapsed active time | | remaining time only (game clock: 2026-11-13) |
| Identity | transcript cwd/title, registry name | sticky repository, label fallback | |

## Limits that cannot be solved reliably with the available telemetry

- **Task success is not observable.** Claude Code reports when a turn ends, not whether the work is right. Only an
  explicit mark is "confirmed"; everything else is labelled by its evidence.
- **Repository scope follows Claude Code's working directory**, not the edited file (paths are never logged). A
  session started in the home folder that only `cd`s inside shell commands has no repository; its checks and fouls stay in its own scope.
- **"Stale" is coarse**: any code edit in the repository stales every check, and shell commands can only be judged by
  their signature (a `node script.js` that rewrites files is not seen).
- **The reply-question rule reads text** (in memory, never stored): a rhetorical question at the end of a reply counts;
  a question asked mid-reply does not.
- **Background agents** that finish without a SubagentStop line are shown as lost after 20 minutes, not completed.
- **Estimates are weak** (see the limits above). The rules keep them honest (ranges, unknown) rather than accurate. The
  confidence calibration (`calibration.json`) was measured on the old multi-turn records; re-run `sb-calibrate` once
  periods have accumulated.
- **The session registry and transcript formats are internal to Claude Code** and may change; the label and liveness
  fall back silently when they do.
- **Startup is slower** because
  transcripts are also scanned for identity and questions. After startup, backlogs are read in 4 MB slices.
- **A commit and the period that made it both score** (milestone + completion, as the rules intend); an amended commit
  has a new hash and scores again.
- **Process liveness needs the registry file**: if Claude Code removes it on exit, an exited session ends by its
  SessionEnd line or goes stale after 30 min instead.
- **The local server answers only loopback requests** from its own origin (or none); marks over `/api/ingest` need the
  `x-alexandria-ingest: 1` header (sb-mark sends it).

- **Injected messages count as periods.** Subagent hand-backs and system notifications reach the UserPromptSubmit
  hook like typed prompts (seen live: period 6 after 4 typed prompts). The transcript can tell them apart
  (`promptSource`/`origin`); using it for the period count is a next step.
- **Approvals close on the first main-thread tool that started after the request**, which relies on the hook's
  `duration_ms` excluding permission time (as documented for Claude Code hooks; not re-measured here because no live
  permission dialog occurred in auto mode).
