// Durability: restart recovery, ledger de-duplication, partial records after log rotation, transcript supplement.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScoreboardServer } from "../server.js";
import { Ledger, readJsonl, writeAtomic } from "../src/ledger.js";

const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const hook = (ts, ev, extra = {}) => JSON.stringify({ ts, ev, sid, proj: "proj", v: 3, ...extra }) + "\n";
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-dur-"));
  const projectsDir = path.join(dir, "projects"); fs.mkdirSync(projectsDir);
  return { dir, hookLog: path.join(dir, "events.jsonl"), dataDir: path.join(dir, "data"), projectsDir };
};
const start = (f, extra = {}) => createScoreboardServer({ port: 0, hookLog: f.hookLog, dataDir: f.dataDir, projectsDir: f.projectsDir, git: false, log: () => {}, snapshotHours: 24 * 365 * 50, checkpointMs: 60e3, transcriptPollMs: 60e3, ...extra });
const LOG = [
  hook("2026-11-10T10:00:00.000Z", "UserPromptSubmit", { promptLen: 900 }),
  hook("2026-11-10T10:05:00.000Z", "PostToolUse", { tool: "Edit", tuid: "t1", durMs: 10 }),
  hook("2026-11-10T10:10:00.000Z", "Stop"),
  hook("2026-11-10T11:00:00.000Z", "UserPromptSubmit", { promptLen: 1500 }), // new brief: the first task completes
  hook("2026-11-10T11:03:00.000Z", "PermissionRequest", { tool: "Bash" }),
  hook("2026-11-10T11:04:00.000Z", "PostToolUse", { tool: "Bash", tuid: "t2", durMs: 30000 }),
].join("");

test("a restarted server rebuilds the open task's clock exactly and never duplicates ledger records", async () => {
  const f = fixture(); fs.writeFileSync(f.hookLog, LOG);
  const at = Date.parse("2026-11-10T11:10:00.000Z");
  let app = start(f); await app.listen();
  let before;
  try {
    before = app.board.snapshot(sid, at);
    // the turn is still open at 11:10: 10 minutes of wall time minus the 30 s approval (11:03 → tool start 11:03:30)
    assert.equal(before.stopwatch.activeMs, 10 * 60e3 - 30e3); assert.equal(before.stopwatch.byKind.approval, 30e3);
    assert.equal(readJsonl(app.ledger.tasksFile).length, 1, "the superseded first brief is recorded once");
    assert.equal(readJsonl(app.ledger.tasksFile)[0].actualActiveMs, 10 * 60e3);
  } finally { await app.close(); }
  app = start(f); await app.listen();
  try {
    const after = app.board.snapshot(sid, at);
    assert.deepEqual(after.stopwatch, before.stopwatch);
    assert.equal(readJsonl(app.ledger.tasksFile).length, 1, "replaying the log after a restart adds no duplicate");
    assert.equal(app.status().sources.ledger.recovered, 0);
  } finally { await app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("a task whose source log was truncated while open is recovered from the checkpoint as a partial record", async () => {
  const f = fixture(); fs.writeFileSync(f.hookLog, LOG);
  let app = start(f); await app.listen(); app.checkpoint(); await app.close();
  const cp = JSON.parse(fs.readFileSync(path.join(f.dataDir, "checkpoint.json"), "utf8"));
  assert.equal(cp.open.length, 1);
  fs.writeFileSync(f.hookLog, ""); // rotated away
  app = start(f); await app.listen();
  try {
    const recs = readJsonl(app.ledger.tasksFile);
    const partial = recs.find((r) => r.partial);
    assert.ok(partial, "partial record written"); assert.equal(partial.endReason, "recovered-after-restart"); assert.equal(app.status().sources.ledger.recovered, 1);
    assert.ok(!new Ledger(f.dataDir).history().some((r) => r.partial), "partial records never feed calibration");
  } finally { await app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("the server tails the live session's transcript in supplement mode: observed model, tokens, rate limit", async () => {
  const f = fixture(); fs.writeFileSync(f.hookLog, LOG);
  const pdir = path.join(f.projectsDir, "C--proj"); fs.mkdirSync(pdir);
  const tx = [
    { type: "user", timestamp: "2026-11-10T11:00:00.000Z", sessionId: sid, message: { role: "user", content: "SECRET-PROMPT" } },
    { type: "assistant", timestamp: "2026-11-10T11:00:05.000Z", sessionId: sid, uuid: "a1", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "SECRET-REPLY" }], usage: { input_tokens: 5, output_tokens: 99 } } },
    { type: "assistant", timestamp: "2026-11-10T11:05:00.000Z", sessionId: sid, uuid: "e1", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: { resetsAt: 1762776000 }, message: { id: "x", model: "<synthetic>", content: [] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  fs.writeFileSync(path.join(pdir, `${sid}.jsonl`), tx);
  const app = start(f); await app.listen();
  try {
    const st = app.status();
    assert.equal(st.sources.transcripts.files, 1); assert.equal(st.sources.transcripts.events, 2);
    const s = app.board.snapshot(sid, Date.parse("2026-11-10T11:20:00.000Z"));
    assert.equal(s.model.value, "claude-opus-5-5"); assert.equal(s.tokens.outputTokens, 99);
    assert.equal(s.stopwatch.kind, "rate_limit"); assert.ok(s.rateLimit.resetsAt);
    assert.ok(!JSON.stringify(app.events).includes("SECRET"), "no transcript content in the server's event list");
  } finally { await app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("atomic writes leave the old or the new file, and a torn last ledger line is skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-atom-")); const file = path.join(dir, "x.json");
  writeAtomic(file, "old"); writeAtomic(file, "new"); assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["x.json"], "no temp files left behind");
  fs.writeFileSync(path.join(dir, "t.jsonl"), '{"id":"a"}\n{"id":"b"}\n{"id":"c"'); assert.deepEqual(readJsonl(path.join(dir, "t.jsonl")).map((r) => r.id), ["a", "b"]);
  const l = new Ledger(dir); assert.equal(l.append({ id: "z" }), true); assert.equal(l.append({ id: "z" }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("live and backfilled records of the same work are never both used for calibration", async () => {
  const { dropOverlapping } = await import("../src/ledger.js");
  const live = [{ id: "s1:live", session: "s1", startedAt: "2026-11-10T10:00:00.000Z", endedAt: "2026-11-10T11:00:00.000Z" }];
  const back = [
    { id: "s1:tx-a", session: "s1", startedAt: "2026-11-10T10:30:00.000Z", endedAt: "2026-11-10T10:40:00.000Z" }, // overlaps → dropped
    { id: "s1:tx-b", session: "s1", startedAt: "2026-11-10T12:00:00.000Z", endedAt: "2026-11-10T12:30:00.000Z" }, // later → kept
    { id: "s2:tx-c", session: "s2", startedAt: "2026-11-10T10:30:00.000Z", endedAt: "2026-11-10T10:40:00.000Z" }, // other session → kept
  ];
  assert.deepEqual(dropOverlapping(back, live).map((r) => r.id), ["s1:tx-b", "s2:tx-c"]);
});

test("eval scoring: log errors, range coverage, repeat spread and per-model medians from registered predictions", async () => {
  const { scoreRuns } = await import("../../../tools/sb-eval.js");
  const P = (p50, p10 = null, p90 = null, state = "estimating") => ({ state, p50: p50 && p50 * 60000, p10: p10 && p10 * 60000, p90: p90 && p90 * 60000 });
  const runs = [
    { runId: "A-r1", predictions: { "declared-raw": P(10), "v02-declared": P(5, 2, 10), "v02-reference": P(null, null, null, "insufficient-data") } },
    { runId: "A-r2", predictions: { "declared-raw": P(10), "v02-declared": P(5, 2, 10), "v02-reference": P(4, 1, 8) } },
  ];
  const results = [{ runId: "A-r1", task: "A", model: "sonnet", activeMs: 5 * 60000, wallMs: 6 * 60000, calls: 10, tokens: { outputTokens: 100 } }, { runId: "A-r2", task: "A", model: "sonnet", activeMs: 20 * 60000, wallMs: 21 * 60000, calls: 30, tokens: { outputTokens: 300 } }];
  const r = scoreRuns(runs, results, { "A-r1": { score: 3 } });
  assert.equal(r.aggregate["declared-raw"].scored, 2); assert.ok(Math.abs(r.aggregate["v02-declared"].coverage80 - 0.5) < 1e-9);
  assert.equal(r.aggregate["v02-reference"].insufficient, 1); assert.equal(r.aggregate["v02-reference"].scored, 1);
  assert.equal(r.repeats["A/sonnet"].maxOverMin, 4); assert.equal(r.byModel.sonnet.medianCalls, 20); assert.equal(r.rows[0].quality, 3);
});
