import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDefaultBranch, mergedStatus, refreshOriginRefs } from "../server/team-worktrees.mjs";

process.env.VIBESQUAD_HOME = mkdtempSync(join(tmpdir(), "sweepfetch-home0-")); // never touch the real ~/.vibesquad
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
  const home = mkdtempSync(join(tmpdir(), "sweepfetch-home-"));
  process.env.VIBESQUAD_HOME = home;
  const calls = [];
  const git = (args) => { calls.push(args[0]); if (args[0] === "fetch") throw new Error("offline"); return ""; };
  assert.equal(refreshOriginRefs("/nonexistent/repoA", { git, now: 0 }), false);
  refreshOriginRefs("/nonexistent/repoA", { git, now: 1000 });
  assert.equal(calls.filter((c) => c === "fetch").length, 1);
  refreshOriginRefs("/nonexistent/repoA", { git, now: 3_600_001 });
  assert.equal(calls.filter((c) => c === "fetch").length, 2);
  assert.doesNotThrow(() => detectDefaultBranch("/nonexistent/repoB", { git, now: 0 }));
  assert.equal(calls.filter((c) => c === "fetch").length, 3, "repoB fetches independently of repoA's stamp");
  rmSync(home, { recursive: true, force: true });
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

test("throttle persists on disk across processes (fresh in-memory state), on error too, atomically", async () => {
  const home = mkdtempSync(join(tmpdir(), "sweepfetch-home-"));
  const repo = mkdtempSync(join(tmpdir(), "sweepfetch-repo-"));
  process.env.VIBESQUAD_HOME = home;
  try {
    const run = (code) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, VIBESQUAD_HOME: home } }).trim();
    const code = (now) => `import { refreshOriginRefs } from ${JSON.stringify(new URL("../server/team-worktrees.mjs", import.meta.url).href)};
      let n = 0; refreshOriginRefs(${JSON.stringify(repo)}, { now: ${now}, git: () => { n++; throw new Error("down"); } }); console.log(n);`;
    assert.equal(run(code(1000)), "1", "first process fetches (and the fetch errors)");
    assert.equal(run(code(2000)), "0", "second process is throttled by the on-disk stamp, error included");
    assert.equal(run(code(3_700_000)), "1", "after an hour it fetches again");
    assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
    assert.ok(existsSync(join(home, "sweep-fetch.json")));
    JSON.parse(readFileSync(join(home, "sweep-fetch.json"), "utf8"));
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("symlink variants of a repo path share one throttle key", () => {
  const home = mkdtempSync(join(tmpdir(), "sweepfetch-home-"));
  const repo = mkdtempSync(join(tmpdir(), "sweepfetch-repo-"));
  const link = join(home, "link");
  symlinkSync(repo, link);
  process.env.VIBESQUAD_HOME = home;
  try {
    let n = 0;
    const git = () => { n++; return ""; };
    refreshOriginRefs(repo, { git, now: 0 });
    refreshOriginRefs(link, { git, now: 10 });
    assert.equal(n, 1);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("sweepBases is read from --local config only", () => {
  const { dir, clone } = setup();
  const calls = [];
  try {
    detectDefaultBranch(clone, { git: (a, c, o) => { calls.push(a); return realGit(a, c, o); }, fetch: false });
    const cfg = calls.find((a) => a.includes("vibesquad.sweepBases"));
    assert.ok(cfg.includes("--local"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
