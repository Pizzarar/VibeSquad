// idea-195: leads never hand-edit files under ~/.vibesquad. `vs handoff --judgment-file <f>` / `--judgment -` writes the Judgment;
// an audit over every injected rule/steer source fails on any instruction to edit/fill/write a packet or ~/.vibesquad file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_PACK_PROFILES, LEAD_NOTE_BODY, BRAINSTORM_NOTE_BODY, SHARED_NOTE_PREFIX } from "../server/profiles.mjs";
import { STANDING_RULES } from "../server/lessons.mjs";
import { SOFT_FLAG_NUDGE, WRITE_HANDOFF_PROMPT } from "../server/lead-handoff.mjs";
import { validateJudgment, MAX_JUDGMENT_LINES } from "../cli/vs.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const VS = join(ROOT, "cli/vs.mjs");

// ---- the audit matcher (narrow: an imperative verb aimed at the packet / Judgment section / ~/.vibesquad)
export const HAND_EDIT = [
  /\b(?:fill|fill in|complete)\s+(?:in\s+)?the\s+judgment\b/i,
  /\b(?:write|put|add|type)\s+(?:your\s+)?judgment\s+(?:in|into|to)\s+the\s+(?:packet|handoff)\b/i,
  /\b(?:edit|open|modify|update)\s+(?:the\s+|your\s+)?(?:handoff\s+)?packet\b/i,
  /\bwrite\s+(?:your\s+)?packet\s+judgment\b/i,
  // negated forms ("never edit ~/.vibesquad", "never hand-edit files under ~/.vibesquad") are the rule itself, not a violation
  /(?<!never\s)(?<!not\s)(?<!n't\s)(?<![-\w])(?:edit|open|modify|write\s+(?:to|into)|append\s+to)\s+(?:the\s+)?(?:files?\s+(?:under\s+|in\s+)?)?~\/\.vibesquad\b/i,
];
export function findHandEdit(text) {
  const hits = [];
  for (const re of HAND_EDIT) { const m = String(text).match(re); if (m) hits.push(m[0]); }
  return hits;
}
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const flat = (v) => (Array.isArray(v) ? v.join("\n") : String(v));

test("audit: no injected prompt/rule/steer source tells an agent to edit a packet or ~/.vibesquad file", () => {
  const sources = {
    "agent-duties.ts": read("server/hooks/agent-duties.ts"),
    "lead-handoff.mjs": read("server/lead-handoff.mjs"),
    "lessons.mjs": read("server/lessons.mjs"),
    "profiles.mjs": read("server/profiles.mjs"),
    "src/profiles.ts": read("src/profiles.ts"),
    "mcp/tools.mjs": read("server/mcp/tools.mjs"),
    "brainstorm.mjs": read("server/brainstorm.mjs"),
    "profile notes": [flat(SHARED_NOTE_PREFIX), flat(LEAD_NOTE_BODY), flat(BRAINSTORM_NOTE_BODY), ...DEFAULT_PACK_PROFILES.map((p) => p.notes || "")].join("\n"),
    steers: `${SOFT_FLAG_NUDGE}\n${WRITE_HANDOFF_PROMPT}`,
    "STANDING_RULES": STANDING_RULES.join("\n"),
  };
  for (const f of ["docs/LEAD_RULES.md", "docs/WORKFLOWS.md"]) if (existsSync(join(ROOT, f))) sources[f] = read(f);
  const bad = [];
  for (const [name, text] of Object.entries(sources)) for (const hit of findHandEdit(text)) bad.push(`${name}: "${hit}"`);
  assert.deepEqual(bad, []);
});

test("audit positive control: catches planted bad phrases, allows the vs verb phrasing", () => {
  for (const s of [
    "Run `vs handoff` and fill the Judgment section.",
    "write your Judgment in the packet",
    "write your packet Judgment first",
    "Please edit the packet before handoff",
    "open ~/.vibesquad/teams/x/packet.md",
  ]) assert.ok(findHandEdit(s).length > 0, s);
  for (const s of [
    "run `vs handoff --judgment-file <file>` (or `--judgment -`); never edit ~/.vibesquad files by hand",
    "Never hand-edit files under ~/.vibesquad (handoff packets, teams, logs, marks); use the vs verb",
  ]) assert.deepEqual(findHandEdit(s), [], s);
});

test("rule text is reworded and the standing rule is present", () => {
  assert.match(SOFT_FLAG_NUDGE, /vs handoff --judgment-file/);
  assert.match(WRITE_HANDOFF_PROMPT, /--judgment-file/);
  assert.match(read("server/hooks/agent-duties.ts"), /vs handoff --judgment-file <file>` \(or `--judgment -`\)/);
  const rule = "Never hand-edit files under ~/.vibesquad (handoff packets, teams, logs, marks); use the vs verb (vs handoff --judgment-file/--judgment -, vs log, vs inbox, vs task).";
  assert.ok(STANDING_RULES.includes(rule));
});

// ---- validateJudgment
test("validateJudgment: 40 lines ok, 41 refused (not truncated), empty refused", () => {
  const n = (k) => Array.from({ length: k }, (_, i) => `l${i}`).join("\n");
  assert.equal(validateJudgment(n(MAX_JUDGMENT_LINES)).split("\n").length, 40);
  assert.throws(() => validateJudgment(n(41)), /41 lines; the cap is 40/);
  assert.throws(() => validateJudgment("  \n\n "), /empty/);
});

// ---- the real CLI
function run(args, { input, home } = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, VIBESQUAD_HOME: join(home, ".vibesquad") };
  delete env.PASEO_AGENT_ID; delete env.VS_AGENT_ID;
  return spawnSync(process.execPath, [VS, "handoff", "--team", "t1", "--lane", "l1", "--ord", "1", "--role", "lead", ...args], { env, input, encoding: "utf8", timeout: 60000 });
}

test("vs handoff: --judgment-file and --judgment - land in the packet; over-40 and empty are refused; no flag keeps the template", () => {
  const home = mkdtempSync(join(tmpdir(), "vs-judg-"));
  try {
    const jf = join(home, "j.md");
    writeFileSync(jf, "### Decisions\n- chose A\n", "utf8");
    const out1 = join(home, "a.md");
    const r1 = run(["--judgment-file", jf, "--out", out1], { home });
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(readFileSync(out1, "utf8"), /## Judgment[^\n]*\n\n### Decisions\n- chose A/);
    assert.doesNotMatch(r1.stderr, /Judgment not filled/);

    const out2 = join(home, "b.md");
    const r2 = run(["--judgment", "-", "--out", out2], { home, input: "### Gotchas\n- from stdin\n" });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(readFileSync(out2, "utf8"), /- from stdin/);

    const big = join(home, "big.md");
    writeFileSync(big, Array.from({ length: 41 }, (_, i) => `x${i}`).join("\n"), "utf8");
    const out3 = join(home, "c.md");
    const r3 = run(["--judgment-file", big, "--out", out3], { home });
    assert.notEqual(r3.status, 0);
    assert.match(r3.stderr, /41 lines; the cap is 40/);
    assert.equal(existsSync(out3), false, "nothing written on refusal");

    const r4 = run(["--judgment", "-", "--out", join(home, "d.md")], { home, input: "\n  \n" });
    assert.notEqual(r4.status, 0);
    assert.match(r4.stderr, /empty/);

    const out5 = join(home, "e.md");
    const r5 = run(["--out", out5], { home });
    assert.equal(r5.status, 0, r5.stderr);
    const t5 = readFileSync(out5, "utf8");
    assert.match(t5, /### Decisions\n\n### Gotchas\n\n### Next 3 Steps\n\n### Don't-Do/);
    assert.match(r5.stderr, /--judgment-file <file>.*--judgment -/);
    assert.equal(r5.stdout.trim(), out5, "stdout stays the packet path");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
