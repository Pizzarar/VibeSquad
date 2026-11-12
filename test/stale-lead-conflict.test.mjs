// idea-166 (unit-stale-lead-conflict):
// (a) Read-only lookup rule: newest ★ / highest-ord live lead wins; lost agents never count; older ones are flagged in
//     `stale` (`staleLeads` / `· stale: ...`), not shown as CONFLICT, unless 2+ equally-new top leads are genuinely ambiguous.
// (b) Retire path: retirePredecessors + lead-handoff + `vs lead retire [--lane <code>]` relabel stale/lost predecessors to
//     `former-lead` using the existing retire title/label code.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveLeadWinner } from "../server/identity.mjs";
import { createLeadHandoffCoordinator, performLeadHandoffHttp, resetLeadHandoffState } from "../server/lead-handoff.mjs";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { commandAgentVerb } from "../cli/vs.mjs";
import { createPlugin } from "../server/hooks/agent-duties.ts";
import { seedDefaultPack } from "../server/profiles.mjs";
import { tokenFor, verifiedIdentity } from "./helpers/agent-token.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");

// ---------------------------------------------------------------------------
// 1. Exact live roster snapshots from idea-166 (usage, perfection, ui-bois)
// ---------------------------------------------------------------------------

test("resolveLeadWinner: picks the ★ / highest-ord live lead for usage, perfection, and ui-bois without CONFLICT (read-only)", () => {
  // usage: Usage Lead rn-6ee72cadc349 idle (ord 2), ★ Usa6 rn-964d9f3967e5 idle (ord 6), Usage Lead rn-d992e1291fac lost (ord 1)
  const usageCandidates = [
    {
      id: "rn-6ee72cadc349",
      title: "Usage Lead",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-07T13:27:03.536Z",
      updatedAt: "2026-11-12T03:20:35.268Z",
      labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "2", job: "Usage Lead" },
    },
    {
      id: "rn-964d9f3967e5",
      title: "★ Usa6",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-11T06:54:23.395Z",
      updatedAt: "2026-11-12T03:24:12.564Z",
      labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "6", "vs.handoff-from": "rn-d25e94ea517c" },
    },
    {
      id: "rn-d992e1291fac",
      title: "Usage Lead",
      status: "closed",
      lost: true,
      resumable: true,
      createdAt: "2026-11-07T00:22:46.944Z",
      updatedAt: "2026-11-07T13:24:15.726Z",
      labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "1" },
    },
  ];
  const usageSnap = JSON.stringify(usageCandidates);
  const usageRes = resolveLeadWinner(usageCandidates);
  assert.equal(usageRes.conflict, false, "usage must not CONFLICT");
  assert.equal(usageRes.winner?.id, "rn-964d9f3967e5", "usage winner is ★ Usa6 (rn-964d9f3967e5)");
  assert.deepEqual(usageRes.stale, ["rn-6ee72cadc349"], "older idle Usage Lead is flagged stale; lost lead never counts");
  assert.equal(JSON.stringify(usageCandidates), usageSnap, "resolveLeadWinner is strictly read-only");

  // perfection: ★ Per2 rn-56366e8af537 (ord 2), ★ Per9 rn-d7f089ad47de (ord 9)
  const perfectionCandidates = [
    {
      id: "rn-56366e8af537",
      title: "★ Per2",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-08T00:29:16.427Z",
      updatedAt: "2026-11-12T03:20:41.346Z",
      labels: { team: "vibesquad", lane: "perfection", role: "lead", ord: "2", "vs.handoff-from": "rn-b87ab37c8c00" },
    },
    {
      id: "rn-d7f089ad47de",
      title: "★ Per9",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-10T02:48:38.875Z",
      updatedAt: "2026-11-12T03:31:33.986Z",
      labels: { team: "vibesquad", lane: "perfection", role: "lead", ord: "9", "vs.handoff-from": "rn-ae4471bfc3b3" },
    },
  ];
  const perfRes = resolveLeadWinner(perfectionCandidates);
  assert.equal(perfRes.conflict, false, "perfection must not CONFLICT");
  assert.equal(perfRes.winner?.id, "rn-d7f089ad47de", "perfection winner is ★ Per9 (rn-d7f089ad47de)");
  assert.deepEqual(perfRes.stale, ["rn-56366e8af537"], "★ Per2 is flagged stale");

  // ui-bois: Lead - Claude rn-0548b8c562f3 (ord 1), Lead - Claude rn-8b6f27961453 (ord 2), ★ UI13 rn-b175b82bf389 (ord 13), ★ UI4 rn-dadb20d85aae (lost, ord 4)
  const uiBoisCandidates = [
    {
      id: "rn-0548b8c562f3",
      title: "Lead - Claude · UI3 rail menu clip",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-07T00:20:02.620Z",
      updatedAt: "2026-11-12T03:21:41.785Z",
      labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "1", job: "Lead - Claude · UI3 rail menu clip" },
    },
    {
      id: "rn-8b6f27961453",
      title: "Lead - Claude · UI4 floor P3 + squads P4",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-07T15:39:40.007Z",
      updatedAt: "2026-11-12T03:20:30.566Z",
      labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "2", job: "Lead - Claude · UI4 floor P3 + squads P4" },
    },
    {
      id: "rn-b175b82bf389",
      title: "★ UI13",
      status: "idle",
      lost: false,
      resumable: false,
      createdAt: "2026-11-11T07:41:11.145Z",
      updatedAt: "2026-11-12T03:29:37.601Z",
      labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "13", "vs.handoff-from": "rn-5ed302568dea" },
    },
    {
      id: "rn-dadb20d85aae",
      title: "★ UI4",
      status: "closed",
      lost: true,
      resumable: true,
      createdAt: "2026-11-07T22:28:54.729Z",
      updatedAt: "2026-11-07T23:01:27.079Z",
      labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "4" },
    },
  ];
  const uiRes = resolveLeadWinner(uiBoisCandidates);
  assert.equal(uiRes.conflict, false, "ui-bois must not CONFLICT");
  assert.equal(uiRes.winner?.id, "rn-b175b82bf389", "ui-bois winner is ★ UI13 (rn-b175b82bf389)");
  assert.deepEqual(uiRes.stale, ["rn-8b6f27961453", "rn-0548b8c562f3"], "legacy Lead - Claude agents are flagged stale; lost UI4 never counts");
});

test("resolveLeadWinner: lost agents (lost:true or status:lost/closed) never count against a live lead; 2 equally-new top leads still CONFLICT", () => {
  const live = { id: "rn-live", title: "★ Usa2", status: "idle", createdAt: "2026-11-08T00:00:00.000Z", labels: { role: "lead", ord: "2" } };
  const lostHigherOrd = { id: "rn-lost-high", title: "★ Usa9", status: "lost", lost: true, resumable: true, createdAt: "2026-11-10T00:00:00.000Z", labels: { role: "lead", ord: "9" } };
  const r1 = resolveLeadWinner([lostHigherOrd, live]);
  assert.equal(r1.conflict, false);
  assert.equal(r1.winner?.id, "rn-live", "a lost agent never beats a live lead");
  assert.deepEqual(r1.stale, []);

  // Two equally-new leads (same star and same highest ord) genuinely conflict; older leads and lost leads are excluded from contenders.
  const twinA = { id: "rn-twin-a", title: "★ Usa6", status: "idle", createdAt: "2026-11-11T00:00:00.000Z", labels: { role: "lead", ord: "6" } };
  const twinB = { id: "rn-twin-b", title: "★ Usa6", status: "idle", createdAt: "2026-11-11T00:01:00.000Z", labels: { role: "lead", ord: "6" } };
  const r2 = resolveLeadWinner([live, lostHigherOrd, twinA, twinB]);
  assert.equal(r2.conflict, true, "two equally-new top leads conflict");
  assert.equal(r2.winner?.id, "rn-twin-b");
  assert.deepEqual(r2.contenders, ["rn-twin-b", "rn-twin-a"], "only the ambiguous top-tier leads are contenders");
  assert.deepEqual(r2.stale, ["rn-live"], "older live lead is in stale, not contenders");
});

// ---------------------------------------------------------------------------
// 2. CLI `vs who lead`: flags stale leads without CONFLICT, read-only
// ---------------------------------------------------------------------------

function makeCliEnv() {
  const dir = mkdtempSync(join(os.tmpdir(), "vs-stale-lead-cli-"));
  const vsHome = join(dir, ".vibesquad");
  const paseoHome = join(dir, ".paseo");
  const agentsDir = join(vsHome, "runner", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(vsHome, "local-token"), "a".repeat(64) + "\n", "utf8");
  seedDefaultPack(join(vsHome, "profiles.json"));
  writeFileSync(
    join(vsHome, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: ["vibesquad"],
          lanes: [
            { id: "vibesquad", name: "VibeSquad", hub: true },
            { id: "usage", name: "Usage" },
            { id: "perfection", name: "Perfection" },
            { id: "ui-bois", name: "UI Bois" },
          ],
        },
      ],
    }) + "\n",
    "utf8",
  );
  const now = Date.now();
  writeFileSync(join(vsHome, "runner", "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: now }), "utf8");
  const writeAgent = ({ id, title, lane, ord, status = "idle", ts = now + 1000, resumable = false, tokens = 50_000 }) => {
    const evs = [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: REPO_ROOT, meta: { title, labels: { team: "vibesquad", lane, role: "lead", ...(ord ? { ord: String(ord) } : {}) } } },
      { seq: 1, ts, type: "status", status },
      { seq: 2, ts, type: "usage", contextTokens: tokens },
      ...(resumable ? [{ seq: 3, ts, type: "session", sessionId: `sess-${id}` }] : []),
    ];
    writeFileSync(join(agentsDir, `${id}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  };
  const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k)));
  const runVs = (args) =>
    spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...baseEnv(), VIBESQUAD_HOME: vsHome, PASEO_HOME: paseoHome, VIBESQUAD_PORT: "1" },
    });
  return { dir, vsHome, agentsDir, now, writeAgent, runVs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("vs who lead: returns winner (exit 0) and flags older stale leads instead of CONFLICT; never mutates disk", () => {
  const env = makeCliEnv();
  try {
    env.writeAgent({ id: "rn-d992e1291fac", title: "Usage Lead", lane: "usage", ord: "1", ts: env.now - 60_000, resumable: true, tokens: 121_000 });
    env.writeAgent({ id: "rn-6ee72cadc349", title: "Usage Lead", lane: "usage", ord: "2", ts: env.now + 1_000, tokens: 123_000 });
    env.writeAgent({ id: "rn-964d9f3967e5", title: "★ Usa6", lane: "usage", ord: "6", ts: env.now + 2_000, tokens: 84_000 });

    const beforeOld = readFileSync(join(env.agentsDir, "rn-6ee72cadc349.jsonl"), "utf8");

    const textRes = env.runVs(["who", "lead", "--lane", "usage"]);
    assert.equal(textRes.status, 0, textRes.stdout + textRes.stderr);
    assert.doesNotMatch(textRes.stdout, /CONFLICT/);
    assert.match(textRes.stdout, /★ Usa6 · rn-964d9f3967e5 · idle · 84k · stale: Usage Lead \(rn-6ee72cadc349\)/);
    assert.doesNotMatch(textRes.stdout, /rn-d992e1291fac/, "lost lead is not shown");

    const jsonRes = env.runVs(["who", "lead", "--lane", "usage", "--json"]);
    assert.equal(jsonRes.status, 0);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].id, "rn-964d9f3967e5");
    assert.deepEqual(parsed.entries[0].staleLeads, ["rn-6ee72cadc349"]);

    const afterOld = readFileSync(join(env.agentsDir, "rn-6ee72cadc349.jsonl"), "utf8");
    assert.equal(afterOld, beforeOld, "vs who lead must not auto-retire on lookup");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Unit 2 — Retire path: retirePredecessors, lead-handoff, vs lead retire
// ---------------------------------------------------------------------------

test("retirePredecessors (agent-duties.ts): retires closed+resumable (lost) and older active predecessors while deferring only the pending handoff-from lead", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "vs-stale-lead-plugin-"));
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(vsHome, { recursive: true });
  const teamsFile = join(vsHome, "teams.json");
  writeFileSync(
    teamsFile,
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: ["VibeSquad"],
          lanes: [{ id: "usage", name: "Usage" }],
        },
      ],
    }),
    "utf8",
  );
  const prev = {
    VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
    VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
  };
  process.env.VIBESQUAD_HOME = vsHome;
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;

  try {
    const agents = new Map([
      [
        "rn-d992e1291fac",
        {
          id: "rn-d992e1291fac",
          title: "Usage Lead",
          status: "closed",
          resumable: true,
          lost: true,
          createdAt: "2026-11-05T19:33:13.997Z",
          cwd: REPO_ROOT,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "1" },
        },
      ],
      [
        "rn-dead",
        {
          id: "rn-dead",
          title: "Dead Lead",
          status: "closed",
          resumable: false,
          createdAt: "2026-11-05T18:00:00.000Z",
          cwd: REPO_ROOT,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "1" },
        },
      ],
      [
        "rn-6ee72cadc349",
        {
          id: "rn-6ee72cadc349",
          title: "Usage Lead",
          status: "idle",
          createdAt: "2026-11-07T02:27:47.372Z",
          cwd: REPO_ROOT,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "2" },
        },
      ],
      [
        "rn-usa5",
        {
          id: "rn-usa5",
          title: "★ Usa5",
          status: "idle",
          createdAt: "2026-11-09T01:00:00.000Z",
          cwd: REPO_ROOT,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "5" },
        },
      ],
      [
        "rn-964d9f3967e5",
        {
          id: "rn-964d9f3967e5",
          title: "★ Usa6",
          status: "running",
          createdAt: "2026-11-09T20:10:07.619Z",
          cwd: REPO_ROOT,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "6", "vs.handoff-from": "rn-usa5" },
        },
      ],
    ]);

    const onHandlers = new Map();
    const labelUpdates = [];
    const server = {
      before() { return () => {}; },
      on(event, fn) { onHandlers.set(event, fn); return () => onHandlers.delete(event); },
    };
    const stop = createPlugin({
      startWatcher: false,
      setLabels: async (agentId, labels, name) => {
        labelUpdates.push({ agentId, labels, name });
        const a = agents.get(agentId);
        if (a) {
          a.labels = { ...a.labels, ...labels };
          if (name) a.title = name;
        }
      },
    })(server);

    const paseo = {
      agents: {
        ref(id) {
          return {
            async refresh() {
              const a = agents.get(id);
              return a ? { agent: a } : null;
            },
            async update() {},
          };
        },
        async list() {
          return { entries: [...agents.values()].map((agent) => ({ agent })) };
        },
      },
    };

    await onHandlers.get("agent.created")({ agent: agents.get("rn-964d9f3967e5") }, { paseo });
    await new Promise((r) => setTimeout(r, 30));
    stop();

    // Closed+resumable ord 1 and idle ord 2 are retired immediately; dead unresumable is untouched; immediate handoff-from ord 5 waits for confirmTakeover.
    assert.equal(agents.get("rn-d992e1291fac").labels.role, "former-lead");
    assert.equal(agents.get("rn-d992e1291fac").title, "(old) Usa1");
    assert.equal(agents.get("rn-6ee72cadc349").labels.role, "former-lead");
    assert.equal(agents.get("rn-6ee72cadc349").title, "(old) Usa2");
    assert.equal(agents.get("rn-usa5").labels.role, "lead", "immediate handoff-from predecessor waits for takeover confirmation");
    assert.equal(labelUpdates.some((u) => u.agentId === "rn-dead"), false, "dead unresumable agent is already retired and not mutated");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lead-handoff spawnSuccessor and confirmTakeover sweep any earlier stale/lost leads in the lane", async () => {
  resetLeadHandoffState();
  const dir = mkdtempSync(join(os.tmpdir(), "vs-stale-handoff-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(vsHome, { recursive: true });
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(
    join(dir, "teams.json"),
    JSON.stringify({
      teams: [{ id: "vibesquad", name: "VibeSquad", paths: ["vibesquad"], lanes: [{ id: "usage", name: "Usage" }] }],
    }),
    "utf8",
  );
  seedDefaultPack(profilesPath);

  try {
    const agents = new Map([
      [
        "rn-d992e1291fac",
        {
          id: "rn-d992e1291fac",
          title: "Usage Lead",
          status: "closed",
          resumable: true,
          lost: true,
          cwd: dir,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "1" },
        },
      ],
      [
        "rn-6ee72cadc349",
        {
          id: "rn-6ee72cadc349",
          title: "Usage Lead",
          status: "idle",
          cwd: dir,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "2" },
        },
      ],
      [
        "rn-usa5",
        {
          id: "rn-usa5",
          title: "★ Usa5",
          status: "idle",
          cwd: dir,
          labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "5", profile: "Lead - Claude" },
        },
      ],
    ]);

    const coord = createLeadHandoffCoordinator({
      rootDir: dir,
      baseHome: vsHome,
      profilesPath,
      listAgents: async () => [...agents.values()],
      getAgent: async (id) => agents.get(id) ?? null,
      setLabels: async (id, labels, name) => {
        const a = agents.get(id);
        if (a) {
          a.labels = { ...a.labels, ...labels };
          if (name) a.title = name;
        }
      },
      createAgent: async (p) => {
        const a = { id: "rn-964d9f3967e5", title: p.config.title, status: "idle", cwd: dir, labels: { ...p.labels } };
        agents.set(a.id, a);
        return a;
      },
      sendMessage: async () => {},
      deleteHeartbeat: async () => {},
    });

    // Spawn with pending confirmation (retireImmediately: false), then confirmTakeover:
    const spawned = await coord.spawnSuccessor({ oldLead: agents.get("rn-usa5"), trigger: "auto-250", retireImmediately: false });
    assert.equal(spawned.successorId, "rn-964d9f3967e5");
    const confirmed = await coord.confirmTakeover("rn-964d9f3967e5");
    assert.equal(confirmed.confirmed, true);

    assert.equal(agents.get("rn-usa5").labels.role, "former-lead");
    assert.equal(agents.get("rn-usa5").title, "(old) Usa5");
    assert.equal(agents.get("rn-6ee72cadc349").labels.role, "former-lead");
    assert.equal(agents.get("rn-6ee72cadc349").title, "(old) Usa2");
    assert.equal(agents.get("rn-d992e1291fac").labels.role, "former-lead");
    assert.equal(agents.get("rn-d992e1291fac").title, "(old) Usa1");
    assert.equal(agents.get("rn-964d9f3967e5").labels.role, "lead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vs lead retire [--lane <code>]: retires stale and lost leads in usage, perfection, and ui-bois, enforces auth gates, and refuses genuine conflicts", async () => {
  resetLeadHandoffState();
  const dir = mkdtempSync(join(os.tmpdir(), "vs-lead-retire-verb-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(vsHome, { recursive: true });
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  const teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      paths: ["vibesquad"],
      lanes: [
        { id: "vibesquad", name: "VibeSquad", hub: true },
        { id: "usage", name: "Usage" },
        { id: "perfection", name: "Perfection" },
        { id: "ui-bois", name: "UI Bois" },
      ],
    },
    {
      id: "other-squad",
      name: "Other Squad",
      paths: ["other"],
      lanes: [{ id: "other-hub", name: "Other Hub", hub: true }],
    },
  ];
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams }), "utf8");
  writeFileSync(join(vsHome, "local-token"), "b".repeat(64) + "\n", "utf8");
  seedDefaultPack(profilesPath);
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = vsHome;

  try {
    const agents = new Map([
      // Hub Overlord + worker + cross-squad Overlord
      ["rn-overlord", { id: "rn-overlord", title: "Overlord", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "9" } }],
      ["rn-worker", { id: "rn-worker", title: "Bug9 · worker", status: "running", cwd: dir, labels: { team: "vibesquad", lane: "usage", role: "worker" } }],
      ["rn-other-overlord", { id: "rn-other-overlord", title: "Overlord", status: "idle", cwd: dir, labels: { team: "other-squad", lane: "other-hub", role: "lead", ord: "1" } }],
      // usage snapshot
      ["rn-d992e1291fac", { id: "rn-d992e1291fac", title: "Usage Lead", status: "closed", resumable: true, lost: true, cwd: dir, labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "1" } }],
      ["rn-6ee72cadc349", { id: "rn-6ee72cadc349", title: "Usage Lead", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "2" } }],
      ["rn-964d9f3967e5", { id: "rn-964d9f3967e5", title: "★ Usa6", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "usage", role: "lead", ord: "6" } }],
      // perfection snapshot
      ["rn-56366e8af537", { id: "rn-56366e8af537", title: "★ Per2", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "perfection", role: "lead", ord: "2" } }],
      ["rn-d7f089ad47de", { id: "rn-d7f089ad47de", title: "★ Per9", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "perfection", role: "lead", ord: "9" } }],
      // ui-bois snapshot
      ["rn-0548b8c562f3", { id: "rn-0548b8c562f3", title: "Lead - Claude · UI3 rail menu clip", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "1", job: "UI3 rail menu clip" } }],
      ["rn-8b6f27961453", { id: "rn-8b6f27961453", title: "Lead - Claude · UI4 floor P3 + squads P4", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "2", job: "UI4 floor P3 + squads P4" } }],
      ["rn-dadb20d85aae", { id: "rn-dadb20d85aae", title: "★ UI4", status: "closed", resumable: true, lost: true, cwd: dir, labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "4" } }],
      ["rn-b175b82bf389", { id: "rn-b175b82bf389", title: "★ UI13", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "ui-bois", role: "lead", ord: "13" } }],
    ]);

    const backend = {
      async fetchAgents() { return { entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }; },
      async fetchAgent(id) { return { agent: agents.get(id) ?? null }; },
      async updateAgent(id, { name, labels }) {
        const a = agents.get(id);
        if (a) {
          a.labels = { ...a.labels, ...labels };
          if (name) a.title = name;
        }
      },
      async deleteHeartbeat() {},
    };

    const makeCtx = (opts = {}) => {
      const c = createContext({
        teams,
        withBackend: async (_o, fn) => fn(backend),
        ...opts,
        ...(opts.identity?.agentId ? verifiedIdentity(opts.identity, { backend, teams }) : {}),
      });
      c.performHandoff = (body) => performLeadHandoffHttp({ ...body, agentClient: backend, baseHome: vsHome, profilesPath }, dir, { agentsForTest: [...agents.values()] });
      return c;
    };

    // 1. Worker is refused
    const workerCtx = makeCtx({ identity: { agentId: "rn-worker", team: "vibesquad", lane: "usage", role: "worker" } });
    await assert.rejects(callTool(workerCtx, "handoff_lead", { action: "retire", lane: "usage" }), /only the owner, a brainstorm \(Buddy\) or a lead/);

    // 2. Stale non-winner lead in the lane is refused from retiring its lane
    const staleLeadCtx = makeCtx({ identity: { agentId: "rn-6ee72cadc349", team: "vibesquad", lane: "usage", role: "lead" } });
    await assert.rejects(callTool(staleLeadCtx, "handoff_lead", { action: "retire" }), /not the active lead/);

    // 3. Cross-Squad Overlord is refused
    const otherOverlordCtx = makeCtx({ identity: { agentId: "rn-other-overlord", team: "other-squad", lane: "other-hub", role: "lead" } });
    await assert.rejects(callTool(otherOverlordCtx, "handoff_lead", { action: "retire", lane: "usage" }), /not in the caller's Squad/);

    // 4. Squad Overlord retires stale leads in `usage` (via CLI `vs lead retire --lane usage`)
    const overlordCtx = makeCtx({ identity: { agentId: "rn-overlord", team: "vibesquad", lane: "vibesquad", role: "lead" } });
    let out = "";
    const code = await commandAgentVerb("lead", { _: ["retire"], lane: "usage" }, () => overlordCtx, (s) => { out += s; });
    assert.equal(code, 0);
    const usageRes = JSON.parse(out);
    assert.equal(usageRes.id, "rn-964d9f3967e5");
    assert.deepEqual(usageRes.retiredIds.sort(), ["rn-6ee72cadc349", "rn-d992e1291fac"]);
    assert.equal(agents.get("rn-964d9f3967e5").labels.role, "lead");
    assert.equal(agents.get("rn-6ee72cadc349").labels.role, "former-lead");
    assert.equal(agents.get("rn-6ee72cadc349").title, "(old) Usa2");
    assert.equal(agents.get("rn-d992e1291fac").labels.role, "former-lead");
    assert.equal(agents.get("rn-d992e1291fac").title, "(old) Usa1");

    // 5. Active winner lead in `perfection` retires its own lane's stale lead
    const perWinnerCtx = makeCtx({ identity: { agentId: "rn-d7f089ad47de", team: "vibesquad", lane: "perfection", role: "lead" } });
    const perRes = await callTool(perWinnerCtx, "handoff_lead", { action: "retire" });
    assert.equal(perRes.id, "rn-d7f089ad47de");
    assert.deepEqual(perRes.retiredIds, ["rn-56366e8af537"]);
    assert.equal(agents.get("rn-56366e8af537").labels.role, "former-lead");
    assert.equal(agents.get("rn-56366e8af537").title, "(old) Per2");

    // 6. Owner (no agentId, local token present) retires stale leads in `ui-bois` (including @uip / code alias)
    const ownerCtx = makeCtx({ identity: { agentId: "", team: "vibesquad", lane: "vibesquad", role: "" } });
    const uiRes = await callTool(ownerCtx, "handoff_lead", { action: "retire", lane: "ui-bois" });
    assert.equal(uiRes.id, "rn-b175b82bf389");
    assert.deepEqual(uiRes.retiredIds.sort(), ["rn-0548b8c562f3", "rn-8b6f27961453", "rn-dadb20d85aae"]);
    assert.equal(agents.get("rn-b175b82bf389").labels.role, "lead");
    assert.equal(agents.get("rn-0548b8c562f3").labels.role, "former-lead");
    assert.equal(agents.get("rn-0548b8c562f3").title, "(old) UI1 · UI3 rail menu clip");
    assert.equal(agents.get("rn-8b6f27961453").labels.role, "former-lead");
    assert.equal(agents.get("rn-8b6f27961453").title, "(old) UI2 · UI4 floor P3 + squads P4");
    assert.equal(agents.get("rn-dadb20d85aae").labels.role, "former-lead");
    assert.equal(agents.get("rn-dadb20d85aae").title, "(old) UI4");

    // 7. Genuine conflict (two equally-new ★ Per9 leads) refuses to auto-retire
    agents.set("rn-per9-dup", { id: "rn-per9-dup", title: "★ Per9", status: "idle", cwd: dir, labels: { team: "vibesquad", lane: "perfection", role: "lead", ord: "9" } });
    await assert.rejects(callTool(ownerCtx, "handoff_lead", { action: "retire", lane: "perfection" }), /ambiguous/);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

