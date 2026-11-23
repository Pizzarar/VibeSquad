// Orphan sweep: a hard-killed runner's ledger (children.json) is swept at next boot, but only for pids whose
// image name AND creation time still match the record.
import "./helpers/clean-env.mjs";
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
async function gone(pid, ms = 60000) {
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

test('linux start time comes from /proc (same on every read), ps only when /proc cannot answer', () => {
  // Field 22 (starttime) = 12345 ticks; comm with a space and a paren must not shift the fields.
  const stat = `4242 (my (odd) cmd) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 12345 1000 50 18446744073709551615`;
  const files = { '/proc/4242/stat': stat, '/proc/stat': 'cpu  1 2 3\nbtime 1700000000\nprocesses 9\n' };
  const read = (f) => { if (f in files) return files[f]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const noPs = () => { throw new Error('ps must not run'); };
  const want = { name: 'my (odd) cmd', createdMs: 1700000000 * 1000 + 123450 };
  assert.deepEqual(inspectProcess(4242, { platform: 'linux', read, run: noPs }), want);
  assert.deepEqual(inspectProcess(4242, { platform: 'linux', read, run: noPs }), want, 'deterministic across calls');
  assert.deepEqual(inspectProcesses([4242], { platform: 'linux', read, run: noPs }).get(4242), want);
  // Gone (or no /proc): ps decides, as before.
  const ps = [];
  const run = (cmd, args) => { ps.push(args[1]); return { stdout: '' }; };
  assert.equal(inspectProcess(777, { platform: 'linux', read, run }), null);
  assert.deepEqual(ps, ['777']);
  assert.deepEqual(inspectProcess(4242, { platform: 'linux', read: (f) => (f === '/proc/stat' ? 'no btime' : stat), run: () => ({ stdout: '  5 node\n' }) })?.name, 'node', 'unparsable /proc falls back to ps');
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
  const ledger = createChildLedger(home);
  setChildLedger(ledger);
  const c = spawnNoShell(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
  pids.add(c.pid);
  await ledger.settled(); // idea-572: the add write is async (off the loop); settled() = on disk
  const [rec] = readChildren(home);
  assert.equal(rec.pid, c.pid);
  assert.equal(rec.name, path.basename(process.execPath).toLowerCase());
  assert.ok(Math.abs(rec.startedAt - Date.now()) < 5000);
  await new Promise((res) => c.once('exit', res));
  // idea-545: the removal is coalesced + async, so it lands shortly after the exit
  for (let i = 0; i < 100 && readChildren(home).length; i++) await sleep(50);
  assert.deepEqual(readChildren(home), []);
  assert.equal(existsSync(path.join(home, CHILDREN_FILE + '.' + process.pid + '.tmp')), false);
  setChildLedger(null);
});

test('ledger: add never writes synchronously, removals coalesce, final file matches the live set (idea-545, idea-572)', async () => {
  const home = tmp();
  const ledger = createChildLedger(home);
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  const a = mk(910001); const b = mk(910002);
  ledger.add(a, 'node.exe');
  ledger.add(b, 'node.exe');
  assert.equal(existsSync(path.join(home, CHILDREN_FILE)), false, 'add returned before any file write: no sync fs on the spawn path');
  await ledger.settled();
  assert.deepEqual(readChildren(home).map((r) => r.pid).sort(), [910001, 910002]);
  a.emit('exit');
  assert.deepEqual(readChildren(home).map((r) => r.pid).sort(), [910001, 910002]); // removal not yet written: coalesced
  const c = mk(910003);
  ledger.add(c, 'node.exe'); // an add between the exit and its write
  b.emit('exit');
  await ledger.settled();
  assert.deepEqual(readChildren(home).map((r) => r.pid), [910003]);
  assert.equal(existsSync(path.join(home, CHILDREN_FILE + '.' + process.pid + '.async.tmp')), false);
});

test('ledger: an add is written promptly, not held behind the 50 ms removal window (idea-572)', async () => {
  const home = tmp();
  const ledger = createChildLedger(home);
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  const old = mk(915001);
  ledger.add(old, 'node.exe');
  await ledger.settled();
  old.emit('exit'); // arms the coalescing timer
  const c = mk(915002);
  ledger.add(c, 'node.exe');
  for (let i = 0; i < 40 && !readChildren(home).some((r) => r.pid === 915002); i++) await new Promise((r) => setImmediate(r));
  assert.ok(readChildren(home).some((r) => r.pid === 915002), 'add landed within a few I/O turns');
  await ledger.settled();
  assert.deepEqual(readChildren(home).map((r) => r.pid), [915002]);
});

test('ledger race: adds interleaved with in-flight removal writes are never dropped; every observed file is a valid snapshot (idea-545 R1, idea-572)', async () => {
  const home = tmp();
  const ledger = createChildLedger(home);
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  const pidsOnDisk = () => readChildren(home).map((r) => r.pid);
  const live = new Set();
  const ever = new Set();
  let n = 920000;
  for (let i = 0; i < 40; i++) {
    const old = mk(n++);
    ledger.add(old, 'node.exe'); live.add(old.pid); ever.add(old.pid);
    old.emit('exit'); live.delete(old.pid);
    await sleep(40 + (i % 5) * 5); // straddles the 50 ms removal timer: before, at and after the async write starts
    const c = mk(n++);
    ledger.add(c, 'node.exe'); live.add(c.pid); ever.add(c.pid);
    for (let k = 0; k < 4; k++) {
      await new Promise((r) => setImmediate(r));
      const raw = readFileSync(path.join(home, CHILDREN_FILE), 'utf8');
      const list = JSON.parse(raw); // never torn: the rename swaps whole files
      assert.ok(list.every((r) => ever.has(r.pid)), 'only recorded pids (iter ' + i + ')');
    }
    await ledger.settled();
    assert.ok(pidsOnDisk().includes(c.pid), 'add durable once settled (iter ' + i + ')');
  }
  await sleep(120);
  await ledger.settled();
  assert.deepEqual(pidsOnDisk().sort(), [...live].sort());
  assert.equal(existsSync(path.join(home, CHILDREN_FILE + '.' + process.pid + '.async.tmp')), false);
});

test('ledger: a stale async rename that lands after a sync clear() is re-asserted, deterministic (idea-572)', async () => {
  const home = tmp();
  const fsp = await import('node:fs/promises');
  let release;
  const held = new Promise((r) => { release = r; });
  let renameCalled;
  const renameStarted = new Promise((r) => { renameCalled = r; });
  let first = true;
  const afs = { writeFile: fsp.writeFile, rm: fsp.rm, rename: async (a, b) => { if (first) { first = false; renameCalled(); await held; } return fsp.rename(a, b); } };
  const ledger = createChildLedger(home, { afs });
  const { EventEmitter } = await import('node:events');
  ledger.add(Object.assign(new EventEmitter(), { pid: 940001 }), 'node.exe');
  await renameStarted; // the [940001] rename is issued (past the generation pre-check) and held
  ledger.clear(); // sync: [] on disk now
  assert.deepEqual(readChildren(home), []);
  release(); // the stale [940001] rename lands over the clear
  await ledger.settled();
  assert.deepEqual(readChildren(home), [], 'the writer noticed its rename was stale and re-wrote the current state');
});

test('ledger: a failed async write falls back to the sync writer and loses nothing (idea-572)', async () => {
  const home = tmp();
  const fsp = await import('node:fs/promises');
  let fail = true;
  const afs = { writeFile: fsp.writeFile, rm: fsp.rm, rename: async (a, b) => { if (fail) { fail = false; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } return fsp.rename(a, b); } };
  const ledger = createChildLedger(home, { afs });
  const { EventEmitter } = await import('node:events');
  ledger.add(Object.assign(new EventEmitter(), { pid: 950001 }), 'node.exe');
  await ledger.settled();
  assert.deepEqual(readChildren(home).map((r) => r.pid), [950001]);
  assert.equal(existsSync(path.join(home, CHILDREN_FILE + '.' + process.pid + '.async.tmp')), false);
});

test('ledger: a sync clear() racing an in-flight async write is never undone by the stale rename (idea-572)', async () => {
  const home = tmp();
  const ledger = createChildLedger(home);
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  for (let i = 0; i < 30; i++) {
    ledger.add(mk(930000 + i), 'node.exe'); // starts an async write
    if (i % 3) await new Promise((r) => setImmediate(r)); // let some writes reach the rename step
    ledger.clear(); // sync: the file is [] on return
    assert.deepEqual(readChildren(home), [], 'clear is durable on return (iter ' + i + ')');
    await ledger.settled();
    assert.deepEqual(readChildren(home), [], 'a stale async rename was re-asserted over (iter ' + i + ')');
  }
  const keep = mk(939999);
  ledger.add(keep, 'node.exe');
  await ledger.settled();
  assert.deepEqual(readChildren(home).map((r) => r.pid), [939999]);
});
