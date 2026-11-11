// Normalized event schema for Alexandria Scoreboard (alexandria.event/1).
// Browser-safe: no Node imports. The JSON Schema copy for documentation lives in ../schema/event.schema.json.
//
// Design rules
// - Every event is either an OBSERVED FACT (provenance.observed = true, taken straight from a source) or an
//   INFERENCE (provenance.observed = false). Classifications always carry their own basis and confidence,
//   so a fact can wear inferred labels without the fact itself becoming uncertain.
// - No source code, prompt text, tool inputs or outputs, file contents or secrets are ever stored.
//   Payloads hold names, counts, durations, hashes and paths only.
// - Parent-child links are explicit ids (session → task → prompt → toolUse → agent), never nesting.

export const SCHEMA = "alexandria.event/1";

export const SOURCES = ["claude-hooks", "claude-transcript", "claude-statusline", "otel", "git", "tests", "build", "parser", "marks", "synthetic", "manual"];

export const KINDS = [
  // session and turn lifecycle (Claude Code)
  "session.start", "session.end", "prompt.submit", "turn.stop", "notification",
  // provider and permission lifecycle (Stopwatch v0.2): API errors incl. rate limits, model responses with token
  // counts, permission requests/denials, context compaction, model switches
  "api.error", "model.response", "permission.request", "permission.denied", "context.compact", "model.switch",
  // tools and agents
  "tool.call", "tool.result", "tool.failure", "agent.start", "agent.stop",
  // tasks (user briefs, marks, inferred segments)
  "task.start", "task.end", "task.estimate", "task.scope-change", "task.pause", "task.resume", "wait.begin", "wait.end",
  // repository and verification
  "git.commit", "code.change", "test.run", "build.run",
  // derived
  "code.structure", "eta.update", "state.change",
];

export const ACTOR_TYPES = ["main", "subagent", "human", "system", "ci"];

// Classification schemes. Values are validated against the taxonomy package when it is available;
// the engine itself only checks the shape.
export const SCHEMES = ["work-category", "language", "code-structure", "operation", "task-type", "complexity"];

export const BASIS = ["observed", "inferred", "declared"]; // declared = a human or agent said so (an estimate, a label)

const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function validateEvent(e) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(e && typeof e === "object", "event must be an object");
  if (errors.length) return errors;
  need(e.schema === SCHEMA, `schema must be ${SCHEMA}`);
  need(typeof e.id === "string" && e.id.length >= 8, "id required");
  need(typeof e.ts === "string" && isoRe.test(e.ts), "ts must be ISO-8601 UTC with ms");
  need(SOURCES.includes(e.source), `source must be one of ${SOURCES.join(",")}`);
  need(KINDS.includes(e.kind), `kind must be a known kind (${e.kind})`);
  need(e.session && typeof e.session.id === "string", "session.id required");
  need(e.actor && ACTOR_TYPES.includes(e.actor.type), "actor.type required");
  if (e.actor && e.actor.model != null) need(typeof e.actor.model === "string", "actor.model must be a string");
  need(e.provenance && typeof e.provenance.observed === "boolean" && typeof e.provenance.adapter === "string", "provenance.observed and provenance.adapter required");
  if (e.provenance && e.provenance.confidence != null) need(e.provenance.confidence >= 0 && e.provenance.confidence <= 1, "provenance.confidence in [0,1]");
  if (e.durationMs != null) need(Number.isFinite(e.durationMs) && e.durationMs >= 0, "durationMs must be a non-negative number");
  if (e.parent != null) need(typeof e.parent === "object", "parent must be an object of ids");
  if (e.classification != null) {
    need(Array.isArray(e.classification), "classification must be an array");
    for (const c of e.classification || []) {
      need(SCHEMES.includes(c.scheme), `classification.scheme unknown (${c.scheme})`);
      need(typeof c.value === "string", "classification.value required");
      need(BASIS.includes(c.basis), "classification.basis must be observed|inferred|declared");
      need(c.confidence >= 0 && c.confidence <= 1, "classification.confidence in [0,1]");
    }
  }
  if (e.payload != null) {
    need(typeof e.payload === "object", "payload must be an object");
    for (const k of ["content", "text", "prompt", "stdout", "stderr", "code", "source", "secret", "token", "password"]) need(!(k in (e.payload || {})), `payload must not carry raw '${k}'`);
  }
  return errors;
}

export function assertEvent(e) {
  const errs = validateEvent(e);
  if (errs.length) throw new Error(`invalid event: ${errs.join("; ")}`);
  return e;
}

// Builder with defaults, so adapters stay short. `observed` defaults to true (facts); pass false for inferences.
export function makeEvent({ id, ts, source, kind, session, actor = { type: "system" }, parent, task, payload, classification, provenance, durationMs }) {
  const e = {
    schema: SCHEMA,
    id,
    ts: typeof ts === "number" ? new Date(ts).toISOString() : ts,
    source,
    kind,
    session,
    actor,
    ...(parent ? { parent } : {}),
    ...(task ? { task } : {}),
    ...(payload ? { payload } : {}),
    ...(classification && classification.length ? { classification } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    provenance: { observed: true, adapter: source, confidence: 1, ...(provenance || {}) },
  };
  return assertEvent(e);
}

export function classification(scheme, value, { basis = "inferred", confidence = 0.6, by = "rule" } = {}) {
  return { scheme, value, basis, confidence, by };
}
