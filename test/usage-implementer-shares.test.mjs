// usa-68 (idea-678): multi-implementer shares for one worktree. Harness copied from usa-60: per-unit review outcomes (reviewVerdicts / firstReviewVerdict /
// reviewSource) from the idea-883 sources (attested Squad-log done.verdict, reviewer runner record), fix rounds + fix profiles,
// byProfile fixRounds / fixPassRate, and "no verdict anywhere" = unknown (never first-try PASS). Synthetic temp homes only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa68-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const T0 = Date.UTC(2026, 10, 24, 12);
const MIN = 60_000;
const MAIN = '/home/x/projects/EFI';
const WT = (n) => `/home/x/.vibesquad/worktrees/EFI/${n}`;
const ev = (evs) => evs.map((e, i) => JSON.stringify({ seq: i, ...e }) + '\n').join('');
const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const sec = (ms) => String(Math.round(ms / 1000));
const SHA = (c) => c.repeat(40);

/** A worker run (implementer / fixer): created in its unit worktree, one costed turn. */
const worker = ({ ts, cwd, profile = 'Implement - Sonnet', labels = {}, cost = 1, provider = 'claude', model = 'claude-sonnet-5-5' }) => ev([
  { ts, type: 'created', provider, model, cwd, meta: { lane: 'usage', role: 'worker', profile, labels } },
  { ts: ts + 1000, type: 'input', text: 'do the thing' },
  { ts: ts + 5000, type: 'turn_done', costUsd: cost, usage: { inputTokens: 100, outputTokens: 10 } },
]);
/** A reviewer run: its last message carries verdict lines (one per entry). */
const reviewer = ({ ts, lines, cwd = MAIN }) => ev([
  { ts, type: 'created', provider: 'gemini', model: 'gemini-4-flash', cwd, meta: { lane: 'usage', role: 'worker', profile: 'Review - Gemini' } },
  { ts: ts + 1000, type: 'input', text: 'ROLE: reviewer\nreview it' },
  { ts: ts + 2000, type: 'output', text: lines.join('\n') + '\n' },
  { ts: ts + 3000, type: 'turn_done', costUsd: 0.1, usage: { inputTokens: 50, outputTokens: 5 } },
]);
function home(logs, teamLog = []) {
  const h = tmp();
  const dir = path.join(h, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, text] of Object.entries(logs)) fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  if (teamLog.length) {
    fs.mkdirSync(path.join(h, 'teams', 'efi'), { recursive: true });
    fs.writeFileSync(path.join(h, 'teams', 'efi', 'log.jsonl'), teamLog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return h;
}
/** merges: [{ m: merge sha char, b: branch commit sha char, unit, ms, subject? }], newest first. Branch commit subject carries no `review rN`. */
const gitFor = (merges) => (args) => {
  if (args[0] === 'rev-parse') return `${SHA(merges[0].m)}\n`;
  if (args[0] === 'log') {
    if (args.includes('--numstat')) return '';
    const lines = [];
    merges.forEach((x, i) => {
      const parent = merges[i + 1] ? SHA(merges[i + 1].m) : 'root';
      lines.push(L(SHA(x.m), `${parent} ${SHA(x.b)}`, sec(x.ms), x.subject ?? `Merge branch '${x.unit}' (@usa)`), L(SHA(x.b), parent, sec(x.ms - 1000), x.bsubject ?? 'feat (@usa)'));
    });
    lines.push(L('root', '', '0', 'init'));
    return lines.join('\n');
  }
  return '';
};
const usage = (h, merges) => { clearUsageCache(); return getUsage({ home: h, git: gitFor(merges), laneCodes: { usa: 'usage' }, usageReview: { suppressSchedule: true } }); };
const unitsOf = (u) => Object.fromEntries(u.merged.units.map((m) => [m.unit, m]));


const impls = (u) => u.byProfile.filter((p) => p.jobKind === 'implementer');
const sumUnits = (u) => impls(u).reduce((n, p) => n + p.mergedUnits, 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('usa-68: two profiles $3/$1 in one worktree -> earliest implementer, shares 0.75/0.25, byProfile units sum to 1, attributed', () => {
  const h = home({
    'rn-a': worker({ ts: T0, cwd: WT('unit-efi-1'), profile: 'Implement - Sonnet', cost: 3 }),
    'rn-b': worker({ ts: T0 + 5 * MIN, cwd: WT('unit-efi-1'), profile: 'Implement - Gemini', cost: 1, provider: 'gemini', model: 'gemini-4-pro' }),
  });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-1', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-1'];
  assert.equal(m.implementerAgentId, 'rn-a');
  assert.equal(m.attributionMiss, null);
  assert.deepEqual(m.implementerShares.map((s) => [s.agentId, s.profile, s.costUsd, s.share]), [['rn-a', 'Implement - Sonnet', 3, 0.75], ['rn-b', 'Implement - Gemini', 1, 0.25]]);
  close(m.costUsd, 4);
  close(sumUnits(u), 1);
  const by = Object.fromEntries(impls(u).map((p) => [p.provider, p]));
  close(by.claude.mergedUnits, 0.75);
  close(by.gemini.mergedUnits, 0.25);
  assert.equal(by.claude.firstTryKnown, 0, 'no review outcome known: not a first-try PASS');
});

test('usa-68: all $0 -> equal split', () => {
  const h = home({
    'rn-a': worker({ ts: T0, cwd: WT('unit-efi-2'), profile: 'Implement - Sonnet', cost: 0 }),
    'rn-b': worker({ ts: T0 + 5 * MIN, cwd: WT('unit-efi-2'), profile: 'Implement - Gemini', cost: 0, provider: 'gemini', model: 'gemini-4-pro' }),
  });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-2', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-2'];
  assert.deepEqual(m.implementerShares.map((s) => s.share), [0.5, 0.5]);
  close(sumUnits(u), 1);
});

test('usa-68: a spawn after the first FAIL is a fix round, not a share', () => {
  const h = home({
    'rn-a': worker({ ts: T0, cwd: WT('unit-efi-3'), profile: 'Implement - Sonnet', cost: 3 }),
    'rn-b': worker({ ts: T0 + 5 * MIN, cwd: WT('unit-efi-3'), profile: 'Implement - Gemini', cost: 1, provider: 'gemini', model: 'gemini-4-pro' }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`FAIL 1/0/0 ${SHA('b').slice(0, 8)}`] }),
    'rn-fix': worker({ ts: T0 + 15 * MIN, cwd: WT('unit-efi-3'), profile: 'Mechanical - DSF', cost: 4 }),
    'rn-r2': reviewer({ ts: T0 + 30 * MIN, lines: [`PASS 0/0/0 ${SHA('b').slice(0, 8)}`] }),
  });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-3', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-3'];
  assert.deepEqual(m.implementerShares.map((s) => s.agentId), ['rn-a', 'rn-b']);
  assert.deepEqual(m.implementerShares.map((s) => s.share), [0.75, 0.25]);
  assert.equal(m.fixRounds, 1);
  assert.equal(m.fixSpawns[0].agentId, 'rn-fix');
  close(sumUnits(u), 1);
});

test('usa-68: a single implementer is unchanged (no shares)', () => {
  const h = home({ 'rn-a': worker({ ts: T0, cwd: WT('unit-efi-4'), cost: 2 }) });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-4', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-4'];
  assert.equal(m.implementerAgentId, 'rn-a');
  assert.equal(m.implementerShares, undefined);
  close(m.costUsd, 2);
  close(sumUnits(u), 1);
});

// ---- usa-68 fix round: buildFloor, per-model/workflow/provider weighting, ledger round-trip
import { buildQualityByModel } from '../src/usageHelpers.ts';

const twoProfileHome = (unit) => home({
  'rn-a': worker({ ts: T0, cwd: WT(unit), profile: 'Implement - Sonnet', cost: 3 }),
  'rn-b': worker({ ts: T0 + 5 * MIN, cwd: WT(unit), profile: 'Implement - Gemini', cost: 1, provider: 'gemini', model: 'gemini-4-pro' }),
});

test('usa-68: buildFloor does not double count non-earliest share runs (rework unit: clean/rework/abandoned match one $4 implementer)', () => {
  const merge = (unit) => [{ m: 'a', b: 'b', unit, ms: T0 + 60 * MIN, bsubject: 'feat review r2 (@usa)' }];
  const split = usage(twoProfileHome('unit-efi-f1'), merge('unit-efi-f1'));
  const single = usage(home({ 'rn-s': worker({ ts: T0, cwd: WT('unit-efi-f2'), cost: 4 }) }), merge('unit-efi-f2'));
  assert.ok(unitsOf(split)['unit-efi-f1'].reviewRounds >= 2, 'fixture is a rework unit');
  close(split.floor.loopAndAbandonedCostUsd, 0);
  close(split.floor.reworkCostUsd, 4);
  close(split.floor.reworkCostUsd, single.floor.reworkCostUsd);
  close(split.floor.loopAndAbandonedCostUsd, single.floor.loopAndAbandonedCostUsd);
  close(split.floor.cleanCostUsd, single.floor.cleanCostUsd);
});

test('usa-68: per-model / workflow / provider-family units match byProfile fractional totals; each model bills its own spend', () => {
  const u = usage(twoProfileHome('unit-efi-w1'), [{ m: 'a', b: 'b', unit: 'unit-efi-w1', ms: T0 + 60 * MIN }]);
  const q = Object.fromEntries(buildQualityByModel(u.merged.units).map((r) => [r.model, r]));
  close(q['claude-sonnet-5-5'].units, 0.75);
  close(q['gemini-4-pro'].units, 0.25);
  close(q['claude-sonnet-5-5'].costUsd, 3);
  close(q['gemini-4-pro'].costUsd, 1);
  const byProf = Object.fromEntries(impls(u).map((p) => [p.model, p.mergedUnits]));
  for (const [model, units] of Object.entries(byProf)) close(q[model].units, units);
  close(u.byWorkflow.reduce((n, w) => n + w.units, 0), 1);
  close(u.byWorkflow.reduce((n, w) => n + w.costUsd, 0), 4);
  const modes = u.byWorkflow.filter((w) => w.units > 0);
  assert.equal(modes.length, 2, 'each share lands in its own workflow arm');
  const prov = Object.fromEntries(u.byProvider.map((p) => [p.provider, p.byFamily.reduce((n, f) => n + f.units, 0)]));
  close(prov.claude, 0.75);
  close(prov.gemini, 0.25);
  // L1: no float noise in fractional rollups
  for (const p of impls(u)) for (const f of p.byFamily) assert.equal(f.units, Math.round(f.units * 1e6) / 1e6);
});

test('usa-68: buildQualityByModel bills a cross-model unit per share (Opus $1.69 + Sonnet $50.53), whole units unchanged', () => {
  const rows = buildQualityByModel([
    { implementerModel: 'claude-opus-5-5', costUsd: 52.215, reviewSource: 'x', firstReviewVerdict: 'PASS', reviewRounds: 1,
      implementerShares: [{ model: 'claude-opus-5-5', costUsd: 1.687, share: 1.687 / 52.215 }, { model: 'claude-sonnet-5-5', costUsd: 50.528, share: 50.528 / 52.215 }] },
    { implementerModel: 'claude-opus-5-5', costUsd: 2, reviewRounds: 1 },
  ]);
  const q = Object.fromEntries(rows.map((r) => [r.model, r]));
  close(q['claude-opus-5-5'].costUsd, 3.687);
  close(q['claude-sonnet-5-5'].costUsd, 50.528);
  close(q['claude-opus-5-5'].units + q['claude-sonnet-5-5'].units, 2);
});

test('usa-68: ledger snapshot carries implementerShares and folds back; old rows fold without it', () => {
  const h = twoProfileHome('unit-efi-l1');
  usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-l1', ms: T0 + 60 * MIN }]);
  const file = path.join(h, 'runner', 'usage-ledger.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rec = rows.find((r) => r.kind === 'unit' && r.unit === 'unit-efi-l1');
  assert.equal(rec.implementerShares.length, 2);
  assert.equal(rec.implementerShares[1].model, 'gemini-4-pro');
  // old row (no shares) + the shares row, folded because the raw git log no longer lists them
  const oldRow = { kind: 'unit', sha: 'oldsha', unit: 'unit-old', ts: new Date(T0 - 9e6).toISOString(), lane: 'usage', reviewRounds: 1, costUsd: 2, implementerProfile: 'Implement - Sonnet', implementerProvider: 'claude', implementerModel: 'claude-sonnet-5-5' };
  fs.appendFileSync(file, JSON.stringify(oldRow) + '\n');
  const h2 = home({ 'rn-z': worker({ ts: T0, cwd: WT('unit-efi-l2'), cost: 1 }) });
  fs.mkdirSync(path.join(h2, 'runner'), { recursive: true });
  fs.copyFileSync(file, path.join(h2, 'runner', 'usage-ledger.jsonl'));
  const u = usage(h2, [{ m: 'c', b: 'd', unit: 'unit-efi-l2', ms: T0 + 60 * MIN }]);
  const folded = Object.fromEntries(u.merged.units.filter((m) => m.fromLedger).map((m) => [m.unit, m]));
  assert.equal(folded['unit-efi-l1'].implementerShares.length, 2);
  assert.equal(folded['unit-old'].implementerShares, undefined);
  const q = Object.fromEntries(buildQualityByModel(u.merged.units).map((r) => [r.model, r]));
  close(q['gemini-4-pro'].costUsd, 1);
});
