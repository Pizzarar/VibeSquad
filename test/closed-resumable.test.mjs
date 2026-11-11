// R2 redesign: "closed" is retired only when the runner cannot resume the agent in place. A lost lead/Buddy with a saved
// session (resumable) stays live; an exited / session-less one is retired as before. Exercises the shared predicate
// (isRetiredAgent / isLiveAgent / whoCandidate / resolveLeadWinner), the runner's resumable status, vs who, spawn gating,
// and send routing — with real resumable fixtures (session event, lost, no exit) and unresumable ones (exit / no session).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isLiveAgent, isRetiredAgent, resolveLeadWinner, whoCandidate } from "../server/identity.mjs";
import { Runner } from "../runner/runner.mjs";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { createPlugin } from "../server/hooks/agent-duties.ts";
import { seedDefaultPack } from "../server/profiles.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");
const tmp = () => mkdtempSync(join(os.tmpdir(), "vs-closed-res-"));
const tick = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// 1. The shared predicate
// ---------------------------------------------------------------------------

test("isRetiredAgent/isLiveAgent: closed+resumable is live, closed+!resumable is retired", () => {
  const resumable = { id: "rn-lost", status: "closed", resumable: true, labels: { role: "lead" } };
  const exited = { id: "rn-exited", status: "closed", resumable: false, labels: { role: "lead" } };
  const noFlag = { id: "rn-nosession", status: "closed", labels: { role: "lead" } }; // daemon/Paseo agents have no resumable
  const archived = { id: "rn-arch", status: "closed", resumable: true, archivedAt: "x", labels: { role: "lead" } };

  assert.equal(isRetiredAgent(resumable), false);
  assert.equal(isLiveAgent(resumable), true);
  assert.equal(isRetiredAgent(exited), true);
  assert.equal(isLiveAgent(exited), false);
  assert.equal(isRetiredAgent(noFlag), true, "no resumable flag -> closed reads retired (old behaviour)");
  assert.equal(isLiveAgent(noFlag), false);
  assert.equal(isRetiredAgent(archived), true);
  assert.equal(isLiveAgent(archived), false);
});

test("whoCandidate: a closed+resumable lead is a live candidate, a dead one is not", () => {
  const teams = [{ id: "efi", name: "EFI", paths: [], lanes: [{ id: "own", name: "Own" }] }];
  const base = { labels: { team: "efi", lane: "own", role: "lead" }, cwd: "/x" };
  const resumable = { ...base, status: "closed", resumable: true };
  const dead = { ...base, status: "closed", resumable: false };
  assert.equal(whoCandidate(resumable, { teams, wantTeamId: "efi", wantLane: "own" })?.role, "lead");
  assert.equal(whoCandidate(dead, { teams, wantTeamId: "efi", wantLane: "own" }), null);
});

// ---------------------------------------------------------------------------
// 2. resolveLeadWinner (the winner rule shared by vs who / findLead / handoff / send)
// ---------------------------------------------------------------------------

const lead = (id, over = {}) => ({ id, status: "idle", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", labels: { role: "lead" }, ...over });

test("resolveLeadWinner: a non-closed lead beats a closed-but-resumable one (no conflict)", () => {
  const closed = lead("rn-lost", { status: "closed", resumable: true, createdAt: "2026-11-02T00:00:00.000Z" });
  const live = lead("rn-live", { createdAt: "2026-11-01T00:00:00.000Z" });
  const { winner, conflict } = resolveLeadWinner([closed, live]);
  assert.equal(conflict, false);
  assert.equal(winner.id, "rn-live");
});

test("resolveLeadWinner: a lone closed-but-resumable lead is its own winner", () => {
  const { winner, conflict } = resolveLeadWinner([lead("rn-lost", { status: "closed", resumable: true })]);
  assert.equal(conflict, false);
  assert.equal(winner.id, "rn-lost");
});

test("resolveLeadWinner: 2+ non-closed leads is a conflict; newest wins among equals", () => {
  const a = lead("rn-a", { createdAt: "2026-11-01T00:00:00.000Z" });
  const b = lead("rn-b", { createdAt: "2026-11-02T00:00:00.000Z" });
  assert.equal(resolveLeadWinner([a, b]).conflict, true);
  assert.equal(resolveLeadWinner([a, b]).winner.id, "rn-b");
  assert.equal(resolveLeadWinner([]).winner, null);
  assert.equal(resolveLeadWinner([]).conflict, false);
});

test("resolveLeadWinner: a closed+resumable agent is dropped when a dead (unresumable) one is the only other", () => {
  const closed = lead("rn-lost", { status: "closed", resumable: true });
  const dead = lead("rn-dead", { status: "closed", resumable: false });
  const { winner, conflict } = resolveLeadWinner([closed, dead]);
  assert.equal(conflict, false);
  assert.equal(winner.id, "rn-lost");
});

// ---------------------------------------------------------------------------
// 3. The runner exposes resumable from the resume endpoint's own predicate
// ---------------------------------------------------------------------------

function fakeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit("exit", 0, null); };
    child.push = (o) => child.stdout.write(JSON.stringify(o) + "\n");
    child.stdin.on("data", () => setImmediate(() => child.push({ type: "result", subtype: "success" })));
    const sid = `sess-${calls.length + 1}`;
    setImmediate(() => child.push({ type: "system", subtype: "init", session_id: sid, model: "m" }));
    calls.push({ args, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}
const mkRunner = (dir, spawnImpl) => new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) } });

test("runner status(): a lost agent is resumable (saved session), an exited / session-less one is not", async () => {
  const dir = tmp();
  const r1 = mkRunner(dir, fakeSpawn());
  const lostId = r1.create({ provider: "claude", cwd: os.tmpdir(), prompt: "hello" });
  await tick();
  assert.equal(r1.status(lostId).status, "idle");
  // restart: a fresh Runner over the same log has no live child -> lost with a saved session
  const r2 = mkRunner(dir, fakeSpawn());
  assert.equal(r2.status(lostId).status, "lost");
  assert.equal(r2.status(lostId).resumable, true, "a lost agent with a session is resumable");

  // exited: shutdown logs an exit -> not resumable
  r1.shutdown();
  const r3 = mkRunner(dir, fakeSpawn());
  assert.equal(r3.status(lostId).status, "exited");
  assert.equal(r3.status(lostId).resumable, false);

  // session-less: never emitted a session -> lost but not resumable
  const noSession = "rn-nosession";
  r3.store.append(noSession, "created", { provider: "claude", model: null, cwd: os.tmpdir(), meta: { title: "x" } });
  r3.store.append(noSession, "status", { status: "running" });
  assert.equal(r3.status(noSession).status, "lost");
  assert.equal(r3.status(noSession).resumable, false);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. vs who lead / vs who brainstorm over real runner logs (hermetic HOME)
// ---------------------------------------------------------------------------

function makeMockEnv() {
  const dir = tmp();
  const vsHome = join(dir, ".vibesquad");
  const paseoHome = join(dir, ".paseo");
  const agentsDir = join(vsHome, "runner", "agents");
  mkdirSync(agentsDir, { recursive: true });
  seedDefaultPack(join(vsHome, "profiles.json"));
  writeFileSync(
    join(vsHome, "teams.json"),
    JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", paths: ["vibesquad"], lanes: [{ id: "vibesquad", name: "VibeSquad" }] }] }) + "\n",
    "utf8",
  );
  const now = Date.now();
  const writeAgent = (id, events, { startedAt = now } = {}) => {
    writeFileSync(join(agentsDir, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    writeFileSync(join(vsHome, "runner", "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt }), "utf8");
  };
  const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k)));
  const runVs = (args) =>
    spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...baseEnv(), VIBESQUAD_HOME: vsHome, PASEO_HOME: paseoHome },
    });
  return { dir, vsHome, agentsDir, now, writeAgent, runVs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const created = (ts, { id, role, topic } = {}) => ({ seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: REPO_ROOT, meta: { title: `★ ${id}`, labels: { team: "vibesquad", lane: "vibesquad", role, ...(topic ? { topic } : {}) } } });

test("vs who lead: a lost (resumable) lead is live; an exited one is not", () => {
  const env = makeMockEnv();
  try {
    const t0 = env.now - 60_000;
    // resumable lost lead: idle + session, runner started after it
    env.writeAgent("rn-resumable-lead", [
      created(t0, { id: "rn-resumable-lead", role: "lead" }),
      { seq: 1, ts: t0, type: "status", status: "idle" },
      { seq: 2, ts: t0, type: "session", sessionId: "sess-1" },
    ]);
    let res = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).entries.map((e) => e.id), ["rn-resumable-lead"]);

    // exited lead (same session, then exit) -> retired -> NONE
    env.writeAgent("rn-exited-lead", [
      created(t0, { id: "rn-exited-lead", role: "lead" }),
      { seq: 1, ts: t0, type: "status", status: "idle" },
      { seq: 2, ts: t0, type: "session", sessionId: "sess-1" },
      { seq: 3, ts: t0, type: "exit", code: 0 },
    ]);
    res = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).entries.map((e) => e.id), ["rn-resumable-lead"], "the exited lead is retired, not a second live lead");

    // lost lead with NO session -> not resumable -> retired
    env.writeAgent("rn-nosession-lead", [
      created(t0, { id: "rn-nosession-lead", role: "lead" }),
      { seq: 1, ts: t0, type: "status", status: "idle" },
    ]);
    res = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).entries.map((e) => e.id), ["rn-resumable-lead"], "a session-less lost lead is retired, not live");
  } finally {
    env.cleanup();
  }
});

test("vs who lead: a lost lead loses to a live successor (no CONFLICT), and a dead closed lead yields NONE", () => {
  const env = makeMockEnv();
  try {
    const t0 = env.now - 60_000;
    const live = env.now + 1_000;
    env.writeAgent("rn-lost-lead", [
      created(t0, { id: "rn-lost-lead", role: "lead" }),
      { seq: 1, ts: t0, type: "status", status: "idle" },
      { seq: 2, ts: t0, type: "session", sessionId: "sess-1" },
    ]);
    env.writeAgent("rn-live-lead", [
      created(live, { id: "rn-live-lead", role: "lead" }),
      { seq: 1, ts: live, type: "status", status: "idle" },
    ], { startedAt: env.now });
    // wait: both agents in the same dir; write runner.json with the live lead's liveness
    // (the lost lead predates startedAt, the live one does not)
    const res = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.entries.map((e) => e.id), ["rn-live-lead"], "the live successor wins; the lost lead is not a conflict");

    // A dead (unresumable) closed lead alone -> NONE
    const env2 = makeMockEnv();
    try {
      const t2 = env2.now - 60_000;
      env2.writeAgent("rn-dead-lead", [
        created(t2, { id: "rn-dead-lead", role: "lead" }),
        { seq: 1, ts: t2, type: "status", status: "idle" },
        { seq: 2, ts: t2, type: "exit", code: 0 },
      ]);
      const none = env2.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
      assert.equal(none.status, 1, none.stdout + none.stderr);
      assert.equal(JSON.parse(none.stdout).status, "none");
    } finally {
      env2.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("vs who brainstorm: a lost Buddy loses to a live same-topic Buddy (winner rule applies to Buddies too)", () => {
  const env = makeMockEnv();
  try {
    const t0 = env.now - 60_000;
    const live = env.now + 1_000;
    env.writeAgent("rn-lost-buddy", [
      created(t0, { id: "rn-lost-buddy", role: "brainstorm" }),
      { seq: 1, ts: t0, type: "status", status: "idle" },
      { seq: 2, ts: t0, type: "session", sessionId: "sess-1" },
    ]);
    env.writeAgent("rn-live-buddy", [
      created(live, { id: "rn-live-buddy", role: "brainstorm" }),
      { seq: 1, ts: live, type: "status", status: "idle" },
    ], { startedAt: env.now });
    const res = env.runVs(["who", "brainstorm", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.entries.map((e) => e.id), ["rn-live-buddy"], "the live Buddy wins over the lost resumable one");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. spawn gating: a resumable closed lead blocks spawn; a dead one is replaceable
// ---------------------------------------------------------------------------

function leadCtx({ agents = [], identity = { agentId: "rn-buddy", team: "efi", lane: "own", role: "brainstorm" } } = {}) {
  const backend = {
    async fetchAgents() { return { entries: agents.map((agent) => ({ agent })) }; },
    async fetchAgent(id) { return { agent: agents.find((a) => a.id === id) ?? null }; },
    async createAgent(p) { const a = { id: "rn-new", title: p.config.title, labels: { ...p.labels } }; return a; },
  };
  const teams = [{ id: "efi", name: "EFI", paths: [], lanes: [{ id: "own", name: "Own" }] }];
  const ctx = createContext({ ...verifiedIdentity(identity, { backend, teams }), withBackend: async (_o, fn) => fn(backend), teams });
  ctx.findLiveLeads = createContext({ identity, withBackend: async (_o, fn) => fn(backend), teams }).findLiveLeads;
  ctx.loadProfiles = async () => [{ id: "p", name: "Lead - Opus", role: "lead", provider: "claude", model: "claude-opus-5-5", modeId: "auto" }];
  ctx.resolveProfile = async (name) => ({ profile: { id: "p", name: "Lead - Opus" }, spawn: { provider: "claude", model: "claude-opus-5-5", modeId: "auto" } });
  return ctx;
}

test("spawn_worker: a closed+resumable lead blocks a lead spawn; a dead closed lead is replaceable", async () => {
  const leadAgent = (id, over = {}) => ({ id, title: id, status: "idle", labels: { team: "efi", lane: "own", role: "lead" }, ...over });
  const resumable = leadCtx({ agents: [leadAgent("rn-lost", { status: "closed", resumable: true })] });
  await assert.rejects(
    callTool(resumable, "spawn_worker", { title: "L", profile: "Lead - Opus", prompt: "lead", labels: { role: "lead" } }),
    /already has a live lead \(rn-lost\)/,
  );
  const dead = leadCtx({ agents: [leadAgent("rn-dead", { status: "closed", resumable: false })] });
  const out = await callTool(dead, "spawn_worker", { title: "L", profile: "Lead - Opus", prompt: "lead", labels: { role: "lead" } });
  assert.equal(out.id, "rn-new", "a dead closed lead can be replaced");
});

// ---------------------------------------------------------------------------
// 6. send routing: a closed losing lead redirects to the live winner; a lone one resumes in place
// ---------------------------------------------------------------------------

function pluginHarness(agents, home) {
  const handlers = new Map();
  const server = {
    before: () => () => {},
    on: (event, fn) => { handlers.set(event, fn); return () => {}; },
  };
  const ref = (id) => ({
    refresh: async () => ({ agent: agents.find((a) => a.id === id) ?? null }),
    send: async () => {},
  });
  const paseo = { agents: { ref, list: async () => ({ entries: agents.map((agent) => ({ agent })) }) } };
  const dispose = createPlugin({ startWatcher: false })(server);
  dispose.setPaseo(paseo);
  return { dispose };
}

test("send to a closed losing lead redirects to the live winner; a lone closed lead resumes in place", async () => {
  const home = mkdtempSync(join(os.tmpdir(), "vs-closed-send-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = home;
  writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", paths: [], lanes: [{ id: "vibesquad", name: "VibeSquad" }] }] }), "utf8");
  try {
    const mk = (id, over = {}) => ({ id, title: id, cwd: REPO_ROOT, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "lead" }, ...over });
    const loser = mk("rn-lost", { status: "closed", resumable: true, createdAt: "2026-11-01T00:00:00.000Z" });
    const winner = mk("rn-live", { createdAt: "2026-11-02T00:00:00.000Z" });

    const { dispose } = pluginHarness([loser, winner], home);
    const r = await dispose.sendAgentPrompt({ agentId: "rn-lost", senderAgentId: "worker-9", prompt: "Report" });
    assert.equal(r.redirected, true);
    assert.equal(r.agentId, "rn-live");
    dispose();

    // lone closed resumable lead: no successor -> no redirect (the runner resumes it)
    const { dispose: d2 } = pluginHarness([loser], home);
    const lone = await d2.sendAgentPrompt({ agentId: "rn-lost", senderAgentId: "worker-9", prompt: "Report" });
    assert.equal(lone, undefined, "a lone closed resumable lead is not redirected (resume in place)");
    d2();
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
