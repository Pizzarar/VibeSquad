// idea-1043 (repeat of idea-949): a read-only MEAS worktree (branch at origin/main, zero commits) was swept while its worker was
// auto-archived between turns (resumable): ancestry alone said "merged". idea-1059: `vs worktree sweep --apply` ran >100s with no
// output (all repos; one game repo alone took 198s: a stale local main made every unmerged worktree pay a cherry + 5 MB squash
// diff against a far-back fork point). Fixes: holdAgentCwds + worktreeHasOwnCommit, ancestor-ref dedupe, per-worktree step
// budget, progress events and CLI progress on stderr. Temp repos only.
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ZERO_COMMIT_HOLD_MS,
  defaultGit,
  holdAgentCwds,
  liveAgentCwds,
  removeSweptWorktree,
  sweepMergedWorktrees,
  throttledHoldCwds,
  worktreeDirt,
  worktreeHasOwnCommit,
} from "../server/team-worktrees.mjs";
import { createWorktreeAutoSweep } from "../server/worktree-autosweep.mjs";

const CLI = resolve(import.meta.dirname, "..", "cli", "vs.mjs");
const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 }).trim();

function initRepo(dir, branch = "main") {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", branch], dir);
  git(["config", "user.email", "t@example.invalid"], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  commitFile(dir, "README.md", "base\n", "init");
}
function commitFile(dir, rel, text, msg = `edit ${rel}`) {
  const p = join(dir, rel);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, text);
  git(["add", rel], dir);
  git(["commit", "-q", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
}
function addWorktree(repo, sanct, branch, base = "HEAD", extra = []) {
  const p = join(sanct, "repo", branch);
  mkdirSync(join(sanct, "repo"), { recursive: true });
  git(["worktree", "add", "-q", ...extra, ...(extra.includes("--detach") ? [] : ["-b", branch]), p, base], repo);
  return p;
}
const byBranch = (res) => Object.fromEntries(res.results.map((r) => [r.branch ?? r.path, r]));
function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), "vs-sweep1043-"));
  // win32: a timed-out git's grandchild (the idea-1059 `!sleep 3` alias) outlives the kill with its cwd in root, and Windows
  // refuses to delete a live process's cwd (EPERM); rmSync retries EPERM/EBUSY until it exits.
  const done = () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  let out;
  try {
    out = fn(root);
  } catch (e) {
    done();
    throw e;
  }
  if (out && typeof out.then === "function") return out.finally(done);
  done();
  return out;
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test("holdAgentCwds: live agents plus agents archived < 24h (auto-archived resumable workers); old archives and closed-for-good do not hold", () => {
  const now = Date.parse("2026-11-25T19:00:00Z");
  const agents = [
    { id: "live", cwd: "/w/live", status: "running" },
    { id: "auto", cwd: "/w/meas-w1", status: "idle", archivedAt: "2026-11-25T18:47:41Z", labels: { role: "worker", "vs.auto-archived": "1" } },
    { id: "old", cwd: "/w/old", archivedAt: new Date(now - ZERO_COMMIT_HOLD_MS - 1).toISOString() },
    { id: "num", cwd: "/w/num", archivedAt: now - 1000 },
    { id: "odd", cwd: "/w/odd", archived: true }, // archived at an unreadable time: holds (fail closed)
    { id: "gone", cwd: "/w/gone", status: "closed", resumable: false },
  ];
  assert.deepEqual(liveAgentCwds(agents), ["/w/live"], "the live set is unchanged");
  assert.deepEqual(holdAgentCwds(agents, { now }).sort(), ["/w/live", "/w/meas-w1", "/w/num", "/w/odd"]);
  assert.deepEqual(holdAgentCwds(null), []);
});

test("worktreeHasOwnCommit: checkouts, resets and fast-forwards are not commits; commit / real merge / cherry-pick are; detached too", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "meas");
    assert.equal(worktreeHasOwnCommit(wt), false, "fresh -b worktree");
    const next = commitFile(repo, "m.txt", "main moves\n");
    git(["reset", "-q", "--hard", next], wt); // vs worktree create + "Reset to origin/main" (meas-w1)
    git(["checkout", "-q", "-B", "meas", next], wt);
    commitFile(repo, "m2.txt", "again\n");
    git(["merge", "-q", "--ff-only", "main"], wt);
    assert.equal(worktreeHasOwnCommit(wt), false, "reset / checkout / ff merge only");

    const det = addWorktree(repo, sanct, "det", "HEAD", ["--detach"]);
    assert.equal(worktreeHasOwnCommit(det), false, "detached at main (idea-949)");

    commitFile(wt, "w.txt", "work\n");
    assert.equal(worktreeHasOwnCommit(wt), true, "a commit");

    const mw = addWorktree(repo, sanct, "merger");
    const side = addWorktree(repo, sanct, "side");
    commitFile(side, "s.txt", "s\n");
    commitFile(repo, "m3.txt", "m3\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge main", "main"], mw);
    assert.equal(worktreeHasOwnCommit(mw), true, "a real merge commit");
    const cp = addWorktree(repo, sanct, "picker");
    git(["cherry-pick", git(["rev-parse", "side"], repo)], cp);
    assert.equal(worktreeHasOwnCommit(cp), true, "a cherry-pick");
    assert.equal(worktreeHasOwnCommit(join(root, "nope")), null, "no worktree: unknown");
  }));

test("idea-1043 replay: zero-commit worktree whose worker is auto-archived is kept (in-use-no-commits); 24h later, or with commits, it goes", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const meas = addWorktree(repo, sanct, "meas-w1");
    const tip = commitFile(repo, "upstream.txt", "merged upstream\n");
    git(["reset", "-q", "--hard", tip], meas); // HEAD moved: the 2h fresh guard no longer applies
    const done = addWorktree(repo, sanct, "unit-done");
    commitFile(done, "d.txt", "d\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-done'", "unit-done"], repo);

    const now = Date.now();
    const archived = new Date(now - 10 * 60_000).toISOString(); // parked, auto-archived 10 min ago, resumable
    const agents = [
      { id: "meas", cwd: meas, status: "idle", archivedAt: archived, labels: { role: "worker", "vs.auto-archived": "1" } },
      { id: "done", cwd: done, status: "idle", archivedAt: archived, labels: { role: "worker", "vs.auto-archived": "1" } },
      { id: "lead", cwd: repo, status: "running" },
    ];
    const opts = { apply: true, sanctuaryRoot: sanct, liveCwds: liveAgentCwds(agents), holdCwds: holdAgentCwds(agents, { now }) };

    const res = byBranch(sweepMergedWorktrees(repo, opts));
    assert.equal(res["meas-w1"].merged, true, "ancestry alone reads it merged");
    assert.equal(res["meas-w1"].ownCommit, false);
    assert.equal(res["meas-w1"].action, "kept");
    assert.equal(res["meas-w1"].reason, "in-use-no-commits");
    assert.ok(existsSync(meas), "the MEAS tree survives the archive window");
    assert.equal(res["unit-done"].action, "removed", "a merged unit with its own commits still goes (normal flow unchanged)");

    const later = now + ZERO_COMMIT_HOLD_MS + 60_000;
    const res2 = byBranch(sweepMergedWorktrees(repo, { ...opts, holdCwds: holdAgentCwds(agents, { now: later }) }));
    assert.equal(res2["meas-w1"].action, "removed", "archived for over a day: done");
    assert.ok(!existsSync(meas));
    assert.equal(git(["rev-parse", "--verify", "--quiet", "refs/heads/meas-w1"], repo).length, 40, "branch ref kept");
  }));

test("idea-1043: the auto-sweep reads holdCwds from the roster (merge subject naming a zero-commit unit keeps it while its worker may return)", async () =>
  withTmp(async (root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const meas = addWorktree(repo, sanct, "meas-w1");
    git(["reset", "-q", "--hard", commitFile(repo, "u.txt", "u\n")], meas);
    const side = addWorktree(repo, sanct, "side");
    commitFile(side, "s.txt", "s\n");
    const agents = [
      { id: "meas", cwd: meas, status: "idle", archivedAt: new Date().toISOString(), labels: { "vs.auto-archived": "1" } },
      { id: "lead", cwd: repo, status: "running" },
      { id: "side", cwd: side, status: "running" },
    ];
    const sweep = createWorktreeAutoSweep({ root: sanct, apply: true, listAgents: async () => agents, log: () => {} });
    await sweep.tick(); // baseline
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'meas-w1'", "side"], repo); // subject names meas-w1: a candidate
    const res = await sweep.tick();
    const r = res.results.find((x) => x.branch === "meas-w1");
    assert.ok(r, JSON.stringify(res));
    assert.equal(r.reason, "in-use-no-commits", JSON.stringify(r));
    assert.ok(existsSync(meas));
  }));

test("idea-1059: a stale local default branch behind origin is dropped from the test refs (no cherry/squash against it); merged verdicts hold", () =>
  withTmp((root) => {
    const origin = join(root, "origin");
    const sanct = join(root, "sanct");
    initRepo(origin);
    const repo = join(root, "repo");
    git(["clone", "-q", origin, repo], root);
    git(["config", "user.email", "t@example.invalid"], repo);
    git(["config", "user.name", "t"], repo);
    const unmerged = addWorktree(repo, sanct, "unit-open");
    commitFile(unmerged, "o.txt", "open\n");
    const merged = addWorktree(repo, sanct, "unit-merged");
    const mc = commitFile(merged, "m.txt", "m\n");
    for (let i = 0; i < 3; i++) commitFile(origin, `up${i}.txt`, `${i}\n`); // origin moves on; local main stays behind
    git(["push", "-q", origin, `${mc}:refs/heads/tmp`], repo);
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-merged'", "tmp"], origin);
    git(["fetch", "-q", "origin"], repo);
    assert.notEqual(git(["rev-parse", "main"], repo), git(["rev-parse", "origin/main"], repo));

    const calls = [];
    const counting = (args, cwd, opts) => {
      calls.push(args.join(" "));
      return defaultGit(args, cwd, opts);
    };
    const res = sweepMergedWorktrees(repo, { git: counting, sanctuaryRoot: sanct, freshGraceMs: 0, targetBranch: "main", targetRefs: ["refs/heads/main", "refs/remotes/origin/main"] });
    const r = byBranch(res);
    assert.equal(r["unit-merged"].action, "would-remove");
    assert.equal(r["unit-merged"].mergedBy, "ancestor");
    assert.equal(r["unit-open"].reason, "unmerged");
    assert.ok(calls.some((c) => c.startsWith("cherry refs/remotes/origin/main")), calls.join("\n"));
    assert.ok(!calls.some((c) => c.startsWith("cherry refs/heads/main") || c.startsWith("merge-base --is-ancestor " + r["unit-open"].head + " refs/heads/main")), "the stale local ref is never tested");

    // Local main ahead of origin (an unpushed merge): origin is the ancestor and is dropped; the local merge still counts.
    const local = addWorktree(repo, sanct, "unit-local");
    commitFile(local, "l.txt", "l\n");
    git(["checkout", "-q", "main"], repo);
    git(["merge", "-q", "--ff-only", "origin/main"], repo);
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-local'", "unit-local"], repo);
    const r2 = byBranch(sweepMergedWorktrees(repo, { sanctuaryRoot: sanct, freshGraceMs: 0, targetBranch: "main", targetRefs: ["refs/heads/main", "refs/remotes/origin/main"] }));
    assert.equal(r2["unit-local"].action, "would-remove", JSON.stringify(r2["unit-local"]));
  }));

test("idea-1059: per-worktree step budget: a slow merged check is cut off and kept (step-timeout), the next worktree still runs; progress events flow", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const slow = addWorktree(repo, sanct, "unit-a-slow");
    const slowHead = commitFile(slow, "a.txt", "a\n");
    const ok = addWorktree(repo, sanct, "unit-b-ok");
    commitFile(ok, "b.txt", "b\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-b-ok'", "unit-b-ok"], repo);
    const seen = [];
    const slowGit = (args, cwd, opts) => {
      if (args[0] === "merge-base" && args.includes(slowHead)) sleepSync(400); // a hung call that eats the budget
      return defaultGit(args, cwd, opts);
    };
    const t0 = Date.now();
    const res = sweepMergedWorktrees(repo, { git: slowGit, sanctuaryRoot: sanct, freshGraceMs: 0, stepTimeoutMs: 250, onProgress: (ev) => seen.push(ev) });
    const r = byBranch(res);
    assert.equal(r["unit-a-slow"].action, "kept");
    assert.equal(r["unit-a-slow"].reason, "step-timeout");
    assert.equal(r["unit-b-ok"].action, "would-remove", "the next worktree gets its own budget");
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(seen.map((e) => e.type), ["start", "repo", "worktree", "result", "worktree", "result"]);
    assert.equal(seen[1].worktrees, 2);
    const res0 = seen.find((e) => e.type === "result" && e.branch === "unit-a-slow");
    assert.equal(res0.reason, "step-timeout");
    assert.ok(res0.ms >= 250);
    assert.doesNotThrow(() => sweepMergedWorktrees(repo, { sanctuaryRoot: sanct, freshGraceMs: 0, onProgress: () => { throw new Error("listener bug"); } }), "a throwing listener never breaks the sweep");
  }));

test("idea-1059: defaultGit honors timeoutMs; a removal past its deadline removes nothing", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const t0 = Date.now();
    assert.throws(() => defaultGit(["-c", "alias.slp=!sleep 3", "slp"], repo, { timeoutMs: 200 }), (e) => e.code === "ETIMEDOUT" || e.signal === "SIGTERM");
    assert.ok(Date.now() - t0 < 2500, "cut off near the budget, not the 30s default");

    const wt = addWorktree(repo, sanct, "unit-big");
    mkdirSync(join(wt, "dist", "deep"), { recursive: true });
    writeFileSync(join(wt, "dist", "deep", "x.js"), "x");
    const res = removeSweptWorktree(repo, wt, { buildOutput: ["dist/"], deadline: Date.now() - 1 });
    assert.deepEqual(res, { removed: false, reason: "build output not removed (ETIMEDOUT)" });
    assert.ok(existsSync(join(wt, "dist", "deep", "x.js")) && existsSync(join(wt, "README.md")));
  }));

test("idea-1059: `vs worktree sweep` prints progress on stderr (stdout stays JSON); --quiet silences it", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "unit-m");
    commitFile(wt, "m.txt", "m\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-m'", "unit-m"], repo);
    const env = { ...process.env, VIBESQUAD_WORKTREES_DIR: sanct, VIBESQUAD_HOME: home, VIBESQUAD_AGENT_ID: "", VIBESQUAD_AGENT_TOKEN: "" };
    const run = (extra) => spawnSync(process.execPath, [CLI, "worktree", "sweep", "--here", ...extra], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
    const out = run([]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /^sweep repo \[\d+\.\d+s\]$/m);
    assert.match(out.stderr, /^ {2}1 worktree\(s\) vs main$/m);
    assert.match(out.stderr, /1\/1 unit-m: would-remove \d+\.\d+s/);
    const json = JSON.parse(out.stdout);
    assert.equal(json.repos[0].results[0].action, "would-remove");
    const quiet = run(["--quiet"]);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stderr, /sweep repo/);
    assert.ok(existsSync(wt), "dry run removes nothing");
  }));

test("Review-Gemini 1043 r1 #1: sweep git reads take no optional lock (status never rewrites the index; step calls run with GIT_OPTIONAL_LOCKS=0)", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const wt = addWorktree(repo, sanct, "unit-m");
    commitFile(wt, "m.txt", "m\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-m'", "unit-m"], repo);
    const index = resolve(wt, git(["rev-parse", "--git-path", "index"], wt));
    const stale = () => {
      const t = new Date(Date.now() + 60_000); // stat info no longer matches the index: a plain status would refresh it
      utimesSync(join(wt, "m.txt"), t, t);
    };
    stale();
    const before = readFileSync(index);
    const dirt = worktreeDirt(wt);
    assert.equal(dirt.clean, true, JSON.stringify(dirt));
    assert.ok(readFileSync(index).equals(before), "worktreeDirt left the index untouched (no lock, no rewrite)");
    git(["status", "--porcelain"], wt); // control: without the flag git does rewrite it, so the check above means something
    assert.ok(!readFileSync(index).equals(before), "control: plain status refreshes the index");

    // Every judgement call of the sweep (bounded or not) carries GIT_OPTIONAL_LOCKS=0; status also passes --no-optional-locks.
    for (const stepTimeoutMs of [60_000, 0]) {
      stale();
      const idx0 = readFileSync(index);
      const calls = [];
      const rec = (args, cwd, opts) => {
        calls.push({ args, env: opts?.env ?? {} });
        return defaultGit(args, cwd, opts);
      };
      const res = byBranch(sweepMergedWorktrees(repo, { git: rec, sanctuaryRoot: sanct, freshGraceMs: 0, stepTimeoutMs, targetBranch: "main", targetRefs: ["refs/heads/main"] }));
      assert.equal(res["unit-m"].action, "would-remove", JSON.stringify(res["unit-m"]));
      const judged = calls.filter((c) => ["merge-base", "status", "ls-files", "rev-parse", "log", "cherry"].some((v) => c.args.includes(v)) && !c.args.includes("--verify"));
      assert.ok(judged.some((c) => c.args.includes("status")) && judged.some((c) => c.args.includes("merge-base")), JSON.stringify(calls.map((c) => c.args)));
      for (const c of judged.filter((c) => c.args.includes("status") || c.args.includes("merge-base") || c.args.includes("ls-files")))
        assert.equal(c.env.GIT_OPTIONAL_LOCKS, "0", `${c.args.join(" ")} (stepTimeoutMs=${stepTimeoutMs})`);
      const st = calls.find((c) => c.args.includes("status"));
      assert.ok(st.args.indexOf("--no-optional-locks") >= 0 && st.args.indexOf("--no-optional-locks") < st.args.indexOf("status"), st.args.join(" "));
      assert.ok(readFileSync(index).equals(idx0), `index untouched by the sweep (stepTimeoutMs=${stepTimeoutMs})`);
    }
    const idxBefore = readFileSync(index);
    stale();
    sweepMergedWorktrees(repo, { sanctuaryRoot: sanct, freshGraceMs: 0, targetBranch: "main", targetRefs: ["refs/heads/main"] });
    assert.ok(readFileSync(index).equals(idxBefore), "a dry-run sweep with the real git leaves the worktree index as it was");
  }));

test("Review-Gemini 1043 r1 #2: the hold set is re-read before removing a zero-commit tree (worker spawned + auto-archived during the sweep keeps it)", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const meas = addWorktree(repo, sanct, "meas-w2");
    git(["reset", "-q", "--hard", commitFile(repo, "up.txt", "up\n")], meas); // zero commits, merged by ancestry
    const done = addWorktree(repo, sanct, "unit-done");
    commitFile(done, "d.txt", "d\n");
    git(["merge", "-q", "--no-ff", "-m", "Merge branch 'unit-done'", "unit-done"], repo);

    // Snapshot taken when the sweep began: the MEAS worker did not exist yet. By removal time it was spawned in meas-w2 and
    // auto-archived (not live, so refreshLiveCwds misses it); only the hold set still names it.
    const t = Date.now();
    const roster = [
      { id: "lead", cwd: repo, status: "running" },
      { id: "meas", cwd: meas, status: "idle", archivedAt: new Date(t - 60_000).toISOString(), labels: { "vs.auto-archived": "1" } },
    ];
    const holdCalls = [];
    const base = { apply: true, sanctuaryRoot: sanct, freshGraceMs: 0, liveCwds: [repo], holdCwds: [repo], refreshLiveCwds: () => [repo] };
    const r1 = byBranch(
      sweepMergedWorktrees(repo, { ...base, refreshHoldCwds: throttledHoldCwds(() => (holdCalls.push(1), roster)), only: (w) => w.branch === "meas-w2" }),
    );
    assert.equal(r1["meas-w2"].ownCommit, false);
    assert.equal(r1["meas-w2"].action, "kept", JSON.stringify(r1["meas-w2"]));
    assert.equal(r1["meas-w2"].reason, "in-use-no-commits");
    assert.ok(existsSync(meas));
    assert.equal(holdCalls.length, 1);

    const r2 = byBranch(sweepMergedWorktrees(repo, { ...base, refreshHoldCwds: () => null, only: (w) => w.branch === "meas-w2" }));
    assert.equal(r2["meas-w2"].reason, "hold-cwd-unknown", "unreadable roster: kept");
    const r3 = byBranch(sweepMergedWorktrees(repo, { ...base, refreshHoldCwds: () => { throw new Error("roster"); }, only: (w) => w.branch === "meas-w2" }));
    assert.equal(r3["meas-w2"].reason, "hold-cwd-unknown", "throwing roster: kept");
    assert.ok(existsSync(meas));

    // A tree with commits of its own never consults the hold set (the live re-read stays its guard).
    let asked = 0;
    const r4 = byBranch(sweepMergedWorktrees(repo, { ...base, refreshHoldCwds: () => (asked++, [done]), only: (w) => w.branch === "unit-done" }));
    assert.equal(r4["unit-done"].action, "removed", JSON.stringify(r4["unit-done"]));
    assert.equal(asked, 0);

    // Control: without the re-read the stale snapshot lets the zero-commit tree go (the reviewed race).
    const r5 = byBranch(sweepMergedWorktrees(repo, { ...base, only: (w) => w.branch === "meas-w2" }));
    assert.equal(r5["meas-w2"].action, "removed");
    assert.ok(!existsSync(meas));
  }));

test("Review-Gemini 1043 r1 #2: throttledHoldCwds = holdAgentCwds of the roster at the clock's now, throttled; empty or throwing roster -> null", () => {
  let now = Date.parse("2026-11-25T20:00:00Z");
  let n = 0;
  const agents = [
    { id: "live", cwd: "/w/live", status: "running" },
    { id: "arch", cwd: "/w/arch", archivedAt: now - 60_000 },
    { id: "old", cwd: "/w/old", archivedAt: now - ZERO_COMMIT_HOLD_MS - 1 },
  ];
  const th = throttledHoldCwds(() => (n++, agents), { intervalMs: 1000, clock: () => now });
  assert.deepEqual(th().sort(), ["/w/arch", "/w/live"]);
  assert.deepEqual(th().sort(), ["/w/arch", "/w/live"]);
  assert.equal(n, 1, "one roster read per interval");
  now += ZERO_COMMIT_HOLD_MS;
  assert.deepEqual(th(), ["/w/live"], "the archive window is judged at read time");
  assert.equal(n, 2);
  assert.equal(throttledHoldCwds(() => [])(), null);
  assert.equal(throttledHoldCwds(() => { throw new Error("x"); })(), null);
});

test("Review-Gemini 1043 r1 #3: a timed-out tree / patch-id scan is not cached; the next worktree rescans and still finds its squash merge", () =>
  withTmp((root) => {
    const repo = join(root, "repo");
    const sanct = join(root, "sanct");
    initRepo(repo);
    const a = addWorktree(repo, sanct, "unit-a-open");
    commitFile(a, "a.txt", "a\n"); // unmerged: judged first, its scans hit the injected timeout
    const b = addWorktree(repo, sanct, "unit-b-squash");
    commitFile(b, "b.txt", "b1\n");
    commitFile(b, "b.txt", "b2\n");
    git(["merge", "-q", "--squash", "unit-b-squash"], repo);
    git(["commit", "-q", "-m", "squash unit-b"], repo); // main's tip tree == unit-b's tree: a tree match
    const timeoutOnce = (match) => {
      let hit = 0;
      return (args, cwd, opts) => {
        if (match(args) && hit++ === 0) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        return defaultGit(args, cwd, opts);
      };
    };
    const opts = { sanctuaryRoot: sanct, freshGraceMs: 0, targetBranch: "main", targetRefs: ["refs/heads/main"] };
    const treeScan = (args) => args[0] === "log" && args[1] === "--format=%T %H";
    const r1 = byBranch(sweepMergedWorktrees(repo, { ...opts, git: timeoutOnce(treeScan) }));
    assert.equal(r1["unit-a-open"].reason, "step-timeout");
    assert.equal(r1["unit-b-squash"].action, "would-remove", JSON.stringify(r1["unit-b-squash"]));
    assert.equal(r1["unit-b-squash"].mergedBy, "tree", "the tree index was rebuilt, not read empty from the cache");

    // unit-c: the base moved before its squash (no tree match) and its two commits were folded (cherry sees no per-commit
    // equivalent): only squash-patch finds it.
    const c = addWorktree(repo, sanct, "unit-c-squash");
    commitFile(c, "c.txt", "c1\n");
    commitFile(c, "c.txt", "c2\n");
    commitFile(repo, "pre.txt", "pre\n");
    git(["merge", "-q", "--squash", "unit-c-squash"], repo);
    git(["commit", "-q", "-m", "squash unit-c"], repo);
    const patchScan = (args) => args[0] === "log" && args[1] === "-p";
    const only = (w) => w.branch !== "unit-b-squash";
    const r2 = byBranch(sweepMergedWorktrees(repo, { ...opts, only, git: timeoutOnce(patchScan) }));
    assert.equal(r2["unit-a-open"].reason, "step-timeout");
    assert.equal(r2["unit-c-squash"].action, "would-remove", JSON.stringify(r2["unit-c-squash"]));
    assert.equal(r2["unit-c-squash"].mergedBy, "squash-patch", "the patch-id index was rebuilt, not read null from the cache");
  }));
