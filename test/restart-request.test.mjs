// idea-347: the server-side restart request state machine (server/restart-request.mjs). Temp VIBESQUAD_HOME only: nothing
// here touches the real runner, server or ~/.vibesquad, and fire() is a fake (the real one runs `vs restart`).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const rtEnv = (lad) => ({ LOCALAPPDATA: lad, VIBESQUAD_RUNTIME_DIR: path.join(lad, "VibeSquad", "runtime") }); // pins the runtime dir on every OS
import os from "node:os";
import path from "node:path";
import {
  abortRestartRequest,
  createRestartRequest,
  createRestartRequestLoop,
  formatRequestStatus,
  readRestartRequest,
  needsBuild,
  requestAskText,
  requestPath,
  notUpdatedNote,
  fitLog,
  LOG_MAX,
  runSyncAsync,
  runVsAsync,
  runtimeLagAsync,
  syncFeedbackText,
  syncRepoRoot,
  stepRequest,
  tipMatches,
} from "../server/restart-request.mjs";
import { commandRestartRequest } from "../cli/vs.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-rr-")); dirs.push(d); return d; };

const TEAMS = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "bug-chaser" }, { id: "ui" }] }];
const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const MIN = 60_000;
const TIP = "abc1234def";
const ag = (id, lane, role, extra = {}) => ({ id, title: `${id} · t`, status: "idle", cwd: "", labels: { team: "vibesquad", lane, role, ...extra }, createdAt: "2026-11-19T00:00:00Z" });
const OVE = ag("rn-ove", "vibesquad", "lead");
const BUG = ag("rn-bug", "bug-chaser", "lead");
const UI = ag("rn-ui", "ui", "lead");
const W1 = ag("rn-w1", "ui", "worker", { "vs.parent": "rn-ui" });

function logLine(home, agent, text, ms) {
  const dir = path.join(home, "teams", "vibesquad");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ ts: new Date(ms).toISOString(), agent, lane: "x", type: "metric", text: `restart-feedback: ${text}` }) + "\n");
}
function writeResult(home, startMs, rec) {
  const at = new Date(startMs).toISOString();
  writeFileSync(path.join(home, `restart-${at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: at, finishedAt: at, dryRun: false, errors: [], ...rec }));
}

/** A loop on `home` with a settable clock, agent list and held list; records every vs call and fire. */
function world(home, { agents = [OVE, BUG, UI], held = null, fireResult = { ok: true } } = {}) {
  const w = { now: T0, agents, held, calls: [], fires: 0, fireResult };
  w.loop = () => createRestartRequestLoop({
    home,
    teams: () => TEAMS,
    now: () => w.now,
    listAgents: async () => w.agents,
    heldList: async () => w.held,
    runVs: async (args) => { w.calls.push(args); return { ok: true }; },
    fire: async () => { w.fires++; return w.fireResult; },
  });
  w.sends = () => w.calls.filter((c) => c[0] === "send");
  w.logs = () => w.calls.filter((c) => c[0] === "log").map((c) => c[2]);
  return w;
}
const request = (home, extra = {}) => createRestartRequest(home, { tip: TIP, requestedBy: "rn-ove", team: "vibesquad", lane: "vibesquad", needs: "server-restart", urgent: true, now: T0, ...extra }); // idea-674: the immediate path; queued windows are tested below

test("all leads drain -> fires exactly once -> restart-done logged and sent", async () => {
  const home = tmp();
  const w = world(home);
  request(home);
  const loop = w.loop();
  assert.equal((await loop.tick()).state, "draining");
  const asks = w.sends();
  assert.deepEqual(asks.map((c) => c[1]).sort(), ["rn-bug", "rn-ui"], "every live lead but the requesting Overlord is asked");
  assert.match(asks[0][2], new RegExp(`vs log restart-feedback 'drained restart ${TIP}'`));
  assert.ok(!/["`]/.test(asks[0][2]), "the ask pastes into a shell");
  let req = readRestartRequest(home);
  assert.ok(req.asked["rn-bug"].sentAt && req.asked["rn-ui"].sentAt);

  w.now = T0 + 2 * MIN;
  logLine(home, "rn-bug", `drained restart ${TIP.slice(0, 7)}`, w.now); // short hash matches
  assert.equal((await loop.tick()).state, "draining", "one lead still out");
  assert.equal(w.fires, 0);
  assert.equal(w.sends().length, 2, "asks are never re-sent");

  w.now = T0 + 3 * MIN;
  logLine(home, "rn-ui", "drained restart", w.now); // a bare drain after the request counts
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(w.fires, 1);
  req = readRestartRequest(home);
  assert.equal(req.readyReason, "all-drained");
  assert.equal(req.launch.ok, true);
  assert.ok(w.logs().some((t) => /ready: all 2 asked lead\(s\) drained/.test(t)));

  for (let i = 0; i < 3; i++) { w.now += MIN; await loop.tick(); }
  assert.equal(w.fires, 1, "firing waits for the result; never fires twice");
  assert.equal(readRestartRequest(home).state, "firing");

  writeResult(home, w.now, { ok: true });
  w.now += MIN;
  assert.equal((await loop.tick()).state, "done");
  assert.ok(w.logs().some((t) => t === `restart-done ${TIP} (restart-request ${req.id})`));
  const done = w.sends().slice(2);
  assert.deepEqual(done.map((c) => c[1]).sort(), ["rn-bug", "rn-ui"]);
  assert.match(done[0][2], /^restart-done: /);
  const n = w.calls.length;
  await loop.tick();
  await loop.tick();
  assert.equal(w.calls.length, n, "a finished request notifies once");
  assert.equal(w.fires, 1);
  assert.ok(w.calls.filter((c) => c[0] === "log").every((c) => c.includes("--team") && c.includes("vibesquad")), "logged in the requester's lane");
});

test("deadline passes -> fires once with the laggards logged", async () => {
  const home = tmp();
  const w = world(home);
  request(home, { deadlineMin: 10 });
  const loop = w.loop();
  await loop.tick();
  w.now = T0 + MIN;
  logLine(home, "rn-bug", `drained restart ${TIP}`, w.now);
  await loop.tick();
  w.now = T0 + 9 * MIN;
  assert.equal((await loop.tick()).state, "draining");
  w.now = T0 + 10 * MIN;
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(w.fires, 1);
  const req = readRestartRequest(home);
  assert.equal(req.readyReason, "deadline");
  assert.deepEqual(req.laggards.map((l) => l.leadId), ["rn-ui"]);
  assert.ok(w.logs().some((t) => /deadline passed; firing vs restart for abc1234def anyway.*not drained: ui lead rn-ui/.test(t)), w.logs().join("\n"));
  w.now += MIN;
  await loop.tick();
  assert.equal(w.fires, 1);
  assert.match(formatRequestStatus(readRestartRequest(home), w.now), /fired at the deadline without: ui lead rn-ui/);
});

test("duplicate drained entries, other tips and non-asked agents change nothing", async () => {
  const home = tmp();
  const w = world(home);
  const { id } = request(home);
  const loop = w.loop();
  await loop.tick();
  logLine(home, "rn-ui", `drained restart ${TIP}`, T0 - 10 * MIN); // before the request (append-only log: written first)
  w.now = T0 + MIN;
  logLine(home, "rn-bug", `drained restart ${TIP}`, w.now);
  logLine(home, "rn-bug", `drained restart ${TIP}`, w.now + 1000);
  logLine(home, "rn-ui", "drained restart 9999999fff", w.now); // another tip: not this request
  logLine(home, "rn-w1", `drained restart ${TIP}`, w.now); // a worker was never asked
  await loop.tick();
  await loop.tick();
  const req = readRestartRequest(home);
  assert.deepEqual(Object.keys(req.drained), ["rn-bug"]);
  assert.equal(req.drained["rn-bug"], new Date(T0 + MIN).toISOString(), "first drain wins");
  assert.equal(req.events.filter((e) => /rn-bug.*drained/.test(e.text)).length, 1);
  assert.equal(req.state, "draining");
  assert.equal(w.fires, 0);
  assert.equal(req.id, id);
  assert.equal(tipMatches("abc1234", "abc1234def"), true);
  assert.equal(tipMatches("abc12", "abc1234def"), false, "under 7 chars is not a hash prefix");
});

test("server restart mid-draining: a new loop resumes from the file, no re-asks, earlier drains count", async () => {
  const home = tmp();
  const w = world(home);
  request(home);
  await w.loop().tick();
  w.now = T0 + MIN;
  logLine(home, "rn-bug", `drained restart ${TIP}`, w.now);
  // The server dies here (before any tick saw rn-bug's drain); a fresh process builds a new loop.
  w.now = T0 + 2 * MIN;
  logLine(home, "rn-ui", `drained restart ${TIP}`, w.now);
  w.now = T0 + 3 * MIN;
  const loop2 = w.loop();
  assert.equal((await loop2.tick()).state, "firing");
  assert.equal(w.sends().length, 2, "the two asks of the first process only");
  assert.equal(w.fires, 1);
  // ...and dies again right after the fire was persisted: the next process never fires again.
  w.now += MIN;
  await w.loop().tick();
  await w.loop().tick();
  assert.equal(w.fires, 1);
  assert.equal(readRestartRequest(home).state, "firing");
});

test("dead leads count as drained; a new lead is asked; held background work blocks and is named (idea-369)", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: { "rn-w1": [{ pid: 4242, cmd: "bash tools/run_suite.sh --full" }] } } });
  request(home);
  const loop = w.loop();
  await loop.tick();
  const uiAsk = w.sends().find((c) => c[1] === "rn-ui")[2];
  assert.match(uiAsk, /runner holds background work in your lane right now: rn-w1 \(pid 4242: bash tools\/run_suite\.sh --full\)/);
  assert.deepEqual(w.sends().map((c) => c[1]), ["rn-ui"], "idea-402: rn-bug's lane holds nothing: auto-drained, not prompted");
  // rn-bug dies; a successor lead in bug-chaser appears: its lane holds nothing either, so it is auto-drained too.
  const BUG2 = ag("rn-bug2", "bug-chaser", "lead");
  w.agents = [OVE, BUG2, UI, W1];
  w.now = T0 + MIN;
  logLine(home, "rn-ui", `drained restart ${TIP}`, w.now);
  await loop.tick();
  let req = readRestartRequest(home);
  assert.ok(req.gone["rn-bug"], "the dead lead counts as drained");
  assert.ok(req.asked["rn-bug2"]?.auto && req.drained["rn-bug2"], "the successor is auto-drained");
  assert.match(formatRequestStatus(req, w.now), /ui lead rn-ui \(rn-ui\): drained .*; runner holds rn-w1/);
  w.now = T0 + 2 * MIN;
  assert.equal((await loop.tick()).state, "draining", "rn-ui drained but the runner still holds rn-w1's suite");
  w.held = { ids: [], work: {} };
  w.now = T0 + 3 * MIN;
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(w.fires, 1);
  writeResult(home, w.now, { ok: true });
  w.now += MIN;
  await loop.tick();
  req = readRestartRequest(home);
  assert.equal(req.state, "done");
  assert.deepEqual(w.sends().slice(1).map((c) => c[1]), ["rn-ui"], "done goes to the prompted lead only: not the dead lead, not the auto-drained successor");
});

test("a refused launch or a deferred restart aborts the request; it is never fired again", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE], fireResult: { ok: false, error: "vs restart: refused: drain guard" } });
  request(home);
  const loop = w.loop();
  assert.equal((await loop.tick()).state, "firing", "no other lead: ready at once");
  assert.equal(w.fires, 1);
  w.now += MIN;
  assert.equal((await loop.tick()).state, "aborted");
  assert.match(readRestartRequest(home).abortReason, /did not launch: vs restart: refused/);
  await loop.tick();
  assert.equal(w.fires, 1);

  const home2 = tmp();
  const w2 = world(home2, { agents: [OVE] });
  request(home2);
  const l2 = w2.loop();
  await l2.tick();
  writeResult(home2, w2.now - 5 * MIN, { ok: true }); // an older restart is not this request's result
  writeResult(home2, w2.now, { ok: false, deferred: { held: 1 }, errors: ["deferred: 1 agent(s) still hold background work"] });
  w2.now += MIN;
  assert.equal((await l2.tick()).state, "aborted");
  assert.match(readRestartRequest(home2).abortReason, /deferred on background work/);
  assert.ok(w2.logs().some((t) => /aborted: the restart deferred/.test(t)));
});

test("abort: an open request ends, the asked leads are told once; a new request may follow", async () => {
  const home = tmp();
  const w = world(home);
  request(home);
  const loop = w.loop();
  await loop.tick();
  assert.throws(() => request(home), /still draining/);
  abortRestartRequest(home, { by: "rn-ove", reason: "tip superseded", now: T0 + MIN });
  await loop.tick();
  await loop.tick();
  const notes = w.sends().slice(2);
  assert.deepEqual(notes.map((c) => c[1]).sort(), ["rn-bug", "rn-ui"]);
  assert.match(notes[0][2], /was aborted: aborted by rn-ove: tip superseded/);
  assert.equal(w.fires, 0);
  assert.throws(() => abortRestartRequest(home), /no open restart request/);
  const next = request(home, { tip: "fff0000aaa" });
  assert.equal(next.state, "requested");
  assert.equal(JSON.parse(readFileSync(requestPath(home), "utf8")).history.length, 1);
});

test("requested with the runner unreachable until the deadline aborts without firing", () => {
  const req = { id: "rr-x", tip: TIP, requestedBy: "owner", createdAt: new Date(T0).toISOString(), deadline: new Date(T0 + 5 * MIN).toISOString(), state: "requested" };
  assert.deepEqual(stepRequest(req, { now: T0 + MIN, leads: null }), []);
  const acts = stepRequest(req, { now: T0 + 5 * MIN, leads: null });
  assert.equal(req.state, "aborted");
  assert.deepEqual(acts.map((a) => a.kind), ["log"]);
});

test("vs restart request/abort: Overlord or owner only; status is read-only for anyone", async () => {
  const home = tmp();
  const env = { VIBESQUAD_HOME: home, VS_AGENT_ID: "rn-abcdef123456" };
  const as = (role, lane) => ({ role, lane, team: { id: "vibesquad" } });
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    await assert.rejects(commandRestartRequest({ _: ["request", TIP] }, { identity: as("worker", "ui"), teams: TEAMS, env }), /only the owner or the Overlord/);
    await assert.rejects(commandRestartRequest({ _: ["request", TIP] }, { identity: as("lead", "bug-chaser"), teams: TEAMS, env }), /only the owner or the Overlord/, "a lane lead is not the Overlord");
    await assert.rejects(commandRestartRequest({ _: ["request", TIP] }, { identity: as("brainstorm", "vibesquad"), teams: TEAMS, env }), /only the owner/);
    await assert.rejects(commandRestartRequest({ _: ["request", TIP] }, { teams: TEAMS, env: { VIBESQUAD_HOME: home }, hasOwnerProof: () => false }), /no owner proof/);
    assert.equal(readRestartRequest(home), null, "nothing recorded by a refused caller");
    await assert.rejects(commandRestartRequest({ _: ["request", "bad\"tip"] }, { identity: as("lead", "vibesquad"), teams: TEAMS, env }), /<tip> must be/);
    await assert.rejects(commandRestartRequest({ _: ["request", TIP], deadline: "0" }, { identity: as("lead", "vibesquad"), teams: TEAMS, env }), /--deadline/);
    assert.equal(await commandRestartRequest({ _: ["request", TIP], deadline: "45", needs: "server-restart" }, { identity: as("lead", "vibesquad"), teams: TEAMS, env, now: () => T0 }), 0);
    const req = readRestartRequest(home);
    assert.equal(req.requestedBy, "rn-abcdef123456");
    assert.deepEqual([req.team, req.lane, req.deadlineMin, req.needs], ["vibesquad", "vibesquad", 45, "server-restart"]);
    assert.equal(await commandRestartRequest({ _: ["status"] }, { teams: TEAMS, env: { VIBESQUAD_HOME: home, VS_AGENT_ID: "rn-worker000001" }, now: () => T0 }), 0, "a worker may read status");
    assert.match(out.join(""), /restart request rr-\S+: queued \(tip abc1234def, needs server-restart/);
    await assert.rejects(commandRestartRequest({ _: ["abort"] }, { identity: as("worker", "ui"), teams: TEAMS, env }), /only the owner or the Overlord/);
    assert.equal(await commandRestartRequest({ _: ["abort"] }, { teams: TEAMS, env: { VIBESQUAD_HOME: home }, hasOwnerProof: () => true }), 0, "the owner may abort");
    assert.equal(readRestartRequest(home).state, "aborted");
    assert.match(readRestartRequest(home).abortReason, /aborted by owner/);
  } finally {
    process.stdout.write = write;
  }
});

// ---- idea-370 / idea-371 ----------------------------------------------------------------------------------------------

test("idea-370: a plain vs restart warns (stderr, not blocking) while a request is requested/draining/ready, and is silent otherwise", async () => {
  const { commandRestart } = await import("../cli/vs.mjs");
  const home = tmp();
  const base = { env: { VIBESQUAD_HOME: home }, teams: TEAMS, hasOwnerProof: () => true, drainGuard: () => ({ pending: [] }), heldList: async () => null, spawnFn: () => 4321, confirmStart: null };
  const run = async () => {
    const err = [];
    const e0 = process.stderr.write; const o0 = process.stdout.write;
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    process.stdout.write = () => true;
    try { await commandRestart({}, base); } finally { process.stderr.write = e0; process.stdout.write = o0; }
    return err.join("");
  };
  assert.doesNotMatch(await run(), /restart request/, "no request: no warning");
  const req = request(home);
  const warned = await run();
  assert.ok(warned.includes(`warning: restart request ${req.id} (tip ${TIP}) is requested`), warned);
  assert.match(warned, /goes ahead anyway/, "not blocking");
  abortRestartRequest(home, { by: "owner", now: T0 });
  assert.doesNotMatch(await run(), /restart request/, "a finished request does not warn");
});

test("idea-371 L2: the ask states the minutes LEFT at ask time, not the initial duration", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG] });
  request(home, { deadlineMin: 30 });
  const loop = w.loop();
  w.now = T0 + 20 * MIN;
  await loop.tick();
  assert.match(w.sends()[0][2], /\(~10 min\)/, "asked 20 min into a 30 min window");
  assert.doesNotMatch(w.sends()[0][2], /~30 min/);
  assert.match(readRestartRequest(home).events.map((e) => e.text).join("|"), /drain asks/);
});

test("idea-371 L2: a lead that appears mid-window is asked once, with the remaining time", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG] });
  request(home, { deadlineMin: 30 });
  const loop = w.loop();
  await loop.tick();
  w.agents = [OVE, BUG, UI];
  w.now = T0 + 25 * MIN;
  await loop.tick();
  const ui = w.sends().filter((c) => c[1] === "rn-ui");
  assert.equal(ui.length, 1);
  assert.match(ui[0][2], /\(~5 min\)/);
  w.now = T0 + 26 * MIN;
  await loop.tick();
  assert.equal(w.sends().filter((c) => c[1] === "rn-ui").length, 1, "never re-sent");
});

test("idea-371 L1: scope=all (default) asks every Squad and says so; --team-only asks only the requester's Squad", async () => {
  const other = { ...ag("rn-oth", "x", "lead"), labels: { team: "other", lane: "x", role: "lead" } };
  const teams2 = [...TEAMS, { id: "other", name: "Other", hub: "x", lanes: [{ id: "x" }] }];
  const mk = (home) => {
    const w = world(home, { agents: [OVE, BUG, other] });
    const loop = createRestartRequestLoop({ home, teams: () => teams2, now: () => w.now, listAgents: async () => w.agents, heldList: async () => null, runVs: async (a) => { w.calls.push(a); return { ok: true }; }, fire: async () => ({ ok: true }) });
    return { w, loop };
  };
  const h1 = tmp();
  const a = mk(h1);
  const r1 = request(h1);
  assert.equal(r1.scope, "all");
  await a.loop.tick();
  assert.deepEqual(a.w.sends().map((c) => c[1]).sort(), ["rn-bug", "rn-oth"], "all Squads asked by default");
  assert.match(a.w.sends()[0][2], /all Squads are asked: the restart is machine-wide/);
  assert.match(formatRequestStatus(readRestartRequest(h1), T0), /all Squads/);

  const h2 = tmp();
  const b = mk(h2);
  const r2 = request(h2, { scope: "team" });
  await b.loop.tick();
  assert.deepEqual(b.w.sends().map((c) => c[1]), ["rn-bug"], "only the requester's Squad");
  assert.match(b.w.sends()[0][2], /Squad vibesquad only/);
  assert.match(formatRequestStatus(readRestartRequest(h2), T0), /vibesquad Squad only/);
  assert.equal(Object.keys(readRestartRequest(h2).asked).includes("rn-oth"), false, "an out-of-scope lead is never asked, so never a laggard");
  assert.throws(() => request(tmp(), { scope: "bogus" }), /scope must be/);
  assert.equal(r2.scope, "team");
});

test("idea-371 L1: vs restart request --team-only records scope=team", async () => {
  const home = tmp();
  const out = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await commandRestartRequest({ _: ["request", TIP], teamOnly: true }, { teams: TEAMS, env: { VIBESQUAD_HOME: home }, hasOwnerProof: () => true, now: () => T0 });
  } finally { process.stdout.write = out; }
  assert.equal(readRestartRequest(home).scope, "team");
});

// idea-398 (PLAN_INBOX_TOP3_1120 T2): --needs build syncs (and rebuilds) right before the fire, or logs sync-skipped visibly.
function buildWorld(home, syncResult) {
  const w = { now: T0, order: [], calls: [], syncs: 0 };
  w.loop = createRestartRequestLoop({
    home,
    teams: () => TEAMS,
    now: () => w.now,
    listAgents: async () => [OVE, BUG],
    heldList: async () => null,
    runVs: async (args) => { w.calls.push(args); return { ok: true }; },
    sync: async () => { w.syncs++; w.order.push("sync"); if (syncResult instanceof Error) throw syncResult; return syncResult; },
    fire: async () => { w.order.push("fire"); return { ok: true }; },
    runtimeLag: async () => ({ sha: "1111111aaaabbbb", behind: 3 }),
  });
  w.logs = () => w.calls.filter((c) => c[0] === "log").map((c) => c[2]);
  return w;
}
async function driveToFire(home, w) {
  await w.loop.tick();
  w.now = T0 + MIN;
  logLine(home, "rn-bug", `drained restart ${TIP}`, w.now);
  await w.loop.tick();
}

test("idea-398: --needs build syncs once, after the drain and right before the fire, and logs it", async () => {
  const home = tmp();
  const w = buildWorld(home, { ok: true, commit: `${TIP}0000`, built: true });
  request(home, { needs: "build, server-restart" });
  await w.loop.tick();
  assert.equal(w.syncs, 0, "no sync while leads are still draining");
  await driveToFire(home, w);
  assert.deepEqual(w.order, ["sync", "fire"]);
  const req = readRestartRequest(home);
  assert.equal(req.state, "firing");
  assert.equal(req.sync.ok, true);
  assert.equal(req.sync.built, true);
  const line = w.logs().find((t) => /synced the runtime/.test(t));
  assert.ok(line.startsWith(`restart-request ${req.id} synced the runtime to ${TIP.slice(0, 7)} (dist rebuilt) before vs restart (needs build)`), line);
  assert.ok(!/not the requested tip/.test(line));
  assert.match(formatRequestStatus(req, w.now), /synced .*runtime at abc1234 \(dist rebuilt\)/);
  w.now += MIN;
  await w.loop.tick();
  assert.equal(w.syncs, 1, "never synced twice");
});

test("idea-398: a sync that does not run logs sync-skipped reason=... and still fires once", async () => {
  for (const [res, why] of [
    [{ ok: false, reason: "skipped: working tree not clean (server/a.mjs)" }, /^sync-skipped .*reason skipped: working tree not clean \(server\/a\.mjs\)$/],
    [new Error("spawn EPERM"), /^sync-skipped .*reason spawn EPERM$/],
  ]) {
    const home = tmp();
    const w = buildWorld(home, res);
    request(home, { needs: "build" });
    await driveToFire(home, w);
    assert.deepEqual(w.order, ["sync", "fire"]);
    const line = w.logs().find((t) => /sync-skipped/.test(t));
    assert.match(line ?? "", why);
    assert.match(line, /vs restart fires anyway: runtime NOT updated: still 1111111, 3 behind abc1234def, reason /);
    const req = readRestartRequest(home);
    assert.equal(req.sync.ok, false);
    assert.match(formatRequestStatus(req, w.now), /sync-skipped reason=/);
    assert.ok(req.events.some((e) => /sync-skipped reason=/.test(e.text)));
  }
});

// Hub13 fix round: the 11-20 02:54 silent old-code restart. After a skipped sync the restart still fires, but the
// restart-done line, the leads' done message and a needs-you in the Overlord's lane all say the runtime was NOT updated.
test("idea-398: a skipped sync -> needs-you to the Overlord, and the restart-done line says runtime NOT updated", async () => {
  const home = tmp();
  const w = buildWorld(home, { ok: false, reason: "skipped: working tree not clean (server/a.mjs)" });
  request(home, { needs: "build,server-restart" });
  await driveToFire(home, w);
  const note = "runtime NOT updated: still 1111111, 3 behind abc1234def, reason skipped: working tree not clean (server/a.mjs)";
  const req = readRestartRequest(home);
  assert.equal(req.sync.note, note);
  const ny = w.calls.filter((c) => c[0] === "log" && c[1] === "needs-you");
  assert.equal(ny.length, 1, "one needs-you");
  assert.ok(ny[0][2].includes(note), ny[0][2]);
  assert.deepEqual(ny[0].slice(3), ["--team", "vibesquad", "--lane", "vibesquad"], "logged in the requesting Overlord's lane");
  const toOve = w.calls.filter((c) => c[0] === "send" && c[1] === "rn-ove");
  assert.equal(toOve.length, 1, "the requesting Overlord is told directly");
  assert.ok(toOve[0][2].includes(note));
  assert.ok(w.logs().find((t) => /sync-skipped/.test(t)).includes(note));
  assert.ok(formatRequestStatus(req, w.now).includes(note));

  w.now = T0 + 3 * MIN;
  writeResult(home, T0 + 2 * MIN, { ok: true });
  assert.equal((await w.loop.tick()).state, "done");
  const done = w.logs().find((t) => t.startsWith("restart-done"));
  assert.ok(done, w.logs().join("\n"));
  assert.ok(done.endsWith(`(restart-request ${req.id}); ${note}`), done);
  const leadDone = w.calls.filter((c) => c[0] === "send" && c[1] === "rn-bug").at(-1);
  assert.ok(leadDone[2].includes(note), leadDone[2]);
  assert.equal(w.calls.filter((c) => c[0] === "log" && c[1] === "needs-you").length, 1, "needs-you is not repeated at done");
});

test("idea-398: a long skip reason still fits vs log's 240-char limit, so neither the needs-you nor the done line is lost", async () => {
  const home = tmp();
  const reason = `skipped: working tree not clean (${Array.from({ length: 30 }, (_, i) => `server/file-${i}.mjs`).join(", ")})`;
  const w = buildWorld(home, { ok: false, reason });
  request(home, { needs: "build" });
  await driveToFire(home, w);
  w.now = T0 + 3 * MIN;
  writeResult(home, T0 + 2 * MIN, { ok: true });
  await w.loop.tick();
  const logs = w.calls.filter((c) => c[0] === "log");
  for (const c of logs) {
    const stored = c[1] === "restart-feedback" ? `restart-feedback: ${c[2]}` : c[2];
    assert.ok(stored.length <= LOG_MAX, `${stored.length}: ${stored}`);
  }
  const head = "runtime NOT updated: still 1111111, 3 behind abc1234def, reason skipped: working tree not clean (server/file-0.mjs";
  assert.ok(logs.find((c) => c[1] === "needs-you")[2].includes(head));
  assert.ok(w.logs().find((t) => t.startsWith("restart-done")).includes(head));
  assert.ok(w.logs().find((t) => t.startsWith("sync-skipped")).includes(head));
  assert.equal(fitLog("x".repeat(300)).length, LOG_MAX);
  assert.equal(fitLog("short"), "short");
});

test("idea-398: a clean sync adds no NOT-updated note and no needs-you; the owner as requester gets no send", async () => {
  const home = tmp();
  const w = buildWorld(home, { ok: true, commit: TIP, built: false });
  request(home, { needs: "build", requestedBy: "owner" });
  await driveToFire(home, w);
  w.now = T0 + 3 * MIN;
  writeResult(home, T0 + 2 * MIN, { ok: true });
  await w.loop.tick();
  assert.ok(!w.calls.some((c) => c[1] === "needs-you"));
  assert.ok(!w.calls.some((c) => JSON.stringify(c).includes("NOT updated")));
  assert.equal(notUpdatedNote({ tip: "master", reason: "x" }), "runtime NOT updated: still ?, ? behind master, reason x");
});

test("idea-398: runtimeLagAsync counts the commits between the runtime build-stamp and the tip", async () => {
  const { execFileSync } = await import("node:child_process");
  const repo = tmp();
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (const n of [1, 2, 3, 4]) { writeFileSync(path.join(repo, "f.txt"), String(n)); git("add", "."); git("commit", "-qm", `c${n}`); }
  const old = git("rev-parse", "HEAD~3");
  const lad = tmp();
  mkdirSync(path.join(lad, "VibeSquad", "runtime"), { recursive: true });
  writeFileSync(path.join(lad, "VibeSquad", "runtime", "build-stamp.json"), JSON.stringify({ commit: old, repo: path.join(repo, ".git") }));
  assert.deepEqual(await runtimeLagAsync({ tip: "master" }, { env: rtEnv(lad) }), { sha: old, behind: 3 });
  assert.deepEqual(await runtimeLagAsync({ tip: "nope-branch" }, { env: rtEnv(lad) }), { sha: old, behind: null });
  assert.deepEqual(await runtimeLagAsync({ tip: "master" }, { env: rtEnv(tmp()) }), { sha: null, behind: null });
});

test("idea-398: without the build token no sync runs; a synced HEAD that is not the requested tip is named", async () => {
  const home = tmp();
  const w = buildWorld(home, { ok: true, commit: "fffffff1234", built: false });
  request(home, { needs: "server-restart,runner-restart" });
  await driveToFire(home, w);
  assert.deepEqual(w.order, ["fire"]);
  assert.equal(readRestartRequest(home).sync, undefined);
  assert.equal(needsBuild("server-restart build"), true);
  assert.equal(needsBuild("rebuild,frontend-reload"), false);
  const req = { id: "rr-x", tip: TIP };
  assert.match(syncFeedbackText(req, { ok: true, commit: "fffffff1234" }), /HEAD fffffff is not the requested tip abc1234def/);
  assert.ok(!/not the requested tip/.test(syncFeedbackText({ id: "rr-x", tip: "master" }, { ok: true, commit: "fffffff1234" })), "a branch tip is not compared");
});

test("idea-398: runSyncAsync reads the real sync-runtime outcome; syncRepoRoot comes from the runtime build-stamp", async () => {
  const lad = tmp();
  assert.equal(syncRepoRoot(rtEnv(lad)), null);
  assert.match((await runSyncAsync({ env: rtEnv(lad) })).reason, /no build-stamp\.json/);
  const runtime = path.join(lad, "VibeSquad", "runtime");
  mkdirSync(runtime, { recursive: true });
  const repo = path.resolve(import.meta.dirname, "..");
  writeFileSync(path.join(runtime, "build-stamp.json"), JSON.stringify({ commit: TIP, repo: path.join(repo, ".git") }));
  assert.equal(syncRepoRoot(rtEnv(lad)), repo);
  // The real script, run as a child. Sync now creates a missing runtime dir (first sync on a fresh machine), so it must never
  // run against a real checkout here: a copy of server/ + runner/ in a temp repo on a unit branch hits the skip guard on any branch,
  // and VIBESQUAD_RUNTIME_DIR pins any runtime it could touch to a temp dir (LOCALAPPDATA alone is ignored off win32).
  const copy = tmp();
  for (const d of ["server", "runner"]) cpSync(path.join(repo, d), path.join(copy, d), { recursive: true });
  execFileSync("git", ["-C", copy, "init", "-q", "-b", "unit-x"]);
  const env = { ...process.env, LOCALAPPDATA: tmp(), VIBESQUAD_HOME: tmp(), VIBESQUAD_RUNTIME_DIR: path.join(tmp(), "runtime"), npm_lifecycle_event: "" };
  const r = await runSyncAsync({ env, repoRoot: copy });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^skipped: .+/);
  assert.ok(!existsSync(env.VIBESQUAD_RUNTIME_DIR), "a skipped sync creates no runtime dir");
});

test("idea-477: the ask text says the runner already refuses new background shells until restart-done", () => {
  const req = { id: "rr-1", tip: "abc1234", requestedBy: "lead", deadline: new Date(Date.now() + 600000).toISOString() };
  assert.match(requestAskText(req, { leadId: "l1" }, []), /runner already refuses new background shells until the restart is done/);
});

test("idea-572: runVsAsync runs `node vs.mjs` through the off-loop exec with agent identity stripped; same result contract", async () => {
  const seen = [];
  const exec = async (file, args, opts) => {
    seen.push({ file, args, opts });
    return seen.length === 1 ? { ok: true, out: "  sent\n", err: "", code: 0 } : seen.length === 2 ? { ok: false, out: "", err: "boom", code: 2 } : seen.length === 3 ? { ok: false, out: "", err: "", code: null, msg: "spawn EPERM" } : Promise.reject(new Error("worker gone"));
  };
  const env = { PATH: "x", VS_AGENT_ID: "a1", PASEO_AGENT_ID: "p1", VS_AGENT_TOKEN: "t", VS_ROLE: "lead", KEEP: "1" };
  assert.deepEqual(await runVsAsync(["send", "lead-1", "hi"], { env, exec }), { ok: true, out: "sent" });
  assert.equal(seen[0].file, process.execPath);
  assert.equal(path.basename(seen[0].args[0]), "vs.mjs");
  assert.deepEqual(seen[0].args.slice(1), ["send", "lead-1", "hi"]);
  assert.equal(seen[0].opts.timeoutMs, 60_000);
  assert.deepEqual(Object.keys(seen[0].opts.env).sort(), ["KEEP", "PATH"], "agent identity stripped, the rest kept");
  assert.equal(env.VS_AGENT_ID, "a1", "caller env untouched");
  assert.deepEqual(await runVsAsync(["log"], { env, exec, timeoutMs: 5 }), { ok: false, error: "boom" });
  assert.equal(seen[1].opts.timeoutMs, 5);
  assert.deepEqual(await runVsAsync(["log"], { env, exec }), { ok: false, error: "spawn EPERM" });
  assert.deepEqual(await runVsAsync(["log"], { env, exec }), { ok: false, error: "worker gone" }, "never rejects");
});

// ---- idea-674: restart windows (queued state, coalescing, --urgent) ------------------------------------------------------

import {
  DEFAULT_WINDOWS_UTC,
  mergeNeeds,
  nextRestartWindow,
  parseRestartWindows,
  requestHoldsDrain,
  restartWindows,
} from "../server/restart-request.mjs";

const W13 = Date.parse("2026-11-19T13:00:00.000Z"); // T0 is 10:00Z: the next default window
const queue = (home, extra = {}) => createRestartRequest(home, { tip: TIP, requestedBy: "rn-ove", team: "vibesquad", lane: "vibesquad", needs: "server-restart", now: T0, ...extra });
/** world() plus a recording runner drain and an agent-list counter. */
function windowWorld(home) {
  const w = world(home);
  w.drainSets = [];
  w.drainClears = [];
  w.listed = 0;
  w.loop = () => createRestartRequestLoop({
    home,
    teams: () => TEAMS,
    now: () => w.now,
    listAgents: async () => { w.listed++; return w.agents; },
    heldList: async () => w.held,
    runVs: async (args) => { w.calls.push(args); return { ok: true }; },
    fire: async () => { w.fires++; return w.fireResult; },
    drain: { set: async (req) => { w.drainSets.push(req.id); }, clear: async (id) => { w.drainClears.push(id); } },
  });
  return w;
}

test("idea-674: windows parse strictly (garbage -> default), VS_RESTART_WINDOWS overrides, nextRestartWindow is strictly future", () => {
  assert.deepEqual([...DEFAULT_WINDOWS_UTC], ["13:00", "21:00"]);
  assert.deepEqual(parseRestartWindows("21:00, 9:30,09:30"), ["09:30", "21:00"], "sorted, zero-padded, de-duplicated");
  for (const bad of ["", " , ", "25:00", "12:60", "noon", "13:00,x", "1300", "13:00:00", "-1:00"]) assert.equal(parseRestartWindows(bad), null, bad);
  assert.deepEqual(restartWindows({}), ["13:00", "21:00"]);
  assert.deepEqual(restartWindows({ VS_RESTART_WINDOWS: "06:15,18:45" }), ["06:15", "18:45"]);
  assert.deepEqual(restartWindows({ VS_RESTART_WINDOWS: "13:00,garbage" }), ["13:00", "21:00"], "one bad entry: the whole default");
  const at = (s) => Date.parse(`2026-11-19T${s}Z`);
  const next = (ms, w) => new Date(nextRestartWindow(ms, w)).toISOString();
  assert.equal(next(at("10:00:00.000")), "2026-11-19T13:00:00.000Z");
  assert.equal(next(at("12:59:59.999")), "2026-11-19T13:00:00.000Z");
  assert.equal(next(at("13:00:00.000")), "2026-11-19T21:00:00.000Z", "a window exactly now is not 'next'");
  assert.equal(next(at("21:00:00.000")), "2026-11-20T13:00:00.000Z", "past the last window: tomorrow's first");
  assert.equal(next(at("23:59:00.000")), "2026-11-20T13:00:00.000Z");
  assert.equal(next(Date.parse("2026-12-31T22:00:00Z")), "2027-01-01T13:00:00.000Z", "month/year roll");
  assert.equal(next(at("07:00:00.000"), ["06:15", "18:45"]), "2026-11-19T18:45:00.000Z");
  assert.equal(next(at("07:00:00.000"), ["bogus"]), "2026-11-19T13:00:00.000Z", "invalid list: default windows");
  assert.equal(mergeNeeds("server-restart", "Server-Restart"), "server-restart", "nothing new: unchanged");
  assert.equal(mergeNeeds("build, server-restart", "runner-restart build"), "build,server-restart,runner-restart");
  assert.equal(mergeNeeds("", "build"), "build");
});

test("idea-674 DC1/DC5: non-urgent -> queued for the next window; before it: no drain hold, no agent list, no ask; abort sends nothing", async () => {
  const home = tmp();
  const w = windowWorld(home);
  const req = queue(home, { deadlineMin: 20 });
  assert.equal(req.state, "queued");
  assert.equal(req.windowAt, new Date(W13).toISOString());
  assert.equal(req.urgent, false);
  assert.deepEqual(req.tips, [TIP]);
  assert.equal(req.deadline, new Date(W13 + 20 * MIN).toISOString(), "projected only");
  assert.equal(requestHoldsDrain(req, T0), false);
  assert.equal(requestHoldsDrain(req, W13 + MIN), false, "even past the window until the loop steps it");
  const loop = w.loop();
  for (const t of [T0, T0 + 60 * MIN, W13 - 1]) {
    w.now = t;
    assert.equal((await loop.tick()).state, "queued");
  }
  assert.equal(w.calls.length, 0, "no ask, log or send before the window");
  assert.equal(w.drainSets.length, 0, "no POST /drain/request before windowAt");
  assert.equal(w.listed, 0, "a queued request does not even read the agent list");
  // A stray bare drain before the window (from another request) must not pre-drain a lead of this one.
  logLine(home, "rn-bug", "drained restart", T0 + 30 * MIN);
  const status = formatRequestStatus(readRestartRequest(home), T0);
  assert.match(status, /: queued \(tip abc1234def, needs server-restart, .*window 2026-11-19T13:00:00\.000Z \(in 3h 00m\), drain deadline 20 min after the window opens\)/);
  assert.match(status, /queued: no lead is asked/);
  abortRestartRequest(home, { by: "rn-ove", reason: "not needed", now: T0 + 70 * MIN });
  w.now = T0 + 71 * MIN;
  assert.equal((await loop.tick()).state, "aborted");
  await loop.tick();
  assert.equal(w.sends().length, 0, "abort on queued: 0 lead messages");
  assert.deepEqual(w.logs().length, 1, "one team-log abort line");
  assert.match(w.logs()[0], /aborted: aborted by rn-ove: not needed/);
  assert.equal(w.drainSets.length, 0);
  assert.equal(w.fires, 0);
});

test("idea-674 DC2: a second non-urgent request coalesces (tip latest, tips[], needs union, scope widens, deadline max)", () => {
  const home = tmp();
  const a = queue(home, { scope: "team", deadlineMin: 20 });
  const b = queue(home, { tip: "fff0000aaa", needs: "build, server-restart", now: T0 + MIN, deadlineMin: 10 });
  assert.equal(b.id, a.id, "same request, never refused");
  assert.equal(b.state, "queued");
  assert.equal(b.tip, "fff0000aaa");
  assert.deepEqual(b.tips, [TIP, "fff0000aaa"]);
  assert.equal(b.needs, "server-restart,build");
  assert.equal(b.scope, "all", "team + all -> all");
  assert.equal(b.deadlineMin, 20, "the longer drain wins");
  assert.equal(b.windowAt, a.windowAt, "the window does not move");
  const c = queue(home, { tip: TIP, now: T0 + 2 * MIN });
  assert.deepEqual(c.tips, [TIP, "fff0000aaa"], "a repeated tip is recorded once");
  assert.equal(c.tip, TIP, "tip = latest requested");
  assert.match(c.events.at(-1).text, /tip abc1234def folded in by rn-ove \(was fff0000aaa\)/);
  const h2 = tmp();
  queue(h2, { scope: "team" });
  assert.equal(queue(h2, { scope: "team", team: "other" }).scope, "all", "two Squads' team requests widen to all");
  const h3 = tmp();
  queue(h3, { scope: "team" });
  assert.equal(queue(h3, { scope: "team" }).scope, "team", "same Squad stays team");
  assert.match(formatRequestStatus(readRestartRequest(home), T0), /batched tips: abc1234def, fff0000aaa \(restarting to abc1234def\)/);
});

test("idea-674 DC3: at windowAt the loop steps queued -> requested -> draining in one tick, deadline = now + deadlineMin, asks go out", async () => {
  const home = tmp();
  const w = windowWorld(home);
  queue(home, { deadlineMin: 25 });
  queue(home, { tip: "fff0000aaa", needs: "build", deadlineMin: 10, now: T0 + MIN }); // max(25, 10) = 25
  const loop = w.loop();
  await loop.tick();
  assert.equal(w.calls.length, 0);
  logLine(home, "rn-bug", "drained restart", W13 - 5 * MIN); // before the window: not this request's drain
  const open = W13 + 7 * MIN; // the server was down at 13:00 sharp: the drain still gets its full window from now
  w.now = open;
  assert.equal((await loop.tick()).state, "draining");
  const req = readRestartRequest(home);
  assert.equal(req.requestedAt, new Date(open).toISOString());
  assert.equal(req.deadline, new Date(open + 25 * MIN).toISOString());
  assert.deepEqual(w.sends().map((c) => c[1]).sort(), ["rn-bug", "rn-ui"]);
  assert.match(w.sends()[0][2], /tip fff0000aaa, needs server-restart,build/);
  assert.match(w.sends()[0][2], /~25 min/);
  assert.ok(w.logs().some((t) => /window 2026-11-19T13:00:00\.000Z open: draining for fff0000aaa \(batched tips abc1234def, fff0000aaa\)/.test(t)));
  assert.deepEqual(w.drainSets, [req.id], "the runner drain is held from the window on");
  assert.equal(req.drained["rn-bug"], undefined, "a drain logged before the window does not count");
  assert.match(formatRequestStatus(req, open), /window 2026-11-19T13:00:00\.000Z; drain started 2026-11-19T13:07:00\.000Z/);
  w.now = open + MIN;
  logLine(home, "rn-bug", "drained restart fff0000aaa", w.now);
  logLine(home, "rn-ui", "drained restart", w.now);
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(w.fires, 1);
});

test("idea-674 DC4: --urgent drains at once; it promotes an open queued request (tips folded, fresh deadline); reason only with urgent", async () => {
  const home = tmp();
  assert.throws(() => queue(home, { reason: "why" }), /--reason is only for --urgent/);
  assert.equal(readRestartRequest(home), null);
  const u = queue(home, { urgent: true, reason: "security fix", deadlineMin: 5 });
  assert.equal(u.state, "requested");
  assert.equal(u.urgent, true);
  assert.equal(u.urgentReason, "security fix");
  assert.equal(u.deadline, new Date(T0 + 5 * MIN).toISOString());
  assert.equal(requestHoldsDrain(u, T0), true);
  assert.match(formatRequestStatus(u, T0), /requested URGENT .*\n {2}urgent: security fix/);

  const h2 = tmp();
  const w = windowWorld(h2);
  const q = queue(h2, { needs: "server-restart" });
  const p = queue(h2, { tip: "fff0000aaa", needs: "build", urgent: true, reason: "server broken", deadlineMin: 10, now: T0 + 30 * MIN });
  assert.equal(p.id, q.id, "promoted, not a second request");
  assert.equal(p.state, "requested");
  assert.deepEqual(p.tips, [TIP, "fff0000aaa"]);
  assert.equal(p.tip, "fff0000aaa");
  assert.equal(p.needs, "server-restart,build");
  assert.equal(p.urgentReason, "server broken");
  assert.equal(p.deadline, new Date(T0 + 40 * MIN).toISOString());
  assert.equal(p.requestedAt, new Date(T0 + 30 * MIN).toISOString());
  assert.match(formatRequestStatus(p, T0 + 30 * MIN), /promoted from the 2026-11-19T13:00:00\.000Z window at 2026-11-19T10:30:00\.000Z/);
  w.now = T0 + 30 * MIN;
  assert.equal((await w.loop().tick()).state, "draining", "drains immediately, not at the window");
  assert.equal(w.sends().length, 2);
  assert.equal(w.drainSets.length, 1);
});

test("idea-674: while a request is requested/draining/ready/firing both urgent and non-urgent requests are refused as before", async () => {
  const home = tmp();
  const w = windowWorld(home);
  queue(home, { urgent: true });
  assert.throws(() => queue(home), /still requested/);
  assert.throws(() => queue(home, { urgent: true, reason: "x" }), /still requested/);
  await w.loop().tick();
  assert.throws(() => queue(home), /still draining/, "a non-urgent request during a drain is refused, not queued behind it");
  assert.throws(() => queue(home, { urgent: true }), /still draining/);
  for (const state of ["ready", "firing"]) {
    const doc = JSON.parse(readFileSync(requestPath(home), "utf8"));
    doc.current.state = state;
    writeFileSync(requestPath(home), JSON.stringify(doc));
    assert.throws(() => queue(home), new RegExp(`still ${state}`));
    assert.throws(() => queue(home, { urgent: true }), new RegExp(`still ${state}`));
  }
});

test("idea-674: a queued request with no valid windowAt aborts on its first step (no ask, no drain), never drains early", () => {
  const req = { id: "rr-x", tip: TIP, requestedBy: "owner", createdAt: new Date(T0).toISOString(), state: "queued", deadlineMin: 30, asked: {} };
  const acts = stepRequest(req, { now: T0, leads: [{ leadId: "rn-bug", team: "vibesquad", lane: "bug-chaser" }] });
  assert.equal(req.state, "aborted");
  assert.deepEqual(acts.map((a) => a.kind), ["log"]);
  const q = { id: "rr-y", tip: TIP, requestedBy: "owner", createdAt: new Date(T0).toISOString(), state: "queued", windowAt: new Date(W13).toISOString(), deadlineMin: 30 };
  assert.deepEqual(stepRequest(q, { now: W13 - 1, leads: [{ leadId: "rn-bug", team: "vibesquad", lane: "bug-chaser" }] }), [], "leads passed in anyway: still no ask");
  assert.equal(q.state, "queued");
  assert.deepEqual(q.asked, {});
});

// ---- idea-674 RW2: the CLI (--urgent / --reason, output, help) -----------------------------------------------------------

test("idea-674 RW2: vs restart request queues by default and prints the window; --urgent drains now; --reason without --urgent errors", async () => {
  const { parseArgs, commandRestart } = await import("../cli/vs.mjs");
  const f = parseArgs(["restart", "request", TIP, "--urgent", "--reason", "security fix"]);
  assert.equal(f.urgent, true);
  assert.equal(f.reason, "security fix");
  const home = tmp();
  const env = { VIBESQUAD_HOME: home };
  const opts = (extra = {}) => ({ teams: TEAMS, env, hasOwnerProof: () => true, now: () => T0, ...extra });
  const cap = async (fn) => {
    const out = []; const err = [];
    const o = process.stdout.write; const e = process.stderr.write;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    try { await fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
    return { out: out.join(""), err: err.join("") };
  };
  await assert.rejects(commandRestartRequest({ _: ["request", TIP], reason: "why" }, opts()), /--reason is only for --urgent/);
  await assert.rejects(commandRestartRequest({ _: ["request", TIP], urgent: true, reason: "  " }, opts()), /--reason needs text/);
  assert.equal(readRestartRequest(home), null, "a refused --reason records nothing");

  let r = await cap(() => commandRestartRequest({ _: ["request", TIP], needs: "server-restart" }, opts()));
  assert.match(r.out, /rr-\S+ queued \(tip abc1234def, needs server-restart\) for the restart window 2026-11-19T13:00:00\.000Z \(in 3h 00m\)\. Nothing happens before then: no lead is asked/);
  assert.match(r.out, /--urgent --reason "<why>"/);
  r = await cap(() => commandRestartRequest({ _: ["request", "fff0000aaa"], needs: "build" }, opts()));
  assert.match(r.out, /updated: folded into the queued request \(tip fff0000aaa, needs server-restart,build\) .* Batched tips: abc1234def, fff0000aaa\./);
  r = await cap(() => commandRestartRequest({ _: ["status"] }, opts()));
  assert.match(r.out, /: queued \(tip fff0000aaa.*window 2026-11-19T13:00:00\.000Z \(in 3h 00m\)/);
  assert.match(r.out, /batched tips: abc1234def, fff0000aaa/);
  // A manual vs restart while queued warns that the window still fires.
  r = await cap(() => commandRestart({}, { env, teams: TEAMS, hasOwnerProof: () => true, drainGuard: () => ({ pending: [] }), heldList: async () => null, spawnFn: () => 4321, confirmStart: null }));
  assert.match(r.err, /is queued for the restart window 2026-11-19T13:00:00\.000Z; this manual restart goes ahead now, and the window will still drain/);

  r = await cap(() => commandRestartRequest({ _: ["request", "abc9999"], urgent: true, reason: "server broken" }, opts()));
  assert.match(r.out, /URGENT: promoted the queued request \(window 2026-11-19T13:00:00\.000Z\) to drain NOW \(tip abc9999, needs server-restart,build, deadline 2026-11-19T10:30:00\.000Z, reason: server broken\)/);
  const req = readRestartRequest(home);
  assert.deepEqual([req.state, req.urgent, req.urgentReason], ["requested", true, "server broken"]);
  await assert.rejects(commandRestartRequest({ _: ["request", TIP] }, opts()), /still requested/, "non-urgent during an open drain: refused as before");

  const h2 = tmp();
  r = await cap(() => commandRestartRequest({ _: ["request", TIP], urgent: true }, opts({ env: { VIBESQUAD_HOME: h2, VS_RESTART_WINDOWS: "nope" } })));
  assert.match(r.out, /URGENT: draining NOW \(tip abc1234def, deadline 2026-11-19T10:30:00\.000Z\)/);
  assert.match(r.err, /VS_RESTART_WINDOWS="nope" is not a comma list of HH:MM UTC times; using the default windows 13:00, 21:00Z/);

  const h3 = tmp();
  await cap(() => commandRestartRequest({ _: ["request", TIP] }, opts({ env: { VIBESQUAD_HOME: h3, VS_RESTART_WINDOWS: "10:30" } })));
  assert.equal(readRestartRequest(h3).windowAt, "2026-11-19T10:30:00.000Z", "VS_RESTART_WINDOWS steers the window");
  r = await cap(() => commandRestartRequest({ _: ["abort"] }, opts({ env: { VIBESQUAD_HOME: h3 } })));
  assert.match(r.out, /aborted; no lead had been asked yet, so none is messaged/);
});

test("idea-674 RW2: vs --help documents --urgent/--reason and the windows", () => {
  const src = readFileSync(new URL("../cli/vs.mjs", import.meta.url), "utf8");
  assert.match(src, /vs restart request <tip> \[--deadline <min, default 30>\] \[--needs <Live-Needs tokens>\] \[--team-only\] \[--urgent \[--reason "<why>"\]\]/);
  assert.match(src, /QUEUED for the next fixed UTC window \(13:00Z \/ 21:00Z; VS_RESTART_WINDOWS/);
});
