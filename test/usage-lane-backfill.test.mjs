// usa-61 (idea-990): merged units without a (@code subject tag get their lane from real evidence only, with laneSource.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, resolveLaneCode } from '../server/providers-catalog.mjs';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const T0 = Date.UTC(2026, 10, 24, 12);
const MIN = 60_000;
const WT = (n) => `/home/x/.vibesquad/worktrees/EFI/${n}`;
const SHA = (c) => c.repeat(40);
const sec = (ms) => String(Math.round(ms / 1000));
const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const ev = (evs) => evs.map((e, i) => JSON.stringify({ seq: i, ...e }) + '\n').join('');
const worker = (ts, cwd, lane) => ev([
  { ts, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd, meta: { lane, role: 'worker', profile: 'Implement - Sonnet' } },
  { ts: ts + 1000, type: 'input', text: 'go' },
  { ts: ts + 5000, type: 'turn_done', costUsd: 1, usage: { inputTokens: 100, outputTokens: 10 } },
]);
const gitFor = (merges) => (args) => {
  if (args[0] === 'rev-parse') return `${SHA(merges[0].m)}\n`;
  if (args[0] === 'log') {
    if (args.includes('--numstat')) return '';
    const lines = [];
    merges.forEach((x, i) => {
      const parent = merges[i + 1] ? SHA(merges[i + 1].m) : 'root';
      lines.push(L(SHA(x.m), `${parent} ${SHA(x.b)}`, sec(x.ms), `Merge branch '${x.unit}'${x.tag ?? ''}`), L(SHA(x.b), parent, sec(x.ms - 1000), 'feat'));
    });
    lines.push(L('root', '', '0', 'init'));
    return lines.join('\n');
  }
  return '';
};

test('usa-61: laneSource per unit: subject > run > unit-prefix > ledger > none; no evidence stays unknown', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa61-'));
  tmpDirs.push(h);
  fs.mkdirSync(path.join(h, 'runner', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(h, 'runner', 'agents', 'rn-run.jsonl'), worker(T0, WT('unit-zzz-run'), 'bug'));
  fs.writeFileSync(path.join(h, 'runner', 'usage-ledger.jsonl'), JSON.stringify({ kind: 'unit', unit: 'unit-led', sha: SHA('d'), ts: new Date(T0).toISOString(), lane: 'ui' }) + '\n');
  const merges = [
    { m: 'a', b: 'e', unit: 'unit-tag', ms: T0 + 50 * MIN, tag: ' (@usa)' },
    { m: 'b', b: 'f', unit: 'unit-zzz-run', ms: T0 + 40 * MIN },
    { m: 'c', b: 'g', unit: 'unit-usa-77-x', ms: T0 + 30 * MIN },
    { m: 'd', b: 'h', unit: 'unit-led', ms: T0 + 20 * MIN },
    { m: 'i', b: 'j', unit: 'unit-nothing-9', ms: T0 + 10 * MIN },
  ];
  clearUsageCache();
  const u = getUsage({ home: h, git: gitFor(merges), laneCodes: { usa: 'usage', usage: 'usage', bug: 'bug' }, usageReview: { suppressSchedule: true } });
  const by = Object.fromEntries(u.merged.units.map((m) => [m.unit, m]));
  assert.deepEqual([by['unit-tag'].lane, by['unit-tag'].laneSource], ['usage', 'subject']);
  assert.deepEqual([by['unit-zzz-run'].lane, by['unit-zzz-run'].laneSource], ['bug', 'run']);
  assert.deepEqual([by['unit-usa-77-x'].lane, by['unit-usa-77-x'].laneSource], ['usage', 'unit-prefix']);
  assert.deepEqual([by['unit-led'].lane, by['unit-led'].laneSource], ['ui', 'ledger']);
  assert.deepEqual([by['unit-nothing-9'].lane, by['unit-nothing-9'].laneSource], [null, 'none']);
  const lanes = u.burstCohorts.byLane.map((r) => r.key);
  assert.ok(!lanes.includes('unit-prefix'));
  assert.equal(u.attributionCoverage.byLane.none?.total ?? 0, 1, 'only the no-evidence unit stays unlaned');
  assert.ok(u.attributionCoverage.byLane.usage.total >= 2);
});

const teamsJson = (h, repo) => fs.writeFileSync(path.join(h, 'teams.json'), JSON.stringify({ teams: [
  { id: 'alpha', paths: repo ? [repo] : [], lanes: [{ id: 'ui-bois', code: 'ui' }, { id: 'bug-chaser', code: 'bug' }] },
  { id: 'beta', paths: [], lanes: [{ id: 'ui', code: 'ui' }, { id: 'bug-runner', code: 'bug' }, { id: 'solo', code: 'sol' }] },
] }));

test('usa-61 regression: two Squads sharing a code -> unscoped lookup leaves ambiguous codes unknown, unique codes resolve', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa61b-'));
  tmpDirs.push(h);
  teamsJson(h, null);
  const merges = [
    { m: 'a', b: 'e', unit: 'unit-ui-thing', ms: T0 + 30 * MIN },
    { m: 'b', b: 'f', unit: 'unit-sol-thing', ms: T0 + 20 * MIN },
    { m: 'c', b: 'g', unit: 'unit-x', ms: T0 + 10 * MIN, tag: ' (@bug)' },
  ];
  clearUsageCache();
  const u = getUsage({ home: h, git: gitFor(merges), usageReview: { suppressSchedule: true } });
  const by = Object.fromEntries(u.merged.units.map((m) => [m.unit, m]));
  assert.deepEqual([by['unit-ui-thing'].lane, by['unit-ui-thing'].laneSource], [null, 'none'], 'ambiguous prefix is never guessed');
  assert.deepEqual([by['unit-sol-thing'].lane, by['unit-sol-thing'].laneSource], ['solo', 'unit-prefix'], 'unique code resolves');
  assert.equal(by['unit-x'].lane, null, 'ambiguous (@bug tag is not last-Squad-wins');
  assert.equal(by['unit-x'].laneSource, 'none');
});

test('usa-61 regression: scoped lookup resolves a shared code inside the repo Squads only (pooled path resolver)', () => {
  const codes = new Map();
  codes.byTeam = new Map([
    ['alpha', new Map([['ui', 'ui-bois'], ['ui-bois', 'ui-bois'], ['bug', 'bug-chaser']])],
    ['beta', new Map([['ui', 'ui'], ['bug', 'bug-runner'], ['sol', 'solo']])],
  ]);
  assert.deepEqual(resolveLaneCode(codes, 'ui', ['alpha']), { lane: 'ui-bois', elsewhere: true }, 'alpha repo: its own ui, beta noted as elsewhere');
  assert.deepEqual(resolveLaneCode(codes, 'ui', ['beta']), { lane: 'ui', elsewhere: true });
  assert.equal(resolveLaneCode(codes, 'ui', ['alpha', 'beta']).ambiguous, true, 'repo shared by both Squads: ambiguous, not last-wins');
  assert.equal(resolveLaneCode(codes, 'bug', null).ambiguous, true, 'unscoped + shared code: ambiguous');
  assert.equal(resolveLaneCode(codes, 'sol', ['alpha']).lane, null, 'a code only another Squad owns is not borrowed');
  assert.equal(resolveLaneCode(codes, 'sol', ['alpha']).elsewhere, true);
  assert.equal(resolveLaneCode(codes, 'sol', null).lane, 'solo', 'unique across all Squads resolves');
});
