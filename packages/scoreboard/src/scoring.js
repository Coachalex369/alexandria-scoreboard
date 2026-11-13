// Scoreboard scoring rules (pure, browser-safe). Scoring rules (2026-11-12), see docs/SCORING.md.
//
// Scope. Checks and fouls belong to the REPOSITORY a session works in (repo key from the session's git root), so a
// test that fails in one terminal and is fixed in another resolves, and evidence survives turn and task boundaries.
// A session whose repository is unknown gets its own scope ("session:<id>").
//
// VERIFIED  checks whose latest run passed and that are still valid. A check is a test command or a build/lint/
//           typecheck command, keyed by its redacted signature. It becomes STALE after a later code change in the
//           same scope (an edit to a non-documentation file, or a command that rewrites the tree), and FAILED when a
//           later run of the same check fails. Commits are never checks.
// FOULS     meaningful unresolved problems: failed test runs, failed build/lint/typecheck commands, failed subagent
//           deliveries. Harmless tool failures (reads, searches, edits refused, ad-hoc shell commands, browser
//           automation) and interruptions are not fouls. A foul is RESOLVED by evidence: the same check passing later
//           (observed) or a later successful delivery by a subagent of the same type (inferred). Resolved fouls move to
//           a separate history.
// WINS      one shared team score per session: completed turns that delivered work, commits, subagent deliveries,
//           explicit task-complete marks. Each win has a tier:
//             confirmed   an explicit task-complete mark
//             verified    a deliverable while at least one check is valid and no foul is unresolved in its scope
//             unverified  an observed deliverable (commit, subagent delivery) without that evidence
//             probable    an inferred completion (a turn that changed files ended) without that evidence
//           Duplicates are impossible by key: one win per commit hash (across all sessions), per subagent, per turn,
//           per marked task.
export const DOC_EXTS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".markdown"]);
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const TEST_SIG = /^(npm (test|run test[\w:-]*)|npx (jest|vitest|mocha|tap|playwright)|node --test|pnpm test|yarn test|pytest|cargo test|go test|dotnet test|godot)/i;
export const BUILD_SIG = /^(npm run (build|lint|typecheck|check|compile|dist)[\w:-]*|npx (tsc|eslint|electron-builder|vite)|tsc|eslint|cargo (build|check|clippy)|go (build|vet)|dotnet build|gradle|gradlew|make|mvn|pnpm (build|lint)|yarn (build|lint))\b/i;
// Commands that rewrite the working tree (the redacted signature is all there is: no paths, so any of them stales).
export const MUTATING_SIG = /^(git (checkout|switch|merge|rebase|reset|pull|stash|cherry-pick|revert|apply|am|restore)|sed|patch|npm (install|ci|update)|pnpm install|yarn install|mv|cp|rm|del|Remove-Item|Move-Item|Copy-Item|Set-Content|Out-File)$/i;
export const TIERS = ["confirmed", "verified", "unverified", "probable"];

export class Scoring {
  constructor() { this.scopes = new Map(); this.winKeys = new Map(); this.commitHashes = []; }
  scope(key) {
    if (!this.scopes.has(key)) this.scopes.set(key, { key, checks: new Map(), fouls: new Map(), resolved: [], lastCodeChange: null });
    return this.scopes.get(key);
  }

  // ---- evidence ----
  codeChange(scopeKey, ts, { session, agentId = null, what }) {
    const sc = this.scope(scopeKey); sc.lastCodeChange = { ts, session, agentId, what };
    for (const c of sc.checks.values()) if (c.state === "pass" && !c.staleSince && c.ts <= ts) { c.staleSince = ts; c.staleBy = what; }
  }
  checkRun(scopeKey, { key, label, kind, ok, ts, session, agentId = null, basis = "observed", counts = null }) {
    const sc = this.scope(scopeKey);
    const prev = sc.checks.get(key);
    sc.checks.set(key, { key, label, kind, state: ok ? "pass" : "fail", ts, session, agentId, basis, counts, staleSince: null, staleBy: null, runs: (prev?.runs || 0) + 1 });
    const fkey = `${kind}:${key}`;
    if (ok) {
      this.resolveFoul(scopeKey, fkey, { ts, by: `${label} passed`, basis: "observed", session });
      // A failure of a differently named command of the same kind (node --test vs npm test) is resolved by this pass too,
      // as an inference: otherwise an old failure would stay open forever after the suite moved to another command.
      // Only when the passing run demonstrably covers at least as much as the failed one (both counts known): a single
      // passing file must not clear a red suite.
      const total = (c) => (c && c.passed != null ? c.passed + (c.failed || 0) : null);
      for (const k of [...sc.fouls.keys()]) { const f0 = sc.fouls.get(k); if (k.startsWith(`${kind}:`) && f0.since < ts && total(counts) != null && total(f0.counts) != null && counts.passed >= total(f0.counts)) this.resolveFoul(scopeKey, k, { ts, by: `${label} passed (same kind of check, ${counts.passed} ≥ ${total(f0.counts)} tests)`, basis: "inferred", session }); }
    }
    else this.openFoul(scopeKey, { key: fkey, kind: kind === "test" ? "test-failure" : "build-failure", label: `${label} failed`, ts, session, agentId, basis, counts });
  }
  openFoul(scopeKey, f) {
    const sc = this.scope(scopeKey);
    const cur = sc.fouls.get(f.key);
    if (cur) { cur.repeats = (cur.repeats || 1) + 1; cur.lastTs = f.ts; return cur; }
    const foul = { ...f, since: f.ts, lastTs: f.ts, repeats: 1 }; sc.fouls.set(f.key, foul); return foul;
  }
  resolveFoul(scopeKey, key, { ts, by, basis, session }) {
    const sc = this.scope(scopeKey); const f = sc.fouls.get(key); if (!f) return null;
    sc.fouls.delete(key); const r = { ...f, resolvedAt: ts, resolvedBy: by, resolutionBasis: basis, resolvedInSession: session };
    sc.resolved.push(r); if (sc.resolved.length > 200) sc.resolved.shift(); return r;
  }
  // Fouls of a kind whose key starts with a prefix, resolved together (a subagent type delivering successfully).
  resolveMatching(scopeKey, prefix, opts) { const sc = this.scope(scopeKey); return [...sc.fouls.keys()].filter((k) => k.startsWith(prefix)).map((k) => this.resolveFoul(scopeKey, k, opts)); }

  // ---- views ----
  validChecks(scopeKey) { const sc = this.scopes.get(scopeKey); return sc ? [...sc.checks.values()].filter((c) => c.state === "pass" && !c.staleSince) : []; }
  unresolved(scopeKey) { const sc = this.scopes.get(scopeKey); return sc ? [...sc.fouls.values()] : []; }
  evidenceTier(scopeKey) { return this.validChecks(scopeKey).length > 0 && this.unresolved(scopeKey).length === 0; }

  // ---- wins ----
  // `key` is globally unique per deliverable; returns the win, or null when that deliverable already scored.
  win(s, { key, kind, ts, observedDeliverable, explicit = false, agentId = null, label, basis, scopeKey }) {
    if (this.winKeys.has(key)) return null;
    const verified = this.evidenceTier(scopeKey);
    const tier = explicit ? "confirmed" : verified ? "verified" : observedDeliverable ? "unverified" : "probable";
    const w = { key, kind, tier, ts, agentId, label, basis, session: s.id, revoked: false, evidence: verified ? this.validChecks(scopeKey).map((c) => c.label) : [] };
    this.winKeys.set(key, w); s.wins.push(w); return w;
  }
  revoke(key, reason) { const w = this.winKeys.get(key); if (w && !w.revoked) { w.revoked = true; w.revokedReason = reason; } return w; }
  seenCommit(hash) {
    if (typeof hash !== "string" || !hash) return false;
    const h = hash.toLowerCase();
    for (const x of this.commitHashes) if (x.startsWith(h) || h.startsWith(x)) return true;
    this.commitHashes.push(h); if (this.commitHashes.length > 2000) this.commitHashes.shift(); return false;
  }
}

// Classify a shell signature (or chain of signatures) for the rules above.
export function sigKinds(signatures) {
  const sigs = (signatures || []).filter((x) => typeof x === "string");
  return { test: sigs.find((x) => TEST_SIG.test(x)) || null, build: sigs.find((x) => BUILD_SIG.test(x)) || null, mutating: sigs.find((x) => MUTATING_SIG.test(x)) || null };
}

export function winSummary(wins) {
  const live = wins.filter((w) => !w.revoked);
  const by = Object.fromEntries(TIERS.map((t) => [t, live.filter((w) => w.tier === t).length]));
  return { total: live.length, sure: by.confirmed + by.verified, ...by, revoked: wins.length - live.length };
}
