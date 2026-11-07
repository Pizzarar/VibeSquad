// H1: handoff_lead MCP tool / `vs lead handoff` over the existing lead-handoff flow. Fake in-memory backend, temp VIBESQUAD_HOME, never the real runner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDefaultPack } from "../server/profiles.mjs";
import { performLeadHandoffHttp, resetLeadHandoffState } from "../server/lead-handoff.mjs";
import { callTool, createContext, VS_TOOLS } from "../server/mcp/tools.mjs";
import { runAgentVerb } from "../cli/vs.mjs";

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
  const calls = { createAgent: [], updateAgent: [] };
  const backend = {
    async fetchAgents() { return { entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }; },
    async fetchAgent(id) { return { agent: agents.get(id) ?? null }; },
    async updateAgent(id, { name, labels }) { calls.updateAgent.push({ id, labels }); const a = agents.get(id); if (a) { a.labels = { ...a.labels, ...labels }; if (name) a.title = name; } },
    async sendAgentPrompt() {},
    async createAgent(p) { calls.createAgent.push(p); const id = `rn-succ-${++n}`; const a = { id, title: p.config.title, status: "running", createdAt: new Date().toISOString(), cwd: dir, labels: { ...p.labels } }; agents.set(id, a); return a; },
    async deleteHeartbeat() {},
  };
  const identity = { agentId: callerId, team: "site", lane, role: callerRole };
  const ctx = createContext({ identity, teams: TEAMS, withBackend: async (_o, fn) => fn(backend) });
  ctx.performHandoff = (body) => performLeadHandoffHttp({ ...body, agentClient: backend, baseHome: vsHome, profilesPath }, dir);
  return { ctx, agents, calls, cleanup() { if (prevHome === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); } };
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

test("vs lead handoff goes through the same tool", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const r = await runAgentVerb("handoff_lead", { _: [] }, t.ctx);
    assert.equal(r.id, "rn-succ-1");
    await assert.rejects(runAgentVerb("handoff_lead", { _: [], lane: "other" }, t.ctx), /not the caller's lane/);
  } finally { t.cleanup(); }
});
