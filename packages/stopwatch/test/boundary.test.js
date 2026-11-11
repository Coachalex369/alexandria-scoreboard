// The stopwatch/ETA engine is independent of Claude Code, the event-engine adapters and the Scoreboard UI:
// it imports only its own files and names no hook or UI specifics.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src");
const files = fs.readdirSync(src).filter((f) => f.endsWith(".js"));

test("stopwatch engine imports only its own sources", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)[^"'\n]*from\s*["']([^"']+)["']/gm)) assert.ok(m[1].startsWith("./"), `${f} imports ${m[1]}`);
  }
});

test("stopwatch engine names no Claude Code or Scoreboard specifics", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const w of ["PostToolUse", "SessionStart", "StopFailure", "Notification", "hook", "claude", "transcript", "scoreboard", "events.jsonl", "document.", "window."]) assert.ok(!text.toLowerCase().includes(w.toLowerCase()), `${f} mentions ${w}`);
  }
});
