import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path, { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkTestTmp, childEnv, testTmpdirEnv, testTmpdirOverride } from "../scripts/test-child-env.mjs";

const RUN_TESTS = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "tmp-preflight-"));

test("idea-1209: checkTestTmp passes on a writable dir with room and leaves no probe", () => {
  const d = scratch();
  const r = checkTestTmp(d, { minFreeBytes: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(readdirSync(d), []);
});

test("idea-1209: low free space gives a one-line error naming dir, free MB and the fix", () => {
  const d = scratch();
  const r = checkTestTmp(d, { statfs: () => ({ bavail: 10, bsize: 1048576 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(r.error, /only 10 MB free/);
  assert.match(r.error, /VS_TEST_TMPDIR/);
  assert.equal(r.error.includes("\n"), false);
});

test("idea-1209: an unwritable dir is reported, not thrown", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => {
  const d = scratch();
  const ro = join(d, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  const r = checkTestTmp(ro);
  chmodSync(ro, 0o700);
  assert.equal(r.ok, false);
  assert.match(r.error, /not writable \(EACCES\)/);
});

test("idea-1209: VS_TEST_TMPDIR overrides the temp dir (posix and win32)", () => {
  assert.deepEqual(testTmpdirEnv({ VS_TEST_TMPDIR: "/home/u/.cache/vs-test-tmp", TMPDIR: "/tmp" }, { platform: "linux", home: "/home/u" }), { TMPDIR: path.resolve("/home/u/.cache/vs-test-tmp") });
  assert.deepEqual(testTmpdirEnv({ VS_TEST_TMPDIR: "/x/t" }, { platform: "win32", home: "/home/u" }), { TMP: path.resolve("/x/t"), TEMP: path.resolve("/x/t") });
  assert.deepEqual(testTmpdirEnv({ TMPDIR: "/tmp" }, { platform: "linux", home: "/home/u" }), {});
});

test("idea-1209: VS_TEST_TMPDIR inside ~/.vibesquad is refused and not applied", () => {
  const env = { VS_TEST_TMPDIR: "/home/u/.vibesquad/tmp" };
  assert.match(testTmpdirOverride(env, { home: "/home/u" }).error, /real-home guard/);
  assert.deepEqual(testTmpdirEnv(env, { platform: "linux", home: "/home/u", current: "/tmp" }), {});
});

test("idea-1209: npm test entry exits 1 with the refusal (inside ~/.vibesquad) and does not hang", () => {
  const home = userInfo().homedir; // refused before anything is created there
  const r = spawnSync(process.execPath, [RUN_TESTS, "test/nonexistent.test.mjs"], {
    env: { ...process.env, VS_TEST_TMPDIR: join(home, ".vibesquad", "tmp-w2-refusal"), VS_TEST_ORPHAN_GUARD: "0" },
    encoding: "utf8", timeout: 20000,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /VS_TEST_TMPDIR=.*real-home guard/);
});

test("idea-1209: npm test entry exits 1 fast when the temp dir is unwritable", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => {
  const d = scratch();
  const ro = join(d, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  const r = spawnSync(process.execPath, [RUN_TESTS, "test/nonexistent.test.mjs"], {
    env: { ...process.env, TMPDIR: "/tmp", VS_TEST_TMPDIR: join(ro, "sub"), VS_TEST_ORPHAN_GUARD: "0" },
    encoding: "utf8", timeout: 20000,
  });
  chmodSync(ro, 0o700);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not writable.*VS_TEST_TMPDIR/);
});

test("idea-1209: a VS_TEST_TMPDIR symlink (or missing subdir under one) into ~/.vibesquad is refused and nothing is written there", { skip: process.platform === "win32" }, () => {
  const home = scratch();
  const real = join(home, ".vibesquad");
  mkdirSync(real);
  const link = join(scratch(), "link");
  symlinkSync(real, link);
  assert.match(testTmpdirOverride({ VS_TEST_TMPDIR: link }, { home }).error, /real-home guard/);
  assert.match(testTmpdirOverride({ VS_TEST_TMPDIR: join(link, "new", "sub") }, { home }).error, /real-home guard/);
  assert.equal(existsSync(join(real, "new")), false);
  assert.deepEqual(testTmpdirOverride({ VS_TEST_TMPDIR: scratch() }, { home }).error, undefined);
});

test("idea-1209: a child env keeps an inherited vs-t-* scratch and drops VS_TEST_TMPDIR", { skip: process.platform === "win32" }, () => {
  const base = scratch();
  const first = childEnv({ VS_TEST_TMPDIR: base, TMPDIR: "/tmp" });
  assert.equal(first.TMPDIR, base);
  assert.equal(first.VS_TEST_TMPDIR, undefined);
  const inherited = join(base, "vs-t-abc123");
  const child = childEnv({ VS_TEST_TMPDIR: base, TMPDIR: inherited });
  assert.equal(child.TMPDIR, inherited);
  assert.equal(child.VS_TEST_TMPDIR, undefined);
  assert.deepEqual(testTmpdirEnv({ VS_TEST_TMPDIR: base, TMPDIR: inherited }, { platform: "linux", home: "/home/u" }), {});
});

test("idea-1209: a direct node --test run with VS_TEST_TMPDIR naming a missing dir creates it (hermetic.mjs)", () => {
  const base = join(scratch(), "missing", "tmp");
  const probe = join(scratch(), "probe.mjs");
  writeFileSync(probe, `import ${JSON.stringify(new URL("./setup/hermetic.mjs", import.meta.url).href)}; console.log(process.env.TMPDIR || process.env.TMP);`);
  const r = spawnSync(process.execPath, [probe], { env: { ...process.env, TMPDIR: "/tmp", VS_TEST_TMPDIR: base }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().startsWith(path.resolve(base)), r.stdout);
  assert.ok(path.basename(r.stdout.trim()).startsWith("vs-t-"));
  assert.equal(existsSync(path.resolve(base)), true);
});
