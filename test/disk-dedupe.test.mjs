// B1 (docs/PLAN_DISK_LIFECYCLE_1121.md): Temp scratch TTL (server/disk-dedupe.mjs). Every fixture lives under a private
// mkdtemp root that the sweep is pointed at: the machine's real temp dir is never swept here.
import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatTempTtlMetric, isVsScratchName, startTempScratchTtl, sweepTempScratch } from "../server/disk-dedupe.mjs";

const DAY = 86_400_000;
const NOW = Date.now();
const OLD = new Date(NOW - 5 * DAY);

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "vs-dd-fixture-"));
}

/** Set an old mtime on every entry under `p` (children first, then p); links get their own mtime via lutimes. */
function ageTree(p, when = OLD) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return lutimesSync(p, when, when);
  if (st.isDirectory()) for (const n of readdirSync(p)) ageTree(join(p, n), when);
  utimesSync(p, when, when);
}

function scratch(root, name, { old = true, files = { "a.txt": "x".repeat(100) } } = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  if (old) ageTree(dir);
  return dir;
}

test("isVsScratchName matches only the vs-<name>-XXXXXX mkdtemp shape", () => {
  for (const ok of ["vs-rt-Ab12Cd", "vs-test-home-aB3dE9", "vs-sync-lad-000000", "vs-x-ZZZZZZ"]) assert.equal(isVsScratchName(ok), true, ok);
  for (const no of [
    "vs-rt-Ab12C", // 5-char suffix
    "vs-rt-Ab12Cde", // 7-char suffix
    "vs-Ab12Cd", // no name segment
    "VS-rt-Ab12Cd", // uppercase prefix
    "vscode-Ab12Cd",
    "vs_rt-Ab12Cd",
    "vibesquad-runner-prompts",
    "other-app-Ab12Cd",
    "vs-sync-result-1234-abcd1234.json",
    "vs-rt-Ab12Cd/..",
    "",
  ]) assert.equal(isVsScratchName(no), false, no);
});

test("TTL removes only old VS scratch dirs; young, non-VS, files and links are never touched", async () => {
  const root = makeRoot();
  const outside = makeRoot(); // a link target outside the swept root
  try {
    writeFileSync(join(outside, "keep.txt"), "sentinel");
    const oldVs = scratch(root, "vs-old-Ab12Cd");
    const oldNested = scratch(root, "vs-old-nested-Qq11Ww");
    mkdirSync(join(oldNested, "sub", "deeper"), { recursive: true });
    writeFileSync(join(oldNested, "sub", "deeper", "b.bin"), "y".repeat(50));
    ageTree(oldNested);
    const youngVs = scratch(root, "vs-young-Zz99Yy", { old: false });
    // Top dir old, but one deep file is fresh: the tree is still in use, so it stays.
    const oldTopFreshChild = scratch(root, "vs-oldtop-Qw12Er");
    mkdirSync(join(oldTopFreshChild, "inner"));
    ageTree(oldTopFreshChild);
    writeFileSync(join(oldTopFreshChild, "inner", "fresh.txt"), "new");
    utimesSync(oldTopFreshChild, OLD, OLD);
    const nonVs = scratch(root, "other-app-Ab12Cd");
    const upper = scratch(root, "VS-upper-Ab12Cd");
    const shortSuffix = scratch(root, "vs-short-abc");
    const vsFile = join(root, "vs-file-Ab12Cd");
    writeFileSync(vsFile, "file, not dir");
    utimesSync(vsFile, OLD, OLD);
    // A top-level junction with a VS name: never followed, never removed.
    const topLink = join(root, "vs-link-Ab12Cd");
    symlinkSync(outside, topLink, "junction");
    lutimesSync(topLink, OLD, OLD);
    // An old scratch dir that holds a junction to `outside`: the dir goes, the link target stays.
    const withLink = scratch(root, "vs-haslink-Mm55Nn");
    symlinkSync(outside, join(withLink, "node_modules"), "junction");
    ageTree(withLink);

    const r = await sweepTempScratch({ tempDir: root, ttlDays: 3, now: NOW });

    assert.equal(existsSync(oldVs), false, "old VS scratch removed");
    assert.equal(existsSync(oldNested), false, "old nested VS scratch removed");
    assert.equal(existsSync(withLink), false, "old VS scratch with a junction removed");
    assert.equal(existsSync(join(outside, "keep.txt")), true, "the junction target outside is intact");
    assert.equal(existsSync(youngVs), true, "young VS scratch kept");
    assert.equal(existsSync(join(oldTopFreshChild, "inner", "fresh.txt")), true, "tree with a fresh entry kept");
    assert.equal(existsSync(nonVs), true, "non-VS dir never touched");
    assert.equal(existsSync(upper), true, "uppercase VS- never touched");
    assert.equal(existsSync(shortSuffix), true, "wrong suffix length never touched");
    assert.equal(existsSync(vsFile), true, "a top-level file with a VS name never touched");
    assert.equal(lstatSync(topLink).isSymbolicLink(), true, "a top-level VS-named junction never touched");
    assert.equal(r.removed, 3);
    assert.equal(r.young, 2);
    assert.equal(r.errors, 0);
    assert.equal(r.bytesFreed, 100 + 100 + 50 + 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("dry run removes nothing and reports the bytes it would free", async () => {
  const root = makeRoot();
  try {
    const d = scratch(root, "vs-dry-Ab12Cd");
    const r = await sweepTempScratch({ tempDir: root, now: NOW, apply: false });
    assert.equal(existsSync(d), true);
    assert.equal(r.removed, 1);
    assert.equal(r.bytesFreed, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maxRemove bounds one pass; the rest drain on the next pass", async () => {
  const root = makeRoot();
  try {
    for (const s of ["Aa11Bb", "Cc22Dd", "Ee33Ff"]) scratch(root, `vs-cap-${s}`);
    const r1 = await sweepTempScratch({ tempDir: root, now: NOW, maxRemove: 2 });
    assert.equal(r1.removed, 2);
    assert.equal(r1.truncated, true);
    const r2 = await sweepTempScratch({ tempDir: root, now: NOW, maxRemove: 2 });
    assert.equal(r2.removed, 1);
    assert.equal(r2.truncated, false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guards: relative temp dir, a TTL under 1 day and a temp dir that is a link are refused", async () => {
  const root = makeRoot();
  const link = `${root}-link`;
  try {
    await assert.rejects(sweepTempScratch({ tempDir: "relative/tmp" }), /absolute/);
    await assert.rejects(sweepTempScratch({ tempDir: root, ttlDays: 0 }), /at least 1 day/);
    await assert.rejects(sweepTempScratch({ tempDir: root, ttlDays: "x" }), /at least 1 day/);
    symlinkSync(root, link, "junction");
    await assert.rejects(sweepTempScratch({ tempDir: link }), /real directory/);
  } finally {
    rmSync(link, { force: true, recursive: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test("tick logs a bytes-freed metric only when something was freed, and honors VS_TEMP_TTL_DAYS", async () => {
  const metrics = [];
  const seen = [];
  let next = { scanned: 9, matched: 4, removed: 2, young: 2, errors: 0, bytesFreed: 4096, truncated: false };
  const tt = startTempScratchTtl({
    env: { VS_TEMP_TTL_DAYS: "7" },
    tempDir: "/placeholder/tmp",
    firstMs: 3_600_000,
    sweep: async (opts) => {
      seen.push(opts);
      return next;
    },
    logMetric: (t) => metrics.push(t),
  });
  try {
    await tt.tick();
    assert.deepEqual(seen[0], { tempDir: "/placeholder/tmp", ttlDays: 7 });
    assert.deepEqual(metrics, ["temp-scratch-ttl removed=2 bytesFreed=4096 young=2 errors=0 matched=4 scanned=9 ttlDays=7"]);
    next = { scanned: 9, matched: 2, removed: 0, young: 2, errors: 0, bytesFreed: 0, truncated: false };
    await tt.tick();
    assert.equal(metrics.length, 1, "a no-op pass logs nothing");
  } finally {
    tt.stop();
  }
  assert.match(formatTempTtlMetric({ removed: 1, bytesFreed: 5, young: 0, errors: 0, matched: 1, scanned: 1, truncated: true }, 3), /truncated=1$/);
});
