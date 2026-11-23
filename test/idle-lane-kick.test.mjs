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

test("laneOpenWork: a new parked card counts; explicitly parked (parkedAt) and archived/handed-off/rejected are skipped; accepted counts; scoped to the Squad AND lane (idea-481)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(home);
  fs.writeFileSync(path.join(home, "inbox.json"), JSON.stringify([
    { id: "idea-1", title: "new parked", teamId: "vs", laneId: "bug", status: "parked" },
    { id: "idea-2", title: "explicit park", teamId: "vs", laneId: "bug", status: "parked", parkedAt: "2026-11-21T08:00:00.000Z" },
    { id: "idea-3", title: "archived", teamId: "vs", laneId: "bug", status: "archived" },
    { id: "idea-4", title: "accepted", teamId: "vs", laneId: "bug", status: "accepted" },
    { id: "idea-5", title: "handed-off", teamId: "vs", laneId: "bug", status: "handed-off" },
    { id: "idea-6", title: "rejected", teamId: "vs", laneId: "bug", status: "rejected" },
    { id: "idea-7", title: "legacy", teamId: "vs", laneId: "bug" },
    { id: "idea-8", title: "other squad", teamId: "efi", laneId: "bug", status: "parked" },
    { id: "idea-9", title: "other lane", teamId: "vs", laneId: "art", status: "parked" },
  ]));
  const items = await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: home, baseHome: home });
  assert.deepEqual(items, ["idea-1 new parked", "idea-4 accepted", "idea-7 legacy"]);
});

for (const [name, cards, expectKick, expectText] of [
  ["a new parked card nudges", [{ id: "n1", title: "new", teamId: "vs", laneId: "bug", status: "parked" }], true, /n1 new/],
  ["an explicitly parked card (parkedAt) does not", [{ id: "p1", title: "parked", teamId: "vs", laneId: "bug", status: "parked", parkedAt: "2026-11-21T08:00:00.000Z" }], false, null],
  ["an archived card does not", [{ id: "a1", title: "archived", teamId: "vs", laneId: "bug", status: "archived" }], false, null],
  ["an accepted card nudges", [{ id: "c1", title: "accepted", teamId: "vs", laneId: "bug", status: "accepted" }], true, /c1 accepted/],
]) {
  test(`idle-kick (idea-481): ${name}`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(home);
    fs.writeFileSync(path.join(home, "inbox.json"), JSON.stringify(cards));
    let t = 1_000_000;
    const sent = [];
    const kick = createIdleLaneKick({
      rootDir: home,
      baseHome: home,
      teams: () => TEAMS,
      listAgents: async () => [ag("L", "lead", "bug"), ag("OV", "lead", "vs")],
      send: async (id, text) => sent.push({ id, text }),
      log: () => {},
      now: () => t,
    });
    await kick.tick();
    t += 11 * MIN;
    const r = await kick.tick();
    if (expectKick) {
      assert.equal(r.length, 1, JSON.stringify(r));
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, expectText);
    } else {
      assert.deepEqual(r, []);
      assert.equal(sent.length, 0);
    }
  });
}

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

test("laneOpenWork (idea-569): plan blocks drop when the plan has a done PASS log entry or says COMPLETE; an unfinished plan still counts", async () => {
  const mk = (planBody, logLines) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(home);
    fs.mkdirSync(path.join(home, "docs", "brainstorm"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "brainstorm", "bug.md"), "Plan: docs/PLAN_X.md\n- G3b todo\n");
    if (planBody != null) fs.writeFileSync(path.join(home, "docs", "PLAN_X.md"), planBody);
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, "logs", "vs--bug.jsonl"), logLines.map((l) => JSON.stringify(l)).join("\n"));
    return home;
  };
  const run = (home) => laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: home, baseHome: home });
  assert.deepEqual(await run(mk("# X\nStatus: in progress\n", [])), ["plan block G3b"]);
  assert.deepEqual(await run(mk("# X\nStatus: COMPLETE\n", [])), []);
  assert.deepEqual(await run(mk(null, [{ type: "done", plan: "docs/PLAN_X.md", pass: true }])), []);
  assert.deepEqual(await run(mk(null, [{ type: "done", plan: "docs/PLAN_X.md" }])), ["plan block G3b"]); // done without PASS is not complete
});

test("laneOpenWork (idea-569 review): anchored COMPLETE; active plan = last named; a done PASS for a different plan does not suppress", async () => {
  const mk = (brief, plans, logLines = []) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ilk-")); dirs.push(home);
    fs.mkdirSync(path.join(home, "docs", "brainstorm"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "brainstorm", "bug.md"), brief);
    for (const [n, body] of Object.entries(plans)) fs.writeFileSync(path.join(home, "docs", n), body);
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, "logs", "vs--bug.jsonl"), logLines.map((l) => JSON.stringify(l)).join("\n"));
    return home;
  };
  const run = (home) => laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: home, baseHome: home });
  const one = "Plan: docs/PLAN_X.md\n- G3b todo\n";
  for (const body of ["Status: NOT COMPLETE\n", "Status: in progress (A1 COMPLETE, A2 todo)\n", "We still need to complete this. Status: open\n", "Status: COMPLETELY wrong\n"]) {
    assert.deepEqual(await run(mk(one, { "PLAN_X.md": body })), ["plan block G3b"], body);
  }
  for (const body of ["**Status:** COMPLETE\n", "- Status — COMPLETE (shipped)\n", "# T\n\nStatus: COMPLETE\n"]) assert.deepEqual(await run(mk(one, { "PLAN_X.md": body })), [], body);
  // old done plan + new open plan (last named is active)
  const two = "Old: docs/PLAN_OLD.md\nPlan: docs/PLAN_NEW.md\n- H1 todo\n";
  assert.deepEqual(await run(mk(two, { "PLAN_OLD.md": "Status: COMPLETE\n", "PLAN_NEW.md": "Status: in progress\n" }, [{ type: "done", plan: "docs/PLAN_OLD.md", pass: true }])), ["plan block H1"]);
  assert.deepEqual(await run(mk(two, { "PLAN_NEW.md": "Status: COMPLETE\n" })), []);
});
