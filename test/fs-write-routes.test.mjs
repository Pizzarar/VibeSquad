import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsWrite, fsCreate, fsRename, fsDelete, fsDuplicate, fsWatch, handleFsMutation, handleFsWatch, FS_WRITE_MAX, _watcherCount, ADE_GATED_READ_PATHS } from "../server/file-search.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "vs-w-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "vs-wout-")));
mkdirSync(join(root, "src"));
mkdirSync(join(root, ".git"));
writeFileSync(join(root, "a.txt"), "one");
writeFileSync(join(root, "src/b.md"), "bee");
writeFileSync(join(root, ".git/config"), "secret");
writeFileSync(join(outside, "secret.txt"), "nope");
let linked = true;
try { symlinkSync(outside, join(root, "escape"), "junction"); } catch { linked = false; }

test("write: atomic overwrite, mtime guard, no temp left, size cap", () => {
  const before = fsWrite(root, "a.txt", "one", undefined);
  const w = fsWrite(root, "a.txt", "two", before.modifiedAt);
  assert.equal(w.entryPath, "a.txt");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "two");
  assert.deepEqual(readdirSync(root).filter((n) => n.endsWith(".tmp")), []);
  const stale = fsWrite(root, "a.txt", "three", "2001-01-01T00:00:00.000Z");
  assert.equal(stale.status, 409);
  assert.equal(stale.conflict, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "two");
  assert.equal(fsWrite(root, "a.txt", "x".repeat(FS_WRITE_MAX + 1)).status, 413);
  assert.equal(fsWrite(root, "a.txt", 5).status, 400);
  assert.equal(fsWrite(root, "nope.txt", "x").status, 404, "write updates existing files only");
  assert.equal(fsWrite(root, "src", "x").status, 400);
});

test("create file + dir, refuses existing, bad names, .git", () => {
  assert.equal(fsCreate(root, "", "new.txt", "file").entryPath, "new.txt");
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "");
  assert.equal(fsCreate(root, "src", "sub", "directory").entryPath, "src/sub");
  assert.ok(statSync(join(root, "src/sub")).isDirectory());
  assert.equal(fsCreate(root, "", "new.txt", "file").status, 409);
  for (const bad of ["", ".", "..", "a/b", "a\\b", ".git", ".GIT", "x\0y"]) assert.equal(fsCreate(root, "", bad, "file").status, 400, JSON.stringify(bad));
  assert.equal(fsCreate(root, "", "k", "socket").status, 400);
  assert.equal(fsCreate(root, ".git", "x", "file").status, 404);
  assert.equal(fsCreate(root, "../x", "y", "file").status, 400);
  assert.equal(fsCreate(root, "/etc", "y", "file").status, 400);
});

test("rename, duplicate, delete", () => {
  assert.equal(fsRename(root, "new.txt", "moved.txt").entryPath, "moved.txt");
  assert.ok(existsSync(join(root, "moved.txt")) && !existsSync(join(root, "new.txt")));
  assert.equal(fsRename(root, "moved.txt", "a.txt").status, 409);
  assert.equal(fsRename(root, "moved.txt", "../evil").status, 400);
  assert.equal(fsRename(root, "src/b.md", "c.md").entryPath, "src/c.md");
  assert.equal(fsDuplicate(root, "src/c.md").entryPath, "src/c copy.md");
  assert.equal(fsDuplicate(root, "src/c.md").entryPath, "src/c copy 2.md");
  assert.equal(readFileSync(join(root, "src/c copy.md"), "utf8"), "bee");
  assert.equal(fsDuplicate(root, "src").entryPath, "src copy");
  assert.ok(existsSync(join(root, "src copy/c.md")));
  assert.equal(fsDelete(root, "moved.txt").entryPath, "moved.txt");
  assert.ok(!existsSync(join(root, "moved.txt")));
  assert.equal(fsDelete(root, "src copy").entryPath, "src copy");
  assert.ok(!existsSync(join(root, "src copy")));
  assert.equal(fsDelete(root, "ghost").status, 404);
});

test("delete / rename refuse the root, .git, traversal, absolute", () => {
  for (const bad of ["", ".", "/", "..", "../x", "src/../..", "/etc/passwd", "C:/Windows", "~/x", ".git", ".git/config"]) {
    const d = fsDelete(root, bad);
    assert.ok(d.error, JSON.stringify(bad));
    assert.ok(existsSync(root) && existsSync(join(root, ".git/config")));
    assert.ok(fsRename(root, bad, "z").error, JSON.stringify(bad));
  }
});

test("symlink escape: write/create/rename/delete/duplicate/watch never leave the root", { skip: !linked }, async () => {
  assert.equal(fsWrite(root, "escape/secret.txt", "pwn").status, 403);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "nope");
  assert.equal(fsCreate(root, "escape", "x.txt", "file").status, 403);
  assert.ok(!existsSync(join(outside, "x.txt")));
  assert.ok(fsDelete(root, "escape/secret.txt").error);
  assert.ok(existsSync(join(outside, "secret.txt")));
  assert.ok(fsRename(root, "escape/secret.txt", "q").error);
  assert.ok(fsDuplicate(root, "escape/secret.txt").error);
  assert.equal((await fsWatch(root, "escape/secret.txt", undefined)).status, 403);
  // Deleting the link itself removes the link, not the target directory.
  assert.equal(fsDelete(root, "escape").entryPath, "escape");
  assert.ok(existsSync(join(outside, "secret.txt")));
});

test("routes: owner-only reaches POST handlers; JSON shape, confinement, conflict 409", async () => {
  const send = (res, status, body) => { res.status = status; res.body = body; };
  const call = async (op, body) => {
    const res = {};
    const req = { method: "POST" };
    await handleFsMutation(op, req, res, [root], send, async () => body);
    return res;
  };
  let r = await call("create", { cwd: root, parentPath: "", name: "r.txt", kind: "file" });
  assert.deepEqual([r.status, r.body.ok, r.body.entryPath], [200, true, "r.txt"]);
  r = await call("write", { cwd: root, path: "r.txt", content: "hello", expectedModifiedAt: "1999-01-01T00:00:00.000Z" });
  assert.deepEqual([r.status, r.body.conflict], [409, true]);
  r = await call("write", { cwd: root, path: "r.txt", content: "hello" });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(root, "r.txt"), "utf8"), "hello");
  r = await call("write", { cwd: outside, path: "secret.txt", content: "pwn" });
  assert.equal(r.status, 403, "cwd outside every root");
  r = await call("delete", { cwd: root, path: "" });
  assert.equal(r.status, 400);
  const res = {};
  await handleFsMutation("write", { method: "GET" }, res, [root], send, async () => ({}));
  assert.equal(res.status, 405);
});

test("owner gate: watch is a gated read; mutation routes are non-GET so the server's isOwner gate applies", async () => {
  assert.ok(ADE_GATED_READ_PATHS.includes("/__vibesquad/fs/watch"));
  const { isGatedRead } = await import("../server/vibesquad-api.mjs");
  assert.equal(isGatedRead("/__vibesquad/fs/watch", "/__vibesquad/fs/watch?cwd=x"), true);
  const api = readFileSync(new URL("../server/vibesquad-api.mjs", import.meta.url), "utf8");
  // every non-GET (`write`) from a non-owner is 403 before the switch (X1c: only an allow-listed verified agent passes it, and
  // the fs routes are not on that list): the fs mutation cases sit behind that gate
  assert.match(api, /isApi && !owner && \(write \|\| isGatedRead\(path, req\.url\)\)/);
  assert.doesNotMatch(api, /AGENT_WRITE_ALLOWLIST = Object\.freeze\(\[[^\]]*\/__vibesquad\/fs\//);
  for (const op of ["write", "create", "rename", "delete", "duplicate"]) assert.match(api, new RegExp(`case "/__vibesquad/fs/${op}":`));
});

test("watch: baseline, fires on change (even atomic replace), shares one watcher, cleans up", async () => {
  writeFileSync(join(root, "w.txt"), "1");
  const base = await fsWatch(root, "w.txt", undefined);
  assert.equal(base.changed, false);
  assert.equal(_watcherCount(), 0, "baseline holds no watcher");
  const p1 = fsWatch(root, "w.txt", base.seq, { holdMs: 5000 });
  const p2 = fsWatch(root, "w.txt", base.seq, { holdMs: 5000 });
  assert.equal(_watcherCount(), 1, "two subscribers share one watcher");
  await new Promise((r) => setTimeout(r, 50));
  fsWrite(root, "w.txt", "2"); // temp + rename
  const [a, b] = await Promise.all([p1, p2]);
  assert.deepEqual([a.changed, b.changed], [true, true]);
  assert.notEqual(a.seq, base.seq);
  assert.equal(_watcherCount(), 0, "closed after the last waiter left");
  // a stale `since` answers at once
  assert.equal((await fsWatch(root, "w.txt", base.seq, { holdMs: 5000 })).changed, true);
  assert.equal(_watcherCount(), 0);
});

test("watch: timeout answers changed:false; disconnect (abort) releases the watcher; other files ignored", async () => {
  const base = await fsWatch(root, "w.txt", undefined);
  assert.equal((await fsWatch(root, "w.txt", base.seq, { holdMs: 60 })).changed, false);
  assert.equal(_watcherCount(), 0);
  const ac = new AbortController();
  const p = fsWatch(root, "w.txt", base.seq, { holdMs: 5000, signal: ac.signal });
  assert.equal(_watcherCount(), 1);
  writeFileSync(join(root, "other.txt"), "x"); // sibling change: not ours
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  assert.equal((await p).changed, false);
  assert.equal(_watcherCount(), 0);
  assert.equal((await fsWatch(root, ".git/config", undefined)).status, 404);
  assert.equal((await fsWatch(root, "../x", undefined)).status, 400);
});

test("handleFsWatch: HTTP shape + request close releases", async () => {
  const send = (res, status, body) => { res.status = status; res.body = body; };
  const res = { on(ev, fn) { this[ev] = fn; }, writableFinished: false };
  const req = { method: "GET", url: `/__vibesquad/fs/watch?cwd=${encodeURIComponent(root)}&path=w.txt` };
  await handleFsWatch(req, res, [root], send);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const res2 = { on(ev, fn) { this[ev] = fn; }, writableFinished: false };
  const p = handleFsWatch({ method: "GET", url: `${req.url}&since=${res.body.seq}` }, res2, [root], send);
  assert.equal(_watcherCount(), 1);
  res2.close(); // client disconnected
  await p;
  assert.equal(_watcherCount(), 0);
});

test("create/rename refuse a sensitive target path (.git leaf via case/dir tricks)", () => {
  assert.equal(fsCreate(root, "", ".git", "directory").status, 400);
  assert.equal(fsRename(root, "a.txt", ".Git").status, 400);
});
