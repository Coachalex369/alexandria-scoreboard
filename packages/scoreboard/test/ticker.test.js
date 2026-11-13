import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../../event-engine/src/schema.js";
import { Board } from "../src/board.js";
import { FONT } from "../src/digits.js";
import { tickerItems, tickerLine, staticPages, windowText, TickerScroller, IDLE_TEXT, MARK } from "../src/ticker.js";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const SECRET = "TICKER-SECRET-MARKER";
const PATH = "C:/Users/someone/private.txt";

const base = (over = {}) => ({
  session: { id: "s1", label: `${SECRET} ${PATH}`, repo: `${SECRET}-repo`, branch: `${PATH}`, labelSource: "title" },
  task: { id: "t1", title: `${SECRET} ${PATH}`, basis: "observed", start: iso(100), end: null, live: true },
  winDetail: { list: [] }, foulDetail: { unresolved: [], resolved: [] }, checks: [], attention: [], agents: [],
  log: [{ ts: iso(150), kind: "tool", text: `${SECRET} ran ${PATH}` }],
  ...over,
});
const joined = (items) => items.map((i) => i.text).join(" / ");

test("(a) only facts from the tracked task: earlier facts and other tasks' subagents are excluded", () => {
  const s = base({
    winDetail: { list: [
      { kind: "commit", tier: "verified", ts: iso(200), basis: "observed", label: "x" },
      { kind: "turn", tier: "verified", ts: iso(10), basis: "observed", label: "before task" },
    ] },
    checks: [
      { kind: "test", status: "valid", ts: iso(210), basis: "observed", counts: { passed: 12, failed: 0 } },
      { kind: "build", status: "valid", ts: iso(20), basis: "observed", counts: null },
    ],
    foulDetail: { unresolved: [{ kind: "test-failure", since: iso(30), basis: "observed" }], resolved: [] },
    agents: [
      { id: "a1", type: "reviewer", taskId: "t1", start: iso(120), end: iso(180), endBasis: "observed", state: "completed" },
      { id: "a2", type: "scout", taskId: "t0", start: iso(5), end: iso(8), endBasis: "observed", state: "completed" },
    ],
  });
  const text = joined(tickerItems(s));
  assert.match(text, /1 STEP DONE/, "only the commit inside the task counts");
  assert.match(text, /12 PASSED/);
  assert.doesNotMatch(text, /BUILD/, "a build check before the task start is excluded");
  assert.doesNotMatch(text, /ISSUE/, "a problem from before the task start is excluded");
  assert.match(text, /REVIEWER FINISHED/);
  assert.doesNotMatch(text, /SCOUT/, "another task's subagent is excluded");
});

test("(a) facts after a finished task's end are excluded", () => {
  const s = base({ task: { ...base().task, end: iso(300), live: false, endReason: "marked" }, winDetail: { list: [{ kind: "commit", tier: "verified", ts: iso(400), basis: "observed" }, { kind: "turn", tier: "verified", ts: iso(250), basis: "observed" }] } });
  assert.match(tickerItems(s)[0].text, /^TASK COMPLETE · 1 STEP DONE/);
});

test("(b) inferred and verified items are marked differently", () => {
  const s = base({
    winDetail: { list: [
      { kind: "commit", tier: "verified", ts: iso(200), basis: "observed" },
      { kind: "turn", tier: "probable", ts: iso(220), basis: "inferred" },
    ] },
    checks: [{ kind: "test", status: "stale", ts: iso(210), basis: "observed", counts: { passed: 3, failed: 0 } }],
  });
  const items = tickerItems(s);
  const commit = items.find((i) => /COMMIT DONE/.test(i.text)), turn = items.find((i) => /WORK TURN/.test(i.text));
  assert.equal(commit.basis, "verified"); assert.equal(turn.basis, "inferred");
  const line = tickerLine(items);
  assert.ok(line.includes(`COMMIT DONE`) && line.includes(MARK.verified) && line.includes(MARK.inferred));
  assert.match(line, /WORK TURN DONE AT \d\d:\d\d · LIKELY\?/);
  assert.match(line, /COMMIT DONE AT \d\d:\d\d · VERIFIED/);
});

test("(c) a completed task leads with a clear completion announcement; a live task does not", () => {
  const done = base({ task: { ...base().task, end: iso(500), live: false, endReason: "marked" }, winDetail: { list: [{ kind: "turn", tier: "verified", ts: iso(300), basis: "observed" }, { kind: "commit", tier: "unverified", ts: iso(310), basis: "observed" }] } });
  const items = tickerItems(done);
  assert.equal(items[0].kind, "complete");
  assert.equal(items[0].text, "TASK COMPLETE · 2 STEPS DONE · 1 VERIFIED");
  const live = tickerItems(base());
  assert.notEqual(live[0].kind, "complete"); assert.match(live[0].text, /^TASK IN PROGRESS/);
});

test("approvals show as YOUR MOVE while live", () => {
  const s = base({ attention: [{ kind: "approval", since: iso(150), basis: "observed", label: `${SECRET}` }] });
  assert.match(joined(tickerItems(s)), /YOUR MOVE · APPROVAL NEEDED SINCE \d\d:\d\d/);
});

test("(d) PRIVACY: no free text, marker or path reaches the ticker", () => {
  const bad = { label: `${SECRET} ${PATH}`, title: `${SECRET}`, note: `${SECRET} ${PATH}`, text: `${SECRET}` };
  const s = base({
    winDetail: { list: [{ kind: `${SECRET}`, tier: "verified", ts: iso(200), basis: "observed", agentId: "a1", ...bad }, { kind: "subagent", tier: "unverified", ts: iso(210), basis: "observed", agentId: "a1", ...bad }] },
    foulDetail: { unresolved: [{ kind: PATH, since: iso(220), basis: "observed", ...bad }], resolved: [{ kind: `${SECRET}`, since: iso(120), resolvedAt: iso(230), resolutionBasis: "inferred", resolvedBy: `${SECRET} ${PATH}`, ...bad }] },
    checks: [{ kind: `${SECRET}`, status: "failed", ts: iso(240), basis: "observed", counts: { passed: 1, failed: 2 }, key: PATH, ...bad }],
    attention: [{ kind: `${SECRET}`, since: iso(250), basis: "inferred", ...bad }],
    agents: [{ id: "a1", type: `${SECRET}\\${PATH}`, taskId: "t1", start: iso(120), end: iso(260), endBasis: "observed", state: "completed", label: SECRET }],
  });
  for (const snap of [s, { ...s, task: { ...s.task, live: false, end: iso(400) } }]) {
    const items = tickerItems(snap);
    const all = joined(items) + "\n" + tickerLine(items) + "\n" + staticPages(items, 28).join("\n");
    for (const needle of [SECRET, "C:/", "/Users/", "\\", "private.txt", "someone"]) assert.ok(!all.includes(needle), `leaked ${needle}`);
    for (const ch of all.replace(/\n/g, "")) assert.ok(FONT[ch], `character ${JSON.stringify(ch)} cannot be drawn`);
  }
});

test("(d) PRIVACY end to end: a real Board fed hostile text yields a clean ticker", () => {
  const b = new Board(); let n = 0;
  const ev = (sec, kind, payload = {}, extra = {}) => makeEvent({ id: `evt_tk_${String(++n).padStart(6, "0")}`, ts: T0 + sec * 1000, source: "claude-hooks", kind, session: { id: "sx", project: SECRET }, actor: extra.actor || { type: "main" }, payload, provenance: { observed: true, adapter: "test", confidence: 1 } });
  b.apply(ev(0, "prompt.submit", { promptLen: 400 }, { actor: { type: "human" } }));
  b.apply(ev(10, "test.run", { framework: "node:test", passed: 9, failed: 0, ok: true, label: `${SECRET} ${PATH}` }));
  b.apply(ev(20, "test.run", { framework: "node:test", passed: 7, failed: 2, ok: false, label: `${SECRET} ${PATH}` }));
  const items = tickerItems(b.snapshot("sx", T0 + 30000));
  assert.ok(items.length > 0 && items[0].kind !== "idle");
  const all = tickerLine(items);
  assert.match(all, /TEST/);
  for (const needle of [SECRET, "C:/", "/Users/", "\\"]) assert.ok(!all.includes(needle), `leaked ${needle}`);
});

test("(e) no session or no task shows the calm idle message; unknown kinds fall back to generic words", () => {
  assert.deepEqual(tickerItems({ session: null, task: null }), [{ text: IDLE_TEXT, basis: "verified", kind: "idle" }]);
  assert.deepEqual(tickerItems(null).map((i) => i.text), [IDLE_TEXT]);
  assert.deepEqual(tickerItems({ session: { id: "x" }, task: null }).map((i) => i.text), [IDLE_TEXT]);
  const t = tickerItems(base({ checks: [{ kind: "zzz", status: "valid", ts: iso(200), basis: "observed" }] }));
  assert.ok(t.some((i) => /^CHECK PASSED AT/.test(i.text)));
});

test("scroller: right-to-left, steady rate, hover pause, reduced-motion pages", () => {
  assert.equal(windowText("ABC", 0, 5), "     ");
  assert.equal(windowText("ABC", 5, 5), "ABC  ");
  assert.equal(windowText("ABC", 6, 5), "BC   ", "text moves left as the offset grows");
  assert.equal(windowText("ABC", 5 + 13, 5), "ABC  ", "wraps after one full loop");
  const s = new TickerScroller({ width: 10, colsPerSec: 8 });
  s.setText("X".repeat(30));
  const run = (from, to, opts) => { for (let t = from; t <= to; t += 100) s.frame(t, opts); };
  run(0, 1000); assert.ok(Math.abs(s.offset - 8) < 1e-9, "8 columns per second");
  run(1100, 2000, { paused: true }); assert.ok(Math.abs(s.offset - 8) < 1e-9, "hover pauses");
  run(2100, 3000); assert.ok(Math.abs(s.offset - 16) < 1e-9, "resumes where it stopped, without catching up");
  s.frame(60000); assert.ok(s.offset - 16 <= 2.01, "a long gap (hidden tab) is not caught up");
  const r = new TickerScroller({ width: 10, pageMs: 1000 }); r.setText("AAAAAAAAAAAAAAAA");
  const pages = ["ONE", "TWO"];
  assert.equal(r.frame(0, { reduced: true, pages }).trim(), "ONE");
  for (let t = 100; t < 1100; t += 100) r.frame(t, { reduced: true, pages });
  assert.equal(r.frame(1100, { reduced: true, pages }).trim(), "TWO");
  for (const p of staticPages(tickerItems(base()), 28)) assert.ok(p.length <= 28);
});

// Regressions.
test("TASK COMPLETE only for a marked task.end that did not fail; an ordinary turn end says TURN ENDED", () => {
  const ended = (endReason, outcome) => joined(tickerItems(base({ task: { id: "t1", basis: "inferred", start: iso(100), end: iso(300), live: false, endReason, outcome } })));
  assert.match(ended("marked", "complete"), /^TASK COMPLETE/);
  assert.doesNotMatch(ended("turn-end", null), /TASK COMPLETE/); assert.match(ended("turn-end", null), /^TURN ENDED · BACK TO YOU/);
  assert.match(ended("marked", "failed"), /^TASK ENDED · NOT COMPLETE/);
  assert.match(ended("session-quiet", null), /^TASK ENDED/); assert.doesNotMatch(ended("session-quiet", null), /COMPLETE/);
});
test("checks and issues of other sessions in the same repository never appear", () => {
  const s = base({
    checks: [{ kind: "test", status: "failed", ts: iso(200), basis: "observed", session: "other" }, { kind: "build", status: "valid", ts: iso(210), basis: "observed", session: "s1" }],
    foulDetail: { unresolved: [{ kind: "test-failure", since: iso(220), basis: "observed", session: "other" }], resolved: [] },
  });
  const text = joined(tickerItems(s));
  assert.doesNotMatch(text, /TEST FAILED|ISSUE/); assert.match(text, /BUILD PASSED/);
});
test("owner attention comes first and is not limited to the task window; stale and ended sessions are announced", () => {
  const s = base({ attention: [{ kind: "approval", since: iso(50), basis: "observed" }], checks: [{ kind: "test", status: "valid", ts: iso(200), basis: "observed" }] });
  const items = tickerItems(s);
  assert.equal(items[0].kind, "approval", "first, so it is never far off screen"); assert.match(items[0].text, /APPROVAL NEEDED/);
  assert.ok(tickerItems(base({ session: { id: "s1", status: "stale" } })).some((i) => i.text === "SESSION QUIET · NO RECENT ACTIVITY"));
  assert.ok(tickerItems(base({ session: { id: "s1", end: iso(400) } })).some((i) => i.text === "SESSION ENDED"));
  const stale = tickerItems(base({ checks: [{ kind: "test", status: "stale", ts: iso(200), basis: "observed" }] })).find((i) => i.kind === "check");
  assert.equal(stale.basis, "inferred", "an out-of-date check is no longer VERIFIED");
});
test("end to end: an ordinary Stop shows TURN ENDED, a marked task.end shows TASK COMPLETE (snapshot carries endReason/outcome)", () => {
  const mk = (t, kind, extra = {}) => makeEvent({ id: `evt_tk_${kind.replace(/\W/g, "")}_${t}`, ts: T0 + t * 1000, source: extra.source || "claude-hooks", kind, session: { id: "sx", project: "p" }, actor: extra.actor || { type: "main" }, task: extra.task, payload: extra.payload, provenance: { observed: true, adapter: "t", confidence: 1 } });
  const b = new Board();
  b.apply(mk(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 100 } })); b.apply(mk(10, "turn.stop"));
  assert.match(joined(tickerItems(b.snapshot("sx", T0 + 20e3))), /^TURN ENDED/);
  b.apply(mk(30, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 100 } }));
  b.apply(mk(31, "task.start", { source: "marks", actor: { type: "human" }, task: { id: "M1", title: "x" } }));
  b.apply(mk(60, "task.end", { source: "marks", actor: { type: "human" }, task: { id: "M1" } }));
  assert.match(joined(tickerItems(b.snapshot("sx", T0 + 70e3))), /^TASK COMPLETE/);
});

test("SESSION ENDED wins over TASK IN PROGRESS", () => {
  const items = tickerItems(base({ session: { id: "s1", end: iso(400) } }));
  assert.ok(items.some((i) => i.text === "SESSION ENDED")); assert.ok(!items.some((i) => /TASK IN PROGRESS/.test(i.text)));
  assert.ok(tickerItems(base({ session: { id: "s1", processGone: true } })).every((i) => !/TASK IN PROGRESS/.test(i.text)));
});
test("a failed marked task is not announced with the horn; a completed one is", async () => {
  const { AlertPolicy } = await import("../src/alerts.js");
  const mk = (t, kind, extra = {}) => makeEvent({ id: `evt_pp_${kind.replace(/\W/g, "")}_${t}`, ts: T0 + t * 1000, source: extra.source || "claude-hooks", kind, session: { id: "sp", project: "p" }, actor: extra.actor || { type: "main" }, task: extra.task, payload: extra.payload, provenance: { observed: true, adapter: "t", confidence: 1 } });
  const run = (payload) => {
    const b = new Board();
    b.apply(mk(0, "prompt.submit", { actor: { type: "human" }, payload: { promptLen: 100 } }));
    b.apply(mk(1, "task.start", { source: "marks", actor: { type: "human" }, task: { id: "F1", title: "x" } }));
    b.apply(mk(9, "task.end", { source: "marks", actor: { type: "human" }, task: { id: "F1" }, payload }));
    return new AlertPolicy().decide(b.takeAlerts(), T0 + 10e3);
  };
  const failed = run({ ok: false });
  assert.ok(!failed.sounds.includes("horn"), "no horn for a failed task"); assert.ok(failed.visible.some((a) => a.kind === "task-ended"));
  assert.ok(run({}).sounds.includes("horn"), "a real completion still sounds the horn");
});

test("failure words (any case, trimmed, US/UK spelling) never sound the horn", async () => {
  const { isFailedOutcome } = await import("../src/board.js");
  for (const o of ["failed", " canceled ", "Cancelled", "failure", "error", "incomplete", "aborted", "not complete", "abandoned"]) assert.equal(isFailedOutcome({ outcome: o }), true, o);
  for (const o of ["done", "complete", "ok", undefined, ""]) assert.equal(isFailedOutcome({ outcome: o }), false, String(o));
  assert.equal(isFailedOutcome({ ok: false, outcome: "done" }), true);
});
