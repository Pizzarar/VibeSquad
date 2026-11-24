// idea-402: restart request auto-drain (a lead whose lane the runner holds no work for is drained by the server, never
// prompted, and not woken by the close notice). idea-604: a lane whose only holders have no shell listed yet (held until
// their first probe) does not prompt its lead at once. Temp VIBESQUAD_HOME only; fire() and every vs call are fakes.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  abortRestartRequest,
  autoDrainVerdicts,
  createRestartRequest,
  createRestartRequestLoop,
  formatRequestStatus,
  heldListFromHealth,
  readRestartRequest,
  stepRequest,
  UNPROBED_ASK_GRACE_MS,
} from "../server/restart-request.mjs";
import { drainedLogRefusal, heldShells, laneHolders } from "../server/restart-coord.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-rad-")); dirs.push(d); return d; };

const TEAMS = [{ id: "vibesquad", name: "VibeSquad", hub: "vibesquad", lanes: [{ id: "vibesquad" }, { id: "bug-chaser" }, { id: "ui" }] }];
const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const MIN = 60_000;
const TIP = "abc1234def";
const ag = (id, lane, role, extra = {}) => ({ id, title: `${id} · t`, status: "idle", cwd: "", labels: { team: "vibesquad", lane, role, ...extra }, createdAt: "2026-11-19T00:00:00Z" });
const OVE = ag("rn-ove", "vibesquad", "lead");
const BUG = ag("rn-bug", "bug-chaser", "lead");
const UI = ag("rn-ui", "ui", "lead");
const W1 = ag("rn-w1", "ui", "worker", { "vs.parent": "rn-ui" });
const NO_HELD = () => ({ ids: [], work: {} });
const SUITE = { "rn-w1": [{ pid: 4242, cmd: "bash tools/run_suite.sh --full" }] };

function logLine(home, agent, text, ms) {
  const dir = path.join(home, "teams", "vibesquad");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ ts: new Date(ms).toISOString(), agent, lane: "x", type: "metric", text: `restart-feedback: ${text}` }) + "\n");
}
function writeResult(home, startMs, rec) {
  const at = new Date(startMs).toISOString();
  writeFileSync(path.join(home, `restart-${at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: at, finishedAt: at, dryRun: false, errors: [], ...rec }));
}
function world(home, { agents = [OVE, BUG, UI], held = null, heldList = null, listAgentsWithArchived = undefined } = {}) {
  const w = { now: T0, agents, held, calls: [], fires: 0 };
  w.loop = () => createRestartRequestLoop({
    home,
    teams: () => TEAMS,
    now: () => w.now,
    listAgents: async () => w.agents,
    heldList: heldList ?? (async () => w.held),
    ...(listAgentsWithArchived !== undefined ? { listAgentsWithArchived } : {}),
    runVs: async (args) => { w.calls.push(args); return { ok: true }; },
    fire: async () => { w.fires++; return { ok: true }; },
  });
  w.sends = () => w.calls.filter((c) => c[0] === "send");
  w.logs = () => w.calls.filter((c) => c[0] === "log").map((c) => c[2]);
  return w;
}
const request = (home, extra = {}) => createRestartRequest(home, { tip: TIP, requestedBy: "rn-ove", team: "vibesquad", lane: "vibesquad", needs: "server-restart", urgent: true, now: T0, ...extra }); // idea-674: the immediate path (non-urgent queues for a window)

test("idea-402: leads whose lanes hold nothing are auto-drained, never prompted, and not woken by restart-done", async () => {
  const home = tmp();
  const w = world(home, { held: NO_HELD() });
  const { id } = request(home);
  const loop = w.loop();
  assert.equal((await loop.tick()).state, "firing", "every lead auto-drained: fires on the first tick");
  assert.equal(w.fires, 1);
  assert.equal(w.sends().length, 0, "no drain ask went out");
  const req = readRestartRequest(home);
  assert.ok(req.asked["rn-bug"].auto && req.asked["rn-bug"].quiet && req.drained["rn-bug"]);
  assert.ok(w.logs().some((t) => /auto-drained 2 lead\(s\), the runner holds no work in their lanes \(no prompt\): bug-chaser rn-bug, ui rn-ui/.test(t)), w.logs().join("\n"));
  assert.match(formatRequestStatus(req, w.now), /bug-chaser lead rn-bug \(rn-bug\): drained .* \(auto: runner holds no work in its lane, not prompted\)/);
  writeResult(home, w.now, { ok: true });
  w.now += MIN;
  assert.equal((await loop.tick()).state, "done");
  assert.equal(w.sends().length, 0, "restart-done is logged, not sent, to never-prompted leads");
  assert.ok(w.logs().includes(`restart-done ${TIP} (restart-request ${id}) [2 auto-drained lead(s) not woken]`), w.logs().join("\n"));
});

test("idea-402: an aborted request wakes only the prompted leads", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: SUITE } });
  request(home);
  const loop = w.loop();
  await loop.tick();
  assert.deepEqual(w.sends().map((c) => c[1]), ["rn-ui"], "only the lane holding a suite is asked");
  assert.match(w.sends()[0][2], /rn-w1 \(pid 4242: bash tools\/run_suite\.sh --full\)/, "the ask names the held work");
  abortRestartRequest(home, { by: "rn-ove", reason: "superseded", now: T0 + MIN });
  await loop.tick();
  assert.deepEqual(w.sends().map((c) => c[1]), ["rn-ui", "rn-ui"], "the abort notice goes to rn-ui only");
  assert.ok(w.logs().some((t) => /aborted \[1 auto-drained lead\(s\) not woken\]: aborted by rn-ove/.test(t)), w.logs().join("\n"));
});

test("idea-402 fail safe: an unreadable held list auto-drains nobody (every lead asked)", async () => {
  for (const heldList of [async () => null, async () => { throw new Error("runner down"); }]) {
    const home = tmp();
    const w = world(home, { heldList });
    request(home);
    assert.equal((await w.loop().tick()).state, "draining");
    assert.deepEqual(w.sends().map((c) => c[1]).sort(), ["rn-bug", "rn-ui"]);
    const req = readRestartRequest(home);
    assert.deepEqual(req.drained, {});
    assert.ok(!req.asked["rn-bug"].quiet && !req.asked["rn-bug"].auto);
  }
  const L = [{ leadId: "rn-bug", team: "vibesquad", lane: "bug-chaser" }];
  const fresh = () => ({ id: "rr-x", tip: TIP, requestedBy: "rn-ove", createdAt: new Date(T0).toISOString(), deadline: new Date(T0 + 30 * MIN).toISOString(), state: "requested" });
  // No verdict for the lead (laneHolders refused: agent list unreadable): asked.
  assert.deepEqual(stepRequest(fresh(), { now: T0, leads: L, held: { byLead: {} }, verdicts: {} }).map((a) => a.kind), ["ask"]);
  // A verdict without this tick's held list is ignored.
  assert.deepEqual(stepRequest(fresh(), { now: T0, leads: L, held: null, verdicts: { "rn-bug": { ok: true } } }).map((a) => a.kind), ["ask"]);
  assert.deepEqual(stepRequest(fresh(), { now: T0, leads: L, verdicts: { "rn-bug": { ok: true } } }).map((a) => a.kind), ["ask"]);
  // autoDrainVerdicts: no held list or agent list -> null; holders of the lane named; unprobedOnly when no shell is listed.
  assert.equal(autoDrainVerdicts(L, null, [OVE, BUG], TEAMS), null);
  assert.equal(autoDrainVerdicts(L, NO_HELD(), null, TEAMS), null);
  const BW = ag("rn-bw", "bug-chaser", "worker");
  assert.deepEqual(autoDrainVerdicts(L, { ids: ["rn-bw"], work: { "rn-bw": [] } }, [OVE, BUG, BW], TEAMS), { "rn-bug": { ok: false, ids: ["rn-bw"], unprobedOnly: true } });
  assert.deepEqual(autoDrainVerdicts(L, { ids: ["rn-w1"], work: SUITE }, [OVE, BUG, UI, W1], TEAMS), { "rn-bug": { ok: true } }, "another lane's suite does not hold this lead");
  // idea-604: no heldWork map (or no entry for the holder) is "shells unknown", never unprobed: the ask is not held off.
  assert.deepEqual(autoDrainVerdicts(L, { ids: ["rn-bw"], work: null }, [OVE, BUG, BW], TEAMS), { "rn-bug": { ok: false, ids: ["rn-bw"], unprobedOnly: false } });
  assert.deepEqual(autoDrainVerdicts(L, { ids: ["rn-bw"], work: {} }, [OVE, BUG, BW], TEAMS), { "rn-bug": { ok: false, ids: ["rn-bw"], unprobedOnly: false } });
});

test("idea-604: heldShells is the one held reading shared by the restart request and the vs restart deferral", () => {
  assert.equal(heldShells(null), null);
  assert.equal(heldShells({ work: {} }), null, "no id list: unknown");
  assert.deepEqual(heldShells({ ids: [], work: {} }), { shells: [], unprobed: [], unprobedOnly: false });
  assert.deepEqual(heldShells({ ids: ["a"], work: { a: [] } }), { shells: [], unprobed: ["a"], unprobedOnly: true });
  assert.deepEqual(heldShells({ ids: ["a", "b"], work: { a: [], b: [{ pid: 1, cmd: "npm test" }] } }), { shells: ["b"], unprobed: ["a"], unprobedOnly: false });
  assert.deepEqual(heldShells({ ids: ["a"], work: null }), { shells: ["a"], unprobed: [], unprobedOnly: false }, "no work map: held");
  assert.deepEqual(heldShells({ ids: ["a"], work: {} }), { shells: ["a"], unprobed: [], unprobedOnly: false }, "no entry: held");
  assert.deepEqual(heldShells({ ids: ["a"], work: { a: "x" } }), { shells: ["a"], unprobed: [], unprobedOnly: false }, "malformed entry: held");
  assert.deepEqual(heldShells({ ids: ["a", "b"], work: { a: [], b: [] } }, ["b"]), { shells: [], unprobed: ["b"], unprobedOnly: true }, "limited to `of`");
});

test("idea-402: laneHolders is the drainedLogRefusal check as data (one primitive for self-report and auto-drain)", () => {
  const agents = [OVE, BUG, UI, W1];
  assert.deepEqual(laneHolders("rn-ui", { held: { ids: ["rn-w1"], work: SUITE }, agents, teams: TEAMS }), { ids: ["rn-w1"] });
  assert.deepEqual(laneHolders("rn-bug", { held: { ids: ["rn-w1"], work: SUITE }, agents, teams: TEAMS }), { ids: [] });
  assert.ok(laneHolders("rn-ui", { held: null, agents, teams: TEAMS }).refusal);
  assert.ok(laneHolders("rn-ui", { held: { ids: ["rn-w1"], work: {} }, agents: null, teams: TEAMS }).refusal);
  assert.match(drainedLogRefusal("rn-ui", { held: { ids: ["rn-w1"], work: SUITE }, agents, teams: TEAMS }), /still holds background work in your lane: rn-w1 \(pid 4242: bash tools\/run_suite\.sh --full\)\. .*vs stop rn-w1 --background/);
  assert.equal(drainedLogRefusal("rn-bug", { held: { ids: ["rn-w1"], work: SUITE }, agents, teams: TEAMS }), null);
  assert.match(drainedLogRefusal("rn-bug", { held: null, agents, teams: TEAMS }), /could not be read/);
});

test("idea-402: a prompted lead whose work finishes is auto-drained without a turn, and still gets restart-done", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: SUITE } });
  request(home);
  const loop = w.loop();
  await loop.tick();
  w.now = T0 + 5 * MIN;
  assert.equal((await loop.tick()).state, "draining", "the suite still runs");
  w.held = NO_HELD();
  w.now = T0 + 6 * MIN;
  assert.equal((await loop.tick()).state, "firing", "the suite finished: rn-ui is drained by the server");
  const req = readRestartRequest(home);
  assert.ok(req.asked["rn-ui"].auto && !req.asked["rn-ui"].quiet);
  assert.equal(req.readyReason, "all-drained");
  writeResult(home, w.now, { ok: true });
  w.now += MIN;
  await loop.tick();
  assert.deepEqual(w.sends().map((c) => c[1]), ["rn-ui", "rn-ui"], "ask + restart-done (it was asked to hold suites)");
  assert.match(w.sends()[1][2], /^restart-done: /);
});

test("idea-402: auto drains need this tick's held list to fire; an auto-drained lane that gains real shells is asked", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: SUITE } });
  request(home, { deadlineMin: 10 });
  const loop = w.loop();
  await loop.tick(); // rn-bug auto, rn-ui asked
  w.now = T0 + MIN;
  logLine(home, "rn-ui", `drained restart ${TIP}`, w.now);
  w.held = null; // /health stops answering: rn-bug's auto drain is unconfirmed
  assert.equal((await loop.tick()).state, "draining", "no fire on an unconfirmed auto drain");
  assert.equal(w.fires, 0);
  w.held = NO_HELD();
  w.now = T0 + 2 * MIN;
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(w.fires, 1);

  // The deadline still fires with the held list unknown (existing behavior), saying why.
  const home3 = tmp();
  const w3 = world(home3, { held: NO_HELD() });
  w3.agents = [OVE, BUG, UI, W1];
  w3.held = { ids: ["rn-w1"], work: SUITE };
  request(home3, { deadlineMin: 10 });
  const l3 = w3.loop();
  await l3.tick();
  logLine(home3, "rn-ui", `drained restart ${TIP}`, T0 + MIN);
  w3.held = null;
  w3.now = T0 + 10 * MIN;
  assert.equal((await l3.tick()).state, "firing");
  assert.ok(w3.logs().some((t) => /deadline passed.*auto-drains unconfirmed/.test(t)), w3.logs().join("\n"));

  const home2 = tmp();
  const BW = ag("rn-bw", "bug-chaser", "worker", { "vs.parent": "rn-bug" });
  const w2 = world(home2, { agents: [OVE, BUG, UI, W1, BW], held: { ids: ["rn-w1"], work: SUITE } });
  request(home2);
  const l2 = w2.loop();
  await l2.tick();
  assert.ok(readRestartRequest(home2).drained["rn-bug"]);
  w2.held = { ids: ["rn-w1", "rn-bw"], work: { ...SUITE, "rn-bw": [{ pid: 77, cmd: "npm run build" }] } };
  w2.now = T0 + MIN;
  await l2.tick();
  const req = readRestartRequest(home2);
  assert.ok(!req.drained["rn-bug"] && !req.asked["rn-bug"].quiet, "auto drain withdrawn, lead prompted");
  assert.match(w2.sends().find((c) => c[1] === "rn-bug")[2], /rn-bw \(pid 77: npm run build\)/);
  assert.ok(req.events.some((e) => /auto-drain withdrawn, the runner holds rn-bw/.test(e.text)));
});

test("idea-604: a lane whose only holder has no shell listed yet is not asked at once; a clean first probe auto-drains it", async () => {
  const home = tmp();
  const w = world(home, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: { "rn-w1": [] } } });
  request(home);
  const loop = w.loop();
  assert.equal((await loop.tick()).state, "draining", "rn-ui pending, not asked, not drained");
  assert.equal(w.sends().length, 0);
  let req = readRestartRequest(home);
  assert.ok(req.asked["rn-ui"].holdoff && !req.drained["rn-ui"]);
  assert.match(formatRequestStatus(req, w.now), /ui lead rn-ui \(rn-ui\): NOT drained \(ask held since .*first probe\)/);
  w.held = NO_HELD(); // the probe came back clean
  w.now = T0 + 15_000;
  assert.equal((await loop.tick()).state, "firing");
  assert.equal(w.sends().length, 0, "nobody took a turn");
  req = readRestartRequest(home);
  assert.ok(req.asked["rn-ui"].auto && req.asked["rn-ui"].quiet && !req.asked["rn-ui"].holdoff);

  // Still unprobed past the grace: asked (the runner may hold a suite started in the turn that just ended).
  const home2 = tmp();
  const w2 = world(home2, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: { "rn-w1": [] } } });
  request(home2);
  const l2 = w2.loop();
  await l2.tick();
  w2.now = T0 + UNPROBED_ASK_GRACE_MS - 15_000;
  await l2.tick();
  assert.equal(w2.sends().length, 0, "inside the grace");
  w2.now = T0 + UNPROBED_ASK_GRACE_MS;
  await l2.tick();
  assert.deepEqual(w2.sends().map((c) => c[1]), ["rn-ui"]);
  assert.ok(!readRestartRequest(home2).asked["rn-ui"].quiet);
  w2.held = { ids: ["rn-w1"], work: SUITE }; // the probe then finds a real suite: still pending, named
  w2.now += 15_000;
  assert.equal((await l2.tick()).state, "draining");
  assert.match(formatRequestStatus(readRestartRequest(home2), w2.now), /NOT drained; runner holds rn-w1 \(pid 4242/);
  assert.equal(w2.sends().length, 1, "asked once");

  // A held-off lead that logs its own drain gets the close notice (it took a turn on it).
  const home3 = tmp();
  const w3 = world(home3, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: { "rn-w1": [] } } });
  request(home3);
  const l3 = w3.loop();
  await l3.tick();
  w3.now = T0 + 10_000;
  logLine(home3, "rn-ui", `drained restart ${TIP}`, w3.now);
  w3.held = NO_HELD();
  assert.equal((await l3.tick()).state, "firing");
  writeResult(home3, w3.now, { ok: true });
  w3.now += MIN;
  await l3.tick();
  assert.deepEqual(w3.sends().map((c) => c[1]), ["rn-ui"], "restart-done only, no ask");
});

// Bug36 M1: a held shell whose owner is in no agent list (spawned since the list, or the archived list failed) is of unknown
// lane. laneHolders would read it as nobody's, so every lead (its own lane's included) would be auto-drained and the
// request fire at once. Fail closed: no verdicts, every lead asked.
test("Bug36 M1: a held id missing from the agent list auto-drains nobody", async () => {
  const NEW = ag("rn-new", "ui", "worker");
  const SHELL = { "rn-new": [{ pid: 777, cmd: "npm test" }] };
  assert.equal(autoDrainVerdicts([{ leadId: "rn-bug", team: "vibesquad", lane: "bug-chaser" }], { ids: ["rn-new"], work: SHELL }, [OVE, BUG, UI], TEAMS), null);
  for (const listAgentsWithArchived of [null, async () => { throw new Error("runner busy"); }, async () => [OVE, BUG, UI]]) {
    const home = tmp();
    const w = world(home, { held: { ids: ["rn-new"], work: SHELL }, listAgentsWithArchived });
    request(home);
    const r = await w.loop().tick();
    assert.equal(r.state, "draining", String(listAgentsWithArchived));
    assert.equal(w.fires, 0, "nothing fired");
    const req = readRestartRequest(home);
    assert.deepEqual(req.drained, {}, "nobody auto-drained");
    assert.deepEqual(w.sends().map((c) => c[1]).sort(), ["rn-bug", "rn-ui"], "every lead asked");
  }
  // The archived list resolves the holder: verdicts apply again (only its own lane's lead is asked).
  const home = tmp();
  const w = world(home, { held: { ids: ["rn-new"], work: SHELL }, listAgentsWithArchived: async () => [OVE, BUG, UI, { ...NEW, archivedAt: null }] });
  request(home);
  await w.loop().tick();
  assert.deepEqual(w.sends().map((c) => c[1]), ["rn-ui"]);
  assert.ok(readRestartRequest(home).asked["rn-bug"].auto);
});

// Bug36 L1: an auto drain stands only on THIS tick's ok verdict for that lead, not on "some verdicts exist".
test("Bug36 L1: an auto-drained lead without an ok verdict this tick keeps the request from firing", () => {
  const L = [{ leadId: "rn-bug", team: "vibesquad", lane: "bug-chaser" }];
  const at = new Date(T0).toISOString();
  const autoReq = () => ({ id: "rr-x", tip: TIP, requestedBy: "rn-ove", createdAt: at, deadline: new Date(T0 + 30 * MIN).toISOString(), state: "draining", drainingAt: at,
    asked: { "rn-bug": { team: "vibesquad", lane: "bug-chaser", title: null, askedAt: at, quiet: true, auto: at } }, drained: { "rn-bug": at }, gone: {} });
  const step = (verdicts) => { const req = autoReq(); const actions = stepRequest(req, { now: T0 + MIN, leads: L, held: { byLead: {} }, verdicts }); return { req, actions }; };
  for (const verdicts of [{ "rn-bug": { ok: false, ids: ["rn-c"], unprobedOnly: true } }, {}, { "rn-other": { ok: true } }]) {
    const { req, actions } = step(verdicts);
    assert.equal(req.state, "draining", JSON.stringify(verdicts));
    assert.ok(!actions.some((a) => a.kind === "fire"), JSON.stringify(verdicts));
  }
  assert.notEqual(step({ "rn-bug": { ok: true } }).req.state, "draining", "an ok verdict this tick lets it go on");
});

// Bug36 L2: the loop's /health reader rejects what restart-runtime healthHeldTruth rejects.
test("Bug36 L2: heldListFromHealth rejects a held count the ids do not match", () => {
  assert.equal(heldListFromHealth({ held: 2, heldAgents: [] }), null, "count without ids: unknown, never clean");
  assert.equal(heldListFromHealth({ held: 1, heldAgents: ["a", "b"] }), null);
  assert.equal(heldListFromHealth({ running: 0 }), null, "no held list");
  assert.equal(heldListFromHealth(null), null);
  assert.deepEqual(heldListFromHealth({ held: 1, heldAgents: ["a"], heldWork: { a: [] } }), { ids: ["a"], work: { a: [] } });
  assert.deepEqual(heldListFromHealth({ heldAgents: ["a"] }), { ids: ["a"], work: null }, "no held count: ids stand, unreported heldWork stays null");
  assert.deepEqual(heldListFromHealth({ held: 0, heldAgents: [], heldWork: [] }), { ids: [], work: null }, "a non-object heldWork is unreported");
});

test("idea-674 x idea-402/604: a queued request gets no auto-drain, no hold-off and no ask before windowAt; both act from the window on", async () => {
  const home = tmp();
  // rn-bug's lane holds nothing (would auto-drain), rn-ui's only holder is unprobed (would get a 60s ask hold-off).
  const w = world(home, { agents: [OVE, BUG, UI, W1], held: { ids: ["rn-w1"], work: { "rn-w1": [] } } });
  let listed = 0;
  let heldReads = 0;
  const loop = createRestartRequestLoop({
    home, teams: () => TEAMS, now: () => w.now,
    listAgents: async () => { listed++; return w.agents; },
    heldList: async () => { heldReads++; return w.held; },
    runVs: async (args) => { w.calls.push(args); return { ok: true }; },
    fire: async () => { w.fires++; return { ok: true }; },
  });
  const q = request(home, { urgent: false });
  assert.equal(q.state, "queued");
  const win = Date.parse(q.windowAt);
  assert.equal(q.windowAt, "2026-11-19T13:00:00.000Z");
  for (const t of [T0, T0 + 30 * MIN, win - 1]) {
    w.now = t;
    assert.equal((await loop.tick()).state, "queued");
  }
  let req = readRestartRequest(home);
  assert.deepEqual([req.asked, req.drained], [{}, {}], "no auto-drain and no held-off ask recorded before the window");
  assert.equal(req.held, null, "no held list kept while queued");
  assert.deepEqual([w.calls.length, w.fires, listed, heldReads], [0, 0, 0, 0], "no ask, log, fire, agent list or held list before windowAt");
  w.now = win;
  assert.equal((await loop.tick()).state, "draining");
  req = readRestartRequest(home);
  assert.ok(req.asked["rn-bug"].auto && req.asked["rn-bug"].quiet && req.drained["rn-bug"], "402 auto-drain acts at the window");
  assert.ok(req.asked["rn-ui"].holdoff && !req.drained["rn-ui"], "604 hold-off starts at the window");
  assert.equal(w.sends().length, 0, "neither is prompted");
  assert.ok(w.logs().some((t) => /window 2026-11-19T13:00:00\.000Z open: draining for abc1234def/.test(t)), w.logs().join("\n"));
  w.held = { ids: [], work: {} };
  w.now = win + MIN;
  assert.equal((await loop.tick()).state, "firing", "a clean first probe auto-drains rn-ui: fires without one ask");
  assert.equal(w.sends().length, 0);
});
