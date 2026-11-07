import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildTower,
  DESK_COUNT,
  floorOrPlaceholder,
  integerScale,
  LOBBY_MAX_SHOWN,
  needsYouFloors,
  placeholderFloor,
  poseFor,
  roleFrames,
  sliceAnchor,
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
  assert.equal(realCast.value.cell, 32);
  assert.ok(realCast.value.roles.lead && realCast.value.roles.buddy);
  assert.equal(realCast.value.roles.lead.work.length, 2);
  assert.equal(realCast.value.roles.lead.idle.length, 1);
  assert.equal(realCast.value.bubble.offset.x, -16);
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
        workers: [member("w-new", { createdAt: newer }), member("w-old", { createdAt: old })],
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
  const workers = Array.from({ length: 10 }, (_, i) => member(`w${i + 1}`, { createdAt: new Date(2026, 0, 1, 0, i).toISOString() }));
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

test("role → sprite fallback lookup follows cast.fallback", () => {
  if (!realCast.ok) return;
  const cast = realCast.value;
  assert.deepEqual(roleFrames(cast, "spec", "work"), cast.roles.review.work);
  assert.deepEqual(roleFrames(cast, "unknown", "idle"), cast.roles.buddy.idle);
  assert.deepEqual(roleFrames(cast, "mechanical", "ride"), cast.roles.implement.ride);
  assert.equal(roleFrames(cast, "no-such-role", "work"), null);
  assert.equal(spriteFrame(cast, "lead", "work", 0).x, cast.roles.lead.work[0].x);
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
