import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runtimeDir } from "../server/runtime-dir.mjs";
import { syncRuntimeDir } from "../server/sync-runtime.mjs";

const winHome = () => "C:\Users\someone";
const posixHome = () => "/home/someone";

test("override wins on every platform", () => {
  const env = { VIBESQUAD_RUNTIME_DIR: "/srv/rt", LOCALAPPDATA: "C:\L", VIBESQUAD_HOME: "/h" };
  assert.equal(runtimeDir(env, { platform: "win32", homedir: winHome }), "/srv/rt");
  assert.equal(runtimeDir(env, { platform: "linux", homedir: posixHome }), "/srv/rt");
  assert.equal(runtimeDir({ VIBESQUAD_RUNTIME_DIR: "  " }, { platform: "linux", homedir: posixHome }), path.join("/home/someone", ".vibesquad", "runtime"));
});

test("win32 keeps the LOCALAPPDATA path, falling back to ~/AppData/Local", () => {
  assert.equal(runtimeDir({ LOCALAPPDATA: "C:\L" }, { platform: "win32", homedir: winHome }), path.join("C:\L", "VibeSquad", "runtime"));
  assert.equal(runtimeDir({}, { platform: "win32", homedir: winHome }), path.join("C:\Users\someone", "AppData", "Local", "VibeSquad", "runtime"));
  // LOCALAPPDATA is ignored off win32 (a stray value must not redirect a Linux runtime)
  assert.equal(runtimeDir({ LOCALAPPDATA: "/x" }, { platform: "linux", homedir: posixHome }), path.join("/home/someone", ".vibesquad", "runtime"));
});

test("linux uses VIBESQUAD_HOME, else ~/.vibesquad", () => {
  assert.equal(runtimeDir({ VIBESQUAD_HOME: "/data/vs" }, { platform: "linux", homedir: posixHome }), path.join("/data/vs", "runtime"));
  assert.equal(runtimeDir({}, { platform: "linux", homedir: posixHome }), path.join("/home/someone", ".vibesquad", "runtime"));
});

test("sync-runtime creates a missing runtime dir (override) instead of no-oping", () => {
  const base = mkdtempSync(path.join(tmpdir(), "vs-rtdir-"));
  try {
    const rt = path.join(base, "fresh", "runtime");
    const res = syncRuntimeDir(base, { env: { VIBESQUAD_RUNTIME_DIR: rt } });
    assert.ok(existsSync(rt), "runtime dir was created");
    assert.equal(res.runtimeDir, rt);
    // base is not a git repo: the sync reports its own error rather than the old silent { synced: false } no-op
    assert.equal(res.synced, false);
    assert.ok(res.error, "reached the git step");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
