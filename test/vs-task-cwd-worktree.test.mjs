import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// idea-1056: vs task/spec must write the caller's linked worktree, not the registry's main checkout.
const CLI = resolve(import.meta.dirname, "..", "cli", "vs.mjs");
const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

function setup({ registryPath }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vs-1056-")));
  const main = join(dir, "projects", "Proj");
  const specRoot = join(dir, "projects", "Spec");
  const wt = join(dir, "wt", "unit-x");
  mkdirSync(main, { recursive: true });
  mkdirSync(specRoot, { recursive: true });
  git(main, "init", "-q");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", wt, "-b", "unit-x");
  const teamsFile = join(dir, "teams.json");
  const rp = registryPath(dir, main);
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "squad", name: "Squad", paths: [rp], lanes: [{ id: "feat-x", name: "Feat X" }] }] }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k))),
    VIBESQUAD_HOME: join(dir, ".vibesquad"), VIBESQUAD_ROOT: specRoot, VIBESQUAD_TEAMS_FILE: teamsFile, PASEO_HOME: join(dir, ".paseo") };
  const run = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env, input: "" });
  return { dir, main, specRoot, wt, run };
}

const ids = ["--team", "squad", "--lane", "feat-x"];

for (const [name, registryPath] of [
  ["registry path is a symlink to the main checkout", (dir, main) => { const l = join(dir, "link"); symlinkSync(main, l); return l; }],
  ["registry path does not resolve", () => "NoSuchProject-1056"],
]) {
  test(`vs task/spec from a linked worktree write the worktree (${name})`, () => {
    const { dir, main, specRoot, wt, run } = setup({ registryPath });
    try {
      const rel = join("docs", "lanes", "feat-x");
      const set = run(wt, ["task", "set", "u1", "--status", "done", ...ids]);
      assert.equal(set.status, 0, set.stderr);
      assert.ok(existsSync(join(wt, rel, "TASKS.json")), "task set wrote the worktree");
      const add = run(wt, ["task", "add", "u2", ...ids]);
      if (add.status === 0) assert.ok(!existsSync(join(main, rel, "TASKS.json")));
      assert.equal(JSON.parse(run(wt, ["task", "list", "--json", ...ids]).stdout).units[0].status, "done");
      const sp = run(wt, ["spec", "write", "hello", ...ids]);
      assert.equal(sp.status, 0, sp.stderr);
      assert.ok(existsSync(join(wt, rel, "SPEC.md")), "spec write wrote the worktree");
      assert.match(run(wt, ["spec", "show", ...ids]).stdout, /hello/);
      for (const root of [main, specRoot]) {
        assert.ok(!existsSync(join(root, rel, "TASKS.json")), `${root} TASKS.json untouched`);
        assert.ok(!existsSync(join(root, rel, "SPEC.md")), `${root} SPEC.md untouched`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
