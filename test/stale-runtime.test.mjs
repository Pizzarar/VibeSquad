import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStale, getStale, resetStaleCache, staleWarning } from "../server/stale-runtime.mjs";

const runtimeWith = (stamp) => {
  const dir = mkdtempSync(join(tmpdir(), "vs-stale-"));
  if (stamp) writeFileSync(join(dir, "build-stamp.json"), JSON.stringify(stamp));
  return dir;
};
const gitFor = (head, behind) => (_repo, args) => (args[0] === "rev-parse" ? head : String(behind));

test("older build is stale with the behind count", () => {
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo: "/r" });
  assert.deepEqual(computeStale({ rootDir, git: gitFor("bbbbbbb2222", 46), exists: () => true }), { built: "aaaaaaa", head: "bbbbbbb", behind: 46 });
});

test("same commit is not stale", () => {
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo: "/r" });
  assert.equal(computeStale({ rootDir, git: gitFor("aaaaaaa1111", 0), exists: () => true }), null);
});

test("missing stamp, missing repo, or git failure is not stale", () => {
  assert.equal(computeStale({ rootDir: runtimeWith(null) }), null);
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo: "/r" });
  assert.equal(computeStale({ rootDir, git: gitFor("b", 3), exists: () => false }), null);
  assert.equal(computeStale({ rootDir, git: () => { throw new Error("no git"); }, exists: () => true }), null);
});

test("getStale caches for a minute and staleWarning reads the published file", () => {
  const home = mkdtempSync(join(tmpdir(), "vs-stale-home-"));
  const env = { VIBESQUAD_HOME: home };
  resetStaleCache();
  let calls = 0;
  const compute = () => (++calls, { built: "aaaaaaa", head: "bbbbbbb", behind: 1 });
  getStale({ rootDir: "x", env, now: 1000, compute });
  getStale({ rootDir: "x", env, now: 2000, compute });
  assert.equal(calls, 1);
  assert.match(staleWarning(env), /older build: 1 commit behind/);
  resetStaleCache();
  getStale({ rootDir: "x", env, now: 1000, compute: () => null });
  assert.equal(staleWarning(env), null);
});
