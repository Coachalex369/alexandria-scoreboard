// Vendored Alexandria Protocol: the files under collector/, packages/event-engine/, packages/taxonomy/, fixtures/ and
// tools/install-collector-v3.mjs must match PROTOCOL_VERSION.json exactly (line endings normalised). Edit them in the
// alexandria-protocol repository and re-sync; never locally. Self-contained: does not need the protocol repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = ["collector", "packages/event-engine", "packages/taxonomy", "tools/install-collector-v3.mjs", "fixtures"];
const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n")).digest("hex");
function list(rel, out = []) { const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) return out; if (fs.statSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs)) if (n !== "node_modules") list(path.posix.join(rel, n), out); } else out.push(rel); return out; }

test("vendored protocol files match PROTOCOL_VERSION.json (no drift)", () => {
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "PROTOCOL_VERSION.json"), "utf8"));
  const problems = [];
  for (const [f, h] of Object.entries(rec.files)) { const abs = path.join(ROOT, f); if (!fs.existsSync(abs)) problems.push(`missing ${f}`); else if (hash(abs) !== h) problems.push(`changed ${f}`); }
  for (const e of VENDORED) for (const f of list(e)) if (!(f in rec.files)) problems.push(`unrecorded ${f}`);
  assert.deepEqual(problems, []);
});

test("protocol version is compatible with this application (collector v3, schema alexandria.event/1)", async () => {
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "PROTOCOL_VERSION.json"), "utf8"));
  assert.equal(rec.version.split(".")[0], "3", "this app is built against protocol 3.x");
  assert.ok(rec.collector >= 3, "approval, rate-limit and model events need collector v3");
  const { SCHEMA, KINDS } = await import("../packages/event-engine/src/schema.js");
  assert.equal(SCHEMA, "alexandria.event/1");
  for (const k of ["api.error", "permission.request", "model.response", "task.pause", "wait.begin"]) assert.ok(KINDS.includes(k), `schema has ${k}`);
});
