// Protocol 3.2.2 security regression tests: the command scanner and the allowlists. 3.2.1 was incomplete: a here-doc
// inside a quoted $(…) whose body has an odd number of double quotes, and `<<\EOF`, could still put body words into
// `segs`. From 3.2.2 privacy rests on allowlists: every word a signature carries is allowlisted, anything else is "cmd".
import { test } from "node:test";
import assert from "node:assert/strict";
import { signature, segmentSignatures, firstSignature, sanitizeSignature, recordFor, mcpTool } from "../collector/eta-hook.mjs";
import { parseHookLog } from "../packages/event-engine/src/adapters/claudeHooks.js";

const M = "zorbcorpSECRETWORD";
const rec = (command, tool = "Bash", name = "PostToolUse") => recordFor({ hook_event_name: name, session_id: "s", tool_name: tool, tool_use_id: "t", tool_input: { command }, tool_response: { stdout: "ℹ pass 1\nℹ fail 0" } }, name, 0);
const noMarker = (command, tool) => { for (const name of ["PostToolUse", "PostToolUseFailure"]) { const r = rec(command, tool, name); assert.ok(!JSON.stringify(r).includes(M), `leak: ${JSON.stringify(command)} -> ${JSON.stringify(r)}`); } };

test("3.2.2: a here-doc inside a quoted $(…) with an odd number of double quotes (the way Claude Code writes commit messages)", () => {
  const c = `git commit -m "$(cat <<'EOF'\nMeasure 5" panels\nnpx ${M}\nmake ${M}-release\nEOF\n)" && git push`;
  noMarker(c);
  assert.deepEqual(segmentSignatures(c), ["git commit", "git push"]);
  assert.equal(firstSignature(c), "git commit");
});

test("3.2.2: backslash and quoted delimiters, line continuations, PowerShell closers at column 0", () => {
  for (const c of [String.raw`cat > n.txt <<\EOF` + `\nmake ${M}\nEOF\nnpm test`, `cat <<"EOF"x\nEOF\ngit ${M}\nEOFx\nnpm test`, `cat <<E"O"F\nE\ngit ${M}\nEOF\nnpm test`,
    "cat <<EOF \\\nEOF\ngit " + M + "\nEOF\nnpm test", `cat <<EOF\rgit ${M}\rEOF\rnpm test`, `echo "mail to user@"\ncat <<'EOF'\ngit ${M}\nEOF\nnpm test`]) {
    noMarker(c); assert.deepEqual(segmentSignatures(c).slice(-1), ["npm test"], JSON.stringify(c));
  }
  noMarker(`$x = @'\n  '@ ; git ${M}\nit's\n'@\ngit status`, "PowerShell");
  noMarker(`<<EOF/git\n${M}\nEOF/git`);
});

test("3.2.2: allowlists — first word, second word and script names; anything else is cmd", () => {
  assert.equal(signature(`git ${M}`), "git cmd"); assert.equal(signature(`make ${M}`), "make cmd"); assert.equal(signature(`docker ${M} x`), "docker cmd");
  assert.equal(signature(`yarn ${M}`), "yarn cmd"); assert.equal(signature(`npm run ${M}`), "npm run cmd"); assert.equal(signature(`npm run build:${M}`), "npm run cmd");
  assert.equal(signature(`npx ${M}`), "npx cmd"); assert.equal(signature(`${M} --flag`), "cmd"); assert.equal(signature(`./${M}.sh`), "cmd");
  assert.equal(signature("git status"), "git status"); assert.equal(signature("npm run test:unit"), "npm run test:unit"); assert.equal(signature("npx tsc"), "npx tsc");
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const w = "zq" + Math.floor(rnd() * 1e9).toString(36);
    for (const c of [w, `${w} x`, `git ${w}`, `make ${w}`, `npm run ${w}`, `pnpm ${w}`, `npx ${w}`, `cd a && ${w} && git ${w}`, `git status && echo "open ${w}\nmake ${w}`, `"${w}" a`, `$(${w})`, `bash -c "${w}"`])
      for (const out of [signature(c), segmentSignatures(c), firstSignature(c), sanitizeSignature(c), rec(c), rec(c, "PowerShell", "PostToolUseFailure")])
        assert.ok(!JSON.stringify(out ?? null).includes(w), `unknown word leaked from ${JSON.stringify(c)}: ${JSON.stringify(out)}`);
  }
});

test("3.2.2: records from older collectors are redacted by the adapter; MCP server names only on an exact allowlist match", () => {
  const lines = [
    { ts: "2026-11-10T10:00:00.000Z", ev: "PostToolUse", sid: "s", v: 4, tool: "Bash", tuid: "t1", sig: `git ${M}`, segs: [`git ${M}`, `make ${M}`], tests: { framework: "node:test", passed: 1, failed: 0, ok: true } },
    { ts: "2026-11-10T10:00:01.000Z", ev: "PermissionRequest", sid: "s", v: 4, tool: `mcp__${M}__lookup` },
    { ts: "2026-11-10T10:00:02.000Z", ev: "PostToolUse", sid: "s", v: 4, tool: "mcp__claude-in-chrome__navigate", tuid: "t2" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const evs = parseHookLog(lines);
  assert.ok(!JSON.stringify(evs).includes(M), "nothing of the stored words or server name reaches an event");
  assert.ok(JSON.stringify(evs).includes("mcp__claude-in-chrome__navigate"));
  assert.equal(mcpTool(`mcp__${M}__x`), "mcp__other__other");
  assert.equal(rec("x", `mcp__${M}__x`).tool, "mcp__other__other");
});
