// O5: `vs buddy restart --lane <x>` / restart_buddy over the existing brainstorm-restart path. Fake in-memory backend, temp VIBESQUAD_HOME.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDefaultPack } from "../server/profiles.mjs";
import { performBrainstormRestart } from "../server/brainstorm.mjs";
import { callTool, createContext, VS_TOOLS } from "../server/mcp/tools.mjs";
import { commandAgentVerb } from "../cli/vs.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const TEAMS = [{ id: "site", name: "example.dev", paths: ["example.dev"], lanes: [{ id: "site-polish", name: "Site Polish" }, { id: "other", name: "Other" }, { id: "site-hub", name: "Hub", hub: true }] },
  { id: "oth", name: "oth.dev", paths: ["oth.dev"], lanes: [{ id: "oth-main", name: "Oth Main" }, { id: "oth-hub", name: "Oth Hub", hub: true }] }];

function setup({ callerRole, callerId, lane = "site-polish", team = "site" }) {
  const dir = mkdtempSync(join(tmpdir(), "vs-buddy-restart-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
  seedDefaultPack(profilesPath);
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = vsHome;
  const agents = new Map();
  const add = (id, role, labels = {}, over = {}) => agents.set(id, { id, title: id, provider: "claude", model: "claude-opus-5-5", cwd: dir, status: "idle", createdAt: "2026-11-01T00:00:00.000Z", labels: { team: "site", lane: "site-polish", role, ...labels }, ...over });
  add("rn-lead", "lead", { ord: "3" });
  add("rn-lead-b", "lead", { lane: "other", ord: "1" });
  add("rn-worker", "worker", { "vs.parent": "rn-lead" }, { status: "running" });
  add("rn-buddy", "brainstorm");
  add("rn-buddy-b", "brainstorm", { lane: "other" });
  add("rn-buddy-topic", "brainstorm", { lane: "other", topic: "t" });
  add("rn-hub-lead", "lead", { lane: "site-hub", ord: "1" });
  add("rn-oth-hub-lead", "lead", { team: "oth", lane: "oth-hub", ord: "1" });
  add("rn-old-lead", "former-lead", { ord: "2" });
  add("rn-closed-lead", "lead", { lane: "site-polish", ord: "9" }, { status: "closed" });
  const calls = { createAgent: [], archive: [] };
  let n = 0;
  const backend = {
    async fetchAgents() { return { entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }; },
    async fetchAgent(id) { return { agent: agents.get(id) ?? null }; },
    async updateAgent(id, { name, labels }) { const a = agents.get(id); if (a) { a.labels = { ...a.labels, ...labels }; if (name) a.title = name; } },
    async archiveAgent(id) { calls.archive.push(id); const a = agents.get(id); if (a) a.archivedAt = new Date().toISOString(); },
    async cancelAgent() {},
    async sendAgentPrompt() {},
    async createAgent(p) { calls.createAgent.push(p); const id = `rn-buddy-new-${++n}`; const a = { id, title: p.config?.title ?? id, status: "running", createdAt: new Date().toISOString(), cwd: dir, labels: { ...p.labels } }; agents.set(id, a); return a; },
  };
  const sent = [];
  const identity = { agentId: callerId, team, lane, role: callerRole };
  const ctx = createContext({ identity, teams: TEAMS, withBackend: async (_o, fn) => fn(backend) });
  ctx.restartBuddyRequest = async (body) => { sent.push(body); return { ok: true, newAgentId: "rn-buddy-new", title: "New Buddy" }; };
  return { ctx, agents, backend, calls, sent, dir, vsHome, profilesPath, cleanup() { if (prevHome === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); } };
}

test("restart_buddy is a listed tool", () => { assert.ok(VS_TOOLS.restart_buddy); });

test("allow: a lane's live lead restarts its own lane's Buddy (no --lane = own lane)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    const r = await callTool(t.ctx, "restart_buddy", { reason: "context full" });
    assert.equal(r.oldBuddyId, "rn-buddy");
    assert.equal(r.trigger, "lane-lead");
    assert.deepEqual(t.sent, [{ agentId: "rn-buddy", laneId: "site-polish", teamId: "site", reason: "buddy-restart-verb: context full", callerId: "rn-lead" }]);
    await callTool(t.ctx, "restart_buddy", { lane: "site-polish" });
    assert.equal(t.sent.length, 2);
  } finally { t.cleanup(); }
});

test("allow: the Squad's Overlord restarts another lane's Buddy in its own Squad", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-hub-lead", lane: "site-hub" });
  try {
    const r = await callTool(t.ctx, "restart_buddy", { lane: "other" });
    assert.equal(r.oldBuddyId, "rn-buddy-b");
    assert.equal(r.trigger, "overlord");
    assert.equal(t.sent[0].callerId, "rn-hub-lead");
    assert.equal(t.sent[0].laneId, "other");
  } finally { t.cleanup(); }
});

test("a reason can't impersonate the route's special reasons (start-brainstorm / auto*)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await callTool(t.ctx, "restart_buddy", { reason: "start-brainstorm" });
    assert.equal(t.sent[0].reason, "buddy-restart-verb: start-brainstorm");
  } finally { t.cleanup(); }
});

test("deny: worker, Buddy, retired lead, closed lead", async () => {
  for (const [id, role] of [["rn-worker", "worker"], ["rn-buddy", "brainstorm"], ["rn-old-lead", "lead"], ["rn-closed-lead", "lead"]]) {
    const t = setup({ callerRole: role, callerId: id });
    try {
      await assert.rejects(callTool(t.ctx, "restart_buddy", {}), /is not a live lead/, id);
      assert.equal(t.sent.length, 0);
    } finally { t.cleanup(); }
  }
});

test("deny: another lane's lead (named lane and the hub lane)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(callTool(t.ctx, "restart_buddy", { lane: "other" }), /only restart its own lane's Buddy/);
    await assert.rejects(callTool(t.ctx, "restart_buddy", { lane: "site-hub" }), /only restart its own lane's Buddy/);
    assert.equal(t.sent.length, 0);
  } finally { t.cleanup(); }
});

test("deny: another Squad's Overlord", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-oth-hub-lead", lane: "oth-hub", team: "oth" });
  try {
    await assert.rejects(callTool(t.ctx, "restart_buddy", { lane: "site-polish" }), /another Squad/);
    assert.equal(t.sent.length, 0);
  } finally { t.cleanup(); }
});

test("deny: env/identity-spoofed lane and team never grant anything (the runner record decides)", async () => {
  // rn-lead is a plain site-polish lead whose process env claims to be a hub lead.
  for (const spoof of [{ team: "site", lane: "site-hub" }, { team: "oth", lane: "oth-hub" }]) {
    const t = setup({ callerRole: "lead", callerId: "rn-lead", ...spoof });
    try {
      await assert.rejects(callTool(t.ctx, "restart_buddy", { lane: "other" }), /only restart its own lane's Buddy/);
      assert.equal(t.sent.length, 0);
    } finally { t.cleanup(); }
  }
  // A worker claiming role=lead in env is still refused from its record.
  const t = setup({ callerRole: "lead", callerId: "rn-worker", lane: "site-hub" });
  try {
    await assert.rejects(callTool(t.ctx, "restart_buddy", { lane: "other" }), /is not a live lead/);
  } finally { t.cleanup(); }
});

test("owner path (no agent id) restarts any lane and posts no callerId; --lane is required", async () => {
  const t = setup({ callerRole: "", callerId: "" });
  try {
    await assert.rejects(callTool(t.ctx, "restart_buddy", {}), /--lane is required/);
    const r = await callTool(t.ctx, "restart_buddy", { lane: "other" });
    assert.equal(r.trigger, "owner");
    assert.equal(t.sent[0].callerId, undefined);
    assert.equal(t.sent[0].agentId, "rn-buddy-b");
  } finally { t.cleanup(); }
});

test("route layer: a direct call with a forged callerId is refused before anything is archived or spawned", async () => {
  for (const callerId of ["rn-worker", "rn-lead-b", "rn-oth-hub-lead", "rn-buddy", "rn-old-lead", "rn-missing"]) {
    const t = setup({ callerRole: "lead", callerId: "rn-lead" });
    try {
      await assert.rejects(
        performBrainstormRestart({ agentId: "rn-buddy", laneId: "site-polish", teamId: "site", reason: "x", callerId, agentClient: t.backend, baseHome: t.vsHome, profilesPath: t.profilesPath }, t.dir),
        (e) => e.status === 403 && /forbidden/.test(e.message),
        callerId,
      );
      assert.equal(t.calls.createAgent.length, 0, callerId);
      assert.equal(t.calls.archive.length, 0, callerId);
    } finally { t.cleanup(); }
  }
});

test("route layer: lane lead and same-Squad Overlord pass the callerId check; no callerId (owner) is unchanged", async () => {
  for (const [callerId, agentId] of [["rn-lead", "rn-buddy"], ["rn-hub-lead", "rn-buddy-b"], [undefined, "rn-buddy-topic"]]) {
    const t = setup({ callerRole: "lead", callerId: "rn-lead" });
    try {
      const r = await performBrainstormRestart({ agentId, reason: "x", ...(callerId ? { callerId } : {}), agentClient: t.backend, baseHome: t.vsHome, profilesPath: t.profilesPath }, t.dir);
      assert.equal(r.ok, true, String(callerId));
      assert.ok(r.newAgentId, String(callerId));
      assert.equal(t.calls.createAgent.length, 1, String(callerId));
    } finally { t.cleanup(); }
  }
});

test("vs buddy restart: CLI usage errors", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    const makeContext = () => t.ctx;
    await assert.rejects(commandAgentVerb("buddy", { _: ["restart"] }, makeContext, () => {}), /usage: vs buddy restart/);
    await assert.rejects(commandAgentVerb("buddy", { _: ["nope"], lane: "x" }, makeContext, () => {}), /usage: vs buddy restart/);
  } finally { t.cleanup(); }
});
