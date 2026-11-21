import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardIgnoresDirt, runSync, syncSkipReason } from "../server/sync-runtime.mjs";
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
