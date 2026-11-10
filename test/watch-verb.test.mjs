// W2: `vs watch add <agent...> [--suite] [--restart] [--stall <min>]` / list / cancel + the MCP `watch` tool, over the injected
// watch-set registry (server/watch-sets.mjs, W1). Fake in-memory backend + fake watchSets; never the real runner or registry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, createContext, VS_TOOLS } from "../server/mcp/tools.mjs";
import { commandAgentVerb, runAgentVerb } from "../cli/vs.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const TEAMS = [
  { id: "site", name: "example.dev", paths: ["example.dev"], lanes: [{ id: "site-polish", name: "Site Polish" }, { id: "other", name: "Other" }, { id: "site-hub", name: "Hub", hub: true }] },
  { id: "oth", name: "oth.dev", paths: ["oth.dev"], lanes: [{ id: "oth-main", name: "Oth Main" }, { id: "oth-hub", name: "Oth Hub", hub: true }] },
];

function setup({ callerRole, callerId, lane = "site-polish", team = "site" }) {
  const dir = mkdtempSync(join(tmpdir(), "vs-watch-verb-"));
  const vsHome = join(dir, ".vibesquad");
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = vsHome;
  const agents = new Map();
  const add = (id, role, labels = {}, over = {}) => agents.set(id, { id, title: id, provider: "claude", model: "claude-opus-5-5", cwd: dir, status: "idle", createdAt: "2026-11-01T00:00:00.000Z", labels: { team: "site", lane: "site-polish", role, ...labels }, ...over });
  add("rn-lead", "lead", { ord: "3" });
  add("rn-lead-b", "lead", { lane: "other", ord: "1" });
  add("rn-worker", "worker", { "vs.parent": "rn-lead" }, { status: "running" });
  add("rn-buddy", "brainstorm");
  add("rn-hub-lead", "lead", { lane: "site-hub", ord: "1" });
  add("rn-oth-lead", "lead", { team: "oth", lane: "oth-main" });
  add("rn-oth-hub-lead", "lead", { team: "oth", lane: "oth-hub", ord: "1" });
  add("rn-old-lead", "former-lead", { ord: "2" });
  add("rn-closed-lead", "lead", { lane: "site-polish", ord: "9" }, { status: "closed" });
  add("rn-digest", "digest");
  const backend = {
    async fetchAgents() { return { entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }; },
    async fetchAgent(id) { return { agent: agents.get(id) ?? null }; },
  };
  const watchCalls = { add: [], list: [], cancel: [] };
  const identity = { agentId: callerId, team, lane, role: callerRole };
  const ctx = createContext({ identity, teams: TEAMS, withBackend: async (_o, fn) => fn(backend) });
  ctx.watchSets = {
    async addWatch(p) { watchCalls.add.push(p); return { id: "w-1" }; },
    async listWatches(opts) { watchCalls.list.push(opts); return [{ id: "w-1", owner: opts.owner ?? "", team: opts.team ?? "" }]; },
    async cancelWatch(id, caller) { watchCalls.cancel.push({ id, caller }); return { id, cancelled: true }; },
  };
  return { ctx, agents, watchCalls, dir, vsHome, cleanup() { if (prevHome === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); } };
}

test("watch is a listed tool with the right schema", () => {
  const t = VS_TOOLS.watch;
  assert.ok(t);
  assert.deepEqual(t.inputSchema.required, ["action"]);
  assert.deepEqual(t.inputSchema.properties.action, { type: "string", enum: ["add", "list", "cancel"] });
  assert.equal(t.inputSchema.properties.suite.type, "boolean");
  assert.equal(t.inputSchema.properties.restart.type, "boolean");
  assert.equal(t.inputSchema.properties.stallMin.type, "number");
  assert.equal(t.inputSchema.properties.owner.type, "string");
  assert.deepEqual(t.inputSchema.properties.agents, { type: "array", items: { type: "string" } });
});

test("self ok: a lead registers agents + suite + restart for itself (owner, team, lane from its record)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    const r = await callTool(t.ctx, "watch", { action: "add", agents: ["rn-a", "rn-b"], suite: true, restart: true, stallMin: 20 });
    assert.deepEqual(r, { id: "w-1" });
    assert.equal(t.watchCalls.add.length, 1);
    assert.deepEqual(t.watchCalls.add[0], {
      owner: "rn-lead",
      team: "site",
      lane: "site-polish",
      items: [{ kind: "agent", ref: "rn-a" }, { kind: "agent", ref: "rn-b" }, { kind: "suite", ref: "" }, { kind: "restart", ref: "" }],
      stallMin: 20,
    });
  } finally { t.cleanup(); }
});

test("stallMin defaults to 15 and must be a positive number", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"] });
    assert.equal(t.watchCalls.add[0].stallMin, 15);
    for (const bad of [0, -1, "x", NaN, "0"]) {
      await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"], stallMin: bad }), /stallMin must be a positive number/);
    }
  } finally { t.cleanup(); }
});

test("worker is refused (also when its record role is worker and env claims lead)", async () => {
  for (const role of ["worker", "lead"]) {
    const t = setup({ callerRole: role, callerId: "rn-worker", lane: "site-hub" });
    try {
      await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"] }), /workers may not use the watch verb/, role);
      assert.equal(t.watchCalls.add.length, 0);
    } finally { t.cleanup(); }
  }
});

test("a plain lead cannot name a different owner; the same-Squad Overlord can (within its own Squad)", async () => {
  const lead = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(callTool(lead.ctx, "watch", { action: "add", agents: ["rn-a"], owner: "rn-lead-b" }), /only the same-Squad Overlord may set a different owner/);
    assert.equal(lead.watchCalls.add.length, 0);
  } finally { lead.cleanup(); }
  const ov = setup({ callerRole: "lead", callerId: "rn-hub-lead", lane: "site-hub" });
  try {
    const r = await callTool(ov.ctx, "watch", { action: "add", agents: ["rn-a"], owner: "rn-lead" });
    assert.deepEqual(r, { id: "w-1" });
    assert.equal(ov.watchCalls.add[0].owner, "rn-lead");
    assert.equal(ov.watchCalls.add[0].team, "site");
    assert.equal(ov.watchCalls.add[0].lane, "site-polish"); // the owner's lane, not the hub
  } finally { ov.cleanup(); }
});

test("another Squad's Overlord cannot name an owner outside its Squad; an unknown owner is refused", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-oth-hub-lead", lane: "oth-hub", team: "oth" });
  try {
    await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"], owner: "rn-lead" }), /only the same-Squad Overlord may set a different owner in its own Squad/);
    await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"], owner: "rn-nobody" }), /unknown agent/);
    assert.equal(t.watchCalls.add.length, 0);
  } finally { t.cleanup(); }
});

test("a non-hub lead cannot name a different owner", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead-b", lane: "other" });
  try {
    await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"], owner: "rn-lead" }), /only the same-Squad Overlord may set a different owner/);
    assert.equal(t.watchCalls.add.length, 0);
  } finally { t.cleanup(); }
});

test("a former-lead, closed lead and digest agent are refused even for themselves", async () => {
  for (const [id, lane, re] of [["rn-old-lead", "site-polish", /only a live lead or Buddy may use the watch verb/], ["rn-closed-lead", "site-polish", /only a live lead or Buddy may use the watch verb/], ["rn-digest", "site-polish", /workers may not use the watch verb/]]) {
    const t = setup({ callerRole: "lead", callerId: id, lane });
    try {
      await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"] }), re, id);
      assert.equal(t.watchCalls.add.length, 0);
    } finally { t.cleanup(); }
  }
});

test("a spoofed callerId/agentId in MCP args is ignored (the ctx identity decides)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" }); // a plain, non-hub lead
  try {
    await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a"], callerId: "rn-hub-lead", agentId: "rn-hub-lead", owner: "rn-lead-b" }), /only the same-Squad Overlord may set a different owner/);
    assert.equal(t.watchCalls.add.length, 0);
  } finally { t.cleanup(); }
});

test("CLI: --owner is forwarded (Overlord allowed, non-Overlord refused)", async () => {
  const ov = setup({ callerRole: "lead", callerId: "rn-hub-lead", lane: "site-hub" });
  try {
    await runAgentVerb("watch", { _: ["rn-a"], watchAction: "add", owner: "rn-lead" }, ov.ctx);
    assert.equal(ov.watchCalls.add[0].owner, "rn-lead");
    assert.equal(ov.watchCalls.add[0].lane, "site-polish");
  } finally { ov.cleanup(); }
  const plain = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(runAgentVerb("watch", { _: ["rn-a"], watchAction: "add", owner: "rn-lead-b" }, plain.ctx), /only the same-Squad Overlord may set a different owner/);
    assert.equal(plain.watchCalls.add.length, 0);
  } finally { plain.cleanup(); }
});

test("cancel passes the id and the caller id; list passes owner + team", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    const c = await callTool(t.ctx, "watch", { action: "cancel", id: "w-9" });
    assert.deepEqual(c, { id: "w-9", cancelled: true });
    assert.deepEqual(t.watchCalls.cancel[0], { id: "w-9", caller: "rn-lead" });
    await assert.rejects(callTool(t.ctx, "watch", { action: "cancel" }), /id is required/);
    await callTool(t.ctx, "watch", { action: "list" });
    assert.deepEqual(t.watchCalls.list[0], { owner: "rn-lead", team: "site" });
    await assert.rejects(callTool(t.ctx, "watch", { action: "bogus" }), /watch action must be one of: add, list, cancel/);
  } finally { t.cleanup(); }
});

test("a missing watch-sets module gives a clean 'watch sets unavailable' error, not a crash", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    delete t.ctx.watchSets;
    await assert.rejects(callTool(t.ctx, "watch", { action: "list" }), /watch sets unavailable/);
  } finally { t.cleanup(); }
});

test("CLI arg parsing: runAgentVerb maps --suite/--restart/--stall and positional agents", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    const r = await runAgentVerb("watch", { _: ["rn-a", "rn-b"], watchAction: "add", suite: true, restart: true, stall: "30" }, t.ctx);
    assert.deepEqual(r, { id: "w-1" });
    assert.deepEqual(t.watchCalls.add[0].items, [{ kind: "agent", ref: "rn-a" }, { kind: "agent", ref: "rn-b" }, { kind: "suite", ref: "" }, { kind: "restart", ref: "" }]);
    assert.equal(t.watchCalls.add[0].stallMin, 30);
  } finally { t.cleanup(); }
});

test("vs watch ls maps to list (no const-reassignment TypeError)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await commandAgentVerb("watch", { _: ["ls"] }, () => t.ctx, () => {});
    assert.equal(t.watchCalls.list.length, 1);
    assert.deepEqual(t.watchCalls.list[0], { owner: "rn-lead", team: "site" });
  } finally { t.cleanup(); }
});

test("non-rn agent ids are rejected (CLI + MCP)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["foo"] }), /runner ids/);
    await assert.rejects(callTool(t.ctx, "watch", { action: "add", agents: ["rn-a", "bar"] }), /runner ids.*got "bar"/);
    assert.equal(t.watchCalls.add.length, 0);
  } finally { t.cleanup(); }
  await assert.rejects(commandAgentVerb("watch", { _: ["add", "foo"] }, () => t.ctx, () => {}), /runner ids/);
});

test("duplicate agent ids are deduplicated (CLI + MCP)", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  try {
    await callTool(t.ctx, "watch", { action: "add", agents: ["rn-a", "rn-a", "rn-b"] });
    assert.deepEqual(t.watchCalls.add[0].items, [{ kind: "agent", ref: "rn-a" }, { kind: "agent", ref: "rn-b" }]);
    await runAgentVerb("watch", { _: ["rn-a", "rn-a"], watchAction: "add" }, t.ctx);
    assert.deepEqual(t.watchCalls.add[1].items, [{ kind: "agent", ref: "rn-a" }]);
  } finally { t.cleanup(); }
});

test("CLI usage errors are caught before any identity resolution", async () => {
  const t = setup({ callerRole: "lead", callerId: "rn-lead" });
  const makeContext = () => t.ctx;
  try {
    await assert.rejects(commandAgentVerb("watch", { _: [] }, makeContext, () => {}), /usage: vs watch add/);
    await assert.rejects(commandAgentVerb("watch", { _: ["bogus"] }, makeContext, () => {}), /usage: vs watch add/);
    await assert.rejects(commandAgentVerb("watch", { _: ["add"] }, makeContext, () => {}), /needs at least one agent/);
    await assert.rejects(commandAgentVerb("watch", { _: ["add", "rn-a"], stall: "0" }, makeContext, () => {}), /--stall must be a positive number/);
    await assert.rejects(commandAgentVerb("watch", { _: ["cancel"] }, makeContext, () => {}), /usage: vs watch cancel/);
  } finally { t.cleanup(); }
});

test("CLI: main() accepts --suite/--restart/--stall (no unknown-option error)", async () => {
  const { main } = await import("../cli/vs.mjs");
  const prevEnv = { v: process.env.VS_AGENT_ID, p: process.env.PASEO_AGENT_ID };
  delete process.env.VS_AGENT_ID; delete process.env.PASEO_AGENT_ID;
  const orig = process.stderr.write;
  const errs = [];
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    for (const argv of [
      ["watch", "add", "rn-a", "--suite", "--restart", "--stall", "10"],
      ["watch", "list"],
      ["watch", "cancel", "w-1"],
    ]) {
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
  assert.match(text, /workers may not use the watch verb/);
});
