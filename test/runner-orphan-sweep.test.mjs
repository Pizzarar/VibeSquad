// Orphan sweep: a hard-killed runner's ledger (children.json) is swept at next boot, but only for pids whose
// image name AND creation time still match the record.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CHILDREN_FILE, createChildLedger, inspectProcess, inspectProcesses, matchesRecord, readChildren, sweepOrphans } from '../runner/children.mjs';
import { setChildLedger, spawnNoShell } from '../runner/spawn.mjs';

const dirs = [];
const pids = new Set();
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-orphan-')); dirs.push(d); return d; };
after(() => {
  setChildLedger(null);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}
function orphan() {
  const t0 = Date.now();
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  pids.add(c.pid);
  return { pid: c.pid, t0, name: path.basename(process.execPath).toLowerCase(), child: c };
}

test('matchesRecord needs name and start time', () => {
  const rec = { name: 'node.exe', startedAt: 100000 };
  assert.equal(matchesRecord(rec, { name: 'node.exe', createdMs: 101000 }), true);
  assert.equal(matchesRecord(rec, { name: 'node.exe', createdMs: 100000 + 3600000 }), false);
  assert.equal(matchesRecord(rec, { name: 'chrome.exe', createdMs: 100000 }), false);
  assert.equal(matchesRecord(rec, null), false);
  assert.equal(matchesRecord({ name: 'node.exe' }, { name: 'node.exe', createdMs: 1 }), false);
});

test('sweep with injected inspector kills only matches and clears the file', () => {
  const home = tmp();
  writeFileSync(path.join(home, CHILDREN_FILE), JSON.stringify([
    { pid: 111, name: 'claude.exe', startedAt: 1000 },
    { pid: 222, name: 'claude.exe', startedAt: 1000 },
    { pid: 333, name: 'claude.exe', startedAt: 1000 },
    { pid: 444, name: 'claude.exe', startedAt: 1000 },
  ]));
  const info = { 111: { name: 'claude.exe', createdMs: 1500 }, 222: { name: 'claude.exe', createdMs: 999999 }, 333: { name: 'notepad.exe', createdMs: 1000 }, 444: null };
  const killed = [];
  const r = sweepOrphans(home, { inspect: (pid) => info[pid], kill: (pid) => killed.push(pid), alive: () => true });
  assert.deepEqual(killed, [111]);
  assert.deepEqual(r.skipped.sort(), [222, 333, 444]);
  assert.deepEqual(readChildren(home), []);
});

test('sweep kills a real orphan, spares a start-time decoy, then clears the ledger', async () => {
  const home = tmp();
  const real = orphan();
  const decoy = orphan();
  await sleep(300);
  // The "killed runner" left both in the ledger; the decoy's recorded start is an hour off (a reused pid).
  writeFileSync(path.join(home, CHILDREN_FILE), JSON.stringify([
    { pid: real.pid, name: real.name, startedAt: real.t0 },
    { pid: decoy.pid, name: decoy.name, startedAt: decoy.t0 - 3600000 },
  ]));
  const info = inspectProcess(real.pid);
  assert.ok(info, 'process inspection unavailable on this machine');
  const batch = inspectProcesses([real.pid, decoy.pid]);
  assert.deepEqual(batch.get(real.pid), info, 'one batched lookup returns the same info as the per-pid lookup');
  assert.ok(batch.has(decoy.pid));
  const r = sweepOrphans(home); // default path: batched lookup
  assert.deepEqual(r.killed, [real.pid]);
  assert.deepEqual(r.skipped, [decoy.pid]);
  assert.equal(await gone(real.pid), true, 'orphan must die');
  assert.equal(alive(decoy.pid), true, 'decoy must survive');
  assert.deepEqual(readChildren(home), []);
});

test('batched lookup with a lookup failure returns an empty map (kill nothing)', () => {
  const m = inspectProcesses([123, 456], { platform: 'win32', run: () => { throw new Error('no powershell'); } });
  assert.equal(m.size, 0);
  assert.equal(inspectProcesses([], { platform: 'win32', run: () => { throw new Error('not called'); } }).size, 0);
});

test('sweep spares a live pid whose image name differs', async () => {
  const home = tmp();
  const d = orphan();
  await sleep(300);
  writeFileSync(path.join(home, CHILDREN_FILE), JSON.stringify([{ pid: d.pid, name: 'claude.exe', startedAt: d.t0 }]));
  assert.deepEqual(sweepOrphans(home).killed, []);
  assert.equal(alive(d.pid), true);
});

test('sweep tolerates a missing or corrupt ledger', () => {
  const home = tmp();
  assert.deepEqual(sweepOrphans(home), { killed: [], skipped: [] });
  writeFileSync(path.join(home, CHILDREN_FILE), '{not json');
  assert.deepEqual(sweepOrphans(home), { killed: [], skipped: [] });
  assert.equal(readFileSync(path.join(home, CHILDREN_FILE), 'utf8'), '[]');
});

test('spawnNoShell records the child and drops it on exit', async () => {
  const home = tmp();
  setChildLedger(createChildLedger(home));
  const c = spawnNoShell(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
  pids.add(c.pid);
  const [rec] = readChildren(home);
  assert.equal(rec.pid, c.pid);
  assert.equal(rec.name, path.basename(process.execPath).toLowerCase());
  assert.ok(Math.abs(rec.startedAt - Date.now()) < 5000);
  await new Promise((res) => c.once('exit', res));
  assert.deepEqual(readChildren(home), []);
  assert.equal(existsSync(path.join(home, CHILDREN_FILE + '.' + process.pid + '.tmp')), false);
  setChildLedger(null);
});
