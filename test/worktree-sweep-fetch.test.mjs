import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDefaultBranch, mergedStatus, refreshOriginRefs } from "../server/team-worktrees.mjs";

const HOME0 = mkdtempSync(join(tmpdir(), "sweepfetch-home0-"));
process.env.VIBESQUAD_HOME = HOME0; // never touch the real ~/.vibesquad
after(() => rmSync(HOME0, { recursive: true, force: true }));
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
  try {
    const calls = [];
    const git = (args) => { calls.push(args[0]); if (args[0] === "fetch") throw new Error("offline"); return ""; };
    assert.equal(refreshOriginRefs("/nonexistent/repoA", { git, now: 0 }), false);
    refreshOriginRefs("/nonexistent/repoA", { git, now: 1000 });
    assert.equal(calls.filter((c) => c === "fetch").length, 1);
    refreshOriginRefs("/nonexistent/repoA", { git, now: 3_600_001 });
    assert.equal(calls.filter((c) => c === "fetch").length, 2);
    assert.doesNotThrow(() => detectDefaultBranch("/nonexistent/repoB", { git, now: 0 }));
    assert.equal(calls.filter((c) => c === "fetch").length, 3, "repoB fetches independently of repoA's stamp");
  } finally { process.env.VIBESQUAD_HOME = HOME0; rmSync(home, { recursive: true, force: true }); }
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

test("under a test runner the real ~/.vibesquad is never read or written (test-guard)", () => {
  const fake = mkdtempSync(join(tmpdir(), "sweepfetch-fakehome-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, VH: process.env.VIBESQUAD_HOME, RH: process.env.VS_TEST_REAL_HOME };
  try {
    delete process.env.VIBESQUAD_HOME;
    process.env.HOME = fake; process.env.USERPROFILE = fake;
    process.env.VS_TEST_REAL_HOME = join(fake, ".vibesquad"); // declare the fake home as "the real home"
    let n = 0;
    const git = () => { n++; return ""; };
    refreshOriginRefs(fake, { git, now: 0 });
    refreshOriginRefs(fake, { git, now: 5 });
    assert.equal(n, 1, "still throttled in memory");
    assert.equal(existsSync(join(fake, ".vibesquad")), false, "no state dir or file created in the guarded home");
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["USERPROFILE", saved.USERPROFILE], ["VIBESQUAD_HOME", saved.VH], ["VS_TEST_REAL_HOME", saved.RH]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(fake, { recursive: true, force: true });
  }
});

test("a different VIBESQUAD_HOME in one process does not inherit another's stamp; non-number stamps are ignored; failed rename leaves no .tmp", () => {
  const h1 = mkdtempSync(join(tmpdir(), "sweepfetch-h1-")), h2 = mkdtempSync(join(tmpdir(), "sweepfetch-h2-"));
  const repo = mkdtempSync(join(tmpdir(), "sweepfetch-repo-"));
  try {
    let n = 0;
    const git = () => { n++; return ""; };
    process.env.VIBESQUAD_HOME = h1; refreshOriginRefs(repo, { git, now: 0 });
    process.env.VIBESQUAD_HOME = h2; refreshOriginRefs(repo, { git, now: 10 });
    assert.equal(n, 2);
    const key = JSON.parse(readFileSync(join(h2, "sweep-fetch.json"), "utf8"));
    for (const bad of [null, "", false]) {
      writeFileSync(join(h2, "sweep-fetch.json"), JSON.stringify(Object.fromEntries(Object.keys(key).map((k) => [k, bad]))));
      const before = n; refreshOriginRefs(repo, { git, now: 20 + n * 3_700_000 });
      assert.equal(n, before + 1, `stamp ${JSON.stringify(bad)} is not a throttle`);
    }
    // rename target is a directory -> renameSync throws; the tmp must be cleaned up
    const h3 = mkdtempSync(join(tmpdir(), "sweepfetch-h3-"));
    mkdirSync(join(h3, "sweep-fetch.json"));
    process.env.VIBESQUAD_HOME = h3;
    refreshOriginRefs(repo, { git, now: 99_000_000 });
    assert.deepEqual(readdirSync(h3).filter((f) => f.endsWith(".tmp")), []);
    rmSync(h3, { recursive: true, force: true });
  } finally { process.env.VIBESQUAD_HOME = HOME0; for (const d of [h1, h2, repo]) rmSync(d, { recursive: true, force: true }); }
});
