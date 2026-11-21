import test from "node:test";
import assert from "node:assert/strict";
import { createIdleLaneKick, openPlanBlocks, kickText } from "../server/idle-lane-kick.mjs";

const TEAMS = [{ id: "vs", name: "VS", lanes: [{ id: "vs", hub: true }, { id: "bug" }, { id: "art" }] }];
const MIN = 60_000;
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
    armedWatch: () => false,
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

test("second episode after the 30 min window kicks again instead of escalating", async () => {
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
  const r = await s.kick.tick();
  assert.deepEqual(r.map((x) => x.action), ["kick"]);
});

for (const [name, over] of [
  ["running worker", { agents: [ag("L", "lead", "bug"), ag("W", "worker", "bug", { status: "running" })] }],
  ["armed watch", { deps: { armedWatch: (id) => id === "L" } }],
  ["open needs-you", { deps: { openNeedsYou: () => true } }],
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
