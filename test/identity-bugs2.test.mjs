// Bug-chaser batch 2, blocks 1-3: no lanes[0] guess, spawn-label drift, migrate dry-run counts, whoami JSON.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createPlugin, nextLeadOrd, spawnRoleLabel } from "../server/hooks/agent-duties.ts";
import { UNASSIGNED_TEAM_ID, resolveAgentIdentity } from "../server/identity.mjs";
import { resolveAgentIdentity as tsResolveAgentIdentity } from "../src/identity.ts";

const VS_CLI = join(resolve(import.meta.dirname, ".."), "cli", "vs.mjs");

const TEAMS = [
  {
    id: "efi",
    name: "Main Project",
    paths: ["main-project"],
    lanes: [
      { id: "main-game", name: "Main Game" },
      { id: "ui-lab", name: "UI Lab" },
    ],
  },
  { id: "site", name: "Example Site", paths: ["example-site"], lanes: [{ id: "site-polish", name: "Site Polish" }] },
];

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "vs-identity-bugs2-"));
  const paseoHome = join(root, ".paseo");
  const vsHome = join(root, ".vibesquad");
  const shard = join(paseoHome, "agents", "aa");
  mkdirSync(shard, { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(join(vsHome, "teams.json"), JSON.stringify({ teams: TEAMS }) + "\n", "utf8");
  return {
    vsHome,
    writeAgent(record) {
      writeFileSync(join(shard, `${record.id}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
    },
    runVs(args) {
      return spawnSync(process.execPath, [VS_CLI, ...args], {
        cwd: root,
        env: { ...process.env, PASEO_HOME: paseoHome, VIBESQUAD_HOME: vsHome, PASEO_CLI: "", PASEO_AGENT_ID: "" },
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("block 1: team + no lane resolves to orphan, never lanes[0] (server + src)", () => {
  for (const resolveFn of [resolveAgentIdentity, tsResolveAgentIdentity]) {
    const bare = resolveFn({ labels: { team: "efi", role: "worker" } }, { teams: TEAMS });
    assert.equal(bare.isOrphan, true);
    assert.equal(bare.laneId, "");
    assert.equal(bare.teamId, UNASSIGNED_TEAM_ID);

    // A multi-lane Squad path names no lane either.
    const inRepo = resolveFn({ labels: { team: "efi" } }, { teams: TEAMS, cwd: "C:/code/main-project/wt-1" });
    assert.equal(inRepo.isOrphan, true);
    assert.notEqual(inRepo.laneId, "main-game");

    // A one-lane Squad path is unambiguous and still resolves.
    const oneLane = resolveFn({ labels: {} }, { teams: TEAMS, cwd: "C:/code/example-site/wt-1" });
    assert.equal(oneLane.isOrphan, false);
    assert.equal(oneLane.laneId, "site-polish");

    // An unregistered lane label under a known team keeps that lane.
    const kept = resolveFn({ labels: { team: "efi", lane: "zz-tmp" } }, { teams: TEAMS });
    assert.equal(kept.isOrphan, false);
    assert.equal(kept.laneId, "zz-tmp");
    assert.equal(kept.teamId, "efi");
  }
});

test("block 2: spawn labels - digests get role=worker, leads get the next ord", async () => {
  assert.equal(spawnRoleLabel("digest"), "worker");
  assert.equal(spawnRoleLabel("lead"), "lead");
  assert.equal(
    nextLeadOrd(
      [
        { id: "a", labels: { lane: "main-game", role: "former-lead", ord: "3" } },
        { id: "b", labels: { lane: "main-game", role: "lead", ord: "ord4" } },
        { id: "c", labels: { lane: "ui-lab", role: "lead", ord: "9" } },
        { id: "d", labels: { lane: "main-game", role: "worker", ord: "7" } },
        { id: "self", labels: { lane: "main-game", role: "lead", ord: "8" } },
      ],
      "main-game",
      "self",
    ),
    "5",
  );
  assert.equal(nextLeadOrd([], "main-game", "self"), "1");

  const env = makeEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const updates = [];
    const onHandlers = new Map();
    const dispose = createPlugin({
      startWatcher: false,
      async setLabels(agentId, labels) {
        updates.push({ agentId, labels });
      },
      async archiveAgent() {},
    })({ before() { return () => {}; }, on(event, fn) { onHandlers.set(event, fn); return () => {}; } });
    try {
      const agents = new Map([
        ["old-lead", { id: "old-lead", status: "idle", labels: { lane: "main-game", team: "efi", role: "former-lead", ord: "2" } }],
        ["new-lead", { id: "new-lead", status: "running", cwd: "", labels: { lane: "main-game", team: "efi", role: "lead" } }],
        ["dig", { id: "dig", status: "running", cwd: "", labels: { lane: "main-game", team: "efi", digestFor: "w1" } }],
      ]);
      const paseo = {
        agents: {
          ref(id) {
            return { async refresh() { const a = agents.get(id); return a ? { agent: a } : null; }, async archive() {}, async detach() {} };
          },
          async list() {
            return { entries: [...agents.values()].map((agent) => ({ agent })) };
          },
        },
      };
      const onCreated = onHandlers.get("agent.created");
      await onCreated({ agent: agents.get("new-lead") }, { paseo });
      assert.equal(updates.find((u) => u.agentId === "new-lead")?.labels.ord, "3");

      await onCreated({ agent: agents.get("dig") }, { paseo });
      assert.equal(updates.find((u) => u.agentId === "dig")?.labels.role, "worker");
    } finally {
      dispose();
    }
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("block 2: migrate dry-run counts archived orphans apart and keeps digests at role=worker", () => {
  const env = makeEnv();
  try {
    env.writeAgent({ id: "live-orphan", lastStatus: "idle", cwd: "C:/tmp/x", labels: { team: "efi", role: "worker" } });
    env.writeAgent({
      id: "old-orphan",
      lastStatus: "closed",
      archivedAt: "2026-10-01T00:00:00.000Z",
      cwd: "C:/tmp/y",
      labels: { role: "worker", orphan: "1" },
    });
    env.writeAgent({
      id: "digest-1",
      lastStatus: "closed",
      cwd: "",
      labels: { lane: "site-polish", team: "site", role: "worker", profile: "Pre-check - Flash", digestFor: "w1" },
    });
    const res = env.runVs(["migrate", "identity", "--dry-run"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /live-orphan \(idle\).*\[ORPHAN\]/);
    assert.match(res.stdout, /old-orphan \(archived\).*\[ARCHIVED-ORPHAN\]/);
    assert.match(res.stdout, /digest-1 \(closed\).*role=worker.*-> .*role=worker.*\[OK\]/);
    assert.match(res.stdout, /total=3 .*orphans=1 archived-orphans=1/);
    assert.equal(res.stdout.match(/\[ORPHAN\]/g)?.length, 1, "only live orphans are tagged ORPHAN");
  } finally {
    env.cleanup();
  }
});

test("block 3: vs whoami --json prints lane: null + orphan: true for a lane-less agent", () => {
  const env = makeEnv();
  try {
    env.writeAgent({ id: "team-only", lastStatus: "idle", cwd: "C:/tmp/none", labels: { team: "efi", role: "worker" } });
    const res = env.runVs(["whoami", "--agent", "team-only", "--json"]);
    assert.equal(res.status, 1, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.lane, null);
    assert.equal(out.orphan, true);
  } finally {
    env.cleanup();
  }
});
