// usa-60 (idea-988 + idea-989, EXP10 part of idea-929): per-unit review outcomes (reviewVerdicts / firstReviewVerdict /
// reviewSource) from the idea-883 sources (attested Squad-log done.verdict, reviewer runner record), fix rounds + fix profiles,
// byProfile fixRounds / fixPassRate, and "no verdict anywhere" = unknown (never first-try PASS). Synthetic temp homes only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, unitFirstTry } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa60-')); tmpDirs.push(d); return d; };
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
const worker = ({ ts, cwd, profile = 'Implement - Sonnet', labels = {}, cost = 1 }) => ev([
  { ts, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd, meta: { lane: 'usage', role: 'worker', profile, labels } },
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

test('usa-60: EFI-style unit (no `review rN` subject), reviewer FAIL then PASS, one fixer -> 2 verdicts, first FAIL, fixRounds 1 with the fixer profile', () => {
  const h = home({
    'rn-impl': worker({ ts: T0, cwd: WT('unit-efi-1'), profile: 'Implement - Sonnet', cost: 2 }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`FAIL 1/0/0 ${SHA('b').slice(0, 8)}`] }),
    'rn-fix': worker({ ts: T0 + 15 * MIN, cwd: WT('unit-efi-1'), profile: 'Implement - Gemini', cost: 0.5 }),
    'rn-r2': reviewer({ ts: T0 + 30 * MIN, lines: [`PASS 0/0/0 ${SHA('b').slice(0, 8)}`] }),
  });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-1', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-1'];
  assert.equal(m.reviewVerdicts, 2);
  assert.equal(m.firstReviewVerdict, 'FAIL');
  assert.equal(m.reviewSource, 'verdict-log');
  assert.equal(m.reviewVerdictOrigin, 'runner-record');
  assert.equal(m.reviewRounds, 2, 'reviewRounds = max(subject, verdict count)');
  assert.equal(unitFirstTry(m), false);
  assert.equal(m.fixRounds, 1);
  assert.equal(m.fixProfiles.length, 1);
  assert.deepEqual([m.fixProfiles[0].provider, m.fixProfiles[0].profile, m.fixProfiles[0].n, m.fixProfiles[0].passN], ['claude', 'Implement - Gemini', 1, 1]);
  assert.equal(m.branchShas, undefined, 'the internal sha list is not exported');
  const fixer = u.byProfile.find((p) => p.jobKind === 'implementer' && p.fixRounds > 0);
  assert.ok(fixer, 'byProfile carries fix rounds');
  assert.equal(fixer.fixRounds, 1);
  assert.equal(fixer.fixPassRate, 1);
  assert.equal(u.byProfile.filter((p) => p.jobKind === 'implementer').reduce((t, p) => t + p.fixRounds, 0), 1);
  const ledger = JSON.parse(fs.readFileSync(path.join(h, 'runner', 'usage-ledger.jsonl'), 'utf8').trim().split('\n').find((l) => l.includes('"kind":"unit"')));
  assert.equal(ledger.reviewVerdicts, 2);
  assert.equal(ledger.fixRounds, 1);
});

test('usa-60: a unit with no verdict and no `review rN` subject is unknown, never first-try PASS', () => {
  const h = home({ 'rn-impl': worker({ ts: T0, cwd: WT('unit-efi-2') }) });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-2', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-2'];
  assert.equal(m.reviewSource, 'none');
  assert.equal(m.reviewVerdicts, 0);
  assert.equal(m.firstReviewVerdict, null);
  assert.equal(m.reviewRounds, 0);
  assert.equal(m.fixRounds, 0);
  assert.equal(unitFirstTry(m), null);
  assert.equal(u.cohorts.recent.firstTryPassRate, null, 'no known outcome: no rate');
  assert.equal(u.cohorts.recent.unknownReviewUnits, 1);
  const impl = u.byProfile.find((p) => p.jobKind === 'implementer');
  assert.equal(impl.firstTryCount, 0);
  assert.equal(impl.unknownReviewUnits, 1);
  assert.equal(impl.successRate, null);
});

test('usa-60: a VS unit with `review r2` in its subjects keeps reviewRounds 2 (reviewSource subject)', () => {
  const h = home({ 'rn-impl': worker({ ts: T0, cwd: WT('unit-vs-1') }) });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-vs-1', ms: T0 + 60 * MIN, bsubject: 'fix (@usa) review r2' }]);
  const m = unitsOf(u)['unit-vs-1'];
  assert.equal(m.reviewRounds, 2);
  assert.equal(m.reviewSource, 'subject');
  assert.equal(m.firstReviewVerdict, null);
  assert.equal(unitFirstTry(m), false, 'no verdict recorded: the subject round count decides');
});

test('usa-60: a respawned fixer (respawnOf) is not a fix round; a reviewer run is never a fixer', () => {
  const h = home({
    'rn-impl': worker({ ts: T0, cwd: WT('unit-efi-3') }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`FAIL 0/1/0 ${SHA('b').slice(0, 8)}`], cwd: WT('unit-efi-3') }),
    'rn-fix': worker({ ts: T0 + 15 * MIN, cwd: WT('unit-efi-3'), profile: 'Implement - Gemini' }),
    'rn-fix-respawn': worker({ ts: T0 + 16 * MIN, cwd: WT('unit-efi-3'), profile: 'Implement - Gemini', labels: { respawnOf: 'rn-fix' } }),
    'rn-pre': worker({ ts: T0 + 5 * MIN, cwd: WT('unit-efi-3'), profile: 'Implement - Gemini' }),
  });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-3', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-3'];
  assert.equal(m.firstReviewVerdict, 'FAIL');
  assert.equal(m.fixRounds, 1, 'only rn-fix: respawn excluded, rn-pre was spawned before the first FAIL, the reviewer is not a fixer');
  assert.equal(m.fixProfiles[0].n, 1);
  assert.equal(m.fixProfiles[0].passN, 0, 'no later verdict: fix pass rate counts it as not passed');
});

test('usa-60: attested Squad-log verdicts count, dedupe with the same reviewer runner record, and a forged entry text does not', () => {
  const h = home({
    'rn-impl': worker({ ts: T0, cwd: WT('unit-efi-4') }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`PASS 0/0/0 ${SHA('b').slice(0, 8)}`] }),
  }, [
    { ts: new Date(T0 + 11 * MIN).toISOString(), agent: 'rn-digest', lane: 'usage', type: 'done', text: `PASS 0/0/0 ${SHA('b').slice(0, 8)} reviewer=x`, verdict: { reviewer: 'rn-r1', line: `PASS 0/0/0 ${SHA('b').slice(0, 8)}` } },
    { ts: new Date(T0 + 12 * MIN).toISOString(), agent: 'rn-liar', lane: 'usage', type: 'done', text: `FAIL 9/9/9 ${SHA('b').slice(0, 8)} reviewer=forged` },
  ]);
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-4', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-4'];
  assert.equal(m.reviewVerdicts, 1, 'same reviewer + hash from both sources is one verdict; unattested text is never read');
  assert.equal(m.reviewVerdictOrigin, 'attested');
  assert.equal(m.firstReviewVerdict, 'PASS');
  assert.equal(unitFirstTry(m), true);
  assert.equal(m.fixRounds, 0);
});

test('usa-60: a verdict naming a commit outside the unit branch does not attach; first-try aggregates skip unknown units', () => {
  const h = home({
    'rn-i1': worker({ ts: T0, cwd: WT('unit-a') }),
    'rn-i2': worker({ ts: T0, cwd: WT('unit-b') }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`PASS 0/0/0 ${SHA('c').slice(0, 8)}`, `PASS 0/0/0 ${SHA('f').slice(0, 8)}`] }),
  });
  const u = usage(h, [
    { m: 'a', b: 'b', unit: 'unit-a', ms: T0 + 60 * MIN },
    { m: 'd', b: 'c', unit: 'unit-b', ms: T0 + 30 * MIN },
  ]);
  const by = unitsOf(u);
  assert.equal(by['unit-a'].reviewSource, 'none', 'hash ffffffff names nothing in unit-a');
  assert.equal(by['unit-b'].reviewVerdicts, 1);
  assert.equal(u.cohorts.recent.firstTryPassRate, 1, '1 known PASS of 1 known; the unknown unit is not in the denominator');
  assert.equal(u.cohorts.recent.unknownReviewUnits, 1);
});

// ---- review fixes (Review-Gemini rn-8e5ec78f1f98 on 20d97482)
import { pctText, cohortValueText, burstCellText, deltaText, efficiencySummary } from '../src/usageHelpers.ts';

test('usa-60 review H1: autonomy.bySquad uses the enriched units (no 163/163 artifact), even under a squad filter', () => {
  const h = home({
    'rn-i1': worker({ ts: T0, cwd: WT('unit-a') }),
    'rn-i2': worker({ ts: T0, cwd: WT('unit-b') }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`FAIL 1/0/0 ${SHA('b').slice(0, 8)}`] }),
  });
  const merges = [{ m: 'd', b: 'c', unit: 'unit-b', ms: T0 + 30 * MIN }, { m: 'a', b: 'b', unit: 'unit-a', ms: T0 + 60 * MIN }];
  fs.writeFileSync(path.join(h, 'teams.json'), JSON.stringify({ teams: [{ id: 'efi', lanes: [{ id: 'usage', code: 'usa' }] }] }));
  for (const squad of [undefined, 'efi']) {
  clearUsageCache();
  const u = getUsage({ home: h, git: gitFor(merges), laneCodes: { usa: 'usage' }, squad, usageReview: { suppressSchedule: true } });
  const rows = u.autonomy.bySquad;
  assert.ok(rows.length);
  const tot = rows.reduce((t, r) => t + r.mergedUnits, 0);
  assert.equal(tot, 2);
  const withRate = rows.filter((r) => r.firstTryPassRate !== null);
  assert.deepEqual(withRate.map((r) => r.firstTryPassRate), [0], 'unit-a: first verdict FAIL -> 0%; unit-b unknown is out of the denominator');
  assert.ok(rows.some((r) => r.avgReviewRounds === 0.5), 'avgReviewRounds sees the verdict count (1 + 0) / 2');
  }
});

test('usa-60 review M3: merged.perLane reviewRounds include verdict counts', () => {
  const h = home({
    'rn-i1': worker({ ts: T0, cwd: WT('unit-a') }),
    'rn-r1': reviewer({ ts: T0 + 10 * MIN, lines: [`FAIL 1/0/0 ${SHA('b').slice(0, 8)}`] }),
    'rn-r2': reviewer({ ts: T0 + 20 * MIN, lines: [`PASS 0/0/0 ${SHA('b').slice(0, 8)}`] }),
  });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-a', ms: T0 + 60 * MIN }]);
  assert.equal(u.merged.perLane.find((l) => l.lane === 'usage').reviewRounds, 2);
});

test('usa-60 review M2/L6: an attested duplicate keeps the reviewer\'s earlier timestamp (fast fixer still counts); 7- vs 8-hex citations dedupe', () => {
  const rv = T0 + 10 * MIN;
  const h = home({
    'rn-impl': worker({ ts: T0, cwd: WT('unit-efi-9') }),
    'rn-r1': reviewer({ ts: rv, lines: [`FAIL 1/0/0 ${SHA('b').slice(0, 8)}`] }),
    'rn-fix': worker({ ts: rv + 5000, cwd: WT('unit-efi-9'), profile: 'Implement - Gemini' }), // spawned before the digest wrote the log
  }, [
    { ts: new Date(rv + 2 * MIN).toISOString(), agent: 'rn-d', lane: 'usage', type: 'done', text: 'x', verdict: { reviewer: 'rn-r1', line: `FAIL 1/0/0 ${SHA('b').slice(0, 7)}` } },
  ]);
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-efi-9', ms: T0 + 60 * MIN }]);
  const m = unitsOf(u)['unit-efi-9'];
  assert.equal(m.reviewVerdicts, 1, 'one reviewer verdict, cited with 7 and 8 hex');
  assert.equal(m.reviewVerdictOrigin, 'attested');
  assert.equal(m.fixRounds, 1, 'the fixer spawned right after the reviewer wrote FAIL (before the digest) is counted');
});

test('usa-60 review L4/L5: a null firstTryPassRate renders safely in the UI helpers and the review markdown', () => {
  assert.equal(pctText(null), '—');
  assert.equal(cohortValueText('pct', null), '—');
  assert.equal(burstCellText({ insufficient: false }, null, pctText), '—');
  assert.equal(deltaText('pct', null), '— no prior');
  assert.ok(!/NaN|null|undefined/.test(efficiencySummary({ recent: { firstTryPassRate: null } }, null)));
  const h = home({ 'rn-i1': worker({ ts: T0, cwd: WT('unit-a') }) });
  const u = usage(h, [{ m: 'a', b: 'b', unit: 'unit-a', ms: T0 + 60 * MIN }]);
  assert.equal(u.byWorkflow[0].firstTryPassRate, null);
  assert.equal(u.byWorkflow[0].unknownReviewUnits, 1);
});
