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

const TEAMS = [{ id: "site", name: "example.dev", paths: ["example.dev"], lanes: [{ id: "site-polish", name: "Site Polish" }, { id: "other", name: "Other" }, { id: "site-hub", name: "Hub", hub: true }, { id: "empty", name: "Empty" }] },
  { id: "oth", name: "oth.dev", paths: ["oth.dev"], lanes: [{ id: "oth-main", name: "Oth Main" }, { id: "oth-hub", name: "Oth Hub", hub: true }] }];

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
  if (!agents.has("rn-buddy")) add("rn-buddy", "brainstorm");
  add("rn-buddy-b", "brainstorm", { labels: { lane: "other" } });
  add("rn-hub-lead", "lead", { labels: { lane: "site-hub", ord: "1" } });
  add("rn-hub-buddy", "brainstorm", { labels: { lane: "site-hub" } });
  add("rn-oth-lead", "lead", { labels: { team: "oth", lane: "oth-main" } });
  add("rn-oth-hub-lead", "lead", { labels: { team: "oth", lane: "oth-hub", ord: "1" } });
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
  const deps = { agentClient: backend, baseHome: vsHome, profilesPath };
  return { ctx, makeCtx, behavior, agents, calls, deps, dir, vsHome, cleanup() { if (prevHome === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); } };
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

test("fetch rejects with ECONNREFUSED: in-process fallback runs on the injected backend and says so", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const c = t.makeCtx({ identity: t.ctx.identity });
    delete c.performHandoff;
    c.inProcessDeps = t.deps;
    c.fetch = async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const r = await callTool(c, "handoff_lead", {});
    assert.equal(r.id, "rn-succ-1");
    assert.match(r.via, /in-process/);
    assert.equal(t.calls.createAgent.length, 1);
  } finally { t.cleanup(); }
});

test("env spoof: a runner record with role=worker plus VS_ROLE=brainstorm is refused", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  const env = { VS_AGENT_ID: "rn-spoof", VS_ROLE: "brainstorm", VS_TEAM: "site", VS_LANE: "site-polish" };
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  delete process.env.PASEO_AGENT_ID;
  try {
    const dir = join(t.vsHome, "runner", "agents");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    writeFileSync(join(dir, "rn-spoof.jsonl"), [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: t.dir, meta: { title: "spoof", labels: { team: "site", lane: "site-polish", role: "worker" } } },
      { seq: 1, ts, type: "status", status: "idle" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const seen = [];
    const makeContext = (opts) => { seen.push(opts.identity); return t.makeCtx(opts); };
    await assert.rejects(commandAgentVerb("lead", { _: ["handoff"] }, makeContext, () => {}), /only a brainstorm \(Buddy\) or a lead may/);
    assert.equal(seen[0].role, "worker");
    assert.equal(t.calls.createAgent.length, 0);
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    t.cleanup();
  }
});

test("server re-check: buddy from another lane and a mismatched self callerId both get 403", async () => {
  const t = setup({ callerRole: "brainstorm", callerId: "rn-buddy" });
  try {
    const run = (extra) => performLeadHandoffHttp({ agentId: "rn-lead", retireImmediately: true, ...t.deps, ...extra }, t.dir);
    await assert.rejects(run({ trigger: "buddy", callerId: "rn-buddy-b" }), (e) => e.status === 403);
    await assert.rejects(run({ trigger: "buddy", callerId: "rn-worker" }), (e) => e.status === 403);
    await assert.rejects(run({ trigger: "self", callerId: "rn-buddy" }), (e) => e.status === 403);
    assert.equal(t.calls.createAgent.length, 0);
    const ok = await run({ trigger: "buddy", callerId: "rn-buddy" });
    assert.equal(ok.ok !== false, true);
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

// O2: the Squad's hub lead (Overlord) acts across lanes of its own Squad.
const overlord = (over = {}) => setup({ callerRole: "lead", callerId: "rn-hub-lead", lane: "site-hub", ...over });
const spawnLead = (ctx, extra = {}) => callTool(ctx, "spawn_worker", { title: "L", profile: "Lead - Claude", prompt: "lead", labels: { role: "lead" }, ...extra });

test("Overlord can hand off another lane's lead in its Squad; steer reaches the successor prompt (trigger overlord)", async () => {
  const t = overlord();
  try {
    const r = await callTool(t.ctx, "handoff_lead", { lane: "other", steer: "stop refactoring, finish the PR" });
    assert.equal(r.trigger, "overlord");
    assert.equal(r.oldLeadId, "rn-lead-b");
    const succ = t.agents.get(r.id);
    assert.equal(succ.labels["vs.handoff-trigger"], "overlord");
    assert.equal(succ.labels.lane, "other");
    assert.equal(t.agents.get("rn-lead-b").labels.role, "former-lead");
    assert.equal(t.agents.get("rn-hub-lead").labels.role, "lead");
    assert.match(t.calls.createAgent[0].initialPrompt, /BEGIN OVERLORD STEER ---\nstop refactoring, finish the PR\n--- END OVERLORD STEER/);
  } finally { t.cleanup(); }
});

test("Overlord handoff needs a lane, a same-Squad lane with a live lead; steer is ignored for non-overlord triggers", async () => {
  const t = overlord();
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { id: "rn-lead" }), /must name the target lane/);
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "oth-main" }), /not in the caller's Squad/);
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "empty" }), /no live lead/);
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "other", id: "rn-lead" }), /not the live lead of lane/);
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
  const s = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await callTool(s.ctx, "handoff_lead", { steer: "ignored" });
    assert.doesNotMatch(s.calls.createAgent[0].initialPrompt, /OVERLORD STEER/);
  } finally { s.cleanup(); }
});

test("a non-hub lead (and another Squad's hub lead) cannot hand off another lane", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "other", steer: "x" }), /only hand off itself/);
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
  const o = setup({ callerRole: "lead", callerId: "rn-oth-hub-lead", lane: "oth-hub" });
  o.ctx.identity.team = "oth";
  try {
    await assert.rejects(callTool(o.ctx, "handoff_lead", { lane: "other" }), /not in the caller's Squad/);
    assert.equal(o.calls.createAgent.length, 0);
  } finally { o.cleanup(); }
});

test("Overlord env spoof: a worker record claiming role=lead on the hub lane is refused", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-worker", lane: "site-hub" });
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "other" }), /not a live lead/);
    await assert.rejects(spawnLead(t.ctx, { labels: { role: "lead", lane: "empty" } }), /per its agent record/);
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
});

test("server re-check: overlord trigger needs a callerId that is a live hub lead of the lead's Squad", async () => {
  const t = overlord();
  try {
    const run = (extra) => performLeadHandoffHttp({ agentId: "rn-lead-b", retireImmediately: true, trigger: "overlord", ...t.deps, ...extra }, t.dir);
    await assert.rejects(run({}), (e) => e.status === 403);
    await assert.rejects(run({ callerId: "rn-lead" }), (e) => e.status === 403); // non-hub lead
    await assert.rejects(run({ callerId: "rn-buddy" }), (e) => e.status === 403);
    await assert.rejects(run({ callerId: "rn-hub-buddy" }), (e) => e.status === 403);
    await assert.rejects(run({ callerId: "rn-oth-hub-lead" }), (e) => e.status === 403); // other Squad's hub lead
    assert.equal(t.calls.createAgent.length, 0);
    const ok = await run({ callerId: "rn-hub-lead", steer: "go" });
    assert.equal(ok.ok !== false, true);
    assert.equal(t.calls.createAgent.length, 1);
  } finally { t.cleanup(); }
});

test("Overlord can spawn a lead in a leaderless same-Squad lane; refused with a live lead or another Squad", async () => {
  const t = overlord();
  try {
    const r = await spawnLead(t.ctx, { labels: { role: "lead", lane: "empty" } });
    assert.ok(r.id);
    const req = t.calls.createAgent[0];
    assert.deepEqual([req.labels.role, req.labels.lane, req.labels.team, req.labels.lead], ["lead", "empty", "site", "empty"]);
    assert.equal(req.env.VS_LANE, "empty");
    await assert.rejects(spawnLead(t.ctx, { labels: { role: "lead", lane: "other" } }), /already has a live lead \(rn-lead-b\)/);
    await assert.rejects(spawnLead(t.ctx, { labels: { role: "lead", lane: "oth-main" } }), /not in the caller's Squad/);
    await assert.rejects(spawnLead(t.ctx, { labels: { role: "lead", lane: "empty", team: "oth" } }), /not the caller's team/);
    await assert.rejects(spawnLead(t.ctx, { profile: "Implement - Sonnet", labels: { role: "lead", lane: "empty" } }), /not a "Lead - " profile/);
    assert.equal(t.calls.createAgent.length, 1);
  } finally { t.cleanup(); }
});

test("a non-hub lead cannot spawn a lead; hub Buddy may spawn only the hub's own Overlord", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(spawnLead(t.ctx, { labels: { role: "lead", lane: "empty" } }), /non-hub lane/);
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
  const b = setup({ callerRole: "brainstorm", callerId: "rn-hub-buddy", lane: "site-hub" });
  try {
    await assert.rejects(spawnLead(b.ctx, { labels: { role: "lead", lane: "empty" } }), /not the caller's lane/);
    await assert.rejects(spawnLead(b.ctx), /already has a live lead \(rn-hub-lead\)/);
    b.agents.get("rn-hub-lead").labels.role = "former-lead";
    const r = await spawnLead(b.ctx);
    assert.ok(r.id);
    const req = b.calls.createAgent[0];
    assert.deepEqual([req.labels.role, req.labels.lane, req.labels.team], ["lead", "site-hub", "site"]);
  } finally { b.cleanup(); }
});

// O2 review fixes: caller lane/team come from the record, no self/own-lane overlord, double-call dedupe.
test("env spoof: a non-hub lead or another Squad's hub lead claiming the hub via VS_LANE/VS_TEAM cannot hand off another lane", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead", lane: "site-hub" }); // record lane = site-polish
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "other" }), /only hand off itself/);
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
  const o = setup({ callerRole: "lead", callerId: "rn-oth-hub-lead", lane: "site-hub" }); // record: team oth / oth-hub
  o.ctx.identity.team = "site";
  try {
    await assert.rejects(callTool(o.ctx, "handoff_lead", { lane: "other" }), /not in the caller's Squad/);
    assert.equal(o.calls.createAgent.length, 0);
  } finally { o.cleanup(); }
});

test("overlord trigger refuses itself and its own lane (tool and server), and a target lane outside the caller's Squad", async () => {
  const t = overlord();
  try {
    await assert.rejects(callTool(t.ctx, "handoff_lead", { lane: "site-hub", id: "rn-lead" }), /not the live lead|other lanes/);
    const run = (extra) => performLeadHandoffHttp({ retireImmediately: true, trigger: "overlord", callerId: "rn-hub-lead", ...t.deps, ...extra }, t.dir);
    await assert.rejects(run({ agentId: "rn-hub-lead" }), (e) => e.status === 403);
    await assert.rejects(run({ agentId: "rn-oth-lead" }), (e) => e.status === 403);
    assert.equal(t.calls.createAgent.length, 0);
  } finally { t.cleanup(); }
});

test("a double Overlord handoff returns the fresh successor instead of handing off again", async () => {
  const t = overlord();
  try {
    const a = await callTool(t.ctx, "handoff_lead", { lane: "other" });
    const b = await callTool(t.ctx, "handoff_lead", { lane: "other" });
    assert.equal(b.id, a.id);
    assert.equal(b.deduped, true);
    assert.equal(t.calls.createAgent.length, 1);
  } finally { t.cleanup(); }
});
