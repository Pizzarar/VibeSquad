// idea-594: the runner's roster watch (fs.watch on the agents dir) spins a CPU core on Windows if that directory is
// deleted under a live runner — libuv keeps polling the dead handle and 'error' never fires (idea-571/590 fixed the
// test-side variant). The production fix is a cheap unref'd guard (one async stat every rosterWatchGuardMs) that closes
// the watcher when the dir is gone or its identity (ino/birthtime) changed, and reopens it when the dir exists again.
// This file drives the guard at a fast interval and covers the review findings: H1 (shutdown during a pending stat),
// M1 (slow/overlapping ticks), M2 (explicit close stays closed), M3 (identity captured at open, not on tick 1), plus the
// error fallback and the clean-cache invalidation.
import './helpers/clean-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { stat as fspStat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';

const homes = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-rw-')); homes.push(d); return d; };
test.after(() => { for (const d of homes) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });

const until = async (fn, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One agent log so statusAll() has an id to fold and, via _foldScan, starts the roster watch.
function seed(dir) {
  writeFileSync(path.join(dir, 'rn-a.jsonl'),
    [{ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: os.tmpdir(), meta: {} }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// A fresh runner on a temp agents dir, seeded, with a fast guard interval.
function mkRunner() {
  const home = tmp();
  const dir = path.join(home, 'agents');
  mkdirSync(dir, { recursive: true });
  seed(dir);
  return { home, dir, r: new Runner({ dir, adapters: {}, rosterWatchGuardMs: 25 }) };
}

test('roster watch closes when the agents dir is deleted and reopens after it is recreated', async () => {
  const { dir, r } = mkRunner();
  try {
    r.statusAll(); // folds the one log and starts the roster watch (plus its guard)
    assert.ok(r._rosterWatch, 'watch is open after a scan');
    rmSync(dir, { recursive: true, force: true });
    await until(() => !r._rosterWatch, 2000); // the guard closes the watch within a bound
    mkdirSync(dir, { recursive: true });
    await until(() => !!r._rosterWatch, 2000); // the guard reopens once the dir exists again
  } finally {
    r.shutdown();
  }
});

test('M3: delete + recreate before the first guard tick still closes the stale watch (identity at open)', async () => {
  const { dir, r } = mkRunner();
  try {
    r.statusAll();
    const w1 = r._rosterWatch;
    assert.ok(w1, 'watch is open');
    // Recreate before the first guard tick (25ms): with the identity captured at open, the stale handle is replaced.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await until(() => r._rosterWatch !== w1, 2000); // the old handle was closed and a fresh one opened
    assert.ok(r._rosterWatch, 'watch is open on the new dir');
  } finally {
    r.shutdown();
  }
});

test('M2: an explicit closeRosterWatch() stays closed — the guard does not reopen it', async () => {
  const { dir, r } = mkRunner();
  try {
    r.statusAll();
    assert.ok(r._rosterWatch, 'watch is open after a scan');
    r.closeRosterWatch(); // what shutdown, the error handler and tests (before rmSync) do
    assert.equal(r._rosterWatch, null);
    assert.equal(r._rosterWatchGuard, null, 'the guard timer is stopped');
    await sleep(120); // several guard intervals elapse
    assert.equal(r._rosterWatch, null, 'the watch stays closed after an explicit close');
    assert.equal(r._rosterWatchFailed, false);
  } finally {
    r.shutdown();
  }
});

test('H1: shutdown during a pending stat leaves no watcher and no guard timer', async () => {
  const { r } = mkRunner();
  let statStarted = false;
  let resolveStat = null;
  r.rosterWatchStat = () => { statStarted = true; return new Promise((res) => { resolveStat = res; }); };
  r.statusAll();
  assert.ok(r._rosterWatch, 'watch is open');
  await until(() => statStarted, 2000); // the first tick is now awaiting its stat
  r.shutdown(); // lands while the stat is in flight
  assert.equal(r._rosterWatch, null);
  assert.equal(r._rosterWatchGuard, null);
  resolveStat({ ino: 123n, birthtimeMs: 456n }); // the stat resolves as if the dir still existed
  await sleep(50); // let the in-flight tick resume
  assert.equal(r._rosterWatch, null, 'no watcher resurrected after shutdown');
  assert.equal(r._rosterWatchGuard, null, 'no guard timer resurrected after shutdown');
});

test('M1: a slow stat never overlaps and never sets the failed flag across delete/recreate', async () => {
  const { dir, r } = mkRunner();
  let inflight = 0;
  let maxInflight = 0;
  r.rosterWatchStat = async (d) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try { await sleep(60); return await fspStat(d, { bigint: true }); } // slower than the 25ms interval
    finally { inflight--; }
  };
  try {
    r.statusAll();
    assert.ok(r._rosterWatch, 'watch is open');
    rmSync(dir, { recursive: true, force: true }); // dir gone: the slow stat resolves ENOENT
    await until(() => !r._rosterWatch, 2000); // closed
    mkdirSync(dir, { recursive: true }); // dir back
    await until(() => !!r._rosterWatch, 2000); // reopened
    assert.equal(r._rosterWatchFailed, false, 'a slow stat must not permanently fail the watch');
    assert.equal(maxInflight, 1, 'self-rescheduling setTimeout keeps ticks serialized');
  } finally {
    r.shutdown();
  }
});

test("a watch 'error' stops the guard and never reopens (permanent-failure fallback)", async () => {
  const { r } = mkRunner();
  try {
    r.statusAll();
    assert.ok(r._rosterWatch, 'watch is open');
    r._rosterWatch.emit('error', new Error('EPERM'));
    assert.equal(r._rosterWatch, null);
    assert.equal(r._rosterWatchFailed, true);
    assert.equal(r._rosterWatchGuard, null, 'the guard stops on a permanent failure');
    await sleep(120); // several guard intervals elapse
    assert.equal(r._rosterWatch, null, 'never reopens after a watch error');
  } finally {
    r.shutdown();
  }
});

test('a guard close clears the clean-cache so the next scan re-stats', async () => {
  const { dir, r } = mkRunner();
  try {
    r.statusAll();
    assert.ok(r._foldClean.size >= 1, 'the folded agent is marked clean');
    rmSync(dir, { recursive: true, force: true });
    await until(() => !r._rosterWatch, 2000);
    assert.equal(r._foldClean.size, 0, 'closing the watch drops every clean mark');
  } finally {
    r.shutdown();
  }
});
