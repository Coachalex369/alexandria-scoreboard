// Protocol compatibility: every collector version ever written (v1, v2, v3, v4) must keep parsing; unknown future
// events and garbage lines are skipped, never thrown.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHookLog } from "../src/adapters/claudeHooks.js";
import { Replayer, LiveState } from "../src/replay.js";

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "hook-lines.jsonl"), "utf8");

test("hook lines from collector v1, v2, v3 and v4 all parse; unknown events and bad lines are skipped", () => {
  const evs = parseHookLog(fixture);
  assert.deepEqual(evs.map((e) => e.kind), ["prompt.submit", "tool.result", "tool.result", "test.run", "session.start", "permission.request", "api.error", "model.switch", "tool.result", "git.commit", "tool.result", "test.run", "tool.result"]);
  assert.deepEqual([...new Set(evs.map((e) => e.provenance.adapter))].sort(), ["claude-hooks@1", "claude-hooks@2", "claude-hooks@3", "claude-hooks@4", "tests@1"]);
  assert.equal(evs.find((e) => e.kind === "api.error").payload.error, "rate_limit");
  assert.equal(evs.find((e) => e.kind === "session.start").payload.model, "claude-opus-5-5");
});

test("collector v4 chain records yield signatures, an observed git.commit (hash only) and test.run", () => {
  const evs = parseHookLog(fixture).filter((e) => e.session.id === "fx-v4");
  assert.deepEqual(evs[0].payload.signatures, ["git add", "git commit"]);
  assert.equal(evs[1].kind, "git.commit"); assert.deepEqual(evs[1].payload, { hash: "a1b2c3d4e5f6", via: "hook" }); assert.equal(evs[1].provenance.observed, true); assert.equal(evs[1].source, "claude-hooks");
  assert.equal(evs.filter((e) => e.kind === "git.commit").length, 1, "a v4 record without commit yields no git.commit");
  assert.equal(evs.find((e) => e.kind === "test.run").payload.passed, 12);
});

test("events from every collector version replay through the generic replay used by both applications", () => {
  const evs = parseHookLog(fixture);
  const live = new LiveState(); for (const e of evs) live.apply(e);
  assert.deepEqual([...live.sessions.keys()].sort(), ["fx-v1", "fx-v2", "fx-v3", "fx-v4"]);
  assert.equal(live.sessions.get("fx-v2").toolCalls, 1);
  const seen = []; const r = new Replayer(evs); r.on("event", ({ event }) => seen.push(event.kind)); r.drain();
  assert.equal(seen.length, evs.length, "the replay delivers every event of every version");
});
