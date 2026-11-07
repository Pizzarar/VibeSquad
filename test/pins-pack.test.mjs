import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAINSTORM_PACK, LEAD_FALLBACK_PACK } from "../server/hooks/agent-duties.ts";
import {
  buildBrainstormInitialPrompt,
  performBrainstormRestart,
  readBrainstormSummary,
  resetBrainstormRestartState,
} from "../server/brainstorm.mjs";
import { applyWhosHere, refreshWhosHere, whosHereBody } from "../server/whos-here.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

test("(a) packs carry the new rules", () => {
  for (const needle of [
    "Read `docs/brainstorm/<lane>.md` before anything else",
    "short diff",
    "## Done when",
    "Never complete a Team yourself",
    "vs:looks-done",
    "✓ Mark complete · Not yet",
    "That sounds like <Team>. Send it there?",
    "I just thought of X",
    "overlap",
    "hard limit VS retires you",
  ]) {
    assert.ok(BRAINSTORM_PACK.includes(needle), `BRAINSTORM_PACK missing: ${needle}`);
  }
  assert.ok(LEAD_FALLBACK_PACK.includes("## In flight"));
  assert.ok(LEAD_FALLBACK_PACK.includes("PASS"));
  const prompt = buildBrainstormInitialPrompt({ laneId: "pinned", laneUpper: "PINNED", summaryContent: "x", latestPlan: "docs/PLAN_X.md" });
  assert.ok(prompt.includes("vs:looks-done") && prompt.includes("Who's here") && prompt.includes("Done when"));
  assert.ok(readBrainstormSummary("no-such-lane-xyz").content.includes("no brief yet"));
});

test("(b) a brainstorm over the hard limit is retired and spawns a successor right away", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-pins-pack-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const calls = { create: 0, update: [], archive: [] };
    const daemon = {
      async createAgent() { calls.create++; return { id: "bs-next" }; },
      async cancelAgent() {},
      async updateAgent(id, patch) { calls.update.push({ id, patch }); },
      async archiveAgent(id) { calls.archive.push(id); },
    };
    const r = await performBrainstormRestart(
      {
        agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "auto-150k", usedTokens: 160000,
        pendingPrompt: "keep this message",
        oldAgent: { id: "bs-1", title: "BRAINSTORM · PINNED", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
        daemonClient: daemon,
        backstopDelayMs: 60000,
      },
      dir,
    );
    assert.equal(r.retired, true);
    assert.equal(r.newAgentId, "bs-next");
    assert.equal(r.pendingPrompt, "keep this message");
    assert.equal(calls.create, 1);
    assert.equal(calls.update[0].patch.labels.role, "former-brainstorm");
    assert.deepEqual(calls.archive, ["bs-1"]);
  } finally {
    resetBrainstormRestartState();
    if (prev === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(c) Who's here refresh for the pinned lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-whos-here-"));
  // Hermetic registry: a real "pinned" lane in ~/.vibesquad would redirect the brief to its project dir.
  const prevTeams = process.env.VIBESQUAD_TEAMS_FILE;
  writeFileSync(join(dir, "teams.json"), '{"teams":[]}');
  process.env.VIBESQUAD_TEAMS_FILE = join(dir, "teams.json");
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const brief = join(dir, "docs", "brainstorm", "pinned.md");
    writeFileSync(brief, "# Brainstorm Summary · PINNED TEAMS (`pinned`)\n\n> brief\n\n## Decided\n- a\n\n## Open\n- none\n", "utf8");
    const L = (id, title, role, extra = {}) => ({ id, title, status: "idle", labels: { lane: "pinned", role }, ...extra });
    const agents = [
      L("a1", "BRAINSTORM · PINNED", "brainstorm"),
      L("a2", "(old) BRAINSTORM · PINNED", "former-brainstorm"),
      L("a3", "★ LEAD · PINNED ord1", "lead"),
      L("a4", "w1", "worker"),
      L("a5", "w2", "worker"),
      L("a6", "gone", "worker", { archivedAt: "2026-11-01" }),
      { id: "b1", title: "other", labels: { lane: "other", role: "worker" } },
    ];
    const res = refreshWhosHere({ laneId: "pinned", agents, rootDir: dir });
    assert.equal(res.changed, true);
    const out = readFileSync(brief, "utf8");
    console.log(out.split("## Decided")[0]);
    assert.match(out, /## Who's here\n- Brainstorm: BRAINSTORM · PINNED\n- Lead: ★ LEAD · PINNED ord1\n- Workers: 2\n\n## Decided/);
    assert.ok(!/a1|a3|\(old\)/.test(res.body), "no IDs or (old) rows");
    assert.equal(refreshWhosHere({ laneId: "pinned", agents, rootDir: dir }).changed, false, "idempotent");
    // replaces in place when roles change
    const next = applyWhosHere(out, whosHereBody(agents.slice(2), "pinned"));
    assert.match(next, /Brainstorm: none running/);
    assert.equal(next.match(/## Who's here/g).length, 1);
  } finally {
    if (prevTeams === undefined) delete process.env.VIBESQUAD_TEAMS_FILE;
    else process.env.VIBESQUAD_TEAMS_FILE = prevTeams;
    rmSync(dir, { recursive: true, force: true });
  }
});
