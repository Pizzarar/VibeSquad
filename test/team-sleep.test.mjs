// B11a (docs/lanes/boring-mode): project folders + Active/Asleep. Folder model + validation, PATCH /api/teams folder ops, and
// the automated-waker gates (idle-lane kick, schedules, token watch, watch sets, restart-request drain asks, tester cards).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_FOLDERS,
  applyFolderOp,
  asleepTeamIds,
  foldersOf,
  isTeamAsleep,
  patchTeamsRegistryAsync,
  readTeamsConfig,
  validateFoldersBody,
  validateTeamsBody,
  writeTeamsRegistryAsync,
} from "../server/teams-file.mjs";
import * as identity from "../server/identity.mjs";
import { isTeamAsleep as isTeamAsleepTs, foldersOf as foldersOfTs } from "../src/teams.ts";
import { createIdleLaneKick, kickText } from "../server/idle-lane-kick.mjs";
import { createSchedulesStore } from "../server/schedules.mjs";
import { startTokenWatcher } from "../server/token-watch.mjs";
import { addWatch, createWatchEngine } from "../server/watch-sets.mjs";
import { dropAsleepLeads, stepRequest } from "../server/restart-request.mjs";
import { _deliverTesterCardForTest, createVibesquadMiddleware } from "../server/vibesquad-api.mjs";
import { readInboxCards, writeInboxCards } from "../server/inbox.mjs";
import { createPlugin } from "../server/hooks/agent-duties.ts";
import { LEGACY_USER_TYPE } from "../server/user-settings.mjs";
import { ownerHeaders } from "./helpers/local-owner.mjs";

const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_IGNORE_HOME_TEAMS"];
const MIN = 60_000;
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2), "utf8");

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-team-sleep-"));
    const repo = join(dir, "repo");
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(repo, { recursive: true });
    mkdirSync(vsHome, { recursive: true });
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.VIBESQUAD_HOME = vsHome;
    const teamsFile = join(vsHome, "teams.json");
    try {
      await fn({ dir, repo, vsHome, teamsFile });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}

async function withServer(rootDir, fn) {
  const srv = createServer(createVibesquadMiddleware(rootDir));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ---- model ----------------------------------------------------------------------------------------------------------

test("isTeamAsleep: unfoldered, active folder, asleep folder, unknown folder/team, default Backlog seed", () => {
  const folders = [{ name: "Active", asleep: false }, { name: "Parked", asleep: true }];
  const teams = [
    { id: "a" },
    { id: "b", folder: "Active" },
    { id: "C", folder: "Parked" },
    { id: "d", folder: "Nope" },
    { id: "e", folder: "Backlog" },
  ];
  const cfg = { teams, folders };
  for (const fn of [isTeamAsleep, isTeamAsleepTs, identity.isTeamAsleep]) {
    assert.equal(fn("a", cfg), false, "no folder = awake");
    assert.equal(fn("b", cfg), false, "active folder");
    assert.equal(fn("c", cfg), true, "asleep folder, case-insensitive id");
    assert.equal(fn(teams[2], cfg), true, "team object form");
    assert.equal(fn("d", cfg), false, "unknown folder = awake");
    assert.equal(fn("zzz", cfg), false, "unknown team = awake");
    assert.equal(fn("", cfg), false);
    assert.equal(fn("e", { teams }), true, "no folders key: the default Backlog is asleep");
    assert.equal(fn("e", cfg), false, "explicit folders without Backlog: unknown = awake");
  }
  assert.deepEqual(DEFAULT_FOLDERS, [{ name: "Backlog", asleep: true }]);
  const a = foldersOf({});
  a.push({ name: "x", asleep: false });
  assert.deepEqual(foldersOf({}), [{ name: "Backlog", asleep: true }], "fresh copy each call");
  assert.deepEqual(foldersOfTs(null), [{ name: "Backlog", asleep: true }]);
  assert.deepEqual([...asleepTeamIds(cfg)], ["c"]);
});

test("validation: team.folder and folders[]", () => {
  validateTeamsBody([{ id: "a", folder: "Backlog" }]);
  assert.throws(() => validateTeamsBody([{ id: "a", folder: 3 }]), /bad folder/);
  assert.throws(() => validateTeamsBody([{ id: "a", folder: "" }]), /bad folder/);
  assert.throws(() => validateTeamsBody([{ id: "a", folder: " " }]), /bad folder/);
  assert.throws(() => validateTeamsBody([{ id: "a", folder: " A" }]), /bad folder/, "untrimmed, like a folder name");
  validateTeamsBody([{ id: "a", folder: "x".repeat(64) }]);
  assert.throws(() => validateTeamsBody([{ id: "a", folder: "x".repeat(65) }]), /bad folder/, "same 64 cap as a folder name");
  validateFoldersBody([{ name: "A", asleep: false }, { name: "B", asleep: true }]);
  assert.throws(() => validateFoldersBody({}), /array/);
  assert.throws(() => validateFoldersBody([{ name: "A", asleep: "no" }]), /boolean/);
  assert.throws(() => validateFoldersBody([{ name: " ", asleep: true }]), /bad folder name/);
  assert.throws(() => validateFoldersBody([{ name: " A", asleep: true }]), /bad folder name/);
  assert.throws(() => validateFoldersBody([{ name: "x".repeat(65), asleep: true }]), /bad folder name/);
  assert.throws(() => validateFoldersBody([{ name: "A", asleep: true }, { name: "A", asleep: false }]), /duplicate/);
  assert.throws(() => validateFoldersBody(Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, asleep: false }))), /too many/);
});

test("applyFolderOp is pure and covers every op", () => {
  const teams = [{ id: "a", folder: "X" }, { id: "b" }];
  const folders = [{ name: "X", asleep: false }];
  const snap = JSON.stringify({ teams, folders });
  assert.equal(applyFolderOp({ op: "createFolder", name: "X" }, teams, folders).status, 409);
  assert.deepEqual(applyFolderOp({ op: "createFolder", name: " Y " }, teams, folders).folders.at(-1), { name: "Y", asleep: false });
  const ren = applyFolderOp({ op: "renameFolder", name: "X", newName: "Z" }, teams, folders);
  assert.deepEqual(ren.folders, [{ name: "Z", asleep: false }]);
  assert.equal(ren.teams[0].folder, "Z");
  const del = applyFolderOp({ op: "deleteFolder", name: "X" }, teams, folders);
  assert.deepEqual(del.folders, []);
  assert.equal("folder" in del.teams[0], false);
  assert.equal(applyFolderOp({ op: "setFolderAsleep", name: "X", asleep: "yes" }, teams, folders).status, 400);
  assert.equal(applyFolderOp({ op: "setTeamFolder", teamId: "b", folder: "Nope" }, teams, folders).status, 404);
  assert.equal(applyFolderOp({ op: "setTeamFolder", teamId: "nope", folder: "X" }, teams, folders).status, 404);
  assert.equal(applyFolderOp({ op: "explode" }, teams, folders).status, 400);
  assert.equal(JSON.stringify({ teams, folders }), snap, "inputs untouched");
});

test(
  "teams-file round-trip: PUT keeps folders when omitted, writes them when given; readTeamsConfig sees a write at once",
  withEnv(async ({ repo, teamsFile }) => {
    writeJson(teamsFile, { teams: [{ id: "a", folder: "Backlog" }], extra: 1 });
    assert.equal(readTeamsConfig(repo).folders[0].name, "Backlog", "no folders key: default");
    assert.equal(isTeamAsleep("a", readTeamsConfig(repo)), true);
    let r = await writeTeamsRegistryAsync({ teams: [{ id: "a", folder: "Backlog" }], folders: [{ name: "Backlog", asleep: false }] }, repo);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.folders, [{ name: "Backlog", asleep: false }]);
    assert.equal(isTeamAsleep("a", readTeamsConfig(repo)), false, "cache invalidated by the write");
    r = await writeTeamsRegistryAsync({ teams: [{ id: "a", folder: "Backlog" }, { id: "b" }] }, repo);
    assert.equal(r.status, 200);
    const saved = readJson(teamsFile);
    assert.deepEqual(saved.folders, [{ name: "Backlog", asleep: false }], "omitted folders are preserved");
    assert.equal(saved.extra, 1);
    await assert.rejects(writeTeamsRegistryAsync({ teams: [], folders: [{ name: "x" }] }, repo), /boolean/);
  }),
);

// ---- API ------------------------------------------------------------------------------------------------------------

test(
  "PATCH /api/teams: create, rename (teams follow), toggle asleep, move team, delete (teams cleared), validation, owner-only",
  withEnv(async ({ repo, teamsFile }) => {
    writeJson(teamsFile, { teams: [{ id: "alpha", name: "A", lanes: [] }, { id: "beta", name: "B", lanes: [] }] });
    await withServer(repo, async (base) => {
      const patch = (body, headers = ownerHeaders({ "content-type": "application/json" })) =>
        fetch(`${base}/api/teams`, { method: "PATCH", headers, body: JSON.stringify(body) });
      const get = await fetch(`${base}/api/teams`, { headers: ownerHeaders() });
      const g = await get.json();
      assert.deepEqual(g.folders, [{ name: "Backlog", asleep: true }], "GET carries the default folders");

      let r = await patch({ op: "createFolder", name: "Active" });
      assert.equal(r.status, 200);
      let body = await r.json();
      assert.deepEqual(body.folders, [{ name: "Backlog", asleep: true }, { name: "Active", asleep: false }]);
      assert.equal((await patch({ op: "createFolder", name: "Active" })).status, 409, "duplicate");
      assert.equal((await patch({ op: "createFolder", name: "" })).status, 400);

      r = await patch({ op: "setTeamFolder", teamId: "alpha", folder: "Active" });
      assert.equal(r.status, 200);
      assert.equal((await patch({ op: "setTeamFolder", teamId: "alpha", folder: "Missing" })).status, 404);
      assert.equal((await patch({ op: "setTeamFolder", teamId: "ghost", folder: "Active" })).status, 404);
      await patch({ op: "setTeamFolder", teamId: "beta", folder: "Active" });

      r = await patch({ op: "renameFolder", name: "Active", newName: "Now" });
      assert.equal(r.status, 200);
      body = await r.json();
      assert.deepEqual(body.teams.map((t) => t.folder), ["Now", "Now"]);
      assert.equal((await patch({ op: "renameFolder", name: "Now", newName: "Backlog" })).status, 409);
      assert.equal((await patch({ op: "renameFolder", name: "Ghost", newName: "X" })).status, 404);

      r = await patch({ op: "setFolderAsleep", name: "Now", asleep: true });
      assert.equal(r.status, 200);
      assert.equal(isTeamAsleep("alpha", readTeamsConfig(repo)), true);
      assert.equal((await patch({ op: "setFolderAsleep", name: "Now" })).status, 400);

      r = await patch({ op: "setTeamFolder", teamId: "beta", folder: null });
      body = await r.json();
      assert.equal("folder" in body.teams[1], false, "null clears the team's folder");

      r = await patch({ op: "deleteFolder", name: "Now" });
      body = await r.json();
      assert.equal(r.status, 200);
      assert.equal("folder" in body.teams[0], false, "teams in a deleted folder are unfoldered");
      assert.deepEqual(body.folders, [{ name: "Backlog", asleep: true }]);

      assert.equal((await patch({ op: "createFolder", name: "Z", revision: "stale" })).status, 409, "stale revision");

      const before = readFileSync(teamsFile, "utf8");
      const anon = await patch({ op: "createFolder", name: "Sneaky" }, { "content-type": "application/json" });
      assert.equal(anon.status, 403, "no owner proof: refused");
      assert.equal(readFileSync(teamsFile, "utf8"), before, "file untouched");

      // PUT keeps the folders it is not sent and validates the ones it is.
      const put = await fetch(`${base}/api/teams`, { method: "PUT", headers: ownerHeaders({ "content-type": "application/json" }), body: JSON.stringify({ teams: readJson(teamsFile).teams, folders: [{ name: "x" }] }) });
      assert.equal(put.status, 400);
    });
  }),
);

// ---- waker gates ----------------------------------------------------------------------------------------------------

test(
  "DONE-CHECK idle-lane-kick: an asleep Squad's idle lane with open work gets no kick; waking the folder kicks on the next tick",
  withEnv(async ({ repo, teamsFile }) => {
    const TEAMS = [{ id: "vs", name: "VS", folder: "Parked", lanes: [{ id: "vs", hub: true }, { id: "bug" }] }];
    writeJson(teamsFile, { teams: TEAMS, folders: [{ name: "Parked", asleep: true }] });
    let t = 1_000_000;
    const sent = [];
    const ag = (id, role, lane) => ({ id, status: "idle", labels: { role, team: "vs", lane } });
    const kick = createIdleLaneKick({
      rootDir: repo,
      teams: () => TEAMS,
      listAgents: async () => [ag("L", "lead", "bug"), ag("OV", "lead", "vs")],
      send: async (id, text) => sent.push({ id, text }),
      log: () => {},
      now: () => t,
      armedOwners: async () => new Set(),
      openNeedsYou: () => false,
      openWork: () => ["unit-x: do thing"],
    });
    await kick.tick();
    t += 11 * MIN;
    assert.deepEqual(await kick.tick(), []);
    t += 30 * MIN;
    assert.deepEqual(await kick.tick(), [], "still asleep: no kick, no escalation");
    assert.equal(sent.length, 0);
    const w = await patchTeamsRegistryAsync({ op: "setFolderAsleep", name: "Parked", asleep: false }, repo);
    assert.equal(w.status, 200);
    t += 1000;
    const r = await kick.tick();
    assert.deepEqual(r.map((x) => x.action), ["kick"], "woken: the very next tick kicks");
    assert.deepEqual(sent, [{ id: "L", text: kickText("unit-x: do thing") }]);
  }),
);

test("schedules: a timer fire for an asleep Squad is skipped and its cadence advances; run-once still goes; wake resumes", async () => {
  const home = mkdtempSync(join(tmpdir(), "vs-team-sleep-sch-"));
  try {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const calls = [];
    const backend = { async createAgent(a) { calls.push(a); return { id: "rn-1" }; }, async sendAgentPrompt() {} };
    let cfg = { teams: [{ id: "game", folder: "Backlog" }] };
    const store = createSchedulesStore({ home, backend, now: () => clock.t, resolveIdentity: async () => ({ team: "game", lane: "l" }), teamsConfig: () => cfg });
    const s = store.create({ prompt: "go", cadence: { type: "every", everyMs: MIN }, target: { type: "new-agent", config: { provider: "claude", cwd: "/x" } } });
    clock.t += MIN;
    await store.tick();
    assert.equal(calls.length, 0, "asleep: nothing spawned");
    const after = store.get(s.id);
    assert.equal(Date.parse(after.nextRunAt), clock.t + MIN, "cadence advanced");
    assert.equal(after.runCount ?? 0, 0, "a skip is not a run");
    const logs = readFileSync(join(home, "schedule-logs", `${s.id}.jsonl`), "utf8");
    assert.match(logs, /"skipped":"asleep"/);
    await store.runOnce(s.id);
    assert.equal(calls.length, 1, "manual run-once is the owner's action: goes through");
    cfg = { teams: [{ id: "game" }] };
    clock.t += MIN;
    await store.tick();
    assert.equal(calls.length, 2, "awake: the timer fires again");
    store.stop();
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("token watch: an asleep Squad's lead gets no nudge or handoff", async () => {
  const sent = [];
  const created = [];
  const runner = {
    subscribeEvents: () => () => {},
    async sendAgentPrompt(id, text) { sent.push({ id, text }); },
    async createAgent(p) { created.push(p); return { id: "x" }; },
    async updateAgent() {},
    async fetchAgent() { return { agent: null }; },
  };
  let asleep = true;
  const w = startTokenWatcher({ runner, coordinator: { evaluateLead: async () => { sent.push({ id: "coord" }); } }, isAsleep: () => asleep });
  const lead = { id: "rn-lead", status: "idle", labels: { role: "lead", team: "t", lane: "l" }, lastUsage: { contextWindowUsedTokens: 999_999 } };
  assert.deepEqual(await w.evaluate(lead), { role: "skip", asleep: true });
  assert.equal(sent.length + created.length, 0);
  asleep = false;
  await w.evaluate(lead);
  assert.deepEqual(sent, [{ id: "coord" }], "awake: the coordinator runs");
  w.stop();
});

test("watch sets: an asleep Squad's ping is held unattempted and delivered after a wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-team-sleep-watch-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const T0 = Date.parse("2026-11-10T12:00:00.000Z");
    const iso = (ms) => new Date(ms).toISOString();
    const { id } = addWatch({ owner: "lead-1", team: "game", lane: "game", items: [{ kind: "agent", ref: "w-1" }] }, { home, now: T0 });
    const clock = { t: T0 };
    const delivered = [];
    let asleep = true;
    const engine = createWatchEngine({
      home,
      tmpdir: join(dir, "tmp"),
      now: () => clock.t,
      alive: () => false,
      deliver: (d) => { delivered.push(d); engine.markAttempted([d.key], d.owner); },
      retryMs: 0,
      asleep: (team) => asleep && team === "game",
    });
    engine.start();
    engine.onRunnerEvent({ kind: "status", agentId: "w-1", agent: { id: "w-1", status: "running", labels: { role: "worker" } } });
    engine.onLogEntry("game", { ts: iso(T0 + 1000), agent: "w-1", lane: "game", type: "done", text: "PASS: shipped", refs: [] });
    engine.onRunnerEvent({ kind: "status", agentId: "w-1", agent: { id: "w-1", status: "idle", labels: { role: "worker" } } });
    clock.t = T0 + 2000;
    await engine.tick();
    await engine.tick();
    assert.equal(delivered.length, 0, "asleep: held");
    assert.ok(engine.get(id).pings.length >= 1, "the set fired its ping");
    assert.ok(engine.get(id).pings.every((p) => !p.attemptedAt), "not marked attempted");
    asleep = false;
    await engine.tick();
    assert.equal(delivered.length, 1, "awake: delivered once");
    await engine.tick();
    assert.equal(delivered.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("restart-request: asleep leads with nothing running get no drain ask and no lift-hold send", () => {
  const teams = [{ id: "game", lanes: [{ id: "g" }] }, { id: "vs", lanes: [{ id: "v" }] }];
  const leads = [{ leadId: "L-game", team: "game", lane: "g" }, { leadId: "L-vs", team: "vs", lane: "v" }];
  const asleep = new Set(["game"]);
  assert.deepEqual(dropAsleepLeads(leads, [], teams, asleep).map((l) => l.leadId), ["L-vs"]);
  const running = [{ id: "w", status: "running", labels: { role: "worker", team: "game", lane: "g" } }];
  assert.deepEqual(dropAsleepLeads(leads, running, teams, asleep).map((l) => l.leadId), ["L-game", "L-vs"], "running work still drains");
  assert.deepEqual(dropAsleepLeads(leads, [], teams, asleep, { byLead: { "L-game": [{ agentId: "w" }] } }).map((l) => l.leadId), ["L-game", "L-vs"], "held work still drains");
  assert.equal(dropAsleepLeads(leads, [], teams, new Set()), leads);

  const now = Date.parse("2026-11-21T12:00:00Z");
  const req = { id: "rr-1", state: "requested", tip: "abc1234", requestedBy: "owner", deadline: new Date(now + 30 * MIN).toISOString(), createdAt: new Date(now).toISOString() };
  const acts = stepRequest(req, { now, leads: dropAsleepLeads(leads, [], teams, asleep), asleep });
  assert.deepEqual(acts.filter((a) => a.kind === "ask").map((a) => a.leadId), ["L-vs"]);
  // A lead asked before its Squad fell asleep is not woken to lift the hold when the request closes.
  const closed = { ...req, state: "aborted", abortReason: "test", asked: { "L-game": { team: "game", lane: "g" }, "L-vs": { team: "vs", lane: "v" } }, gone: {}, drained: {} };
  const sends = stepRequest(closed, { now, asleep }).filter((a) => a.kind === "send").map((a) => a.leadId);
  assert.deepEqual(sends, ["L-vs"]);
});

test("schedules: an asleep skip that lands past expiresAt finishes the schedule at once", async () => {
  const home = mkdtempSync(join(tmpdir(), "vs-team-sleep-exp-"));
  try {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const calls = [];
    const backend = { async createAgent(a) { calls.push(a); return { id: "rn-1" }; }, async sendAgentPrompt() {} };
    const cfg = { teams: [{ id: "game", folder: "Backlog" }] };
    let lateBy = 0; // the clock moves while fire() resolves the target team (tick's own expiry sweep already ran)
    const resolveIdentity = async () => {
      clock.t += lateBy;
      return { team: "game", lane: "l" };
    };
    const store = createSchedulesStore({ home, backend, now: () => clock.t, resolveIdentity, teamsConfig: () => cfg });
    const s = store.create({
      prompt: "go",
      cadence: { type: "every", everyMs: MIN },
      expiresAt: new Date(clock.t + 150_000).toISOString(),
      target: { type: "new-agent", config: { provider: "claude", cwd: "/x" } },
    });
    clock.t += MIN;
    await store.tick();
    assert.equal(store.get(s.id).status, "active", "not yet expired: still active");
    clock.t += MIN; // due again (t=120s), still before expiresAt (150s) when tick() sweeps
    lateBy = 40_000; // ...but past it by the time the asleep skip is written
    await store.tick();
    const after = store.get(s.id);
    assert.equal(after.status, "completed", "skip past expiresAt: finished, not left active");
    assert.equal(after.nextRunAt, null);
    assert.equal(calls.length, 0, "asleep: never ran");
    store.stop();
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test(
  "tester cards: an asleep Squad's tester report is parked undelivered; the owner's own playtest report still delivers",
  withEnv(async ({ repo, teamsFile }) => {
    const TEAMS = [{ id: "game", name: "Game", folder: "Parked", lanes: [{ id: "game", hub: true }, { id: "game-bugs", name: "Bugs", kind: "bug" }] }];
    writeJson(teamsFile, { teams: TEAMS, folders: [{ name: "Parked", asleep: true }] });
    const card = (id) => ({ id, teamId: "game", laneId: "game-bugs", title: `report ${id}`, text: "door clips", scope: "other", status: "parked" });
    writeInboxCards([card("idea-1"), card("idea-2")]);
    const buddy = { id: "rn-buddy", title: "Buddy", status: "idle", cwd: repo, labels: { team: "game", lane: "game-bugs", role: "brainstorm" } };
    const prompts = [];
    const client = { async fetchAgents() { return [buddy]; }, async listAgents() { return [buddy]; }, async sendAgentPrompt(id, text) { prompts.push({ id, text }); } };

    const parked = await _deliverTesterCardForTest("idea-1", repo, client, { teamId: "game" });
    assert.deepEqual(parked, { delivered: false, reason: "Squad asleep", agentId: null });
    assert.equal(prompts.length, 0, "nothing sent");
    assert.equal(readInboxCards().find((c) => c.id === "idea-1").deliveredAt, undefined, "card kept undelivered");

    const owner = await _deliverTesterCardForTest("idea-2", repo, client, { teamId: "game", ownerPlaytest: true });
    assert.equal(owner.delivered, true, JSON.stringify(owner));
    assert.equal(owner.reason, undefined);
    assert.equal(owner.agentId, "rn-buddy");
    assert.deepEqual(prompts.map((p) => p.id), ["rn-buddy"]);
    assert.ok(readInboxCards().find((c) => c.id === "idea-2").deliveredAt, "owner playtest card delivered");
  }),
);

// ---- agent-duties lead wakes (server/hooks/agent-duties.ts) -----------------------------------------------------------

const DUTIES_CWD = "/projects/VibeSquad";
const dutyAgent = (id, role, extra = {}) => ({ id, title: id, cwd: DUTIES_CWD, status: "idle", provider: "claude", labels: { team: "vibesquad", lane: "vibesquad", role, ...extra } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function withDutiesEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-team-sleep-duties-"));
    const home = join(dir, "home");
    const tmp = join(dir, "tmp");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    const teamsFile = join(home, "teams.json");
    writeJson(teamsFile, { teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] });
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.VIBESQUAD_HOME = home;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    try {
      await fn({ dir, home, tmp });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}

function dutiesHarness(sb, agents, sleep) {
  const sent = [];
  const on = new Map();
  const server = { before: () => () => {}, on: (name, fn) => (on.set(name, fn), () => on.delete(name)) };
  const stop = createPlugin({
    startWatcher: false,
    briefRoot: sb.dir,
    debounceMs: 20,
    retryBaseMs: 10,
    leadWakeCooldownMs: 40,
    firstPromptRedeliverMs: 60_000,
    setLabels: async () => {},
    archiveAgent: async () => {},
    teamAsleep: (team) => sleep.asleep && team === "vibesquad",
    watchSets: { home: sb.home, tmpdir: sb.tmp, retryMs: 0 },
  })(server);
  const paseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => (agents.has(id) ? { agent: agents.get(id) } : null),
        send: async (text) => void sent.push({ to: id, text }),
        archive: async () => {},
        detach: async () => {},
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
      list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })) }),
    },
  };
  stop.setPaseo(paseo);
  let n = 0;
  const writeLog = (entries) => {
    mkdirSync(join(sb.home, "teams", "vibesquad"), { recursive: true });
    const lines = entries.map((e) => JSON.stringify({ ts: new Date(Date.now() + ++n).toISOString(), lane: "vibesquad", refs: [], ...e }) + "\n");
    appendFileSync(join(sb.home, "teams", "vibesquad", "log.jsonl"), lines.join(""));
    stop.scanLogs(false);
  };
  const turnEnded = (agent, kind = "completed") => on.get("agent.turn_ended")({ agent, turnId: `t-${++n}`, outcome: { kind } }, { paseo });
  return { stop, sent, on, paseo, watch: stop.watchSets, writeLog, turnEnded };
}

test(
  "agent-duties: an asleep Squad's lead gets no log-line wake and no former-lead relay; owner you/legacy lines still wake it",
  withDutiesEnv(async (sb) => {
    const sleep = { asleep: true };
    const agents = new Map([["lead-1", dutyAgent("lead-1", "lead")], ["old-1", dutyAgent("old-1", "former-lead")]]);
    const h = dutiesHarness(sb, agents, sleep);
    try {
      h.writeLog([
        { agent: "w-1", type: "done", text: "PASS: asleep done" },
        { agent: "w-2", type: "blocker", text: "asleep blocker" },
        { agent: "w-3", type: "needs-you", text: "asleep needs-you" },
      ]);
      await h.turnEnded(agents.get("old-1")); // relayFromFormerLead
      await wait(150);
      assert.deepEqual(h.sent, [], "asleep: no agent log wake, no relay");

      h.writeLog([{ agent: "owner", type: "you", text: "owner ping" }, { agent: "owner", type: LEGACY_USER_TYPE, text: "legacy ping" }]);
      await wait(150);
      assert.equal(h.sent.length, 1, JSON.stringify(h.sent));
      assert.equal(h.sent[0].to, "lead-1");
      assert.match(h.sent[0].text, /legacy ping \(\+1 more\)/, "both owner lines, nothing else");
      assert.doesNotMatch(h.sent[0].text, /asleep/);

      sleep.asleep = false; // control: the same relay wakes an awake Squad's lead
      await h.turnEnded(agents.get("old-1"));
      await wait(150);
      assert.equal(h.sent.length, 2, JSON.stringify(h.sent));
      assert.match(h.sent[1].text, /Relayed from former lead/);
    } finally {
      h.stop();
    }
  }),
);

test(
  "agent-duties: wakes buffered before the Squad fell asleep (debounce queue, held for a running lead) are dropped; owner lines pass",
  withDutiesEnv(async (sb) => {
    const sleep = { asleep: false };
    const lead = dutyAgent("lead-1", "lead");
    const agents = new Map([["lead-1", lead]]);
    const h = dutiesHarness(sb, agents, sleep);
    try {
      // dispatchWakes: the entry is in the debounce queue when the folder goes to sleep.
      h.writeLog([{ agent: "w-1", type: "done", text: "PASS: debounced" }]);
      sleep.asleep = true;
      await wait(150);
      assert.deepEqual(h.sent, [], "debounce-queued wake dropped");

      // flushWake: held in pendingWake while the lead runs, then the folder sleeps before the lead goes idle.
      sleep.asleep = false;
      lead.status = "running";
      h.writeLog([{ agent: "w-2", type: "done", text: "PASS: held while running" }]);
      await wait(150);
      assert.deepEqual(h.sent, [], "lead running: held");
      sleep.asleep = true;
      lead.status = "idle";
      h.writeLog([{ agent: "owner", type: "you", text: "owner while asleep" }]);
      await wait(150);
      assert.equal(h.sent.length, 1, JSON.stringify(h.sent));
      assert.match(h.sent[0].text, /\[you\] owner while asleep\./, "only the owner line, no (+N more)");
      assert.doesNotMatch(h.sent[0].text, /held while running/);
    } finally {
      h.stop();
    }
  }),
);

test(
  "agent-duties: a watch ping held for a running lead when the Squad sleeps is dropped unattempted and re-offered after the wake",
  withDutiesEnv(async (sb) => {
    const sleep = { asleep: false };
    const lead = dutyAgent("lead-1", "lead");
    lead.status = "running";
    const agents = new Map([["lead-1", lead], ["w-1", dutyAgent("w-1", "worker")]]);
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: Date.now() - 1000 });
    const h = dutiesHarness(sb, agents, sleep);
    try {
      h.writeLog([{ agent: "w-1", type: "done", text: "PASS: w1 shipped" }]);
      await h.watch.tick();
      await wait(100);
      assert.deepEqual(h.sent, [], "lead running: ping held in pendingWake");
      assert.ok(h.watch.get(id).pings.length >= 1, "the set fired its ping");

      sleep.asleep = true;
      lead.status = "idle";
      await h.turnEnded(lead, "canceled"); // the lead's turn ends: flushWake runs while asleep
      await h.watch.tick();
      await wait(150);
      assert.deepEqual(h.sent, [], "asleep: not sent");
      assert.ok(h.watch.get(id).pings.every((p) => !p.attemptedAt), "dropped WITHOUT markAttempted");

      sleep.asleep = false;
      await h.watch.tick();
      await wait(150);
      const pings = h.sent.filter((s) => s.to === "lead-1" && s.text.includes(`Watch ${id}`));
      assert.equal(pings.length, 1, JSON.stringify(h.sent));
      assert.ok(h.watch.get(id).pings[0].attemptedAt, "attempted once delivered after the wake");
    } finally {
      h.stop();
    }
  }),
);
