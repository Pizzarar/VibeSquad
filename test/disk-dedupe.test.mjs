// B1 (docs/PLAN_DISK_LIFECYCLE_1121.md): Temp scratch TTL (server/disk-dedupe.mjs). Every fixture lives under a private
// mkdtemp root that the sweep is pointed at: the machine's real temp dir is never swept here.
import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { catchUpTempScratch, formatCatchUpReport, formatTempTtlMetric, isVsScratchName, startTempScratchTtl, sweepTempScratch } from "../server/disk-dedupe.mjs";
import { commandTempTtl, parseArgs } from "../cli/vs.mjs";

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

test("maxMs bounds one pass by wall clock (stop=time) and the metric carries ms and the stop reason", async () => {
  const root = makeRoot();
  try {
    for (const s of ["Aa11Bb", "Cc22Dd", "Ee33Ff"]) scratch(root, `vs-time-${s}`);
    let t = 0;
    const clock = () => (t += 10); // every read advances 10ms
    const r = await sweepTempScratch({ tempDir: root, now: NOW, maxMs: 25, clock });
    assert.equal(r.truncated, true);
    assert.equal(r.stop, "time");
    assert.ok(r.removed >= 1 && r.removed < 3, `removed ${r.removed}`);
    assert.equal(readdirSync(root).length, 3 - r.removed);
    assert.match(formatTempTtlMetric(r, 3), / ms=\d+ truncated=time$/);
    const r2 = await sweepTempScratch({ tempDir: root, now: NOW });
    assert.equal(r2.truncated, false);
    assert.equal(r2.stop, null);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler: a truncated pass runs the next one on the backlog cadence, an untruncated one waits for the slow tick", async () => {
  let calls = 0;
  const truncs = [true, true, false];
  let done;
  const third = new Promise((r) => (done = r));
  const tt = startTempScratchTtl({
    env: {},
    tempDir: "/placeholder/tmp",
    firstMs: 1,
    backlogMs: 5,
    tickMs: 3_600_000,
    sweep: async () => {
      calls++;
      if (calls === 3) done();
      return { scanned: 1, matched: 1, removed: 5, young: 0, errors: 0, bytesFreed: 0, truncated: truncs[calls - 1] ?? false, stop: "count", ms: 0 };
    },
  });
  try {
    await Promise.race([third, new Promise((_, rej) => setTimeout(() => rej(new Error("backlog cadence did not re-run the sweep")), 2000))]);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 3, "after the untruncated third pass the next one waits for the slow tick");
  } finally {
    tt.stop();
  }
});

test("catch-up dry run reports count and bytes by prefix and age, deletes nothing, and keeps every guard", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    writeFileSync(join(outside, "keep.txt"), "sentinel");
    const a = scratch(root, "vs-cat-Aa11Bb", { files: { "f.bin": "x".repeat(300) } });
    scratch(root, "vs-cat-Cc22Dd", { files: { "f.bin": "x".repeat(200) } });
    const b = scratch(root, "vs-other-Ee33Ff", { files: { "g.bin": "y".repeat(50) } });
    ageTree(b, new Date(NOW - 10 * DAY));
    const fresh = scratch(root, "vs-cat-Gg44Hh", { old: false, files: { "h.bin": "z".repeat(10) } });
    // Old top dir with one fresh file deep inside: aged <1d and not past the TTL.
    const freshDeep = scratch(root, "vs-cat-Ii55Jj", { files: { "a.txt": "q" } });
    mkdirSync(join(freshDeep, "in"));
    ageTree(freshDeep);
    writeFileSync(join(freshDeep, "in", "new.txt"), "n");
    utimesSync(freshDeep, OLD, OLD);
    // A link inside a candidate: never followed (its target's bytes are not counted).
    const withLink = scratch(root, "vs-link-Kk66Ll", { files: { "a.txt": "x".repeat(7) } });
    symlinkSync(outside, join(withLink, "node_modules"), "junction");
    ageTree(withLink);
    const unrelated = scratch(root, "other-app-Ab12Cd");
    const badName = scratch(root, "vs-boot-bench-5k");

    const r = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW });
    assert.equal(r.apply, false);
    assert.equal(r.removed, 0);
    for (const p of [a, b, fresh, freshDeep, withLink, unrelated, badName]) assert.equal(existsSync(p), true, `dry run kept ${p}`);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.equal(r.vsNamed, 7);
    assert.equal(r.nameMismatch, 1);
    assert.equal(r.matched, 6);
    assert.equal(r.eligible, 4);
    const cat = r.byPrefix["vs-cat"];
    assert.equal(cat.count, 4);
    assert.equal(cat.bytes, 300 + 200 + 10 + 2);
    assert.equal(cat.eligible, 2);
    assert.equal(cat.eligibleBytes, 500);
    assert.deepEqual(cat.ages["<1d"], { count: 2, bytes: 12 });
    assert.deepEqual(cat.ages["3-7d"], { count: 2, bytes: 500 });
    assert.deepEqual(r.byPrefix["vs-other"].ages[">=7d"], { count: 1, bytes: 50 });
    assert.equal(r.byPrefix["vs-link"].bytes, 7, "link target bytes never counted");
    assert.equal(r.byPrefix["other-app"], undefined);
    const text = formatCatchUpReport(r);
    assert.match(text, /DRY RUN/);
    assert.match(text, /^vs-cat \| 4 \| /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("catch-up apply removes only expired VS trees; link targets, fresh trees, files, top-level links and unrelated names survive", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    writeFileSync(join(outside, "keep.txt"), "sentinel");
    const old = scratch(root, "vs-cat-Aa11Bb");
    const withLink = scratch(root, "vs-link-Kk66Ll");
    symlinkSync(outside, join(withLink, "node_modules"), "junction");
    ageTree(withLink);
    const fresh = scratch(root, "vs-cat-Gg44Hh", { old: false });
    const unrelated = scratch(root, "other-app-Ab12Cd");
    const vsFile = join(root, "vs-file-Ab12Cd");
    writeFileSync(vsFile, "x");
    utimesSync(vsFile, OLD, OLD);
    const topLink = join(root, "vs-top-Zz99Yy");
    symlinkSync(outside, topLink, "junction");
    lutimesSync(topLink, OLD, OLD);

    const r = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW, apply: true });
    assert.equal(r.removed, 2);
    assert.equal(r.errors, 0);
    assert.equal(r.notDir, 2);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(withLink), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true, "junction target intact");
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(vsFile), true);
    assert.equal(lstatSync(topLink).isSymbolicLink(), true);
    await assert.rejects(catchUpTempScratch({ tempDir: root, ttlDays: 0 }), /at least 1 day/);
    await assert.rejects(catchUpTempScratch({ tempDir: "relative/tmp" }), /absolute/);
  } finally {
    rmSync(join(root, "vs-top-Zz99Yy"), { force: true, recursive: false });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("vs temp-ttl --catch-up: dry run by default; --apply is refused from an agent shell before anything is touched", async () => {
  const root = makeRoot();
  try {
    const old = scratch(root, "vs-cli-Aa11Bb");
    let out = "";
    const io = { tempDir: root, write: (t) => (out += t), progress: () => {} };
    assert.equal(await commandTempTtl(parseArgs(["--catch-up"]), { ...io, env: {} }), 0);
    assert.match(out, /DRY RUN/);
    assert.equal(existsSync(old), true);
    await assert.rejects(commandTempTtl(parseArgs(["--catch-up", "--apply"]), { ...io, env: { VS_AGENT_ID: "w1" } }), /owner verb/);
    await assert.rejects(commandTempTtl(parseArgs(["--catch-up", "--apply"]), { ...io, env: { VS_AGENT_TOKEN: "t" } }), /owner verb/);
    assert.equal(existsSync(old), true, "a refused --apply removed nothing");
    await assert.rejects(commandTempTtl(parseArgs([]), { ...io, env: {} }), /usage: vs temp-ttl --catch-up/);
    await assert.rejects(commandTempTtl(parseArgs(["--catch-up", "--days", "0"]), { ...io, env: {} }), /--days/);
    out = "";
    assert.equal(await commandTempTtl(parseArgs(["--catch-up", "--apply", "--json"]), { ...io, env: {} }), 0);
    assert.equal(JSON.parse(out).removed, 1);
    assert.equal(existsSync(old), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catch-up sample mode: exact counts from top-level mtimes, bytes estimated from walked samples, guard-kept trees reported", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    writeFileSync(join(outside, "big.bin"), "x".repeat(5000));
    for (const s of ["Aa11Bb", "Cc22Dd", "Ee33Ff", "Gg44Hh"]) scratch(root, `vs-smp-${s}`, { files: { "f.bin": "x".repeat(100) } });
    scratch(root, "vs-smp-Ii55Jj", { old: false, files: { "f.bin": "x".repeat(40) } });
    // Old top dir, fresh deep entry: counted past-TTL by top mtime, but if sampled the guard keeps it.
    const guard = scratch(root, "vs-grd-Kk66Ll", { files: { "a.txt": "x".repeat(10) } });
    mkdirSync(join(guard, "in"));
    ageTree(guard);
    writeFileSync(join(guard, "in", "new.txt"), "n");
    utimesSync(guard, OLD, OLD);
    const withLink = scratch(root, "vs-lnk-Mm77Nn", { files: { "a.txt": "x".repeat(3) } });
    symlinkSync(outside, join(withLink, "node_modules"), "junction");
    ageTree(withLink);
    scratch(root, "other-app-Ab12Cd");

    const r = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW, sample: 2 });
    assert.equal(r.estimated, true);
    assert.equal(r.removed, 0);
    assert.equal(readdirSync(root).length, 8, "sample mode deletes nothing");
    assert.equal(r.matched, 7);
    const smp = r.byPrefix["vs-smp"];
    assert.equal(smp.count, 5);
    assert.equal(smp.eligible, 4);
    assert.equal(smp.eligibleBytes, 400, "2 of 4 sampled at 100 bytes each, scaled to 4");
    assert.deepEqual(smp.ages["<1d"], { count: 1, bytes: 40 });
    assert.equal(r.byPrefix["vs-lnk"].bytes, 3, "a link inside a sampled tree is never followed");
    assert.equal(r.sampledTrees, 5);
    assert.equal(r.guardKept, 1);
    assert.match(formatCatchUpReport(r), /SAMPLED: .* kept 1 of 4 sampled past-TTL trees/);
    await assert.rejects(catchUpTempScratch({ tempDir: root, sample: 2, apply: true }), /dry run only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("catch-up checkpoint: a time budget stops the scan, the next call resumes and the totals match one full pass", async () => {
  const root = makeRoot();
  const ckDir = makeRoot();
  try {
    const names = ["Aa11Bb", "Cc22Dd", "Ee33Ff", "Gg44Hh", "Ii55Jj"];
    for (const s of names) scratch(root, `vs-ck-${s}`, { files: { "f.bin": "x".repeat(10) } });
    const full = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW });
    const checkpoint = join(ckDir, "ck.json");
    let t = 0;
    const clock = () => (t += 10);
    const chunks = [];
    for (let i = 0; i < 10; i++) {
      const r = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW + i, checkpoint, budgetMs: 35, clock });
      chunks.push(r);
      if (r.complete) break;
    }
    assert.ok(chunks.length > 1, "the budget split the scan");
    assert.equal(chunks[0].complete, false);
    assert.match(formatCatchUpReport(chunks[0]), /PARTIAL/);
    const last = chunks.at(-1);
    assert.equal(last.complete, true);
    assert.deepEqual(last.byPrefix, full.byPrefix);
    assert.equal(last.eligible, 5);
    assert.equal(readdirSync(root).length, 5, "dry run chunks delete nothing");
    await assert.rejects(catchUpTempScratch({ tempDir: root, ttlDays: 4, checkpoint }), /another run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ckDir, { recursive: true, force: true });
  }
});

test("scheduler: a pass cut off by time with nothing removed goes back to the slow tick and still logs a metric", async () => {
  let calls = 0;
  const metrics = [];
  const tt = startTempScratchTtl({
    env: {},
    tempDir: "/placeholder/tmp",
    firstMs: 1,
    backlogMs: 5,
    tickMs: 3_600_000,
    logMetric: (t) => metrics.push(t),
    sweep: async () => {
      calls++;
      return { scanned: 9, matched: 9, removed: 0, young: 9, errors: 0, bytesFreed: 0, truncated: true, stop: "time", ms: 240000 };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls, 1, "no 60 s loop when a truncated pass made no progress");
    assert.equal(metrics.length, 1);
    assert.match(metrics[0], /removed=0 .* truncated=time$/);
  } finally {
    tt.stop();
  }
});

/** fs wrapper whose readdir runs `hook(path)` once, right after the first read of `target` (inside the scan's walk). */
function hookedFs(target, hook) {
  let fired = false;
  return {
    lstat: fsp.lstat,
    opendir: fsp.opendir,
    rmdir: fsp.rmdir,
    unlink: fsp.unlink,
    readdir: async (p) => {
      const names = await fsp.readdir(p);
      if (!fired && p === target) {
        fired = true;
        hook(p);
      }
      return names;
    },
  };
}

/** Replace dir `p` with a junction to `target`, aged so only the link-type check can refuse it. */
function swapForJunction(p, target) {
  rmSync(p, { recursive: true, force: true });
  symlinkSync(target, p, "junction");
  lutimesSync(p, OLD, OLD);
}

for (const mode of ["sweep", "catch-up"]) {
  const run = (root, fs) =>
    mode === "sweep" ? sweepTempScratch({ tempDir: root, now: NOW, fs }) : catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW, apply: true, fs });

  test(`${mode}: a candidate swapped for a junction during the walk is never followed; the link target survives`, async () => {
    const root = makeRoot();
    const outside = makeRoot();
    try {
      writeFileSync(join(outside, "keep.txt"), "sentinel");
      mkdirSync(join(outside, "sub"));
      writeFileSync(join(outside, "sub", "deep.txt"), "deep");
      ageTree(outside);
      const p = scratch(root, "vs-swap-Aa11Bb");
      const r = await run(root, hookedFs(p, () => swapForJunction(p, outside)));
      assert.equal(r.removed, 0);
      assert.equal(existsSync(join(outside, "keep.txt")), true, "junction target intact");
      assert.equal(existsSync(join(outside, "sub", "deep.txt")), true, "junction target subtree intact");
      assert.equal(lstatSync(p).isSymbolicLink(), true, "the swapped-in link itself is left alone");
    } finally {
      rmSync(join(root, "vs-swap-Aa11Bb"), { force: true, recursive: false });
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test(`${mode}: a tree written to during the walk is not deleted (top-level write and deep write)`, async () => {
    const root = makeRoot();
    try {
      const top = scratch(root, "vs-wtop-Aa11Bb");
      const fs1 = hookedFs(top, (p) => writeFileSync(join(p, "fresh.txt"), "new"));
      const r1 = await run(root, fs1);
      assert.equal(r1.removed, 0);
      assert.equal(existsSync(join(top, "fresh.txt")), true, "top-level fresh write kept");
      rmSync(top, { recursive: true, force: true });
      // Deep write after the walk has read that subdir: the top dir's mtime is unchanged, so only removeTree's
      // per-entry check can catch it.
      const deep = scratch(root, "vs-wdeep-Cc22Dd");
      mkdirSync(join(deep, "in"));
      writeFileSync(join(deep, "in", "old.txt"), "o");
      ageTree(deep);
      const fs2 = hookedFs(join(deep, "in"), (p) => writeFileSync(join(p, "fresh.txt"), "new"));
      const r2 = await run(root, fs2);
      assert.equal(r2.errors, 1, "removal stopped at the fresh entry");
      assert.equal(existsSync(join(deep, "in", "fresh.txt")), true, "deep fresh write kept");
      assert.equal(r2.removed, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("catch-up checkpoint: a future, non-numeric or malformed checkpoint is refused before anything is removed", async () => {
  const root = makeRoot();
  const ckDir = makeRoot();
  try {
    const d = scratch(root, "vs-ckv-Aa11Bb");
    const checkpoint = join(ckDir, "ck.json");
    const base = { tempDir: resolve(root), ttlDays: 3, apply: true, eligible: 0, removed: 0, bytesFreed: 0, byPrefix: {}, done: [] };
    for (const bad of [{ now: NOW + 30 * DAY }, { now: "x" }, { now: null }, { now: NOW - DAY, done: "nope" }, { now: NOW - DAY, byPrefix: [] }]) {
      writeFileSync(checkpoint, JSON.stringify({ ...base, ...bad }));
      await assert.rejects(catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW, apply: true, checkpoint }), /checkpoint .* is invalid/, JSON.stringify(bad));
    }
    assert.equal(existsSync(d), true, "a refused checkpoint removed nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ckDir, { recursive: true, force: true });
  }
});

test("catch-up checkpointed apply: a failed removal is not marked done, so the resumed chunk retries it", async () => {
  const root = makeRoot();
  const ckDir = makeRoot();
  try {
    const d = scratch(root, "vs-busy-Aa11Bb", { files: { "f.bin": "x".repeat(20) } });
    const checkpoint = join(ckDir, "ck.json");
    let failOnce = true;
    const fs = {
      ...hookedFs("", () => {}),
      unlink: async (p) => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return fsp.unlink(p);
      },
    };
    const r1 = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW, apply: true, checkpoint, fs });
    assert.equal(r1.errors, 1);
    assert.equal(r1.removed, 0);
    assert.equal(existsSync(d), true);
    assert.deepEqual(JSON.parse(readFileSync(checkpoint, "utf8")).done, [], "a failed removal is not done");
    const r2 = await catchUpTempScratch({ tempDir: root, ttlDays: 3, now: NOW, apply: true, checkpoint, fs });
    assert.equal(r2.removed, 1);
    assert.equal(r2.bytesFreed, 20);
    assert.equal(existsSync(d), false);
    assert.equal(r2.byPrefix["vs-busy"].eligible, 1, "counted once");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ckDir, { recursive: true, force: true });
  }
});

test("idea-473 lows: a filesystem root is refused; young dirs never report truncated; a vanished dir mid-removal is not an error", async () => {
  await assert.rejects(sweepTempScratch({ tempDir: resolve("/") }), /filesystem root/);

  const root = makeRoot();
  try {
    scratch(root, "vs-old-Aa11Bb");
    scratch(root, "vs-new-Cc22Dd", { old: false });
    // maxRemove 1: the old dir fills the quota; the only remaining match is young, so nothing is left to do.
    const r = await sweepTempScratch({ tempDir: root, now: NOW, maxRemove: 1 });
    assert.equal(r.removed, 1);
    assert.equal(r.young, 1);
    assert.equal(r.truncated, false);
    assert.equal(r.errors, 0);

    scratch(root, "vs-gone-Ee33Ff");
    // Delete the dir on the SECOND readdir of it: the first is treeAge's walk, the second is removeTree's, so its ENOENT catch runs.
    let goneReads = 0;
    const fs = { ...fsp, readdir: async (d, ...a) => {
      if (String(d).includes("vs-gone-") && ++goneReads === 2) await fsp.rm(d, { recursive: true, force: true });
      return fsp.readdir(d, ...a);
    } };
    const r2 = await sweepTempScratch({ tempDir: root, now: NOW, fs });
    assert.ok(goneReads >= 2, `removeTree read the dir (${goneReads} readdirs)`);
    assert.equal(r2.removed, 1);
    assert.equal(r2.errors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
