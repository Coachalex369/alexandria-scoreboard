// Code-structure proof of concept with Tree-sitter (web-tree-sitter WASM, MIT; tree-sitter-javascript grammar, MIT).
// Parses JavaScript/JSX (TypeScript later: same approach with tree-sitter-typescript) and summarizes which
// taxonomy code structures a file contains, then diffs two versions of a file to say what a change touched.
// Only counts and identifier names leave this module; source text is parsed in memory and discarded.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let ParserMod = null, jsLanguage = null;

export async function initParser() {
  if (jsLanguage) return;
  const mod = await import("web-tree-sitter");
  ParserMod = mod;
  const Parser = mod.Parser || mod.default;
  const wasmRuntime = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => wasmRuntime });
  const grammarWasm = path.join(path.dirname(require.resolve("tree-sitter-javascript/package.json")), "tree-sitter-javascript.wasm");
  jsLanguage = await (mod.Language || Parser.Language).load(grammarWasm);
}

function newParser() {
  const Parser = ParserMod.Parser || ParserMod.default;
  const p = new Parser();
  p.setLanguage(jsLanguage);
  return p;
}

// Tree-sitter node type → taxonomy code-structure value.
const NODE_MAP = {
  function_declaration: "function", function_expression: "function", arrow_function: "function", generator_function_declaration: "function",
  method_definition: "method",
  class_declaration: "class", class: "class",
  for_statement: "loop", for_in_statement: "loop", while_statement: "loop", do_statement: "loop",
  if_statement: "condition", switch_statement: "condition", ternary_expression: "condition",
  import_statement: "import",
  lexical_declaration: "variable", variable_declaration: "variable",
  comment: "comment",
  jsx_element: "component", jsx_self_closing_element: "component",
};
const TEST_CALLEES = new Set(["test", "it", "describe", "suite", "bench"]);

// Walks the tree once; returns { counts: {structure: n}, names: { function: [...], class: [...], method: [...] }, nodes }.
export function summarizeTree(tree) {
  const counts = {}; const names = { function: [], class: [], method: [], "test-case": [] };
  let nodes = 0;
  const visit = (node) => {
    nodes++;
    const kind = NODE_MAP[node.type];
    if (kind) {
      counts[kind] = (counts[kind] || 0) + 1;
      if (kind === "function" || kind === "class" || kind === "method") {
        const nameNode = node.childForFieldName ? node.childForFieldName("name") : null;
        let name = nameNode ? nameNode.text : null;
        if (!name && node.type === "arrow_function" && node.parent?.type === "variable_declarator") name = node.parent.childForFieldName("name")?.text || null;
        if (name) names[kind].push(name);
      }
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const callee = fn ? fn.text.split(".")[0] : "";
      if (TEST_CALLEES.has(callee)) {
        counts["test-case"] = (counts["test-case"] || 0) + 1;
        const arg = node.childForFieldName("arguments")?.namedChildren?.[0];
        if (arg && (arg.type === "string" || arg.type === "template_string")) names["test-case"].push(arg.text.slice(1, -1).slice(0, 80));
      }
      if (callee === "require") counts.import = (counts.import || 0) + 1;
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(tree.rootNode);
  return { counts, names, nodes, hasErrors: tree.rootNode.hasError };
}

export async function summarizeSource(source) {
  await initParser();
  const parser = newParser();
  const tree = parser.parse(String(source || ""));
  const s = summarizeTree(tree);
  tree.delete(); parser.delete();
  return s;
}

// What a change touched: per-structure deltas plus named definitions added/removed. `before` may be null (new file).
export async function structureDiff(before, after) {
  const a = before == null ? { counts: {}, names: { function: [], class: [], method: [], "test-case": [] }, nodes: 0 } : await summarizeSource(before);
  const b = after == null ? { counts: {}, names: { function: [], class: [], method: [], "test-case": [] }, nodes: 0 } : await summarizeSource(after);
  const keys = new Set([...Object.keys(a.counts), ...Object.keys(b.counts)]);
  const delta = {};
  for (const k of keys) { const d = (b.counts[k] || 0) - (a.counts[k] || 0); if (d !== 0) delta[k] = d; }
  const setDiff = (x, y) => x.filter((n) => !y.includes(n));
  const named = {};
  for (const k of ["function", "class", "method", "test-case"]) {
    const added = setDiff(b.names[k], a.names[k]), removed = setDiff(a.names[k], b.names[k]);
    if (added.length || removed.length) named[k] = { added, removed };
  }
  // structures present in the after-version whose count changed or that gained/lost names count as "touched"
  const touched = new Set(Object.keys(delta));
  for (const k of Object.keys(named)) touched.add(k);
  return { delta, named, touched: [...touched], before: a.counts, after: b.counts, nodesBefore: a.nodes, nodesAfter: b.nodes, parseErrors: !!(a.hasErrors || b.hasErrors) };
}

// Classification entries for a diff result: observed (the parser saw it), high confidence; touched structures only.
export function structureClassifications(diff, { lang = "javascript" } = {}) {
  const out = [{ scheme: "language", value: lang, basis: "observed", confidence: 1, by: "tree-sitter" }];
  for (const k of diff.touched) out.push({ scheme: "code-structure", value: k, basis: "observed", confidence: diff.parseErrors ? 0.7 : 0.95, by: "tree-sitter" });
  // a change that only adds test cases is testing work; functions+conditions+loops without tests is implementation
  if (diff.touched.includes("test-case") && diff.touched.every((k) => ["test-case", "import", "variable", "comment", "function"].includes(k))) out.push({ scheme: "work-category", value: "testing", basis: "inferred", confidence: 0.7, by: "tree-sitter:test-only-change" });
  if (diff.touched.includes("component")) out.push({ scheme: "work-category", value: "frontend", basis: "inferred", confidence: 0.7, by: "tree-sitter:jsx" });
  return out;
}

// Which named structures enclose the given 1-based line numbers of `source`? Catches edits that change a
// body or a call without adding or removing any structure (the common case for refactors and threading).
// Returns [{ kind, name, lines: [start, end], hits }] sorted by first hit, innermost named node per line.
export async function touchedByLines(source, lineNumbers) {
  await initParser();
  const parser = newParser();
  const tree = parser.parse(String(source || ""));
  const wanted = new Set(lineNumbers.map((n) => n - 1)); // tree-sitter rows are 0-based
  const found = new Map();
  const visit = (node, chain) => {
    const kind = NODE_MAP[node.type];
    let next = chain;
    if (kind === "function" || kind === "class" || kind === "method") {
      const nameNode = node.childForFieldName("name");
      let name = nameNode ? nameNode.text : null;
      if (!name && node.type === "arrow_function" && node.parent?.type === "variable_declarator") name = node.parent.childForFieldName("name")?.text || null;
      if (name) next = { kind, name, start: node.startPosition.row, end: node.endPosition.row, parent: chain };
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i), next);
    if (next !== chain) {
      let hits = 0; for (let r = next.start; r <= next.end; r++) if (wanted.has(r)) hits++;
      if (hits) {
        const key = `${next.kind}:${next.name}:${next.start}`;
        const inner = found.get(key) || { kind: next.kind, name: next.name, lines: [next.start + 1, next.end + 1], hits: 0 };
        inner.hits = hits; found.set(key, inner);
      }
    }
  };
  visit(tree.rootNode, null);
  tree.delete(); parser.delete();
  // keep innermost: drop a node whose range strictly contains another found node's range
  const list = [...found.values()];
  return list.filter((a) => !list.some((b) => b !== a && b.lines[0] >= a.lines[0] && b.lines[1] <= a.lines[1] && (b.lines[0] > a.lines[0] || b.lines[1] < a.lines[1]))).sort((a, b) => a.lines[0] - b.lines[0]);
}

// Parses unified diff hunk headers (`@@ -a,b +c,d @@`) into the changed line numbers of the AFTER version.
export function changedLinesFromHunks(diffText) {
  const lines = [];
  for (const m of String(diffText || "").matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]), count = m[2] == null ? 1 : Number(m[2]);
    for (let i = 0; i < Math.max(count, 1); i++) lines.push(start + i);
  }
  return lines;
}

export const supportsPath = (p) => /\.(js|mjs|cjs|jsx)$/i.test(String(p));
export { pathToFileURL };
