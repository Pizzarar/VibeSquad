// usa-42: pre-cutover cost backfill. scripts/usage-import-archive.mjs restores runner/agents/*.jsonl from a home-backup zip into
// <home>/runner/agents-archive/ (never touching runner/agents); getUsage folds the archive read-only (live wins on an id clash),
// caches its listing, and the ledger re-fold supersedes costless unit rows. Fixtures are temp dirs only.
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { clearUsageCache, getUsage, getUsageAsync, readUsageLedger, usageStats } from '../server/providers-catalog.mjs';
import { importArchive } from '../scripts/usage-import-archive.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/usage-import-archive.mjs', import.meta.url));
const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa42-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

/** Minimal zip writer (deflate or store) so the test needs no zip binary. entries: [{ name, data, store? }] */
function writeZip(file, entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const raw = Buffer.from(data);
    const body = store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const crc = crc32(raw) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(store ? 0 : 8, 8);
    lfh.writeUInt16LE(0x5a21, 10); lfh.writeUInt16LE(0x5b77, 12); // dos time/date
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(body.length, 18); lfh.writeUInt32LE(raw.length, 22); lfh.writeUInt16LE(nameBuf.length, 26);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(store ? 0 : 8, 10);
    cdh.writeUInt16LE(0x5a21, 12); cdh.writeUInt16LE(0x5b77, 14);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(body.length, 20); cdh.writeUInt32LE(raw.length, 24); cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    locals.push(lfh, nameBuf, body);
    central.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

const ev = (o) => JSON.stringify(o) + '\n';
const agentLog = (evs) => evs.map((e, i) => ev({ seq: i, ...e })).join('');
const T0 = Date.UTC(2026, 10, 19, 12);
const sec = (ms) => String(Math.round(ms / 1000));
const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const worker = (unit, cost, { provider = 'claude', model = 'claude-sonnet-5-5', ts = T0 } = {}) => agentLog([
  { ts, type: 'created', provider, model, cwd: `/wt/VibeSquad/${unit}`, meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet', labels: { wf: 'sonnet' } } },
  { ts: ts + 1000, type: 'input', text: 'do it' },
  { ts: ts + 2000, type: 'turn_done', costUsd: cost, usage: { inputTokens: 100, outputTokens: 10 } },
]);
/** Snapshot of a dir (name -> content + mtime) to prove it was not touched. */
const snap = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => { const p = path.join(dir, n); return [n, [fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs]]; }));
const noSchedule = { suppressSchedule: true };

test('usa-42 import: extracts only runner/agents/*.jsonl, skips live + archived dups, never touches runner/agents', async () => {
  const home = tmp();
  const live = path.join(home, 'runner', 'agents');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'rn-dup.jsonl'), 'LIVE\n');
  const before = snap(live);
  const zip = path.join(tmp(), 'home.zip');
  writeZip(zip, [
    { name: 'teams/x/log.jsonl', data: '{"not":"an agent"}\n' },
    { name: 'runner/agents/rn-dup.jsonl', data: 'ARCHIVED\n' },
    { name: 'runner/agents/rn-a.jsonl', data: 'a'.repeat(5000) + '\n' },
    { name: 'runner/agents/rn-b.jsonl', data: 'b\n', store: true },
    { name: 'runner/agents/rn-empty.jsonl', data: '', store: true },
    { name: 'runner/prompts/rn-a.md', data: 'prompt' },
    { name: 'runner/agents/sub/rn-nested.jsonl', data: 'nested\n' },
    { name: 'runner/agents/../evil.jsonl', data: 'evil\n' },
  ]);

  const dry = await importArchive(zip, { home: path.join(tmp(), 'fresh'), dryRun: true });
  assert.equal(dry.found, 4);
  assert.equal(dry.imported, 4);
  assert.equal(fs.existsSync(dry.home), false, 'dry-run writes nothing');

  const s = await importArchive(zip, { home });
  assert.deepEqual([s.found, s.imported, s.skippedDup, s.skippedLive, s.errors.length], [4, 3, 1, 1, 0]);
  assert.equal(s.bytes, 5001 + 2 + 0);
  const archive = path.join(home, 'runner', 'agents-archive');
  assert.deepEqual(fs.readdirSync(archive).sort(), ['rn-a.jsonl', 'rn-b.jsonl', 'rn-empty.jsonl'], 'no .part leftovers, no dup, no nested/escaped entry');
  assert.equal(fs.readFileSync(path.join(archive, 'rn-a.jsonl'), 'utf8'), 'a'.repeat(5000) + '\n');
  assert.deepEqual(snap(live), before, 'runner/agents untouched');
  assert.equal(fs.existsSync(path.join(home, 'evil.jsonl')) || fs.existsSync(path.join(home, 'runner', 'evil.jsonl')), false);

  const again = await importArchive(zip, { home });
  assert.deepEqual([again.imported, again.skippedDup, again.skippedLive, again.skippedArchive], [0, 4, 1, 3], 're-run is idempotent');
  assert.deepEqual(snap(live), before, 'runner/agents still untouched');

  // One top-level folder prefix (a zip of the home folder itself) is accepted; the CLI prints counts.
  const zip2 = path.join(tmp(), 'prefixed.zip');
  writeZip(zip2, [{ name: 'vibesquad/runner/agents/rn-p.jsonl', data: 'p\n' }]);
  const home2 = tmp();
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, zip2, '--home', home2, '--json'], { encoding: 'utf8' }));
  assert.deepEqual([out.prefix, out.found, out.imported], ['vibesquad/', 1, 1]);
  assert.equal(fs.existsSync(path.join(home2, 'runner', 'agents')), false, 'import never creates runner/agents');
});

test('usa-42 import: refuses an agents-archive that resolves into runner/agents', async () => {
  const home = tmp();
  const live = path.join(home, 'runner', 'agents');
  fs.mkdirSync(live, { recursive: true });
  fs.symlinkSync(live, path.join(home, 'runner', 'agents-archive'), 'dir');
  const zip = path.join(tmp(), 'home.zip');
  writeZip(zip, [{ name: 'runner/agents/rn-x.jsonl', data: 'x\n' }]);
  await assert.rejects(importArchive(zip, { home }), /refusing/);
  assert.deepEqual(fs.readdirSync(live), []);
});

/** A home with one live worker (unit-live), an archived worker for the same id (must lose), and an archived pre-cutover worker. */
function buildHome() {
  const home = tmp();
  const live = path.join(home, 'runner', 'agents');
  const arch = path.join(home, 'runner', 'agents-archive');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(live, 'rn-live.jsonl'), worker('unit-live', 1, { ts: T0 + 86_400_000 }));
  fs.writeFileSync(path.join(arch, 'rn-live.jsonl'), worker('unit-live', 100, { ts: T0 + 86_400_000 })); // id clash: live wins
  fs.writeFileSync(path.join(arch, 'rn-old.jsonl'), worker('unit-old', 5));
  return { home, live, arch };
}
const gitFor = (merges) => (args) => {
  if (args[0] === 'rev-parse') return `${merges[0][0]}\n`;
  if (args[0] === 'log') {
    const lines = [];
    merges.forEach(([sha, unit, ms], i) => {
      const parent = merges[i + 1]?.[0] ?? 'root';
      lines.push(L(sha, `${parent} b${sha}`, sec(ms), `Merge branch '${unit}' (@usa)`), L(`b${sha}`, parent, sec(ms - 1000), 'feat (@usa)'));
    });
    lines.push(L('root', '', '0', 'init'));
    return lines.join('\n');
  }
  return '';
};

test('usa-42 getUsage: archived cost folds in (live wins on an id clash), byWorkflow costCoverage, cached archive listing', async () => {
  const { home, arch } = buildHome();
  const git = gitFor([['m2', 'unit-live', T0 + 90_000_000], ['m1', 'unit-old', T0 + 10_000]]);
  clearUsageCache();
  const s0 = usageStats();
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' }, usageReview: noSchedule });
  assert.equal(u.totals.costUsd, 6, 'live 1 + archived 5; the archived copy of rn-live (100) is ignored');
  assert.equal(u.files, 2);
  const units = Object.fromEntries(u.merged.units.map((m) => [m.unit, m]));
  assert.equal(units['unit-old']?.costUsd, 5, 'pre-cutover unit gets its implementer cost from the archive');
  assert.equal(units['unit-live']?.costUsd, 1);
  const sonnet = u.byWorkflow.find((w) => w.workflowMode === 'sonnet');
  assert.equal(sonnet?.units, 2);
  assert.equal(sonnet.costCoverage, 1);
  assert.equal(u.byDay.find((d) => d.day === '2026-11-19')?.costUsd, 5);
  const s1 = usageStats();
  assert.equal(s1.archive.scans - s0.archive.scans, 1);
  assert.equal(s1.archive.folds - s0.archive.folds, 1);

  // Second call: no readdir of the archive, no stat of an archived file, no bytes re-read.
  const statted = [];
  const realStat = fs.statSync;
  mock.method(fs, 'statSync', function (p, ...rest) { statted.push(String(p)); return realStat.call(this, p, ...rest); });
  syncBuiltinESMExports();
  let u2;
  try { u2 = getUsage({ home, git, laneCodes: { usa: 'usage' }, usageReview: noSchedule }); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  const s2 = usageStats();
  assert.equal(u2.totals.costUsd, 6);
  assert.equal(s2.readBytes, s1.readBytes, 'nothing re-read');
  assert.deepEqual([s2.archive.scans, s2.archive.folds], [s1.archive.scans, s1.archive.folds], 'archive listing reused, no per-file pass');
  assert.deepEqual(statted.filter((p) => p.startsWith(arch + path.sep)), [], 'no archived file statted');

  // Async (HTTP) path: same numbers, still no archive pass.
  const ua = await getUsageAsync({ home, git, laneCodes: { usa: 'usage' }, usageReview: noSchedule, cacheMs: 0 });
  assert.equal(ua.totals.costUsd, 6);
  assert.deepEqual([usageStats().archive.scans, usageStats().archive.folds, usageStats().readBytes], [s1.archive.scans, s1.archive.folds, s1.readBytes]);

  // A later import (dir mtime moves) rescans once and folds only the new file.
  fs.writeFileSync(path.join(arch, 'rn-new.jsonl'), worker('unit-new', 2));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(arch, future, future);
  const before = usageStats().readBytes;
  const u3 = await getUsageAsync({ home, git, laneCodes: { usa: 'usage' }, usageReview: noSchedule, cacheMs: 0 });
  assert.equal(u3.totals.costUsd, 8);
  assert.equal(usageStats().archive.scans, s1.archive.scans + 1);
  assert.equal(usageStats().readBytes - before, fs.statSync(path.join(arch, 'rn-new.jsonl')).size, 'only the new archived file read');
});

test('usa-42 getUsage: a cold async call folds the archive without holding the loop', async () => {
  const home = tmp();
  const arch = path.join(home, 'runner', 'agents-archive');
  fs.mkdirSync(arch, { recursive: true });
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(arch, `rn-${String(i).padStart(4, '0')}.jsonl`), worker(`unit-${i}`, 0.5, { ts: T0 + i * 60_000 }));
  clearUsageCache();
  let ticks = 0;
  let on = true;
  const tick = () => { if (on) { ticks += 1; setImmediate(tick); } };
  setImmediate(tick);
  const u = await getUsageAsync({ home, git: () => '', usageReview: noSchedule, cacheMs: 0 });
  on = false;
  assert.ok(ticks > 0, 'the event loop ran while the archive was folded');
  assert.equal(u.files, 300);
  assert.equal(Math.round(u.totals.costUsd * 100) / 100, 150);
  assert.equal(usageStats().archive.files, 300);
});

test('usa-42 ledger re-fold: costless unit rows are superseded once the archive supplies the cost (idempotent)', () => {
  const { home } = buildHome();
  const ledgerFile = path.join(home, 'runner', 'usage-ledger.jsonl');
  // Written post-cutover with no implementer log: costUsd null, unattributed.
  const stale = { kind: 'unit', unit: null, sha: 'm1', ts: new Date(T0 + 10_000).toISOString(), lane: 'usage', implementerProfile: null, implementerProvider: null, workflowMode: 'unattributed', reviewRounds: 0, firstTryPass: true, costUsd: null, totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, cycleMs: null, locAdded: 0, locDeleted: 0, filesChanged: 0, fixedAfterMerge: false };
  const known = { ...stale, sha: 'm0', costUsd: 7, workflowMode: 'opus' };
  fs.writeFileSync(ledgerFile, ev(stale) + ev(known));
  const git = gitFor([['m2', 'unit-live', T0 + 90_000_000], ['m1', 'unit-old', T0 + 10_000], ['m0', 'unit-zero', T0]]);
  clearUsageCache();
  getUsage({ home, git, laneCodes: { usa: 'usage' }, usageReview: noSchedule, now: () => T0 + 100_000_000 });
  const ledger = readUsageLedger(home);
  assert.equal(ledger.filter((r) => r.sha === 'm1').length, 1, 'one record per sha after supersede');
  const m1 = ledger.find((r) => r.sha === 'm1');
  assert.equal(m1.costUsd, 5);
  assert.equal(m1.workflowMode, 'sonnet');
  assert.equal(ledger.find((r) => r.sha === 'm0').costUsd, 7, 'a unit that already had a cost is never rewritten');
  assert.equal(ledger.findIndex((r) => r.sha === 'm1'), 0, 'superseded record keeps its position');
  const text = fs.readFileSync(ledgerFile, 'utf8');
  getUsage({ home, git, laneCodes: { usa: 'usage' }, usageReview: noSchedule, now: () => T0 + 100_000_000 });
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), text, 'second sync appends nothing');
  assert.equal(text.split('\n').filter((l) => l.includes('"sha":"m1"')).length, 2, 'append-only: stale line kept, superseding line added');

  // Once m1 falls off the git log, the folded ledger row carries the cost into byWorkflow.
  const git2 = gitFor([['m2', 'unit-live', T0 + 90_000_000]]);
  clearUsageCache();
  const u = getUsage({ home, git: git2, laneCodes: { usa: 'usage' }, usageReview: noSchedule, now: () => T0 + 100_000_000 });
  const folded = u.merged.units.find((m) => m.sha === 'm1');
  assert.equal(folded?.fromLedger, true);
  assert.equal(folded.costUsd, 5);
  assert.equal(u.byWorkflow.find((w) => w.workflowMode === 'sonnet')?.costCoverage, 1);
});
