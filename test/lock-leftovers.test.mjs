// idea-233 (idea-227 leftovers from the unit-loop-stall review): server hot paths that read or stat more than they need.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drainedLeadIds } from '../server/restart-coord.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
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
