// idea-518 part B, Tier A R2 (H1): git-refs-fs never answers a stale or guessed sha. Whenever the .git files can't answer
// the way git would (locked/unreadable file, half-written or empty loose ref, a .lock beside a ref, symref chain past the
// hop cap, malformed packed-refs) it returns null, and every caller treats null as "ask git", never as "no refs".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitDirsFs, readHeadFs, resolveRefsFs } from "../server/git-refs-fs.mjs";
import { _resetGitHelperCaches, gitHelperStats, gitUnitBranchState, inspectGitSpawnState } from "../server/hooks/agent-duties.ts";
import { createWorktreeAutoSweep } from "../server/worktree-autosweep.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-grf-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  const wt = path.join(dir, "wt");
  git(repo, "worktree", "add", "-q", "-b", "unit-x", wt);
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  git(wt, "add", "b.txt");
  git(wt, "commit", "-q", "-m", "unit work");
  const gitDir = path.join(repo, ".git");
  return { dir, repo, wt, gitDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const errno = (code) => Object.assign(new Error(`${code}: simulated`), { code });

/** Make fs.promises.readFile throw `code` for paths matching `match` (git-refs-fs calls through the shared promises object). */
function failReads(t, match, code) {
  const orig = fs.promises.readFile;
  t.mock.method(fs.promises, "readFile", function (p, ...rest) {
    if (match(String(p))) return Promise.reject(errno(code));
    return orig.call(this, p, ...rest);
  });
}

test("H1: half-written or empty loose ref over packed-refs answers null, not the stale packed sha", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const dirs = await gitDirsFs(r.repo);
  git(r.repo, "pack-refs", "--all");
  const packedMaster = git(r.repo, "rev-parse", "master");
  assert.equal((await resolveRefsFs(dirs, ["refs/heads/master"])).get("refs/heads/master"), packedMaster, "packed only");

  const loose = path.join(r.gitDir, "refs", "heads", "master");
  for (const junk of ["deadbeef\n", "", "\n", "ref: \n", packedMaster.slice(0, 20)]) {
    fs.writeFileSync(loose, junk);
    assert.equal(await resolveRefsFs(dirs, ["refs/heads/master"]), null, `loose ${JSON.stringify(junk)} -> null`);
  }
  fs.writeFileSync(loose, `${packedMaster.toUpperCase()}\n`);
  assert.equal((await resolveRefsFs(dirs, ["refs/heads/master"])).get("refs/heads/master"), packedMaster, "upper-case sha accepted, lower-cased");
  fs.rmSync(loose);
  assert.equal((await resolveRefsFs(dirs, ["refs/heads/master"])).get("refs/heads/master"), packedMaster, "gone again: packed");
});

test("H1: a .lock beside HEAD, a loose ref or packed-refs answers null", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const dirs = await gitDirsFs(r.repo);
  const wtDirs = await gitDirsFs(r.wt);
  const ok = await resolveRefsFs(dirs, ["refs/heads/master", "refs/heads/unit-x"]);
  assert.equal(ok.size, 2);

  const masterLock = path.join(r.gitDir, "refs", "heads", "master.lock");
  fs.writeFileSync(masterLock, "");
  assert.equal(await resolveRefsFs(dirs, ["refs/heads/master"]), null, "<ref>.lock");
  assert.ok(await resolveRefsFs(dirs, ["refs/heads/unit-x"]), "other refs unaffected");
  fs.rmSync(masterLock);

  const headLock = path.join(wtDirs.gitDir, "HEAD.lock");
  fs.writeFileSync(headLock, "");
  assert.equal(await readHeadFs(wtDirs), null, "HEAD.lock -> readHeadFs null");
  assert.equal(await resolveRefsFs(wtDirs, ["HEAD"]), null, "HEAD.lock -> resolveRefsFs(HEAD) null");
  fs.rmSync(headLock);
  assert.deepEqual(await readHeadFs(wtDirs), { branch: "unit-x" });

  git(r.repo, "pack-refs", "--all");
  const packedLock = path.join(r.gitDir, "packed-refs.lock");
  fs.writeFileSync(packedLock, "");
  assert.equal(await resolveRefsFs(dirs, ["refs/heads/master"]), null, "packed-refs.lock while the ref is only packed");
  fs.rmSync(packedLock);
  assert.ok((await resolveRefsFs(dirs, ["refs/heads/master"])).get("refs/heads/master"));
});

test("H1: locked/unreadable loose ref, packed-refs, HEAD, .git or commondir answer null (never an empty Map)", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const dirs = await gitDirsFs(r.repo);
  const wtDirs = await gitDirsFs(r.wt);
  git(r.repo, "pack-refs", "--all");
  const isPacked = (p) => path.basename(p) === "packed-refs";
  const isLooseMaster = (p) => p.endsWith(path.join("refs", "heads", "master"));

  await t.test("packed-refs EBUSY", async (t) => {
    failReads(t, isPacked, "EBUSY");
    const got = await resolveRefsFs(dirs, ["refs/heads/master"]);
    assert.equal(got, null, "locked packed-refs is not an empty Map");
  });
  await t.test("packed-refs EACCES", async (t) => {
    failReads(t, isPacked, "EACCES");
    assert.equal(await resolveRefsFs(dirs, ["refs/heads/master", "refs/heads/nope"]), null);
  });
  await t.test("loose ref EPERM does not fall through to packed-refs", async (t) => {
    fs.writeFileSync(path.join(r.gitDir, "refs", "heads", "master"), `${git(r.repo, "rev-parse", "master")}\n`);
    failReads(t, isLooseMaster, "EPERM");
    assert.equal(await resolveRefsFs(dirs, ["refs/heads/master"]), null);
  });
  await t.test("HEAD EBUSY", async (t) => {
    failReads(t, (p) => path.basename(p) === "HEAD", "EBUSY");
    assert.equal(await readHeadFs(wtDirs), null);
  });
  await t.test("commondir EBUSY does not pass the worktree gitdir off as the common dir", async (t) => {
    failReads(t, (p) => path.basename(p) === "commondir", "EBUSY");
    assert.equal(await gitDirsFs(r.wt), null);
  });
  await t.test(".git stat EPERM does not walk up into an enclosing repo", async (t) => {
    const inner = path.join(r.repo, "sub");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
    const orig = fs.promises.stat;
    t.mock.method(fs.promises, "stat", function (p, ...rest) {
      if (String(p) === path.join(inner, ".git")) return Promise.reject(errno("EPERM"));
      return orig.call(this, p, ...rest);
    });
    assert.equal(await gitDirsFs(inner), null);
  });
  await t.test("malformed packed-refs line", async () => {
    const packedPath = path.join(r.gitDir, "packed-refs");
    const good = fs.readFileSync(packedPath, "utf8");
    fs.writeFileSync(packedPath, `${good}deadbeef refs/heads/half\n`);
    assert.equal(await resolveRefsFs(dirs, ["refs/heads/unit-x"]), null);
    fs.writeFileSync(packedPath, good);
    assert.ok(await resolveRefsFs(dirs, ["refs/heads/unit-x"]));
  });
});

test("H1: symref chains resolve within the cap, answer null past it, and unsafe targets are refused", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const dirs = await gitDirsFs(r.repo);
  const heads = path.join(r.gitDir, "refs", "heads");
  const master = git(r.repo, "rev-parse", "master");
  fs.writeFileSync(path.join(heads, "c0"), "ref: refs/heads/c1\n");
  fs.writeFileSync(path.join(heads, "c1"), "ref: refs/heads/master\n");
  assert.equal((await resolveRefsFs(dirs, ["refs/heads/c0"])).get("refs/heads/c0"), master, "2-hop chain");
  assert.equal((await resolveRefsFs(dirs, ["refs/heads/c0"])).get("refs/heads/c0"), git(r.repo, "rev-parse", "refs/heads/c0"));

  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(heads, `s${i}`), `ref: refs/heads/s${i + 1}\n`);
  fs.writeFileSync(path.join(heads, "s5"), `${master}\n`);
  assert.equal(await resolveRefsFs(dirs, ["refs/heads/s0"]), null, "hop cap exhausted -> null, not missing");
  assert.equal((await resolveRefsFs(dirs, ["refs/heads/s1"])).get("refs/heads/s1"), master, "4 symref hops + the sha fits the cap");

  fs.writeFileSync(path.join(heads, "evil"), "ref: refs/../../../outside\n");
  assert.equal(await resolveRefsFs(dirs, ["refs/heads/evil"]), null, "target escaping refs/");
  fs.writeFileSync(path.join(heads, "evil"), "ref: refs/heads\\..\\..\\HEAD\n");
  assert.equal(await resolveRefsFs(dirs, ["refs/heads/evil"]), null, "backslash target");
  assert.equal(await resolveRefsFs(dirs, ["refs/heads/../HEAD"]), null, "caller-supplied unsafe name");

  const missing = await resolveRefsFs(dirs, ["refs/heads/nope", "refs/heads/master"]);
  assert.ok(missing, "a missing ref is still an answer (left out), not null");
  assert.equal(missing.has("refs/heads/nope"), false);
  assert.equal(missing.get("refs/heads/master"), master);
});

test("H1: slash refs (feat/x) resolve loose and packed, HEAD on a slash branch, the dir name itself is missing", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  git(r.wt, "checkout", "-q", "-b", "feat/x");
  git(r.repo, "branch", "team/lane/unit-y", "master");
  const dirs = await gitDirsFs(r.repo);
  const wtDirs = await gitDirsFs(r.wt);
  assert.deepEqual(await readHeadFs(wtDirs), { branch: "feat/x" });
  const want = ["refs/heads/feat/x", "refs/heads/team/lane/unit-y", "refs/heads/feat"];
  const loose = await resolveRefsFs(dirs, want);
  assert.equal(loose.get(want[0]), git(r.repo, "rev-parse", "feat/x"));
  assert.equal(loose.get(want[1]), git(r.repo, "rev-parse", "team/lane/unit-y"));
  assert.equal(loose.has(want[2]), false, "refs/heads/feat is a directory, not a ref");
  git(r.repo, "pack-refs", "--all");
  const packed = await resolveRefsFs(dirs, want);
  assert.deepEqual([...packed], [...loose], "packed answers match loose");
  assert.equal((await resolveRefsFs(wtDirs, ["HEAD"])).get("HEAD"), git(r.wt, "rev-parse", "HEAD"));
});

test("H1 callers: null from git-refs-fs makes the duties sweep, spawn snapshot and auto-sweep ask git", async (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  git(r.repo, "pack-refs", "--all");
  const loose = path.join(r.gitDir, "refs", "heads", "master");
  fs.writeFileSync(loose, "deadbeef"); // half-written: the fs path must not use the stale packed master

  _resetGitHelperCaches();
  const before = gitHelperStats.unitBranchGit;
  await gitUnitBranchState(r.wt);
  assert.ok(gitHelperStats.unitBranchGit > before, "gitUnitBranchState fell back to git");

  // inspectGitSpawnState: no fingerprint -> no cache hit, git runs every time.
  fs.rmSync(loose);
  const headLock = path.join((await gitDirsFs(r.wt)).gitDir, "HEAD.lock");
  _resetGitHelperCaches();
  await inspectGitSpawnState(r.wt, { timeoutMs: 30_000 });
  const afterFirst = gitHelperStats.spawnStateGit;
  assert.ok(afterFirst >= 1);
  await inspectGitSpawnState(r.wt, { timeoutMs: 30_000 });
  assert.equal(gitHelperStats.spawnStateGit, afterFirst, "readable .git: cache hit");
  fs.writeFileSync(path.join(r.gitDir, "packed-refs.lock"), "");
  await inspectGitSpawnState(r.wt, { timeoutMs: 30_000 });
  assert.ok(gitHelperStats.spawnStateGit > afterFirst, "packed-refs.lock: no fingerprint, git asked again");
  fs.rmSync(path.join(r.gitDir, "packed-refs.lock"));
  assert.equal(fs.existsSync(headLock), false);

  // Auto-sweep default readRefs: locked packed-refs -> for-each-ref (not an empty Map that skips the repo silently).
  await t.test("auto-sweep", async (t) => {
    failReads(t, (p) => path.basename(p) === "packed-refs", "EBUSY");
    const seen = [];
    const sweep = createWorktreeAutoSweep({
      root: r.dir,
      listAgents: async () => [],
      log: () => {},
      runHeavy: async (name) => (name === "repos" ? [{ repo: { name: "r", repoRoot: r.repo }, def: { name: "master", refs: ["refs/heads/master"] } }] : { results: [] }),
      yieldLoop: async () => {},
      gitAsync: async (args) => (seen.push(args[0]), null),
    });
    await sweep.tick();
    assert.deepEqual(seen, ["for-each-ref"]);
  });
});
