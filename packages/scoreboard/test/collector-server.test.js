import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { recordFor, signature, testCounts } from "../../../collector/eta-hook.mjs";
import { parseHookLog } from "../../event-engine/src/adapters/claudeHooks.js";
import { createScoreboardServer, FileTail } from "../server.js";

const SECRET = "TEST-SECRET-PLACEHOLDER";

test("collector records never carry command text, prompt text or tool output; only a signature and counts", () => {
  const rec = recordFor({ hook_event_name: "PostToolUse", session_id: "s", cwd: "C:/Users/x/proj", tool_name: "Bash", tool_use_id: "tu1", duration_ms: 1500, tool_input: { command: `cd C:/proj && npm test -- --token ${SECRET}` }, tool_response: { stdout: `${SECRET}\nℹ tests 5\nℹ pass 4\nℹ fail 1\nℹ duration_ms 321` } }, "PostToolUse", Date.now());
  const json = JSON.stringify(rec);
  assert.ok(!json.includes(SECRET)); assert.ok(!json.includes("--token")); assert.ok(!json.includes("C:/proj"));
  assert.equal(rec.sig, "npm test"); assert.deepEqual(rec.tests, { framework: "node:test", passed: 4, failed: 1, skipped: 0, ok: false, durationMs: 321 }); assert.equal(rec.v, 5); assert.equal(rec.proj, "proj");
  const prompt = recordFor({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: `please use ${SECRET}` }, "UserPromptSubmit", Date.now());
  assert.ok(!JSON.stringify(prompt).includes(SECRET)); assert.equal(prompt.promptLen, `please use ${SECRET}`.length);
  const plain = recordFor({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "echo hello" }, tool_response: { stdout: "hello" } }, "PostToolUse", Date.now());
  assert.equal(plain.sig, "echo"); assert.equal(plain.tests, undefined, "non-test commands never parse output");
});

test("command signatures keep the executable and a plain subcommand only", () => {
  assert.equal(signature("git commit -m 'secret message'"), "git commit");
  assert.equal(signature("SECRET=abc node scripts/deploy.js --key xyz"), "node");
  assert.equal(signature('"C:/Program Files/Git/bin/git.exe" status'), "git status");
  assert.equal(signature("cd C:/repo && npm run test:unit"), "npm run test:unit");
  assert.equal(signature("curl https://user:pass@host/x"), "curl");
  assert.equal(signature("user:token@host"), "cmd"); // 3.2.2: not an allowlisted executable
  assert.equal(signature("   "), null); assert.equal(signature(undefined), null);
  assert.equal(signature("python -I script.py"), "python");
});

test("test counts are recognised for several frameworks and ignored otherwise", () => {
  assert.deepEqual(testCounts("Tests:       2 failed, 1 skipped, 40 passed, 43 total"), { framework: "jest", passed: 40, failed: 2, skipped: 1, ok: false, durationMs: null });
  assert.equal(testCounts("TOTAL: 12 passed, 0 failed").framework, "godot-runner");
  assert.equal(testCounts("========= 3 passed, 1 skipped in 0.5s =========").passed, 3);
  assert.deepEqual(testCounts("test result: ok. 17 passed; 0 failed; 0 ignored").framework, "cargo");
  assert.equal(testCounts("ok 1 a\nok 2 b\nnot ok 3 c").failed, 1);
  assert.equal(testCounts("nothing to see"), null); assert.equal(testCounts(""), null);
});

test("the hooks adapter turns v2 records into a tool.result with a signature plus an observed test.run", () => {
  const line = JSON.stringify({ ts: "2026-11-09T10:00:00.000Z", ev: "PostToolUse", sid: "s", proj: "p", tool: "Bash", tuid: "tu1", durMs: 10, v: 2, sig: "npm test", tests: { framework: "node:test", passed: 4, failed: 1, skipped: 0, ok: false, durationMs: 321 } });
  const events = parseHookLog(line + "\n", { file: "f.jsonl", lineOffset: 41 });
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "tool.result"); assert.equal(events[0].payload.signature, "npm test"); assert.equal(events[0].provenance.raw.line, 42); assert.equal(events[0].provenance.adapter, "claude-hooks@2");
  assert.ok(events[0].classification.some((c) => c.scheme === "operation" && c.value === "test"));
  assert.equal(events[1].kind, "test.run"); assert.equal(events[1].payload.ok, false); assert.equal(events[1].payload.failed, 1); assert.equal(events[1].provenance.observed, true);
  const same = parseHookLog(line + "\n", { file: "f.jsonl", lineOffset: 41 });
  assert.equal(same[0].id, events[0].id, "stable ids across tails");
  assert.notEqual(parseHookLog(line + "\n", { file: "f.jsonl", lineOffset: 0 })[0].id, events[0].id);
});

test("FileTail delivers appended complete lines with absolute line numbers and survives truncation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-tail-")); const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, "a\nb\n"); const got = [];
  const tail = new FileTail(file, (chunk, first) => got.push([chunk, first]));
  tail.readNew(); assert.deepEqual(got, [["a\nb\n", 0]]);
  fs.appendFileSync(file, "c\npartial"); tail.readNew(); assert.deepEqual(got[1], ["c\n", 2]);
  fs.appendFileSync(file, "-done\n"); tail.readNew(); assert.deepEqual(got[2], ["partial-done\n", 3]);
  fs.writeFileSync(file, "z\n"); tail.readNew(); assert.deepEqual(got[3], ["z\n", 0], "truncation restarts numbering");
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(port, p, headers = {}) { return new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p, headers }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b, headers: r.headers })); }).on("error", rej)); }
function post(port, p, body, extra = { "x-alexandria-ingest": "1" }) { return new Promise((res, rej) => { const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", ...extra } }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b })); }); req.on("error", rej); req.end(body); }); }
// Opens the SSE stream and resolves with a function that waits for the next event of a type.
function sse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
      let buf = ""; const waiters = []; const queue = [];
      res.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); const type = /^event: (.*)$/m.exec(frame)?.[1]; const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] || "null"); const w = waiters.findIndex((x) => x.type === type); if (w >= 0) waiters.splice(w, 1)[0].resolve(data); else queue.push({ type, data }); } });
      resolve({ next: (type) => { const q = queue.findIndex((x) => x.type === type); if (q >= 0) return Promise.resolve(queue.splice(q, 1)[0].data); return new Promise((r) => waiters.push({ type, resolve: r })); }, close: () => req.destroy() });
    }).on("error", reject);
  });
}

test("server: snapshot on connect, live events as the hook log grows, marks over ingest, status and predictions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-srv-")); const hookLog = path.join(dir, "events.jsonl"); const dataDir = path.join(dir, "data");
  const sid = "11111111-2222-3333-4444-555555555555";
  const hook = (ts, ev, extra = {}) => JSON.stringify({ ts, ev, sid, proj: "proj", ...extra }) + "\n";
  fs.writeFileSync(hookLog, hook("2026-11-09T10:00:00.000Z", "SessionStart", { source: "startup" }) + hook("2026-11-09T10:00:01.000Z", "UserPromptSubmit", { promptLen: 800 }) + hook("2026-11-09T10:00:10.000Z", "PostToolUse", { tool: "Edit", tuid: "t1", durMs: 5 }));
  // The fixture uses fixed timestamps; widen the snapshot window so the test does not expire 24 h after it was written.
  const app = createScoreboardServer({ port: 0, hookLog, dataDir, git: false, log: () => {}, snapshotHours: 24 * 365 * 50, transcripts: false, registry: false });
  const port = await app.listen();
  try {
    const st = JSON.parse((await get(port, "/api/status")).body);
    assert.equal(st.sources.hookLog.events, 3); assert.equal(st.focus, sid); assert.equal(st.sessions[0].project, "proj");
    const stream = await sse(port);
    const snap = await stream.next("snapshot");
    assert.equal(snap.events.length, 3); assert.equal(snap.events[0].kind, "session.start");
    fs.appendFileSync(hookLog, hook("2026-11-09T10:00:20.000Z", "PostToolUseFailure", { tool: "Bash", tuid: "t2", failed: true, sig: "npm run build" }) + hook("2026-11-09T10:00:21.000Z", "Notification", { kind: "permission_prompt" }));
    const live = await stream.next("events");
    assert.deepEqual(live.map((e) => e.kind), ["tool.failure", "notification"]);
    const snapAfter = app.board.snapshot(sid, Date.parse("2026-11-09T10:00:30.000Z"));
    assert.equal(snapAfter.fouls.value, 1, "a failed build is a foul"); assert.equal(snapAfter.waiting.kind, "approval"); assert.equal(snapAfter.timeouts.value, 1); assert.equal(snapAfter.task.toolCalls, 2); assert.equal(snapAfter.home.value, 0);
    // marks via ingest: declared estimate then completion → prediction persisted
    const mk = (kind, ts, payload, observed = true) => ({ schema: "alexandria.event/1", id: `mark_${kind}_${ts}`, ts, source: "marks", kind, session: { id: sid, project: "proj" }, actor: { type: "human" }, task: { id: "T9", title: "Ingested task" }, payload, provenance: { observed, adapter: "test", confidence: 1 } });
    let r = await post(port, "/api/ingest", JSON.stringify([mk("task.start", "2026-11-09T10:01:00.000Z", {}), mk("task.estimate", "2026-11-09T10:01:01.000Z", { p50Min: 5, calls: 4 }, false)]));
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).accepted, 2);
    const marks = await stream.next("events"); assert.deepEqual(marks.map((e) => e.kind), ["task.start", "task.estimate"]);
    const s2 = app.board.snapshot(sid, Date.parse("2026-11-09T10:02:00.000Z")); assert.equal(s2.task.id, "T9"); assert.equal(s2.guest.value, 4); assert.equal(s2.game.mode, "countdown"); assert.equal(s2.game.estimate, true, "a declared estimate without history is low confidence: a labelled estimate with a range");
    r = await post(port, "/api/ingest", JSON.stringify([mk("task.end", "2026-11-09T10:11:00.000Z", {})])); assert.equal(r.status, 200);
    await stream.next("events");
    const pred = JSON.parse((await get(port, "/api/predictions")).body);
    assert.equal(pred.history.length, 1); assert.equal(pred.history[0].actualWorkMin, 10); assert.equal(pred.history[0].errorRatio, 0.5);
    assert.ok(fs.existsSync(app.predictionsFile), "completed predictions persisted"); assert.equal(fs.readFileSync(app.predictionsFile, "utf8").trim().split("\n").length, 1);
    // ingest rejects foreign sources and invalid events
    r = await post(port, "/api/ingest", JSON.stringify([{ ...mk("task.start", "2026-11-09T10:20:00.000Z", {}), source: "claude-hooks" }])); assert.equal(r.status, 400);
    r = await post(port, "/api/ingest", "{\"nope\":1}"); assert.equal(r.status, 400);
    // local-only: foreign Host (DNS rebinding) and foreign Origin (another web page) are refused; ingest needs its header
    assert.equal((await get(port, "/api/status", { host: "evil.example:80" })).status, 403);
    assert.equal((await get(port, "/api/status", { origin: "https://evil.example" })).status, 403);
    assert.equal((await get(port, "/api/status", { origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await get(port, "/api/status", { origin: "http://localhost:1" })).status, 403, "another local port is another origin");
    assert.equal((await post(port, "/api/ingest", "[]", {})).status, 403, "no header → refused (a web page cannot add it without a preflight)");
    assert.equal((await get(port, "/api/status")).headers["access-control-allow-origin"], undefined);
    // static + redirect
    assert.equal((await get(port, "/")).status, 302); assert.equal((await get(port, "/packages/scoreboard/")).status, 200); assert.equal((await get(port, "/packages/scoreboard/app.js")).headers["content-type"], "text/javascript; charset=utf-8"); assert.equal((await get(port, "/../etc/passwd")).status, 404);
    stream.close();
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("server restores completed predictions from disk so calibration survives restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-srv2-")); const dataDir = path.join(dir, "data"); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "predictions.jsonl"), [1, 2, 3].map((i) => JSON.stringify({ taskId: `t${i}`, session: "old", completedAt: "x", errorRatio: 2, p50Min: 2, actualWorkMin: 1 })).join("\n") + "\n");
  const app = createScoreboardServer({ port: 0, hookLog: path.join(dir, "missing.jsonl"), dataDir, git: false, log: () => {}, transcripts: false, registry: false });
  const port = await app.listen();
  try { const st = JSON.parse((await get(port, "/api/status")).body); assert.equal(st.calibration.n, 3); assert.equal(st.calibration.k, 0.5); assert.equal(st.sources.hookLog.present, false); } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("collector v3 lifecycle records keep only error types, tool names, triggers and model ids", () => {
  const t = Date.now();
  const recs = [
    recordFor({ session_id: "s", error: "rate_limit", error_details: "429 Too Many Requests", last_assistant_message: `API Error: ${SECRET}` }, "StopFailure", t),
    recordFor({ session_id: "s", error: "something_new", error_details: SECRET }, "StopFailure", t),
    recordFor({ session_id: "s", tool_name: "Bash", tool_input: { command: SECRET }, permission_suggestions: [SECRET] }, "PermissionRequest", t),
    recordFor({ session_id: "s", tool_name: "Bash", tool_use_id: "tu", reason: SECRET }, "PermissionDenied", t),
    recordFor({ session_id: "s", trigger: "auto", custom_instructions: SECRET }, "PreCompact", t),
    recordFor({ session_id: "s", from_model: "claude-opus-5-5", to_model: `x ${SECRET}` }, "PostModelSwitch", t),
    recordFor({ session_id: "s", source: "startup", model: "claude-opus-5-5", effort: "high" }, "SessionStart", t),
    recordFor({ session_id: "s", notification_type: "quota_auto_resume_fired", message: SECRET }, "Notification", t),
  ];
  assert.ok(!JSON.stringify(recs).includes(SECRET));
  assert.equal(recs[0].error, "rate_limit"); assert.equal(recs[0].status, 429);
  assert.equal(recs[1].error, "unknown", "unlisted error types collapse to unknown"); assert.equal(recs[1].status, undefined);
  assert.equal(recs[2].tool, "Bash"); assert.equal(recs[3].tuid, "tu"); assert.equal(recs[4].trigger, "auto");
  assert.equal(recs[5].fromModel, "claude-opus-5-5"); assert.equal(recs[5].toModel, undefined, "a value that is not a plain id is dropped");
  assert.equal(recs[6].model, "claude-opus-5-5"); assert.equal(recs[6].effort, "high"); assert.equal(recs[7].kind, "quota_auto_resume_fired");
});

test("collector v3 installer merge adds only missing events, copies the installed command, and leaves everything else alone", async () => {
  const { mergeHooks, NEW_EVENTS } = await import("../../../tools/install-collector-v3.mjs");
  const cmd = { type: "command", command: 'node "C:/x/.claude/eta/eta-hook.mjs"', timeout: 5 };
  const settings = { env: { A: "1" }, permissions: { allow: ["x"] }, hooks: { Stop: [{ hooks: [cmd] }], PreCompact: [{ hooks: [{ type: "command", command: "other-tool" }] }], PostCompact: [{ hooks: [cmd] }] } };
  const { settings: out, added } = mergeHooks(settings);
  assert.deepEqual(added, NEW_EVENTS.filter((e) => e !== "PostCompact"), "an event that already has the collector is not added twice");
  assert.equal(out.hooks.PreCompact.length, 2, "an unrelated hook on the same event is kept"); assert.equal(out.hooks.PreCompact[0].hooks[0].command, "other-tool");
  assert.deepEqual(out.hooks.StopFailure[0].hooks[0], cmd); assert.deepEqual(out.env, settings.env); assert.deepEqual(out.permissions, settings.permissions);
  assert.equal(settings.hooks.StopFailure, undefined, "input not mutated");
  assert.deepEqual(mergeHooks(out).added, [], "idempotent");
  const ft = mergeHooks({ hooks: {} }, undefined, "C:/home/test"); // protocol 3.2: first-time install instead of an error
  assert.equal(ft.firstTime, true); assert.equal(ft.added.length, 16); assert.ok(ft.settings.hooks.Stop[0].hooks[0].command.includes("C:/home/test/.claude/eta/eta-hook.mjs"));
});

test("FileTail reads a large backlog in bounded slices after startup, and a throwing consumer is contained", async () => {
  const { FileTail } = await import("../server.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-tail-")); const file = path.join(dir, "big.jsonl");
  fs.writeFileSync(file, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(100) })).join("\n") + "\n");
  const chunks = []; const errors = [];
  const tail = new FileTail(file, (chunk, first) => { chunks.push([chunk.split("\n").length - 1, first]); if (chunks.length === 2) throw new Error("boom"); }, { maxBytes: 64 * 1024, onError: (e) => errors.push(e.message) });
  tail.readNew();
  assert.equal(chunks.length, 1, "first call reads one slice only");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(chunks.reduce((n, c) => n + c[0], 0), 2000, "every line delivered across slices, none twice");
  assert.deepEqual(errors, ["boom"], "the error was reported, not thrown");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("FileTail keeps multi-byte characters whole across slice boundaries", async () => {
  const { FileTail } = await import("../server.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-utf8-")); const file = path.join(dir, "u.jsonl");
  const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ i, t: "é€😀".repeat(7) + "ü" }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  let got = "";
  const tail = new FileTail(file, (chunk) => { got += chunk; }, { maxBytes: 1001 }); // odd size: slices split characters
  tail.readNew(); await new Promise((r) => setTimeout(r, 300));
  assert.equal(got, lines.join("\n") + "\n"); assert.ok(!got.includes("�"));
  fs.rmSync(dir, { recursive: true, force: true });
});
