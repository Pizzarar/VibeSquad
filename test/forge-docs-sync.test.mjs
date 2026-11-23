// scripts/forge-docs-sync.mjs (docs/PLAN_FORGE_CUTOVER.md C2). Hermetic: temp dirs only, placeholder names only,
// no real ssh (the remote path runs through a local node double that executes the remote command on this machine).
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseRemote, shq, sourceDocs, syncDocs, verifyBriefs } from "../scripts/forge-docs-sync.mjs";
import { HEAVY_DIRS, isHeavyDir, main as migrateMain } from "../scripts/forge-migrate.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/forge-docs-sync.mjs", import.meta.url));
const temps = [];
const tmp = (tag) => { const d = mkdtempSync(join(tmpdir(), `vs-docs-sync-${tag}-`)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const g = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost" } });
const put = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

/** A main checkout with a tracked README, a tracked docs/lanes/x/SPEC.md and an ignored docs/brainstorm/. */
function makeRepo(root, name, { tracked = {}, untracked = {} } = {}) {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  g(d, "init", "-q", "-b", "main");
  put(join(d, ".gitignore"), "docs/brainstorm/\ndocs/**/node_modules/\n");
  put(join(d, "README.md"), "readme\n");
  for (const [rel, text] of Object.entries(tracked)) put(join(d, rel), text);
  g(d, "add", "-A");
  g(d, "commit", "-q", "-m", "init");
  for (const [rel, text] of Object.entries(untracked)) put(join(d, rel), text);
  return d;
}

/** Source projects root with one repo "Alpha"; dest projects root with a clone that tracks docs/lanes/x/SPEC.md differently. */
function fixture() {
  const src = tmp("src");
  makeRepo(src, "Alpha", {
    untracked: {
      "docs/brainstorm/x.md": "brief x\n",
      "docs/lanes/x/TASKS.json": "{\"units\":[]}\n",
      "docs/lanes/x/SPEC.md": "source spec\n",
      "docs/PLAN_A.md": "plan a\n",
      "docs/tool/node_modules/pkg/index.js": "junk\n",
      "src/not-docs.txt": "outside docs\n",
    },
  });
  const dest = tmp("dest");
  makeRepo(dest, "Alpha", { tracked: { "docs/lanes/x/SPEC.md": "dest tracked spec\n" }, untracked: { "docs/PLAN_A.md": "dest local plan\n" } });
  return { src, dest };
}

function checkSyncResult(s, readDest) {
  const r = s.repos.find((x) => x.repo === "Alpha");
  assert.equal(s.errors.length, 0, s.errors.join("\n"));
  assert.equal(r.destState, "cloned");
  assert.equal(r.files, 4, "4 eligible docs files (node_modules and non-docs excluded)");
  assert.equal(r.copied, 2, "brainstorm brief + TASKS.json copied");
  assert.equal(readDest("docs/brainstorm/x.md"), "brief x\n", "ignored brief copied");
  assert.equal(readDest("docs/lanes/x/TASKS.json"), "{\"units\":[]}\n");
  assert.equal(readDest("docs/lanes/x/SPEC.md"), "dest tracked spec\n", "tracked dest file not overwritten");
  assert.equal(readDest("docs/PLAN_A.md"), "dest local plan\n", "differing dest file kept");
  assert.deepEqual(r.conflicts.map((c) => c.rel).sort(), ["docs/PLAN_A.md", "docs/lanes/x/SPEC.md"]);
  assert.match(r.conflicts.find((c) => c.rel === "docs/lanes/x/SPEC.md").reason, /tracked in dest/);
  assert.ok(r.skipped.some((k) => k.rel.includes("node_modules") && k.reason === "node_modules"), "node_modules skipped");
  assert.equal(readDest("docs/tool/node_modules/pkg/index.js"), null, "node_modules not copied");
  assert.equal(readDest("src/not-docs.txt"), null, "only docs/** is copied");
}

describe("forge-docs-sync --sync-docs (local dest)", () => {
  test("copies ignored docs, keeps tracked and differing dest files, skips node_modules; source untouched", () => {
    const { src, dest } = fixture();
    const before = g(join(src, "Alpha"), "status", "--porcelain", "--ignored");
    const s = syncDocs({ fromProjects: src, to: dest });
    const readDest = (rel) => { const p = join(dest, "Alpha", rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
    checkSyncResult(s, readDest);
    assert.equal(g(join(src, "Alpha"), "status", "--porcelain", "--ignored"), before, "source unchanged");
    // Second run: everything already there is "same", nothing copied, still never overwritten.
    const s2 = syncDocs({ fromProjects: src, to: dest });
    const r2 = s2.repos[0];
    assert.equal(r2.copied, 0);
    assert.equal(r2.same, 2);
    assert.equal(r2.conflicts.length, 2);
  });

  test("dry run writes nothing and reports would-copy counts", () => {
    const { src, dest } = fixture();
    const s = syncDocs({ fromProjects: src, to: dest, dryRun: true });
    assert.equal(s.mode, "sync-docs-dry-run");
    assert.equal(s.repos[0].copied, 2);
    assert.equal(existsSync(join(dest, "Alpha", "docs", "brainstorm")), false);
  });

  test("a dest repo that is not cloned is reported and gets nothing", () => {
    const { src } = fixture();
    const empty = tmp("empty");
    const s = syncDocs({ fromProjects: src, to: empty });
    assert.equal(s.repos[0].destState, "not cloned");
    assert.equal(s.totals.notCloned, 1);
    assert.deepEqual(readdirSync(empty), []);
  });

  test("a junction / symlink in the dest that escapes the repo is refused", () => {
    const { src, dest } = fixture();
    const outside = tmp("outside");
    symlinkSync(outside, join(dest, "Alpha", "docs", "brainstorm"), process.platform === "win32" ? "junction" : "dir");
    const s = syncDocs({ fromProjects: src, to: dest });
    const r = s.repos[0];
    assert.ok(r.errors.some((e) => /docs\/brainstorm\/x\.md: refusing: .*(escape|outside)/.test(e)), r.errors.join("\n"));
    assert.deepEqual(readdirSync(outside), [], "nothing written through the link");
    assert.notEqual(main(["--sync-docs", "--from-projects", src, "--to", dest], () => {}, () => {}), 0, "exit non-zero on a refused write");
  });

  test("a dest that is the source or inside it is refused", () => {
    const { src } = fixture();
    assert.throws(() => syncDocs({ fromProjects: src, to: src }), /refusing/);
    assert.throws(() => syncDocs({ fromProjects: src, to: join(src, "Alpha", "copy") }), /refusing/);
  });

  test("--repo restricts the set and rejects a non-checkout", () => {
    const { src, dest } = fixture();
    makeRepo(src, "Beta", { untracked: { "docs/brainstorm/b.md": "b\n" } });
    const s = syncDocs({ fromProjects: src, to: dest, repo: ["Beta"], dryRun: true });
    assert.deepEqual(s.repos.map((r) => r.repo), ["Beta"]);
    assert.throws(() => syncDocs({ fromProjects: src, to: dest, repo: ["Nope"] }), /not a main git checkout/);
  });

  test("--as maps a source folder to a differently named dest clone", () => {
    const { src, dest } = fixture();
    const renamed = tmp("renamed");
    makeRepo(renamed, "AlphaGame");
    const s = syncDocs({ fromProjects: src, to: renamed, as: ["Alpha=AlphaGame"] });
    assert.equal(s.repos[0].dest, "AlphaGame");
    assert.equal(readFileSync(join(renamed, "AlphaGame", "docs", "brainstorm", "x.md"), "utf8"), "brief x\n");
    assert.throws(() => syncDocs({ fromProjects: src, to: dest, as: ["Alpha=../x"] }), /--as needs/);
  });

  test("L2: skips the same heavy dirs as forge-migrate's untracked tar (shared HEAVY_DIRS)", () => {
    const src = tmp("heavy");
    const d = makeRepo(src, "Beta", {
      untracked: {
        "docs/app/src-tauri/target/x.bin": "x", "docs/tool/test-results/r.json": "{}", "docs/tool/Coverage/c.html": "c",
        "docs/.tmp-1/t.md": "t", "docs/notes/build.md": "a file named build.md stays\n", "docs/PLAN_B.md": "plan b\n",
      },
    });
    const r = sourceDocs(d);
    assert.deepEqual(r.files.map((f) => f.rel).sort(), ["docs/PLAN_B.md", "docs/notes/build.md"]);
    assert.deepEqual(r.skipped.map((k) => k.reason).sort(), [".tmp-1", "Coverage", "target", "test-results"]);
    for (const k of r.skipped) assert.ok(isHeavyDir(k.reason), k.reason);
    assert.ok(HEAVY_DIRS.includes("target") && HEAVY_DIRS.includes("node_modules"));
    const dst = tmp("heavy-dst");
    makeRepo(dst, "Beta");
    const out = [];
    assert.equal(main(["--sync-docs", "--from-projects", src, "--to", dst, "--dry-run"], (l) => out.push(l), (l) => out.push(l)), 0, out.join("\n"));
    assert.match(out.join("\n"), /skipped by folder: .*target 1/);
  });

  test("forge-migrate.mjs dispatches --sync-docs", () => {
    const { src, dest } = fixture();
    const out = [];
    assert.equal(migrateMain(["--sync-docs", "--from-projects", src, "--to", dest, "--dry-run"], (l) => out.push(l), (l) => out.push(l)), 0);
    assert.match(out.join("\n"), /Alpha: 4 files.*would copy 2, same 0, conflicts 2/);
  });
});

// The ssh double: `node fake-ssh.mjs [-o x] -- <host> "cd '<dir>' && <cmd>"` runs <cmd> locally in <dir>. It implements
// exactly what the real remote side needs (cd, git, sha256sum, tar) without a shell, so the quoting is exercised too.
const FAKE_SSH = `
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const i = argv.indexOf("--");
const host = argv[i + 1];
const cmd = argv[i + 2];
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, host + "\\t" + cmd + "\\n");
function words(s) {
  const out = []; let cur = null; let k = 0;
  while (k < s.length) {
    const c = s[k];
    if (c === " ") { if (cur !== null) { out.push(cur); cur = null; } k++; continue; }
    if (c === "'") { const e = s.indexOf("'", k + 1); cur = (cur ?? "") + s.slice(k + 1, e); k = e + 1; continue; }
    if (c === "\\\\") { cur = (cur ?? "") + s[k + 1]; k += 2; continue; }
    cur = (cur ?? "") + c; k++;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const w = words(cmd);
if (w[0] !== "cd" || w[2] !== "&&") { process.stderr.write("fake ssh: unexpected command " + cmd); process.exit(97); }
const cwd = w[1];
const [bin, ...args] = w.slice(3);
const input = bin === "tar" ? readFileSync(0) : undefined;
if (bin === "sha256sum") {
  let rc = 0;
  for (const f of args.slice(args[0] === "--" ? 1 : 0)) {
    try { process.stdout.write(createHash("sha256").update(readFileSync(join(cwd, f))).digest("hex") + "  " + f + "\\n"); }
    catch { process.stderr.write("sha256sum: " + f + ": No such file or directory\\n"); rc = 1; }
  }
  process.exit(rc);
}
const real = bin === "tar" && process.platform === "win32" ? join(process.env.SystemRoot || "C:\\\\Windows", "System32", "tar.exe") : bin;
if (bin !== "git" && bin !== "tar") { process.stderr.write("fake ssh: command not allowed: " + bin); process.exit(98); }
const r = spawnSync(real, bin === "git" ? ["-C", cwd, ...args] : args, { cwd, input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });
process.exit(r.status ?? 99);
`;

describe("forge-docs-sync --sync-docs (remote dest over the ssh double)", () => {
  const sshDeps = () => {
    const d = tmp("ssh");
    const fake = join(d, "fake-ssh.mjs");
    writeFileSync(fake, FAKE_SSH);
    return { ssh: [process.execPath, fake] };
  };

  test("streams new files with tar, verifies sha256, keeps the staging copy, never overwrites", () => {
    const { src, dest } = fixture();
    const staging = join(tmp("stage-parent"), "staging");
    const log = join(tmp("log"), "ssh.log");
    process.env.FAKE_SSH_LOG = log;
    try {
      const s = syncDocs({ fromProjects: src, to: `forge-host:${dest.replace(/\\/g, "/")}`, staging }, sshDeps());
      const readDest = (rel) => { const p = join(dest, "Alpha", rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
      checkSyncResult(s, readDest);
      assert.equal(s.remote, true);
      assert.equal(s.staging, staging);
      assert.equal(readFileSync(join(staging, "Alpha", "docs", "brainstorm", "x.md"), "utf8"), "brief x\n", "staging copy kept");
      assert.equal(readFileSync(join(staging, "Alpha", "docs", "PLAN_A.md"), "utf8"), "plan a\n", "staging has every eligible file");
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(calls.every((l) => l.startsWith("forge-host\t")));
      assert.ok(calls.some((l) => l.includes("tar -x -k -f -")));
      assert.ok(calls.some((l) => l.includes("git ls-files -s -z -- docs")));
    } finally {
      delete process.env.FAKE_SSH_LOG;
    }
  });

  test("remote dry run probes only: no staging, no tar", () => {
    const { src, dest } = fixture();
    const s = syncDocs({ fromProjects: src, to: `forge-host:${dest.replace(/\\/g, "/")}`, dryRun: true }, sshDeps());
    assert.equal(s.staging, null);
    assert.equal(s.repos[0].copied, 2);
    assert.equal(s.repos[0].conflicts.length, 2);
    assert.equal(existsSync(join(dest, "Alpha", "docs", "brainstorm")), false);
  });

  test("a remote repo that is not cloned is reported", () => {
    const { src } = fixture();
    const empty = tmp("rempty");
    const s = syncDocs({ fromProjects: src, to: `forge-host:${empty.replace(/\\/g, "/")}`, dryRun: true }, sshDeps());
    assert.match(s.repos[0].destState, /not cloned/);
  });

  test("host parsing and quoting", () => {
    assert.equal(parseRemote("C:\\x"), null);
    assert.equal(parseRemote("C:/x"), null);
    assert.equal(parseRemote("/tmp/x"), null);
    assert.deepEqual(parseRemote("forge:~/projects"), { host: "forge", dir: "~/projects" });
    assert.throws(() => parseRemote("-oProxyCommand=x:dir"), /bad ssh host/);
    assert.equal(shq("~/projects/My Game"), "~/'projects/My Game'");
    assert.equal(shq("it's"), `'it'\\''s'`);
  });
});

describe("forge-docs-sync --verify-briefs", () => {
  function teamsFixture() {
    const root = tmp("verify");
    const projects = join(root, "projects");
    mkdirSync(join(projects, "Game", "docs", "brainstorm"), { recursive: true });
    mkdirSync(join(projects, "VibeSquad", "docs", "brainstorm"), { recursive: true });
    mkdirSync(join(projects, "Game", "docs", "lanes", "core"), { recursive: true });
    writeFileSync(join(projects, "Game", "docs", "brainstorm", "core.md"), "core\n");
    writeFileSync(join(projects, "VibeSquad", "docs", "brainstorm", "hub.md"), "hub\n");
    const teams = {
      teams: [
        {
          id: "game", paths: ["Game", "game-"],
          lanes: [
            { id: "core", state: "pinned" },
            { id: "ui", state: "pinned" },
            { id: "old", state: "removed" },
            { id: "bug-runner-2", hidden: true, kind: "bug", state: "pinned" },
          ],
        },
        { id: "nopath", lanes: [{ id: "hub", state: "pinned" }] },
      ],
    };
    const file = join(root, "teams.json");
    writeFileSync(file, `\uFEFF${JSON.stringify(teams)}`);
    return { file, projects, teams };
  }

  test("flags a missing brief (exit 1), skips removed lanes, warns on hidden lanes and missing lane dirs", () => {
    const { file, projects } = teamsFixture();
    const v = verifyBriefs({ teams: file, projectsRoot: projects });
    assert.equal(v.lanes, 4);
    assert.equal(v.present, 2, "core in Game, hub via the VibeSquad fallback");
    assert.deepEqual(v.missing.map((m) => `${m.team}/${m.lane}`), ["game/ui"]);
    assert.ok(v.warnings.some((w) => w.lane === "bug-runner-2" && /hidden/.test(w.reason)));
    assert.ok(v.warnings.some((w) => w.lane === "ui" && /docs\/lanes/.test(w.reason)));
    assert.ok(!v.warnings.some((w) => w.lane === "core"));
    const r = spawnSync(process.execPath, [SCRIPT, "--verify-briefs", "--teams", file, "--projects-root", projects], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /MISSING game\/ui/);
  });

  test("passes (exit 0) once every brief is present", () => {
    const { file, projects } = teamsFixture();
    writeFileSync(join(projects, "Game", "docs", "brainstorm", "ui.md"), "ui\n");
    const r = spawnSync(process.execPath, [SCRIPT, "--verify-briefs", "--teams", file, "--projects-root", projects], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: every lane has its brief/);
    const out = [];
    assert.equal(migrateMain(["--verify-briefs", "--teams", file, "--projects-root", projects], (l) => out.push(l), (l) => out.push(l)), 0, "forge-migrate dispatch");
  });

  test("an absolute lane path outside the projects root is ignored (falls back like the server)", () => {
    const { file, projects, teams } = teamsFixture();
    const elsewhere = tmp("elsewhere");
    mkdirSync(join(elsewhere, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(elsewhere, "docs", "brainstorm", "ui.md"), "ui\n");
    teams.teams[0].lanes[1].paths = [elsewhere];
    writeFileSync(file, JSON.stringify(teams));
    const v = verifyBriefs({ teams: file, projectsRoot: projects });
    assert.deepEqual(v.missing.map((m) => m.lane), ["ui"]);
  });
});

describe("forge-docs-sync CLI", () => {
  test("needs exactly one mode", () => {
    assert.equal(main([], () => {}, () => {}), 2);
    assert.equal(main(["--sync-docs", "--verify-briefs"], () => {}, () => {}), 2);
    assert.equal(main(["--bogus"], () => {}, () => {}), 2);
  });
});
