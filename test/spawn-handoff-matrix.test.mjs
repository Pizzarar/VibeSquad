// PLAN_V03_STABILIZE S1: the spawn/handoff matrix. Every path that mints a lead or Buddy (Spin Up, Buddy restart, lead handoff
// self/auto, Buddy-spawns-lead, resume-in-place) runs against ONE in-memory fake backend, with double-click / concurrent and
// "create timed out but the agent exists" variants. After each scenario the roster must hold exactly one live lead (and one live
// Buddy) for the lane, by the same filter `vs who` uses (whoCandidate + resolveLeadWinner). No live runner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDefaultPack } from "../server/profiles.mjs";
import { createLeadHandoffCoordinator, resetLeadHandoffState } from "../server/lead-handoff.mjs";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { resolveLeadWinner, whoCandidate } from "../server/identity.mjs";
import { commandAgentVerb, resolveIdentity } from "../cli/vs.mjs";
import { tokenFor, verifiedIdentity } from "./helpers/agent-token.mjs";

process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "hub", name: "Hub", hub: true }] }];
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  resetLeadHandoffState();
  resetBrainstormRestartState();
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-matrix-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
  seedDefaultPack(profilesPath);
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = vsHome;
  let n = 0;
  const agents = new Map();
  // modes: queue of "ok" | "late" (agent is created, then the call times out) | "fail" (nothing created)
  const world = {
    agents, modes: [], creates: 0, dir, vsHome, profilesPath,
    seed(a) {
      const rec = { provider: "claude", model: "m", cwd: dir, status: "idle", createdAt: new Date(Date.now() - 3_600_000 + ++n).toISOString(), ...a, labels: { team: "mx", lane: "feat", ...(a.labels ?? {}) } };
      agents.set(rec.id, rec);
      return rec;
    },
    async createAgent(req) {
      world.creates++;
      const mode = world.modes.shift() ?? "ok";
      await tick();
      if (mode === "fail") throw new Error("spawn exploded");
      const id = `rn-${++n}`;
      const rec = { id, title: req.config?.title ?? req.title, provider: "claude", model: "m", cwd: req.config?.cwd ?? dir, status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), labels: { ...(req.labels ?? {}) } };
      agents.set(id, rec);
      if (mode === "late") throw new Error("agent.create.request timed out after 300000ms");
      return { ...rec, labels: { ...rec.labels } };
    },
    async fetchAgents() { return { entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent: { ...agent, labels: { ...agent.labels } } })) }; },
    async listAgents() { return world.fetchAgents(); },
    async fetchAgent(id) { const a = agents.get(id); if (!a) throw new Error(`agent ${id} not found`); return { agent: { ...a, labels: { ...a.labels } } }; },
    async updateAgent(id, { name, labels } = {}) { const a = agents.get(id); if (!a) return; if (name) a.title = name; if (labels) a.labels = { ...a.labels, ...labels }; },
    async archiveAgent(id) { const a = agents.get(id); if (a) a.archivedAt = new Date().toISOString(); },
    async cancelAgent() {},
    async sendAgentPrompt() {},
    async refreshAgent(id) {
      const a = agents.get(id);
      if (a.status === "closed" && a.resumable) { a.status = "idle"; a.resumable = false; world.resumes = (world.resumes ?? 0) + 1; }
      return { ...a };
    },
    live(role, lane = "feat") {
      return [...agents.values()].filter((a) => whoCandidate(a, { teams: TEAMS, wantTeamId: "mx", wantLane: lane })?.role === role);
    },
    /** `vs who <role>`: ok with exactly one entry, never conflict. */
    who(role, lane = "feat") {
      const { winner, conflict, pending } = resolveLeadWinner(world.live(role, lane));
      return { ids: world.live(role, lane).map((a) => a.id), winner: winner?.id ?? null, conflict, pending };
    },
    cleanup() {
      if (prevHome === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}

const oneLive = (w, role, msg) => {
  const r = w.who(role);
  assert.equal(r.conflict, false, `${msg}: vs who ${role} says CONFLICT (${r.ids})`);
  assert.equal(r.ids.length, 1, `${msg}: expected exactly one live ${role}, got [${r.ids}]`);
  return r.winner;
};

const lead = (w, over = {}) => w.seed({ id: "rn-lead1", title: "Lead 1", status: "idle", labels: { role: "lead", lead: "feat", ord: "1", profile: "Lead - Claude" }, ...over });
const buddy = (w, over = {}) => w.seed({ id: "rn-bud1", title: "Buddy", status: "idle", labels: { role: "brainstorm", lead: "feat" }, ...over });

function coordinator(w, over = {}) {
  return createLeadHandoffCoordinator({
    rootDir: w.dir, baseHome: () => w.vsHome, profilesPath: w.profilesPath, sharedSlots: false,
    listAgents: async () => (await w.fetchAgents()).entries.map((e) => e.agent),
    getAgent: async (id) => (await w.fetchAgent(id).catch(() => null))?.agent ?? null,
    setLabels: (id, labels, name) => w.updateAgent(id, { name, labels }),
    sendMessage: async () => {},
    deleteHeartbeat: async () => {},
    appendLog: () => {},
    createAgent: (p) => w.createAgent(p),
    ...over,
  });
}

const spinUp = (w, extra = {}) =>
  performBrainstormRestart({ agentId: "start-brainstorm", reason: "start-brainstorm", teamId: "mx", laneId: "feat", agentClient: w, backstopDelayMs: 0, emptyRetryMs: 0, ...extra }, w.dir);
const restart = (w, id, extra = {}) =>
  performBrainstormRestart({ agentId: id, reason: "manual", teamId: "mx", laneId: "feat", agentClient: w, backstopDelayMs: 0, ...extra }, w.dir);

// ---------------------------------------------------------------- Spin Up / pin-new first click (start-brainstorm)

test("Spin Up: one Buddy; a double-click shares one spawn; a later click reuses it", async () => {
  const w = setup();
  try {
    const [a, b] = await Promise.all([spinUp(w), spinUp(w)]);
    assert.equal(w.creates, 1, "double-click spawned once");
    assert.equal(a.newAgentId, b.newAgentId);
    const again = await spinUp(w);
    assert.equal(again.reused, true);
    assert.equal(w.creates, 1);
    await sleep(20);
    oneLive(w, "brainstorm", "after Spin Up");
  } finally { w.cleanup(); }
});

test("Spin Up: create times out but the agent exists -> retry ends with exactly one live Buddy", async () => {
  const w = setup();
  try {
    w.modes = ["late"];
    await assert.rejects(spinUp(w), /timed out/);
    const r = await spinUp(w);
    assert.equal(r.ok, true);
    await sleep(20);
    oneLive(w, "brainstorm", "after timeout + retry");
  } finally { w.cleanup(); }
});

test("Spin Up: a lost (closed, resumable) Buddy resumes in place with the same id; a dead one is replaced once", async () => {
  const w = setup();
  try {
    buddy(w, { status: "closed", resumable: true });
    const r = await spinUp(w);
    assert.equal(r.newAgentId, "rn-bud1");
    assert.equal(w.creates, 0, "resumed, not replaced");
    assert.equal(w.resumes, 1);
    oneLive(w, "brainstorm", "after resume-in-place");
  } finally { w.cleanup(); }
  const d = setup();
  try {
    buddy(d, { status: "closed", resumable: false });
    const r = await spinUp(d);
    assert.notEqual(r.newAgentId, "rn-bud1");
    assert.equal(d.creates, 1);
    await sleep(20);
    assert.equal(oneLive(d, "brainstorm", "after replace"), r.newAgentId);
  } finally { d.cleanup(); }
});

test("Spin Up: a refresh failure on a resumable runner Buddy never spawns a second one", async () => {
  const w = setup();
  try {
    buddy(w, { status: "closed", resumable: true });
    w.refreshAgent = async () => { throw Object.assign(new Error("agent cap"), { status: 503 }); };
    const r = await spinUp(w);
    assert.equal(r.ok, false);
    assert.equal(w.creates, 0);
    oneLive(w, "brainstorm", "after failed reopen");
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- restart_buddy / Buddy auto-restart

test("restart_buddy: concurrent restarts of one Buddy share a spawn; a repeat is skipped; timeout-created retry keeps one Buddy", async () => {
  const w = setup();
  try {
    buddy(w);
    const [a, b] = await Promise.all([restart(w, "rn-bud1"), restart(w, "rn-bud1")]);
    assert.equal(w.creates, 1);
    assert.equal(a.newAgentId, b.newAgentId);
    const again = await restart(w, "rn-bud1");
    assert.equal(again.skipped, true);
    assert.equal(w.creates, 1);
    await sleep(20);
    assert.equal(oneLive(w, "brainstorm", "after restart"), a.newAgentId);
  } finally { w.cleanup(); }
  const t = setup();
  try {
    buddy(t);
    t.modes = ["late"];
    await assert.rejects(restart(t, "rn-bud1"), /timed out/);
    const r = await restart(t, "rn-bud1");
    assert.equal(r.ok, true);
    await sleep(20);
    assert.equal(oneLive(t, "brainstorm", "after timeout + retry"), r.newAgentId);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- lead handoff (self / auto / vs handoff)

test("handoff: one successor, old lead retired; concurrent triggers share one spawn", async () => {
  const w = setup();
  try {
    const old = lead(w);
    const c = coordinator(w);
    const [a, b] = await Promise.all([
      c.triggerSelfHandoff(old, { trigger: "self", retireImmediately: true }),
      c.triggerSelfHandoff(old, { trigger: "self", retireImmediately: true }),
    ]);
    assert.equal(w.creates, 1);
    assert.equal(a.successorId ?? b.successorId, oneLive(w, "lead", "after handoff"));
  } finally { w.cleanup(); }
});

test("handoff: create times out but the successor exists -> retry adopts it, one live lead", async () => {
  const w = setup();
  try {
    const old = lead(w);
    w.modes = ["late"];
    await assert.rejects(coordinator(w).triggerSelfHandoff(old, { trigger: "self", retireImmediately: true }), /timed out/);
    const r = await coordinator(w).triggerSelfHandoff(old, { trigger: "self", retireImmediately: true });
    assert.equal(r.ok, true);
    assert.equal(w.creates, 1, "the retry adopted the late successor instead of spawning another");
    assert.equal(oneLive(w, "lead", "after timeout + retry"), r.successorId);
    assert.equal(w.agents.get("rn-lead1").labels.role, "former-lead");
  } finally { w.cleanup(); }
});

test("handoff: a plain failure leaves the old lead, and the retry mints exactly one successor", async () => {
  const w = setup();
  try {
    const old = lead(w);
    w.modes = ["fail"];
    await assert.rejects(coordinator(w).triggerSelfHandoff(old, { trigger: "self", retireImmediately: true }), /spawn exploded/);
    assert.equal(oneLive(w, "lead", "after failed spawn"), "rn-lead1");
    const r = await coordinator(w).triggerSelfHandoff(old, { trigger: "self", retireImmediately: true });
    assert.equal(oneLive(w, "lead", "after retry"), r.successorId);
  } finally { w.cleanup(); }
});

test("handoff: pending takeover survives a server restart (fresh coordinator) without a second successor; confirm retires the old lead", async () => {
  const w = setup();
  try {
    const old = lead(w);
    const first = await coordinator(w).triggerSelfHandoff(old, { trigger: "auto-250" });
    assert.equal(first.pendingConfirmation, true);
    // Server restart: in-memory dedupe slots are gone; the old lead is still role=lead until the successor confirms.
    const second = await coordinator(w).triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "self" });
    assert.equal(w.creates, 1, "no second successor for the same predecessor");
    assert.equal(second.successorId, first.successorId);
    const c = coordinator(w);
    const conf = await c.confirmTakeover(first.successorId);
    assert.equal(conf.confirmed, true);
    assert.equal(oneLive(w, "lead", "after confirm"), first.successorId);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- Buddy spawns the lane lead (spawn_worker role=lead)

function buddyCtx(w, identity = { agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }) {
  const profiles = [{ id: "p-l", name: "Lead - Opus", role: "lead", provider: "claude", model: "claude-opus-5-5", modeId: "auto", notes: "lead it" }];
  const withBackend = async (_t, fn) => fn(w);
  return {
    ...verifiedIdentity(identity, { backend: w, teams: TEAMS }), cwd: w.dir, teams: TEAMS,
    loadProfiles: async () => profiles,
    resolveProfile: async (name) => { const p = profiles.find((x) => x.name === name); return p ? { profile: p, spawn: { provider: p.provider, model: p.model, modeId: p.modeId, systemPrompt: p.notes } } : null; },
    writeLog: async () => {},
    withBackend,
    findLiveLeads: createContext({ env: {}, identity, withBackend, teams: TEAMS }).findLiveLeads,
  };
}
const askLead = (ctx) => callTool(ctx, "spawn_worker", { title: "L", profile: "Lead - Opus", prompt: "lead", labels: { role: "lead" } });

test("Buddy spawns lead: concurrent asks mint one lead; a timeout-created retry is refused; resume of a lost lead blocks a new one", async () => {
  const w = setup();
  try {
    buddy(w);
    const ctx = buddyCtx(w);
    const results = await Promise.allSettled([askLead(ctx), askLead(ctx)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "second concurrent ask is refused");
    assert.equal(w.creates, 1);
    oneLive(w, "lead", "after concurrent asks");
  } finally { w.cleanup(); }
  const t = setup();
  try {
    buddy(t);
    t.modes = ["late"];
    await assert.rejects(askLead(buddyCtx(t)), /timed out/);
    await assert.rejects(askLead(buddyCtx(t)), /already has a live lead/);
    assert.equal(t.creates, 1);
    oneLive(t, "lead", "after timeout + retry");
  } finally { t.cleanup(); }
  const r = setup();
  try {
    buddy(r);
    lead(r, { status: "closed", resumable: true });
    await assert.rejects(askLead(buddyCtx(r)), /already has a live lead/);
    assert.equal(r.creates, 0);
    oneLive(r, "lead", "lost lead is resumed, not replaced");
  } finally { r.cleanup(); }
});

// ---------------------------------------------------------------- vs spawn / handoff / restart: spoofed identity flags cannot escalate

function writeRunnerRecord(vsHome, id, meta) {
  const dir = join(vsHome, "runner", "agents");
  mkdirSync(dir, { recursive: true });
  const ev = (seq, type, data) => JSON.stringify({ seq, ts: Date.now(), type, ...data });
  writeFileSync(join(dir, `${id}.jsonl`), [ev(0, "created", { provider: "claude", model: "m", cwd: process.cwd(), meta }), ev(1, "status", { status: "idle" })].join("\n") + "\n");
}

test("spoofed --role/--lane/--team/--agent/--ord cannot make a worker spawn a lead, hand off, or restart a Buddy", async () => {
  const w = setup();
  const keys = ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "VS_ROLE", "VS_TEAM", "VS_LANE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    buddy(w);
    lead(w);
    writeRunnerRecord(w.vsHome, "rn-work1", { team: "mx", lane: "feat", role: "worker", title: "Worker" });
    writeRunnerRecord(w.vsHome, "rn-lead1", { team: "mx", lane: "feat", role: "lead", title: "Lead 1", ord: "1" });
    Object.assign(process.env, { VS_AGENT_ID: "rn-work1", PASEO_AGENT_ID: "rn-work1", VS_AGENT_TOKEN: tokenFor("rn-work1"), VS_ROLE: "lead", VS_TEAM: "mx", VS_LANE: "hub" });
    const spoof = { role: "lead", lane: "hub", team: "mx", agent: "rn-lead1", ord: "9" };
    const seen = [];
    const makeContext = (opts) => { seen.push(opts.identity); return buddyCtx(w, opts.identity); };
    const quiet = () => {};
    const liveBefore = w.who("lead").ids;

    // spawn: the CLI carries no labels, so it can only ever mint a worker under the record's own team/lane.
    await commandAgentVerb("spawn", { _: [], title: "Sub", profile: "Lead - Opus", prompt: "x", ...spoof }, makeContext, quiet);
    const spawned = [...w.agents.values()].at(-1);
    assert.deepEqual([spawned.labels.role, spawned.labels.lane, spawned.labels.team, spawned.labels["vs.parent"]], ["worker", "feat", "mx", "rn-work1"]);
    assert.deepEqual(w.who("lead").ids, liveBefore, "no lead was minted");

    // handoff_lead and restart_buddy: still a worker, so both refuse.
    await assert.rejects(commandAgentVerb("lead", { _: ["handoff"], ...spoof }, makeContext, quiet), /caller role is "worker"/);
    await assert.rejects(commandAgentVerb("buddy", { _: ["restart"], ...spoof }, makeContext, quiet), /not a live lead/);
    for (const id of seen) assert.deepEqual([id.agentId, id.role, id.team, id.lane], ["rn-work1", "worker", "mx", "feat"]);
    assert.equal(w.creates, 1, "only the worker spawn reached the backend");
    assert.deepEqual(w.who("lead").ids, liveBefore);

    // Default-mode verbs (log/spec/task/pin ...) take the same record: --agent/--role/--ord are claims.
    const id = resolveIdentity({ role: "lead", agent: "rn-lead1", ord: "9" });
    assert.deepEqual([id.agentId, id.role], ["rn-work1", "worker"]);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    w.cleanup();
  }
});

// ---------------------------------------------------------------- vs who lead during a handoff

test("who lead: pending handoff keeps the old lead as sole winner, the confirmed successor takes over, an unconfirmed one never conflicts, unlinked leads still CONFLICT", async () => {
  const w = setup();
  try {
    const old = lead(w);
    const first = await coordinator(w).triggerSelfHandoff(old, { trigger: "auto-250" });
    // pending: both live, linked by vs.handoff-from
    let r = w.who("lead");
    assert.equal(r.ids.length, 2);
    assert.equal(r.conflict, false, "a linked successor is not a duplicate");
    assert.equal(r.winner, "rn-lead1");
    assert.deepEqual(r.pending, [first.successorId]);
    // never confirms: still exactly one winner, no conflict
    r = w.who("lead");
    assert.equal(r.winner, "rn-lead1");
    // confirmed: old retires, the successor is the sole winner
    await coordinator(w).confirmTakeover(first.successorId);
    r = w.who("lead");
    assert.deepEqual([r.winner, r.conflict, r.pending.length], [first.successorId, false, 0]);
  } finally { w.cleanup(); }
  const u = setup();
  try {
    lead(u);
    u.seed({ id: "rn-lead9", title: "Lead 9", labels: { role: "lead", lead: "feat", ord: "2" } });
    const r = u.who("lead");
    assert.equal(r.conflict, true, "two live leads with no handoff link are a real CONFLICT");
    // a link to an agent that is not a live lead does not excuse a duplicate either
    u.agents.get("rn-lead9").labels["vs.handoff-from"] = "rn-gone";
    assert.equal(u.who("lead").conflict, true);
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------- R2 review fixes

test("hard-300 after an unconfirmed auto-250 adopts the pending successor and retires the old lead: never two settled leads", async () => {
  const w = setup();
  try {
    const old = lead(w);
    const s1 = await coordinator(w).triggerSelfHandoff(old, { trigger: "auto-250" });
    assert.equal(s1.pendingConfirmation, true);
    const forced = await coordinator(w).spawnSuccessor({ oldLead: w.agents.get("rn-lead1"), trigger: "hard-300", forceSynthesize: true });
    assert.equal(w.creates, 1, "no second successor for the same predecessor");
    assert.equal(forced.successorId, s1.successorId);
    assert.equal(oneLive(w, "lead", "after hard-300"), s1.successorId);
    assert.equal(w.agents.get("rn-lead1").labels.role, "former-lead");
  } finally { w.cleanup(); }
});

test("spawn_worker strips handoff labels; confirmTakeover refuses a non-lead, so a worker cannot demote the live lead", async () => {
  const w = setup();
  try {
    buddy(w);
    lead(w);
    const ctx = buddyCtx(w, { agentId: "rn-w", team: "mx", lane: "feat", role: "worker" });
    await callTool(ctx, "spawn_worker", { title: "W", profile: "Lead - Opus", prompt: "x", labels: { "vs.handoff-from": "rn-lead1", "vs.handoff-trigger": "self", "handoff-successor": "rn-x", job: "j" } });
    const spawned = [...w.agents.values()].at(-1);
    for (const k of ["vs.handoff-from", "vs.handoff-trigger", "handoff-successor"]) assert.equal(spawned.labels[k], undefined, k);
    // Even a forged worker record (label set by another route) cannot confirm.
    w.seed({ id: "rn-forged", title: "W", labels: { role: "worker", "vs.handoff-from": "rn-lead1", "vs.handoff-trigger": "self" } });
    const r = await coordinator(w).confirmTakeover("rn-forged");
    assert.equal(r.confirmed, false);
    assert.equal(oneLive(w, "lead", "after forged confirm"), "rn-lead1");
  } finally { w.cleanup(); }
});

test("handoff_lead (retireImmediately, shared slots) after an unconfirmed auto-250 retires the old lead instead of returning early", async () => {
  const w = setup();
  try {
    const old = lead(w);
    const shared = () => coordinator(w, { sharedSlots: true });
    const s1 = await shared().triggerSelfHandoff(old, { trigger: "auto-250" });
    assert.equal(s1.pendingConfirmation, true);
    const again = await shared().triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "buddy", retireImmediately: true });
    assert.equal(w.creates, 1);
    assert.equal(again.successorId, s1.successorId);
    assert.equal(w.agents.get("rn-lead1").labels.role, "former-lead", "old lead retired");
    assert.equal(oneLive(w, "lead", "after handoff_lead"), s1.successorId);
  } finally { w.cleanup(); }
});

test("R3 stakes param: sets labels.stakes, labels.stakes wins, unknown rejected, handoff strip keeps stakes, vs --stakes", async () => {
  const w = setup();
  try {
    buddy(w);
    lead(w);
    const ctx = buddyCtx(w, { agentId: "rn-w", team: "mx", lane: "feat", role: "worker" });
    const last = () => [...w.agents.values()].at(-1);
    await callTool(ctx, "spawn_worker", { title: "A", profile: "Lead - Opus", prompt: "x", stakes: "mechanical" });
    assert.equal(last().labels.stakes, "mechanical");
    await callTool(ctx, "create_agent", { title: "B", profile: "Lead - Opus", prompt: "x", stakes: "mechanical", labels: { stakes: "tierA-security" } });
    assert.equal(last().labels.stakes, "tierA-security");
    await callTool(ctx, "spawn_worker", { title: "C", profile: "Lead - Opus", prompt: "x", stakes: "tierA-invariant", labels: { "vs.handoff-from": "rn-lead1", "handoff-successor": "rn-x" } });
    assert.equal(last().labels.stakes, "tierA-invariant");
    assert.equal(last().labels["vs.handoff-from"], undefined);
    const before = w.creates;
    await assert.rejects(callTool(ctx, "spawn_worker", { title: "D", profile: "Lead - Opus", prompt: "x", stakes: "bogus" }), /unknown stakes "bogus"/);
    assert.equal(w.creates, before);
    await callTool(ctx, "spawn_worker", { title: "E", profile: "Lead - Opus", prompt: "x" });
    assert.equal(last().labels.stakes, undefined);
    const out = [];
    await commandAgentVerb("spawn", { _: [], title: "F", profile: "Lead - Opus", prompt: "x", stakes: "mechanical" }, () => ctx, (s) => out.push(s));
    assert.equal(last().labels.stakes, "mechanical");
    await assert.rejects(commandAgentVerb("spawn", { _: [], title: "G", profile: "Lead - Opus", prompt: "x", stakes: "nope" }, () => ctx, () => {}), /unknown stakes/);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- S1 lows (unit-s1-lows)

test("L1: a pending successor that died before confirm is evicted; the next handoff mints a fresh one (not a dead deduped id)", async () => {
  for (const via of ["self", "spawn"]) {
    const w = setup();
    try {
      const old = lead(w);
      const c = coordinator(w);
      const s1 = await c.triggerSelfHandoff(old, { trigger: "auto-250" });
      assert.equal(s1.pendingConfirmation, true);
      w.agents.get(s1.successorId).archivedAt = new Date().toISOString(); // dies before confirming
      const again = via === "self"
        ? await c.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "buddy", retireImmediately: true })
        : await c.spawnSuccessor({ oldLead: w.agents.get("rn-lead1"), trigger: "buddy", retireImmediately: true });
      assert.equal(w.creates, 2, `${via}: a fresh successor was minted`);
      assert.notEqual(again.successorId, s1.successorId, `${via}: not the dead one`);
      assert.equal(w.agents.get("rn-lead1").labels.role, "former-lead", `${via}: old lead retired`);
      assert.equal(oneLive(w, "lead", `${via}: after dead-successor handoff`), again.successorId);
    } finally { w.cleanup(); }
  }
});

test("L2: confirmTakeover refuses an unverifiable (unfetchable) successor and leaves the old lead live", async () => {
  const w = setup();
  try {
    const old = lead(w);
    const c = coordinator(w);
    const s1 = await c.triggerSelfHandoff(old, { trigger: "auto-250" });
    w.agents.delete(s1.successorId); // pending record exists, successor can no longer be verified
    const r = await c.confirmTakeover(s1.successorId);
    assert.equal(r.confirmed, false);
    assert.equal(w.agents.get("rn-lead1").labels.role, "lead", "old lead not retired on an unverified successor");
    assert.equal(oneLive(w, "lead", "after unverifiable confirm"), "rn-lead1");
  } finally { w.cleanup(); }
});

test("L2: a failing setLabels leaves the takeover pending and retryable (no confirmed/pending drift)", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let fail = true;
    const c = coordinator(w, { setLabels: async (id, labels, name) => { if (fail) throw new Error("update boom"); return w.updateAgent(id, { name, labels }); } });
    const s1 = await c.triggerSelfHandoff(old, { trigger: "auto-250" });
    const bad = await c.confirmTakeover(s1.successorId);
    assert.equal(bad.confirmed, false);
    assert.equal(c.hasPendingTakeover(s1.successorId), true, "still pending");
    assert.equal(w.agents.get("rn-lead1").labels.role, "lead");
    fail = false;
    const ok = await c.confirmTakeover(s1.successorId);
    assert.equal(ok.confirmed, true, "retry succeeds (not reported alreadyConfirmed)");
    assert.equal(c.hasPendingTakeover(s1.successorId), false);
    assert.equal(oneLive(w, "lead", "after retry"), s1.successorId);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- S1 lows round 2 (unit-s1-lows)

test("L1r2: a stale roster that still lists the dead successor as adoptable never retires the old lead onto it (0 leads)", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let stale = null;
    const c = coordinator(w, { listAgents: async () => stale ?? (await w.fetchAgents()).entries.map((e) => e.agent) });
    const s1 = await c.triggerSelfHandoff(old, { trigger: "auto-250" });
    stale = (await w.fetchAgents()).entries.map((e) => e.agent); // roster lags: still shows the successor as a live adoptable lead
    w.agents.get(s1.successorId).archivedAt = new Date().toISOString();
    const again = await c.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "buddy", retireImmediately: true });
    assert.equal(w.creates, 2, "a fresh successor, not the dead adoptable");
    assert.notEqual(again.successorId, s1.successorId);
    assert.equal(oneLive(w, "lead", "after stale-roster handoff"), again.successorId);
  } finally { w.cleanup(); }
});

test("L2r2: a failing worker repoint does not abort the handoff after the successor exists", async () => {
  const w = setup();
  try {
    const old = lead(w);
    w.seed({ id: "rn-w1", title: "W", status: "running", labels: { role: "worker", "paseo.parent-agent-id": "rn-lead1" } });
    const c = coordinator(w, { setLabels: async (id, labels, name) => { if (id === "rn-w1") throw new Error("worker boom"); return w.updateAgent(id, { name, labels }); } });
    const r = await c.triggerSelfHandoff(old, { trigger: "self", retireImmediately: true });
    assert.equal(r.ok, true);
    assert.equal(oneLive(w, "lead", "after failed repoint"), r.successorId);
    assert.equal(w.agents.get("rn-lead1").labels.role, "former-lead");
  } finally { w.cleanup(); }
});

test("L2r2: evaluateLead releases its once-only claim when setLabels fails, so the next evaluation retries", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let fail = true;
    const c = coordinator(w, { setLabels: async (id, labels, name) => { if (fail) throw new Error("label boom"); return w.updateAgent(id, { name, labels }); } });
    await assert.rejects(c.evaluateLead(old, { usedTokens: 150_000 }), /label boom/);
    fail = false;
    const r = await c.evaluateLead(w.agents.get("rn-lead1"), { usedTokens: 150_000 });
    assert.equal(r.stage, "flag-150");
    assert.equal(r.triggered, true, "retried instead of being stuck as already-flagged");
  } finally { w.cleanup(); }
});

test("L3r2: handoff_lead on a pending handoff surfaces a failed retire instead of reporting success", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let fail = false;
    const c = coordinator(w, { setLabels: async (id, labels, name) => { if (fail) throw new Error("retire boom"); return w.updateAgent(id, { name, labels }); } });
    const s1 = await c.triggerSelfHandoff(old, { trigger: "auto-250" });
    fail = true;
    const r = await c.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "buddy", retireImmediately: true });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /retire boom/);
    assert.equal(r.successorId, s1.successorId);
    assert.equal(w.agents.get("rn-lead1").labels.role, "lead", "old lead still live; not silently half-done");
  } finally { w.cleanup(); }
});

test("L4r2: a transient getAgent error is not 'dead' (no eviction, no second successor); a real death evicts and relabels the dead successor", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let flaky = false;
    const c = coordinator(w, { getAgent: async (id) => { if (flaky) throw new Error("socket hang up"); return (await w.fetchAgent(id).catch(() => null))?.agent ?? null; } });
    const s1 = await c.triggerSelfHandoff(old, { trigger: "auto-250" });
    flaky = true;
    const r = await c.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "self" });
    assert.equal(w.creates, 1, "no eviction on a fetch error");
    assert.equal(r.successorId, s1.successorId);
    flaky = false;
    // Real death: successor archived but still labeled as a lead -> evicted and relabeled so nothing adopts/counts it again.
    w.agents.get(s1.successorId).archivedAt = new Date().toISOString();
    const r2 = await c.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "self", retireImmediately: true });
    assert.equal(w.creates, 2);
    const dead = w.agents.get(s1.successorId);
    assert.equal(dead.labels.role, "former-lead");
    assert.notEqual(dead.labels["vs.handoff-from"], "rn-lead1");
    assert.equal(oneLive(w, "lead", "after eviction"), r2.successorId);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- S1 lows round 3 (unit-s1-lows)

test("L1r3: retire write fails after the successor was created and the retry roster lags -> the retry confirms the recorded successor, no second one", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let failRetire = true;
    let lag = false;
    const c = coordinator(w, {
      listAgents: async () => (lag ? [] : (await w.fetchAgents()).entries.map((e) => e.agent)),
      setLabels: async (id, labels, name) => { if (failRetire && id === "rn-lead1") throw new Error("retire boom"); return w.updateAgent(id, { name, labels }); },
    });
    await assert.rejects(c.triggerSelfHandoff(old, { trigger: "self", retireImmediately: true }), /retire boom/);
    assert.equal(w.creates, 1);
    failRetire = false;
    lag = true; // listDaemonAgents failed / lags: the created successor is invisible to adoption
    const r = await c.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "self", retireImmediately: true });
    assert.equal(w.creates, 1, "the retry must not mint a second successor");
    assert.equal(w.agents.get("rn-lead1").labels.role, "former-lead");
    assert.equal(oneLive(w, "lead", "after retire retry"), r.successorId);
  } finally { w.cleanup(); }
});

test("L2r3: evicted successors are shared across coordinators when sharedSlots (a second coordinator with a lagging roster cannot re-adopt the dead one)", async () => {
  const w = setup();
  try {
    const old = lead(w);
    let stale = null;
    const mk = () => coordinator(w, { sharedSlots: true, listAgents: async () => stale ?? (await w.fetchAgents()).entries.map((e) => e.agent) });
    const c1 = mk();
    const s1 = await c1.triggerSelfHandoff(old, { trigger: "auto-250" });
    stale = (await w.fetchAgents()).entries.map((e) => e.agent);
    w.agents.get(s1.successorId).archivedAt = new Date().toISOString();
    w.modes = ["fail"];
    await assert.rejects(c1.triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "self", retireImmediately: true }), /spawn exploded/);
    const r = await mk().triggerSelfHandoff(w.agents.get("rn-lead1"), { trigger: "self", retireImmediately: true });
    assert.notEqual(r.successorId, s1.successorId, "dead successor not re-adopted");
    assert.equal(oneLive(w, "lead", "after second coordinator"), r.successorId);
  } finally { w.cleanup(); }
});
