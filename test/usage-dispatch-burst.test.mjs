// usa-50 (idea-788): per merged unit, dispatchBurstSize / dispatchBurstAll = same (team, lane) worker spawns within +-2m of the
// implementer's createdAt. Synthetic logs in temp dirs only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa50-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const T0 = Date.UTC(2026, 10, 20, 12);
const MAIN = 'C:\\Users\\x\\projects\\VibeSquad';
const ev = (evs) => evs.map((e, i) => JSON.stringify({ seq: i, ...e }) + '\n').join('');
function run({ ts = T0, unit, lane = 'usage', team = 'vibesquad', profile = 'Implement - Sonnet', labels = {} }) {
  return ev([
    { ts, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: MAIN, meta: { lane, team, role: 'worker', profile, labels: { wf: 'sonnet', ...(unit ? { unit } : {}), ...labels } } },
    { ts: ts + 1000, type: 'input', text: 'do it' },
    { ts: ts + 5000, type: 'turn_done', costUsd: 1, usage: { inputTokens: 100, outputTokens: 10 } },
  ]);
}
function home(logs) {
  const h = tmp();
  const dir = path.join(h, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, text] of Object.entries(logs)) fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  return h;
}
const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const sec = (ms) => String(Math.round(ms / 1000));
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
function usage(h, units) {
  clearUsageCache();
  const merges = units.map((n, i) => [`m${i + 1}`, n, T0 + 3_600_000 + i * 60_000]);
  const u = getUsage({ home: h, git: gitFor(merges), laneCodes: { usa: 'usage' }, usageReview: { suppressSchedule: true } });
  return Object.fromEntries(u.merged.units.map((m) => [m.unit, m]));
}

test('solo implementer -> 1', () => {
  const m = usage(home({ 'rn-a': run({ unit: 'unit-a' }) }), ['unit-a']);
  assert.equal(m['unit-a'].dispatchBurstSize, 1);
  assert.equal(m['unit-a'].dispatchBurstAll, 1);
});

test('three implementers 40s apart in one lane -> 3 each', () => {
  const m = usage(home({
    'rn-a': run({ ts: T0, unit: 'unit-a' }),
    'rn-b': run({ ts: T0 + 40_000, unit: 'unit-b' }),
    'rn-c': run({ ts: T0 + 80_000, unit: 'unit-c' }),
  }), ['unit-a', 'unit-b', 'unit-c']);
  for (const n of ['unit-a', 'unit-b', 'unit-c']) assert.equal(m[n].dispatchBurstSize, 3, n);
});

test('respawned implementer excluded; different lane same minute not counted', () => {
  const m = usage(home({
    'rn-a': run({ ts: T0, unit: 'unit-a' }),
    'rn-r': run({ ts: T0 + 20_000, labels: { respawnOf: 'rn-x' } }),
    'rn-o': run({ ts: T0 + 30_000, lane: 'other' }),
    'rn-t': run({ ts: T0 + 35_000, team: 'otherteam' }),
  }), ['unit-a']);
  assert.equal(m['unit-a'].dispatchBurstSize, 1);
  assert.equal(m['unit-a'].dispatchBurstAll, 1);
});

test('window is +-2m: a spawn 3m away is not counted', () => {
  const m = usage(home({ 'rn-a': run({ ts: T0, unit: 'unit-a' }), 'rn-b': run({ ts: T0 + 180_000 }) }), ['unit-a']);
  assert.equal(m['unit-a'].dispatchBurstSize, 1);
});

test('missing implementer -> null', () => {
  const m = usage(home({}), ['unit-ghost']);
  assert.equal(m['unit-ghost'].implementerAgentId, null);
  assert.equal(m['unit-ghost'].dispatchBurstSize, null);
  assert.equal(m['unit-ghost'].dispatchBurstAll, null);
});

test('dispatchBurstAll counts a reviewer spawned in the window; dispatchBurstSize does not', () => {
  const m = usage(home({
    'rn-a': run({ ts: T0, unit: 'unit-a' }),
    'rn-rev': run({ ts: T0 + 30_000, profile: 'Review - Gemini' }),
  }), ['unit-a']);
  assert.equal(m['unit-a'].dispatchBurstSize, 1);
  assert.equal(m['unit-a'].dispatchBurstAll, 2);
});
