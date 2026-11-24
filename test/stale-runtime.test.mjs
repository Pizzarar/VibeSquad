import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStale, getStale, packagedStamp, readBuildStamp, readRefSha, resetStaleCache, staleWarning } from "../server/stale-runtime.mjs";

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

test("computeStale compares against refs/heads/master, not HEAD (idea-377 M1)", () => {
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo: "/r" });
  const calls = [];
  const git = (_repo, args) => { calls.push(args); return args[0] === "rev-parse" ? "bbbbbbb2222" : "46"; };
  assert.deepEqual(computeStale({ rootDir, git, exists: () => true }), { built: "aaaaaaa", head: "bbbbbbb", behind: 46 });
  assert.deepEqual(calls[0], ["rev-parse", "master"]);
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

test("readRefSha resolves a ref from packed-refs", () => {
  const sha = "c".repeat(40);
  const gitDir = tmp();
  writeFileSync(join(gitDir, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted \n${sha} refs/heads/master\n`);
  assert.equal(readRefSha(gitDir, "refs/heads/master"), sha);
});

test("readRefSha returns null for a missing ref", () => {
  const gitDir = tmp();
  writeFileSync(join(gitDir, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted \n${"d".repeat(40)} refs/heads/other\n`);
  assert.equal(readRefSha(gitDir, "refs/heads/master"), null);
});

test("readRefSha follows a linked worktree .git file and commondir", () => {
  const sha = "e".repeat(40);
  const mainGit = tmp();
  mkdirSync(join(mainGit, "refs", "heads"), { recursive: true });
  writeFileSync(join(mainGit, "refs", "heads", "master"), `${sha}\n`);
  const wtGit = join(mainGit, "worktrees", "wt");
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, "commondir"), "../..\n");
  writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/master\n");
  const wtRoot = tmp();
  writeFileSync(join(wtRoot, ".git"), `gitdir: ${wtGit}\n`);
  assert.equal(readRefSha(wtRoot, "refs/heads/master"), sha);
});

test("staleWarning suppresses once refs/heads/master moves (reset --keep dropped the named head, idea-377)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const gitDir = tmp();
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(join(gitDir, "refs", "heads", "master"), `${B}\n`);

  const home = tmp();
  const env = { VIBESQUAD_HOME: home };
  writeFileSync(join(home, "stale.json"), JSON.stringify({ stale: { built: A.slice(0, 7), head: B.slice(0, 7), behind: 1 }, master: B, repo: gitDir }));

  // While master is B, the warning names B.
  assert.match(staleWarning(env), /1 commit behind/);
  assert.match(staleWarning(env), new RegExp(B.slice(0, 7)));

  // reset --keep back to A: master moves to A, so the warning must not name the dropped B.
  writeFileSync(join(gitDir, "refs", "heads", "master"), `${A}\n`);
  assert.equal(staleWarning(env), null);
});

test("idea-595: a master that moved (reset away) invalidates the 60s cache for refreshStale, getStale and peekStale", async () => {
  const { refreshStale, peekStale } = await import("../server/stale-runtime.mjs");
  const home = tmp();
  const repo = tmp(); // acts as the git dir: readRefSha reads refs/heads/master from it
  mkdirSync(join(repo, "refs", "heads"), { recursive: true });
  const setMaster = (c) => writeFileSync(join(repo, "refs", "heads", "master"), `${c.repeat(40)}\n`);
  const rootDir = runtimeWith({ commit: "aaaaaaa1111", repo });
  resetStaleCache();
  setMaster("b");
  let calls = 0;
  const compute = async () => { calls++; return { built: "aaaaaaa", head: "bbbbbbb", behind: 2 }; };
  await refreshStale({ rootDir, env: { VIBESQUAD_HOME: home }, now: 1000, compute });
  await refreshStale({ rootDir, env: { VIBESQUAD_HOME: home }, now: 2000, compute });
  assert.equal(calls, 1, "unchanged master stays cached");
  assert.equal(peekStale(rootDir).behind, 2);
  setMaster("c"); // reset-away / new commit within the 60s window
  assert.equal(peekStale(rootDir), null, "peek drops the value at once");
  await refreshStale({ rootDir, env: { VIBESQUAD_HOME: home }, now: 3000, compute });
  assert.equal(calls, 2, "refresh recomputes despite being inside 60s");
});
