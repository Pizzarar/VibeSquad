import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { gitWatch, _gitWatcherCount, worktreeEventRelevant, gitDirEventRelevant } from "../server/git-watch.mjs";
import { handleGitApi } from "../server/git-api.mjs";
import { decideProxyRequest, proxyTimeoutFor } from "../plugin/server/remote-proxy-rules.ts";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roots = [];
function repo() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "gitwatch-")));
  roots.push(d);
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "one\n");
  git(d, "add", "."); git(d, "commit", "-q", "-m", "init");
  return d;
}
after(async () => { await sleep(300); for (const d of roots) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const FAST = { debounceMs: 30, lingerMs: 150, holdMs: 4000 };
const noChange = (cwd, since, holdMs = 700) => gitWatch(cwd, since, { ...FAST, holdMs });

async function expectFires(cwd, action, label) {
  const base = await gitWatch(cwd, undefined, FAST);
  assert.equal(base.changed, false);
  const p = gitWatch(cwd, base.seq, FAST);
  await sleep(100); // let the waiter attach
  action();
  const r = await p;
  assert.equal(r.changed, true, label);
  assert.notEqual(r.seq, base.seq, label);
}

test("relevance filters: node_modules and .git internals are noise", () => {
  assert.equal(worktreeEventRelevant("src/a.ts"), true);
  assert.equal(worktreeEventRelevant("node_modules/x/y.js"), false);
  assert.equal(worktreeEventRelevant("pkg\\node_modules\\x"), false);
  assert.equal(worktreeEventRelevant(".git/objects/ab/cd"), false);
  assert.equal(worktreeEventRelevant(".git"), false);
  assert.equal(gitDirEventRelevant("index"), true);
  assert.equal(gitDirEventRelevant("HEAD"), true);
  assert.equal(gitDirEventRelevant("index.lock"), false);
  assert.equal(gitDirEventRelevant("objects"), false);
});

test("fires on a working-tree edit, a new untracked file, git add, commit and branch switch", async () => {
  const d = repo();
  await expectFires(d, () => writeFileSync(join(d, "a.txt"), "two\n"), "edit");
  await expectFires(d, () => writeFileSync(join(d, "new.txt"), "n\n"), "untracked file");
  await expectFires(d, () => mkdirSync(join(d, "sub", "deep"), { recursive: true }) || writeFileSync(join(d, "sub", "deep", "f.txt"), "x"), "nested new file");
  await expectFires(d, () => git(d, "add", "new.txt"), "git add");
  await expectFires(d, () => git(d, "commit", "-q", "-m", "second"), "commit");
  await expectFires(d, () => git(d, "switch", "-q", "-c", "feature/x"), "branch switch");
  await expectFires(d, () => git(d, "switch", "-q", "main"), "switch back");
});

test("an empty commit (refs only) fires too", async () => {
  const d = repo();
  await expectFires(d, () => git(d, "commit", "-q", "--allow-empty", "-m", "empty"), "empty commit");
});

test("ignores node_modules and .git internals; times out unchanged", async () => {
  const d = repo();
  mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
  const base = await gitWatch(d, undefined, FAST);
  const p = noChange(d, base.seq, 600);
  await sleep(100);
  writeFileSync(join(d, "node_modules", "pkg", "i.js"), "x");
  writeFileSync(join(d, ".git", "scratch-file"), "x");
  const r = await p;
  assert.equal(r.changed, false);
  assert.equal(r.seq, base.seq);
});

test("a stale cursor (another epoch or a missed change) answers changed at once", async () => {
  const d = repo();
  const t0 = Date.now();
  const r = await gitWatch(d, "bogus:0", FAST);
  assert.equal(r.changed, true);
  assert.ok(Date.now() - t0 < 1000);
});

test("a change between two polls is not lost while the watcher lingers", async () => {
  const d = repo();
  const base = await gitWatch(d, undefined, { ...FAST, lingerMs: 1500 });
  writeFileSync(join(d, "gap.txt"), "x"); // no waiter attached
  await sleep(250);
  const r = await gitWatch(d, base.seq, { ...FAST, lingerMs: 1500 });
  assert.equal(r.changed, true);
});

test("watcher is released after the last waiter leaves (timeout) and on disconnect", async () => {
  const d = repo();
  const before = _gitWatcherCount();
  const base = await gitWatch(d, undefined, FAST);
  assert.equal(_gitWatcherCount(), before + 1);
  assert.equal((await noChange(d, base.seq, 150)).changed, false);
  await sleep(400);
  assert.equal(_gitWatcherCount(), before, "closed after the linger");
  const ac = new AbortController();
  const b2 = await gitWatch(d, undefined, FAST);
  const p = gitWatch(d, b2.seq, { ...FAST, holdMs: 20_000, signal: ac.signal });
  await sleep(100);
  ac.abort();
  assert.equal((await p).changed, false);
  await sleep(400);
  assert.equal(_gitWatcherCount(), before, "closed after a disconnect");
});

test("one shared watcher per cwd across concurrent waiters", async () => {
  const d = repo();
  await sleep(400); // let earlier tests' lingering entries close
  const before = _gitWatcherCount();
  const base = await gitWatch(d, undefined, FAST);
  const ps = [1, 2, 3].map(() => gitWatch(d, base.seq, FAST));
  await sleep(100);
  assert.equal(_gitWatcherCount(), before + 1);
  writeFileSync(join(d, "a.txt"), "shared\n");
  for (const r of await Promise.all(ps)) assert.equal(r.changed, true);
});

test("fallback (no recursive watch) detects edits, untracked files, add and commit via the git signature", async () => {
  const d = repo();
  const opts = { ...FAST, recursive: false };
  for (const [label, act] of [
    ["edit", () => writeFileSync(join(d, "a.txt"), "fallback\n")],
    ["untracked", () => writeFileSync(join(d, "u.txt"), "u")],
    ["add", () => git(d, "add", "u.txt")],
    ["commit", () => git(d, "commit", "-q", "-m", "fb")],
  ]) {
    const base = await gitWatch(d, undefined, opts);
    const p = gitWatch(d, base.seq, { ...opts, holdMs: 6000 });
    await sleep(100);
    act();
    assert.equal((await p).changed, true, label);
  }
});

test("route: GET git/watch long-polls through handleGitApi; unresolved cwd is 403", async () => {
  const d = repo();
  const sendJson = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const server = createServer((req, res) => handleGitApi(req, res, { readBody: async () => ({}), sendJson, resolveCwd: async (c) => (c === d ? d : null) }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/__vibesquad/git/watch?cwd=${encodeURIComponent(d)}`;
  try {
    const first = await (await fetch(base)).json();
    assert.equal(first.changed, false);
    const pending = fetch(`${base}&since=${encodeURIComponent(first.seq)}`).then((r) => r.json());
    await sleep(150);
    writeFileSync(join(d, "route.txt"), "r");
    assert.equal((await pending).changed, true);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/__vibesquad/git/watch?cwd=${encodeURIComponent(tmpdir())}`)).status, 403);
    const ac = new AbortController();
    const hang = fetch(`${base}&since=${encodeURIComponent((await (await fetch(base)).json()).seq)}`, { signal: ac.signal }).catch(() => "aborted");
    await sleep(100); ac.abort();
    assert.equal(await hang, "aborted");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test("remote proxy: git/watch is an owner GET route with the long-poll timeout", () => {
  assert.equal(decideProxyRequest("GET", "/__vibesquad/git/watch?cwd=C:/w&since=1").ok, true);
  assert.equal(decideProxyRequest("POST", "/__vibesquad/git/watch").code, "method");
  assert.equal(proxyTimeoutFor("/__vibesquad/git/watch") > 25_000, true);
  assert.equal(proxyTimeoutFor("/__vibesquad/git/status"), 10_000);
});
