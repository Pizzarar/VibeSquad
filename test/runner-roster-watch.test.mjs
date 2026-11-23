// idea-594: the runner's roster watch (fs.watch on the agents dir) spins a CPU core on Windows if that directory is
// deleted under a live runner — libuv keeps polling the dead handle and 'error' never fires (idea-571/590 fixed the
// test-side variant). The production fix is a cheap unref'd guard (one async fs.promises.stat every rosterWatchGuardMs)
// that closes the watcher when the dir is gone or its identity (ino/birthtime) changed, and reopens it when the dir
// exists again. This file drives the guard at a fast interval and asserts the close/reopen behavior.
import './helpers/clean-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// One agent log so statusAll() has an id to fold and, via _foldScan, starts the roster watch.
function seed(dir) {
  writeFileSync(path.join(dir, 'rn-a.jsonl'),
    [{ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: os.tmpdir(), meta: {} }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('roster watch closes when the agents dir is deleted and reopens after it is recreated', async () => {
  const home = tmp();
  const dir = path.join(home, 'agents');
  mkdirSync(dir, { recursive: true });
  seed(dir);
  const r = new Runner({ dir, adapters: {}, rosterWatchGuardMs: 50 });
  try {
    r.statusAll(); // folds the one log and starts the roster watch (plus its guard)
    assert.ok(r._rosterWatch, 'watch is open after a scan');
    rmSync(dir, { recursive: true, force: true });
    await until(() => !r._rosterWatch, 2000); // the guard closes the watch within a bound, before libuv spins
    mkdirSync(dir, { recursive: true });
    await until(() => !!r._rosterWatch, 2000); // the guard reopens once the dir exists again
  } finally {
    r.shutdown(); // closes the watch + guard timer before the temp home is removed
  }
});
