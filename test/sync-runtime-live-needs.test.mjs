import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sync from "../server/sync-runtime.mjs";

const { DIST_STAMP, liveNeedsSince, parseLiveNeeds, readLiveNeeds, runSync, syncRuntimeDir, syncSkipReason, viteBuild } = sync;

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const put = (dir, rel, text) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const commit = (dir, msg, files = {}) => {
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
  return git(dir, "rev-parse", "HEAD");
};
/** A unit branch merged into master with --no-ff, the trailer on the merge commit (how leads merge). */
const merge = (dir, branch, msg, files) => {
  git(dir, "checkout", "-qb", branch);
  commit(dir, `${branch} work`, files);
  git(dir, "checkout", "-q", "master");
  git(dir, "merge", "-q", "--no-ff", branch, "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "vs-live-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "init", { "src/App.tsx": "v1", "server/serve.mjs": "s1", "runner/runner.mjs": "r1", "docs/a.md": "a", ".gitignore": "dist/\n" });
  return dir;
}

/** A fake install: LOCALAPPDATA/VibeSquad/runtime + VIBESQUAD_HOME, never the live ones. */
function install(lastSynced) {
  const lad = mkdtempSync(join(tmpdir(), "vs-live-lad-"));
  const runtime = join(lad, "VibeSquad", "runtime");
  mkdirSync(runtime, { recursive: true });
  if (lastSynced) writeFileSync(join(runtime, "build-stamp.json"), JSON.stringify({ commit: lastSynced, repo: "x", builtAt: "t" }));
  const home = mkdtempSync(join(tmpdir(), "vs-live-home-"));
  return { runtime, home, env: { LOCALAPPDATA: lad, VIBESQUAD_HOME: home } };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), text: () => lines.join("\n") };
};

test("parseLiveNeeds: known values, none, and unknown tokens", () => {
  assert.deepEqual(parseLiveNeeds("server-restart, build"), { needs: ["build", "server-restart"], unknown: [] });
  assert.deepEqual(parseLiveNeeds("none"), { needs: [], unknown: [] });
  assert.deepEqual(parseLiveNeeds("Build,,frontend-reload  runner-restart"), { needs: ["build", "frontend-reload", "runner-restart"], unknown: [] });
  assert.deepEqual(parseLiveNeeds("server-restrat"), { needs: [], unknown: ["server-restrat"] });
});

test("idea-100: a sync after a src/ merge rebuilds dist before copying it (never ships the stale UI)", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  put(dir, "dist/index.html", "old-ui");
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: base, dirty: false }));
  merge(dir, "unit-boring", "Merge unit-boring\n\nLive-Needs: build, frontend-reload", { "src/boring.css": "body{}" });
  const { runtime, env } = install(base);
  const builds = [];
  const build = (root) => {
    builds.push(root);
    put(root, "dist/index.html", "new-ui");
    return { ok: true };
  };
  const out = quiet();
  const res = runSync({ repoRoot: dir, env, build, log: out.log });
  assert.equal(builds.length, 1, "stale dist must be rebuilt");
  assert.equal(res.synced, true);
  assert.equal(readFileSync(join(runtime, "dist", "index.html"), "utf8"), "new-ui");
  assert.equal(JSON.parse(readFileSync(join(dir, "dist", DIST_STAMP), "utf8")).commit, git(dir, "rev-parse", "HEAD"));
  assert.match(out.text(), /build \(applied\)/);
  assert.match(out.text(), /frontend-reload/);
});

test("idea-100: a stale dist whose build fails (or --no-build) refuses the whole sync and keeps the live runtime", () => {
  const dir = repo();
  put(dir, "dist/index.html", "old-ui");
  commit(dir, "ui change", { "src/App.tsx": "v2" });
  const { runtime, env } = install(null);
  put(runtime, "dist/index.html", "live-ui");
  const out = quiet();
  const failed = runSync({ repoRoot: dir, env, build: () => ({ ok: false, error: "vite exploded" }), log: out.log });
  assert.equal(failed.synced, false);
  assert.match(failed.refused, /vite exploded/);
  assert.equal(readFileSync(join(runtime, "dist", "index.html"), "utf8"), "live-ui");
  assert.equal(existsSync(join(runtime, "server")), false, "nothing copied on refusal");
  const noBuild = runSync({ repoRoot: dir, env, noBuild: true, build: () => assert.fail("--no-build must not build"), log: () => {} });
  assert.match(noBuild.refused, /dist is stale/);
});

test("a fresh dist (stamp at HEAD, or only non-UI changes since) is copied without a build", () => {
  const dir = repo();
  const head = git(dir, "rev-parse", "HEAD");
  put(dir, "dist/index.html", "ui");
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: head, dirty: false }));
  merge(dir, "unit-cli", "Merge unit-cli\n\nLive-Needs: none", { "cli/vs.mjs": "c", "docs/b.md": "b", "test/x.test.mjs": "t" });
  const { runtime, env } = install(head);
  const res = runSync({ repoRoot: dir, env, build: () => assert.fail("no UI input changed"), log: () => {} });
  assert.equal(res.synced, true);
  assert.equal(readFileSync(join(runtime, "dist", "index.html"), "utf8"), "ui");
});

test("a server module the frontend imports counts as a UI input", () => {
  const dir = repo();
  commit(dir, "shared", { "server/lane-pure.mjs": "export const a = 1;", "src/lane.ts": 'import { a } from "../server/lane-pure.mjs";' });
  const head = git(dir, "rev-parse", "HEAD");
  put(dir, "dist/index.html", "ui");
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: head, dirty: false }));
  commit(dir, "shared change", { "server/lane-pure.mjs": "export const a = 2;" });
  let built = 0;
  runSync({ repoRoot: dir, env: install(head).env, build: () => (built++, { ok: true }), log: () => {} });
  assert.equal(built, 1);
});

test("inside `npm run build` (vite just ran) the dist is stamped at HEAD, not rebuilt", () => {
  const dir = repo();
  put(dir, "dist/index.html", "just-built");
  const { env } = install(null);
  runSync({ repoRoot: dir, env: { ...env, npm_lifecycle_event: "build" }, build: () => assert.fail("no recursive build"), log: () => {} });
  const stamp = JSON.parse(readFileSync(join(dir, "dist", DIST_STAMP), "utf8"));
  assert.equal(stamp.commit, git(dir, "rev-parse", "HEAD"));
  assert.equal(stamp.dirty, false);
});

test("readLiveNeeds: declared merges are authoritative, undeclared ones are inferred from their paths", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  const declared = merge(dir, "unit-a", "Merge unit-a\n\nLive-Needs: server-restart\nCo-Authored-By: x <x@x>", { "server/serve.mjs": "s2" });
  const silent = merge(dir, "unit-b", "Merge unit-b", { "runner/runner.mjs": "r2", "docs/c.md": "c" });
  merge(dir, "unit-c", "Merge unit-c\n\nLive-Needs: none", { "server/serve.mjs": "s3" });
  const typo = merge(dir, "unit-d", "Merge unit-d\n\nLive-Needs: server-restrat", { "docs/d.md": "d" });
  const r = readLiveNeeds(dir, base, "HEAD");
  assert.equal(r.ok, true);
  assert.deepEqual(r.needs["server-restart"], [declared.slice(0, 7)], "declared none on unit-c wins over its server/ path");
  assert.deepEqual(r.needs["runner-restart"], [silent.slice(0, 7)]);
  assert.deepEqual(r.undeclared.map((u) => u.commit), [silent.slice(0, 7), typo.slice(0, 7)]);
  assert.deepEqual(r.unknown, [{ commit: typo.slice(0, 7), value: "server-restrat" }]);
  assert.equal(r.commits, 4, "first-parent merges only, not the unit commits behind them");
  assert.equal(readLiveNeeds(dir, "0".repeat(40), "HEAD").ok, false);
});

test("restarts are reported, never performed, and carry over until a successful vs restart", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  put(dir, "dist/index.html", "ui");
  merge(dir, "unit-s", "Merge unit-s\n\nLive-Needs: server-restart, runner-restart", { "server/serve.mjs": "s2" });
  const { runtime, home, env } = install(base);
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: git(dir, "rev-parse", "HEAD"), dirty: false }));
  let now = Date.parse("2026-11-10T10:00:00Z");
  const first = quiet();
  runSync({ repoRoot: dir, env, now: () => now, log: first.log, build: () => assert.fail() });
  assert.match(first.text(), /server-restart \(pending since [0-9a-f]{7}.*vs restart/);
  assert.match(first.text(), /runner-restart/);
  const pend = JSON.parse(readFileSync(join(runtime, "live-needs.json"), "utf8"));
  assert.ok(pend.pending["server-restart"].length === 1);

  // A docs-only merge next: the server restart is still owed.
  merge(dir, "unit-docs", "Merge unit-docs\n\nLive-Needs: none", { "docs/z.md": "z" });
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: git(dir, "rev-parse", "HEAD"), dirty: false }));
  now += 60_000;
  const second = quiet();
  runSync({ repoRoot: dir, env, now: () => now, log: second.log, build: () => assert.fail() });
  assert.match(second.text(), /server-restart \(pending since/);

  // The Overlord ran `vs restart` and it succeeded: the debt is cleared on the next sync.
  writeFileSync(join(home, "restart-2026-11-10T10-05-00-000Z.json"), JSON.stringify({ startedAt: "2026-11-10T10:05:00.000Z", dryRun: false, ok: true }));
  merge(dir, "unit-docs2", "Merge unit-docs2\n\nLive-Needs: none", { "docs/y.md": "y" });
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: git(dir, "rev-parse", "HEAD"), dirty: false }));
  now += 10 * 60_000;
  const third = quiet();
  runSync({ repoRoot: dir, env, now: () => now, log: third.log, build: () => assert.fail() });
  assert.doesNotMatch(third.text(), /server-restart/);
  assert.match(third.text(), /live-needs [0-9a-f]{7}\.\.[0-9a-f]{7}: none/);
});

test("--dry-run reports the live needs and touches nothing", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  commit(dir, "ui", { "src/App.tsx": "v3" });
  const { runtime, env } = install(base);
  const out = quiet();
  const res = runSync({ repoRoot: dir, env, dryRun: true, build: () => assert.fail("dry run never builds"), log: out.log });
  assert.equal(res.synced, false);
  assert.match(out.text(), /dry run/);
  assert.match(out.text(), /build \(would build: dist/);
  assert.equal(existsSync(join(runtime, "dist")), false);
  assert.equal(existsSync(join(runtime, "live-needs.json")), false);
});

// --- Review-Gemini R1 (9d34a82) findings ---------------------------------------------------------------------------

const stampDist = (dir) => {
  put(dir, "dist/index.html", "ui");
  writeFileSync(join(dir, "dist", DIST_STAMP), JSON.stringify({ commit: git(dir, "rev-parse", "HEAD"), dirty: false }));
};
const LICENSES = "public/THIRD-PARTY-LICENSES.txt";

test("H1: a trailer with one valid token plus a typo keeps the declared needs AND the path inference", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  const m = merge(dir, "unit-h1", "Merge unit-h1\n\nLive-Needs: server-restart, buld", { "src/App.tsx": "v9" }).slice(0, 7);
  const r = readLiveNeeds(dir, base, "HEAD");
  assert.deepEqual(r.needs["server-restart"], [m]);
  assert.deepEqual(r.needs.build, [m], "the typo'd build must still come from the src/ path");
  assert.deepEqual(r.unknown, [{ commit: m, value: "buld" }]);
  assert.deepEqual(r.undeclared.map((u) => u.commit), [m]);
});

test("H2: a missing or corrupt build-stamp records server-restart + runner-restart debt instead of nothing", () => {
  for (const stamp of [null, "{not json"]) {
    const dir = repo();
    stampDist(dir);
    const { runtime, env } = install(null);
    if (stamp) writeFileSync(join(runtime, "build-stamp.json"), stamp);
    const out = quiet();
    runSync({ repoRoot: dir, env, log: out.log, build: () => assert.fail() });
    const pend = JSON.parse(readFileSync(join(runtime, "live-needs.json"), "utf8")).pending;
    assert.equal(pend["server-restart"].length, 1, `stamp=${stamp}`);
    assert.match(out.text(), /server-restart \(pending since/);
    assert.match(out.text(), /runner-restart/);
  }
});

test("H2: a non-ancestor baseline (rebase/force-push) is read from the merge-base plus the prev..HEAD diff", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  const dropped = commit(dir, "runner work, later rewritten away", { "runner/runner.mjs": "r-dropped" });
  git(dir, "reset", "-q", "--hard", base);
  commit(dir, "server work", { "server/serve.mjs": "s-new" });
  const r = liveNeedsSince(dir, dropped, git(dir, "rev-parse", "HEAD"));
  assert.equal(r.ok, true);
  assert.ok(r.needs["server-restart"]?.length, "new server commit since the merge-base");
  assert.ok(r.needs["runner-restart"]?.length, "the live runner code was rolled back: restart it too");
  assert.match(r.note, /not an ancestor/);
  const gone = liveNeedsSince(dir, "f".repeat(40), git(dir, "rev-parse", "HEAD"));
  assert.ok(gone.needs["server-restart"]?.length && gone.needs["runner-restart"]?.length, "unknown baseline: conservative");
});

test("H3: the generated THIRD-PARTY-LICENSES.txt does not block the sync after npm run build", () => {
  const dir = repo();
  commit(dir, "licenses", { [LICENSES]: "old" });
  put(dir, LICENSES, "regenerated by npm run build");
  assert.equal(syncSkipReason(dir), null);
  put(dir, "dist/index.html", "built");
  const { runtime, env } = install(git(dir, "rev-parse", "HEAD"));
  runSync({ repoRoot: dir, env: { ...env, npm_lifecycle_event: "build" }, build: () => assert.fail("just built"), log: () => {} });
  assert.equal(readFileSync(join(runtime, "dist", "index.html"), "utf8"), "built");
  let builds = 0;
  runSync({ repoRoot: dir, env, build: () => (builds++, { ok: true }), log: () => {} });
  assert.equal(builds, 0, "same tree as the stamped build: no second build");
});

test("H3: an uncommitted src/ edit after a clean stamp makes dist stale (once), under --force", () => {
  const dir = repo();
  stampDist(dir);
  put(dir, "src/App.tsx", "uncommitted edit");
  const { env } = install(git(dir, "rev-parse", "HEAD"));
  let builds = 0;
  const build = () => (builds++, { ok: true });
  runSync({ repoRoot: dir, env, force: true, build, log: () => {} });
  assert.equal(builds, 1);
  runSync({ repoRoot: dir, env, force: true, build, log: () => {} });
  assert.equal(builds, 1, "the same dirty tree was already built");
});

test("M1: a failed copy keeps the old runtime and never advances build-stamp.json", () => {
  const dir = repo();
  const base = git(dir, "rev-parse", "HEAD");
  commit(dir, "server+runner", { "server/serve.mjs": "s-new", "runner/runner.mjs": "r-new" });
  const { runtime, env } = install(base);
  put(runtime, "server/serve.mjs", "s-live");
  put(runtime, "runner/runner.mjs", "r-live");
  let n = 0;
  const rename = (a, b) => {
    if (++n === 3) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    renameSync(a, b);
  };
  const res = syncRuntimeDir(dir, { env, ops: { rename } });
  assert.equal(res.synced, false);
  assert.match(res.error, /EPERM/);
  assert.equal(readFileSync(join(runtime, "server", "serve.mjs"), "utf8"), "s-live");
  assert.equal(readFileSync(join(runtime, "runner", "runner.mjs"), "utf8"), "r-live");
  assert.equal(JSON.parse(readFileSync(join(runtime, "build-stamp.json"), "utf8")).commit, base);
  const ok = syncRuntimeDir(dir, { env });
  assert.equal(ok.synced, true);
  assert.equal(readFileSync(join(runtime, "server", "serve.mjs"), "utf8"), "s-new");
});

test("M1: runSync refuses while another sync holds the runtime lock", () => {
  const dir = repo();
  stampDist(dir);
  const { runtime, env } = install(git(dir, "rev-parse", "HEAD"));
  writeFileSync(join(runtime, "sync.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const busy = runSync({ repoRoot: dir, env, lockTimeoutMs: 50, build: () => assert.fail(), log: () => {} });
  assert.match(busy.refused, /another sync/);
  assert.equal(existsSync(join(runtime, "dist")), false);
});

test("M2: cross-dir imports count (server -> cli, server -> runner, runner -> server)", () => {
  const dir = repo();
  commit(dir, "graph", {
    "server/serve.mjs": 'import "../cli/vs.mjs";\nimport { x } from "../runner/lock.mjs";',
    "runner/runner.mjs": 'import { g } from "../server/test-guard.mjs";',
    "cli/vs.mjs": "c1", "runner/lock.mjs": "l1", "server/test-guard.mjs": "g1",
  });
  const needsOf = (files) => {
    const from = git(dir, "rev-parse", "HEAD");
    commit(dir, "change", files);
    return Object.keys(readLiveNeeds(dir, from, "HEAD").needs).sort();
  };
  assert.deepEqual(needsOf({ "cli/vs.mjs": "c2" }), ["server-restart"]);
  assert.deepEqual(needsOf({ "runner/lock.mjs": "l2" }), ["runner-restart", "server-restart"]);
  assert.deepEqual(needsOf({ "server/test-guard.mjs": "g2" }), ["runner-restart", "server-restart"]);
  assert.deepEqual(needsOf({ "cli/other.mjs": "o" }), [], "a cli module nobody long-lived imports needs nothing");
});

test("L: --dry-run shows carried restart debt", () => {
  const dir = repo();
  stampDist(dir);
  const { runtime, env } = install(git(dir, "rev-parse", "HEAD"));
  writeFileSync(join(runtime, "live-needs.json"), JSON.stringify({ pending: { "server-restart": [{ commit: "abc1234", at: new Date().toISOString() }] } }));
  const out = quiet();
  runSync({ repoRoot: dir, env, dryRun: true, log: out.log });
  assert.match(out.text(), /server-restart \(pending since abc1234/);
});

test("L: viteBuild reads output as utf8 and falls back to stdout for the error line", () => {
  let opts;
  const exec = (_cmd, _args, o) => {
    opts = o;
    throw Object.assign(new Error("Command failed"), { stderr: "", stdout: "vite v6\nerror: Could not resolve ./boring.css\n" });
  };
  const r = viteBuild("/repo", { exec, exists: () => true });
  assert.equal(opts.encoding, "utf8");
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not resolve \.\/boring\.css/);
});

test("L: an unknown flag exits non-zero before touching anything", () => {
  const r = spawnSync(process.execPath, ["server/sync-runtime.mjs", "--dryrun"], { encoding: "utf8", env: { ...process.env, LOCALAPPDATA: mkdtempSync(join(tmpdir(), "vs-sync-lad-")) } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --dryrun/);
});
