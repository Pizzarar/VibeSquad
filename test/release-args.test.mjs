import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, runRelease, UsageError, USAGE } from "../server/release.mjs";

const repo = resolve(import.meta.dirname, "..");

describe("release arg parsing", () => {
  test("help flags short-circuit", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--bogus", "--help"]).help, true);
  });
  test("unknown flag or positional is a UsageError", () => {
    assert.throws(() => parseArgs(["--channel", "beta", "--bogus"]), UsageError);
    assert.throws(() => parseArgs(["--channel", "beta", "extra"]), UsageError);
    assert.throws(() => parseArgs(["build", "--commit"]), UsageError);
  });
  test("no subcommand and no --channel is refused", () => {
    assert.throws(() => parseArgs([]), /explicit --channel/);
    assert.throws(() => parseArgs(["--stage-only"]), UsageError);
    assert.throws(() => parseArgs(["--channel", "stabel"]), /beta or stable/);
  });
  test("every legitimate form still parses", () => {
    assert.equal(parseArgs(["--channel", "beta"]).channel, "beta");
    assert.equal(parseArgs(["--channel=stable", "--skip-build"]).skipBuild, true);
    assert.equal(parseArgs(["--channel", "stable", "--stage-only", "--no-authenticode"]).stageOnly, true);
    assert.equal(parseArgs(["build", "--channel", "stable", "--commit", "abc", "--no-authenticode"]).noAuthenticode, true);
    assert.equal(parseArgs(["sign", "--channel", "stable", "--commit", "abc"]).stage, "sign");
    assert.equal(parseArgs(["stage"]).stage, "stage");
    const o = parseArgs(["publish", "--channel", "stable", "--commit", "abc", "--version", "v1.2.3", "--with-android", "--project", "P", "--repo", "o/r", "--requester", "a", "--approval", "b", "--changelog", "c"]);
    assert.equal(o.version, "1.2.3");
    assert.equal(o.withAndroid, true);
    assert.equal(parseArgs(["build", "--unsigned"]).unsigned, true);
  });
  test("runRelease --help prints usage and calls no side effect", () => {
    const calls = [];
    const logs = [];
    const r = runRelease(["--help"], { exec: (...a) => calls.push(a), log: (m) => logs.push(m), readSecret: () => calls.push("secret") });
    assert.deepEqual(r, { help: true });
    assert.deepEqual(calls, []);
    assert.equal(logs[0], USAGE);
  });
});

describe("release.mjs as a child process (fixture copy, never the real checkout)", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "relargs-"));
    mkdirSync(join(dir, "server"));
    mkdirSync(join(dir, "src-tauri"));
    cpSync(join(repo, "server"), join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.3.0", type: "module" }));
    writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.3.0" }));
    execFileSync("ln", ["-s", join(repo, "node_modules"), join(dir, "node_modules")]);
    const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fx");
    return { dir, git };
  }
  const run = (dir, args) => spawnSync(process.execPath, [join(dir, "server", "release.mjs"), ...args], { cwd: dir, encoding: "utf8" });

  test("--help exits 0, prints usage, leaves the tree clean", () => {
    const { dir, git } = fixture();
    try {
      for (const flag of ["--help", "-h"]) {
        const r = run(dir, [flag]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Usage:/);
        assert.equal(git("status", "--porcelain").trim(), "");
      }
      assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "0.3.0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("unknown flag and bare run exit non-zero with usage, tree clean", () => {
    const { dir, git } = fixture();
    try {
      for (const args of [["--bogus"], []]) {
        const r = run(dir, args);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /Usage:/);
        assert.equal(git("status", "--porcelain").trim(), "");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
