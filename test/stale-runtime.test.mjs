import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStale, getStale, packagedStamp, readBuildStamp, resetStaleCache, staleWarning } from "../server/stale-runtime.mjs";

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

test("packaged stamp has no repo path; a repo-less stamp reads fine and is never stale", () => {
  const stamp = packagedStamp({ commit: "aaaaaaa1111", builtAt: "t", repo: "C:/Users/x/.git" });
  assert.deepEqual(Object.keys(stamp).sort(), ["builtAt", "commit"]);
  const rootDir = runtimeWith(stamp);
  assert.equal(readBuildStamp(rootDir).commit, "aaaaaaa1111");
  assert.equal(readBuildStamp(rootDir).repo, undefined);
  assert.equal(computeStale({ rootDir, git: () => { throw new Error("must not run git"); }, exists: () => true }), null);
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
