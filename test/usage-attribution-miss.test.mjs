// usa-55 (derived from usa-44 harness): implementers that ran in the MAIN checkout (cwd is not a unit worktree) are tied to their merged unit by explicit evidence
// in their own log (labels.unit > the work order's assigned unit > the unique most-worked unit), folded during the normal event fold.
// Synthetic logs in temp dirs only. Real data is never read.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, usageTestHooks } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa55-')); tmpDirs.push(d); return d; };
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


const WT = (n) => `/home/x/.vibesquad/worktrees/VibeSquad/${n}`;
const wtRun = (name, profile = 'Implement - Sonnet', extra = {}) => mainRun({ cwd: WT(name), profile, ...extra });

test('usa-55: worktree `sb2-x` joins merged branch `unit-sb2-x` (storybook naming)', () => {
  const h = home({ 'rn-a': wtRun('sb2-x') });
  const u = usage(h, [merge('m1', 'unit-sb2-x', T0 + 3_600_000)]);
  const m = unitsOf(u).m1;
  assert.equal(m.implementerAgentId, 'rn-a');
  assert.equal(m.attributionMiss, null);
  assert.equal(u.attributionCoverage.attributed, 1);
  assert.equal(u.attributionCoverage.rate, 1);
});

test('usa-55: miss reasons are enumerated and byMiss sums to the miss count', () => {
  const h = home({
    'rn-a': wtRun('unit-amb', 'Implement - Sonnet'),
    'rn-b': wtRun('unit-amb', 'Work Order - DSP'),
    'rn-c': wtRun('unit-revonly', 'Review - Gemini'),
    'rn-c2': wtRun('unit-revonly', 'Review - Gemini'),
    'rn-d': wtRun('unit-other'),
  });
  const merges = [
    merge('m1', 'unit-amb', T0 + 3_600_000),
    merge('m2', 'unit-revonly', T0 + 3_700_000),
    merge('m3', 'unit-ghost', T0 + 3_800_000),
    merge('m4', 'unit-other', T0 + 3_900_000),
  ];
  const u = usage(h, merges);
  const m = unitsOf(u);
  assert.ok(m.m1.implementerAgentId, 'several implementer profiles -> costliest primary credited');
  assert.equal(m.m1.attributionMiss, null);
  assert.equal(m.m2.attributionMiss, 'no-implementer-in-worktree');
  assert.equal(m.m3.attributionMiss, 'no-lane-implementer'); // lane fallback: 3 implementer-ish workers, lane has no unique pick
  assert.equal(m.m4.attributionMiss, null);
  const c = u.attributionCoverage;
  assert.equal(c.total, 4);
  assert.equal(c.attributed, 2);
  assert.equal(Object.values(c.byMiss).reduce((a, b) => a + b, 0), c.total - c.attributed);
});

test('usa-55: no agents at all -> other-repo-unmapped', () => {
  const h = home({});
  const u = usage(h, [merge('m1', 'unit-zzz', T0 + 3_600_000)]);
  assert.equal(unitsOf(u).m1.attributionMiss, 'other-repo-unmapped');
  assert.deepEqual(u.attributionCoverage.byMiss, { 'other-repo-unmapped': 1 });
});

// ---- R1 review fixes: unit-level tests on synthetic agent summaries
import { usageTestHooks as H } from '../server/providers-catalog.mjs';
const ag = (agentId, cwd, o = {}) => ({ agentId, role: 'worker', cwd, lane: 'x', profile: 'Implement - Sonnet', provider: 'claude', turns: 1, costUsd: 1, createdAt: 1000, team: null, ...o });
const resolve = (unit, agents, merged = []) => {
  const idx = H.indexWorkers(agents);
  idx.mergedNames = new Set(merged);
  idx.mergesByName = new Map();
  return H.resolveImplementer({ squad: null, mergedAt: 5000, lane: null, ...unit }, agents, idx);
};

test('R1 M1: main-checkout cwd (.../VibeSquad) is never aliased to branch unit-vibesquad', () => {
  const r = resolve({ unit: 'unit-vibesquad' }, [ag('a', '/home/x/projects/VibeSquad')]);
  assert.equal(r.implementer, null);
  assert.equal(r.miss, 'no-worker-cwd-match');
});

test('R1 M1: exact unit-<name> worktree outranks a costlier unit-less alias worktree', () => {
  const agents = [ag('exact', '/h/.vibesquad/worktrees/R/unit-foo', { costUsd: 1 }), ag('alias', '/h/.vibesquad/worktrees/R/foo', { costUsd: 99 })];
  assert.equal(resolve({ unit: 'unit-foo' }, agents).implementer.agentId, 'exact');
  assert.equal(resolve({ unit: 'unit-foo' }, [agents[1]]).implementer.agentId, 'alias'); // alias still joins when no exact worktree exists
});

test('R1 M2: a worker in alias worktree `sb2-x` is not also credited to the unit its log references (byRef)', () => {
  const w = ag('w', '/h/.vibesquad/worktrees/R/sb2-x', { unitRef: 'unit-other' });
  const merged = ['unit-sb2-x', 'unit-other'];
  assert.equal(resolve({ unit: 'unit-sb2-x' }, [w], merged).implementer.agentId, 'w');
  const r = resolve({ unit: 'unit-other' }, [w], merged);
  assert.equal(r.implementer, null, 'no double credit');
});

test('R1 M3: byRef multi-profile ambiguity reports ambiguous-implementers; later-created ref worker is not "claimed"', () => {
  const m = '/home/x/projects/R';
  const a = ag('a', m, { unitRef: 'unit-q', profile: 'Implement - Sonnet' });
  const b = ag('b', m, { unitRef: 'unit-q', profile: 'Mechanical - DSF' });
  assert.equal(resolve({ unit: 'unit-q' }, [a, b]).miss, 'ambiguous-implementers');
  const late = ag('late', m, { unitRef: 'unit-q', createdAt: 9000 }); // created after mergedAt 5000: filtered, falls through
  assert.notEqual(resolve({ unit: 'unit-q' }, [late]).miss, 'evidence-claimed-by-other-merge');
});

test('R1 L1: primary implementer is the costliest worked run; 0-turn loses; ties break by createdAt then agentId', () => {
  const wt = '/h/.vibesquad/worktrees/R/unit-t';
  const pick = (agents) => resolve({ unit: 'unit-t' }, agents).implementer.agentId;
  assert.equal(pick([ag('p', wt, { costUsd: 1, profile: 'Implement - Sonnet' }), ag('q', wt, { costUsd: 5, profile: 'Mechanical - DSF' })]), 'q');
  assert.equal(pick([ag('p', wt, { costUsd: 9, turns: 0, profile: 'Implement - Sonnet' }), ag('q', wt, { costUsd: 1, profile: 'Mechanical - DSF' })]), 'q');
  assert.equal(pick([ag('p', wt, { createdAt: 2000, profile: 'Implement - Sonnet' }), ag('q', wt, { createdAt: 1000, profile: 'Mechanical - DSF' })]), 'q');
  assert.equal(pick([ag('z', wt, { createdAt: null, profile: 'Implement - Sonnet' }), ag('b', wt, { createdAt: null, profile: 'Mechanical - DSF' })]), 'b');
  assert.equal(pick([ag('z', wt, { profile: 'Implement - Sonnet' }), ag('b', wt, { profile: 'Mechanical - DSF' })]), 'b');
});
