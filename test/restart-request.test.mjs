// idea-347: the server-side restart request state machine (server/restart-request.mjs). Temp VIBESQUAD_HOME only: nothing
// here touches the real runner, server or ~/.vibesquad, and fire() is a fake (the real one runs `vs restart`).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  abortRestartRequest,
  createRestartRequest,
  createRestartRequestLoop,
  formatRequestStatus,
  readRestartRequest,
  requestPath,
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
const request = (home, extra = {}) => createRestartRequest(home, { tip: TIP, requestedBy: "rn-ove", team: "vibesquad", lane: "vibesquad", needs: "server-restart", now: T0, ...extra });

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
  assert.ok(!/holds background work/.test(w.sends().find((c) => c[1] === "rn-bug")[2]));
  // rn-bug dies; a new lane lead rn-ui2 appears in ui? No: a new lane (bug-chaser successor) appears and is asked.
  const BUG2 = ag("rn-bug2", "bug-chaser", "lead");
  w.agents = [OVE, BUG2, UI, W1];
  w.now = T0 + MIN;
  logLine(home, "rn-ui", `drained restart ${TIP}`, w.now);
  await loop.tick();
  let req = readRestartRequest(home);
  assert.ok(req.gone["rn-bug"], "the dead lead counts as drained");
  assert.ok(req.asked["rn-bug2"], "the successor is asked");
  assert.match(formatRequestStatus(req, w.now), /ui lead rn-ui \(rn-ui\): drained .*; runner holds rn-w1/);
  w.now = T0 + 2 * MIN;
  logLine(home, "rn-bug2", `drained restart ${TIP}`, w.now);
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
  assert.ok(!w.sends().slice(3).some((c) => c[1] === "rn-bug"), "no done message to the dead lead");
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
    assert.match(out.join(""), /restart request rr-\S+: requested \(tip abc1234def, needs server-restart/);
    await assert.rejects(commandRestartRequest({ _: ["abort"] }, { identity: as("worker", "ui"), teams: TEAMS, env }), /only the owner or the Overlord/);
    assert.equal(await commandRestartRequest({ _: ["abort"] }, { teams: TEAMS, env: { VIBESQUAD_HOME: home }, hasOwnerProof: () => true }), 0, "the owner may abort");
    assert.equal(readRestartRequest(home).state, "aborted");
    assert.match(readRestartRequest(home).abortReason, /aborted by owner/);
  } finally {
    process.stdout.write = write;
  }
});
