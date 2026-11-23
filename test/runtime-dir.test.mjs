import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { runtimeDir } from "../server/runtime-dir.mjs";
import { childEnv, hermeticizeEnv, testTmpdirEnv, tmpdirOf } from "../scripts/test-child-env.mjs";
import { runSync, syncRuntimeDir } from "../server/sync-runtime.mjs";

// String.raw: a plain "C:\Users" literal would silently lose its backslashes.
const WINHOME = String.raw`C:\Users\someone`;
const LAD = String.raw`C:\L`;
const winHome = () => WINHOME;
const posixHome = () => "/home/someone";

test("override wins on every platform", () => {
  const env = { VIBESQUAD_RUNTIME_DIR: "/srv/rt", LOCALAPPDATA: LAD, VIBESQUAD_HOME: "/h" };
  assert.equal(runtimeDir(env, { platform: "win32", homedir: winHome }), "/srv/rt");
  assert.equal(runtimeDir(env, { platform: "linux", homedir: posixHome }), "/srv/rt");
  assert.equal(runtimeDir({ VIBESQUAD_RUNTIME_DIR: "  " }, { platform: "linux", homedir: posixHome }), path.join("/home/someone", ".vibesquad", "runtime"));
});

test("win32 keeps the LOCALAPPDATA path, falling back to ~/AppData/Local", () => {
  assert.equal(runtimeDir({ LOCALAPPDATA: LAD }, { platform: "win32", homedir: winHome }), path.join(LAD, "VibeSquad", "runtime"));
  assert.equal(runtimeDir({}, { platform: "win32", homedir: winHome }), path.join(WINHOME, "AppData", "Local", "VibeSquad", "runtime"));
  // LOCALAPPDATA is ignored off win32 (a stray value must not redirect a Linux runtime)
  assert.equal(runtimeDir({ LOCALAPPDATA: "/x" }, { platform: "linux", homedir: posixHome }), path.join("/home/someone", ".vibesquad", "runtime"));
});

test("linux uses VIBESQUAD_HOME, else ~/.vibesquad", () => {
  assert.equal(runtimeDir({ VIBESQUAD_HOME: "/data/vs" }, { platform: "linux", homedir: posixHome }), path.join("/data/vs", "runtime"));
  assert.equal(runtimeDir({}, { platform: "linux", homedir: posixHome }), path.join("/home/someone", ".vibesquad", "runtime"));
});

function git(cwd, ...a) { return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

test("sync-runtime creates + seeds a missing runtime dir (override), links node_modules; a non-repo creates nothing", () => {
  const base = mkdtempSync(path.join(tmpdir(), "vs-rtdir-"));
  try {
    const rt = path.join(base, "fresh", "runtime");
    const env = { VIBESQUAD_RUNTIME_DIR: rt };
    const bad = syncRuntimeDir(path.join(base, "not-a-repo"), { env });
    assert.equal(bad.synced, false);
    assert.ok(!existsSync(rt), "a source that cannot be read leaves nothing behind");

    const repo = path.join(base, "repo");
    mkdirSync(path.join(repo, "server"), { recursive: true });
    mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(repo, "server", "x.mjs"), "export {};" + String.fromCharCode(10));
    writeFileSync(path.join(repo, "package.json"), "{}");
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "server", "package.json");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const res = syncRuntimeDir(repo, { env });
    assert.equal(res.synced, true, JSON.stringify(res));
    assert.ok(existsSync(path.join(rt, "server", "x.mjs")), "tracked files seeded");
    assert.ok(existsSync(path.join(rt, "build-stamp.json")));
    assert.ok(existsSync(path.join(rt, "node_modules", "dep")), "node_modules linked");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("runSync dry run and guard refusals create no runtime dir", () => {
  const base = mkdtempSync(path.join(tmpdir(), "vs-rtdir-"));
  try {
    const rt = path.join(base, "rt");
    const repo = path.join(base, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "master");
    writeFileSync(path.join(repo, "package.json"), "{}");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    runSync({ repoRoot: repo, env: { VIBESQUAD_RUNTIME_DIR: rt, VIBESQUAD_HOME: base }, force: true, dryRun: true, log: () => {} });
    assert.ok(!existsSync(rt), "dry run creates nothing");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("hermetic preload + childEnv keep the live runtime out of test children", () => {
  const live = path.join(tmpdir(), "vs-pretend-live-runtime");
  assert.equal(childEnv({ VIBESQUAD_RUNTIME_DIR: live, KEEP: "1" }).VIBESQUAD_RUNTIME_DIR, undefined);
  assert.equal(childEnv({ VIBESQUAD_RUNTIME_DIR: live, KEEP: "1" }).KEEP, "1");
  // Even run directly (no run-tests.mjs scrub), the preload replaces an inherited live pointer with a fresh temp dir.
  const out = execFileSync(process.execPath, ["--import", "./test/setup/hermetic.mjs", "-e", "console.log(process.env.VIBESQUAD_RUNTIME_DIR)"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, VIBESQUAD_RUNTIME_DIR: live } }).trim();
  assert.notEqual(out, live);
  assert.ok(path.relative(tmpdir(), out).startsWith("vs-test-runtime-"), out);
});

test("forge 11-23: test env drops inherited live/identity vars, keeps test knobs, and moves a TMPDIR out of ~/.vibesquad", () => {
  const env = childEnv({
    VIBESQUAD_MESHNET_HOST: "live.nord", VIBESQUAD_MESHNET_IP: "100.1.2.3", VIBESQUAD_LAN: "1", VIBESQUAD_PORT: "4180",
    VIBESQUAD_START_RUNNER: "1", VIBESQUAD_TEAMS_FILE: "/live/teams.json", VS_LANE: "bug-chaser", VS_AGENT_TOKEN: "t", PASEO_AGENT_ID: "rn-x",
    VS_TEST_FILE_TIMEOUT_MS: "5000", VS_BENCH: "1", VS_ALLOW_REAL_HOME: "1", PATH: "/usr/bin",
    VS_SMOKE: "1", VS_TEST_STRICT_TIMING: "1", VS_TEST_LOAD_FACTOR: "2", VS_TEST_DUMP: "1", VS_SMOKEY: "x",
  });
  // Review M2: VS_SMOKE (live provider smokes) and the VS_TEST_* knobs survive; a look-alike does not.
  assert.deepEqual([env.VS_SMOKE, env.VS_TEST_STRICT_TIMING, env.VS_TEST_LOAD_FACTOR, env.VS_TEST_DUMP, env.VS_SMOKEY], ["1", "1", "2", "1", undefined]);
  for (const k of ["VIBESQUAD_MESHNET_HOST", "VIBESQUAD_MESHNET_IP", "VIBESQUAD_LAN", "VIBESQUAD_PORT", "VIBESQUAD_START_RUNNER", "VIBESQUAD_TEAMS_FILE", "VS_LANE", "VS_AGENT_TOKEN", "PASEO_AGENT_ID"])
    assert.equal(env[k], undefined, k);
  assert.deepEqual([env.VS_TEST_FILE_TIMEOUT_MS, env.VS_BENCH, env.VS_ALLOW_REAL_HOME, env.PATH], ["5000", "1", "1", "/usr/bin"]);
  // TMPDIR: moved only when it sits inside the real ~/.vibesquad (a runner shell's ~/.vibesquad/tmp).
  const home = "/home/someone";
  assert.deepEqual(testTmpdirEnv({}, { platform: "linux", home, current: "/home/someone/.vibesquad/tmp" }), { TMPDIR: "/tmp" });
  assert.deepEqual(testTmpdirEnv({}, { platform: "linux", home, current: "/home/someone/.vibesquad" }), { TMPDIR: "/tmp" });
  assert.deepEqual(testTmpdirEnv({}, { platform: "linux", home, current: "/home/someone/.cache/vibesquad-tmp" }), {});
  assert.deepEqual(testTmpdirEnv({}, { platform: "linux", home, current: "/home/someone/.vibesquad-other" }), {});
  const win = testTmpdirEnv({ LOCALAPPDATA: String.raw`C:\Users\someone\AppData\Local` }, { platform: "win32", home: WINHOME, current: path.join(WINHOME, ".vibesquad", "tmp") });
  assert.deepEqual(win, { TMP: String.raw`C:\Users\someone\AppData\Local\Temp`, TEMP: String.raw`C:\Users\someone\AppData\Local\Temp` });
  // Review L1: with no `current`, the temp dir comes from the PASSED env (node's var order), not this process's os.tmpdir().
  const realVs = path.join(os.userInfo().homedir, ".vibesquad", "tmp");
  if (process.platform !== "win32") {
    assert.equal(childEnv({ TMPDIR: realVs }).TMPDIR, "/tmp", "a caller env's bad TMPDIR is moved even when ours is fine");
    assert.equal(childEnv({ TMPDIR: "/var/tmp/ok" }).TMPDIR, "/var/tmp/ok");
    assert.equal(childEnv({ TMP: realVs }).TMPDIR, "/tmp", "TMP is what node falls back to without TMPDIR");
  }
  assert.equal(tmpdirOf({}, "linux"), "/tmp");
  assert.equal(tmpdirOf({ TMPDIR: "/a", TMP: "/b" }, "linux"), "/a");
  assert.equal(tmpdirOf({ TMP: String.raw`D:\t`, TEMP: String.raw`E:\t` }, "win32"), String.raw`E:\t`);
  assert.equal(tmpdirOf({ SystemRoot: String.raw`C:\Win` }, "win32"), String.raw`C:\Win\temp`);
  const inPlace = { TMPDIR: "x", VS_ROLE: "worker" };
  assert.equal(hermeticizeEnv(inPlace, { platform: "linux", home, current: "/home/someone/.vibesquad/tmp" }), inPlace);
  assert.deepEqual(inPlace, { TMPDIR: "/tmp" });
  // The preload applies it in-process, so a direct `node --test --import` run is covered too.
  const out = execFileSync(process.execPath, ["--import", "./test/setup/hermetic.mjs", "-e", "console.log(JSON.stringify([process.env.VIBESQUAD_MESHNET_HOST ?? null, process.env.VS_LANE ?? null]))"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, VIBESQUAD_MESHNET_HOST: "live.nord", VS_LANE: "x" } }).trim();
  assert.equal(out, "[null,null]");
});

test("sync --no-build on a stale dist is refused before anything creates the runtime dir", () => {
  const base = mkdtempSync(path.join(tmpdir(), "vs-rtdir-"));
  try {
    const rt = path.join(base, "rt");
    const repo = path.join(base, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "master");
    writeFileSync(path.join(repo, "package.json"), "{}");
    writeFileSync(path.join(repo, "src", "App.tsx"), "x");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const res = runSync({ repoRoot: repo, env: { VIBESQUAD_RUNTIME_DIR: rt, VIBESQUAD_HOME: base }, noBuild: true, log: () => {} });
    assert.equal(res.synced, false);
    assert.match(String(res.refused), /dist is stale/);
    assert.ok(!existsSync(rt), "refusal created no runtime dir");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
