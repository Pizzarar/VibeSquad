// H1: handoff_lead MCP tool / `vs lead handoff` over the existing lead-handoff flow. Fake in-memory backend, temp VIBESQUAD_HOME, never the real runner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDefaultPack } from "../server/profiles.mjs";
import { performLeadHandoffHttp, resetLeadHandoffState } from "../server/lead-handoff.mjs";
import { callTool, createContext, VS_TOOLS } from "../server/mcp/tools.mjs";
import { commandAgentVerb, runAgentVerb } from "../cli/vs.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const TEAMS = [{ id: "site", name: "example.dev", paths: ["example.dev"], lanes: [{ id: "site-polish", name: "Site Polish" }, { id: "other", name: "Other" }] }];

function setup({ callerRole, callerId, lane = "site-polish" }) {
  resetLeadHandoffState();
  const dir = mkdtempSync(join(tmpdir(), "vs-successor-verb-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
  seedDefaultPack(profilesPath);
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = vsHome;
  const mk = (id, role, over = {}) => ({ id, title: id, provider: "claude", model: "claude-opus-5-5", cwd: dir, status: "idle", createdAt: "2026-11-01T00:00:00.000Z",
    labels: { team: "site", lane: "site-polish", role, ...(role === "lead" ? { ord: "3", profile: "Lead - Claude" } : {}), ...(over.labels ?? {}) }, ...over, ...{ labels: undefined } });
  const agents = new Map();
  const add = (id, role, over = {}) => { const a = mk(id, role, over); a.labels = { team: "site", lane: "site-polish", role, ...(role === "lead" ? { ord: "3", profile: "Lead - Claude" } : {}), ...(over.labels ?? {}) }; agents.set(id, a); return a; };
  add("rn-lead", "lead");
  add("rn-lead-b", "lead", { labels: { lane: "other" } });
  add("rn-worker", "worker", { status: "running", labels: { "vs.parent": "rn-lead" } });
  let n = 0;
  const behavior = { createAgent: null };
  const calls = { createAgent: [], updateAgent: [] };
  const backend = {
    async fetchAgents() { return { entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }; },
    async fetchAgent(id) { return { agent: agents.get(id) ?? null }; },
    async updateAgent(id, { name, labels }) { calls.updateAgent.push({ id, labels }); const a = agents.get(id); if (a) { a.labels = { ...a.labels, ...labels }; if (name) a.title = name; } },
    async sendAgentPrompt() {},
    async createAgent(p) { calls.createAgent.push(p); if (behavior.createAgent === "throw") throw new Error("spawn exploded"); if (behavior.createAgent === "null") return null; const id = `rn-succ-${++n}`; const a = { id, title: p.config.title, status: "running", createdAt: new Date().toISOString(), cwd: dir, labels: { ...p.labels } }; agents.set(id, a); return a; },
    async deleteHeartbeat() {},
  };
  const identity = { agentId: callerId, team: "site", lane, role: callerRole };
  const makeCtx = (opts) => {
    const c = createContext({ teams: TEAMS, withBackend: async (_o, fn) => fn(backend), ...opts });
    c.performHandoff = (body) => performLeadHandoffHttp({ ...body, agentClient: backend, baseHome: vsHome, profilesPath }, dir);
    return c;
  };
  const ctx = makeCtx({ identity });
  return { ctx, makeCtx, behavior, agents, calls, cleanup() { if (prevHome === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); } };
}

const liveLeads = async (ctx) => (await ctx.findLiveLeads({ team: "site", lane: "site-polish" })).map((a) => a.id);

test("handoff_lead is a listed tool", () => {
  assert.ok(VS_TOOLS.handoff_lead);
});

test("Buddy on its own lane: successor spawned, old lead relabelled former-lead, vs who lead = successor", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    assert.deepEqual(await liveLeads(t.ctx), ["rn-lead"]);
    const r = await callTool(t.ctx, "handoff_lead", {});
    assert.equal(r.id, "rn-succ-1");
    assert.equal(r.oldLeadId, "rn-lead");
    assert.ok(r.title);
    assert.equal(t.agents.get("rn-lead").labels.role, "former-lead");
    assert.equal(t.agents.get("rn-succ-1").labels["vs.handoff-trigger"], "buddy");
    assert.equal(t.agents.get("rn-worker").labels["vs.parent"], "rn-succ-1");
    assert.deepEqual(await liveLeads(t.ctx), ["rn-succ-1"]);
  } finally { t.cleanup(); }
});

test("Buddy on another lane is refused", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "other" }), /not the caller's lane/);
    await assert.rejects(callTool(t.ctx, "handoff_lead", { id: "rn-lead-b" }), /not the live lead/);
    assert.equal(t.calls.createAgent.length, 0);
    assert.equal(t.agents.get("rn-lead-b").labels.role, "lead");
  } finally { t.cleanup(); }
});

test("lead on itself is ok (trigger self); lead on another lead is refused", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { id: "rn-lead-b" }), /only hand off itself/);
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "other" }), /only hand off itself/);
    assert.equal(t.calls.createAgent.length, 0);
    const r = await callTool(t.ctx, "handoff_lead", {});
    assert.equal(r.id, "rn-succ-1");
    assert.equal(r.oldLeadId, "rn-lead");
    assert.equal(t.agents.get("rn-succ-1").labels["vs.handoff-trigger"], "self");
    assert.equal(t.agents.get("rn-lead").labels.role, "former-lead");
    assert.deepEqual(await liveLeads(t.ctx), ["rn-succ-1"]);
  } finally { t.cleanup(); }
});

test("worker (and unknown role) is refused", async () => {
  for (const role of ["worker", ""]) {
    const t = setup({ callerRole: role, callerId: "rn-worker" });
    try {
      await assert.rejects(callTool(t.ctx, "handoff_lead", {}), /only a brainstorm \(Buddy\) or a lead may/, role);
      assert.equal(t.calls.createAgent.length, 0);
    } finally { t.cleanup(); }
  }
});

test("double call gives one successor (Buddy twice, and the old lead calling again)", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const a = await callTool(t.ctx, "handoff_lead", {});
    const b = await callTool(t.ctx, "handoff_lead", {});
    assert.equal(b.id, a.id);
    assert.equal(b.deduped, true);
    assert.equal(t.calls.createAgent.length, 1);
    // The retired lead retrying hands back the same successor.
    const oldCtx = createContext({ identity: { agentId: "rn-lead", team: "site", lane: "site-polish", role: "lead" }, teams: TEAMS, withBackend: t.ctx.withBackend });
    oldCtx.performHandoff = t.ctx.performHandoff;
    const c = await callTool(oldCtx, "handoff_lead", {});
    assert.equal(c.id, a.id);
    assert.equal(t.calls.createAgent.length, 1);
  } finally { t.cleanup(); }
});

test("vs lead handoff: --lane/--role/--team/--agent flags cannot spoof the caller (commandAgentVerb)", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  const saved = {};
  const env = { VS_AGENT_ID: "rn-buddy", VS_ROLE: "brainstorm", VS_TEAM: "site", VS_LANE: "site-polish" };
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  delete process.env.PASEO_AGENT_ID;
  const seen = [];
  const makeContext = (opts) => { seen.push(opts.identity); return t.makeCtx(opts); };
  const quiet = () => {};
  try {
    await assert.rejects(commandAgentVerb("lead", { _: ["handoff"], lane: "other" }, makeContext, quiet), /not the caller's lane/);
    await assert.rejects(commandAgentVerb("lead", { _: ["handoff"], lane: "other", role: "lead", team: "site", agent: "rn-lead-b" }, makeContext, quiet), /not the caller's lane/);
    for (const id of seen) { assert.equal(id.role, "brainstorm"); assert.equal(id.lane, "site-polish"); assert.equal(id.agentId, "rn-buddy"); }
    assert.equal(t.calls.createAgent.length, 0);
    assert.equal(t.agents.get("rn-lead-b").labels.role, "lead");
    let printed = "";
    assert.equal(await commandAgentVerb("lead", { _: ["handoff"], role: "lead" }, makeContext, (s) => { printed += s; }), 0);
    assert.equal(JSON.parse(printed).id, "rn-succ-1");
    assert.equal(seen.at(-1).role, "brainstorm");
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    t.cleanup();
  }
});

test("createAgent throws: old lead stays live and a retry spawns", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    t.behavior.createAgent = "throw";
    await assert.rejects(callTool(t.ctx, "handoff_lead", {}), /spawn exploded/);
    assert.equal(t.agents.get("rn-lead").labels.role, "lead");
    assert.deepEqual(await liveLeads(t.ctx), ["rn-lead"]);
    t.behavior.createAgent = null;
    const r = await callTool(t.ctx, "handoff_lead", {});
    assert.equal(r.id, "rn-succ-1");
    assert.equal(t.calls.createAgent.length, 2);
    // The lead's own self handoff rolls back the same way.
    const s = setup({ callerRole: "lead", callerId: "rn-lead" });
    try {
      s.behavior.createAgent = "throw";
      await assert.rejects(callTool(s.ctx, "handoff_lead", {}), /spawn exploded/);
      s.behavior.createAgent = null;
      assert.equal((await callTool(s.ctx, "handoff_lead", {})).id, "rn-succ-1");
    } finally { s.cleanup(); }
  } finally { t.cleanup(); }
});

test("createAgent returns null: error, old lead still role=lead, workers not re-parented", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    t.behavior.createAgent = "null";
    await assert.rejects(callTool(t.ctx, "handoff_lead", {}), /no agent id/);
    assert.equal(t.agents.get("rn-lead").labels.role, "lead");
    assert.equal(t.agents.get("rn-lead").labels["handoff-successor"], undefined);
    assert.equal(t.agents.get("rn-worker").labels["vs.parent"], "rn-lead");
    assert.deepEqual(await liveLeads(t.ctx), ["rn-lead"]);
  } finally { t.cleanup(); }
});

test("explicit id bypasses the 10-minute fresh-successor window", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const a = await callTool(t.ctx, "handoff_lead", {});
    assert.equal(a.id, "rn-succ-1");
    assert.equal((await callTool(t.ctx, "handoff_lead", {})).deduped, true);
    assert.equal(t.calls.createAgent.length, 1);
    const c = await callTool(t.ctx, "handoff_lead", { id: "rn-succ-1" });
    assert.notEqual(c.deduped, true);
    assert.equal(c.oldLeadId, "rn-succ-1");
    assert.equal(t.calls.createAgent.length, 2);
  } finally { t.cleanup(); }
});

test("retired-lead dedupe returns the successor's real title", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const a = await callTool(t.ctx, "handoff_lead", {});
    const oldCtx = t.makeCtx({ identity: { agentId: "rn-lead", team: "site", lane: "site-polish", role: "lead" } });
    const c = await callTool(oldCtx, "handoff_lead", {});
    assert.equal(c.id, a.id);
    assert.equal(c.title, t.agents.get(a.id).title);
    assert.ok(c.title);
  } finally { t.cleanup(); }
});

test("lead self branch is refused when its lane is empty or not in the registry", async () => {
  for (const lane of ["", "ghost-lane"]) {
    const t = setup({ callerRole: "lead", callerId: "rn-lead", lane });
    try {
      await assert.rejects(callTool(t.ctx, "handoff_lead", {}), /no lane|not in the team registry/, lane);
      assert.equal(t.calls.createAgent.length, 0);
      assert.equal(t.agents.get("rn-lead").labels.role, "lead");
    } finally { t.cleanup(); }
  }
});

test("handoff goes through the VS server endpoint, falling back in-process only when unreachable", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const c = t.makeCtx({ identity: t.ctx.identity });
    delete c.performHandoff;
    const urls = [];
    c.fetch = async (url, init) => { urls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, successorId: "rn-srv-1", title: "srv", oldLeadId: "rn-lead" }) }; };
    const r = await callTool(c, "handoff_lead", {});
    assert.equal(r.id, "rn-srv-1");
    assert.equal(r.via, "server");
    assert.match(urls[0][0], /\/__vibesquad\/lead-handoff$/);
    assert.equal(urls[0][1].agentId, "rn-lead");
    // A server-side refusal is an error, never a silent in-process retry.
    c.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: "nope" }) });
    await assert.rejects(callTool(c, "handoff_lead", {}), /handoff failed: nope/);
  } finally { t.cleanup(); }
});

test("vs lead handoff goes through the same tool", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const r = await runAgentVerb("handoff_lead", { _: [] }, t.ctx);
    assert.equal(r.id, "rn-succ-1");
    await assert.rejects(runAgentVerb("handoff_lead", { _: [], lane: "other" }, t.ctx), /not the caller's lane/);
  } finally { t.cleanup(); }
});
