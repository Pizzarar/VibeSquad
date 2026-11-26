// @desk C3 (docs/PLAN_DESK_DD_CHOICES.md): `vs log needs-you` warns (stderr, never blocks) when the ask names lettered
// options but has no --alt; the writer rule is in the role prompt and docs/WORKFLOWS.md.
import "./setup/hermetic.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "vs-c3-home-"));
after(() => rmSync(HOME, { recursive: true, force: true }));
process.env.VIBESQUAD_HOME = HOME;
const { namesLetteredOptions } = await import("../cli/vs.mjs");
const { getLocalToken } = await import("../server/auth.mjs");
getLocalToken(); // owner proof under the temp VS home, so the CLI falls back to a disk append there (no server)

const POSITIVE = [
  "Which one: A, B, or C?", "Ship A/B/C?", "A or B?", "(a) keep it or (b) drop it?",
  "Go with option A?", "Option 1/2 for the sidebar?", "option 1 or 2?", "Pick A vs B",
];
const NEGATIVE = [
  "A new lane is needed", "Is a or b better here", "Plan B if this fails?", "Ship it now?",
  "A decision is needed: push master?", "Use option 2 of the config", "Ship the (a) footnote only",
  "Vitamin A, the B-side, and C++ are unrelated", "Reply A-OK", "Needs a ruling on the S/N ratio",
];

test("namesLetteredOptions flags lettered options", () => {
  for (const t of POSITIVE) assert.equal(namesLetteredOptions(t), true, t);
});
test("namesLetteredOptions ignores ordinary text (articles, lone Plan B, footnotes)", () => {
  for (const t of NEGATIVE) assert.equal(namesLetteredOptions(t), false, t);
});

function run(args) {
  const env = { ...process.env, VIBESQUAD_HOME: HOME, VIBESQUAD_IGNORE_HOME_TEAMS: "1", VIBESQUAD_PORT: "1" };
  for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN"]) delete env[k];
  return spawnSync(process.execPath, [path.resolve("cli/vs.mjs"), "log", "needs-you", ...args, "--team", "sq", "--lane", "desk"], { env, encoding: "utf8" });
}

test("CLI: lettered ask without --alt warns and still logs", () => {
  const r = run(["Which one: A, B, or C?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning:.*--alt/);
  assert.equal(JSON.parse(r.stdout.trim()).type, "needs-you");
});
test("CLI: with --alt there is no warning", () => {
  const r = run(["Which one: A, B, or C?", "--decides", "x", "--lean", "A: do it", "--alt", "B: wait", "--alt", "C: skip"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /warning/);
});
test("CLI: non-option text gives no warning", () => {
  const r = run(["A new lane needs a name, Plan B if refused?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /warning/);
});

test("writer rule is in the role prompt and docs/WORKFLOWS.md", () => {
  assert.match(readFileSync("server/hooks/agent-duties.ts", "utf8"), /Never log a needs-you that asks \\"A, B or C\?\\" without one `--alt` per option/);
  assert.match(readFileSync("docs/WORKFLOWS.md", "utf8"), /never log "A, B or C\?" without one `--alt` per option/);
});
