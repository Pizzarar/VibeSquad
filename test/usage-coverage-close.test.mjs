// usa-58: coverage close. (1) a run that implemented several units in turn is credited its secondary units (identity only, cost stays with
// the primary); (2) ledger-folded rows (no agent id) always carry an attributionMiss reason.
// Synthetic logs in temp dirs only. Real data is never read.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, usageTestHooks } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa58-')); tmpDirs.push(d); return d; };
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

const cd = (n) => `cd /c/Users/x/AppData/Local/VibeSquad/worktrees/VibeSquad/${n} && git status`;
const many = (n, k) => Array.from({ length: k }, () => cd(n));

test('usa-58: a run that implemented two units in turn is credited both; the secondary merge carries no cost', () => {
  const h = home({ 'rn-a': mainRun({ cost: 2, input: 'work order: `vs worktree create unit-first`', tools: [...many('unit-first', 20), ...many('unit-second', 6)] }) });
  const u = usage(h, [merge('m1', 'unit-first', T0 + 3_600_000), merge('m2', 'unit-second', T0 + 3_700_000)]);
  const m = unitsOf(u);
  assert.equal(m.m1.implementerAgentId, 'rn-a');
  assert.equal(m.m1.implementerShared, false);
  assert.equal(m.m1.costUsd, 2);
  assert.equal(m.m2.implementerAgentId, 'rn-a');
  assert.equal(m.m2.attributionMiss, null);
  assert.equal(m.m2.implementerShared, true);
  assert.equal(m.m2.costUsd, null); // never double-counted
  assert.equal(u.attributionCoverage.attributed, 2);
});

test('usa-58: a few stray calls in another unit are not credit (below the secondary threshold)', () => {
  const h = home({ 'rn-a': mainRun({ input: 'work order: `vs worktree create unit-first`', tools: [...many('unit-first', 20), ...many('unit-peek', 4)] }), 'rn-z': wtRun('unit-other') }); // rn-z: the lane has no unique worker to guess
  const u = usage(h, [merge('m1', 'unit-first', T0 + 3_600_000), merge('m2', 'unit-peek', T0 + 3_700_000)]);
  const m = unitsOf(u);
  assert.equal(m.m2.implementerAgentId, null);
  assert.ok(m.m2.attributionMiss); // lane-level miss: the run is never credited on a stray peek
});

test('usa-58: secondary credit never goes to a merge before the run existed, and only to the earliest later merge', () => {
  const h = home({ 'rn-z': wtRun('unit-other'), 'rn-a': mainRun({ ts: T0 + 1_000_000, tools: [...many('unit-first', 20), ...many('unit-second', 6)], input: 'work order: `vs worktree create unit-first`' }) });
  const u = usage(h, [merge('m0', 'unit-second', T0), merge('m1', 'unit-first', T0 + 3_600_000), merge('m2', 'unit-second', T0 + 3_700_000), merge('m3', 'unit-second', T0 + 3_800_000)]);
  const m = unitsOf(u);
  assert.notEqual(m.m0.implementerAgentId, 'rn-a'); // run did not exist yet (lane guess may pick rn-z)
  assert.equal(m.m2.implementerAgentId, 'rn-a');
  assert.equal(m.m3.implementerAgentId, null);
});

test('usa-58: a ledger-folded unit (agent id not kept) is unattributed WITH a reason; every unattributed unit has one', () => {
  const h = home({ 'rn-a': wtRun('unit-live') });
  fs.writeFileSync(path.join(h, 'runner', 'usage-ledger.jsonl'), [
    { kind: 'unit', unit: 'unit-gone', sha: 'dead1', ts: new Date(T0 + 1000).toISOString(), implementerProfile: 'Implement - Sonnet', implementerProvider: 'claude', reviewRounds: 0 },
    { kind: 'unit', unit: 'unit-gone2', sha: 'dead2', ts: new Date(T0 + 2000).toISOString(), reviewRounds: 0 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const u = usage(h, [merge('m1', 'unit-live', T0 + 3_600_000)]);
  const m = unitsOf(u);
  assert.equal(m.dead1.fromLedger, true);
  assert.equal(m.dead1.attributionMiss, 'ledger-archived-no-agent');
  assert.equal(m.dead2.attributionMiss, 'ledger-archived-unattributed');
  for (const x of u.merged.units) assert.ok(x.implementerAgentId || x.attributionMiss, `unit ${x.sha} has neither an implementer nor a miss reason`);
});

test('usa-58 R1 H1: a later merge of the secondary unit is a miss, never a lane-guess re-credit at full cost (no decoy lane worker)', () => {
  const h = home({ 'rn-a': mainRun({ cost: 2, input: 'work order: `vs worktree create unit-first`', tools: [...many('unit-first', 20), ...many('unit-second', 6)] }) });
  const u = usage(h, [merge('m1', 'unit-first', T0 + 3_600_000), merge('m2', 'unit-second', T0 + 3_700_000), merge('m3', 'unit-second', T0 + 3_800_000)]);
  const m = unitsOf(u);
  assert.equal(m.m2.implementerShared, true);
  assert.equal(m.m3.implementerAgentId, null);
  assert.equal(m.m3.attributionMiss, 'evidence-claimed-by-other-merge');
  assert.equal(m.m3.costUsd, null);
});

test('usa-58 R1 M1: a run with no primary unit (two assigned units) is never credited a secondary unit', () => {
  const h = home({ 'rn-a': mainRun({ cost: 2, input: 'work order: `vs worktree create unit-a` then `vs worktree create unit-b`', tools: [...many('unit-a', 8), ...many('unit-b', 8), ...many('unit-c', 8)] }), 'rn-z': wtRun('unit-other') });
  const u = usage(h, [merge('m1', 'unit-c', T0 + 3_600_000)]);
  assert.equal(unitsOf(u).m1.implementerAgentId, null);
});

test('usa-58 R1 M1: shared (cost-less) credits stay out of the byWorkflow / cohort cost averages', () => {
  const h = home({ 'rn-a': mainRun({ cost: 2, input: 'work order: `vs worktree create unit-first`', tools: [...many('unit-first', 20), ...many('unit-second', 6)] }) });
  const u = usage(h, [merge('m1', 'unit-first', T0 + 3_600_000), merge('m2', 'unit-second', T0 + 3_700_000)]);
  const g = u.byWorkflow.find((x) => x.units === 2);
  assert.ok(g, 'both merges in one workflow group');
  assert.equal(g.costPerUnit, 2); // not 1 (= 2 / 2 units)
  assert.equal(g.costCoverage, 1);
  const rows = u.merged.units;
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...rows[0], sha: `s${i}`, dispatchBurstSize: 1, implementerShared: i >= 5, costUsd: i >= 5 ? null : 2 }));
  const solo = usageTestHooks.buildBurstCohorts(mk(10)).buckets.find((b) => b.key === '1');
  assert.equal(solo.costPerUnit, 2);
});
