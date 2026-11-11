// Workflow taxonomy: lookups and rule-based classifiers. Browser-safe apart from the JSON import.
// Every classifier returns { scheme, value, basis, confidence, by } entries; several schemes may apply
// to one event (language + work-category + operation + code-structure are not exclusive).
import taxonomy from "../taxonomy.json" with { type: "json" };

export const TAXONOMY = taxonomy;
export const LEVELS = taxonomy.hierarchy.map((h) => h.level);

export function values(scheme) { return Object.keys(taxonomy.schemes[scheme]?.values || {}); }
export function isValue(scheme, value) { return Object.hasOwn(taxonomy.schemes[scheme]?.values || {}, value); }
export function meta(scheme, value) { return taxonomy.schemes[scheme]?.values?.[value] || null; }

const cls = (scheme, value, confidence, by, basis = "inferred") => ({ scheme, value, basis, confidence, by });

const EXT_TO_LANG = (() => { const m = {}; for (const [lang, v] of Object.entries(taxonomy.schemes.language.values)) for (const ext of v.ext) m[ext] = lang; return m; })();

export function languageOfPath(p) {
  if (!p) return null;
  const lower = String(p).toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_LANG[lower.slice(dot)] || null;
}

// Operation from a tool name (observed: the tool name is a fact, the mapping is fixed).
export function operationOfTool(toolName) {
  for (const [op, v] of Object.entries(taxonomy.schemes.operation.values)) if (v.tools.includes(toolName)) return op;
  if (toolName && toolName.startsWith("mcp__")) return "browse";
  return "other";
}

// Refines a run (Bash/PowerShell) by its command signature. The caller passes a SIGNATURE, never the
// full command: first token(s) and flags only, or a hash. Here we only need the text shape to match.
export function classifyRunSignature(signature) {
  const out = [];
  if (!signature) return out;
  for (const rule of taxonomy["run-signatures"]) {
    if (new RegExp(rule.pattern, "i").test(signature)) {
      if (rule.operation !== "run") out.push(cls("operation", rule.operation, 0.8, "rule:run-signature"));
      for (const wc of rule["work-category"]) out.push(cls("work-category", wc, 0.6, "rule:run-signature"));
      break; // first matching rule wins for operation; categories from that rule only
    }
  }
  return out;
}

export function classifyPath(p) {
  const out = [];
  if (!p) return out;
  const lang = languageOfPath(p);
  if (lang) out.push(cls("language", lang, 0.95, "rule:extension", "observed"));
  const norm = String(p).replace(/\\/g, "/");
  for (const hint of taxonomy["path-hints"]) {
    if (new RegExp(hint.match, "i").test(norm)) for (const wc of hint["work-category"]) out.push(cls("work-category", wc, 0.55, "rule:path"));
  }
  return dedupe(out);
}

// Combine classifications for a tool event. `paths` are file paths touched (names only), `signature` is a
// redacted command signature for runs, `toolName` the tool. Dedupes by scheme+value keeping the max confidence.
export function classifyToolEvent({ toolName, paths = [], signature = null }) {
  const out = [];
  const op = operationOfTool(toolName);
  out.push(cls("operation", op, 0.9, "rule:tool-name", "observed"));
  if (op === "run") {
    const refined = classifyRunSignature(signature);
    if (refined.some((c) => c.scheme === "operation")) out.length = 0; // operation is single-valued: the signature replaces the generic run
    out.push(...refined);
  }
  for (const p of paths) out.push(...classifyPath(p));
  if (op === "search") out.push(cls("work-category", "research", 0.7, "rule:tool-name"));
  if (op === "read" && !paths.length) out.push(cls("work-category", "research", 0.4, "rule:tool-name"));
  if (op === "delegate") out.push(cls("work-category", "planning", 0.4, "rule:tool-name"));
  if (op === "publish") out.push(cls("work-category", "documentation", 0.5, "rule:tool-name"));
  return dedupe(out);
}

// Task type from a brief's wording (keyword rules; an LLM judgement should replace this later).
export function classifyTaskTitle(title) {
  const t = String(title || "").toLowerCase();
  const rules = [
    ["gatekeeper", /deploy|release|merge|publish|ship|promote|rollout/],
    ["laboratory", /research|experiment|feasib|prototype|mockup|investigate whether/],
    ["inspector", /audit|investigat|review|assess|verify|diagnos|inventory/],
    ["mechanic", /\bfix|\bbug|broken|\bfail|regress|not work|stale|remove unused|tidy|clean ?up|repair/],
    ["studio", /design|visual|vfx|style|layout|landing|redesign|color|theme|icon|favicon|speed line/],
    ["architect", /architect|plan|propos|schema design|structure/],
    ["builder", /build|implement|add|create|make|write|set up|setup|localiz|generaliz|workflow/],
  ];
  for (const [value, re] of rules) if (re.test(t)) return cls("task-type", value, 0.5, "rule:title");
  return cls("task-type", "builder", 0.3, "rule:default");
}

export function dedupe(list) {
  const m = new Map();
  for (const c of list) { const k = c.scheme + "|" + c.value; const prev = m.get(k); if (!prev || c.confidence > prev.confidence) m.set(k, c); }
  return [...m.values()];
}

// Visual/music hints for a classification value (used by presentation and audio mappers).
export function hintsFor(scheme, value) { return meta(scheme, value) || {}; }
