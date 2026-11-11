// Adapter: git history → git.commit and code.change events. Node only; reads metadata and numstat, never diffs' text.
// Each commit becomes one git.commit (observed) plus one code.change per file with lines added/removed and
// path-based classifications (language observed from the extension, work-category inferred from the path).
import { spawnSync } from "node:child_process";
import { makeEvent } from "../schema.js";
import { stableId } from "../ids.js";
import { classifyPath } from "../../../taxonomy/src/index.js";

export function readGitLog(repo, { since = null, max = 200, branch = "HEAD" } = {}) {
  const args = ["-C", repo, "log", branch, `--max-count=${max}`, "--date=iso-strict", "--numstat", "--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%P"];
  if (since) args.push(`--since=${since}`);
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr}`);
  return r.stdout;
}

// Parses the record-separated format above into { hash, ts, author, subject, parents, files:[{path, added, removed}] }.
export function parseGitLog(text) {
  const commits = [];
  for (const rec of text.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split("\n");
    const [hash, ts, author, subject, parents] = head.split("\x1f");
    const files = [];
    for (const line of rest) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) files.push({ added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]), path: m[3].replace(/^.*=> /, "").replace(/[{}]/g, "") });
    }
    commits.push({ hash, ts: new Date(ts).toISOString(), author, subject, parents: parents ? parents.split(" ").filter(Boolean) : [], files });
  }
  return commits;
}

export function commitsToEvents(commits, { project, sessionId = null, adapter = "git@1", assistantAuthors = ["Claude"] } = {}) {
  const out = [];
  for (const c of commits) {
    const sid = sessionId || `git:${project}`;
    const added = c.files.reduce((a, f) => a + (f.added || 0), 0), removed = c.files.reduce((a, f) => a + (f.removed || 0), 0);
    out.push(makeEvent({
      id: stableId("evt", "git", c.hash), ts: c.ts, source: "git", kind: "git.commit", session: { id: sid, project },
      actor: { type: "human", name: c.author }, payload: { hash: c.hash.slice(0, 12), subjectLen: c.subject.length, merge: c.parents.length > 1, files: c.files.length, added, removed, authored: assistantAuthors.includes(c.author) ? "assistant" : "human" },
      classification: [{ scheme: "operation", value: "commit", basis: "observed", confidence: 1, by: "git" }],
      provenance: { observed: true, adapter, confidence: 1, raw: { hash: c.hash } },
    }));
    for (const f of c.files) {
      out.push(makeEvent({
        id: stableId("evt", "git", c.hash, f.path), ts: c.ts, source: "git", kind: "code.change", session: { id: sid, project },
        actor: { type: "human", name: c.author }, parent: { commit: c.hash.slice(0, 12) },
        payload: { path: f.path, added: f.added, removed: f.removed, binary: f.added == null },
        classification: classifyPath(f.path),
        provenance: { observed: true, adapter, confidence: 1, raw: { hash: c.hash, path: f.path } },
      }));
    }
  }
  return out;
}

export function ingestGit(repo, opts = {}) {
  const project = opts.project || repo.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return commitsToEvents(parseGitLog(readGitLog(repo, opts)), { project, sessionId: opts.sessionId });
}

// Working-tree snapshot for the code-structure parser: which files changed vs HEAD (paths and status only).
export function changedFiles(repo) {
  const r = spawnSync("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || "M", path: l.slice(3).trim() }));
}
