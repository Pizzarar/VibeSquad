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

// ---- block 3: no duplicate Buddy when the agent list can't be read ----
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";

function brainstormDaemon(fetchAgents) {
  const created = [];
  return {
    created,
    fetchAgents,
    async createAgent(req) {
      created.push(req);
      return { id: `new-${created.length}`, labels: {} };
    },
    async archiveAgent() {},
    async updateAgent() {},
    async cancelAgent() {},
  };
}

test("block 3: fetchAgents rejecting (or returning junk) spawns nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-hygiene-b3-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  try {
    for (const fetchAgents of [async () => { throw new Error("daemon restarting"); }, async () => null, async () => ({ nope: 1 })]) {
      resetBrainstormRestartState();
      const daemon = brainstormDaemon(fetchAgents);
      const r = await performBrainstormRestart(
        { reason: "start-brainstorm", teamId: "sq", laneId: "dup-test", daemonClient: daemon, emptyRetryMs: 1 },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.reason, "agent-list-unavailable");
      assert.equal(daemon.created.length, 0, "must not spawn");
    }
  } finally {
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("block 3: an empty list is retried once; a readable list reuses the live Buddy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-hygiene-b3b-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  try {
    resetBrainstormRestartState();
    let calls = 0;
    const live = { id: "bs1", status: "idle", title: "BRAINSTORM", labels: { team: "sq", lane: "dup-test", role: "brainstorm" } };
    const daemon = brainstormDaemon(async () => (++calls === 1 ? [] : [live]));
    const r = await performBrainstormRestart(
      { reason: "start-brainstorm", teamId: "sq", laneId: "dup-test", daemonClient: daemon, emptyRetryMs: 1 },
      dir,
    );
    assert.equal(calls, 2);
    assert.equal(r.reused, true);
    assert.equal(daemon.created.length, 0);
  } finally {
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- block 4: boot acts, not confirms ----
import { buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";

test("block 4: boot prompt tells the Buddy to work the top Open item, not confirm readiness", () => {
  const p = buildBrainstormInitialPrompt({ laneId: "x", laneUpper: "X", summaryContent: "## Open\n- q1", latestPlan: "docs/PLAN_X.md" });
  assert.match(p, /Work the top Open item now/);
  assert.ok(!/confirming you are ready/.test(p));
  const withPending = buildBrainstormInitialPrompt({ laneId: "x", laneUpper: "X", summaryContent: "s", latestPlan: "p", pendingPrompt: "hello" });
  assert.match(withPending, /Pending message from the user to answer now:\nhello/);
});

// ---- block 5: live In-flight block at boot ----
test("block 5: boot prompt lists the lane's running lead, workers and latest log entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-hygiene-b5-"));
  const home = join(dir, ".vibesquad");
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = home;
  try {
    mkdirSync(join(home, "teams", "sq"), { recursive: true });
    writeFileSync(
      join(home, "teams", "sq", "log.jsonl"),
      [
        { ts: "t1", agent: "x", lane: "lane-a", type: "decision", text: "chose A" },
        { ts: "t2", agent: "x", lane: "lane-b", type: "decision", text: "other lane" },
        { ts: "t3", agent: "x", lane: "lane-a", type: "metric", text: "spawn-timing noise" },
        { ts: "t4", agent: "plugin", lane: "lane-a", type: "done", text: "block 3 PASS" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const agents = [
      { id: "L1", title: "★ LANE ord3", status: "running", updatedAt: "2026-11-01T10:00:00Z", labels: { team: "sq", lane: "lane-a", role: "lead" } },
      { id: "W1", title: "worker one", status: "running", labels: { team: "sq", lane: "lane-a", role: "worker" } },
      { id: "L2", title: "other lane lead", status: "running", labels: { team: "sq", lane: "lane-b", role: "lead" } },
    ];
    resetBrainstormRestartState();
    const created = [];
    const daemon = {
      fetchAgents: async () => agents,
      createAgent: async (req) => (created.push(req), { id: "new1", labels: {} }),
      archiveAgent: async () => {},
      updateAgent: async () => {},
      cancelAgent: async () => {},
    };
    await performBrainstormRestart({ reason: "start-brainstorm", teamId: "sq", laneId: "lane-a", daemonClient: daemon, emptyRetryMs: 1 }, dir);
    const p = created[0].initialPrompt;
    assert.match(p, /In flight \(live/);
    assert.match(p, /Lead: ★ LANE ord3 \[running/);
    assert.match(p, /Workers: worker one/);
    assert.ok(!p.includes("other lane lead") && !p.includes("other lane\n"));
    assert.match(p, /block 3 PASS/);
    assert.match(p, /chose A/);
    assert.ok(!p.includes("spawn-timing noise"));
  } finally {
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("block 5: unreadable agent list is stated, not guessed", async () => {
  const { liveInFlightBlock } = await import("../server/in-flight.mjs");
  const b = liveInFlightBlock({ agents: null, laneId: "z", teamId: "nope", home: tmpdir() });
  assert.match(b, /Live agents: unavailable/);
});

// ---- block 6: brief durability ----
import { BRIEF_HISTORY_KEEP, writeBrainstormSummary } from "../server/brainstorm.mjs";
import { readdirSync } from "node:fs";

function withBriefDirs(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-hygiene-b6-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "docs", "brainstorm"), { recursive: true });
    return fn({ repo, history: join(dir, ".vibesquad", "brief-history", "lane-x"), file: join(repo, "docs", "brainstorm", "lane-x.md") });
  } finally {
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("block 6: a near-empty write keeps the old brief (and a backup exists)", () =>
  withBriefDirs(({ repo, history, file }) => {
    const big = "# Brief\n" + "- decision line\n".repeat(100);
    writeBrainstormSummary("lane-x", big, repo);
    assert.throws(() => writeBrainstormSummary("lane-x", "# Brief\n", repo), /Refusing to replace/);
    assert.equal(readFileSync(file, "utf8"), big);
    assert.ok(readdirSync(history).length >= 1);
  }));

test("block 6: a new lane may start small; normal overwrites back up the previous text; keeps 20", () =>
  withBriefDirs(({ repo, history, file }) => {
    writeBrainstormSummary("lane-x", "# tiny\n", repo);
    assert.equal(readFileSync(file, "utf8"), "# tiny\n");
    assert.ok(!existsSync(history), "no backup for a brand-new brief");
    for (let i = 0; i < BRIEF_HISTORY_KEEP + 5; i++) writeBrainstormSummary("lane-x", `# v${i}\n`, repo);
    const files = readdirSync(history).sort();
    assert.equal(files.length, BRIEF_HISTORY_KEEP);
    assert.equal(readFileSync(join(history, files.at(-1)), "utf8"), `# v${BRIEF_HISTORY_KEEP + 3}\n`);
  }));
