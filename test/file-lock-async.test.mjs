// idea-227 (file-lock part) + idea-114 L1/L4: the async lock never blocks the event loop while it waits, it excludes sync
// holders in other processes (same <file>.lock), and stale reaping re-checks the holder before it removes anything.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reapStaleLock, updateJsonFile, updateJsonFileSync, withFileLock, withFileLockSync } from "../server/file-lock.mjs";

const modUrl = pathToFileURL(fileURLToPath(new URL("../server/file-lock.mjs", import.meta.url))).href;
const DEAD_PID = 2147483000;

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-flock-async-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A child process that takes the lock with withFileLockSync, prints "held", and keeps it for `holdMs`. */
function holdInChild(f, holdMs) {
  const code = `import(${JSON.stringify(modUrl)}).then(m=>m.withFileLockSync(${JSON.stringify(f)},()=>{process.stdout.write("held\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${holdMs});}))`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("held")) resolve(); });
    child.on("error", reject);
    child.on("exit", (rc) => reject(new Error(`holder exited (${rc}) before taking the lock`)));
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { held, exited };
}

/** Largest gap between setInterval ticks while `run()` is pending: a blocked loop shows up as one long gap. */
async function maxTickGap(run) {
  let last = Date.now();
  let max = 0;
  const iv = setInterval(() => {
    const now = Date.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    const value = await run();
    max = Math.max(max, Date.now() - last);
    return { value, max };
  } finally {
    clearInterval(iv);
  }
}

test("withFileLock: uncontended runs fn (sync or async), returns its value and releases", async (t) => {
  const f = path.join(tmp(t), "a.json");
  assert.equal(await withFileLock(f, () => { assert.ok(existsSync(`${f}.lock`)); return 7; }), 7);
  assert.equal(await withFileLock(f, async () => { await new Promise((r) => setTimeout(r, 5)); return 8; }), 8);
  assert.equal(existsSync(`${f}.lock`), false);
  await assert.rejects(withFileLock(f, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${f}.lock`), false);
});

test("lock file carries pid + startedAt + a per-acquire token", async (t) => {
  const f = path.join(tmp(t), "a.json");
  const seen = [];
  await withFileLock(f, () => seen.push(JSON.parse(readFileSync(`${f}.lock`, "utf8"))));
  withFileLockSync(f, () => seen.push(JSON.parse(readFileSync(`${f}.lock`, "utf8"))));
  for (const s of seen) {
    assert.equal(s.pid, process.pid);
    assert.ok(Number.isFinite(s.startedAt));
    assert.match(String(s.token), /^[0-9a-f]{16}$/);
  }
  assert.notEqual(seen[0].token, seen[1].token);
});

test("idea-227: a contended async wait does not block the event loop (sync holder in another process)", async (t) => {
  const f = path.join(tmp(t), "a.json");
  const holder = holdInChild(f, 700);
  await holder.held;
  const t0 = Date.now();
  const { value, max } = await maxTickGap(() => withFileLock(f, () => "got it", { timeoutMs: 10_000 }));
  const waited = Date.now() - t0;
  assert.equal(value, "got it");
  assert.ok(waited >= 300, `it really waited for the holder (waited ${waited}ms)`);
  assert.ok(max < 150, `event loop kept ticking while waiting (max gap ${max}ms over a ${waited}ms wait)`);
  await holder.exited;
});

test("contrast: the sync variant does block the loop for the whole wait (why request paths moved off it)", async (t) => {
  const f = path.join(tmp(t), "a.json");
  const holder = holdInChild(f, 500);
  await holder.held;
  const { max } = await maxTickGap(async () => {
    await new Promise((r) => setTimeout(r, 10)); // let the interval arm first
    return withFileLockSync(f, () => 1, { timeoutMs: 10_000 });
  });
  assert.ok(max >= 250, `sync wait froze the loop (max gap ${max}ms)`);
  await holder.exited;
});

test("updateJsonFile: fallback, in-place mutate, returned value, corrupt file untouched", async (t) => {
  const f = path.join(tmp(t), "a.json");
  await updateJsonFile(f, (d) => { d.n = (d.n ?? 0) + 1; }, { fallback: { n: 10 } });
  assert.equal(JSON.parse(readFileSync(f, "utf8")).n, 11);
  assert.deepEqual(await updateJsonFile(f, (d) => ({ ...d, m: 1 })), { n: 11, m: 1 });
  writeFileSync(f, "{not json");
  await assert.rejects(updateJsonFile(f, (d) => { d.x = 1; }), SyntaxError);
  assert.equal(readFileSync(f, "utf8"), "{not json");
  assert.equal(existsSync(`${f}.lock`), false);
});

test("mutual exclusion: async holders here + sync and async holders in other processes, no lost updates", async (t) => {
  const f = path.join(tmp(t), "counter.json");
  writeFileSync(f, JSON.stringify({ n: 0 }));
  const per = 30;
  const syncChild = `import(${JSON.stringify(modUrl)}).then(m=>{for(let i=0;i<${per};i++)m.updateJsonFileSync(${JSON.stringify(f)},d=>{d.n+=1},{timeoutMs:30000})})`;
  const asyncChild = `import(${JSON.stringify(modUrl)}).then(async m=>{for(let i=0;i<${per};i++)await m.updateJsonFile(${JSON.stringify(f)},d=>{d.n+=1},{timeoutMs:30000})})`;
  const run = (code) =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "inherit", "inherit"] });
      c.on("exit", (rc) => (rc === 0 ? resolve() : reject(new Error(`child exit ${rc}`))));
      c.on("error", reject);
    });
  // Here: three concurrent async writers whose critical section awaits (so in-process waiters really overlap with it),
  // plus a check that no two holders are ever inside at once.
  let inside = 0;
  const local = async () => {
    for (let i = 0; i < per; i++) {
      await withFileLock(f, async (lock) => {
        assert.equal(++inside, 1, "two holders inside the lock at once");
        const d = JSON.parse(readFileSync(f, "utf8"));
        await new Promise((r) => setTimeout(r, 1));
        lock.assertOwned();
        writeFileSync(f, JSON.stringify({ n: d.n + 1 }));
        inside--;
      }, { timeoutMs: 30000 });
    }
  };
  await Promise.all([run(syncChild), run(syncChild), run(asyncChild), local(), local(), local()]);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).n, per * 6);
  assert.equal(existsSync(`${f}.lock`), false);
});

test("async waiter takes over a dead holder's lock, and a live old lock past staleMs", async (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }));
  assert.equal(await withFileLock(f, () => "ok", { timeoutMs: 1000 }), "ok");
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 60000 }));
  assert.equal(await withFileLock(f, () => "ok2", { timeoutMs: 1000, staleMs: 30000, alive: () => true }), "ok2");
  assert.equal(existsSync(`${f}.lock`), false);
});

test("a live-held lock times out (async) with the same error and is left alone", async (t) => {
  const f = path.join(tmp(t), "a.json");
  const body = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  writeFileSync(`${f}.lock`, body);
  const t0 = Date.now();
  await assert.rejects(withFileLock(f, () => 1, { timeoutMs: 150 }), (e) => e.message.includes(`${f}.lock`) && /Timed out/.test(e.message));
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(readFileSync(`${f}.lock`, "utf8"), body);
});

test("timeoutMs 0 is a single try: busy lock throws at once, free lock is taken", async (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
  // "No waiting" is asserted by counting sleeps (sync Atomics.wait, async setTimeout), not wall time: reading the
  // freshly written lock file costs 5-15ms under Windows real-time AV scanning, so a stopwatch bound flakes.
  let sleeps = 0;
  const realWait = Atomics.wait;
  const realSetTimeout = globalThis.setTimeout;
  Atomics.wait = (...a) => { sleeps++; return realWait(...a); };
  globalThis.setTimeout = (...a) => { sleeps++; return realSetTimeout(...a); };
  try {
    assert.throws(() => withFileLockSync(f, () => 1, { timeoutMs: 0 }), /Timed out/);
    await assert.rejects(withFileLock(f, () => 1, { timeoutMs: 0 }), /Timed out/);
  } finally {
    Atomics.wait = realWait;
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(sleeps, 0, "no waiting");
  rmSync(`${f}.lock`);
  assert.equal(withFileLockSync(f, () => 2, { timeoutMs: 0 }), 2);
});

// ---- idea-114 L4: the reaper re-checks the holder; a reaped holder neither commits nor removes a newer lock ----

test("L4: a holder judged dead that answers again on the re-check under the reap guard is not reaped", async (t) => {
  const f = path.join(tmp(t), "a.json");
  const body = JSON.stringify({ pid: 4242, startedAt: Date.now(), token: "aaaaaaaaaaaaaaaa" });
  writeFileSync(`${f}.lock`, body);
  let calls = 0;
  const alive = () => ++calls > 1; // first look: dead; the re-check right before the rm: alive
  await assert.rejects(withFileLock(f, () => "stolen", { timeoutMs: 150, alive }), /Timed out/);
  assert.equal(readFileSync(`${f}.lock`, "utf8"), body, "the live holder's lock was never removed");
  calls = 0;
  assert.throws(() => withFileLockSync(f, () => "stolen", { timeoutMs: 150, alive }), /Timed out/);
  assert.equal(readFileSync(`${f}.lock`, "utf8"), body);
});

test("L4: reapStaleLock removes nothing when the lock changed since it was judged (identity, token, mtime)", (t) => {
  const dir = tmp(t);
  const lockFile = path.join(dir, "a.json.lock");
  const old = Date.now() / 1000 - 60;
  const opts = { staleMs: 30000, alive: () => false };

  // judged: dead holder X. Now: a new holder with the same pid + startedAt but a fresh token (re-created lock).
  const seen = { pid: DEAD_PID, startedAt: 1000, token: "1111111111111111" };
  writeFileSync(lockFile, JSON.stringify({ ...seen, token: "2222222222222222" }));
  utimesSync(lockFile, old, old);
  assert.equal(reapStaleLock(lockFile, seen, statSync(lockFile).mtimeMs, opts), false);
  assert.ok(existsSync(lockFile), "token differs: not the lock we judged");

  // Same content, but rewritten after we judged it (mtime moved).
  writeFileSync(lockFile, JSON.stringify(seen));
  const judgedAt = statSync(lockFile).mtimeMs - 5000;
  assert.equal(reapStaleLock(lockFile, seen, judgedAt, opts), false);
  assert.ok(existsSync(lockFile), "mtime differs: replaced since the judgement");

  // Judged: unreadable and old. Now: a fresh lock caught mid-write (empty file, new mtime). The old reaper removed it.
  writeFileSync(lockFile, "");
  assert.equal(reapStaleLock(lockFile, null, statSync(lockFile).mtimeMs - 5000, opts), false);
  assert.ok(existsSync(lockFile), "a fresh mid-write lock is never reaped as 'unreadable and old'");
  // Same unreadable file, but now fresh by its own mtime: still not reaped (age re-checked under the guard).
  assert.equal(reapStaleLock(lockFile, null, statSync(lockFile).mtimeMs, opts), false);
  assert.ok(existsSync(lockFile));

  // The lock we judged, unchanged and still stale: reaped.
  writeFileSync(lockFile, JSON.stringify(seen));
  utimesSync(lockFile, old, old);
  assert.equal(reapStaleLock(lockFile, seen, statSync(lockFile).mtimeMs, opts), true);
  assert.equal(existsSync(lockFile), false);
  assert.equal(existsSync(`${lockFile}.reap`), false, "reap guard released");
});

test("L4: a reaped async holder does not commit, and does not release the new same-pid holder's lock", async (t) => {
  const f = path.join(tmp(t), "a.json");
  writeFileSync(f, JSON.stringify({ n: 1 }));
  const takeover = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "ffffffffffffffff" }); // another task in this process
  await assert.rejects(
    updateJsonFile(f, (d) => {
      writeFileSync(`${f}.lock`, takeover);
      d.n = 2;
    }),
    /lock lost/,
  );
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { n: 1 }, "the stale holder's mutate never reached the file");
  assert.equal(readFileSync(`${f}.lock`, "utf8"), takeover, "release checks the token, not just the pid");
  rmSync(`${f}.lock`);
  withFileLockSync(f, () => writeFileSync(`${f}.lock`, takeover));
  assert.equal(readFileSync(`${f}.lock`, "utf8"), takeover, "the sync release checks the token too");
});

test("compatible with old-format sync holders: a { pid, startedAt } lock from a live pid is waited on, not stolen", async (t) => {
  const f = path.join(tmp(t), "a.json");
  const body = JSON.stringify({ pid: process.ppid, startedAt: Date.now() });
  writeFileSync(`${f}.lock`, body);
  setTimeout(() => rmSync(`${f}.lock`, { force: true }), 120); // the old holder releases
  const t0 = Date.now();
  assert.equal(await withFileLock(f, () => "after release", { timeoutMs: 5000 }), "after release");
  assert.ok(Date.now() - t0 >= 100);
});

test("updateJsonFileSync stays available for CLI / one-shot callers", (t) => {
  const f = path.join(tmp(t), "a.json");
  assert.deepEqual(updateJsonFileSync(f, (d) => { d.a = 1; }), { a: 1 });
});
