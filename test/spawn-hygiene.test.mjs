import assert from "node:assert/strict";
import test from "node:test";
import { EVERYONE_LAYER, dedupeNotesAgainst, injectedPrefix } from "../plugin/index.server.ts";
import { SHARED_NOTE_PREFIX } from "../server/profiles.mjs";

test("block 1: R1-R7 rules appear once when profile notes repeat them", () => {
  const prefix = injectedPrefix("worker", "");
  const notes = `${SHARED_NOTE_PREFIX}\nRole-specific line.`;
  const composed = [prefix, dedupeNotesAgainst(notes, prefix)].join("\n\n");
  for (const tag of ["R1 (Search/Read)", "R3 (Images)", "R4 (Large files)", "R6 (Waiting)", "R2/R7 (Git state)"]) {
    assert.equal(composed.split(tag).length - 1, 1, tag);
  }
  assert.ok(composed.includes("Role-specific line."));
  assert.ok(composed.includes("Project rules first"));
  assert.ok(!/Roster:/.test(composed));
});

test("block 1: bold-style rules in notes are deduped too", () => {
  const out = dedupeNotesAgainst("- **R1 (Search/Read):** x\nkeep me", EVERYONE_LAYER);
  assert.equal(out, "keep me");
});

// ---- block 2: brief lane comes from the label/env, never from cwd ----
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin } from "../plugin/index.server.ts";

async function withBriefEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-hygiene-"));
  const vsHome = join(dir, ".vibesquad");
  const briefRoot = join(dir, "repo");
  mkdirSync(vsHome, { recursive: true });
  mkdirSync(join(briefRoot, "docs", "brainstorm"), { recursive: true });
  const lanes = ["vibesquad", "token-checker"].map((id) => ({ id, name: id, paths: id === "vibesquad" ? ["VibeSquad"] : [] }));
  const teamsFile = join(vsHome, "teams.json");
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes, paths: ["VibeSquad"] }] }), "utf8");
  for (const l of ["vibesquad", "token-checker"]) {
    writeFileSync(join(briefRoot, "docs", "brainstorm", `${l}.md`), `# ${l}\n\n## Done when\n- ${l}-marker\n`, "utf8");
  }
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_PROFILES_PATH"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.VIBESQUAD_HOME = vsHome;
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
  process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
  try {
    const before = new Map();
    const server = { before: (n, f) => (before.set(n, f), () => {}), on: () => () => {} };
    createPlugin({ startWatcher: false, briefRoot, setLabels: async () => {}, archiveAgent: async () => {} })(server);
    const spawn = (req) => {
      const r = { config: { cwd: "/projects/VibeSquad/.worktrees/x", ...req.config }, ...req };
      const out = before.get("agent.create")({ request: r }) ?? r;
      return String(out.config.systemPrompt ?? "");
    };
    const log = () => {
      const f = join(vsHome, "teams", "vibesquad", "log.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    };
    await fn({ spawn, log });
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("block 2: lane label (or VS_LANE env) picks the brief; cwd never does", () =>
  withBriefEnv(({ spawn, log }) => {
    const byLabel = spawn({ labels: { role: "brainstorm", team: "vibesquad", lane: "token-checker" } });
    assert.ok(byLabel.includes("token-checker-marker") && !byLabel.includes("vibesquad-marker"));
    assert.match(log(), /brief-injected: lane=token-checker/);

    const byEnv = spawn({ env: { VS_ROLE: "brainstorm", VS_LANE: "token-checker" } });
    assert.ok(byEnv.includes("token-checker-marker"));

    const unknown = spawn({ labels: { role: "brainstorm" } });
    assert.ok(!unknown.includes("--- BEGIN docs/brainstorm/"), "no lane -> no brief, even from a vibesquad worktree cwd");
  }));
