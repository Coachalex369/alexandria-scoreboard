import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSource, structureDiff, structureClassifications, supportsPath, touchedByLines, changedLinesFromHunks } from "../src/codeStructure.js";

test("changed lines are attributed to the innermost enclosing named structure", async () => {
  const src = `function outer() {\n  const x = 1;\n  function inner() {\n    return x + 1;\n  }\n  return inner();\n}\nclass K {\n  m() {\n    return 2;\n  }\n}\n`;
  const t = await touchedByLines(src, [4, 10]);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.name}`), ["function:inner", "method:m"]);
  assert.deepEqual(changedLinesFromHunks("@@ -1,2 +3,2 @@\n+a\n+b\n@@ -9 +12 @@\n+c\n"), [3, 4, 12]);
  assert.deepEqual(await touchedByLines(src, [2]), [{ kind: "function", name: "outer", lines: [1, 7], hits: 1 }]);
});

const BEFORE = `
import fs from "node:fs";
const limit = 3;
function load(file) {
  if (!file) return null;
  for (let i = 0; i < limit; i++) { console.log(i); }
  return fs.readFileSync(file, "utf8");
}
class Store { constructor() { this.items = []; } add(x) { this.items.push(x); } }
`;
const AFTER = `
import fs from "node:fs";
import path from "node:path";
const limit = 3;
function load(file) {
  if (!file) return null;
  for (let i = 0; i < limit; i++) { console.log(i); }
  while (false) {}
  return fs.readFileSync(path.resolve(file), "utf8");
}
const save = (file, data) => fs.writeFileSync(file, data);
class Store { constructor() { this.items = []; } add(x) { this.items.push(x); } clear() { this.items = []; } }
// a comment
`;

test("summarizeSource counts functions, classes, methods, loops, conditions, imports, variables", async () => {
  const s = await summarizeSource(BEFORE);
  assert.equal(s.counts.function, 1);
  assert.equal(s.counts.class, 1);
  assert.equal(s.counts.method, 2, "constructor + add");
  assert.equal(s.counts.loop, 1);
  assert.equal(s.counts.condition, 1);
  assert.equal(s.counts.import, 1);
  assert.ok(s.counts.variable >= 1);
  assert.deepEqual(s.names.function, ["load"]);
  assert.deepEqual(s.names.class, ["Store"]);
  assert.equal(s.hasErrors, false);
});

test("structureDiff reports what a change touched, with added names", async () => {
  const d = await structureDiff(BEFORE, AFTER);
  assert.equal(d.delta.import, 1);
  assert.equal(d.delta.loop, 1);
  assert.equal(d.delta.method, 1);
  assert.equal(d.delta.function, 1, "arrow function save");
  assert.equal(d.delta.comment, 1);
  assert.deepEqual(d.named.function.added, ["save"]);
  assert.deepEqual(d.named.method.added, ["clear"]);
  assert.ok(d.touched.includes("loop") && d.touched.includes("method"));
  const cls = structureClassifications(d);
  assert.ok(cls.some((c) => c.scheme === "code-structure" && c.value === "loop" && c.basis === "observed"));
  assert.ok(cls.some((c) => c.scheme === "language" && c.value === "javascript"));
});

test("test files are recognized as test-only changes; new files diff against nothing", async () => {
  const d = await structureDiff(null, `import { test } from "node:test";\ntest("adds", () => { assert.equal(1, 1); });\ntest("subtracts", () => {});\n`);
  assert.equal(d.after["test-case"], 2);
  assert.deepEqual(d.named["test-case"].added, ["adds", "subtracts"]);
  const cls = structureClassifications(d);
  assert.ok(cls.some((c) => c.scheme === "work-category" && c.value === "testing"));
  assert.ok(supportsPath("a.jsx") && !supportsPath("a.gd"));
});

test("broken code still parses with errors flagged and lower confidence", async () => {
  const d = await structureDiff("function ok() {}", "function ok( {");
  assert.equal(d.parseErrors, true);
  const cls = structureClassifications(d);
  for (const c of cls.filter((x) => x.scheme === "code-structure")) assert.equal(c.confidence, 0.7);
});
