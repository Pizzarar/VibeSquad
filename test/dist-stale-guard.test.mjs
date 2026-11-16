// Unit test for the dist/ staleness check that the overlap harness (scripts/ui-overlap/env.mjs)
// uses to decide whether to rebuild before serving the prebuilt bundle. Bug24: normal-invariants
// went red on master because dist/index.html was older than src/BoringAde.tsx / src/boring.css,
// and ensureDist only rebuilt when dist/ was missing.
//
// These tests use temp dirs (no real vite build) and pass `override` explicitly so they are
// deterministic regardless of the ambient UI_OVERLAP_REBUILD.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distNeedsBuild, newestMtime } from "../scripts/ui-overlap/env.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vs-dist-stale-"));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write a file (creating parent dirs) and force its atime/mtime to the given epoch ms. */
const touch = (p, ms) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  const t = new Date(ms);
  utimesSync(p, t, t);
};

/** A repo with dist/index.html at 1000 and every source strictly older -> fresh. */
const makeRepo = () => {
  const root = tmp();
  touch(join(root, "dist", "index.html"), 1000);
  touch(join(root, "src", "App.tsx"), 500);
  touch(join(root, "src", "deep", "nested.css"), 400);
  touch(join(root, "index.html"), 300);
  touch(join(root, "vite.config.ts"), 200);
  return root;
};

test("fresh dist (all sources older than dist/index.html) needs no build", () => {
  const root = makeRepo();
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), false);
});

test("missing dist/index.html needs a build", () => {
  const root = tmp();
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), true);
});

test("a newer file under src/ makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "src", "App.tsx"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), true);
});

test("a newer nested file under src/ makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "src", "deep", "nested.css"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), true);
});

test("a newer index.html makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "index.html"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), true);
});

test("a newer vite.config.* makes dist stale", () => {
  const root = makeRepo();
  touch(join(root, "vite.config.ts"), 2000);
  assert.equal(distNeedsBuild({ repoRoot: root, override: null }), true);
});

test("UI_OVERLAP_REBUILD=1 (override) forces a build even when fresh", () => {
  const root = makeRepo();
  assert.equal(distNeedsBuild({ repoRoot: root, override: "1" }), true);
});

test("newestMtime ignores missing paths and returns the max mtime under a directory tree", () => {
  const root = makeRepo();
  assert.equal(newestMtime([join(root, "does-not-exist")]), 0);
  assert.equal(newestMtime([join(root, "src")]), 500, "newest file under src/ is App.tsx at 500ms");
  assert.equal(newestMtime([join(root, "src"), join(root, "index.html")]), 500);
});
