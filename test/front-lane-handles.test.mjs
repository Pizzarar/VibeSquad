import assert from "node:assert/strict";
import test from "node:test";
import { findLaneInRegistry as srv, resolveAgentIdentity as srvResolve } from "../server/identity.mjs";
import { findLaneInRegistry as front, resolveAgentIdentity as frontResolve } from "../src/identity.ts";

// idea-1220: src/identity.ts mirrors the server's live-first lane handle rule (idea-1215).
const lane = (id, name, extra = {}) => ({ id, name, ...extra });
const both = (q, teams, pref = "") => [front(q, teams, pref)?.lane.id ?? null, srv(q, teams, pref)?.lane.id ?? null];

test("removed lane never shadows a live lane's code (frontend mirrors server)", () => {
  const teams = [{ id: "s", name: "S", lanes: [lane("release-0-2", "Release 0.2.0", { state: "removed", code: "Rel" }), lane("release-desk", "Release Desk")] }];
  const [f, s] = both("@rel", teams, "s");
  assert.equal(f, "release-desk");
  assert.equal(s, "release-desk");
  // Same bumped live lane with empty preferTeamId
  assert.deepEqual(both("@rel", teams), ["release-desk", "release-desk"]);
});

test("resolveAgentIdentity forwards preferTeamId across Squads sharing a code", () => {
  const teams = [
    { id: "alpha", name: "Alpha", lanes: [lane("alpha-rel", "Release Alpha", { code: "Rel" })] },
    { id: "beta", name: "Beta", lanes: [lane("beta-rel", "Release Beta", { code: "Rel" })] },
  ];
  const fBeta = frontResolve({ labels: { lane: "@rel", team: "beta" } }, { teams });
  const sBeta = srvResolve({ labels: { lane: "@rel", team: "beta" } }, { teams });
  assert.equal(fBeta.teamId, "beta");
  assert.equal(fBeta.laneId, "beta-rel");
  assert.equal(fBeta.teamMismatch, false);
  assert.equal(sBeta.teamId, "beta");
  assert.equal(sBeta.laneId, "beta-rel");
  assert.equal(sBeta.teamMismatch, false);
});

test("live lane beats removed lane with same code across Squads", () => {
  const teams = [
    { id: "a", name: "A", lanes: [lane("old", "Old", { removedAt: 1, code: "Zed" })] },
    { id: "b", name: "B", lanes: [lane("new", "New", { code: "Zed" })] },
  ];
  assert.deepEqual(both("zed", teams), ["new", "new"]);
});

test("two live lanes claiming one code in a Squad fail closed", () => {
  const teams = [{ id: "s", name: "S", lanes: [lane("x1", "X One", { code: "Xx" }), lane("x2", "X Two", { code: "Xx" })] }];
  assert.deepEqual(both("xx", teams, "s"), [null, null]);
  assert.deepEqual(both("@xx", teams), [null, null]);
});

test("a tag only a removed lane holds still names it", () => {
  const teams = [{ id: "s", name: "S", lanes: [lane("gone", "Gone", { state: "removed", code: "Gon" })] }];
  assert.deepEqual(both("gon", teams, "s"), ["gone", "gone"]);
});
