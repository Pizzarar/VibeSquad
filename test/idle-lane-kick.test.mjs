import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIdleLaneKick, openPlanBlocks, openTaskUnits, laneHasOpenNeedsYou, laneOpenWork, kickText } from "../server/idle-lane-kick.mjs";

const TEAMS = [{ id: "vs", name: "VS", lanes: [{ id: "vs", hub: true }, { id: "bug" }, { id: "art" }] }];
const MIN = 60_000;

const dirs = [];
test.after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const ag = (id, role, lane, extra = {}) => ({ id, status: "idle", labels: { role, team: "vs", lane }, ...extra });

function setup(over = {}) {
  let t = 1_000_000;
  const sent = [];
  const logs = [];
  const agents = over.agents ?? [ag("L", "lead", "bug"), ag("OV", "lead", "vs")];
  const kick = createIdleLaneKick({
    teams: () => TEAMS,
    listAgents: async () => agents,
    send: async (id, text) => sent.push({ id, text }),
    log: (e) => logs.push(e.text),
    now: () => t,
    armedOwners: async () => new Set(),
    openNeedsYou: () => false,
    openWork: () => ["unit-x: do thing"],
    ...over.deps,
  });
  return { kick, sent, logs, agents, advance: (ms) => (t += ms) };
}

test("idle < 10 min: no kick; at 10 min: one kick, never twice per episode", async () => {
  const s = setup();
  await s.kick.tick();
  s.advance(9 * MIN);
  await s.kick.tick();
  assert.equal(s.sent.length, 0);
  s.advance(2 * MIN);
  const r = await s.kick.tick();
  assert.deepEqual(r.map((x) => x.action), ["kick"]);
  assert.deepEqual(s.sent, [{ id: "L", text: kickText("unit-x: do thing") }]);
  assert.deepEqual(s.logs, ["idle-kick lane=bug item=unit-x: do thing"]);
  s.advance(5 * MIN);
  await s.kick.tick();
  assert.equal(s.sent.length, 1);
});

test("second idle episode on same item within 30 min escalates to the hub lead, once", async () => {
  const s = setup();
  await s.kick.tick();
  s.advance(11 * MIN);
  await s.kick.tick(); // kick
  s.agents[0].status = "running";
  s.advance(1 * MIN);
  await s.kick.tick(); // episode ends
  s.agents[0].status = "idle";
  await s.kick.tick();
  s.advance(11 * MIN); // 23 min after kick
  const r = await s.kick.tick();
  assert.deepEqual(r.map((x) => x.action), ["escalate"]);
  assert.equal(s.sent.at(-1).id, "OV");
  assert.match(s.logs.at(-1), /^idle-escalate lane=bug item=/);
  s.advance(5 * MIN);
  await s.kick.tick();
  assert.equal(s.sent.length, 2);
});

test("second episode after the 30 min window: no re-kick and no late escalation for the same item", async () => {
  const s = setup();
  await s.kick.tick();
  s.advance(11 * MIN);
  await s.kick.tick();
  s.agents[0].status = "running";
  s.advance(1 * MIN);
  await s.kick.tick();
  s.agents[0].status = "idle";
  await s.kick.tick();
  s.advance(35 * MIN);
  assert.deepEqual(await s.kick.tick(), []);
  s.advance(60 * MIN);
  assert.deepEqual(await s.kick.tick(), []);
  assert.equal(s.sent.length, 1);
});

test("a changed top item is kicked again; at most 1 kick + 1 escalation per item over many episodes", async () => {
  let top = "A";
  const s = setup({ deps: { openWork: () => [top] } });
  const episode = async () => {
    s.agents[0].status = "running";
    await s.kick.tick();
    s.agents[0].status = "idle";
    await s.kick.tick();
    s.advance(11 * MIN);
    return s.kick.tick();
  };
  assert.equal((await episode())[0].action, "kick");
  assert.equal((await episode())[0].action, "escalate");
  for (let i = 0; i < 4; i++) assert.deepEqual(await episode(), []);
  top = "B";
  assert.equal((await episode())[0].action, "kick");
});

test("multi-Squad: escalation goes to the SAME Squad's Overlord, never another's", async () => {
  const teams = [
    { id: "vs", lanes: [{ id: "vs", hub: true }, { id: "bug" }] },
    { id: "efi", lanes: [{ id: "efi", hub: true }, { id: "bug" }] },
  ];
  const mk = (id, role, team, lane) => ({ id, status: "idle", labels: { role, team, lane } });
  const s = setup({ agents: [mk("L", "lead", "efi", "bug"), mk("OVvs", "lead", "vs", "vs"), mk("OVefi", "lead", "efi", "efi")], deps: { teams: () => teams } });
  const episode = async () => {
    s.agents[0].status = "running";
    await s.kick.tick();
    s.agents[0].status = "idle";
    await s.kick.tick();
    s.advance(11 * MIN);
    return s.kick.tick();
  };
  await episode();
  await episode();
  assert.deepEqual(s.sent.map((x) => x.id), ["L", "OVefi"]);
});

test("openTaskUnits: only live states are open work (superseded/dropped/done/blocked are not)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(dir);
  const f = path.join(dir, "TASKS.json");
  fs.writeFileSync(f, JSON.stringify({ units: ["todo", "running", "done", "superseded", "dropped", "blocked", "weird"].map((st) => ({ id: st, status: st })) }));
  assert.deepEqual(await openTaskUnits(f), ["todo", "running"]);
});

test("laneHasOpenNeedsYou: label, log tail, answered by a later decision", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(home);
  fs.mkdirSync(path.join(home, "logs"));
  const f = path.join(home, "logs", "vs--bug.jsonl");
  const line = (type, ts) => JSON.stringify({ ts: new Date(ts).toISOString(), type, text: "x" }) + "\n";
  const now = Date.now();
  assert.equal(await laneHasOpenNeedsYou({ teamId: "vs", laneId: "bug", baseHome: home, nowMs: now }), false);
  assert.equal(await laneHasOpenNeedsYou({ teamId: "vs", laneId: "bug", baseHome: home, agents: [{ labels: { "needs-you": "r" } }] }), true);
  fs.writeFileSync(f, line("needs-you", now - 3 * 24 * 3_600_000)); // 3 days old, beyond the old 24h cap
  assert.equal(await laneHasOpenNeedsYou({ teamId: "vs", laneId: "bug", baseHome: home, nowMs: now }), true);
  fs.appendFileSync(f, line("decision", now - 1000));
  assert.equal(await laneHasOpenNeedsYou({ teamId: "vs", laneId: "bug", baseHome: home, nowMs: now }), false);
});

test("laneOpenWork: parked cards are scoped to the Squad AND lane", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(home);
  fs.writeFileSync(path.join(home, "inbox.json"), JSON.stringify([
    { id: "idea-1", title: "mine", teamId: "vs", laneId: "bug", status: "parked" },
    { id: "idea-2", title: "other squad", teamId: "efi", laneId: "bug", status: "parked" },
    { id: "idea-3", title: "archived", teamId: "vs", laneId: "bug", status: "archived" },
  ]));
  const items = await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: home, baseHome: home });
  assert.deepEqual(items, ["idea-1 mine"]);
});

test("open work and registry reads are cached across ticks within the TTL", async () => {
  let calls = 0;
  const s = setup({ deps: { openWork: () => (calls++, ["A"]) } });
  await s.kick.tick();
  s.advance(11 * MIN);
  await s.kick.tick(); // kicks, 1 read
  assert.equal(calls, 1);
});

for (const [name, over] of [
  ["running worker", { agents: [ag("L", "lead", "bug"), ag("W", "worker", "bug", { status: "running" })] }],
  ["armed watch", { deps: { armedOwners: async () => new Set(["L"]) } }],
  ["open needs-you", { deps: { openNeedsYou: () => true } }],
  ["needs-you label on the lead", { deps: { openNeedsYou: undefined }, agents: [ag("L", "lead", "bug", { labels: { role: "lead", team: "vs", lane: "bug", "needs-you": "blocked" } })] }],
  ["pending permission", { agents: [ag("L", "lead", "bug", { pendingPermissions: [{ id: "p" }] })] }],
  ["no open work", { deps: { openWork: () => [] } }],
  ["lead mid-turn per fresh status", { deps: { freshAgent: async () => ({ status: "running" }) } }],
  ["hub lane", { agents: [ag("OV", "lead", "vs")] }],
]) {
  test(`exclusion: ${name} -> no kick`, async () => {
    const s = setup(over);
    await s.kick.tick();
    s.advance(30 * MIN);
    await s.kick.tick();
    assert.equal(s.sent.length, 0);
  });
}

test("Buddy is the target when the lane has no lead", async () => {
  const s = setup({ agents: [ag("B", "brainstorm", "art")] });
  await s.kick.tick();
  s.advance(11 * MIN);
  await s.kick.tick();
  assert.equal(s.sent[0].id, "B");
});

test("a Buddy turning blocks the kick for a lead lane", async () => {
  const s = setup({ agents: [ag("L", "lead", "bug"), ag("B", "brainstorm", "bug", { status: "running" })] });
  await s.kick.tick();
  s.advance(30 * MIN);
  await s.kick.tick();
  assert.equal(s.sent.length, 0);
});

test("openPlanBlocks lists non-PASS blocks only", () => {
  const md = "- K1 idle kick: todo\n- K2 thing PASS abc\n- T3 x (pending)\nprose todo";
  assert.deepEqual(openPlanBlocks(md), ["plan block K1", "plan block T3"]);
});
