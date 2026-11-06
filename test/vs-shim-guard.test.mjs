import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const posix = (p) => p.split("\\").join("/");

describe("vs install-shim / worktree create from a linked worktree", () => {
  let tmp, main, wt, env, realBin;

  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "vs-shim-guard-")));
    main = join(tmp, "main");
    mkdirSync(main);
    git(main, ["init", "-q", "-b", "master"]);
    git(main, ["config", "user.email", "t@example.com"]);
    git(main, ["config", "user.name", "t"]);
    for (const d of ["cli", "server", "docs/profiles"]) cpSync(join(REPO_ROOT, d), join(main, d), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(main, "package.json"));
    git(main, ["add", "-A"]);
    git(main, ["commit", "-q", "-m", "base"]);
    wt = join(tmp, "wt");
    git(main, ["worktree", "add", "-q", "-b", "side", wt]);
    git(wt, ["commit", "-q", "--allow-empty", "-m", "side only"]);
    // vs.mjs needs the project's dependencies; junction them in (a worktree has none of its own).
    const commonDir = git(REPO_ROOT, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const nm = [join(REPO_ROOT, "node_modules"), join(resolve(commonDir, ".."), "node_modules")].find((d) => existsSync(d));
    if (nm) for (const d of [main, wt]) symlinkSync(nm, join(d, "node_modules"), "junction");

    const home = join(tmp, "home");
    realBin = [join(home, ".local", "bin"), join(home, "AppData", "Roaming", "npm")];
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      VIBESQUAD_HOME: join(home, ".vibesquad"),
      VIBESQUAD_WORKTREES_DIR: join(tmp, "worktrees"),
    };
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const runVs = (script, args, cwd) =>
    spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });

  it("install-shim --bin-dir from a linked worktree pins the MAIN repo script, not the worktree", () => {
    const bin = join(tmp, "bin");
    const r = runVs(join(wt, "cli", "vs.mjs"), ["install-shim", "--bin-dir", bin, "--json"], wt);
    assert.equal(r.status, 0, r.stderr);
    const sh = readFileSync(join(bin, "vs"), "utf8");
    const mainScript = posix(join(main, "cli", "vs.mjs"));
    assert.ok(sh.includes(`if [ -f "${mainScript}" ]`), `primary should be main repo:\n${sh}`);
    assert.ok(!sh.includes(posix(wt)), "worktree path must not appear in the shim");
    for (const f of ["vs.cmd", "vs.ps1"]) {
      const body = readFileSync(join(bin, f), "utf8").toLowerCase();
      assert.ok(!body.includes(wt.toLowerCase()) && !body.includes(posix(wt).toLowerCase()), `${f} must not pin the worktree`);
    }
    for (const d of realBin) assert.equal(existsSync(join(d, "vs")), false, `${d} must stay untouched`);
  });

  it("install-shim with no --bin-dir refuses when the runtime home is under the temp dir", () => {
    const r = runVs(join(wt, "cli", "vs.mjs"), ["install-shim"], wt);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to write the default global shim/);
    for (const d of realBin) assert.equal(existsSync(join(d, "vs")), false, `${d} must stay untouched`);
  });

  it("worktree create run from a worktree script resolves the main checkout and bases on master", () => {
    const r = runVs(join(wt, "cli", "vs.mjs"), ["worktree", "create", "unit-x", "--json"], wt);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(realpathSync(out.repoRoot), main);
    assert.equal(git(out.path, ["rev-parse", "HEAD"]), git(main, ["rev-parse", "master"]));
    assert.notEqual(git(out.path, ["rev-parse", "HEAD"]), git(wt, ["rev-parse", "HEAD"]));
  });

  it("worktree create honors an explicit --base", () => {
    const r = runVs(join(wt, "cli", "vs.mjs"), ["worktree", "create", "unit-y", "--base", "side", "--json"], wt);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(git(out.path, ["rev-parse", "HEAD"]), git(wt, ["rev-parse", "HEAD"]));
  });
});
