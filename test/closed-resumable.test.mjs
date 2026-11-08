// Regression: after a runner restart an idle agent's status becomes "closed" (lost/exited in the runner log).
// "closed" means resumable-on-send and still live in the roster; only archived or former-lead is retired.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { effectiveAgentRole, isRetiredAgent, resolveLeadWinner, whoCandidate } from "../server/identity.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = join(REPO_ROOT, "cli", "vs.mjs");

// ── 1. Identity: closed (not archived, not former-lead) is live ──────────────

test("isRetiredAgent: closed is NOT retired unless archived or former-lead", () => {
  assert.equal(isRetiredAgent({ status: "closed", labels: { role: "lead" } }), false, "closed lead is not retired");
  assert.equal(isRetiredAgent({ status: "closed", labels: { role: "worker" } }), false, "closed worker is not retired");
  assert.equal(isRetiredAgent({ status: "closed", labels: { role: "brainstorm" } }), false, "closed Buddy is not retired");
  // Archived or former-lead stays retired, even when also closed.
  assert.equal(isRetiredAgent({ status: "closed", archivedAt: "2026-01-01T00:00:00Z", labels: { role: "lead" } }), true, "archived stays retired");
  assert.equal(isRetiredAgent({ status: "closed", labels: { role: "former-lead" } }), true, "former-lead stays retired");
  assert.equal(isRetiredAgent({ status: "idle", labels: { role: "former-lead" } }), true, "former-lead idle stays retired");
});

test("effectiveAgentRole: a closed lead is still a lead", () => {
  assert.equal(effectiveAgentRole({ status: "closed", labels: { role: "lead" } }), "lead");
  assert.equal(effectiveAgentRole({ status: "closed", labels: { role: "former-lead" } }), "retired");
  assert.equal(effectiveAgentRole({ status: "closed", archivedAt: "x", labels: { role: "lead" } }), "retired");
});

test("whoCandidate: a closed lead is a candidate; archived and former-lead are not", () => {
  const teams = [{ id: "efi", name: "Main", paths: [], lanes: [{ id: "main-game", name: "Main Game" }] }];
  const closedLead = { id: "rn-1", status: "closed", cwd: "/p/efi", labels: { team: "efi", lane: "main-game", role: "lead" } };
  assert.equal(whoCandidate(closedLead, { teams, wantTeamId: "efi", wantLane: "main-game" })?.role, "lead");
  const archivedLead = { id: "rn-2", status: "closed", cwd: "/p/efi", archivedAt: "x", labels: { team: "efi", lane: "main-game", role: "lead" } };
  assert.equal(whoCandidate(archivedLead, { teams, wantTeamId: "efi", wantLane: "main-game" }), null);
  const oldLead = { id: "rn-3", status: "closed", cwd: "/p/efi", labels: { team: "efi", lane: "main-game", role: "former-lead" } };
  assert.equal(whoCandidate(oldLead, { teams, wantTeamId: "efi", wantLane: "main-game" }), null);
});

test("resolveLeadWinner: non-closed beats closed; newest wins among equals; CONFLICT only for 2+ non-closed", () => {
  const mk = (id, status, createdAt) => ({ id, status, createdAt });
  assert.equal(resolveLeadWinner([mk("old-closed", "closed", "2026-01-01"), mk("new-live", "idle", "2026-01-02")]).winner.id, "new-live");
  assert.equal(resolveLeadWinner([mk("a", "closed", "2026-01-01"), mk("b", "closed", "2026-01-02")]).winner.id, "b");
  const two = resolveLeadWinner([mk("a", "idle", "2026-01-01"), mk("b", "running", "2026-01-02")]);
  assert.equal(two.conflict, true);
  assert.equal(two.winner.id, "b");
  assert.equal(resolveLeadWinner([mk("a", "idle", "2026-01-01"), mk("b", "closed", "2026-01-02")]).conflict, false);
  assert.deepEqual(resolveLeadWinner([]), { winner: null, conflict: false, contenders: [] });
});

// ── 2. CLI: vs who lists a closed agent and vs who lead returns it ───────────

function makeCliEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-closed-resumable-"));
  const vsHome = join(dir, ".vibesquad");
  const agentsDir = join(vsHome, "runner", "agents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(
    join(vsHome, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "efi",
          name: "Main Project",
          paths: ["main-project"],
          lanes: [
            { id: "main-game", name: "Main Game" },
            { id: "ui-lab", name: "UI Lab" },
            { id: "feature", name: "Feature" },
          ],
        },
      ],
    }) + "\n",
    "utf8",
  );
  // Writes a runner log whose last status is "closed" (an exit event after idle), mirroring a restart.
  const agent = (id, title, labels) => {
    const ts = Date.now();
    const evs = [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: join(dir, "elsewhere"), meta: { title, labels } },
      { seq: 1, ts, type: "status", status: "idle" },
      { seq: 2, ts, type: "exit", code: null },
    ];
    writeFileSync(join(agentsDir, id + ".jsonl"), evs.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");
  };
  // Writes a LIVE runner log (idle, no exit) at a given createdAt offset (ms from now).
  const liveAgent = (id, title, labels, createdAtOffset = 0) => {
    const ts = Date.now() + createdAtOffset;
    const evs = [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: join(dir, "elsewhere"), meta: { title, labels } },
      { seq: 1, ts, type: "status", status: "idle" },
    ];
    writeFileSync(join(agentsDir, id + ".jsonl"), evs.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");
  };
  const closedAgent = (id, title, labels, createdAtOffset = 0) => {
    const ts = Date.now() + createdAtOffset;
    const evs = [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: join(dir, "elsewhere"), meta: { title, labels } },
      { seq: 1, ts, type: "status", status: "idle" },
      { seq: 2, ts, type: "exit", code: null },
    ];
    writeFileSync(join(agentsDir, id + ".jsonl"), evs.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");
  };
  const archivedAgent = (id, title, labels) => {
    const ts = Date.now();
    const evs = [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: join(dir, "elsewhere"), meta: { title, labels } },
      { seq: 1, ts, type: "status", status: "idle" },
      { seq: 2, ts, type: "archive", ts: ts + 1 },
      { seq: 3, ts: ts + 2, type: "exit", code: null },
    ];
    writeFileSync(join(agentsDir, id + ".jsonl"), evs.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");
  };
  // Live lane: a closed lead and a closed worker (resumable).
  agent("rn-lead-live", "★ MAIN ord1", { team: "efi", lane: "main-game", role: "lead", ord: "1" });
  agent("rn-worker-live", "MAIN · worker", { team: "efi", lane: "main-game", role: "worker", ord: "1" });
  // Retired lane: a former-lead (archived) and an archived lead.
  archivedAgent("rn-lead-old", "(old) ★ UI ord2", { team: "efi", lane: "ui-lab", role: "former-lead", ord: "2" });
  archivedAgent("rn-lead-archived", "★ UI ord3", { team: "efi", lane: "ui-lab", role: "lead", ord: "3" });
  // Feature lane: a closed OLDER lead (predecessor) plus a live NEWER lead (successor).
  closedAgent("rn-lead-pred", "★ FEATURE ord4", { team: "efi", lane: "feature", role: "lead", ord: "4" }, -60_000);
  liveAgent("rn-lead-new-live", "★ FEATURE ord5", { team: "efi", lane: "feature", role: "lead", ord: "5" }, 0);
  liveAgent("rn-feature-worker", "FEATURE · worker", { team: "efi", lane: "feature", role: "worker", ord: "5" }, 0);

  return {
    run(args, extraEnv = {}) {
      return spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, VIBESQUAD_HOME: vsHome, PASEO_HOME: join(dir, ".paseo"), PASEO_AGENT_ID: "", VS_AGENT_ID: "", VS_TEAM: "", VS_LANE: "", ...extraEnv },
      });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("vs who all lists a closed lead and worker, but not archived/former-lead agents", () => {
  const env = makeCliEnv();
  try {
    const res = env.run(["who", "all", "--team", "efi"]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("rn-lead-live"), res.stdout);
    assert.ok(res.stdout.includes("rn-worker-live"), res.stdout);
    assert.ok(!res.stdout.includes("rn-lead-old"), res.stdout);
    assert.ok(!res.stdout.includes("rn-lead-archived"), res.stdout);
  } finally {
    env.cleanup();
  }
});

test("vs who lead returns a closed (resumable) lead; a lane of only retired leads reads NONE", () => {
  const env = makeCliEnv();
  try {
    const live = env.run(["who", "lead"], { PASEO_AGENT_ID: "rn-worker-live" });
    assert.equal(live.status, 0, live.stderr);
    assert.ok(live.stdout.includes("rn-lead-live"), live.stdout);

    const retired = env.run(["who", "lead", "--team", "efi", "--lane", "ui-lab"]);
    assert.equal(retired.status, 1, retired.stderr);
    assert.equal(retired.stdout.trim(), "NONE", retired.stdout);
  } finally {
    env.cleanup();
  }
});

test("vs who lead returns the live newer lead over a closed older lead; vs who lists both (no CONFLICT)", () => {
  const env = makeCliEnv();
  try {
    const res = env.run(["who", "lead"], { PASEO_AGENT_ID: "rn-feature-worker" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim().split(/\r?\n/).length, 1, res.stdout);
    assert.ok(res.stdout.includes("rn-lead-new-live"), res.stdout);
    assert.ok(!res.stdout.includes("rn-lead-pred"), res.stdout);

    const all = env.run(["who", "all", "--team", "efi", "--lane", "feature"]);
    assert.equal(all.status, 0, all.stderr);
    assert.ok(all.stdout.includes("rn-lead-new-live"), all.stdout);
    assert.ok(all.stdout.includes("rn-lead-pred"), all.stdout);

    // JSON: status "ok", single entry (the winner), never "conflict".
    const json = env.run(["who", "lead", "--team", "efi", "--lane", "feature", "--json"]);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.status, "ok", json.stdout);
    assert.deepEqual(parsed.entries.map((e) => e.id), ["rn-lead-new-live"]);
  } finally {
    env.cleanup();
  }
});

// ── 3. Send routing: closed is not rerouted; archived/former-lead still are ──

import { createPlugin } from "../server/hooks/agent-duties.ts";

function sendHarness(agents) {
  const server = {
    before() {
      return () => {};
    },
    on() {
      return () => {};
    },
  };
  const plugin = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {} });
  const handle = plugin(server);
  const sent = [];
  const paseo = {
    agents: {
      ref(id) {
        return {
          async refresh() {
            const a = agents.get(id);
            return a ? { agent: a } : null;
          },
          async send(text) {
            sent.push({ to: id, text });
          },
        };
      },
      async list() {
        return { entries: [...agents.values()].map((agent) => ({ agent })) };
      },
    },
  };
  return { handle, sent, paseo };
}

const team = (id, lane, role, status, extra = {}) => ({
  id,
  title: `${lane} ${role} ${id}`,
  cwd: "/p/efi",
  status,
  labels: { team: "efi", lane, role, ord: "1", ...(extra.labels ?? {}) },
  ...(extra.archivedAt ? { archivedAt: extra.archivedAt } : {}),
  ...(extra.updatedAt ? { updatedAt: extra.updatedAt } : {}),
});

test("send to a closed (resumable) lead is not rerouted", async () => {
  const agents = new Map([["lead-closed", team("lead-closed", "main-game", "lead", "closed")]]);
  const { handle, paseo } = sendHarness(agents);
  const res = await handle.sendAgentPrompt({ agentId: "lead-closed", senderAgentId: "bs-sender", prompt: "hi" }, { paseo });
  assert.equal(res, undefined, "no redirect for a closed, resumable agent");
});

test("send to an archived lead still redirects to the live successor", async () => {
  const agents = new Map([
    ["lead-archived", team("lead-archived", "main-game", "lead", "closed", { archivedAt: "2026-01-01T00:00:00Z" })],
    ["lead-live", team("lead-live", "main-game", "lead", "idle")],
  ]);
  const { handle, paseo } = sendHarness(agents);
  const res = await handle.sendAgentPrompt({ agentId: "lead-archived", senderAgentId: "bs-sender", prompt: "hi" }, { paseo });
  assert.ok(res, "archived target is rerouted");
  assert.equal(res.redirected, true);
  assert.equal(res.agentId, "lead-live");
});

test("send to a former-lead still redirects to the live successor", async () => {
  const agents = new Map([
    ["lead-old", team("lead-old", "main-game", "former-lead", "closed")],
    ["lead-live", team("lead-live", "main-game", "lead", "idle")],
  ]);
  const { handle, paseo } = sendHarness(agents);
  const res = await handle.sendAgentPrompt({ agentId: "lead-old", senderAgentId: "bs-sender", prompt: "hi" }, { paseo });
  assert.ok(res, "former-lead target is rerouted");
  assert.equal(res.redirected, true);
  assert.equal(res.agentId, "lead-live");
});
