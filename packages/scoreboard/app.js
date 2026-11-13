// Alexandria Scoreboard page. Presentation only: wires the live feed (SSE from server.js) or a clearly labelled
// synthetic recording (Replayer) into the pure Board model and draws the result on the physical board.
import { Replayer } from "/packages/event-engine/src/replay.js";
import { Board } from "./src/board.js";
import { AlertPolicy } from "./src/alerts.js";
import { MatrixDisplay, fitNumber, fitClock } from "./src/digits.js";
import { HornKit } from "./src/horn.js";
import { tickerItems, tickerLine, staticPages, TickerScroller } from "./src/ticker.js";

const $ = (id) => document.getElementById(id);
const DEMOS = { "synthetic-multi-agent": "Demo A · synthetic multi-agent session (11 min)", "forge-demo-session": "Demo B · synthetic session (10 min, failing test then fix)" };

// displays
const D = {
  home: new MatrixDisplay($("dHome"), 3, { colour: "red" }), guest: new MatrixDisplay($("dGuest"), 3, { colour: "red" }),
  clock: new MatrixDisplay($("dClock"), 5, { colour: "amber" }),
  fouls: new MatrixDisplay($("dFouls"), 2, { colour: "amber" }), verified: new MatrixDisplay($("dVerified"), 2, { colour: "green" }),
  period: new MatrixDisplay($("dPeriod"), 2, { colour: "amber" }), shot: new MatrixDisplay($("dShot"), 5, { colour: "red" }),
  timeouts: new MatrixDisplay($("dTimeouts"), 2, { colour: "amber" }), player: new MatrixDisplay($("dPlayer"), 2, { colour: "amber" }),
  message: new MatrixDisplay($("dMessage"), 28, { colour: "amber" }),
};

const horn = new HornKit();
const policy = new AlertPolicy();
const state = { mode: "live", board: new Board(), es: null, replayer: null, lastMessageAt: 0, pinned: null, tab: "roster", status: null, demoEvents: [], benchCollapsed: false, lastRenderKey: "" };

// ---------- data sources ----------
function resetBoard(history = [], taskHistory = [], etaCalibration = null, agentHistory = []) { state.board = new Board({ history, taskHistory, agentHistory, recordHistory: false }); state.board.calibration = etaCalibration; state.pinned = null; policy.lastByKey.clear(); $("alerts").innerHTML = ""; }

function startLive() {
  stopSources(); state.mode = "live"; resetBoard();
  $("demoRibbonWrap").hidden = true; $("demoTransport").hidden = true; setSignal("connecting", "CONNECTING");
  const es = new EventSource("/api/stream"); state.es = es;
  es.addEventListener("snapshot", (m) => {
    const data = JSON.parse(m.data); resetBoard(data.predictions?.filter((p) => p.completedAt) || [], data.taskHistory || [], data.etaCalibration || null, data.agentHistory || []);
    state.status = data.status; applyEvents(data.events, { historical: true }); state.lastMessageAt = Date.now(); setSignal("live", "LIVE"); render(true);
  });
  es.addEventListener("events", (m) => { applyEvents(JSON.parse(m.data)); state.lastMessageAt = Date.now(); setSignal("live", "LIVE"); render(true); });
  es.addEventListener("history", (m) => { const d = JSON.parse(m.data); state.board.setHistory(d.taskHistory || []); });
  es.addEventListener("heartbeat", (m) => { state.lastMessageAt = Date.now(); const h = JSON.parse(m.data); if (state.status) state.status.sessions = h.sessions; });
  es.onerror = () => setSignal("nosignal", "NO SIGNAL · server unreachable");
  fetch("/api/status").then((r) => r.json()).then((s) => { state.status = s; renderFoot(); }).catch(() => {});
}

async function startDemo(name) {
  stopSources(); state.mode = `demo:${name}`; resetBoard();
  $("demoRibbonWrap").hidden = false; $("demoTransport").hidden = false; setSignal("demo", "DEMO · SYNTHETIC");
  const res = await fetch(`/demo/recordings/${name}.events.jsonl`, { cache: "no-store" });
  const events = (await res.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  for (const e of events) { e.provenance = { ...(e.provenance || {}), synthetic: true }; } // never let a demo look observed
  state.demoEvents = events;
  const r = new Replayer(events, { speed: Number($("demoSpeed").value) }); state.replayer = r;
  r.on("event", ({ event }) => { state.board.apply(event); handleAlerts(Date.parse(event.ts)); });
  r.on("done", () => { $("demoPlay").textContent = "▶"; });
  r.start(); $("demoPlay").textContent = "⏸";
  render(true);
}

function stopSources() { if (state.es) { state.es.close(); state.es = null; } if (state.replayer) { state.replayer.pause(); state.replayer = null; } }

function applyEvents(events, { historical = false } = {}) {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  for (const e of sorted) state.board.apply(e);
  handleAlerts(Date.now(), { historical });
}

// Alerts raised while catching up on history are shown quietly (no sound); fresh ones may sound.
function handleAlerts(nowMs, { historical = false } = {}) {
  const raised = state.board.takeAlerts().map((a) => (historical || nowMs - Date.parse(a.ts) > 60e3 ? { ...a, quiet: true } : a));
  const focus = currentSession();
  const { visible, sounds } = policy.decide(raised.filter((a) => !focus || a.session === focus || a.kind === "permission" || a.kind === "attention").map((a) => (a.session !== focus ? { ...a, text: `${a.label || a.session.slice(0, 8)} · ${a.text}` } : a)), Date.now());
  for (const a of visible) showAlert(a);
  for (const s of sounds) horn.play(s);
}

// ---------- message ticker ----------
// Plain-English facts about the tracked task, built from derived snapshot facts only (src/ticker.js), scrolled right to
// left; hovering the window pauses it, and reduced-motion users get static pages instead of movement.
const ticker = { scroller: new TickerScroller({ width: 28, colsPerSec: 7 }), pages: null, key: "", hover: false, reduced: !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) };
function updateTicker(s) {
  const items = tickerItems(s);
  const key = `${s.session?.id || ""}|${s.task?.id || ""}|${s.task?.live ? 1 : 0}|${items[0]?.kind}`;
  ticker.scroller.setText(tickerLine(items), { reset: key !== ticker.key });
  if (key !== ticker.key) { const w = $("dMessage"); w.setAttribute("aria-hidden", "true"); w.parentElement.setAttribute("aria-label", tickerLine(items)); }
  ticker.key = key;
  ticker.pages = ticker.reduced ? staticPages(items, 28) : null;
}
function tickerFrame(ts) { D.message.render(ticker.scroller.frame(ts, { paused: ticker.hover, reduced: ticker.reduced, pages: ticker.pages })); requestAnimationFrame(tickerFrame); }
// Pause while the pointer is over the ticker or it has keyboard focus (it is focusable for that reason).
{ const box = $("dMessage").parentElement; let over = false, focused = false; const sync = () => { ticker.hover = over || focused; };
  box.tabIndex = 0;
  box.addEventListener("mouseenter", () => { over = true; sync(); }); box.addEventListener("mouseleave", () => { over = false; sync(); });
  box.addEventListener("focusin", () => { focused = box.matches(":focus-visible"); sync(); }); /* keyboard focus only: a click does not latch the pause */ box.addEventListener("focusout", () => { focused = false; sync(); }); }
// prefers-reduced-motion is followed live: switching it on shows static pages instead of scrolling.
if (window.matchMedia) { const mq = matchMedia("(prefers-reduced-motion: reduce)"); mq.addEventListener?.("change", (e) => { ticker.reduced = e.matches; ticker.key = ""; }); }
requestAnimationFrame(tickerFrame);

// ---------- rendering ----------
function nowMs() {
  if (state.replayer) { const r = state.replayer; if (r.state === "playing") r.advanceVirtual(); return r.t0 + r.position; }
  return Date.now();
}
function currentSession() { return state.board.focusSession(state.pinned, nowMs()); }

function render(force = false) {
  const now = nowMs(); const sid = currentSession(); const s = state.board.snapshot(sid, now);
  const w = s.winDetail;
  // WINS (HOME): every win counts; the note says how many are verified/confirmed, never presenting guesses as sure.
  D.home.render(fitNumber(s.wins.value, 3)); D.home.setDim(!s.session);
  // GUEST: declared remaining scope, or question marks when scope is unknown.
  const scopeUnknown = s.guest.basis === "unavailable";
  D.guest.render(scopeUnknown ? "???" : fitNumber(s.guest.value, 3)); D.guest.setDim(scopeUnknown); D.guest.el.classList.toggle("qmark", scopeUnknown && !!s.task?.live);
  const g = s.game; const gc = gameClockText(g);
  D.clock.render(gc.text); D.clock.setDim(g.mode === "unknown" || g.mode === "final"); D.clock.setFlash(g.mode === "overtime"); D.clock.el.classList.toggle("qmark", g.mode === "unknown" && !!s.task?.live); lamp("lampHrs", gc.hours);
  lamp("lampOT", g.mode === "overtime"); lamp("lampEst", (g.mode === "countdown" || g.mode === "overtime") && !!g.estimate);
  D.fouls.render(fitNumber(s.fouls.value ?? 0, 2)); D.verified.render(fitNumber(s.verified.value, 2));
  D.period.render(fitNumber(s.period.value, 2)); D.period.setDim(s.period.basis === "unavailable");
  D.timeouts.render(fitNumber(s.timeouts.value, 2)); D.player.render(fitNumber(s.player.value, 2));
  // TIMER: counts up only while Claude is blocked on the owner; dark (blank) otherwise.
  const tm = s.timer;
  const tc = tm.running ? fitClock(tm.waitingMs) : null;
  D.shot.render(tc ? tc.text : "     "); D.shot.setDim(!tm.running); D.shot.setFlash(false);
  $("shotNote").textContent = tm.running ? TIMER_WORD(tm) + (tc.hours ? " · H:MM" : "") : "";

  lamp("lampRun", !!s.task?.live && !s.attention.length && s.session?.status === "active");
  lamp("lampWait", s.attention.length > 0); $("lampWait").classList.toggle("blink", s.attention.length > 0);
  lamp("lampIdle", s.session?.status === "idle" || s.session?.status === "stale");
  lamp("lampBonus", s.bonus); lamp("lampTO", s.attention.length > 0);
  lamp("lampPass", s.tests.value === "PASS"); lamp("lampFail", s.tests.value === "FAIL");
  $("arrowHome").classList.toggle("on", s.possession === "home"); $("arrowGuest").classList.toggle("on", s.possession === "guest");

  $("homeNote").textContent = !s.session ? "WINS · NO SESSION" : `WINS · ${w.sure} VERIFIED${w.unverified ? " · " + w.unverified + " UNVERIFIED" : ""}${w.probable ? " · " + w.probable + " PROBABLE" : ""}`;
  $("guestNote").textContent = scopeUnknown ? "REMAINING · SCOPE UNKNOWN" : `REMAINING OF ${s.task?.estimate?.calls ?? "?"} · DECLARED`;
  $("clockNote").textContent = clockNote(s, g);
  $("periodNote").textContent = s.task?.kind === "marked" ? "TURN · MARKED TASK" : s.task?.resumed && s.task?.live ? "TURN · RESUMED" : "TURN";
  $("playerNote").textContent = `MAIN ${(s.main.state || "idle").toUpperCase()} · ${s.player.value ? (s.lastActor?.side === "guest" ? (s.lastActor.label || "").toUpperCase().slice(0, 16) : s.player.value + " SUB") : "NO SUBAGENTS"}`;
  $("plateProject").textContent = s.session ? `${s.session.label}${s.session.repo && s.session.labelSource !== "repo" ? " · " + s.session.repo : ""}` : "";
  $("plateProject").title = s.session ? `session ${s.session.id} · label from ${s.session.labelSource}${s.session.branch ? " · branch " + s.session.branch : ""}` : "";
  updateTicker(s);
  renderStopwatch(s);
  $("basisNote").textContent = `STEPS DONE ${s.wins.basis} · GAME CLOCK ${g.basis} (${g.mode}) · YOUR MOVE ${s.timer.running ? s.timer.kind : "dark"} · ISSUES ${s.fouls.basis} · CHECK-INS ${s.timeouts.basis} · PHASE ${s.phase.basis} (${s.phase.note})`;
  renderSessionNav(sid, now);

  if (state.mode === "live") { const silent = Date.now() - state.lastMessageAt; if (state.lastMessageAt && silent > 45e3) setSignal("nosignal", `NO SIGNAL · ${Math.round(silent / 1000)} s`); }
  if (state.replayer) { $("demoPos").textContent = `${fmtDur(state.replayer.position)} / ${fmtDur(state.replayer.duration)}`; }
  renderBench(s, force);
}

// Game clock = time LEFT, never time spent (design decision 2026-11-13). Counts down second by second (rounded up,
// like a game clock: 0:00 only when the time is really out); the OVERTIME lamp lights and the digits count up from
// 0:00 once it expires; 0:00 when the period is over; ??:?? when there is no estimate.
function gameClockText(g) {
  if (g.mode === "countdown") return fitClock(Math.ceil(g.remainingMs / 1000) * 1000);
  if (g.mode === "overtime") { const m = Math.floor(g.overtimeMs / 60000); return { text: m < 10 ? "+" + fitClock(g.overtimeMs).text.trim().slice(-4) : `+${Math.min(999, m)}M`.slice(0, 5), hours: false }; }
  if (g.mode === "final") return fitClock(0);
  return { text: "??:??", hours: false };
}
const signed = (ms) => `${ms >= 0 ? "+" : "−"}${fitClock(Math.abs(ms)).text.trim()}`;
function clockNote(s, g) {
  if (!s.task) return "NO PERIOD OBSERVED";
  const counting = g.mode === "countdown" || g.mode === "overtime";
  if (counting && g.adjustment) return `${g.adjustment.fromOvertime ? "CLOCK RESET" : "ADJUSTED " + signed(g.adjustment.deltaMs)} · ${String(g.adjustment.reason).toUpperCase().slice(0, 28)}`;
  if (s.task.live && (s.waiting || g.stopped)) { const k = s.waiting?.kind || g.stopped.kind; const w = g.stopped?.state === "unknown" ? "NO ACTIVITY SEEN" : g.stopped?.state === "paused" ? "PAUSED" : WAIT_WORD[k] || String(k || "WAIT").toUpperCase(); return `CLOCK STOPPED · ${w}${k === "rate_limit" && s.rateLimit?.resetsAt ? " · RESETS " + hm(s.rateLimit.resetsAt) : ""}`; }
  if (g.mode === "countdown") return g.estimate ? `ESTIMATE · ${minOf(g.range.loMs)}–${minOf(g.range.hiMs)} MIN · ${String(g.confidence || "low").toUpperCase()} CONF` : `TIME LEFT · ${String(g.confidence || "").toUpperCase()} CONFIDENCE`;
  if (g.mode === "overtime") return `OVERTIME · ESTIMATE WAS ${minOf(g.target?.activeMs)} MIN`;
  if (g.mode === "final") return "FINAL";
  return `TIME LEFT UNKNOWN · ${String(g.note || "").toUpperCase().slice(0, 34)}`;
}

// Session navigation: ◀ ▶ cycle the active sessions and HOLD the chosen one (pinned); AUTO follows the most recent.
function renderSessionNav(sid, now) {
  const pin = $("sessPin"); pin.setAttribute("aria-pressed", String(!!state.pinned)); pin.textContent = state.pinned ? "📌 PINNED" : "AUTO";
  const others = state.board.sessionList(now).filter((x) => x.id !== sid && x.attention.length && x.status === "waiting");
  const el = $("otherAttention");
  if (others.length) { el.hidden = false; el.textContent = `⚑ ${others.length === 1 ? others[0].label.slice(0, 28) : others.length + " sessions"} · NEEDS YOU`; el.dataset.sid = others[0].id; el.title = others.map((o) => `${o.label}: ${o.attention.map((a) => a.label).join(", ")}`).join("\n"); }
  else el.hidden = true;
}
function cycleSession(dir) {
  const list = state.board.cycleList(nowMs()); if (!list.length) return;
  const cur = currentSession(); const i = Math.max(0, list.findIndex((x) => x.id === cur));
  state.pinned = list[(i + dir + list.length) % list.length].id; render(true);
}

const TIMER_WORD = (tm) => tm.kind === "owner" ? "YOUR TURN" : tm.kind === "approval" || tm.request === "plan-approval" ? "APPROVAL NEEDED" : "QUESTION";
const WAIT_WORD = { approval: "APPROVAL", question: "QUESTION", owner: "OWNER'S MOVE", rate_limit: "RATE LIMIT", api_error: "API ERROR", external: "EXTERNAL", permission: "PERMISSION", idle: "IDLE" };
const minOf = (ms) => (ms == null ? "–" : String(Math.max(0, Math.round(ms / 60000))));
function shotNoteV2(e) {
  if (e.state === "insufficient-data") return `INSUFFICIENT DATA · ${e.n}/${e.need} TASKS`;
  if (e.state === "beyond-history") return "BEYOND HISTORY · NO RANGE";
  return `MIN LEFT · ${minOf(e.remaining.p10)}–${minOf(e.remaining.p90)} · ${e.confidence.toUpperCase()}`;
}
// One strip of facts and predictions under the message window: state, active vs waiting, ETA range, model.
function renderStopwatch(s) {
  const el = $("swRow"); const sw = s.stopwatch;
  if (!sw) { el.innerHTML = `<span class="dim">STOPWATCH · no task</span>`; return; }
  const st = sw.state === "waiting" ? `WAITING · ${WAIT_WORD[sw.kind] || sw.kind}` : sw.state.toUpperCase();
  const e = s.etaV2;
  const eta = !s.task?.live ? `<span class="dim">ETA · task finished</span>`
    : !e ? `<span class="dim">ETA · –</span>`
    : e.state === "insufficient-data" ? `ETA <b>insufficient data</b> <span class="dim">(${e.n} of ${e.need} comparable tasks; no declared estimate)</span>`
    : e.state === "beyond-history" ? `ETA <b>beyond history</b> <span class="dim">(longer than nearly all ${e.n} comparable tasks; no range)</span>`
    : `ETA <b>${minOf(e.remaining.p50)} min</b> <span class="dim">range ${minOf(e.remaining.p10)}–${minOf(e.remaining.p90)} · p10–p90 · ${esc(e.method)} · n ${e.n}</span> · conf <b>${esc(e.confidence)}</b>`;
  el.innerHTML = [
    `<span class="sw-state" data-s="${esc(sw.state)}" title="basis: ${esc(sw.basis || "–")}">● ${esc(st)}</span>`,
    eta,
    `MODEL <b>${esc(s.model?.value || "–")}</b>`,
    s.tokens?.responses ? `<span class="dim">${Math.round(s.tokens.outputTokens / 1000)}k out · ${s.tokens.responses} responses</span>` : "",
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
}
// Completed tasks: what the estimator said at the start versus what happened (content-free records).
function renderOutcomes(s) {
  const recs = state.board.taskHistory.filter((r) => r.session === s.session?.id && r.predictionAtStart).slice(-12).reverse();
  const c = state.board.calibration;
  const head = `<div class="calib">ETA v0.2 · ${state.board.taskHistory.filter((r) => r.calibratable !== false).length} tasks in the calibration store${c ? ` · backtest (rolling origin, at start): MdALE ${c.mdale ?? "–"} · within 2× ${c.within2x != null ? Math.round(c.within2x * 100) + "%" : "–"} · 80% range covered ${c.coverage80 != null ? Math.round(c.coverage80 * 100) + "%" : "–"} of ${c.n}` : " · no backtest yet (run sb-calibrate evaluate)"}</div>`;
  if (!recs.length) return head;
  const rows = recs.map((r) => { const p = r.predictionAtStart; const inR = p.p10 != null && p.p90 != null ? (r.actualActiveMs >= p.p10 && r.actualActiveMs <= p.p90 ? "✓" : "✗") : "–";
    return `<tr><td>${esc(r.title || r.taskId.slice(-10))}</td><td>${hm(r.startedAt)}</td><td>${esc(p.method)}${p.n ? " · n " + p.n : ""}</td><td>${p.p50 != null ? minOf(p.p50) + " min (" + minOf(p.p10) + "–" + minOf(p.p90) + ")" : esc(p.state)}</td><td>${minOf(r.actualActiveMs)} min active · ${minOf(r.waitingMs)} waiting</td><td>${inR}</td></tr>`; });
  return head + `<table class="grid"><thead><tr><th>task</th><th>start</th><th>method</th><th>predicted at start</th><th>actual</th><th>in range</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function lamp(id, on) { $(id).classList.toggle("on", !!on); }
function setSignal(stateName, text) { const el = $("signal"); el.dataset.state = stateName; el.querySelector("b").textContent = text; }
function fmtDur(ms) { if (ms == null) return "–"; const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`; return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; }
function ago(ts, now) { return ts ? fmtDur(now - Date.parse(ts)) + " ago" : "–"; }
function hm(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`; }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function showAlert(a) {
  const box = $("alerts"); const el = document.createElement("div"); el.className = `alert ${a.level}`;
  el.innerHTML = `<time>${hm(a.ts)}</time><span>${esc(a.text.toUpperCase())}</span><span class="mono">${esc(a.project || "")}</span><button class="dismiss" aria-label="dismiss">✕</button>`;
  el.querySelector(".dismiss").onclick = () => el.remove(); box.appendChild(el);
  while (box.children.length > 5) box.firstChild.remove();
  if (a.level === "info" || a.level === "success") setTimeout(() => el.remove(), a.level === "info" ? 12e3 : 45e3);
}

// ---------- bench ----------
function renderBench(s, force) {
  const now = s.now;
  $("benchStatus").textContent = state.mode === "live" ? `live · ${state.board.sessions.size} sessions · ${state.board.count} events` : `${DEMOS[state.mode.slice(5)] || "demo"} · ${state.board.count} events`;
  if (state.benchCollapsed) return;
  if (state.tab === "roster") {
    const rows = [];
    const mainState = !s.session ? "idle" : s.session.status === "waiting" ? "waiting" : s.possession === "home" && s.session.status === "active" ? "active" : s.session.status;
    rows.push(`<tr class="main"><td><span class="state ${s.main.state}"><i></i>${s.main.state}</span></td><td>MAIN · session</td><td>${s.session?.synthetic ? "synthetic" : s.model?.value ? esc(s.model.value) + ` <span style="color:#777">(${esc(s.model.basis)})</span>` : "unknown <span title=\"not yet observed in the transcript or SessionStart\">(not observed yet)</span>"}</td><td>${esc(s.task?.title || (s.task ? `period ${s.session.periods}${s.task.resumed ? " (resumed)" : ""} · ${s.task.edits} file changes` : "no period"))}</td><td>–</td><td>${s.task?.mainCalls ?? 0}</td><td>${ago(s.session?.lastEventTs, now)}</td></tr>`);
    // Running agents always; completed ones only from the current task (older sessions can hold dozens).
    const agents = s.agents.filter((a) => a.state !== "completed" || !s.task || a.taskId === s.task.id).sort((a, b) => (a.end ? 1 : 0) - (b.end ? 1 : 0) || b.start.localeCompare(a.start));
    for (const a of agents) rows.push(`<tr class="child"><td><span class="state ${a.state}"><i></i>${a.state}</span></td><td>SUB · ${esc(a.type || "agent")} <span class="mono" style="color:#777">${esc(a.id.slice(0, 8))}</span></td><td>${a.model ? esc(a.model) + ` <span style="color:#777">(${a.modelBasis})</span>` : "unknown"}</td><td>${esc(a.label || "assignment not observable from hooks")}</td><td>${a.parentAgentId ? "agent " + esc(a.parentAgentId.slice(0, 8)) : "main thread"}${a.parentToolUseId ? ` <span style="color:#777">via ${esc(a.parentToolUseId.slice(-6))}</span>` : ""}</td><td>${a.toolCalls}${a.lastTool ? ` <span style="color:#777">${esc(a.lastTool)}</span>` : ""}${a.wins ? ` · <b>${a.wins} win${a.wins === 1 ? "" : "s"}</b>` : ""}${a.state === "lost" ? " · <span title=\"no stop event and no activity: shown as lost, not running\">no stop seen</span>" : a.endBasis === "inferred" ? " · <span title=\"ended when its Agent result returned\">end inferred</span>" : ""}</td><td>${ago(a.lastSeen, now)}</td></tr>`);
    $("tab-roster").innerHTML = `<table class="grid"><thead><tr><th>state</th><th>agent</th><th>model</th><th>task</th><th>parent</th><th>calls</th><th>last seen</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  } else if (state.tab === "events") {
    const lines = [...s.log].reverse().map((l) => { const cls = /FAIL|failure/.test(l.text) ? "fail" : /pass/.test(l.text) ? "pass" : /wait/.test(l.text) ? "wait" : ""; return `<div class="logline ${cls}"><span>${hm(l.ts)}</span><span class="${l.observed ? "obs" : "inf"}" title="${l.observed ? "observed" : "synthetic / declared"}">${l.observed ? "●" : "○"}</span><span>${esc(l.text)}</span><span class="k">${esc(l.kind)}</span></div>`; });
    $("tab-events").innerHTML = lines.length ? lines.join("") : `<div class="empty">No significant events yet for this session.</div>`;
  } else if (state.tab === "predictions") {
    const p = s.predictions; const c = s.calibration;
    const rows = p.slice().reverse().map((r) => `<tr><td>${esc(r.title || r.taskId)}</td><td>${hm(r.estimatedAt)}</td><td>${r.p50Min ?? "–"}${r.p90Min != null ? " / " + r.p90Min : ""} min${r.calls != null ? " · " + r.calls + " calls" : ""}</td><td>${r.etaMinApplied ?? "–"} min${r.k !== 1 ? " (k " + r.k.toFixed(2) + ")" : ""}</td><td>${r.completedAt ? r.actualWorkMin + " min · " + (r.actualCalls ?? "–") + " calls" : s.task?.id === r.taskId && s.task.live ? "<span style=\"color:#ffe27a\">open</span>" : "open"}</td><td>${r.errorRatio != null ? (r.errorRatio > 1 ? "estimate " + r.errorRatio + "× too long" : "estimate " + (1 / r.errorRatio).toFixed(2) + "× too short") : "–"}</td><td>${r.withinRange == null ? "–" : r.withinRange ? "✓" : "✗"}</td></tr>`);
    $("tab-predictions").innerHTML = (rows.length ? `<table class="grid"><thead><tr><th>task</th><th>estimated at</th><th>declared p50 / p90</th><th>ETA applied</th><th>actual</th><th>error</th><th>in range</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<div class="empty">No declared estimates for this session. The shot clock stays dark until one exists. Declare one for the live task with<br><code>node tools/sb-mark.js start "title" --minutes 25 --p90 40 --calls 60</code> … then <code>node tools/sb-mark.js end</code> when done.</div>`)
      + renderOutcomes(s) + `<div class="calib">declared-estimate log over all sessions: ${c.n} completed prediction${c.n === 1 ? "" : "s"}${c.n ? ` · median estimate/actual ${c.medianRatio} · ${c.within2x}/${c.n} within 2× · bias k ${c.k.toFixed(2)}${c.n < 3 ? " (identity until 3 samples)" : ""}` : " · bias correction inactive"}</div>`;
  } else if (state.tab === "score") {
    const wins = s.winDetail.list.map((x) => `<tr><td>${hm(x.ts)}</td><td><span class="tier ${x.tier}">${x.tier}</span>${x.revoked ? " <s>revoked</s>" : ""}</td><td>${esc(x.kind)}</td><td>${esc(x.label)}</td><td>${x.agentId ? "SUB " + esc(x.agentId.slice(0, 8)) : "team"}</td><td>${esc(x.basis)}${x.evidence?.length ? " · checks: " + esc(x.evidence.join(", ")) : ""}</td></tr>`);
    const fouls = s.foulDetail.unresolved.map((f) => `<tr><td>${hm(f.since)}</td><td>${esc(f.kind)}</td><td>${esc(f.label)}${f.repeats > 1 ? " ×" + f.repeats : ""}</td><td>${esc(f.basis)}</td><td>open</td></tr>`)
      .concat(s.foulDetail.resolved.map((f) => `<tr style="opacity:.7"><td>${hm(f.since)}</td><td>${esc(f.kind)}</td><td>${esc(f.label)}</td><td>${esc(f.basis)}</td><td>resolved ${hm(f.resolvedAt)} · ${esc(f.resolvedBy)} (${esc(f.resolutionBasis)})</td></tr>`));
    const checks = s.checks.map((c) => `<tr><td class="chk ${c.status}">${c.status}</td><td>${esc(c.kind)}</td><td>${esc(c.label)}</td><td>${hm(c.ts)}${c.counts?.passed != null ? ` · ${c.counts.passed} passed / ${c.counts.failed} failed` : ""}</td><td>${c.staleSince ? "stale since " + hm(c.staleSince) + " (" + esc(c.staleBy) + ")" : c.agentId ? "run by SUB " + esc(c.agentId.slice(0, 8)) : ""}</td></tr>`);
    const att = s.attention.map((a) => `<tr><td>${hm(a.since)}</td><td>${esc(a.kind)}</td><td>${esc(a.label)}</td><td>${esc(a.basis)}</td></tr>`);
    $("tab-score").innerHTML = `<div class="calib">scope: ${esc(s.session?.scope || "–")} · checks and fouls belong to the repository, wins to this session · ${s.idle ? "idle notification " + fmtDur(s.idle.forMs) + " (not counted as a timeout)" : "no idle notification"}</div>`
      + `<h4>STEPS DONE (${s.winDetail.total}: ${s.winDetail.sure} verified/confirmed · ${s.winDetail.unverified} unverified · ${s.winDetail.probable} probable)</h4><table class="grid"><thead><tr><th>time</th><th>tier</th><th>kind</th><th>deliverable</th><th>by</th><th>basis / evidence</th></tr></thead><tbody>${wins.join("") || "<tr><td colspan=6 class=empty>no wins yet</td></tr>"}</tbody></table>`
      + `<h4>CHECK-INS · waiting for you</h4><table class="grid"><tbody>${att.join("") || "<tr><td class=empty>nothing outstanding</td></tr>"}</tbody></table>`
      + `<h4>VERIFIED · checks</h4><table class="grid"><tbody>${checks.join("") || "<tr><td class=empty>no checks observed in this repository</td></tr>"}</tbody></table>`
      + `<h4>ISSUES · open and resolved</h4><table class="grid"><tbody>${fouls.join("") || "<tr><td class=empty>no problems recorded</td></tr>"}</tbody></table>`;
  } else if (state.tab === "sessions") {
    const list = state.board.sessionList(now);
    const rows = list.map((x) => `<tr><td><span class="state ${x.status}"><i></i>${x.status}</span></td><td>${esc(x.label)} <span style="color:#777">(${esc(x.labelSource)})</span>${x.repo ? " · " + esc(x.repo) : ""}${x.attention.length ? ` · <b style="color:#ff9b8a">needs you: ${esc(x.attention.map((a) => a.label).join(", "))}</b>` : ""}</td><td class="mono">${esc(x.id.slice(0, 8))}</td><td>P${x.periods} · ${x.wins} wins</td><td>${x.agents}</td><td>${ago(x.lastEventTs, now)}</td><td><button class="pin" data-sid="${esc(x.id)}" aria-pressed="${state.pinned === x.id}">${state.pinned === x.id ? "pinned" : "show"}</button></td></tr>`);
    $("tab-sessions").innerHTML = `<div class="calib">${state.pinned ? `pinned to ${esc(state.pinned.slice(0, 8))} · <button class="pin" id="unpin">follow most recent</button>` : "AUTO · following the most recently active session (held while it is busy)"}</div><table class="grid"><thead><tr><th>status</th><th>session</th><th>id</th><th>periods · wins</th><th>subagents running</th><th>last event</th><th></th></tr></thead><tbody>${rows.join("") || "<tr><td colspan=7 class=empty>no sessions</td></tr>"}</tbody></table>`;
    for (const b of $("tab-sessions").querySelectorAll("button.pin[data-sid]")) b.onclick = () => { state.pinned = b.dataset.sid; render(true); };
    const un = $("unpin"); if (un) un.onclick = () => { state.pinned = null; render(true); };
  }
}

function renderFoot() { const st = state.status; if (!st) return; $("footSource").textContent = `source: ${st.sources.hookLog.file} (${st.sources.hookLog.present ? st.sources.hookLog.events + " hook events" : "missing"}) · marks ${st.sources.marks.events} · git ${st.sources.git.events} commits · server up since ${hm(st.startedAt)}`; }

// ---------- controls ----------
for (const b of document.querySelectorAll(".mode-btn")) b.onclick = () => { for (const x of document.querySelectorAll(".mode-btn")) x.setAttribute("aria-selected", String(x === b)); const m = b.dataset.mode; if (m === "live") startLive(); else startDemo(m.slice(5)); };
for (const t of document.querySelectorAll(".tab")) t.onclick = () => { state.tab = t.dataset.tab; for (const x of document.querySelectorAll(".tab")) x.setAttribute("aria-selected", String(x === t)); for (const p of document.querySelectorAll(".pane")) p.hidden = p.id !== `tab-${state.tab}`; render(true); };
$("benchToggle").onclick = () => { state.benchCollapsed = !state.benchCollapsed; $("bench").classList.toggle("collapsed", state.benchCollapsed); $("benchToggle").textContent = state.benchCollapsed ? "BENCH ▸" : "BENCH ▾"; $("benchToggle").setAttribute("aria-expanded", String(!state.benchCollapsed)); render(true); };
$("demoPlay").onclick = () => { const r = state.replayer; if (!r) return; if (r.state === "playing") { r.pause(); $("demoPlay").textContent = "▶"; } else if (r.state === "paused") { r.resume(); $("demoPlay").textContent = "⏸"; } else if (r.state === "done") startDemo(state.mode.slice(5)); };
$("demoRestart").onclick = () => { if (state.mode.startsWith("demo:")) startDemo(state.mode.slice(5)); };
$("demoSpeed").onchange = () => { if (state.replayer) state.replayer.setSpeed(Number($("demoSpeed").value)); };
$("soundEnable").onclick = () => { if (horn.enable()) { $("soundEnable").hidden = true; } };
$("mute").onclick = () => { horn.setMuted(!horn.muted); syncSound(); };
$("volume").oninput = () => horn.setVolume($("volume").value);
$("testHorn").onclick = () => { horn.enable(); $("soundEnable").hidden = true; horn.play("horn"); };
$("sessPrev").onclick = () => cycleSession(-1);
$("sessNext").onclick = () => cycleSession(1);
$("sessPin").onclick = () => { state.pinned = state.pinned ? null : currentSession(); render(true); };
$("otherAttention").onclick = () => { if ($("otherAttention").dataset.sid) { state.pinned = $("otherAttention").dataset.sid; render(true); } };
addEventListener("keydown", (e) => { if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return; if (e.key === "ArrowLeft") cycleSession(-1); if (e.key === "ArrowRight") cycleSession(1); if (e.key === "p" || e.key === "P") $("sessPin").click(); if (e.code === "Space" && state.replayer) { e.preventDefault(); $("demoPlay").click(); } if (e.key === "m") $("mute").click(); if (e.key === "b") $("benchToggle").click(); });
function syncSound() { $("mute").setAttribute("aria-pressed", String(horn.muted)); $("mute").textContent = horn.muted ? "🔕" : "🔔"; $("volume").value = horn.volume; }
syncSound();
// Inside the desktop shell autoplay is allowed, so sound can be armed without a click.
if (globalThis.alexandriaDesktop?.shell === "electron" && horn.enable()) $("soundEnable").hidden = true;

const params = new URLSearchParams(location.search);
const wanted = params.get("mode");
if (wanted && wanted.startsWith("demo:") && DEMOS[wanted.slice(5)]) { document.querySelector(`.mode-btn[data-mode="${wanted}"]`)?.click(); } else startLive();
setInterval(() => render(false), 500);
