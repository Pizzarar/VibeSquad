// usa-44: implementers that ran in the MAIN checkout (cwd is not a unit worktree) are tied to their merged unit by explicit evidence
// in their own log (labels.unit > the work order's assigned unit > the unique most-worked unit), folded during the normal event fold.
// Synthetic logs in temp dirs only. Real data is never read.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, usageTestHooks } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa44-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const T0 = Date.UTC(2026, 10, 20, 12);
const MAIN = 'C:\\Users\\x\\projects\\VibeSquad';
const ev = (evs) => evs.map((e, i) => JSON.stringify({ seq: i, ...e }) + '\n').join('');
const bash = (ts, command) => ({ ts, type: 'tool', phase: 'call', id: `t${ts}`, name: 'Bash', input: { command } });
const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const sec = (ms) => String(Math.round(ms / 1000));

/** One main-checkout implementer run: created in the main checkout, given a work order, then tool calls, then one costed turn. */
function mainRun({ ts = T0, cost = 1, labels = {}, input = 'do the thing', tools = [], cwd = MAIN, profile = 'Implement - Sonnet', turns = 1 }) {
  const evs = [
    { ts, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd, meta: { lane: 'usage', role: 'worker', profile, labels: { wf: 'sonnet', ...labels } } },
    { ts: ts + 1000, type: 'input', text: input },
    ...tools.map((c, i) => bash(ts + 2000 + i, c)),
  ];
  for (let i = 0; i < turns; i++) evs.push({ ts: ts + 5000 + i, type: 'turn_done', costUsd: cost * (i + 1) / turns, usage: { inputTokens: 100, outputTokens: 10 } });
  return ev(evs);
}
function home(logs) {
  const h = tmp();
  const dir = path.join(h, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, text] of Object.entries(logs)) fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  return h;
}
const gitFor = (merges) => (args) => {
  if (args[0] === 'rev-parse') return `${merges[0][0]}\n`;
  if (args[0] === 'log') {
    const lines = [];
    merges.forEach(([sha, subject, ms], i) => {
      const parent = merges[i + 1]?.[0] ?? 'root';
      lines.push(L(sha, `${parent} b${sha}`, sec(ms), subject), L(`b${sha}`, parent, sec(ms - 1000), 'feat (@usa)'));
    });
    lines.push(L('root', '', '0', 'init'));
    return lines.join('\n');
  }
  return '';
};
const usage = (h, merges) => { clearUsageCache(); return getUsage({ home: h, git: gitFor(merges), laneCodes: { usa: 'usage' }, usageReview: { suppressSchedule: true } }); };
const unitsOf = (u) => Object.fromEntries(u.merged.units.map((m) => [m.sha, m]));
const merge = (sha, unit, ms) => [sha, `Merge branch '${unit}' (@usa)`, ms];

test('usa-44 signal 1: labels.unit on a main-checkout run attributes it (cwd is not a worktree)', () => {
  const h = home({ 'rn-a': mainRun({ cost: 2, labels: { unit: 'unit-alpha' } }) });
  const u = unitsOf(usage(h, [merge('m1', 'unit-alpha', T0 + 3_600_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-a');
  assert.equal(u.m1.costUsd, 2);
});

test('usa-44 signal 2: the work order assigns the unit (`vs worktree create` / `branch unit-x`)', () => {
  const h = home({
    'rn-a': mainRun({ cost: 3, input: 'Work in your own worktree: `vs worktree create unit-beta`. Then do it.' }),
    'rn-b': mainRun({ ts: T0 + 10_000, cost: 4, input: 'Fix it on branch `unit-gamma` please.' }),
  });
  const u = unitsOf(usage(h, [merge('m1', 'unit-beta', T0 + 3_600_000), merge('m2', 'unit-gamma', T0 + 3_700_000)]));
  assert.deepEqual([u.m1.implementerAgentId, u.m1.costUsd], ['rn-a', 3]);
  assert.deepEqual([u.m2.implementerAgentId, u.m2.costUsd], ['rn-b', 4]);
});

test('usa-44 signal 3: the run\'s own tool calls enter the unit worktree (cd .../worktrees/<repo>/<unit>, git checkout -b)', () => {
  const wt = 'cd /c/Users/x/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-delta';
  const h = home({
    'rn-a': mainRun({ cost: 5, tools: [`${wt} && git status`, `${wt} && npm test`, 'ls'] }),
    'rn-b': mainRun({ ts: T0 + 10_000, cost: 6, tools: ['git checkout -b unit-eps', 'git switch unit-eps'] }),
  });
  const u = unitsOf(usage(h, [merge('m1', 'unit-delta', T0 + 3_600_000), merge('m2', 'unit-eps', T0 + 3_700_000)]));
  assert.deepEqual([u.m1.implementerAgentId, u.m1.costUsd], ['rn-a', 5]);
  assert.deepEqual([u.m2.implementerAgentId, u.m2.costUsd], ['rn-b', 6]);
});

test('usa-44 no double count: a run that spread over several units, or only brushed one, attributes to none', () => {
  const cdA = 'cd /w/worktrees/VibeSquad/unit-one && git log';
  const cdB = 'cd /w/worktrees/VibeSquad/unit-two && git log';
  const h = home({
    // two assigned units in the work order -> ambiguous
    'rn-multi': mainRun({ cost: 7, input: 'Do `vs worktree create unit-one` then `vs worktree create unit-two`.' }),
    // tool calls: one unit once only (< 2 calls) and a tie -> no primary
    'rn-tie': mainRun({ ts: T0 + 10_000, cost: 8, tools: [cdA, cdB] }),
  });
  const u = unitsOf(usage(h, [merge('m1', 'unit-one', T0 + 3_600_000), merge('m2', 'unit-two', T0 + 3_700_000)]));
  assert.equal(u.m1.implementerAgentId, null);
  assert.equal(u.m2.implementerAgentId, null);
  assert.equal(u.m1.costUsd, null);
});

test('usa-44 no double count: one run is never credited to two units, and a unit name merged twice credits its earliest merge only', () => {
  // a second lane implementer keeps the legacy single-worker-in-lane fallback out of this test
  const h = home({ 'rn-a': mainRun({ cost: 9, labels: { unit: 'unit-twice' } }), 'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }) });
  const u = unitsOf(usage(h, [merge('m2', 'unit-twice', T0 + 7_200_000), merge('m1', 'unit-twice', T0 + 3_600_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-a', 'earliest merge');
  assert.equal(u.m2.implementerAgentId, null, 'later merge of the same branch name');
  const credited = Object.values(u).filter((m) => m.implementerAgentId === 'rn-a').length;
  assert.equal(credited, 1);
});

test('usa-44 precedence: a worktree-cwd implementer wins over main-checkout evidence; reviewers and digests never count', () => {
  const wtRun = ev([
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: '/wt/VibeSquad/unit-zeta', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet', labels: { wf: 'sonnet' } } },
    { ts: T0 + 5000, type: 'turn_done', costUsd: 1, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const h = home({
    'rn-wt': wtRun,
    'rn-main': mainRun({ ts: T0 + 10_000, cost: 50, labels: { unit: 'unit-zeta' } }),
    'rn-rev': mainRun({ ts: T0 + 20_000, cost: 60, profile: 'Review - Gemini', labels: { unit: 'unit-eta' } }),
  });
  const u = unitsOf(usage(h, [merge('m1', 'unit-zeta', T0 + 3_600_000), merge('m2', 'unit-eta', T0 + 3_700_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-wt');
  assert.equal(u.m1.costUsd, 1);
  assert.equal(u.m2.implementerAgentId, null, 'a reviewer is not an implementer');
});

test('usa-44 zero-turn runs in a worktree no longer shadow the run that spent (same unit, one profile)', () => {
  const run = (cwd, ts, turns) => ev([
    { ts, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd, meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet', labels: { wf: 'sonnet' } } },
    ...(turns ? [{ ts: ts + 5000, type: 'turn_done', costUsd: 2, usage: { inputTokens: 1, outputTokens: 1 } }] : [{ ts: ts + 5000, type: 'error', message: 'boom' }]),
  ]);
  const h = home({ 'rn-dead': run('/wt/VibeSquad/unit-theta', T0, 0), 'rn-live': run('/wt/VibeSquad/unit-theta', T0 + 60_000, 1) });
  const u = unitsOf(usage(h, [merge('m1', 'unit-theta', T0 + 3_600_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-live');
  assert.equal(u.m1.costUsd, 2);
});

test('usa-44 "Merge unit-<name>:" subjects (no quoted branch) still name the unit', () => {
  const h = home({ 'rn-a': mainRun({ cost: 4, labels: { unit: 'unit-iota-352' } }) });
  const u = unitsOf(usage(h, [['m1', 'Merge unit-iota-352: idea-352 worker final auto-forward (@usa)', T0 + 3_600_000]]));
  assert.equal(u.m1.unit, 'unit-iota-352');
  assert.equal(u.m1.implementerAgentId, 'rn-a');
});

test('usa-44 fold is bounded and cheap: only main-checkout workers record refs, capped', () => {
  const tools = Array.from({ length: 40 }, (_, i) => `cd /w/worktrees/VibeSquad/unit-n${i} && ls`);
  const h = home({ 'rn-many': mainRun({ tools }), 'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }) }); // decoy: no lane-fallback guess
  const u = unitsOf(usage(h, [merge('m1', 'unit-n3', T0 + 3_600_000)]));
  assert.equal(u.m1.implementerAgentId, null);
  assert.equal(typeof usageTestHooks.attributeImplementer, 'function');
});

// ---- usa-44 R1 (Review-Gemini FAIL 0/3/2 679c09fe)
test('usa-44 R1 M1: a follow-up run spawned after the first merge is credited to the later merge, not the earlier one', () => {
  const h = home({
    'rn-1': mainRun({ ts: T0, cost: 1, labels: { unit: 'unit-foo' } }),
    'rn-2': mainRun({ ts: T0 + 10_000_000, cost: 2, labels: { unit: 'unit-foo' } }),
  });
  const u = unitsOf(usage(h, [merge('m2', 'unit-foo', T0 + 20_000_000), merge('m1', 'unit-foo', T0 + 3_600_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-1', 'the run that existed at the first merge');
  assert.equal(u.m2.implementerAgentId, 'rn-2', 'the follow-up run, created after the first merge');
});

test('usa-44 R1 M1: a same-named unit in another Squad does not claim the earlier merge', () => {
  const idx = usageTestHooks.attributeImplementer;
  const agent = { agentId: 'rn-x', role: 'worker', profile: 'Implement - Sonnet', provider: 'claude', turns: 1, createdAt: T0, cwd: MAIN, lane: 'l', team: null, unitRef: 'unit-dup' };
  const index = { byUnit: new Map(), byLane: new Map(), byRef: new Map([['unit-dup', [agent]]]), mergesByName: new Map([['a|unit-dup', [{ ms: T0 + 1, sha: 'sa' }]], ['b|unit-dup', [{ ms: T0 + 2, sha: 'sb' }]]]), mergedNames: new Set(['unit-dup']) };
  assert.equal(idx({ unit: 'unit-dup', sha: 'sb', squad: 'b', mergedAt: new Date(T0 + 2).toISOString(), lane: null }, [agent], index), agent, 'Squad b merge not blocked by Squad a');
});

test('usa-44 R1 M2: a second merge of the label unit does NOT fall through to the lane guess when the run is the lane\'s only worker', () => {
  const h = home({ 'rn-a': mainRun({ cost: 9, labels: { unit: 'unit-twice' } }) }); // no decoy: the lane fallback would hit
  const u = unitsOf(usage(h, [merge('m2', 'unit-twice', T0 + 7_200_000), merge('m1', 'unit-twice', T0 + 3_600_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-a');
  assert.equal(u.m2.implementerAgentId, null);
});

test('usa-44 R1 M2: a worktree-cwd run carrying a different labels.unit is not also credited to that unit', () => {
  const wt = ev([
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: '/wt/VibeSquad/unit-alpha', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet', labels: { wf: 'sonnet', unit: 'unit-beta' } } },
    { ts: T0 + 5000, type: 'turn_done', costUsd: 4, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const h = home({ 'rn-wt': wt, 'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }) });
  const u = unitsOf(usage(h, [merge('m1', 'unit-alpha', T0 + 3_600_000), merge('m2', 'unit-beta', T0 + 3_700_000)]));
  assert.equal(u.m1.implementerAgentId, 'rn-wt');
  assert.notEqual(u.m2.implementerAgentId, 'rn-wt');
});

test('usa-44 R1 M3: a passing "branch unit-x" mention does not override what the tool calls worked on', () => {
  const cd = (n) => `cd /w/worktrees/VibeSquad/${n} && npm test`;
  const h = home({
    'rn-a': mainRun({ cost: 5, input: 'Branch `unit-old` is already merged; implement the new thing.', tools: [cd('unit-new'), cd('unit-new'), cd('unit-new')] }),
    'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }),
  });
  const u = unitsOf(usage(h, [merge('m1', 'unit-old', T0 + 3_600_000), merge('m2', 'unit-new', T0 + 3_700_000)]));
  assert.equal(u.m1.implementerAgentId, null, 'prose mention loses to tool-call evidence');
  assert.equal(u.m2.implementerAgentId, null, 'disagreement is ambiguous, not guessed');
  // agreement is fine
  const h2 = home({ 'rn-a': mainRun({ cost: 5, input: 'Work on branch `unit-new`.', tools: [cd('unit-new'), cd('unit-new')] }), 'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }) });
  assert.equal(unitsOf(usage(h2, [merge('m2', 'unit-new', T0 + 3_700_000)])).m2.implementerAgentId, 'rn-a');
});

test('usa-44 R1 L1: one call repeating a unit path counts once (a single diff is not two calls)', () => {
  const h = home({
    'rn-a': mainRun({ cost: 5, tools: ['diff /w/worktrees/VibeSquad/unit-foo/a /w/worktrees/VibeSquad/unit-foo/b'] }),
    'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }),
  });
  assert.equal(unitsOf(usage(h, [merge('m1', 'unit-foo', T0 + 3_600_000)])).m1.implementerAgentId, null);
});

test('usa-44 R1 L2: overflowing the unit cap voids the tool-call ranking instead of picking an early unit', () => {
  const cd = (n) => `cd /w/worktrees/VibeSquad/${n} && ls`;
  const tools = [cd('unit-n0'), cd('unit-n0'), ...Array.from({ length: 11 }, (_, i) => cd(`unit-n${i + 1}`)), ...Array.from({ length: 30 }, () => cd('unit-late'))];
  const h = home({ 'rn-a': mainRun({ cost: 5, tools }), 'rn-decoy': mainRun({ ts: T0 + 10_000, cost: 1, labels: { unit: 'unit-decoy' } }) });
  const u = unitsOf(usage(h, [merge('m1', 'unit-n0', T0 + 3_600_000), merge('m2', 'unit-late', T0 + 3_700_000)]));
  assert.equal(u.m1.implementerAgentId, null);
  assert.equal(u.m2.implementerAgentId, null);
});
