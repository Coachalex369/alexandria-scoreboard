import assert from "node:assert/strict";
import { test } from "node:test";
import { TAXONOMY, LEVELS, values, isValue, languageOfPath, operationOfTool, classifyRunSignature, classifyPath, classifyToolEvent, classifyTaskTitle, hintsFor } from "../src/index.js";

test("hierarchy has the eight approved levels in order", () => {
  assert.deepEqual(LEVELS, ["project", "session", "main-task", "subtask", "agent", "work-category", "code-structure", "operation"]);
});

test("every work-category value carries visual and musical hints; every operation lists tools or a note", () => {
  for (const v of values("work-category")) { const h = hintsFor("work-category", v); assert.ok(Number.isFinite(h.hue) && h.shape && h.instrument, v); }
  for (const [v, m] of Object.entries(TAXONOMY.schemes.operation.values)) assert.ok(m.tools.length || m.note || v === "other", v);
  assert.ok(isValue("code-structure", "function") && !isValue("code-structure", "banana"));
});

test("language from extension is observed; unknown extensions give null", () => {
  assert.equal(languageOfPath("src/a.ts"), "typescript");
  assert.equal(languageOfPath("game/ui/run_screen.gd"), "gdscript");
  assert.equal(languageOfPath("C:\\x\\y.SQL"), "sql");
  assert.equal(languageOfPath("Makefile"), null);
});

test("operation from tool name, refined by a run signature", () => {
  assert.equal(operationOfTool("Edit"), "edit");
  assert.equal(operationOfTool("Agent"), "delegate");
  assert.equal(operationOfTool("mcp__claude-in-chrome__navigate"), "browse");
  assert.equal(operationOfTool("mcp__something__else"), "browse");
  assert.equal(operationOfTool("Unknown"), "other");
  const t = classifyRunSignature("npm test");
  assert.ok(t.some((c) => c.scheme === "operation" && c.value === "test") && t.some((c) => c.value === "testing"));
  assert.ok(classifyRunSignature("git commit -q -m").some((c) => c.value === "commit"));
  assert.ok(classifyRunSignature("godot --headless --path game res://tests/run_tests.tscn").some((c) => c.value === "test"));
  assert.deepEqual(classifyRunSignature("echo hi"), []);
});

test("paths yield several non-exclusive labels", () => {
  const c = classifyPath("server/db/migrations/047_x.sql");
  const vals = c.map((x) => x.scheme + ":" + x.value);
  assert.ok(vals.includes("language:sql") && vals.includes("work-category:database") && vals.includes("work-category:backend"));
  const d = classifyPath("game/tests/test_route_curve.gd").map((x) => x.scheme + ":" + x.value);
  assert.ok(d.includes("work-category:testing") && d.includes("language:gdscript") && d.includes("work-category:frontend"));
});

test("tool events combine operation, path and signature labels and dedupe by max confidence", () => {
  const c = classifyToolEvent({ toolName: "Bash", signature: "node --test test/*.test.js", paths: ["test/app.test.js"] });
  const testing = c.filter((x) => x.scheme === "work-category" && x.value === "testing");
  assert.equal(testing.length, 1, "deduped");
  assert.equal(c.find((x) => x.scheme === "operation").value, "test");
  const r = classifyToolEvent({ toolName: "WebSearch" });
  assert.ok(r.some((x) => x.value === "research"));
});

test("task titles map to the operating-mode task types with low confidence", () => {
  assert.equal(classifyTaskTitle("Deploy the landing page").value, "gatekeeper");
  assert.equal(classifyTaskTitle("Whatever Mode speed lines VFX").value, "studio");
  assert.equal(classifyTaskTitle("Remove unused favicon.svg").value, "mechanic");
  assert.equal(classifyTaskTitle("Localize server-side error messages").value, "builder");
  assert.ok(classifyTaskTitle("anything").confidence <= 0.5);
});
