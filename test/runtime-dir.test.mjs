import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runtimeDir } from "../server/runtime-dir.mjs";
import { childEnv } from "../scripts/test-child-env.mjs";
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
