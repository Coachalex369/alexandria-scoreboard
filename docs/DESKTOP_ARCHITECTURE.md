# Desktop application — architecture notes

## Requirements recap

Windows first, cross-platform later; one local event engine; the Scoreboard keeps its
look and behaviour: authentic vintage high-school basketball scoreboard, compact draggable widget
and full second-monitor mode, named session tabs, parent agents with subagents grouped underneath, referee
whistle on approval requests, basketball horn on main-task completion (never for subagents), remaining-time
estimates with uncertainty ranges, professional/college team colour presets without logos or trademarks,
custom palettes. Not a conventional modern dashboard.

## Framework comparison

| | Electron 45 (MIT) | Tauri 2 (MIT/Apache) | Plain browser + local service |
|---|---|---|---|
| Windows packaging | mature (MSIX/NSIS), auto-update | mature (MSI/NSIS), auto-update plugin | none |
| Footprint | ~150–200 MB, own Chromium | ~10 MB, uses WebView2 (present on Windows 11) | n/a |
| Always-on-top frameless widget, multi-window, tray | first-class | first-class (`decorations:false`, `alwaysOnTop`, multiwindow) | limited |
| File watching of `~/.claude/eta/events.jsonl`, spawning git/Tree-sitter | Node in main process: reuse the engine as-is | Rust core + JS front; our Node engine would run as a sidecar or be partly ported | Node service required anyway |
| Web Audio and Canvas/WebGL | identical | identical (WebView2 is Chromium-based) | identical |
| Team skills | JavaScript only | JavaScript + some Rust | JavaScript |
| Risk | size, memory | sidecar plumbing, Rust toolchain on the build machine | no native integration |

## Recommendation

**Electron for the first release.** The whole engine and its adapters are plain Node/ES modules; Electron's main
process runs them unchanged (file watcher on the hook log, git and Tree-sitter, replay/live state) and the renderer
hosts the views. Tauri's smaller footprint is
attractive for a free download, and nothing in the design prevents a later port: the engine is
UI-independent and the UI is plain web code, so the migration cost is the sidecar and IPC layer only.
Decide at v1.0 based on measured memory and installer size.

## Process layout

```
main process (Node)                         renderer windows (Chromium/WebView2)
 ├─ collector watcher: tails ~/.claude/eta/events.jsonl   ──IPC/event bus──▶  Scoreboard window (vintage board, tabs, ETA, alerts)
 ├─ adapters: git, tests, structure (on demand)                            ▶  compact widget (frameless, always-on-top, draggable)
 ├─ EventStore (append-only JSONL, per day)
 ├─ LiveState + ETA engine (estimator v0.2, calibration store)
 └─ settings: palettes, sounds, privacy toggles, hook install/rollback
```

- One event bus (the engine's `Replayer`/`LiveState` in live mode) feeds every window; the audio engine subscribes to
  the same stream, so they stay in sync without coupling.
- Alerts: whistle on `notification permission_prompt` / `AskUserQuestion`, horn on main-thread `Stop` or
  `task.end` when a task was open; subagent stops change the board only. Sounds must be original
  synthesized or licensed assets (see licensing).
- Session tabs come from `session.id` + the Claude Code session title (available from transcripts or the
  `ai-title` record; the hook log does not carry it, so the collector should add `SessionStart.session_title`
  when present).
- The ETA engine runs in the main process so the widget and the full board show the same numbers.

## Visual identity constraints

Seven-segment style digits, incandescent-bulb glow, painted-steel frame, team-colour presets stored as
palettes (no marks or names), a "possession arrow" repurposed as the active-agent indicator, "fouls" as
permission waits, "period" as task phase. These are design notes for the Studio phase, not implemented.
