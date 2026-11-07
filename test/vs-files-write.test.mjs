// N2 client: src/vsFiles.ts write/entry/watch helpers against a fake fetch, and the call sites are off the daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vsWriteFile, vsCreateEntry, vsRenameEntry, vsDeleteEntry, vsDuplicateEntry, vsWatchFile, VsFilesError } from "../src/vsFiles.ts";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const withFetch = async (fake, fn) => { const real = globalThis.fetch; globalThis.fetch = fake; try { return await fn(); } finally { globalThis.fetch = real; } };

test("vsWriteFile maps ok / conflict / error and posts cwd, path, content, expectedModifiedAt", async () => {
  const seen = [];
  const replies = [json(200, { ok: true, modifiedAt: "T" }), json(409, { ok: false, conflict: true, error: "file changed on disk" }), json(413, { ok: false, error: "content too large" })];
  await withFetch(async (url, init) => (seen.push([url, JSON.parse(init.body)]), replies.shift()), async () => {
    assert.deepEqual(await vsWriteFile("/w", "a.md", "hi", "M"), { status: "ok", modifiedAt: "T" });
    assert.equal((await vsWriteFile("/w", "a.md", "hi", "M")).status, "conflict");
    assert.deepEqual(await vsWriteFile("/w", "a.md", "big"), { status: "error", error: "content too large" });
  });
  assert.equal(seen[0][0], "/__vibesquad/fs/write");
  assert.deepEqual(seen[0][1], { cwd: "/w", path: "a.md", content: "hi", expectedModifiedAt: "M" });
  assert.ok(!("expectedModifiedAt" in seen[2][1]));
});

test("vsWriteFile resolves (never throws) when the server is down", async () => {
  const r = await withFetch(async () => { throw new Error("offline"); }, () => vsWriteFile("/w", "a", "x"));
  assert.equal(r.status, "error");
  assert.match(r.error, /offline/);
});

test("entry ops return entryPath and throw VsFilesError on failure", async () => {
  const calls = [];
  await withFetch(async (url, init) => (calls.push([url, JSON.parse(init.body)]), json(200, { ok: true, entryPath: "x/y" })), async () => {
    assert.equal(await vsCreateEntry("/w", "x", "y", "file"), "x/y");
    assert.equal(await vsRenameEntry("/w", "x/y", "z"), "x/y");
    assert.equal(await vsDuplicateEntry("/w", "x/y"), "x/y");
    await vsDeleteEntry("/w", "x/y");
  });
  assert.deepEqual(calls.map((c) => c[0]), ["create", "rename", "duplicate", "delete"].map((o) => `/__vibesquad/fs/${o}`));
  await withFetch(async () => json(409, { ok: false, error: "already exists" }), async () => {
    await assert.rejects(vsCreateEntry("/w", "", "y", "file"), (e) => e instanceof VsFilesError && /already exists/.test(e.message));
  });
});

test("vsWatchFile: baseline is silent, a change fires onChange, stop() aborts the request", async () => {
  const urls = [];
  let abortedSignal;
  let n = 0;
  let fired = 0;
  const fake = (url, init) => {
    urls.push(url);
    abortedSignal = init.signal;
    n++;
    if (n === 1) return Promise.resolve(json(200, { ok: true, seq: "s1", changed: false })); // baseline
    if (n === 2) return Promise.resolve(json(200, { ok: true, seq: "s2", changed: true }));
    return new Promise((_ok, fail) => init.signal.addEventListener("abort", () => fail(new Error("aborted")))); // parked poll
  };
  const stop = await withFetch(fake, async () => {
    const s = vsWatchFile("/w", "a b.md", () => fired++);
    await new Promise((r) => setTimeout(r, 50));
    return s;
  });
  assert.equal(fired, 1);
  assert.ok(!urls[0].includes("since="));
  assert.match(urls[1], /since=s1/);
  assert.match(urls[2], /since=s2/);
  assert.match(urls[0], /path=a%20b\.md/);
  stop();
  assert.equal(abortedSignal.aborted, true);
});

test("call sites are off the Paseo daemon", () => {
  for (const f of ["FilesPanel.tsx", "InlineEdit.tsx", "ProjectPanel.tsx", "paseoFiles.ts", "paseoPermissions.ts"]) {
    assert.doesNotMatch(src(f), /daemonClient/, f);
  }
  assert.match(src("FilesPanel.tsx"), /vsWatchFile\(cwd, path,/);
  assert.match(src("FilesPanel.tsx"), /vsWriteFile\(cwd, openFile, editValue, fileModifiedAt\)/);
  assert.doesNotMatch(src("paseo.ts"), /file writes \(FilesPanel/);
});
