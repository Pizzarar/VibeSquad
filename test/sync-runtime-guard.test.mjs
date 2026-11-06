import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkipReason } from "../server/sync-runtime.mjs";
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
