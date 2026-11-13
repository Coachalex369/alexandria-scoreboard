// Message-window ticker. Pure and browser-safe: turns a board snapshot into plain-English items about the task the
// GAME CLOCK is tracking (s.task: main thread plus its subagents), and scrolls them across the message window.
//
// PRIVACY RULE: text comes only from the fixed templates below, filled with counts, clock times and words looked up
// in fixed tables. No free-text field is ever interpolated (labels, titles, notes, s.log, repo, branch, session label,
// signatures). Unknown kinds fall back to a generic word. Output is also restricted to characters the dot-matrix font
// can draw.
//
// MARKERS: every item ends with a marker. " · VERIFIED" = observed, and for steps confirmed by a task-complete mark or
// backed by a valid check. " · LIKELY?" = inferred, probable, or observed but not yet backed by a check. The font has
// no brackets, so the markers are plain words.
import { FONT } from "./digits.js";

export const MARK = { verified: "VERIFIED", inferred: "LIKELY?" };
export const SEP = "   ·   ";
export const IDLE_TEXT = "WAITING FOR THE NEXT TASK";
const MAX_STEP_ITEMS = 6;

const CHECK_WORD = { test: "TEST", build: "BUILD", lint: "LINT", typecheck: "TYPECHECK", commit: "COMMIT" };
const STEP_WORD = { turn: "WORK TURN", commit: "COMMIT", subagent: "HELPER REPORT", task: "MARKED TASK", mark: "MARKED STEP" };
const FOUL_WORD = { "test-failure": "A TEST FAILED", "build-failure": "A BUILD OR LINT CHECK FAILED", "subagent-failure": "A HELPER DID NOT DELIVER" };
const ASK_WORD = { approval: "APPROVAL NEEDED", "plan-approval": "PLAN APPROVAL NEEDED", question: "A QUESTION IS WAITING", input: "YOUR INPUT IS NEEDED" };
const AGENT_WORD = { implementer: "IMPLEMENTER", reviewer: "REVIEWER", scout: "SCOUT", "test-runner": "TEST RUNNER", researcher: "RESEARCHER", explore: "EXPLORER", plan: "PLANNER", "general-purpose": "GENERAL HELPER" };

const word = (table, k, fallback) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(table, k.toLowerCase()) ? table[k.toLowerCase()] : fallback);
const toMs = (v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);
const clock = (v) => { const m = toMs(v); if (!Number.isFinite(m)) return ""; const d = new Date(m); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const num = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(999, Math.round(n))) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sure = (b) => (b === "observed" || b === "verified" || b === "confirmed" ? "verified" : "inferred");

// Anything the dot-matrix font cannot draw becomes a space (belt and braces; the templates already stay inside it).
export function drawable(text) {
  return String(text).toUpperCase().replace(/./gu, (c) => (FONT[c] ? c : " ")).trim();
}

// snapshot → [{ text, basis: "verified" | "inferred", kind }], most important first.
export function tickerItems(s) {
  const out = [];
  const add = (kind, text, basis) => out.push({ text, basis, kind });
  const t = s && s.session ? s.task : null;
  if (!t) return [{ text: IDLE_TEXT, basis: "verified", kind: "idle" }];

  const t0 = toMs(t.start), t1 = t.end ? toMs(t.end) : Infinity;
  // Repository-scoped facts (checks, issues) are shared by every session in the repo: keep this session's only.
  const sid = s.session.id, mine = (x) => !x.session || x.session === sid;
  const inTask = (ts) => { const m = toMs(ts); return Number.isFinite(m) && m >= t0 && m <= t1; };
  const wins = (s.winDetail?.list || []).filter((w) => !w.revoked && inTask(w.ts));
  const stepsDone = wins.length;
  const sureSteps = wins.filter((w) => w.tier === "confirmed" || w.tier === "verified").length;
  const openFouls = (s.foulDetail?.unresolved || []).filter((f) => mine(f) && inTask(f.since));
  const resolved = (s.foulDetail?.resolved || []).filter((f) => mine(f) && inTask(f.since) && inTask(f.resolvedAt));
  const checks = (s.checks || []).filter((c) => mine(c) && inTask(c.ts));
  const agents = (s.agents || []).filter((a) => (a.taskId ? a.taskId === t.id : inTask(a.start)));
  // Everything still waiting on the owner, whenever it opened (not limited to the task window).
  const asks = s.attention || [];
  const ended = !t.live && !!t.end;
  // TASK COMPLETE only for a real completion, matching the final horn: a marked task.end that did not fail.
  const completed = ended && t.endReason === "marked" && t.outcome !== "failed";
  const issues = openFouls.length ? ` · ${plural(num(openFouls.length), "ISSUE", "ISSUES")} STILL OPEN` : "";

  if (completed) add("complete", `TASK COMPLETE · ${plural(num(stepsDone), "STEP", "STEPS")} DONE${stepsDone ? ` · ${num(sureSteps)} VERIFIED` : ""}${issues}`, "verified");
  else if (ended && t.endReason === "marked") add("ended", `TASK ENDED · NOT COMPLETE${issues}`, "verified");
  else if (ended && t.endReason === "turn-end") add("ended", `TURN ENDED · BACK TO YOU${issues}`, "verified");
  else if (ended) add("ended", `TASK ENDED${issues}`, "inferred");

  // Owner attention first, so an approval is never scrolled out of view behind a long line.
  for (const a of asks) add("approval", `YOUR MOVE · ${word(ASK_WORD, a.kind, "YOUR INPUT IS NEEDED")} SINCE ${clock(a.since)}`, sure(a.basis));

  // Session state the old message line showed.
  const sess = s.session;
  if (sess.end || sess.processGone || sess.status === "ended") add("session", "SESSION ENDED", "verified");
  else if (sess.status === "stale") add("session", "SESSION QUIET · NO RECENT ACTIVITY", "inferred");

  const sessionOver = !!(sess.end || sess.processGone || sess.status === "ended");
  if (t.live && !sessionOver) add("progress", `TASK IN PROGRESS · ${plural(num(stepsDone), "STEP", "STEPS")} DONE${openFouls.length ? ` · ${plural(num(openFouls.length), "ISSUE", "ISSUES")} OPEN` : ""}`, "verified");

  for (const f of openFouls) add("problem", `ISSUE · ${word(FOUL_WORD, f.kind, "A CHECK FAILED")} AT ${clock(f.since)} · STILL OPEN`, sure(f.basis));
  for (const f of resolved.slice(0, 3)) add("problem", `ISSUE RESOLVED AT ${clock(f.resolvedAt)} · ${word(FOUL_WORD, f.kind, "A CHECK FAILED")} EARLIER`, sure(f.resolutionBasis));

  for (const c of [...checks].sort((a, b) => toMs(b.ts) - toMs(a.ts))) {
    const w = word(CHECK_WORD, c.kind, "CHECK");
    const n = c.counts && Number.isFinite(c.counts.passed) ? ` · ${num(c.counts.passed)} PASSED${Number.isFinite(c.counts.failed) ? ` · ${num(c.counts.failed)} FAILED` : ""}` : "";
    const when = clock(c.ts);
    if (c.status === "failed") add("check", `${w} FAILED AT ${when}${n}`, sure(c.basis));
    else if (c.status === "stale") add("check", `${w} PASSED AT ${when} · OUT OF DATE AFTER LATER EDITS${n}`, "inferred"); // no longer verified
    else add("check", `${w} PASSED AT ${when}${n}`, sure(c.basis));
  }

  for (const w of wins.slice(0, MAX_STEP_ITEMS)) {
    const ok = w.tier === "confirmed" || w.tier === "verified";
    const ag = w.kind === "subagent" ? agents.find((a) => a.id === w.agentId) : null;
    const base = ag ? `${word(AGENT_WORD, ag.type, "HELPER")} DELIVERED` : `${word(STEP_WORD, w.kind, "STEP")} DONE`;
    add("milestone", `${base} AT ${clock(w.ts)}`, ok && w.basis !== "inferred" ? "verified" : "inferred");
  }

  const running = agents.filter((a) => a.state === "active" || a.state === "running");
  if (t.live && running.length) add("agents", `${plural(num(running.length), "HELPER", "HELPERS")} WORKING`, "inferred");
  for (const a of agents.filter((x) => x.end).slice(-3).reverse()) {
    const who = word(AGENT_WORD, a.type, "HELPER");
    if (a.state === "lost" || a.endBasis === "lost") add("agents", `${who} STOPPED REPORTING AT ${clock(a.end)}`, "inferred");
    else add("agents", `${who} FINISHED AT ${clock(a.end)}`, sure(a.endBasis));
  }

  if (!out.length) add("progress", "TASK IN PROGRESS · NO STEPS YET", "verified");
  return out.map((i) => ({ ...i, text: drawable(i.text) }));
}

const itemText = (i) => (i.kind === "idle" ? i.text : `${i.text} · ${MARK[i.basis]}`);

// One scrolling line. Idle is a single static message.
export function tickerLine(items) { return items.map(itemText).join(SEP); }

// ---- scrolling (window columns = display characters) ----
// The visible slice of a looping tape (blank window, text, blank window): the text enters from the right.
export function windowText(text, offset, width) {
  const tape = " ".repeat(width) + text + " ".repeat(width);
  const n = tape.length; const o = ((Math.floor(offset) % n) + n) % n; let out = "";
  for (let i = 0; i < width; i++) out += tape[(o + i) % n];
  return out;
}

// Reduced motion: the same items as static pages of at most `width` characters, word-wrapped.
export function staticPages(items, width) {
  const pages = [];
  for (const i of items) {
    let line = "";
    for (const w of itemText(i).split(" ").filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (next.length <= width) line = next; else { if (line) pages.push(line); line = w.slice(0, width); }
    }
    if (line) pages.push(line);
  }
  return pages.length ? pages : [IDLE_TEXT];
}

const fit = (t, w) => String(t).slice(0, w).padEnd(w, " ");
export class TickerScroller {
  constructor({ width = 28, colsPerSec = 7, pageMs = 3000 } = {}) { Object.assign(this, { width, colsPerSec, pageMs, text: "", offset: 0, last: null, pageClock: 0 }); }
  setText(text, { reset = false } = {}) { if (reset) { this.offset = 0; this.pageClock = 0; } this.text = text; }
  // Returns the string for the window. `paused` freezes both modes; time spent paused is not caught up on resume.
  frame(nowMs, { paused = false, reduced = false, pages = null } = {}) {
    const dt = this.last == null ? 0 : Math.max(0, Math.min(nowMs - this.last, 250)); this.last = nowMs;
    if (!paused) { this.offset += (dt * this.colsPerSec) / 1000; this.pageClock += dt; }
    if (reduced && pages) return fit(pages[Math.floor(this.pageClock / this.pageMs) % pages.length], this.width);
    if (this.text.length <= this.width) return fit(this.text, this.width);
    return windowText(this.text + SEP, this.offset, this.width);
  }
}
