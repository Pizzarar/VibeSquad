// Unit tests for the dist/ build coordination in scripts/ui-overlap/env.mjs.
//
// Bug24 (R2): ensureDist ran vite build in parallel processes (normal-invariants, ui-overlap,
// uip-u11) with no lock, so concurrent builds raced on the same dist/ — and vite's emptyOutDir
// meant another process could serve a half-built bundle. These tests cover the stamp-based
// staleness check and the cross-process lock: a single build under concurrency, a waiter blocking
// while a build holds the lock, and stale-lock reclaim. All use temp dirs and a fake build
// function — no real vite build.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { distNeedsBuild, ensureDist, newestMtime } from "../scripts/ui-overlap/env.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vs-dist-stale-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Write a file (creating parent dirs) and force its atime/mtime to the given epoch ms. */
const touch = (p, ms) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x");
  const t = new Date(ms);
  utimesSync(p, t, t);
};

const writeStamp = (root, { srcMtime, builtAt }) => {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", ".build-stamp"), JSON.stringify({ srcMtime, builtAt, pid: process.pid }));
};

const writeLock = (root, { pid, startedAt }) => {
  writeFileSync(join(root, ".dist-build.lock"), JSON.stringify({ pid, startedAt }));
};

/** A repo whose UI sources peak at `src` ms, stamped as built from `stampSrcMtime`. */
const makeRepo = ({ src = 500, stampSrcMtime = 1000, builtAt = 0 } = {}) => {
  const root = tmp();
  touch(join(root, "dist", "index.html"), 3000);
  writeStamp(root, { srcMtime: stampSrcMtime, builtAt });
  touch(join(root, "src", "App.tsx"), src);
  touch(join(root, "src", "deep", "nested.css"), 400);
  touch(join(root, "index.html"), 300);
  touch(join(root, "vite.config.ts"), 200);
  return root;
};

// ── distNeedsBuild (stamp-based) ─────────────────────────────────────────────
test("fresh dist (stamp at/after every source) needs no build", () => {
  assert.equal(distNeedsBuild({ repoRoot: makeRepo(), override: null, runStart: 10000 }), false);
});

test("missing dist/index.html needs a build", () => {
  assert.equal(distNeedsBuild({ repoRoot: tmp(), override: null, runStart: 10000 }), true);
});

test("missing stamp (even with dist/index.html) needs a build", () => {
  const root = tmp();
  touch(join(root, "dist", "index.html"), 3000);
  touch(join(root, "src", "App.tsx"), 500);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null, runStart: 10000 }), true);
});

test("a newer file under src/ than the stamp makes dist stale", () => {
  const root = makeRepo({ src: 2000, stampSrcMtime: 1000 });
  assert.equal(distNeedsBuild({ repoRoot: root, override: null, runStart: 10000 }), true);
});

test("a newer nested file under src/ makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "src", "deep", "nested.css"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null, runStart: 10000 }), true);
});

test("a newer index.html makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "index.html"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null, runStart: 10000 }), true);
});

test("a newer vite.config.* makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "vite.config.ts"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null, runStart: 10000 }), true);
});

test("UI_OVERLAP_REBUILD=1 forces a rebuild only when the stamp predates this run", () => {
  assert.equal(distNeedsBuild({ repoRoot: makeRepo({ builtAt: 5000 }), override: "1", runStart: 10000 }), true, "old stamp is forced");
  assert.equal(distNeedsBuild({ repoRoot: makeRepo({ builtAt: 15000 }), override: "1", runStart: 10000 }), false, "stamp from this run is not re-forced");
});

test("newestMtime ignores missing paths and returns the max mtime under a directory tree", () => {
  const root = makeRepo();
  assert.equal(newestMtime([join(root, "does-not-exist")]), 0);
  assert.equal(newestMtime([join(root, "src")]), 500, "newest file under src/ is App.tsx at 500ms");
  assert.equal(newestMtime([join(root, "src"), join(root, "index.html")]), 500);
});

// ── ensureDist lock coordination ─────────────────────────────────────────────
test("two concurrent ensureDist calls build exactly once", async () => {
  const root = tmp();
  touch(join(root, "src", "App.tsx"), 500);
  let builds = 0;
  const build = async () => {
    builds++;
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "built");
    await sleep(20);
  };
  await Promise.all([
    ensureDist({ repoRoot: root, override: null, build }),
    ensureDist({ repoRoot: root, override: null, build }),
  ]);
  assert.equal(builds, 1);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), false, "stamp written, dist now fresh");
});

test("a waiter does not return while a build holds the lock", async () => {
  const root = tmp();
  touch(join(root, "src", "App.tsx"), 500);
  let builds = 0;
  let release;
  const started = deferred();
  const build = async () => {
    builds++;
    started.resolve();
    await new Promise((r) => { release = r; });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "built");
  };
  const first = ensureDist({ repoRoot: root, override: null, build });
  await started.promise; // first has taken the lock and is mid-build
  let waiterDone = false;
  const second = ensureDist({ repoRoot: root, override: null, build }).then(() => { waiterDone = true; });
  await sleep(400); // > one 250ms poll cycle, still blocked
  assert.equal(waiterDone, false, "waiter must not resolve while the lock is held");
  assert.equal(builds, 1);
  release(); // finish the build; the waiter may now proceed
  await Promise.all([first, second]);
  assert.equal(waiterDone, true);
  assert.equal(builds, 1, "still exactly one build");
});

test("a stale lock from a dead holder pid is reclaimed", async () => {
  const root = tmp();
  touch(join(root, "src", "App.tsx"), 500);
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  writeLock(root, { pid: deadPid, startedAt: Date.now() });
  let builds = 0;
  await ensureDist({ repoRoot: root, override: null, build: async () => { builds++; } });
  assert.equal(builds, 1);
});

test("a stale lock older than 10 minutes is reclaimed", async () => {
  const root = tmp();
  touch(join(root, "src", "App.tsx"), 500);
  writeLock(root, { pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 });
  let builds = 0;
  await ensureDist({ repoRoot: root, override: null, build: async () => { builds++; } });
  assert.equal(builds, 1);
});
