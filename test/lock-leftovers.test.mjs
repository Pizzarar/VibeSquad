// idea-233 (idea-227 leftovers from the unit-loop-stall review): server hot paths that read or stat more than they need.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { drainedLeadIds } from '../server/restart-coord.mjs';
import { LogStore } from '../runner/log.mjs';
import { Runner } from '../runner/runner.mjs';

const dirs = [];
const runners = [];
after(() => {
  for (const r of runners) r.closeRosterWatch?.(); // before the dirs go: a watched dir is busy on Windows
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'vs-lockleft-') => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/** Count bytes fs.readSync / readFileSync hand back while `fn` runs. */
function countReads(fn) {
  const origRead = fs.readSync;
  const origFile = fs.readFileSync;
  let bytes = 0;
  fs.readSync = function (...a) { const n = origRead.apply(this, a); bytes += n; return n; };
  fs.readFileSync = function (...a) { const r = origFile.apply(this, a); bytes += r.length ?? 0; return r; };
  try { return { result: fn(), bytes }; } finally { fs.readSync = origRead; fs.readFileSync = origFile; }
}

// ---- (a) drainedLeadIds stops at `since` ----------------------------------------------------------------------------

test('(a) drainedLeadIds reads the team log from the end and stops once entries are older than since', () => {
  const home = tmp();
  mkdirSync(path.join(home, 'teams', 'sq'), { recursive: true });
  const file = path.join(home, 'teams', 'sq', 'log.jsonl');
  const since = '2026-11-14T12:00:00.000Z';
  const sinceMs = Date.parse(since);
  const line = (ms, agent, text, type = 'metric') => JSON.stringify({ ts: new Date(ms).toISOString(), agent, lane: 'l', type, text }) + '\n';
  const parts = [];
  // ~3 MB of history from the day before (one stale drain in it that must not count).
  parts.push(line(sinceMs - 86400000, 'rn-stale', 'restart-feedback: drained restart'));
  const pad = 'x'.repeat(200);
  for (let i = 0; i < 12000; i++) parts.push(line(sinceMs - 86400000 + i * 1000, 'rn-noise', `progress ${pad}`, 'progress'));
  parts.push(line(sinceMs + 1000, 'rn-lead1', 'restart-feedback: drained restart'));
  parts.push(line(sinceMs + 2000, 'rn-other', 'restart-feedback: something else'));
  parts.push(line(sinceMs + 3000, 'rn-lead2', 'restart-feedback: drained restart'));
  writeFileSync(file, parts.join(''));
  const size = fs.statSync(file).size;

  const { result, bytes } = countReads(() => drainedLeadIds(home, ['sq'], since));
  assert.deepEqual([...result].sort(), ['rn-lead1', 'rn-lead2']);
  assert.ok(bytes < size / 4, `read ${bytes} of ${size} bytes: must stop near the since cutoff, not read the whole log`);
});

test('(a) drainedLeadIds: a drain logged a little out of order (just before an older line) still counts; missing log is empty', () => {
  const home = tmp();
  mkdirSync(path.join(home, 'teams', 'sq'), { recursive: true });
  const since = '2026-11-14T12:00:00.000Z';
  const sinceMs = Date.parse(since);
  const e = (ms, agent, text, type = 'metric') => JSON.stringify({ ts: new Date(ms).toISOString(), agent, type, text });
  // Two writers raced: the drain (ts after since) landed before a line stamped 2s before since.
  writeFileSync(path.join(home, 'teams', 'sq', 'log.jsonl'), [
    e(sinceMs - 600000, 'rn-old', 'restart-feedback: drained restart'),
    e(sinceMs + 500, 'rn-lead', 'restart-feedback: drained restart'),
    e(sinceMs - 2000, 'rn-x', 'note', 'progress'),
    'not json',
    '',
  ].join('\r\n'));
  assert.deepEqual([...drainedLeadIds(home, ['sq', 'missing'], since)], ['rn-lead']);
});

// ---- (b) runner roster scan: no stat per log for logs known unchanged -----------------------------------------------

/** Count fs.statSync calls (named imports included, via syncBuiltinESMExports) while `fn` runs. */
async function countStats(fn) {
  const orig = fs.statSync;
  let n = 0;
  fs.statSync = function (...a) { n++; return orig.apply(this, a); };
  syncBuiltinESMExports();
  try { const result = await fn(); return { result, stats: n }; } finally { fs.statSync = orig; syncBuiltinESMExports(); }
}
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const byId = (all) => Object.fromEntries(all.agents.map((a) => [a.id, a]));

function seededRunner(n) {
  const dir = path.join(tmp('vs-roster-'), 'agents');
  const seedStore = new LogStore(dir);
  for (let i = 0; i < n; i++) {
    seedStore.append(`rn-${i}`, 'created', { provider: 'claude', model: 'm', cwd: '/x', meta: { title: `a${i}`, labels: { role: 'worker' } } });
    seedStore.append(`rn-${i}`, 'status', { status: 'idle' });
    if (i % 2) seedStore.append(`rn-${i}`, 'archive', {});
  }
  const r = new Runner({ dir, adapters: {}, maxLive: 4 });
  runners.push(r);
  return r;
}

test('(b) a repeat roster scan does not stat every log; it returns the same agents as the cold scan', async () => {
  const r = seededRunner(300);
  const cold = await countStats(() => r.statusAllAsync());
  assert.equal(cold.result.agents.length, 300);
  assert.ok(cold.stats >= 300, `cold scan stats each log (${cold.stats})`);
  const warm = await countStats(() => r.statusAllAsync());
  assert.ok(warm.stats < 10, `warm scan stat'ed ${warm.stats} logs`);
  assert.deepEqual(warm.result, cold.result);
  assert.deepEqual(r.statusAll(), cold.result.agents);
});

test('(b) the cached scan still sees in-process writes at once and external writes (append, rewrite, new log)', async () => {
  const r = seededRunner(20);
  await r.statusAllAsync();
  r.updateMeta('rn-2', { title: 'renamed' });
  r.archive('rn-4');
  assert.equal(byId(await r.statusAllAsync())['rn-2'].meta.title, 'renamed');
  assert.ok(byId(await r.statusAllAsync())['rn-4'].archivedAt);
  assert.equal(r.laneHasLiveLead(undefined, 'l9'), false);

  // Another process appends to one log, rewrites another, and creates a third.
  const ext = (id, ev) => fs.appendFileSync(r.store.file(id), JSON.stringify(ev) + '\n');
  ext('rn-6', { seq: 2, ts: 5, type: 'meta', patch: { title: 'external', labels: { role: 'lead', lane: 'l9' } } });
  writeFileSync(r.store.file('rn-8'), JSON.stringify({ seq: 0, ts: 1, type: 'created', provider: 'claude', cwd: '/x', meta: { title: 'rewritten' } }) + '\n');
  ext('rn-new', { seq: 0, ts: 1, type: 'created', provider: 'claude', cwd: '/x', meta: { title: 'new' } });
  await until(async () => {
    const a = byId(await r.statusAllAsync());
    return a['rn-6']?.meta.title === 'external' && a['rn-8']?.meta.title === 'rewritten' && a['rn-new']?.meta.title === 'new';
  });
  assert.equal(r.laneHasLiveLead(undefined, 'l9'), true);
  // and a scan after that matches a fresh runner's cold read of the same dir
  const fresh = new Runner({ dir: r.store.dir, adapters: {}, maxLive: 4 });
  runners.push(fresh);
  assert.deepEqual(byId(await r.statusAllAsync()), byId(await fresh.statusAllAsync()));
});

test('(b) without a working directory watch the scan stats every log (fallback = old behaviour)', async () => {
  const r = seededRunner(30);
  r.rosterWatchFactory = () => { throw new Error('no watch here'); };
  r.closeRosterWatch();
  await r.statusAllAsync();
  const again = await countStats(() => r.statusAllAsync());
  assert.ok(again.stats >= 30, `fallback stat'ed ${again.stats}`);
  // a watch error mid-life drops the cache too
  const r2 = seededRunner(30);
  await r2.statusAllAsync();
  r2._rosterWatch.emit('error', new Error('EPERM'));
  const after2 = await countStats(() => r2.statusAllAsync());
  assert.ok(after2.stats >= 30, `after a watch error stat'ed ${after2.stats}`);
});
