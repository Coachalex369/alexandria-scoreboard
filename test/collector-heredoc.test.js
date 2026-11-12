// Regression test for the protocol 3.2.1 security fix: here-doc and here-string bodies are file content and must never
// be split into command segments or recorded as signatures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFor, segmentSignatures } from "../collector/eta-hook.mjs";

const M = "HEREDOC-SECRET-MARKER";
const cases = [
  [`cat > notes.md <<'EOF'\n${M} first line\nimport ${M}\ndon't stop here\nEOF\nnpm test`, ["cat", "npm test"]],
  [`cat <<-EOF > x.txt\n\t${M} indented\n\tEOF\ngit status`, ["cat", "git status"]],
  [`cat <<"END"\n${M}\nEND\nnode --test test/`, ["cat", "node --test"]],
  [`cat > a <<A && cat > b <<B\n${M} a\nA\n${M} b\nB\nnpm test`, ["cat", "cat", "npm test"]],
  [`cat > f <<EOF\n${M} never terminated\nnpm test`, ["cat"]],
  [`grep x <<< "${M}" && npm test`, ["grep", "npm test"]],
  [`$t = @'\n${M} don't\n'@\nnpm test`, ["$t", "npm test"]],
  [`$t = @"\n${M} "quoted"\n"@\ngit status`, ["$t", "git status"]],
];

test("here-doc and here-string bodies are skipped; the command after them is still recognised; nothing of the body is recorded", () => {
  for (const [command, expected] of cases) {
    assert.deepEqual(segmentSignatures(command), expected, command.split("\n")[0]);
    const rec = recordFor({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t", tool_input: { command }, tool_response: { stdout: "ℹ pass 1\nℹ fail 0" } }, "PostToolUse", Date.now());
    assert.ok(!JSON.stringify(rec).includes(M), `no body text recorded: ${command.split("\n")[0]}`);
    assert.ok(!JSON.stringify(rec).includes("import"), "no first word of a body line becomes a signature");
  }
  const pass = recordFor({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t", tool_input: { command: cases[0][0] }, tool_response: { stdout: "ℹ pass 4\nℹ fail 0\nℹ duration_ms 3" } }, "PostToolUse", Date.now());
  assert.equal(pass.tests?.passed, 4, "the test run after the here-doc is recognised");
});
