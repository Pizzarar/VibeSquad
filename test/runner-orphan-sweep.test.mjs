// Orphan sweep: a hard-killed runner's ledger (children.json) is swept at next boot, but only for pids whose
// image name AND creation time still match the record.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

test('ledger: an add is written promptly, not held behind the 50 ms removal window (idea-572)', async (t) => {
  const home = tmp();
  const ledger = createChildLedger(home);
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  const old = mk(915001);
  ledger.add(old, 'node.exe');
  await ledger.settled();
  // idea-925: freeze setTimeout from here, so the 50 ms removal timer can never fire. The add must then land on the
  // kick() path alone; a real-time I/O-turn budget (the old 40 setImmediate loop) flaked when the disk was slow.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  old.emit('exit'); // arms the (frozen) coalescing timer
  const c = mk(915002);
  ledger.add(c, 'node.exe');
  const deadline = Date.now() + 10_000; // only a hang guard: the wait ends on the file, not on elapsed time
  while (!readChildren(home).some((r) => r.pid === 915002)) {
    if (Date.now() > deadline) assert.fail('add never landed while the removal timer was frozen');
    await new Promise((r) => setImmediate(r));
  }
  t.mock.timers.reset(); // real timers back; settled() flushes the pending removal
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

// idea-681: what is on disk right now (null = no file yet), and the files left in home (no temp may linger).
const onDisk = (home) => { try { return JSON.parse(readFileSync(path.join(home, CHILDREN_FILE), 'utf8')).map((r) => r.pid); } catch { return null; } };
const leftovers = (home) => readdirSync(home).filter((f) => f !== CHILDREN_FILE);

test('ledger: clear() during an in-flight rename never lets the stale rename land after it; disk only moves forward (idea-681)', async () => {
  const home = tmp();
  const fsp = await import('node:fs/promises');
  let release;
  const held = new Promise((r) => { release = r; });
  let renameCalled;
  const renameStarted = new Promise((r) => { renameCalled = r; });
  let first = true;
  const seen = []; // every on-disk state, in order
  const afs = { writeFile: fsp.writeFile, rm: fsp.rm, rename: async (a, b) => {
    if (first) { first = false; renameCalled(); await held; }
    await fsp.rename(a, b);
    seen.push(onDisk(home));
  } };
  const ledger = createChildLedger(home, { afs });
  const { EventEmitter } = await import('node:events');
  ledger.add(Object.assign(new EventEmitter(), { pid: 940001 }), 'node.exe'); // generation 1
  await renameStarted; // the [940001] rename is issued and held: it is "in the threadpool"
  ledger.clear(); // generation 2, while that rename is in flight
  seen.push(onDisk(home));
  release(); // the [940001] rename lands now
  await ledger.settled();
  // Old code: clear() wrote [] sync, the held rename put [940001] back, the writer re-wrote [] -> [[], [940001], []].
  const genOf = (st) => (st === null ? 0 : st.includes(940001) ? 1 : 2);
  const gens = seen.map(genOf);
  assert.deepEqual(gens, [...gens].sort((x, y) => x - y), 'on-disk generations never go backwards: ' + JSON.stringify(seen));
  assert.deepEqual(seen, [null, [940001], []]);
  assert.deepEqual(onDisk(home), []);
  assert.deepEqual(leftovers(home), [], 'no temp file left');
});

test('ledger: clear() with no write in flight is durable on return (sync shutdown path, idea-681)', async () => {
  const home = tmp();
  const ledger = createChildLedger(home);
  const { EventEmitter } = await import('node:events');
  ledger.add(Object.assign(new EventEmitter(), { pid: 941001 }), 'node.exe');
  await ledger.settled();
  assert.deepEqual(onDisk(home), [941001]);
  ledger.clear();
  assert.deepEqual(onDisk(home), [], 'written before clear() returned');
  await ledger.settled();
  assert.deepEqual(onDisk(home), []);
  assert.deepEqual(leftovers(home), []);
});

test('ledger: a spawn burst during each tmp write never skips the rename; every write lands the previous snapshot (idea-681)', async () => {
  const home = tmp();
  const fsp = await import('node:fs/promises');
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  const N = 6;
  let next = 942000;
  const diskAtWrite = [];
  let ledger;
  // Every writeFile sees one more add land while it is in flight: the generation always moves under the writer.
  const afs = { rm: fsp.rm, rename: fsp.rename, writeFile: async (p, data) => {
    diskAtWrite.push(onDisk(home)?.length ?? 0);
    const io = fsp.writeFile(p, data);
    await null; // the add arrives while the write is in flight (as a spawn would), not re-entrantly inside the call
    if (next < 942000 + N) ledger.add(mk(next++), 'node.exe');
    return io;
  } };
  ledger = createChildLedger(home, { afs });
  ledger.add(mk(next++), 'node.exe');
  await ledger.settled();
  // Old code skipped the rename whenever gen moved during writeFile: nothing reached disk until the burst ended (all 0).
  assert.deepEqual(diskAtWrite.slice(0, N), Array.from({ length: N }, (_, i) => i), 'write i finds the snapshot of write i-1 on disk');
  assert.deepEqual(onDisk(home).sort(), Array.from({ length: N }, (_, i) => 942000 + i));
  assert.deepEqual(leftovers(home), []);
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

test('ledger: clear() while a failed write is cleaning up is carried by the sync fallback; no temp left (idea-681)', async () => {
  const home = tmp();
  const fsp = await import('node:fs/promises');
  let rmHit; const rmStarted = new Promise((r) => { rmHit = r; });
  let rmGo; const rmHeld = new Promise((r) => { rmGo = r; });
  const afs = {
    writeFile: fsp.writeFile,
    rename: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
    rm: async (p, o) => { rmHit(); await rmHeld; return fsp.rm(p, o); },
  };
  const ledger = createChildLedger(home, { afs });
  const { EventEmitter } = await import('node:events');
  ledger.add(Object.assign(new EventEmitter(), { pid: 943001 }), 'node.exe');
  await rmStarted; // the writer is in its catch, awaiting the temp cleanup
  ledger.clear(); // a writer is in flight: the clear is queued, not written over it
  assert.equal(onDisk(home), null);
  rmGo();
  await ledger.settled();
  assert.deepEqual(onDisk(home), [], 'the sync fallback wrote the state after clear()');
  assert.deepEqual(leftovers(home), []);
});

test('ledger: clear() while the write is held at each stage (tmp write, rename, idle) keeps disk monotonic and ends at [] (idea-572, idea-681)', async () => {
  const home = tmp();
  const fsp = await import('node:fs/promises');
  const seen = [];
  let gate = null; // { op, started, release } holds the next call to op until released
  const hold = (op) => { let started; let release; const g = { op, started: new Promise((r) => { started = r; }) }; g.hit = started; g.go = new Promise((r) => { release = r; }); g.release = release; gate = g; return g; };
  const pass = async (op) => { const g = gate; if (g?.op === op) { gate = null; g.hit(); await g.go; } };
  const afs = {
    rm: fsp.rm,
    writeFile: async (p, data) => { await pass('writeFile'); return fsp.writeFile(p, data); },
    rename: async (a, b) => { await pass('rename'); await fsp.rename(a, b); seen.push(onDisk(home)); },
  };
  const ledger = createChildLedger(home, { afs });
  const { EventEmitter } = await import('node:events');
  const mk = (pid) => Object.assign(new EventEmitter(), { pid });
  const stages = ['writeFile', 'rename', 'idle'];
  for (let i = 0; i < 12; i++) {
    const stage = stages[i % 3];
    const base = 931000 + i; const pid = 930000 + i;
    ledger.add(mk(base), 'node.exe');
    await ledger.settled(); // disk: [base] (gen 0 of this round), never [] before the clear
    seen.length = 0;
    const g = stage === 'idle' ? null : hold(stage);
    ledger.add(mk(pid), 'node.exe'); // [base, pid] (gen 1)
    if (g) await g.started; else await ledger.settled();
    ledger.clear(); // [] (gen 2)
    const afterClear = onDisk(home);
    seen.push(afterClear);
    g?.release();
    await ledger.settled();
    const gens = seen.map((st) => (st.length === 0 ? 2 : st.includes(pid) ? 1 : 0));
    assert.deepEqual(gens, [...gens].sort((x, y) => x - y), stage + ': never backwards (iter ' + i + '): ' + JSON.stringify(seen));
    assert.deepEqual(onDisk(home), [], stage + ': settled at [] (iter ' + i + ')');
    if (stage === 'idle') assert.deepEqual(afterClear, [], 'idle: clear() durable on return');
  }
  const keep = mk(939999);
  ledger.add(keep, 'node.exe');
  await ledger.settled();
  assert.deepEqual(onDisk(home), [939999]);
  assert.deepEqual(leftovers(home), []);
});
