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

const TEAMS = [{ id: "site", name: "example.dev", paths: ["example.dev"], lanes: [{ id: "site-polish", name: "Site Polish" }, { id: "other", name: "Other" }, { id: "fresh", name: "Fresh" }, { id: "site-hub", name: "Hub", hub: true }] },
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
  add("rn-lead-fresh", "lead", { lane: "fresh", ord: "1" }); // idea-95: a new lane with a lead and no Buddy yet
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

test("route: a denied callerId is 403 and spends no archive/spawn budget slot", async () => {
  const { createServer } = await import("node:http");
  const { createVibesquadMiddleware, archiveBudget, spawnBudget, ARCHIVE_BUDGET_PER_MIN, SPAWN_BUDGET_PER_MIN } = await import("../server/vibesquad-api.mjs");
  const { ownerHeaders } = await import("./helpers/local-owner.mjs");
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  const srv = createServer(createVibesquadMiddleware(t.dir));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    archiveBudget.reset();
    spawnBudget.reset();
    const total = Math.max(ARCHIVE_BUDGET_PER_MIN, SPAWN_BUDGET_PER_MIN) + 3;
    for (let i = 0; i < total; i++) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/__vibesquad/brainstorm-restart`, {
        method: "POST",
        headers: ownerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ agentId: "rn-buddy", laneId: "site-polish", teamId: "site", reason: "x", callerId: "rn-nobody" }),
      });
      assert.equal(r.status, 403, `call ${i}`);
    }
    for (let i = 0; i < ARCHIVE_BUDGET_PER_MIN; i++) assert.ok(archiveBudget.take(), `archive slot ${i} still free`);
    for (let i = 0; i < SPAWN_BUDGET_PER_MIN; i++) assert.ok(spawnBudget.take(), `spawn slot ${i} still free`);
  } finally {
    archiveBudget.reset();
    spawnBudget.reset();
    await new Promise((r) => srv.close(r));
    t.cleanup();
  }
});

test("pre-auth: a non-lead callerId is refused for a missing target, empty agentId and start-brainstorm, and spends no budget", async () => {
  const { createServer } = await import("node:http");
  const { createVibesquadMiddleware, archiveBudget, spawnBudget, ARCHIVE_BUDGET_PER_MIN, SPAWN_BUDGET_PER_MIN } = await import("../server/vibesquad-api.mjs");
  const { ownerHeaders } = await import("./helpers/local-owner.mjs");
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  const srv = createServer(createVibesquadMiddleware(t.dir));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    archiveBudget.reset();
    spawnBudget.reset();
    const bodies = [
      { callerId: "rn-nobody", agentId: "rn-nonexistent" },
      { callerId: "rn-nobody", agentId: "" },
      { callerId: "rn-nobody", agentId: "start-brainstorm", laneId: "site-polish", teamId: "site" },
      { callerId: "rn-nobody", reason: "start-brainstorm", laneId: "site-polish", teamId: "site" },
    ];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/__vibesquad/brainstorm-restart`, {
        method: "POST", headers: ownerHeaders({ "content-type": "application/json" }), body: JSON.stringify(bodies[i % bodies.length]),
      });
      assert.equal(r.status, 403, `call ${i}`);
    }
    for (let i = 0; i < ARCHIVE_BUDGET_PER_MIN; i++) assert.ok(archiveBudget.take(), `archive slot ${i}`);
    for (let i = 0; i < SPAWN_BUDGET_PER_MIN; i++) assert.ok(spawnBudget.take(), `spawn slot ${i}`);
  } finally {
    archiveBudget.reset(); spawnBudget.reset();
    await new Promise((r) => srv.close(r));
    t.cleanup();
  }
  // And directly: a live lead naming start-brainstorm / a missing target / no agentId is refused too.
  const u = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    // idea-95: start-brainstorm with a callerId is allowed now, but only for a lane the caller may restart (rn-lead: site-polish only).
    for (const extra of [{ agentId: "start-brainstorm", laneId: "other" }, { agentId: "rn-nonexistent" }, { agentId: "" }, { agentId: "rn-lead" }]) {
      await assert.rejects(performBrainstormRestart({ callerId: "rn-lead", laneId: "site-polish", teamId: "site", agentClient: u.backend, baseHome: u.vsHome, profilesPath: u.profilesPath, ...extra }, u.dir), (e) => e.status === 403, JSON.stringify(extra));
    }
    assert.equal(u.calls.createAgent.length, 0);
  } finally { u.cleanup(); }
});

test("a shared @<code> lane handle resolves inside the caller's own (non-primary) Squad", async () => {
  const SHARED = [{ id: "first", name: "First", paths: ["first"], lanes: [{ id: "first-chaser", name: "First Chaser", code: "bug" }, { id: "first-hub", name: "Hub", hub: true }] },
    { id: "second", name: "Second", paths: ["second"], lanes: [{ id: "second-chaser", name: "Second Chaser", code: "bug" }, { id: "second-hub", name: "Hub", hub: true }] }];
  const mk = (id, role, lane) => ({ id, title: id, status: "idle", createdAt: "2026-11-01T00:00:00.000Z", labels: { team: "second", lane, role } });
  const agents = [mk("rn-s-hub", "lead", "second-hub"), mk("rn-s-bug-buddy", "brainstorm", "second-chaser"), mk("rn-s-bug-lead", "lead", "second-chaser")];
  const backend = { async fetchAgents() { return { entries: agents.map((agent) => ({ agent })) }; }, async fetchAgent(id) { return { agent: agents.find((a) => a.id === id) ?? null }; } };
  const sent = [];
  for (const [callerId, lane] of [["rn-s-hub", "second-hub"], ["rn-s-bug-lead", "second-chaser"]]) {
    const ctx = createContext({ identity: { agentId: callerId, team: "second", lane, role: "lead" }, teams: SHARED, withBackend: async (_o, fn) => fn(backend) });
    ctx.restartBuddyRequest = async (b) => { sent.push(b); return { ok: true, newAgentId: "rn-new" }; };
    const r = await callTool(ctx, "restart_buddy", { lane: "@bug" });
    assert.equal(r.team, "second");
    assert.equal(r.lane, "second-chaser");
  }
  assert.equal(sent.length, 2);
});

test("CLI: main() parses --reason and --steer (no unknown-option error)", async () => {
  const { main } = await import("../cli/vs.mjs");
  const errs = [];
  const prevEnv = { v: process.env.VS_AGENT_ID, p: process.env.PASEO_AGENT_ID };
  delete process.env.VS_AGENT_ID; delete process.env.PASEO_AGENT_ID; // the suite may run inside an agent; the owner path is the CLI case here
  const orig = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    // A lane that is not in any registry fails deterministically before any backend call (a rejected promise, not a parse error).
    for (const argv of [["buddy", "restart", "--lane", "no-such-lane-zz", "--reason", "context full"], ["lead", "handoff", "--lane", "no-such-lane-zz", "--steer", "note"]]) {
      const code = await Promise.resolve(main(argv)).catch((e) => { errs.push(`Error: ${e.message}`); return 1; });
      assert.notEqual(code, 0);
    }
  } finally {
    process.stderr.write = orig;
    if (prevEnv.v !== undefined) process.env.VS_AGENT_ID = prevEnv.v;
    if (prevEnv.p !== undefined) process.env.PASEO_AGENT_ID = prevEnv.p;
  }
  const text = errs.join("");
  assert.ok(!/unknown option/.test(text), text);
  assert.match(text, /not in the team registry/);
});

// idea-95: no agent verb could start a NEW lane's FIRST Buddy (`vs pin new` makes the lane, restart refused "has no live Buddy").
// restart_buddy now starts one through the same start-brainstorm path the UI's first pin click uses.
const startBody = (lane, callerId, extra = {}) => ({ agentId: "start-brainstorm", reason: "start-brainstorm", laneId: lane, teamId: "site", ...(callerId ? { callerId } : {}), ...extra });
// Wire the tool to the real route function (in-process, fake backend), as the VS server would.
const wireRoute = (t) => { t.ctx.restartBuddyRequest = (body) => { t.sent.push(body); return performBrainstormRestart({ ...body, agentClient: t.backend, baseHome: t.vsHome, profilesPath: t.profilesPath, backstopDelayMs: 0 }, t.dir); }; };
const freshBuddies = (t) => [...t.agents.values()].filter((x) => x.labels?.role === "brainstorm" && x.labels?.lane === "fresh" && !x.archivedAt);

test("first Buddy: a lane lead with no Buddy in its lane starts one (start-brainstorm path), role=brainstorm + its lane/team", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead-fresh", lane: "fresh" });
  wireRoute(t);
  try {
    const r = await callTool(t.ctx, "restart_buddy", { reason: "new lane" });
    assert.deepEqual(t.sent, [startBody("fresh", "rn-lead-fresh")]);
    assert.equal(r.started, true);
    assert.equal(r.oldBuddyId, "");
    assert.equal(r.lane, "fresh");
    assert.equal(r.team, "site");
    assert.equal(r.trigger, "lane-lead");
    assert.equal(t.calls.createAgent.length, 1);
    const labels = t.calls.createAgent[0].labels;
    assert.equal(labels.role, "brainstorm");
    assert.equal(labels.lane, "fresh");
    assert.equal(labels.team, "site");
    assert.equal(r.id, freshBuddies(t)[0]?.id);
    assert.equal(t.calls.archive.length, 0);
  } finally { t.cleanup(); }
});

test("first Buddy: the Squad's Overlord and the owner may start one in any lane of the Squad", async () => {
  for (const [callerId, lane, trigger] of [["rn-hub-lead", "site-hub", "overlord"], ["", "", "owner"]]) {
    const t = setup({ callerRole: callerId ? "lead" : "", callerId, lane });
    wireRoute(t);
    try {
      const r = await callTool(t.ctx, "restart_buddy", { lane: "fresh" });
      assert.deepEqual(t.sent, [startBody("fresh", callerId)], trigger);
      assert.equal(r.trigger, trigger);
      assert.equal(r.started, true);
      assert.equal(t.calls.createAgent.length, 1, trigger);
      assert.equal(t.calls.createAgent[0].labels.role, "brainstorm");
      assert.equal(t.calls.createAgent[0].labels.lane, "fresh");
    } finally { t.cleanup(); }
  }
});

test("first Buddy: an existing live Buddy is still restarted, never a second start", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    const r = await callTool(t.ctx, "restart_buddy", {});
    assert.equal(r.started, undefined);
    assert.equal(r.oldBuddyId, "rn-buddy");
    assert.deepEqual(t.sent, [{ agentId: "rn-buddy", laneId: "site-polish", teamId: "site", reason: "buddy-restart-verb", callerId: "rn-lead" }]);
  } finally { t.cleanup(); }
});

test("first Buddy: workers, Buddies, other lanes' leads and other Squads' Overlords are refused (tool and route)", async () => {
  for (const [callerId, lane, team, re] of [
    ["rn-worker", "site-polish", "site", /is not a live lead/],
    ["rn-buddy", "site-polish", "site", /is not a live lead/],
    ["rn-lead", "site-polish", "site", /only restart its own lane's Buddy/],
    ["rn-oth-hub-lead", "oth-hub", "oth", /another Squad/],
  ]) {
    const t = setup({ callerRole: "lead", callerId, lane, team });
    wireRoute(t);
    try {
      await assert.rejects(callTool(t.ctx, "restart_buddy", { lane: "fresh" }), re, callerId);
      assert.equal(t.sent.length, 0, callerId);
      await assert.rejects(performBrainstormRestart({ ...startBody("fresh", callerId), agentClient: t.backend, baseHome: t.vsHome, profilesPath: t.profilesPath }, t.dir), (e) => e.status === 403, callerId);
      assert.equal(t.calls.createAgent.length, 0, callerId);
    } finally { t.cleanup(); }
  }
});

test("first Buddy: a route call can't aim a lead's start outside its grant (unknown/empty lane, forceNew)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead-fresh", lane: "fresh" });
  try {
    for (const extra of [{ laneId: "no-such-lane" }, { laneId: "" }, { forceNew: true }]) {
      await assert.rejects(performBrainstormRestart({ ...startBody("fresh", "rn-lead-fresh"), ...extra, agentClient: t.backend, baseHome: t.vsHome, profilesPath: t.profilesPath }, t.dir), (e) => e.status === 403, JSON.stringify(extra));
    }
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
});

test("first Buddy: two concurrent restart_buddy calls start exactly one Buddy", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead-fresh", lane: "fresh" });
  wireRoute(t);
  try {
    const [a, b] = await Promise.all([callTool(t.ctx, "restart_buddy", {}), callTool(t.ctx, "restart_buddy", {})]);
    assert.equal(t.calls.createAgent.length, 1);
    assert.ok(a.id);
    assert.equal(a.id, b.id);
    assert.equal(freshBuddies(t).length, 1);
  } finally { t.cleanup(); }
});

test("first Buddy: --profile / --provider pick the Buddy's brainstorm profile", async () => {
  for (const [args, want] of [[{ profile: "Brainstorm - Gemini" }, "Brainstorm - Gemini"], [{ provider: "gemini" }, "Brainstorm - Gemini"], [{ provider: "claude" }, "Brainstorm - Claude"]]) {
    const t = setup({ callerRole: "lead", callerId: "rn-lead-fresh", lane: "fresh" });
    wireRoute(t);
    try {
      await callTool(t.ctx, "restart_buddy", args);
      assert.equal(t.sent[0].profileName, want, JSON.stringify(args));
      assert.equal(t.calls.createAgent[0].labels.profile, want, JSON.stringify(args));
    } finally { t.cleanup(); }
  }
  const t = setup({ callerRole: "lead", callerId: "rn-lead-fresh", lane: "fresh" });
  try {
    await assert.rejects(callTool(t.ctx, "restart_buddy", { provider: "nope" }), /provider/);
    assert.equal(t.sent.length, 0);
  } finally { t.cleanup(); }
});

test("vs buddy restart: CLI passes --profile / --provider through", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead-fresh", lane: "fresh" });
  try {
    await commandAgentVerb("buddy", { _: ["restart"], lane: "fresh", provider: "gemini" }, () => t.ctx, () => {});
    assert.equal(t.sent[0].profileName, "Brainstorm - Gemini");
    assert.equal(t.sent[0].agentId, "start-brainstorm");
  } finally { t.cleanup(); }
});
