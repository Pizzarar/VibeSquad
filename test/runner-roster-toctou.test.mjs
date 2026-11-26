// idea-682 (idea-597 residue): two TOCTOU lows in the roster-watch guard, from review rn-4a042c7a3808 on c6727a51.
// L1 — the guard tick clears the reopen flag (or never sets it) before `_ensureRosterWatch()` actually opens the watch, so a
//      dir that vanishes in the gap stops the guard permanently. Fix: keep the flag armed and let `_ensureRosterWatch()` clear
//      it only on success.
// L2 — an ENOENT from the watch factory (dir vanished between the stat and the watch open) was recorded as a permanent
//      failure. Fix: treat `err.code === 'ENOENT'` as a missing dir, not a failure.
// These tests inject the gap deterministically (stub rosterWatchStat / rosterWatchFactory and delete the real dir), no sleeps.
import './helpers/clean-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';

const homes = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-rtoctou-')); homes.push(d); return d; };
test.after(() => { for (const d of homes) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });

// One agent log so statusAll() has an id to fold and, via _foldScan, can start the roster watch.
function seed(dir) {
  writeFileSync(path.join(dir, 'rn-a.jsonl'),
    [{ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: os.tmpdir(), meta: {} }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// idea-1144: these tests are about the guard's stat/identity logic, not real inotify. A real fs.watch fails with EMFILE/ENOSPC
// when the per-user inotify instance budget (max_user_instances, 128) is exhausted — which happens in the full suite — and
// the runner records that as a permanent failure, leaving `_rosterWatch` null. Inject a fake watcher so no inotify is used.
const fakeWatchFactory = () => Object.assign(new EventEmitter(), { close() {} });

// A fresh runner on a temp agents dir, seeded, with a fast guard interval.
function mkRunner() {
  const home = tmp();
  const dir = path.join(home, 'agents');
  mkdirSync(dir, { recursive: true });
  seed(dir);
  const r = new Runner({ dir, adapters: {}, rosterWatchGuardMs: 25 });
  r.rosterWatchFactory = fakeWatchFactory;
  return { home, dir, r };
}

const enoent = () => { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; return e; };

test('L1: a pending reopen keeps the reopen flag armed when the dir vanishes before the reopen stat', async () => {
  const { dir, r } = mkRunner();
  try {
    r._rosterWatchReopen = true; // the guard already closed the watch: a reopen is pending
    r.rosterWatchStat = async () => ({ ino: 1n, birthtimeMs: 2n }); // the check sees the dir
    rmSync(dir, { recursive: true, force: true }); // ...but it is gone before the reopen stat
    await r._rosterWatchGuardTick();
    assert.equal(r._rosterWatch, null, 'the reopen could not open (dir gone)');
    assert.equal(r._rosterWatchReopen, true, 'the reopen flag stays armed (L1)');
    assert.ok(r._rosterWatchGuard, 'the guard reschedules instead of stopping permanently (L1)');
  } finally { r.shutdown(); }
});

test('L1: a replaced dir keeps the guard armed when the reopen races the dir away', async () => {
  const { dir, r } = mkRunner();
  try {
    r.statusAll(); // opens a real watch and captures its identity
    assert.ok(r._rosterWatch, 'watch is open');
    r.rosterWatchStat = async () => ({ ino: 999n, birthtimeMs: 999n }); // the dir looks replaced (new identity)
    rmSync(dir, { recursive: true, force: true }); // ...but it is gone before the reopen
    await r._rosterWatchGuardTick();
    assert.equal(r._rosterWatch, null, 'the reopen could not open (dir gone)');
    assert.equal(r._rosterWatchReopen, true, 'the reopen flag stays armed (L1)');
    assert.ok(r._rosterWatchGuard, 'the guard reschedules instead of stopping permanently (L1)');
  } finally { r.shutdown(); }
});

test('L2: an ENOENT from the watch factory on the initial open is a retry, not a permanent failure', async () => {
  const { r } = mkRunner();
  try {
    r.rosterWatchFactory = () => { throw enoent(); }; // dir vanished between the stat and the watch open
    r.statusAll(); // _foldScan -> _ensureRosterWatch: the stat succeeds, the factory reports the dir gone
    assert.equal(r._rosterWatchFailed, false, 'ENOENT is not a permanent failure (L2)');
    assert.equal(r._rosterWatch, null);
    assert.equal(r._rosterWatchGuard, null, 'no guard starts on a plain retry');
  } finally { r.shutdown(); }
});

test('L2: an ENOENT from the watch factory during a pending reopen keeps the guard armed', async () => {
  const { r } = mkRunner();
  try {
    r._rosterWatchReopen = true; // a reopen is pending
    r.rosterWatchStat = async () => ({ ino: 1n, birthtimeMs: 2n }); // the dir is present
    r.rosterWatchFactory = () => { throw enoent(); }; // ...but it vanishes at the watch open
    await r._rosterWatchGuardTick();
    assert.equal(r._rosterWatchFailed, false, 'ENOENT is not a permanent failure (L2)');
    assert.equal(r._rosterWatch, null);
    assert.equal(r._rosterWatchReopen, true, 'the reopen flag stays armed (L2)');
    assert.ok(r._rosterWatchGuard, 'the guard keeps polling (L2)');
  } finally { r.shutdown(); }
});

test('a permanent factory failure during a pending reopen still stops the guard (no poll spin)', async () => {
  const { r } = mkRunner();
  try {
    r._rosterWatchReopen = true;
    r.rosterWatchStat = async () => ({ ino: 1n, birthtimeMs: 2n });
    r.rosterWatchFactory = () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
    await r._rosterWatchGuardTick();
    assert.equal(r._rosterWatchFailed, true, 'a non-ENOENT factory error is permanent');
    assert.equal(r._rosterWatch, null);
    assert.equal(r._rosterWatchGuard, null, 'the guard does not reschedule after a permanent failure');
  } finally { r.shutdown(); }
});
