import assert from "node:assert/strict";
import test from "node:test";
import { findLaneInRegistry as srv } from "../server/identity.mjs";
import { findLaneInRegistry as front } from "../src/identity.ts";

// idea-1220: src/identity.ts mirrors the server's live-first lane handle rule (idea-1215).
const lane = (id, name, extra = {}) => ({ id, name, ...extra });
const both = (q, teams, pref = "") => [front(q, teams, pref)?.lane.id ?? null, srv(q, teams, pref)?.lane.id ?? null];

test("removed lane never shadows a live lane's code (frontend mirrors server)", () => {
  const teams = [{ id: "s", name: "S", lanes: [lane("release-0-2", "Release 0.2.0", { state: "removed", code: "Rel" }), lane("release-desk", "Release Desk")] }];
  const [f, s] = both("@rel", teams, "s");
  assert.equal(f, "release-desk");
  assert.equal(s, "release-desk");
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
