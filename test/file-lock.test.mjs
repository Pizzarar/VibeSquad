import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateJsonFileSync, withFileLockSync } from "../server/file-lock.mjs";

const modUrl = pathToFileURL(fileURLToPath(new URL("../server/file-lock.mjs", import.meta.url))).href;

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-flock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("runs fn, returns its value and releases the lock", (t) => {
  const f = path.join(tmp(t), "a.json");
  const r = withFileLockSync(f, () => {
    assert.ok(existsSync(`${f}.lock`));
    return 42;
  });
  assert.equal(r, 42);
  assert.equal(existsSync(`${f}.lock`), false);
});

test("releases when fn throws", (t) => {
  const f = path.join(tmp(t), "a.json");
  assert.throws(() => withFileLockSync(f, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${f}.lock`), false);
});

test("takes over a stale lock from a dead pid", (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: 2147483000, startedAt: Date.now() }));
  assert.equal(withFileLockSync(f, () => "ok", { timeoutMs: 1000 }), "ok");
  assert.equal(existsSync(`${f}.lock`), false);
});

test("takes over a live other-pid lock older than staleMs (positive staleMs)", (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 60000 }));
  assert.equal(withFileLockSync(f, () => "ok", { timeoutMs: 1000, staleMs: 30000, alive: () => true }), "ok");
});

test("re-entry in the same process times out instead of stealing its own lock", (t) => {
  const f = path.join(tmp(t), "a.json");
  assert.throws(() => withFileLockSync(f, () => withFileLockSync(f, () => 1, { timeoutMs: 100, staleMs: 10 }), { staleMs: 10 }), /Timed out/);
  assert.equal(existsSync(`${f}.lock`), false);
});

test("creates a missing parent directory", (t) => {
  const f = path.join(tmp(t), "new", "lane", "TASKS.json");
  updateJsonFileSync(f, (d) => { d.a = 1; });
  assert.equal(JSON.parse(readFileSync(f, "utf8")).a, 1);
});

test("corrupt file throws and is left intact; BOM file parses", (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(f, "{not json");
  assert.throws(() => updateJsonFileSync(f, (d) => { d.x = 1; }), SyntaxError);
  assert.equal(readFileSync(f, "utf8"), "{not json");
  assert.equal(existsSync(`${f}.lock`), false);
  writeFileSync(f, "﻿" + JSON.stringify({ keep: 1 }));
  updateJsonFileSync(f, (d) => { d.x = 2; });
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { keep: 1, x: 2 });
});

test("a live-held lock times out with a clear error and is left alone", (t) => {
  const f = path.join(tmp(t), "a.json");
  const body = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  writeFileSync(`${f}.lock`, body);
  const t0 = Date.now();
  assert.throws(() => withFileLockSync(f, () => 1, { timeoutMs: 150 }), (e) => e.message.includes(`${f}.lock`) && /Timed out/.test(e.message));
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(readFileSync(`${f}.lock`, "utf8"), body);
});

test("does not release a lock owned by someone else", (t) => {
  const f = path.join(tmp(t), "a.json");
  withFileLockSync(f, () => {
    // simulate takeover by another process mid-fn
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() }));
  });
  assert.ok(existsSync(`${f}.lock`));
});

test("updateJsonFileSync: fallback, in-place mutate, returned value", (t) => {
  const f = path.join(tmp(t), "a.json");
  updateJsonFileSync(f, (d) => { d.n = (d.n ?? 0) + 1; }, { fallback: { n: 10 } });
  assert.equal(JSON.parse(readFileSync(f, "utf8")).n, 11);
  const out = updateJsonFileSync(f, (d) => ({ ...d, m: 1 }));
  assert.deepEqual(out, { n: 11, m: 1 });
  assert.equal(existsSync(`${f}.lock`), false);
});

test("real cross-process race: no lost updates", async (t) => {
  const f = path.join(tmp(t), "counter.json");
  writeFileSync(f, JSON.stringify({ n: 0 }));
  const procs = 4, per = 40;
  const code = `import(${JSON.stringify(modUrl)}).then(m=>{for(let i=0;i<${per};i++)m.updateJsonFileSync(${JSON.stringify(f)},d=>{d.n+=1},{timeoutMs:20000})})`;
  await Promise.all(
    Array.from({ length: procs }, () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "inherit", "inherit"] });
      c.on("exit", (rc) => (rc === 0 ? resolve() : reject(new Error(`child exit ${rc}`))));
      c.on("error", reject);
    })),
  );
  assert.equal(JSON.parse(readFileSync(f, "utf8")).n, procs * per);
  assert.equal(existsSync(`${f}.lock`), false);
});

// X1 E4a R2 L4 (E4b): a holder that was reaped as stale must not commit when it resumes.
test("lock.assertOwned(): fn sees its own lock; a stolen lock throws and updateJsonFileSync writes nothing", (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(f, JSON.stringify({ n: 1 }));
  withFileLockSync(f, (lock) => {
    assert.equal(lock.stillOwned(), true);
    assert.doesNotThrow(() => lock.assertOwned());
    // another writer reaped our lock and took its own
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: 2147483000, startedAt: Date.now() }));
    assert.equal(lock.stillOwned(), false);
    assert.throws(() => lock.assertOwned(), /lock lost/);
  });
  assert.ok(existsSync(`${f}.lock`), "we never release a lock that is not ours");
  rmSync(`${f}.lock`, { force: true });
  assert.throws(
    () =>
      updateJsonFileSync(f, (d) => {
        writeFileSync(`${f}.lock`, JSON.stringify({ pid: 2147483000, startedAt: Date.now() }));
        d.n = 2;
      }),
    /lock lost/,
  );
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { n: 1 }, "the stale holder's mutate never reached the file");
  rmSync(`${f}.lock`, { force: true });
});
