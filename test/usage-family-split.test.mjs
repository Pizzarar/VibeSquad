// usa-65 (idea-1063): quota family split from vs.route (`family=<f>`) across agentV2, merged units, byProvider, byProfile, byWorkflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearUsageCache, getUsage, mergeSubjectBranch, parseRouteFamily, usageTestHooks } from '../server/providers-catalog.mjs';
import './helpers/keep-alive.mjs';

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'vs-usa65-'));
  mkdirSync(join(dir, 'runner', 'agents'), { recursive: true });
  return dir;
}

function writeLog(home, id, events) {
  writeFileSync(join(home, 'runner', 'agents', `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function fakeGit(commits) {
  // commits: [{ sha, ts, subject }] in chronological order; newest first for git log, chained via first-parent.
  const rev = [...commits].reverse();
  const lines = rev.map((c, i) => {
    const p1 = rev[i + 1]?.sha ?? '0000000';
    const p2 = `side${i}`;
    const ct = Math.floor(Date.parse(c.ts) / 1000);
    return `${c.sha}\x1f${p1} ${p2}\x1f${ct}\x1f${c.subject}`;
  });
  return (args) => {
    if (args[0] === 'rev-parse') return rev[0]?.sha ?? '0000000';
    if (args[0] === 'log' && args.includes('--numstat')) return '';
    if (args[0] === 'log') return lines.join('\n') + '\n';
    return '';
  };
}

test('parseRouteFamily: present, empty, absent, and odd values', () => {
  assert.equal(parseRouteFamily('stakes=normal model=claude-sonnet-5-5 effort=medium reason=default tier=t2 role=implement family=agy-claude'), 'agy-claude');
  assert.equal(parseRouteFamily('stakes=normal model=claude-sonnet-5-5 effort=medium reason=failover tier=t2 role=implement family=claude'), 'claude');
  assert.equal(parseRouteFamily('stakes=normal model=pistol effort=medium reason=default family=pistol'), 'pistol');
  // Odd non-empty values are kept verbatim (no guessing).
  assert.equal(parseRouteFamily('stakes=normal model=claude-sonnet-5-5 effort=medium reason=default family=8'), '8');
  assert.equal(parseRouteFamily('family=weird_fam-2'), 'weird_fam-2');
  // Empty values are treated as absent.
  assert.equal(parseRouteFamily('stakes=normal model=claude-sonnet-5-5 family='), null);
  assert.equal(parseRouteFamily('stakes=normal family= reason=default'), null);
  // Absent / non-string.
  assert.equal(parseRouteFamily('stakes=normal model=claude-sonnet-5-5 effort=medium reason=default'), null);
  assert.equal(parseRouteFamily(''), null);
  assert.equal(parseRouteFamily(undefined), null);
  assert.equal(parseRouteFamily(null), null);
});

test('agentV2 exposes family from vs.route and preserves it across unrelated meta patches', () => {
  const { foldEvent, agentV2 } = usageTestHooks;
  const fresh = () => ({ provider: 'claude', model: 'claude-sonnet-5-5', lane: 'usage', role: 'worker', prevCost: 0, turns: 0, workingMs: 0, buckets: new Map() });

  const s1 = fresh();
  foldEvent(s1, { type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'antigravity-cli', model: 'claude-sonnet-5-5', meta: { role: 'worker', labels: { 'vs.route': 'stakes=normal model=claude-sonnet-5-5 family=agy-claude' } } });
  foldEvent(s1, { type: 'meta', ts: '2026-11-25T10:01:00Z', patch: { labels: { extra: '1' } } });
  assert.equal(agentV2(s1, 'a1').family, 'agy-claude');

  const sEmpty = fresh();
  foldEvent(sEmpty, { type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5', meta: { role: 'worker', labels: { 'vs.route': 'stakes=normal family=' } } });
  assert.equal(agentV2(sEmpty, 'a2').family, null);

  const sAbsent = fresh();
  foldEvent(sAbsent, { type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5', meta: { role: 'worker', labels: { 'vs.route': 'stakes=normal' } } });
  assert.equal(agentV2(sAbsent, 'a3').family, null);

  const sOdd = fresh();
  foldEvent(sOdd, { type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5', meta: { role: 'worker', labels: { 'vs.route': 'stakes=normal family=8' } } });
  assert.equal(agentV2(sOdd, 'a4').family, '8');
});

test('sonnet arm splits agy-claude ($0), claude (paid), unlabeled (pre-R10), and odd family honestly while keeping existing shape backward compatible', () => {
  clearUsageCache();
  const home = makeHome();
  try {
    // 1. agy-claude $0 run inside sonnet arm (first-try PASS: review r1)
    writeLog(home, 'ag-agy', [
      {
        type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'antigravity-cli', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-a1',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 effort=medium reason=default tier=t2 role=implement family=agy-claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T10:02:00Z', costUsd: 0 },
      { type: 'turn_done', ts: '2026-11-25T10:04:00Z', costUsd: 0 },
    ]);

    // 2. claude-family paid run inside sonnet arm (first-try PASS: review r1)
    writeLog(home, 'ag-claude', [
      {
        type: 'created', ts: '2026-11-25T11:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-a2',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 effort=medium reason=failover tier=t2 role=implement family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T11:02:00Z', costUsd: 1.0 },
      { type: 'turn_done', ts: '2026-11-25T11:04:00Z', costUsd: 2.5 },
      { type: 'turn_done', ts: '2026-11-25T11:05:00Z', costUsd: 2.5 },
    ]);

    // 3. pre-R10 unlabeled run inside sonnet arm (2 review rounds -> not first-try PASS)
    writeLog(home, 'ag-old', [
      {
        type: 'created', ts: '2026-11-25T12:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-a3',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 effort=medium reason=default' } },
      },
      { type: 'turn_done', ts: '2026-11-25T12:03:00Z', costUsd: 1.5 },
    ]);

    // 4. odd family=8 run inside sonnet arm (first-try PASS: review r1)
    writeLog(home, 'ag-odd', [
      {
        type: 'created', ts: '2026-11-25T13:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-a4',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 family=8' } },
      },
      { type: 'turn_done', ts: '2026-11-25T13:03:00Z', costUsd: 2.0 },
    ]);

    const git = fakeGit([
      { sha: 'aaaa111', ts: '2026-11-25T10:10:00Z', subject: "Merge branch 'unit-usa-a1' (review r1, @usa)" },
      { sha: 'aaaa222', ts: '2026-11-25T11:10:00Z', subject: "Merge branch 'unit-usa-a2' (review r1, @usa)" },
      { sha: 'aaaa333', ts: '2026-11-25T12:10:00Z', subject: "Merge branch 'unit-usa-a3' (review r2, @usa)" },
      { sha: 'aaaa444', ts: '2026-11-25T13:10:00Z', subject: "Merge branch 'unit-usa-a4' (review r1, @usa)" },
    ]);

    const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });

    // Merged unit rows expose implementerFamily
    const byUnit = Object.fromEntries(u.merged.units.map((m) => [m.unit, m]));
    assert.equal(byUnit['unit-usa-a1'].implementerFamily, 'agy-claude');
    assert.equal(byUnit['unit-usa-a2'].implementerFamily, 'claude');
    assert.equal(byUnit['unit-usa-a3'].implementerFamily, null);
    assert.equal(byUnit['unit-usa-a4'].implementerFamily, '8');

    // byWorkflow: single backward-compatible 'sonnet' arm row + byFamily sub-breakdown
    assert.equal(u.byWorkflow.length, 1);
    const sonnet = u.byWorkflow.find((w) => w.workflowMode === 'sonnet');
    assert.ok(sonnet);
    assert.equal(sonnet.units, 4);
    assert.equal(sonnet.costUsd, 6.0);
    assert.equal(sonnet.costPerUnit, 1.5);
    assert.equal(sonnet.firstTryPassRate, 0.75);

    const wfFam = Object.fromEntries(sonnet.byFamily.map((f) => [f.family, f]));
    assert.deepEqual(Object.keys(wfFam).sort(), ['8', 'agy-claude', 'claude', 'unlabeled']);
    assert.deepEqual(wfFam['agy-claude'], {
      family: 'agy-claude', units: 1, turns: 2, costUsd: 0, costPerUnit: 0,
      firstTryPassCount: 1, firstTryKnown: 1, firstTryPassRate: 1,
    });
    assert.deepEqual(wfFam['claude'], {
      family: 'claude', units: 1, turns: 3, costUsd: 2.5, costPerUnit: 2.5,
      firstTryPassCount: 1, firstTryKnown: 1, firstTryPassRate: 1,
    });
    assert.deepEqual(wfFam['unlabeled'], {
      family: 'unlabeled', units: 1, turns: 1, costUsd: 1.5, costPerUnit: 1.5,
      firstTryPassCount: 0, firstTryKnown: 1, firstTryPassRate: 0,
    });
    assert.deepEqual(wfFam['8'], {
      family: '8', units: 1, turns: 1, costUsd: 2.0, costPerUnit: 2.0,
      firstTryPassCount: 1, firstTryKnown: 1, firstTryPassRate: 1,
    });

    // byProfile: existing (provider, model, stakes, jobKind) rows unchanged + byFamily breakdown
    const claudeProfile = u.byProfile.find((p) => p.provider === 'claude' && p.model === 'claude-sonnet-5-5' && p.jobKind === 'implementer');
    assert.ok(claudeProfile);
    assert.equal(claudeProfile.runs, 3);
    assert.equal(claudeProfile.mergedUnits, 3);
    assert.equal(claudeProfile.costUsd, 6.0);
    const cpFam = Object.fromEntries(claudeProfile.byFamily.map((f) => [f.family, f]));
    assert.deepEqual(Object.keys(cpFam).sort(), ['8', 'claude', 'unlabeled']);
    assert.equal(cpFam['claude'].costPerUnit, 2.5);
    assert.equal(cpFam['claude'].firstTryPassRate, 1);
    assert.equal(cpFam['unlabeled'].costPerUnit, 1.5);
    assert.equal(cpFam['unlabeled'].firstTryPassRate, 0);
    assert.equal(cpFam['8'].costPerUnit, 2.0);

    const agyProfile = u.byProfile.find((p) => p.provider === 'antigravity-cli' && p.model === 'claude-sonnet-5-5' && p.jobKind === 'implementer');
    assert.ok(agyProfile);
    assert.equal(agyProfile.byFamily.length, 1);
    assert.equal(agyProfile.byFamily[0].family, 'agy-claude');
    assert.equal(agyProfile.byFamily[0].costUsd, 0);
    assert.equal(agyProfile.byFamily[0].costPerUnit, 0);
    assert.equal(agyProfile.byFamily[0].firstTryPassRate, 1);

    // byProvider: existing provider rows unchanged + byFamily breakdown
    const claudeProv = u.byProvider.find((p) => p.provider === 'claude');
    assert.ok(claudeProv);
    assert.equal(claudeProv.costUsd, 6.0);
    assert.equal(claudeProv.turns, 5);
    const provFam = Object.fromEntries(claudeProv.byFamily.map((f) => [f.family, f]));
    assert.deepEqual(Object.keys(provFam).sort(), ['8', 'claude', 'unlabeled']);
    assert.equal(provFam['claude'].turns, 3);
    assert.equal(provFam['claude'].units, 1);
    assert.equal(provFam['claude'].costPerUnit, 2.5);
    assert.equal(provFam['unlabeled'].turns, 1);
    assert.equal(provFam['unlabeled'].firstTryPassRate, 0);

    const agyProv = u.byProvider.find((p) => p.provider === 'antigravity-cli');
    assert.ok(agyProv);
    assert.equal(agyProv.turns, 2);
    assert.equal(agyProv.costUsd, 0);
    assert.equal(agyProv.byFamily.length, 1);
    assert.equal(agyProv.byFamily[0].family, 'agy-claude');
    assert.equal(agyProv.byFamily[0].units, 1);
    assert.equal(agyProv.byFamily[0].implementerCostUsd, 0);
    assert.equal(agyProv.byFamily[0].costPerUnit, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    clearUsageCache();
  }
});

test('byProvider.byFamily.costPerUnit excludes lead/Buddy/reviewer spend via implementerCostUsd', () => {
  clearUsageCache();
  const home = makeHome();
  try {
    // 1 implementer run ($2.50) + 1 lead ($10.00) + 1 Buddy ($4.00) + 1 reviewer ($1.50), all family=claude
    writeLog(home, 'ag-impl', [
      {
        type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-m1',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T10:02:00Z', costUsd: 2.5 },
    ]);
    writeLog(home, 'ag-lead', [
      {
        type: 'created', ts: '2026-11-25T09:00:00Z', provider: 'claude', model: 'claude-opus-5-5',
        cwd: '/tmp/repo',
        meta: { role: 'lead', lane: 'usage', profile: 'Lead', labels: { 'vs.route': 'stakes=normal model=claude-opus-5-5 family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T09:10:00Z', costUsd: 10.0 },
    ]);
    writeLog(home, 'ag-buddy', [
      {
        type: 'created', ts: '2026-11-25T09:05:00Z', provider: 'claude', model: 'claude-opus-5-5',
        cwd: '/tmp/repo',
        meta: { role: 'brainstorm', lane: 'usage', profile: 'Brainstorm', labels: { 'vs.route': 'stakes=normal model=claude-opus-5-5 family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T09:15:00Z', costUsd: 4.0 },
    ]);
    writeLog(home, 'ag-rev', [
      {
        type: 'created', ts: '2026-11-25T10:05:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-m1',
        meta: { role: 'worker', lane: 'usage', profile: 'Review', labels: { 'vs.route': 'stakes=normal model=claude-sonnet-5-5 family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T10:06:00Z', costUsd: 1.5 },
    ]);

    const git = fakeGit([
      { sha: 'bbbb111', ts: '2026-11-25T10:10:00Z', subject: "Merge branch 'unit-usa-m1' (review r1, @usa)" },
    ]);
    const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
    const claudeProv = u.byProvider.find((p) => p.provider === 'claude');
    assert.ok(claudeProv);
    assert.equal(claudeProv.costUsd, 18.0);
    const fam = claudeProv.byFamily.find((f) => f.family === 'claude');
    assert.ok(fam);
    assert.equal(fam.runs, 4);
    assert.equal(fam.units, 1);
    assert.equal(fam.costUsd, 18.0, 'provider family costUsd sums all roles to match parent byProvider');
    assert.equal(fam.implementerCostUsd, 2.5, 'implementerCostUsd isolates implementer spend');
    assert.equal(fam.costPerUnit, 2.5, 'costPerUnit divides implementerCostUsd, not lead/Buddy/reviewer spend');
  } finally {
    rmSync(home, { recursive: true, force: true });
    clearUsageCache();
  }
});

test('byProvider.byFamily keeps runs/cost and merged units/firstTry in the same [since, until] day window', () => {
  clearUsageCache();
  const home = makeHome();
  try {
    // Day 1 (2026-11-20): $1.00, 2 review rounds (not first-try PASS)
    writeLog(home, 'ag-d1', [
      {
        type: 'created', ts: '2026-11-20T10:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-d1',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-20T10:05:00Z', costUsd: 1.0 },
    ]);
    // Day 2 (2026-11-25): $3.00, 1 review round (first-try PASS)
    writeLog(home, 'ag-d2', [
      {
        type: 'created', ts: '2026-11-25T10:00:00Z', provider: 'claude', model: 'claude-sonnet-5-5',
        cwd: '/tmp/wt/unit-usa-d2',
        meta: { role: 'worker', lane: 'usage', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5 family=claude' } },
      },
      { type: 'turn_done', ts: '2026-11-25T10:05:00Z', costUsd: 3.0 },
    ]);

    const git = fakeGit([
      { sha: 'cccc111', ts: '2026-11-20T10:10:00Z', subject: "Merge branch 'unit-usa-d1' (review r2, @usa)" },
      { sha: 'cccc222', ts: '2026-11-25T10:10:00Z', subject: "Merge branch 'unit-usa-d2' (review r1, @usa)" },
    ]);

    const u = getUsage({ home, git, laneCodes: { usa: 'usage' }, since: '2026-11-25', until: '2026-11-25' });
    const claudeProv = u.byProvider.find((p) => p.provider === 'claude');
    assert.ok(claudeProv);
    assert.equal(claudeProv.costUsd, 3.0);
    const fam = claudeProv.byFamily.find((f) => f.family === 'claude');
    assert.ok(fam);
    assert.equal(fam.runs, 1);
    assert.equal(fam.units, 1, 'only the 2026-11-25 merged unit is counted');
    assert.equal(fam.costUsd, 3.0);
    assert.equal(fam.implementerCostUsd, 3.0);
    assert.equal(fam.costPerUnit, 3.0);
    assert.equal(fam.firstTryPassCount, 1);
    assert.equal(fam.firstTryKnown, 1);
    assert.equal(fam.firstTryPassRate, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    clearUsageCache();
  }
});

test('mergeSubjectBranch parses hand-typed hyphenated unit slugs (e.g. Merge hub-relay-rule: ...) and attributes agy-claude', () => {
  assert.equal(mergeSubjectBranch('Merge hub-relay-rule: team rule R18 (@vibesquad)'), 'hub-relay-rule');
  assert.equal(mergeSubjectBranch('Merge desk-u2-history-races (incl. U1 desk-u1-url-keys): URL slot key'), 'desk-u2-history-races');
  assert.equal(mergeSubjectBranch('Merge sf-m2 into sf-m3'), null);
  assert.equal(mergeSubjectBranch('Merge fix: single word not a hyphen slug'), null);

  clearUsageCache();
  const home = makeHome();
  try {
    writeLog(home, 'ag-hub', [
      {
        type: 'created', ts: '2026-11-25T22:06:55Z', provider: 'antigravity-cli', model: 'claude-sonnet-5-5-medium',
        cwd: '/home/user/.vibesquad/worktrees/VibeSquad/hub-relay-rule',
        meta: { role: 'worker', lane: 'vibesquad', profile: 'Implement', labels: { wf: 'sonnet', 'vs.route': 'stakes=normal model=claude-sonnet-5-5-medium effort=medium reason=default tier=mid role=implement family=agy-claude why=arm' } },
      },
      { type: 'turn_done', ts: '2026-11-25T22:08:00Z', costUsd: 0 },
    ]);
    const git = fakeGit([
      { sha: '1bb07d0c', ts: '2026-11-25T22:10:38Z', subject: 'Merge hub-relay-rule: team rule R18 (@vibesquad; review r1)' },
    ]);
    const u = getUsage({ home, git, laneCodes: { vibesquad: 'vibesquad' } });
    const hub = u.merged.units.find((m) => m.sha === '1bb07d0c');
    assert.ok(hub);
    assert.equal(hub.unit, 'hub-relay-rule');
    assert.equal(hub.implementerFamily, 'agy-claude');
    assert.equal(hub.workflowMode, 'sonnet');
  } finally {
    rmSync(home, { recursive: true, force: true });
    clearUsageCache();
  }
});
