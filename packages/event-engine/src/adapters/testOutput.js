// Adapter: test and build output → test.run / build.run events. Browser-safe parsing, Node-free.
// Recognizes node:test summaries ("ℹ pass N / ℹ fail N"), Godot runner totals ("TOTAL: N passed, M failed"),
// TAP ("ok N" / "not ok N"), Jest/Vitest ("Tests: N passed, M failed"), pytest ("N passed, M failed"),
// GitHub Actions step conclusions (gh run view JSON) and generic exit codes. Only counts and names are kept.
import { makeEvent } from "../schema.js";
import { stableId } from "../ids.js";

export function parseTestOutput(text, { exitCode = null } = {}) {
  const t = String(text || "");
  let m, framework = "unknown", passed = null, failed = null, skipped = null;
  if ((m = t.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/))) { framework = "node:test"; passed = +m[1]; failed = +m[2]; const s = t.match(/ℹ skipped (\d+)/); skipped = s ? +s[1] : 0; }
  else if ((m = t.match(/TOTAL: (\d+) passed, (\d+) failed/))) { framework = "godot-runner"; passed = +m[1]; failed = +m[2]; }
  else if ((m = t.match(/Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed/))) { framework = "jest"; failed = +(m[1] || 0); skipped = +(m[2] || 0); passed = +m[3]; }
  else if ((m = t.match(/(\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?/)) && /pytest|=+ .* in [\d.]+s/.test(t)) { framework = "pytest"; passed = +m[1]; failed = +(m[2] || 0); skipped = +(m[3] || 0); }
  else if (/^(ok|not ok) \d+/m.test(t)) { framework = "tap"; passed = (t.match(/^ok \d+/gm) || []).length; failed = (t.match(/^not ok \d+/gm) || []).length; }
  else if ((m = t.match(/TOTAL PASS=(\d+) FAIL=(\d+)/))) { framework = "pass-fail-totals"; passed = +m[1]; failed = +m[2]; }
  const durationMs = (m = t.match(/duration_ms ([\d.]+)/)) ? Math.round(+m[1]) : null;
  const ok = failed != null ? failed === 0 && (exitCode == null || exitCode === 0) : exitCode != null ? exitCode === 0 : null;
  return { framework, passed, failed, skipped, durationMs, exitCode, ok };
}

export function testRunEvent({ ts, session, actor = { type: "main" }, parent, result, label = null, source = "tests" }) {
  return makeEvent({
    id: stableId("evt", "test", session.id, ts, label || "", result.framework), ts, source, kind: "test.run", session, actor, parent,
    payload: { framework: result.framework, passed: result.passed, failed: result.failed, skipped: result.skipped, exitCode: result.exitCode, ok: result.ok, label },
    classification: [{ scheme: "operation", value: "test", basis: "observed", confidence: 1, by: "adapter" }, { scheme: "work-category", value: "testing", basis: "observed", confidence: 0.9, by: "adapter" }],
    durationMs: result.durationMs ?? undefined,
    provenance: { observed: true, adapter: "tests@1", confidence: result.framework === "unknown" ? 0.5 : 1 },
  });
}

// GitHub Actions run (from `gh run view --json status,conclusion,jobs,createdAt,updatedAt`).
export function ghRunToEvent(run, { session, project }) {
  const steps = (run.jobs || []).flatMap((j) => j.steps || []);
  const failedSteps = steps.filter((s) => s.conclusion === "failure").map((s) => s.name);
  const ts = new Date(run.updatedAt || run.createdAt || Date.now()).toISOString();
  return makeEvent({
    id: stableId("evt", "gh-run", String(run.databaseId || run.id || ts)), ts, source: "build", kind: "build.run", session: session || { id: `ci:${project}`, project },
    actor: { type: "ci", name: "github-actions" },
    payload: { status: run.status, conclusion: run.conclusion, steps: steps.length, failedSteps, ok: run.conclusion === "success" },
    classification: [{ scheme: "operation", value: "build", basis: "observed", confidence: 1, by: "adapter" }, { scheme: "work-category", value: "tooling", basis: "observed", confidence: 0.8, by: "adapter" }],
    durationMs: run.createdAt && run.updatedAt ? Date.parse(run.updatedAt) - Date.parse(run.createdAt) : undefined,
    provenance: { observed: true, adapter: "gh-run@1", confidence: 1 },
  });
}
