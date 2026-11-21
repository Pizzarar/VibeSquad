import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardIgnoresDirt, runSync, syncRuntimeDir, syncSkipReason, trackedRuntimeFiles } from "../server/sync-runtime.mjs";
import { guardHandler } from "../server/safe-handler.mjs";
import { createVibesquadMiddleware } from "../server/vibesquad-api.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "vs-sync-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("sync allowed on clean master in the main checkout", () => {
  assert.equal(syncSkipReason(repo()), null);
});

test("sync skipped on a unit branch, dirty tree, and linked worktree; force overrides", () => {
  const dir = repo();
  writeFileSync(join(dir, "b.txt"), "b");
  assert.equal(syncSkipReason(dir), null, "untracked files (other lanes' docs) don't block the sync");
  writeFileSync(join(dir, "a.txt"), "changed");
  assert.match(syncSkipReason(dir), /not clean/);
  assert.equal(syncSkipReason(dir, { force: true }), null);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "b");
  const wt = join(mkdtempSync(join(tmpdir(), "vs-wt-")), "wt");
  git(dir, "worktree", "add", "-q", wt, "-b", "unit-x", "master");
  assert.match(syncSkipReason(wt), /linked worktree/);
  git(dir, "checkout", "-q", "-b", "unit-y");
  assert.match(syncSkipReason(dir), /unit-y/);
  assert.equal(syncSkipReason(wt, { force: true }), null);
});

test("CLI prints a one-line skip and exits 0 for a non-master checkout", () => {
  const out = execFileSync(process.execPath, ["server/sync-runtime.mjs"], { encoding: "utf8", env: { ...process.env, VIBESQUAD_SYNC_FORCE: "", LOCALAPPDATA: mkdtempSync(join(tmpdir(), "vs-sync-lad-")) } });
  assert.ok(out.split("\n").filter(Boolean).length <= 1);
});

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("guardHandler turns sync and async throws into 500 and the server keeps answering", async () => {
  const { server, base } = await listen(
    guardHandler(async (req, res) => {
      if (req.url === "/sync") throw new ReferenceError("readBuildStamp is not defined");
      if (req.url === "/async") return Promise.reject(new Error("boom"));
      res.end("ok");
    }, () => {}),
  );
  try {
    assert.equal((await fetch(`${base}/sync`)).status, 500);
    assert.equal((await fetch(`${base}/async`)).status, 500);
    assert.equal(await (await fetch(`${base}/fine`)).text(), "ok");
  } finally {
    server.close();
  }
});

test("/api/desktop/update.json answers JSON, and a failing handler behind the guard answers 500", async () => {
  const api = createVibesquadMiddleware(process.cwd());
  const { server, base } = await listen(guardHandler((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }), () => {}));
  try {
    const r = await fetch(`${base}/__vibesquad/desktop/update.json`);
    assert.ok(r.status === 200 || r.status === 401, `status ${r.status}`);
    assert.notEqual(r.status, 500);
  } finally {
    server.close();
  }
  const boom = await listen(guardHandler(() => { throw new ReferenceError("readBuildStamp is not defined"); }, () => {}));
  try {
    assert.equal((await fetch(`${boom.base}/__vibesquad/desktop/update.json`)).status, 500);
  } finally {
    boom.server.close();
  }
});

// idea-401 (PLAN_INBOX_TOP3_1120 T2): docs/-only, artifacts/-only and untracked-only dirt no longer needs --force.
test("idea-401: docs/, artifacts/ and untracked dirt don't block the sync; a dirty server/*.mjs still does", () => {
  const dir = repo();
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "docs", "SPEC.md"), "v1");
  writeFileSync(join(dir, "artifacts", "shot.txt"), "v1");
  writeFileSync(join(dir, "server", "a.mjs"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "tracked docs, artifacts, server");

  writeFileSync(join(dir, "docs", "x.md"), "untracked");
  assert.equal(syncSkipReason(dir), null, "untracked docs/x.md");
  writeFileSync(join(dir, "docs", "SPEC.md"), "v2 (another lane's uncommitted edit)");
  assert.equal(syncSkipReason(dir), null, "tracked docs/ edit");
  writeFileSync(join(dir, "artifacts", "shot.txt"), "v2");
  git(dir, "add", "artifacts/shot.txt");
  assert.equal(syncSkipReason(dir), null, "staged artifacts/ edit");
  writeFileSync(join(dir, "server", "b.mjs"), "untracked");
  assert.equal(syncSkipReason(dir), null, "untracked-only outside docs/ is ignored as before");

  writeFileSync(join(dir, "server", "a.mjs"), "export const a = 2;\n");
  assert.match(syncSkipReason(dir), /^working tree not clean \(server\/a\.mjs\)$/, "a dirty server/*.mjs still refuses, mixed with docs dirt");
  git(dir, "checkout", "-q", "--", "server/a.mjs");
  assert.equal(syncSkipReason(dir), null);
  git(dir, "rm", "-q", "--cached", "docs/SPEC.md");
  assert.equal(syncSkipReason(dir), null, "a staged docs/ delete");
  git(dir, "mv", "a.txt", "docs/a.txt");
  assert.match(syncSkipReason(dir), /not clean \(a\.txt\)/, "a rename out of the root counts its source side");
  assert.equal(guardIgnoresDirt("docsx/a.md"), false, "a prefix, not a substring");
  assert.equal(guardIgnoresDirt("public/THIRD-PARTY-LICENSES.txt"), true);
});

test("idea-401: runSync with an untracked docs/x.md and an edited tracked doc syncs into the runtime", () => {
  const dir = repo();
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "server", "a.mjs"), "export const a = 1;\n");
  writeFileSync(join(dir, "docs", "SPEC.md"), "v1");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "server + docs");
  writeFileSync(join(dir, "docs", "x.md"), "untracked");
  writeFileSync(join(dir, "docs", "SPEC.md"), "v2");
  const lad = mkdtempSync(join(tmpdir(), "vs-sync-lad-"));
  const runtime = join(lad, "VibeSquad", "runtime");
  mkdirSync(runtime, { recursive: true });
  const lines = [];
  const env = { LOCALAPPDATA: lad, VIBESQUAD_HOME: mkdtempSync(join(tmpdir(), "vs-sync-home-")) };
  const res = runSync({ repoRoot: dir, env, log: (l) => lines.push(l) });
  assert.equal(res.synced, true, lines.join("\n"));
  assert.equal(readFileSync(join(runtime, "server", "a.mjs"), "utf8"), "export const a = 1;\n");
  assert.ok(!existsSync(join(runtime, "docs")), "docs/ is never copied into the runtime");
  assert.ok(!lines.some((l) => /skipped/.test(l)), lines.join("\n"));

  writeFileSync(join(dir, "server", "a.mjs"), "export const a = 2;\n");
  const res2 = runSync({ repoRoot: dir, env, log: (l) => lines.push(l) });
  assert.equal(res2.synced, false);
  assert.match(res2.skipped, /not clean \(server\/a\.mjs\)/);
  assert.equal(readFileSync(join(runtime, "server", "a.mjs"), "utf8"), "export const a = 1;\n", "the live runtime keeps the committed copy");
});

// idea-404 (PLAN_INBOX_TOP3_1121 I1): the runtime gets only what git tracks at the synced commit.
const put = (root, rel, text) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const commitAll = (dir, msg) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
  return git(dir, "rev-parse", "HEAD");
};
function trackedRepo() {
  const dir = repo();
  for (const [rel, text] of Object.entries({
    ".gitignore": "dist/\n", "server/a.mjs": "a1", "cli/vs.mjs": "c1", "runner/r.mjs": "r1", "public/p.txt": "p1",
    "scripts/restart-runtime.mjs": "rr1", "scripts/other.mjs": "o1", "src/App.tsx": "ui",
  })) put(dir, rel, text);
  commitAll(dir, "runtime entries");
  put(dir, "dist/index.html", "built"); // gitignored build output
  return dir;
}
/** dist/ is gitignored build output here; a no-op build lets runSync stamp it as the build of HEAD. */
const okBuild = () => ({ ok: true });
function fakeInstall() {
  const lad = mkdtempSync(join(tmpdir(), "vs-sync-lad-"));
  const runtime = join(lad, "VibeSquad", "runtime");
  mkdirSync(runtime, { recursive: true });
  return { runtime, env: { LOCALAPPDATA: lad, VIBESQUAD_HOME: mkdtempSync(join(tmpdir(), "vs-sync-home-")) } };
}

test("idea-404: untracked files in server/, cli/, runner/, public/ never reach the runtime; tracked ones and dist/ do", () => {
  const dir = trackedRepo();
  for (const rel of ["server/scratch.mjs", "server/new/deep.mjs", "cli/tmp.mjs", "runner/x.log", "public/leak.txt", "scripts/untracked.mjs"]) put(dir, rel, "untracked");
  assert.equal(syncSkipReason(dir), null, "untracked-only dirt still doesn't block (T2)");
  const { runtime, env } = fakeInstall();
  const lines = [];
  const res = runSync({ repoRoot: dir, env, build: okBuild, log: (l) => lines.push(l) });
  assert.equal(res.synced, true, lines.join("\n"));
  for (const [rel, text] of [["server/a.mjs", "a1"], ["cli/vs.mjs", "c1"], ["runner/r.mjs", "r1"], ["public/p.txt", "p1"], ["scripts/restart-runtime.mjs", "rr1"], ["dist/index.html", "built"]]) {
    assert.equal(read(runtime, rel), text, rel);
  }
  for (const rel of ["server/scratch.mjs", "server/new", "cli/tmp.mjs", "runner/x.log", "public/leak.txt", "scripts/untracked.mjs", "scripts/other.mjs", "src", ".gitignore"]) {
    assert.ok(!existsSync(join(runtime, rel)), `${rel} must not be synced`);
  }
  assert.match(lines.join("\n"), /synced .*git-tracked files only\)/);
  assert.deepEqual(trackedRuntimeFiles(dir, "HEAD"), ["cli/vs.mjs", "public/p.txt", "runner/r.mjs", "scripts/restart-runtime.mjs", "server/a.mjs"]);
});

test("idea-404: content comes from the synced commit, not the working tree (forced dirty edit, HEAD moving mid-sync)", () => {
  const dir = trackedRepo();
  const base = git(dir, "rev-parse", "HEAD");
  put(dir, "server/a.mjs", "uncommitted edit");
  const { runtime, env } = fakeInstall();
  const res = syncRuntimeDir(dir, { env });
  assert.equal(res.synced, true);
  assert.equal(read(runtime, "server/a.mjs"), "a1", "a dirty tracked file (--force, or edited after the guard) ships its committed blob");
  assert.equal(JSON.parse(read(runtime, "build-stamp.json")).commit, base);

  git(dir, "checkout", "-q", "--", "server/a.mjs");
  put(dir, "server/a.mjs", "a2");
  const next = commitAll(dir, "a2");
  const pinned = syncRuntimeDir(dir, { env, commit: base });
  assert.equal(pinned.synced, true);
  assert.equal(pinned.commit, base);
  assert.equal(read(runtime, "server/a.mjs"), "a1", "the guarded sha is synced even though HEAD is now a2");
  assert.equal(JSON.parse(read(runtime, "build-stamp.json")).commit, base, "the stamp names the commit the files came from");
  assert.equal(syncRuntimeDir(dir, { env }).commit, next);
  assert.equal(read(runtime, "server/a.mjs"), "a2");
});

test("idea-404: a source that is not a git repo (or an unknown sha) refuses with a clear reason and leaves the runtime alone", () => {
  const plain = mkdtempSync(join(tmpdir(), "vs-sync-plain-"));
  put(plain, "server/a.mjs", "not tracked anywhere");
  const { runtime, env } = fakeInstall();
  put(runtime, "server/a.mjs", "live");
  writeFileSync(join(runtime, "build-stamp.json"), JSON.stringify({ commit: "old" }));
  const res = syncRuntimeDir(plain, { env });
  assert.equal(res.synced, false);
  assert.match(res.error, /^cannot read the git-tracked file list at HEAD \(.+\); only tracked files are synced, the live runtime was kept$/);
  const forced = runSync({ repoRoot: plain, env, force: true, build: okBuild, log: () => {} });
  assert.equal(forced.synced, false);
  assert.match(forced.refused, /cannot read the git-tracked file list .*build-stamp\.json not advanced/);
  assert.equal(read(runtime, "server/a.mjs"), "live");
  assert.equal(JSON.parse(read(runtime, "build-stamp.json")).commit, "old");
  const bad = syncRuntimeDir(trackedRepo(), { env, commit: "0123456789abcdef0123456789abcdef01234567" });
  assert.match(bad.error, /cannot read the git-tracked file list at 0123456/);
});

test("idea-404: files deleted from git (and earlier untracked leaks) are removed from mirrored dirs only; node_modules and installer extras stay", () => {
  const dir = trackedRepo();
  put(dir, "server/old.mjs", "old");
  put(dir, "server/Case.mjs", "case1");
  commitAll(dir, "old + Case");
  const { runtime, env } = fakeInstall();
  assert.equal(syncRuntimeDir(dir, { env }).synced, true);
  assert.equal(read(runtime, "server/old.mjs"), "old");

  git(dir, "rm", "-q", "server/old.mjs");
  git(dir, "mv", "server/Case.mjs", "server/tmp.mjs");
  git(dir, "mv", "server/tmp.mjs", "server/case.mjs");
  commitAll(dir, "delete old, rename Case -> case");
  put(runtime, "server/backend/leaked.mjs", "an untracked file an older sync copied");
  put(runtime, "runner/node_modules/pkg/index.js", "vendored");
  put(runtime, "node_modules/x/index.js", "vendored");
  put(runtime, "plugin/index.js", "installer");
  put(runtime, "scripts/squadz.mjs", "installer");
  put(runtime, "docs/profiles/DEFAULT_PACK.md", "installer");
  put(runtime, "dist/assets/old-chunk.js", "an older build's chunk");

  const res = syncRuntimeDir(dir, { env });
  assert.equal(res.synced, true, res.error);
  assert.deepEqual(res.pruned, ["server/backend/leaked.mjs", "server/old.mjs"], "a case-only rename never prunes its new spelling");
  assert.ok(!existsSync(join(runtime, "server/old.mjs")));
  assert.ok(!existsSync(join(runtime, "server/backend/leaked.mjs")));
  assert.equal(read(runtime, "server/case.mjs"), "case1");
  for (const rel of ["runner/node_modules/pkg/index.js", "node_modules/x/index.js", "plugin/index.js", "scripts/squadz.mjs", "docs/profiles/DEFAULT_PACK.md", "dist/assets/old-chunk.js"]) {
    assert.ok(existsSync(join(runtime, rel)), `${rel} is not a git mirror and stays`);
  }
  const lines = [];
  put(runtime, "cli/stray.mjs", "stray");
  assert.equal(runSync({ repoRoot: dir, env, build: okBuild, log: (l) => lines.push(l) }).synced, true, lines.join("\n"));
  assert.match(lines.join("\n"), /removed 1 file\(s\) no longer tracked: cli\/stray\.mjs/);
});

test("idea-404: a failure while removing stale files rolls back the new files and the removed ones", () => {
  const dir = trackedRepo();
  const base = git(dir, "rev-parse", "HEAD");
  put(dir, "server/a.mjs", "a2");
  commitAll(dir, "a2");
  const { runtime, env } = fakeInstall();
  writeFileSync(join(runtime, "build-stamp.json"), JSON.stringify({ commit: base }));
  put(runtime, "server/a.mjs", "a-live");
  put(runtime, "server/gone1.mjs", "g1");
  put(runtime, "server/gone2.mjs", "g2");
  const rename = (a, b) => {
    if (a.replace(/\\/g, "/").endsWith("runtime/server/gone2.mjs")) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    renameSync(a, b);
  };
  const res = syncRuntimeDir(dir, { env, ops: { rename } });
  assert.equal(res.synced, false);
  assert.match(res.error, /EBUSY/);
  assert.equal(read(runtime, "server/a.mjs"), "a-live");
  assert.equal(read(runtime, "server/gone1.mjs"), "g1", "a removed stale file is put back");
  assert.equal(read(runtime, "server/gone2.mjs"), "g2");
  assert.ok(!existsSync(join(runtime, "cli/vs.mjs")), "newly placed files are taken out again");
  assert.equal(JSON.parse(read(runtime, "build-stamp.json")).commit, base);
});
