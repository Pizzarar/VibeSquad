import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDefaultBranch, mergedStatus, refreshOriginRefs } from "../server/team-worktrees.mjs";

const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sweepfetch-"));
  const origin = join(dir, "origin"), clone = join(dir, "clone");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "a"), "1");
  g(origin, "add", "."); g(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  return { dir, origin, clone };
}
const realGit = (args, cwd, opts) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(opts?.env ?? {}) } }).trim();

test("stale origin ref is refreshed by a throttled fetch", () => {
  const { dir, origin, clone } = setup();
  try {
    g(clone, "checkout", "-qb", "unit"); writeFileSync(join(clone, "b"), "2"); g(clone, "add", "."); g(clone, "commit", "-qm", "u");
    const head = g(clone, "rev-parse", "HEAD");
    g(origin, "merge", "-q", "--ff-only", "--no-edit", "HEAD"); // noop
    g(origin, "fetch", "-q", clone, "unit"); g(origin, "merge", "-q", "--ff-only", "FETCH_HEAD");
    g(clone, "checkout", "-q", "main"); // local main stale, origin/main stale
    let def = detectDefaultBranch(clone, { git: realGit, fetch: false });
    assert.equal(mergedStatus(clone, head, def.refs, { git: realGit }).merged, false);
    def = detectDefaultBranch(clone, { git: realGit, now: 1_000 });
    assert.equal(mergedStatus(clone, head, def.refs, { git: realGit }).merged, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fetch throttled to once per hour per repo; failure is harmless", () => {
  const calls = [];
  const git = (args) => { calls.push(args[0]); if (args[0] === "fetch") throw new Error("offline"); return ""; };
  assert.equal(refreshOriginRefs("/nonexistent/repoA", { git, now: 0 }), false);
  refreshOriginRefs("/nonexistent/repoA", { git, now: 1000 });
  assert.equal(calls.filter((c) => c === "fetch").length, 1);
  refreshOriginRefs("/nonexistent/repoA", { git, now: 3_600_001 });
  assert.equal(calls.filter((c) => c === "fetch").length, 2);
  assert.doesNotThrow(() => detectDefaultBranch("/nonexistent/repoB", { git, now: 0 }));
});

test("vibesquad.sweepBases adds origin/<base>; bad or unknown names add nothing", () => {
  const { dir, origin, clone } = setup();
  try {
    g(origin, "checkout", "-qb", "efi-showoff"); writeFileSync(join(origin, "c"), "3"); g(origin, "add", "."); g(origin, "commit", "-qm", "s");
    g(origin, "checkout", "-q", "main");
    g(clone, "fetch", "-q", "origin");
    const head = g(origin, "rev-parse", "efi-showoff");
    let def = detectDefaultBranch(clone, { git: realGit, fetch: false });
    assert.equal(mergedStatus(clone, head, def.refs, { git: realGit }).merged, false);
    g(clone, "config", "--add", "vibesquad.sweepBases", "efi-showoff");
    g(clone, "config", "--add", "vibesquad.sweepBases", "--upload-pack=x");
    g(clone, "config", "--add", "vibesquad.sweepBases", "nope");
    def = detectDefaultBranch(clone, { git: realGit, fetch: false });
    assert.deepEqual(def.refs.filter((r) => r.includes("efi") || r.includes("nope") || r.includes("upload")), ["refs/remotes/origin/efi-showoff"]);
    assert.equal(mergedStatus(clone, head, def.refs, { git: realGit }).merged, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
