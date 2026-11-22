// R2: per-agent log index + incremental status fold. Temp homes only.
import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, appendFileSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogStore } from '../runner/log.mjs';
import { Runner } from '../runner/runner.mjs';

const tmpDirs = [];
const runners = [];
test.after(() => {
  for (const r of runners) r.closeRosterWatch?.(); // before the dirs go: a watched dir is busy on Windows (idea-571)
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} }
});
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-il-')); tmpDirs.push(d); return d; };
const mkRunner = () => { const r = new Runner({ dir: path.join(tmp(), 'agents'), adapters: {}, maxLive: 4 }); runners.push(r); return r; };

// Writes a realistic log: created + n events of ~`pad` bytes.
function seed(store, id, n, pad = 200) {
  store.append(id, 'created', { provider: 'claude', model: 'm', cwd: '/x', meta: { title: id } });
  for (let i = 1; i < n; i++) store.append(id, i % 7 === 0 ? 'status' : 'text', i % 7 === 0 ? { status: 'idle' } : { text: 'x'.repeat(pad) });
}

test('timeline after=N never reads the whole file (no readFileSync) and matches a full read', () => {
  let readFileSyncCalls = 0;
  let bytesRead = 0;
  const fsSpy = { ...nodeFs, readFileSync: (...a) => { readFileSyncCalls++; return nodeFs.readFileSync(...a); }, readSync: (...a) => { const n = nodeFs.readSync(...a); bytesRead += n; return n; } };
  const dir = tmp();
  const store = new LogStore(dir, fsSpy);
  seed(store, 'rn-a', 3000);
  const fresh = new LogStore(dir, fsSpy); // cold index, like a restarted runner
  const size = nodeFs.statSync(fresh.file('rn-a')).size;
  const tail = fresh.read('rn-a', 2990);
  assert.deepEqual(tail.map((e) => e.seq), [2990, 2991, 2992, 2993, 2994, 2995, 2996, 2997, 2998, 2999]);
  assert.equal(readFileSyncCalls, 0);
  // a warm tail read touches only the tail
  bytesRead = 0;
  fresh.read('rn-a', 2990);
  assert.ok(bytesRead < size / 10, `warm tail read ${bytesRead} of ${size} bytes`);
  assert.equal(fresh.read('rn-a', 100, 5).length, 5);
  assert.equal(fresh.read('rn-a').length, 3000);
});

test('append keeps the index in place; a shrunk or externally grown file is reindexed', () => {
  const dir = tmp();
  const store = new LogStore(dir);
  seed(store, 'rn-a', 200);
  assert.equal(store.append('rn-a', 'text', { text: 'n' }).seq, 200);
  appendFileSync(store.file('rn-a'), JSON.stringify({ seq: 201, ts: 1, type: 'text' }) + '\n'); // not ours: size grew underneath us
  assert.equal(store.read('rn-a', 200).length, 2);
  assert.equal(store.append('rn-a', 'text', {}).seq, 202);
  writeFileSync(store.file('rn-a'), ['created', 'text'].map((type, seq) => JSON.stringify({ seq, ts: 1, type })).join('\n') + '\n'); // shrank
  assert.equal(store.read('rn-a', 1).length, 1);
  assert.equal(store.append('rn-a', 'text', {}).seq, 2);
});

test('status fold is incremental and never stale after meta/archive/unarchive/status', () => {
  const r = mkRunner();
  seed(r.store, 'rn-a', 50);
  assert.equal(r.status('rn-a').meta.title, 'rn-a');
  const calls = [];
  const orig = r.store.readFrom.bind(r.store);
  r.store.readFrom = (id, off, ...rest) => { calls.push(off); return orig(id, off, ...rest); };
  r.updateMeta('rn-a', { title: 'renamed' });
  assert.equal(r.status('rn-a').meta.title, 'renamed');
  r.archive('rn-a');
  assert.ok(r.status('rn-a').archivedAt);
  r.unarchive('rn-a');
  assert.equal(r.status('rn-a').archivedAt, null);
  r.store.append('rn-a', 'status', { status: 'parked' });
  assert.equal(r.status('rn-a').status, 'parked');
  assert.ok(calls.length >= 4 && calls.every((o) => o > 0), `folds resumed from offsets ${calls}`);
  // external truncation forces a full refold
  const f = r.store.file('rn-a');
  truncateSync(f, 0);
  writeFileSync(f, JSON.stringify({ seq: 0, ts: 1, type: 'created', provider: 'claude', cwd: '/x', meta: { title: 'fresh' } }) + '\n');
  assert.equal(r.status('rn-a').meta.title, 'fresh');
});

// Timing asserts are load-sensitive: enforced only with VS_BENCH=1; numbers are always logged.
const BENCH = process.env.VS_BENCH === '1';
test('bench: GET /agents/:id p95 < 20 ms on ~476 KB log; 453-agent roster seed < 2 s', () => {
  const r = mkRunner();
  seed(r.store, 'rn-big', 1900, 220); // ~476 KB
  const size = nodeFs.statSync(r.store.file('rn-big')).size;
  assert.ok(size > 400_000 && size < 560_000, `size ${size}`);
  // fresh runner on the same dir = cold start; every status after an append is a fold miss
  const cold = new Runner({ dir: r.store.dir, adapters: {}, maxLive: 4 }); runners.push(cold);
  const ms = [];
  for (let i = 0; i < 200; i++) {
    cold.store.append('rn-big', 'text', { text: 'y' });
    const t = performance.now();
    cold.status('rn-big');
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.floor(ms.length * 0.95)];
  console.log(`bench: status p95=${p95.toFixed(3)}ms on ${size} bytes`);
  if (BENCH) assert.ok(p95 < 20, `p95 ${p95}`);

  const home = tmp();
  const seedStore = new LogStore(path.join(home, 'agents'));
  let total = 0;
  for (let i = 0; i < 453; i++) { // written directly (fast); ~20 MB total, sizes vary per agent
    const n = 80 + (i % 5) * 40;
    const lines = [JSON.stringify({ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: '/x', meta: { title: `a${i}` } })];
    for (let k = 1; k < n; k++) lines.push(JSON.stringify(k % 7 === 0 ? { seq: k, ts: 1, type: 'status', status: 'idle' } : { seq: k, ts: 1, type: 'text', text: 'x'.repeat(300) }));
    writeFileSync(seedStore.file(`rn-${i}`), lines.join('\n') + '\n');
    total += nodeFs.statSync(seedStore.file(`rn-${i}`)).size;
  }
  const fresh = new Runner({ dir: path.join(home, 'agents'), adapters: {}, maxLive: 4 }); runners.push(fresh);
  const t = performance.now();
  const all = fresh.statusAll();
  const took = performance.now() - t;
  console.log(`bench: roster seed 453 agents, ${(total / 1e6).toFixed(1)} MB: ${took.toFixed(0)}ms`);
  assert.equal(all.length, 453);
  if (BENCH) assert.ok(took < 2000, `roster ${took}ms`);
});

test('read past the last indexed bucket reads ~0 bytes (count at a bucket boundary)', () => {
  let bytesRead = 0;
  const fsSpy = { ...nodeFs, readSync: (...a) => { const n = nodeFs.readSync(...a); bytesRead += n; return n; } };
  const dir = tmp();
  seed(new LogStore(dir), 'rn-a', 128);
  const store = new LogStore(dir, fsSpy);
  assert.equal(store.count('rn-a'), 128);
  bytesRead = 0;
  assert.deepEqual(store.read('rn-a', 128), []);
  assert.deepEqual(store.read('rn-a', 200), []);
  assert.equal(bytesRead, 0);
  assert.equal(store.read('rn-a', 127).length, 1);
  assert.ok(bytesRead < nodeFs.statSync(store.file('rn-a')).size * 0.6, `read ${bytesRead}`); // one bucket, not the file
});

test('CRLF logs and blank lines: index count, offsets and reads agree', () => {
  const dir = tmp();
  const store = new LogStore(dir);
  const ev = (seq) => JSON.stringify({ seq, ts: 1, type: 'text', text: 'é' });
  writeFileSync(store.file('rn-a'), [ev(0), '\r', ev(1), '', ev(2)].join('\r\n').replace('\r\n\r\n', '\r\n\r\n') + '\r\n');
  assert.equal(store.count('rn-a'), 3);
  assert.deepEqual(store.read('rn-a', 1).map((e) => e.seq), [1, 2]);
  const { events, end } = store.readFrom('rn-a', 0);
  assert.equal(events.length, 3);
  assert.equal(end, nodeFs.statSync(store.file('rn-a')).size);
  assert.equal(store.append('rn-a', 'text', {}).seq, 3);
});

test('incremental status deepEquals a cold fold from 0 across every event kind', () => {
  const r = mkRunner();
  const id = 'rn-a';
  const check = () => assert.deepEqual(r.status(id), new Runner({ dir: r.store.dir, adapters: {}, maxLive: 4 }).status(id));
  seed(r.store, id, 10);
  check();
  r.updateMeta(id, { labels: { a: '1' } }); check();
  r.updateMeta(id, { labels: { b: '2' }, title: 't2' }); check();
  r.store.append(id, 'usage', { contextTokens: 5, contextMax: 10, inputTokens: 1, outputTokens: 2, costUsd: 0.1 }); check();
  r.store.append(id, 'permission', { phase: 'request', id: 'p1', toolName: 'Bash' }); check();
  r.store.append(id, 'permission', { phase: 'request', id: 'p2', toolName: 'Edit' }); check();
  r.store.append(id, 'permission', { phase: 'resolve', id: 'p1' }); check();
  r.archive(id); check();
  r.unarchive(id); check();
  r.store.append(id, 'resume_fallback', { reason: 'x' }); check();
  r.store.append(id, 'exit', { code: 0 }); check();
  r.store.append(id, 'exit', { code: 1 }); check();
});

test('readAsync matches read() across slices and yields to the loop between them (loop-lag 302)', async () => {
  const store = new LogStore(tmp());
  seed(store, 'a', 400, 2000); // ~800 KB
  for (const after of [0, 150, 399]) {
    const want = store.read('a', after);
    assert.deepEqual(await store.readAsync('a', after, Infinity, 64 * 1024), want);
  }
  assert.deepEqual(await store.readAsync('a', 0, 5, 64 * 1024), store.read('a', 0, 5));
  // A concurrent setImmediate chain advances only if readAsync yields; a sync read would starve it until done.
  let spins = 0;
  let stop = false;
  const spin = () => { spins++; if (!stop) setImmediate(spin); };
  setImmediate(spin);
  await store.readAsync('a', 0, Infinity, 32 * 1024);
  stop = true;
  assert.ok(spins > 3, `loop ran between slices (${spins})`);
});

test('readAsync does not drop the log after a line longer than the slice (>1 MB mid-log)', async () => {
  const store = new LogStore(tmp());
  seed(store, 'a', 20, 100);
  store.append('a', 'text', { text: 'y'.repeat(1100 * 1024) });
  for (let i = 0; i < 20; i++) store.append('a', 'text', { text: 'z'.repeat(100) });
  const want = store.read('a');
  assert.equal(want.length, 41);
  assert.deepEqual(await store.readAsync('a', 0, Infinity, 64 * 1024), want);
  assert.deepEqual(await store.readAsync('a', 0), want);
});
