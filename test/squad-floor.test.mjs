import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { castVariant } from "../src/cast.ts";
import {
  bandLayers,
  BLINK_MAX_MS,
  BLINK_MIN_MS,
  faceFrame,
  faceMode,
  nextBlinkDelay,
  topBand,
  validateFaces,
  buildTower,
  DESK_COUNT,
  floorOrPlaceholder,
  integerScale,
  LOBBY_MAX_SHOWN,
  needsYouFloors,
  placeholderFloor,
  isSeatedWorkerPose,
  poseFor,
  roleFrames,
  sliceAnchor,
  sortByAnchorY,
  spreadNeighbours,
  spriteFrame,
  transitionRiders,
  validateCast,
  validateFloor,
} from "../src/squadFloorLogic.ts";

// Minimal Member fixture, mirroring test/squad-queue.test.mjs (agent + attention + kind + agentType).
const member = (id, { status = "idle", archivedAt = null, labels = {}, createdAt, kind = "worker", agentType = "implement", attention = null, title } = {}) => ({
  agent: { id, title: title ?? id, status, updatedAt: createdAt ?? "2026-11-01T00:00:00Z", archivedAt, labels, createdAt },
  attention,
  kind,
  agentType,
});

const team = (laneId, { lead = null, buddy = null, workers = [] } = {}) => ({ laneId, name: laneId, lead, buddy, workers });

const realCast = validateCast(JSON.parse(readFileSync(new URL("../public/office/cast.json", import.meta.url), "utf8")));

test("real public/office/cast.json validates", () => {
  assert.equal(realCast.ok, true);
  if (!realCast.ok) return;
  assert.equal(realCast.value.cell, JSON.parse(readFileSync(new URL('../public/office/cast.json', import.meta.url), 'utf8')).cell);
  assert.ok(realCast.value.roles.lead && realCast.value.roles.buddy);
  assert.equal(realCast.value.roles.lead.work.length, 2);
  assert.equal(realCast.value.roles.lead.idle.length, 1);
  assert.ok(Number.isFinite(realCast.value.bubble.offset.x));
});

test("two teams per floor, in squad pin order, odd team leaves teamB null", () => {
  const tower = buildTower({
    hubBuddy: null,
    hubLead: null,
    teams: [team("a"), team("b"), team("c")],
  });
  assert.equal(tower.floors.length, 2);
  assert.equal(tower.floors[0].index, 0);
  assert.equal(tower.floors[0].teamA.laneId, "a");
  assert.equal(tower.floors[0].teamB.laneId, "b");
  assert.equal(tower.floors[1].teamA.laneId, "c");
  assert.equal(tower.floors[1].teamB, null);
});

test("lead → lead slice, Buddy → buddyOffice, workers → desks in oldest-spawn-first order", () => {
  const old = new Date(2026, 0, 1).toISOString();
  const newer = new Date(2026, 0, 2).toISOString();
  const tower = buildTower({
    hubBuddy: null,
    hubLead: null,
    teams: [
      team("x", {
        lead: member("lead-1", { kind: "lead" }),
        buddy: member("buddy-1", { kind: "brainstorm" }),
        workers: [member("w-new", { createdAt: newer, status: "running" }), member("w-old", { createdAt: old, status: "running" })],
      }),
    ],
  });
  const a = tower.floors[0].teamA;
  assert.equal(a.lead.seat, "lead");
  assert.equal(a.lead.role, "lead");
  assert.equal(a.buddy.seat, "buddyOffice");
  assert.equal(a.buddy.role, "buddy");
  assert.equal(a.desks.length, 2);
  assert.deepEqual(a.desks.map((d) => d.agentId), ["w-old", "w-new"]); // oldest first
  assert.deepEqual(a.desks.map((d) => d.desk), [0, 1]);
});

test("7th–10th worker → lobby shows 3 and a +1 badge", () => {
  const workers = Array.from({ length: 10 }, (_, i) => member(`w${i + 1}`, { createdAt: new Date(2026, 0, 1, 0, i).toISOString(), status: "running" }));
  const tower = buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", { workers })] });
  const a = tower.floors[0].teamA;
  assert.equal(a.desks.length, DESK_COUNT);
  assert.equal(a.lobby.length, LOBBY_MAX_SHOWN);
  assert.equal(a.lobbyOverflow, 1);
  assert.deepEqual(a.lobby.map((l) => l.agentId), ["w7", "w8", "w9"]); // oldest overflow first
});

test("retired leads (old-lead / former-lead label) are not drawn", () => {
  const tower = buildTower({
    hubBuddy: null,
    hubLead: null,
    teams: [
      team("x", {
        lead: member("retired", { kind: "old-lead" }),
        buddy: member("b", { kind: "brainstorm", labels: { role: "former-brainstorm" } }),
      }),
    ],
  });
  const a = tower.floors[0].teamA;
  assert.equal(a.lead, null);
  // former-lead label, even with kind "lead", is retired
  const t2 = buildTower({ hubBuddy: null, hubLead: null, teams: [team("y", { lead: member("fl", { kind: "lead", labels: { role: "former-lead" } }) })] });
  assert.equal(t2.floors[0].teamA.lead, null);
});

test("pose mapping: running → work, needs → needs, idle → idle, closed/archived → ride", () => {
  assert.equal(poseFor(member("r", { status: "running" })), "work");
  assert.equal(poseFor(member("n", { attention: { tone: "needs-you", reason: "decide" } })), "needs");
  assert.equal(poseFor(member("p", { attention: { tone: "permission", reason: "1 permission request(s)" } })), "needs");
  assert.equal(poseFor(member("e", { status: "error", attention: { tone: "error", reason: "boom" } })), "needs");
  assert.equal(poseFor(member("i", { status: "idle" })), "idle");
  assert.equal(poseFor(member("c", { status: "closed" })), "ride");
  assert.equal(poseFor(member("a", { archivedAt: "2026-11-01T00:00:00Z" })), "ride");
  // needs-you beats running (turned round to signal)
  assert.equal(poseFor(member("rn", { status: "running", attention: { tone: "needs-you", reason: "decide" } })), "needs");
  // finished attention is not a needs hit → falls through to idle
  assert.equal(poseFor(member("f", { attention: { tone: "finished", reason: "done" } })), "idle");
});

test("every real role resolves to its own frames (cast.fallback is empty)", () => {
  if (!realCast.ok) return;
  const cast = realCast.value;
  assert.deepEqual(cast.fallback, {});
  for (const role of Object.keys(cast.roles)) {
    for (const pose of ["work", "idle", "needs", "ride"]) {
      if (cast.roles[role][pose]) assert.deepEqual(roleFrames(cast, role, pose), cast.roles[role][pose]);
    }
  }
  assert.deepEqual(roleFrames(cast, "spec", "work"), cast.roles.spec.work);
  assert.deepEqual(roleFrames(cast, "unknown", "idle"), cast.roles.unknown.idle);
  assert.deepEqual(roleFrames(cast, "mechanical", "ride"), cast.roles.mechanical.ride);
  assert.equal(roleFrames(cast, "zzz", "work"), null);
  assert.equal(spriteFrame(cast, "lead", "work", 0).x, cast.roles.lead.work[0].x);
});

test("role → sprite fallback lookup follows cast.fallback (synthetic cast)", () => {
  const f = (x) => [{ x, y: 0, w: 32, h: 32 }];
  const cast = {
    cell: 32,
    roles: { lead: { work: f(0), idle: f(32) }, buddy: { work: f(64), idle: f(96) }, loopA: {}, loopB: {} },
    fallback: { zzz: "buddy", spec: "lead", loopA: "loopB", loopB: "loopA" },
  };
  assert.deepEqual(roleFrames(cast, "zzz", "work"), cast.roles.buddy.work);
  assert.deepEqual(roleFrames(cast, "spec", "idle"), cast.roles.lead.idle);
  assert.equal(roleFrames(cast, "loopA", "work"), null);
  assert.equal(roleFrames(cast, "no-such-role", "work"), null);
});

test("missing or invalid floor.json → placeholder (640x360 floors + 640x200 penthouse + lobbies)", () => {
  assert.equal(validateFloor(undefined).ok, false);
  assert.equal(validateFloor(null).ok, false);
  assert.equal(validateFloor({}).ok, false);
  const bad = validateFloor({ teamA: { lead: { x: 0, y: 0, w: 1, h: 1 }, buddyOffice: { x: 0, y: 0, w: 1, h: 1 }, desks: [] } });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason);

  const ph = placeholderFloor();
  assert.equal(ph.teamA.desks.length, DESK_COUNT);
  assert.equal(ph.teamB.desks.length, DESK_COUNT);
  assert.ok(ph.teamA.lobby && ph.teamB.lobby);
  assert.equal(ph.penthouse.w, 640);
  assert.equal(ph.penthouse.h, 200);
  assert.equal(ph.penthouse.plate, "roof");
  assert.equal(floorOrPlaceholder(undefined).teamA.desks.length, DESK_COUNT);
});

test("a valid floor.json round-trips", () => {
  const v = validateFloor({
    teamA: { lead: { x: 0, y: 0, w: 1, h: 1 }, buddyOffice: { x: 1, y: 0, w: 1, h: 1 }, desks: [{ x: 2, y: 0, w: 1, h: 1 }], lobby: { x: 0, y: 0, w: 72, h: 32 } },
    teamB: { lead: { x: 0, y: 0, w: 1, h: 1 }, buddyOffice: { x: 1, y: 0, w: 1, h: 1 }, desks: [] },
    elevator: { doorA: { x: 0, y: 0, w: 1, h: 1 }, doorB: { x: 1, y: 0, w: 1, h: 1 }, car: { x: 2, y: 0, w: 1, h: 1 } },
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.teamA.lobby.w, 72);
  assert.equal(v.value.penthouse, undefined);
});

test("penthouse: RiffBot is the hub Buddy, Overlord is the hub lead", () => {
  const tower = buildTower({
    hubBuddy: member("riffbot", { kind: "brainstorm" }),
    hubLead: member("overlord", { kind: "lead" }),
    teams: [team("x")],
  });
  assert.equal(tower.penthouse.riffbot.agentId, "riffbot");
  assert.equal(tower.penthouse.riffbot.role, "riffbot");
  assert.equal(tower.penthouse.riffbot.seat, "riffbot");
  assert.equal(tower.penthouse.overlord.agentId, "overlord");
  assert.equal(tower.penthouse.overlord.role, "overlord");
  assert.equal(tower.penthouse.overlord.seat, "overlord");
});

test("floor '!' markers: which floor indexes have a needs-you agent", () => {
  const tower = buildTower({
    hubBuddy: null,
    hubLead: null,
    teams: [
      team("a", { workers: [member("ok", {})] }),
      team("b"),
      team("c", { workers: [member("needy", { attention: { tone: "needs-you", reason: "decide" } })] }),
    ],
  });
  // floor 0 = a+b, floor 1 = c (needs-you)
  assert.equal(tower.floors[0].needsYou, false);
  assert.equal(tower.floors[1].needsYou, true);
  assert.deepEqual(needsYouFloors(tower.floors), [1]);
});

test("transition riders: members gone from next animate ride", () => {
  const a = member("a");
  const b = member("b");
  const c = member("c");
  assert.deepEqual(transitionRiders([a, b, c], [a, c]), ["b"]);
  assert.deepEqual(transitionRiders([a], [a, b]), []);
});

test("integer scale helper", () => {
  assert.equal(integerScale(640), 1);
  assert.equal(integerScale(1280), 2);
  assert.equal(integerScale(700), 1);
  assert.equal(integerScale(639), 0);
  assert.equal(integerScale(NaN), 0);
});

test("slice anchor is bottom-centre", () => {
  assert.deepEqual(sliceAnchor({ x: 10, y: 20, w: 40, h: 30 }), { x: 30, y: 50 });
});

test("P3b draw order: plate < y-sorted sprites < front < bubbles; no front layer unless floor.json says so", () => {
  assert.deepEqual(bandLayers(true), ["plate", "sprites", "front", "bubbles"]);
  assert.deepEqual(bandLayers(false), ["plate", "sprites", "bubbles"]);
  const src = readFileSync(new URL("../src/SquadFloor.tsx", import.meta.url), "utf8");
  assert.match(src, /floor\.front \? FLOOR_FRONT_URL/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.sq-floor-front\s*\{[^}]*pointer-events:\s*none/);
});

test("P3b y-sort: lower anchor draws later (in front), ties keep input order", () => {
  const items = [{ id: "c", anchor: { y: 30 } }, { id: "a", anchor: { y: 10 } }, { id: "b2", anchor: { y: 20 } }, { id: "b1", anchor: { y: 20 } }];
  assert.deepEqual(sortByAnchorY(items).map((i) => i.id), ["a", "b2", "b1", "c"]);
});

test("P3b floor.json `front` flags: floor and penthouse, absent → undefined", () => {
  const base = {
    teamA: { lead: { x: 0, y: 0, w: 1, h: 1 }, buddyOffice: { x: 1, y: 0, w: 1, h: 1 }, desks: [] },
    teamB: { lead: { x: 0, y: 0, w: 1, h: 1 }, buddyOffice: { x: 1, y: 0, w: 1, h: 1 }, desks: [] },
    elevator: { doorA: { x: 0, y: 0, w: 1, h: 1 }, doorB: { x: 1, y: 0, w: 1, h: 1 }, car: { x: 2, y: 0, w: 1, h: 1 } },
  };
  assert.equal(validateFloor(base).value.front, undefined);
  assert.equal(validateFloor({ ...base, front: true }).value.front, true);
  const r = { x: 0, y: 0, w: 1, h: 1 };
  const pent = { plate: "roof", w: 640, h: 200, riffbot: { seat: r, lounge: r }, overlord: { seat: r, crtWall: r }, elevatorTop: r };
  assert.equal(validateFloor({ ...base, penthouse: pent }).value.penthouse.front, undefined);
  assert.equal(validateFloor({ ...base, penthouse: { ...pent, front: true } }).value.penthouse.front, true);
});

test("P3f 4K: scale is floor(w*dpr/640)/dpr, so the floor fills the column at the largest crisp device scale", () => {
  assert.equal(integerScale(1355, 2), 2); // 4x device px
  assert.equal(integerScale(1275, 2), 1.5); // was 1 (half the column empty)
  assert.equal(integerScale(1995, 1.5), 8 / 3); // 4x device px; was a blurry 3 css (4.5 device)
  assert.equal(integerScale(3275, 1), 5);
  assert.equal(integerScale(1000, 2), 1.5);
  assert.equal(integerScale(639, 2), 0);
  assert.equal(integerScale(700, 0.5), 1); // bogus dpr below 1 is treated as 1
  // device-pixel integer: scale*dpr is a whole number
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const sc = integerScale(2300, dpr);
    assert.ok(Math.abs(sc * dpr - Math.round(sc * dpr)) < 1e-9);
    assert.ok(sc * 640 <= 2300);
  }
});

test("P3a idle worker with no needs-you is not seated; running and needs-you workers are", () => {
  const tower = buildTower({
    hubBuddy: null,
    hubLead: null,
    teams: [
      team("x", {
        workers: [
          member("idle", { createdAt: "2026-01-01T00:00:00Z" }),
          member("busy", { status: "running", createdAt: "2026-01-02T00:00:00Z" }),
          member("needy", { attention: { tone: "needs-you", reason: "decide" }, createdAt: "2026-01-03T00:00:00Z" }),
        ],
      }),
    ],
  });
  const a = tower.floors[0].teamA;
  assert.deepEqual(a.desks.map((d) => d.agentId), ["busy", "needy"]);
  assert.deepEqual(a.desks.map((d) => d.desk), [0, 1]); // desks pack, no gap where the idle one was
  assert.equal(a.desks[1].pose, "needs"); // still seated with its bubble pose
  assert.equal(isSeatedWorkerPose("idle"), false);
  assert.equal(isSeatedWorkerPose("ride"), false);
});

test("P3a running → idle: the worker leaves the tower, so the floor plays ride at the elevator, then it is gone", () => {
  const mk = (status) => buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", { workers: [member("w", { status })] })] });
  const ids = (t) => t.floors[0].teamA.desks.map((d) => ({ agent: { id: d.agentId } }));
  const before = mk("running");
  const after = mk("idle");
  assert.equal(before.floors[0].teamA.desks.length, 1);
  assert.equal(after.floors[0].teamA.desks.length, 0);
  assert.deepEqual(transitionRiders(ids(before), ids(after)), ["w"]);
  // an idle worker that was never seated does not ride
  assert.deepEqual(transitionRiders(ids(after), ids(after)), []);
});

test("P3a needs-you → idle (finished) also goes home; leads, Buddies, RiffBot and Overlord stay seated idle", () => {
  const tower = buildTower({
    hubBuddy: member("riffbot", { kind: "brainstorm" }),
    hubLead: member("overlord", { kind: "lead" }),
    teams: [
      team("x", {
        lead: member("lead-1", { kind: "lead" }),
        buddy: member("buddy-1", { kind: "brainstorm" }),
        workers: [member("done", { attention: { tone: "finished", reason: "all green" } })],
      }),
    ],
  });
  const a = tower.floors[0].teamA;
  assert.equal(a.lead.pose, "idle");
  assert.equal(a.buddy.pose, "idle");
  assert.equal(tower.penthouse.riffbot.pose, "idle");
  assert.equal(tower.penthouse.overlord.pose, "idle");
  assert.equal(a.desks.length, 0);
});

test("P3a lobby +N counts only running/needs-you workers", () => {
  const workers = [
    ...Array.from({ length: 8 }, (_, i) => member(`r${i}`, { status: "running", createdAt: new Date(2026, 0, 1, 0, i).toISOString() })),
    ...Array.from({ length: 5 }, (_, i) => member(`i${i}`, { createdAt: new Date(2026, 0, 2, 0, i).toISOString() })),
  ];
  const a = buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", { workers })] }).floors[0].teamA;
  assert.equal(a.desks.length, DESK_COUNT);
  assert.equal(a.lobby.length, 2); // 8 running − 6 desks
  assert.equal(a.lobbyOverflow, 0);
  assert.ok([...a.desks, ...a.lobby].every((s) => s.agentId.startsWith("r")));
});

// ── P3e cast v2 ───────────────────────────────────────────────────────────────
const castV2Json = JSON.parse(readFileSync(new URL("../public/office/cast.json", import.meta.url), "utf8")); // master (Art9 85e38b6), read-only
const castV2 = validateCast(castV2Json);

test("P3e v2 cast parses roles.X.variants[4] (work/needs/idle/ride); compat x,y on a variant is ignored", () => {
  assert.equal(castV2.ok, true);
  if (!castV2.ok) return;
  assert.equal(castV2.value.version, 2);
  assert.equal(castV2.value.variants.lead.length, 4);
  for (const v of castV2.value.variants.lead) {
    assert.deepEqual(Object.keys(v).sort(), ["idle", "needs", "ride", "work"]); // no stray "x"/"y" pose
    assert.ok(v.work.length >= 1 && v.needs.length >= 1 && v.idle.length >= 1 && v.ride.length >= 1);
  }
  assert.deepEqual(castV2.value.variants.lead[1].work, castV2Json.roles.lead.variants[1].work);
  // v1 keys stay = variant 0
  assert.deepEqual(castV2.value.roles.lead.work, castV2.value.variants.lead[0].work);
});

test("P3e v1 cast still parses (no variants) and v2 lookups pick the variant, wrapping and falling back", () => {
  if (!castV2.ok) return;
  const v1 = validateCast({ version: 1, cell: 32, roles: { lead: { work: [{ x: 0, y: 0 }], needs: [{ x: 1, y: 0 }], idle: [{ x: 2, y: 0 }], ride: [{ x: 3, y: 0 }] } }, bubble: { x: 0, y: 0, w: 1, h: 1, offset: { x: 0, y: 0 } } });
  assert.equal(v1.ok, true);
  assert.deepEqual(v1.value.variants, {});
  assert.deepEqual(roleFrames(v1.value, "lead", "work", 3), [{ x: 0, y: 0 }]); // v1: variant ignored
  const c = castV2.value;
  assert.deepEqual(roleFrames(c, "lead", "work", 2), c.variants.lead[2].work);
  assert.deepEqual(roleFrames(c, "lead", "work", 6), c.variants.lead[2].work); // wraps mod 4
  assert.deepEqual(spriteFrame(c, "lead", "idle", 5, 1), c.variants.lead[1].idle[0]);
  assert.notDeepEqual(roleFrames(c, "lead", "work", 0), roleFrames(c, "lead", "work", 1));
});

test("P3e invalid v2 variants fail validation", () => {
  const bad = structuredClone(castV2Json);
  bad.roles.lead.variants[2].work = [];
  assert.equal(validateCast(bad).ok, false);
  const empty = structuredClone(castV2Json);
  empty.roles.lead.variants = [];
  assert.equal(validateCast(empty).ok, false);
});

test("P3e a seated agent's variant is castVariant(agent.id), the same as its icon", () => {
  const ids = ["w-alpha", "w-bravo", "w-charlie", "w-delta"];
  const tower = buildTower({
    hubBuddy: member("riffbot", { kind: "brainstorm" }),
    hubLead: null,
    teams: [team("x", { lead: member("lead-1", { kind: "lead" }), workers: ids.map((id, i) => member(id, { status: "running", createdAt: new Date(2026, 0, 1, 0, i).toISOString() })) })],
  });
  const a = tower.floors[0].teamA;
  assert.equal(a.lead.variant, castVariant("lead-1"));
  assert.equal(tower.penthouse.riffbot.variant, castVariant("riffbot"));
  for (const d of a.desks) assert.equal(d.variant, castVariant(d.agentId));
});

test("P3e spreadNeighbours: stable when no clash, splits same-row duplicates, never changes items", () => {
  const key = (x) => x.k;
  const same = [{ id: 1, k: "a" }, { id: 2, k: "b" }, { id: 3, k: "c" }];
  assert.deepEqual(spreadNeighbours(same, key), same);
  const dup = [{ id: 1, k: "a" }, { id: 2, k: "a" }, { id: 3, k: "b" }];
  assert.deepEqual(spreadNeighbours(dup, key).map((x) => x.id), [1, 3, 2]);
  // a row break is not a neighbour: slot 3 starts a new row
  const rows = [{ id: 1, k: "a" }, { id: 2, k: "b" }, { id: 3, k: "c" }, { id: 4, k: "c" }];
  assert.deepEqual(spreadNeighbours(rows, key).map((x) => x.id), [1, 2, 3, 4]);
  // all identical: nothing to swap, keep order
  const all = [{ id: 1, k: "a" }, { id: 2, k: "a" }];
  assert.deepEqual(spreadNeighbours(all, key).map((x) => x.id), [1, 2]);
});

test("P3e desk assignment reorders same-look neighbours in a team without touching variants", () => {
  // find three ids: first two share a variant, third differs (same role "implement")
  const byVariant = new Map();
  for (let i = 0; byVariant.size < 4 || [...byVariant.values()].every((l) => l.length < 2); i++) {
    const v = castVariant(`probe-${i}`);
    byVariant.set(v, [...(byVariant.get(v) ?? []), `probe-${i}`]);
  }
  const [vA, vB] = [...byVariant.entries()].filter(([, l]) => l.length >= 2).map(([v]) => v);
  const [a1, a2] = byVariant.get(vA);
  const b1 = byVariant.get([...byVariant.keys()].find((v) => v !== vA))[0];
  const ws = [a1, a2, b1].map((id, i) => member(id, { status: "running", createdAt: new Date(2026, 0, 1, 0, i).toISOString() }));
  const desks = buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", { workers: ws })] }).floors[0].teamA.desks;
  assert.deepEqual(desks.map((d) => d.agentId), [a1, b1, a2]); // spawn order was a1, a2, b1
  assert.deepEqual(desks.map((d) => d.desk), [0, 1, 2]);
  for (const d of desks) assert.equal(d.variant, castVariant(d.agentId));
});
test("P3e real cast.json has no riffbot/overlord roles: no crash, no sprite, the floor draws its fallback box", () => {
  assert.ok(castV2.ok);
  const c = castV2.value;
  assert.equal(c.roles.riffbot, undefined);
  assert.equal(c.roles.overlord, undefined);
  for (const role of ["riffbot", "overlord"]) for (const pose of ["work", "needs", "idle", "ride"]) {
    assert.equal(roleFrames(c, role, pose, 2), null);
    assert.equal(spriteFrame(c, role, pose, 5, 3), null); // Seat renders is-fallback when null
  }
  const t = buildTower({ hubBuddy: member("rb", { kind: "brainstorm" }), hubLead: member("ov", { kind: "lead", status: "running" }), teams: [team("x")] });
  assert.equal(t.penthouse.riffbot.role, "riffbot");
  assert.equal(spriteFrame(c, t.penthouse.overlord.role, t.penthouse.overlord.pose, 0, t.penthouse.overlord.variant), null);
});

// ── P3d CRT screens (Art10 as built, art-crt-screens 6b156b9) ────────────────
const screensJson = JSON.parse(readFileSync(new URL("./fixtures/floor-screens.json", import.meta.url), "utf8"));
const facesJson = JSON.parse(readFileSync(new URL("./fixtures/faces.json", import.meta.url), "utf8"));

test("P3d held Art10 floor.json: screens parse (no penthouse key), screens wins the top band", () => {
  assert.equal(screensJson.penthouse, undefined);
  const v = validateFloor(screensJson);
  assert.equal(v.ok, true);
  const f = v.value;
  assert.equal(f.penthouse, undefined);
  assert.equal(f.screens.plate, "roof");
  assert.equal(f.screens.w, 640);
  assert.equal(f.screens.h, 200);
  assert.equal(f.screens.front, true);
  assert.deepEqual(f.screens.riffbot, { x: 74, y: 52, w: 128, h: 96 });
  assert.deepEqual(f.screens.overlord, { x: 438, y: 52, w: 128, h: 96 });
  assert.deepEqual(f.screens.elevatorTop, { x: 304, y: 146, w: 32, h: 32 });
  assert.deepEqual(topBand(f), { kind: "screens", w: 640, h: 200, elevatorTop: f.screens.elevatorTop, front: true });
});

test("P3d old top band only when neither screens nor penthouse exists", () => {
  const ph = placeholderFloor();
  const none = { ...ph };
  delete none.penthouse;
  assert.equal(topBand(none).kind, "penthouse"); // placeholder penthouse stands in
  assert.equal(topBand(none).h, 200);
  assert.equal(topBand(ph).kind, "penthouse");
  const both = { ...ph, screens: validateFloor(screensJson).value.screens };
  assert.equal(topBand(both).kind, "screens"); // screens beats a penthouse
  assert.equal(validateFloor({ ...screensJson, screens: { plate: "roof", w: 640, h: 200 } }).value.screens, undefined); // incomplete screens ignored
});

test("P3d held faces.json: 128x96 cells, fps 3, frame counts read from the json", () => {
  const v = validateFaces(facesJson);
  assert.equal(v.ok, true);
  const f = v.value;
  assert.deepEqual(f.cell, { w: 128, h: 96 });
  assert.equal(f.fps, 3);
  const count = (bot) => Object.values(f.bots[bot]).reduce((n, frames) => n + frames.length, 0);
  assert.equal(count("riffbot"), 7);
  assert.equal(f.bots.riffbot.talk.length, 3);
  assert.equal(f.bots.riffbot.needs.length, 2);
  assert.equal(count("overlord"), 8);
  assert.equal(f.bots.overlord.idle.length, 2);
  assert.equal(f.bots.overlord.talk.length, 3);
  assert.equal(f.bots.overlord.needs.length, 2);
  assert.equal(validateFaces({}).ok, false);
  assert.equal(validateFaces({ cell: { w: 128, h: 96 }, riffbot: { talk: [{ x: 0, y: 0 }] } }).ok, false); // no idle
  assert.equal(validateFaces({ cell: { w: 128, h: 96 } }).ok, false); // no bots
});

test("P3d face mode: talk while running, needs on needs-you (wins), blink only when otherwise idle, none → idle", () => {
  const seated = (pose) => ({ pose });
  assert.equal(faceMode(seated("work")), "talk");
  assert.equal(faceMode(seated("needs")), "needs");
  assert.equal(faceMode(seated("idle")), "idle");
  assert.equal(faceMode(seated("idle"), true), "blink");
  assert.equal(faceMode(seated("work"), true), "talk");
  assert.equal(faceMode(seated("needs"), true), "needs");
  assert.equal(faceMode(null), "idle");
  assert.equal(faceMode(null, true), "idle"); // an "off" screen never blinks
  // end-to-end with the tower: Overlord running → talk; needs-you → needs; hub Buddy idle → idle
  const t = buildTower({
    hubBuddy: member("riffbot", { kind: "brainstorm" }),
    hubLead: member("overlord", { kind: "lead", status: "running" }),
    teams: [],
  });
  assert.equal(faceMode(t.penthouse.riffbot), "idle");
  assert.equal(faceMode(t.penthouse.overlord), "talk");
  const n = buildTower({ hubBuddy: null, hubLead: member("overlord", { kind: "lead", status: "running", attention: { tone: "needs-you", reason: "x" } }), teams: [] });
  assert.equal(faceMode(n.penthouse.overlord), "needs");
  const none = buildTower({ hubBuddy: null, hubLead: member("gone", { kind: "lead", status: "closed" }), teams: [] });
  assert.equal(none.penthouse.overlord, null); // no live Overlord → dimmed idle screen
});

test("P3d face frames: cycle the frames from the json, fall back to idle, reduced motion = tick 0", () => {
  const f = validateFaces(facesJson).value;
  assert.deepEqual(faceFrame(f, "riffbot", "talk", 0), { x: 256, y: 0 });
  assert.deepEqual(faceFrame(f, "riffbot", "talk", 4), { x: 384, y: 0 }); // wraps over 3 frames
  assert.deepEqual(faceFrame(f, "overlord", "needs", 1), { x: 896, y: 0 });
  const noBlink = { ...f, bots: { riffbot: { idle: f.bots.riffbot.idle } } };
  assert.deepEqual(faceFrame(noBlink, "riffbot", "blink", 3), { x: 0, y: 0 }); // missing mode → idle
  assert.equal(faceFrame(noBlink, "overlord", "idle", 0), null);
});

test("P3d blink spacing is random within 3-8 s", () => {
  assert.equal(nextBlinkDelay(0), BLINK_MIN_MS);
  assert.equal(nextBlinkDelay(1), BLINK_MAX_MS);
  assert.ok(nextBlinkDelay(0.5) > BLINK_MIN_MS && nextBlinkDelay(0.5) < BLINK_MAX_MS);
  assert.equal(nextBlinkDelay(-3), BLINK_MIN_MS);
});

test("P3d wiring moved (C2b G2): the faces + blink/reduced-motion logic live in useBotFace.ts, the tower draws none", () => {
  const hook = readFileSync(new URL("../src/useBotFace.ts", import.meta.url), "utf8");
  assert.ok(hook.includes("if (reduced || !faces)")); // no blink / no ticker under reduced motion
  assert.ok(hook.includes("faces.json"));
  const floorSrc = readFileSync(new URL("../src/SquadFloor.tsx", import.meta.url), "utf8");
  assert.ok(floorSrc.includes("openPinMember(pin, agentId)"));
});

test("floor nits: riders expire at their own start+RIDE_MS; +N lobby badge draws in the bubbles layer above floor-front", () => {
  const src = readFileSync(new URL("../src/SquadFloor.tsx", import.meta.url), "utf8");
  assert.match(src, /r\.start \+ RIDE_MS/);
  assert.match(src, /Math\.min\(\.\.\.riders\.map/);
  assert.doesNotMatch(src, /RIDE_MS \+ 50/);
  assert.match(src, /overlays=\{\s*<>\s*<LobbyPlus/);
  assert.doesNotMatch(src, /extras=\{\s*<>\s*<LobbyPlus/);
  assert.match(src, /\{overlays\}/);
  assert.ok(bandLayers(true).indexOf("front") < bandLayers(true).indexOf("bubbles"));
});
