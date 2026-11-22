import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStale, getStale, packagedStamp, readBuildStamp, resetStaleCache, staleWarning } from "../server/stale-runtime.mjs";

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vs-stale-")); tmpDirs.push(d); return d; };
const runtimeWith = (stamp) => {
  const dir = tmp();
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
  const home = tmp();
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

test("refreshStale never blocks the loop on git and is single-flight (idea-225)", async () => {
  const { refreshStale, peekStale, computeStaleAsync } = await import("../server/stale-runtime.mjs");
  const home = tmp();
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo: "/r" });
  resetStaleCache();
  let calls = 0;
  const compute = async () => { calls++; await new Promise((r) => setTimeout(r, 300)); return { built: "aaaaaaa", head: "bbbbbbb", behind: 2 }; };
  let maxGap = 0, last = performance.now();
  const iv = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 10);
  const p1 = refreshStale({ rootDir, env: { VIBESQUAD_HOME: home }, now: 1000, compute });
  const p2 = refreshStale({ rootDir, env: { VIBESQUAD_HOME: home }, now: 1001, compute });
  assert.equal(peekStale(), null);
  await Promise.all([p1, p2]);
  clearInterval(iv);
  assert.equal(calls, 1);
  assert.ok(maxGap < 100, `loop gap ${maxGap}ms`);
  assert.equal(peekStale().behind, 2);
  assert.match(staleWarning({ VIBESQUAD_HOME: home }), /2 commits behind/);
  assert.deepEqual(await computeStaleAsync({ rootDir, git: async (_r, a) => (a[0] === "rev-parse" ? "bbbbbbb2222" : "46"), exists: () => true }), { built: "aaaaaaa", head: "bbbbbbb", behind: 46 });
});

test("/health source never calls the sync getStale", async () => {
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync(new URL("../server/vibesquad-api.mjs", import.meta.url), "utf8"), /getStale\(/);
  assert.doesNotMatch(readFileSync(new URL("../server/serve.mjs", import.meta.url), "utf8"), /getStale\(/);
});

test("peekStale drops a cached value once a sync rewrote the build stamp (idea-276)", async () => {
  const { writeFileSync } = await import("node:fs");
  const { refreshStale, peekStale } = await import("../server/stale-runtime.mjs");
  const home = tmp();
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo: "/r" });
  resetStaleCache();
  await refreshStale({ rootDir, env: { VIBESQUAD_HOME: home }, now: 1000, compute: async () => ({ built: "aaaaaaa", head: "bbbbbbb", behind: 2 }) });
  assert.equal(peekStale(rootDir).behind, 2);
  writeFileSync(join(rootDir, "build-stamp.json"), JSON.stringify({ commit: "bbbbbbb2222", repo: "/r" }));
  assert.equal(peekStale(rootDir), null);
});

test("reset --keep back to the built commit is not stale and never names the dropped commit (idea-377)", () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = tmp();
  const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv }).trim();
  git("init", "-q", "-b", "master");
  git("commit", "-q", "--allow-empty", "-m", "A");
  const A = git("rev-parse", "HEAD");
  const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir");

  const runtime = tmp();
  writeFileSync(join(runtime, "build-stamp.json"), JSON.stringify({ commit: A, repo: commonDir, builtAt: "t" }));

  // Not stale while HEAD is the built commit.
  assert.equal(computeStale({ rootDir: runtime }), null);

  // Commit B -> 1 behind.
  git("commit", "-q", "--allow-empty", "-m", "B");
  const B = git("rev-parse", "HEAD");
  assert.deepEqual(computeStale({ rootDir: runtime }), { built: A.slice(0, 7), head: B.slice(0, 7), behind: 1 });

  // The cached/warning path reports B while it is HEAD.
  const home = tmp();
  const env = { VIBESQUAD_HOME: home };
  resetStaleCache();
  assert.equal(getStale({ rootDir: runtime, env, now: 1000 }).behind, 1);
  assert.match(staleWarning(env), /1 commit behind/);

  // reset --keep back to A: not behind, and the message must not name B.
  git("reset", "-q", "--keep", "HEAD~1");
  assert.equal(git("rev-parse", "HEAD"), A);
  assert.equal(computeStale({ rootDir: runtime }), null);
  // The cache is keyed on HEAD too, so a reset within the 60s window forces a recompute (not the dropped commit B).
  assert.equal(getStale({ rootDir: runtime, env, now: 2000 }), null);
  assert.equal(staleWarning(env), null);
});
