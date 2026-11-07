import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  blipMotion,
  buildTower,
  BLIP_PX,
  placeholderFloor,
  tvBlips,
  tvCapacity,
  tvCountText,
  validateFloor,
} from "../src/squadFloorLogic.ts";

// F4b: stats TV blips for overflow workers (docs/PLAN_FLOOR_RELAYOUT_F4.md). Built against an 11-desk fixture
// floor.json (the @art F4a contract: no `facing`, optional per-team `statsTv`); real art comes later.
const member = (id, { status = "running", createdAt, attention = null, title } = {}) => ({
  agent: { id, title: title ?? id, status, updatedAt: createdAt ?? "2026-11-01T00:00:00Z", archivedAt: null, labels: {}, createdAt },
  attention,
  kind: "worker",
  agentType: "implement",
});
const team = (laneId, workers) => ({ laneId, name: laneId, lead: null, buddy: null, workers });
const needs = { tone: "needs-you", reason: "needs you" };

const desks = (x0, dx) => Array.from({ length: 11 }, (_, i) => ({ x: x0 + (i % 6) * dx, y: 120 + Math.floor(i / 6) * 60, w: 32, h: 28 }));
const fixtureJson = (extra = {}) => ({
  teamA: { lead: { x: 8, y: 8, w: 32, h: 28 }, buddyOffice: { x: 8, y: 8, w: 32, h: 32 }, desks: desks(16, 40), statsTv: { x: 120, y: 20, w: 40, h: 28 }, ...extra.A },
  teamB: { lead: { x: 600, y: 8, w: 32, h: 28 }, buddyOffice: { x: 600, y: 8, w: 32, h: 32 }, desks: desks(360, 40), statsTv: { x: 480, y: 20, w: 40, h: 28 }, ...extra.B },
  elevator: { doorA: { x: 304, y: 220, w: 14, h: 44 }, doorB: { x: 322, y: 220, w: 14, h: 44 }, car: { x: 300, y: 96, w: 40, h: 130 } },
});
const fixture = (extra) => {
  const v = validateFloor(fixtureJson(extra));
  assert.equal(v.ok, true);
  return v.value;
};
// n running workers, oldest first (w00 ..), optional ids that need you
const workers = (n, needy = []) =>
  Array.from({ length: n }, (_, i) => {
    const id = `w${String(i).padStart(2, "0")}`;
    return member(id, { createdAt: `2026-11-01T00:${String(i).padStart(2, "0")}:00Z`, ...(needy.includes(id) ? { attention: needs } : {}) });
  });
const place = (n, floor, needy) => buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", workers(n, needy))] }, floor).floors[0].teamA;
const GLASS = { x: 0, y: 0, w: 40, h: 28 };

test("fixture: 11 desks and a statsTv rect validate; no facing field", () => {
  const f = fixture();
  assert.equal(f.teamA.desks.length, 11);
  assert.deepEqual(f.teamB.statsTv, { x: 480, y: 20, w: 40, h: 28 });
  assert.equal("facing" in f.teamA.desks[0], false);
});

test("statsTv invalid or missing → dropped, behaviour as today", () => {
  for (const bad of [{ x: 1, y: 1, w: 0, h: 28 }, { x: 1, y: 1, w: 40, h: -1 }, { x: "1", y: 1, w: 40, h: 28 }, "tv", 5, { x: 1, y: 1 }]) {
    const v = validateFloor(fixtureJson({ A: { statsTv: bad } }));
    assert.equal(v.ok, true, "floor itself still valid");
    assert.equal(v.value.teamA.statsTv, undefined);
    assert.ok(v.value.teamB.statsTv, "other team keeps its TV");
  }
  assert.equal(placeholderFloor().teamA.statsTv, undefined);
});

test("no overflow: 11 workers fill 11 desks, TV empty", () => {
  const a = place(11, fixture());
  assert.equal(a.desks.length, 11);
  assert.deepEqual(a.tv, []);
  assert.deepEqual(a.lobby, []);
});

test("overflow → blips: counts and oldest-first order, lobby empty", () => {
  const a = place(16, fixture());
  assert.equal(a.desks.length, 11);
  assert.equal(a.tv.length, 5);
  assert.deepEqual(a.tv.map((s) => s.agentId), ["w11", "w12", "w13", "w14", "w15"]);
  assert.ok(a.tv.every((s) => s.seat === "tv"));
  assert.equal(a.lobby.length, 0);
  assert.equal(a.lobbyOverflow, 0);
  assert.equal(new Set([...a.desks, ...a.tv].map((s) => s.agentId)).size, 16, "each worker shows exactly once");
});

test("blip layout: clusters of 4 (2x2), inside the glass, no overlap, count right up to capacity", () => {
  assert.equal(tvCapacity(GLASS), 32);
  const blips = tvBlips(GLASS, place(11 + 9, fixture()).tv);
  assert.equal(blips.length, 9);
  const cells = new Set();
  for (const b of blips) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + BLIP_PX <= GLASS.w && b.y + BLIP_PX <= GLASS.h, "inside glass");
    cells.add(`${b.x},${b.y}`);
  }
  assert.equal(cells.size, 9, "no two blips share a cell");
  assert.deepEqual(blips.slice(0, 4).map((b) => [b.x, b.y]), [[2, 2], [6, 2], [2, 6], [6, 6]]);
  assert.deepEqual([blips[4].x, blips[4].y], [10, 2], "fifth blip starts the next cluster");
  const full = tvBlips(GLASS, place(11 + 40, fixture()).tv);
  assert.equal(full.length, 32);
  assert.ok(full.every((b) => b.x + BLIP_PX <= GLASS.w && b.y + BLIP_PX <= GLASS.h - 4));
  assert.equal(tvCountText(40), "40");
  assert.equal(tvCountText(7), "07");
  assert.equal(tvCountText(250), "99");
});

test("needs-you overflow worker is a pink-tone blip that blinks; working pulses", () => {
  const blips = tvBlips(GLASS, place(14, fixture(), ["w12"]).tv);
  assert.deepEqual(blips.map((b) => b.tone), ["work", "needs", "work"]);
  assert.equal(blipMotion("needs", false), "blink");
  assert.equal(blipMotion("work", false), "pulse");
});

test("a needs-you blip raises the floor's needsYou mark", () => {
  const hot = buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", workers(13, ["w12"]))] }, fixture());
  assert.equal(hot.floors[0].needsYou, true);
  const calm = buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", workers(13))] }, fixture());
  assert.equal(calm.floors[0].needsYou, false);
});

test("reduced motion: no blink, no pulse; needs stays pink (tone unchanged)", () => {
  assert.equal(blipMotion("needs", true), "none");
  assert.equal(blipMotion("work", true), "none");
  assert.equal(tvBlips(GLASS, place(12, fixture(), ["w11"]).tv)[0].tone, "needs");
});

test("teamB uses its own slices", () => {
  const f = fixture({ B: { desks: desks(360, 40).slice(0, 4) } });
  const t = buildTower({ hubBuddy: null, hubLead: null, teams: [team("a", workers(8)), team("b", workers(8))] }, f);
  assert.equal(t.floors[0].teamA.desks.length, 8);
  assert.equal(t.floors[0].teamA.tv.length, 0);
  assert.equal(t.floors[0].teamB.desks.length, 4);
  assert.equal(t.floors[0].teamB.tv.length, 4);
});

test("missing statsTv → lobby fallback, even with 11 desks", () => {
  const f = fixture({ A: { statsTv: undefined } });
  assert.equal(f.teamA.statsTv, undefined);
  const a = place(16, f);
  assert.equal(a.desks.length, 11);
  assert.equal(a.tv.length, 0);
  assert.equal(a.lobby.length, 3);
  assert.equal(a.lobbyOverflow, 2);
});

test("buildTower without a floor behaves as before (6 desks, lobby)", () => {
  const a = buildTower({ hubBuddy: null, hubLead: null, teams: [team("x", workers(10))] }).floors[0].teamA;
  assert.equal(a.desks.length, 6);
  assert.equal(a.lobby.length, 3);
  assert.equal(a.lobbyOverflow, 1);
  assert.deepEqual(a.tv, []);
});

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
test("SquadFloor wires the TV: focusable button, aria-label, tooltip, open; below the front overlay", () => {
  const s = src("SquadFloor.tsx");
  assert.match(s, /<button[\s\S]*?sq-floor-blip[\s\S]*?aria-label=\{`\$\{agent\.title\}, \$\{status\}`\}/);
  assert.match(s, /title=\{`\$\{agent\.title\} · \$\{status\}`\}/);
  assert.match(s, /onClick=\{\(\) => onOpen\(agent\.agentId\)\}/);
  assert.match(s, /openAgent\(f\.teamA\.laneId, id\)/);
  assert.match(s, /towerForView\(view, floor\)/);
  assert.match(s, /\{plate\}\{wall\}/);
  assert.match(s, /blipMotion\(tone, reduced\)/);
});

test("css: blink and pulse are off under prefers-reduced-motion; pink blip and light-theme TV exist", () => {
  const c = src("styles.css");
  assert.match(c, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sq-floor-blip\.is-pulse, \.sq-floor-blip\.is-blink, \.sq-floor-tv-beat \{ animation: none; \}/);
  assert.match(c, /\.sq-floor-blip\.is-needs \{ background: var\(--hot-pink\); \}/);
  assert.match(c, /:root\[data-theme="light"\] \.sq-floor-tv/);
});
