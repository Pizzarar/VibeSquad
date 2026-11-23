import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUsage, LEAD_LONG_TURN_MIN } from '../server/providers-catalog.mjs';
import './helpers/keep-alive.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-leadsplit-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const noGit = () => '';
const T0 = Date.UTC(2026, 10, 3, 12);
function writeAgent(home, id, evs) {
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), evs.map((e, i) => JSON.stringify({ seq: i, ...e })).join('\n') + '\n');
}
// A lead run of `n` turns; toolsFor(i) -> [{name,input}] for 1-based turn i. Each turn costs $0.10 (cumulative total_cost_usd).
function leadRun(team, n, toolsFor) {
  const evs = [{ ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead', team } }];
  for (let i = 1; i <= n; i++) {
    const ts = T0 + i * 1000;
    for (const t of toolsFor(i)) evs.push({ ts, type: 'tool', phase: 'call', id: `t${i}`, name: t.name, input: t.input });
    evs.push({ ts, type: 'turn_done', costUsd: Math.round(i * 0.1 * 1e6) / 1e6 });
  }
  return evs;
}
const bash = (command) => ({ name: 'Bash', input: { command } });

test('lead long-tail split: loop / productive / other, buckets sum to total, bySquad splits teams', () => {
  const home = tmp();
  const N = LEAD_LONG_TURN_MIN + 10; // long tail = turns 81..90
  writeAgent(home, 'rn-a', leadRun('alpha', N, (i) => {
    if (i <= LEAD_LONG_TURN_MIN) return [bash('ls')]; // head repeats don't count: only the long tail seeds repeats
    if (i === 85) return [bash('git commit -m x')];
    if (i >= 81 && i <= 84) return [{ name: 'Bash', input: { b: 2, a: 1 } }]; // 81,82 seed; 83,84 loop
    return [bash(`echo ${i}`)];
  }));
  // team beta: 90 turns, same-signature repeats but in the other key order -> still a loop
  writeAgent(home, 'rn-b', leadRun('beta', N, (i) => (i === 81 || i === 82 || i === 83 ? [{ name: 'Bash', input: { a: 1, b: 2 } }] : [])));
  const u = getUsage({ home, git: noGit });
  const l = u.leadLongTurns;
  assert.equal(l.threshold, 80);
  const a = l.bySquad.find((r) => r.teamId === 'alpha');
  assert.equal(a.productive.turns, 1);
  assert.equal(a.loop.turns, 2);
  assert.equal(a.other.turns, 7);
  assert.equal(a.productive.turns + a.loop.turns + a.other.turns, 10);
  const b = l.bySquad.find((r) => r.teamId === 'beta');
  assert.equal(b.loop.turns, 1, 'key-order independent signature');
  assert.equal(b.other.turns, 9);
  assert.equal(l.bySquad.length, 2);
  // pooled = sum of both teams; costs sum to the long-tail turn costs ($0.10 each, 20 turns)
  const p = l.pooled;
  assert.equal(p.productive.turns + p.loop.turns + p.other.turns, 20);
  assert.equal(p.loop.turns, 3);
  const cost = p.productive.costUsd + p.loop.costUsd + p.other.costUsd;
  assert.ok(Math.abs(cost - 2.0) < 1e-6, `cost ${cost}`);
  assert.ok(Math.abs(a.productive.costUsd - 0.1) < 1e-6);
});

test('lead long-tail split: non-lead roles and short runs contribute nothing', () => {
  const home = tmp();
  writeAgent(home, 'rn-s', leadRun('alpha', 20, () => [bash('ls')]));
  const evs = leadRun('alpha', 90, () => [bash('ls')]);
  evs[0].meta.role = 'worker';
  writeAgent(home, 'rn-w', evs);
  const l = getUsage({ home, git: noGit }).leadLongTurns;
  assert.equal(l.pooled.other.turns + l.pooled.loop.turns + l.pooled.productive.turns, 0);
  assert.deepEqual(l.bySquad, []);
});

test('spawn storms: countExclRespawns drops respawned agents, raw count unchanged', () => {
  const home = tmp();
  [0, 20_000, 40_000, 60_000].forEach((off, i) => {
    writeAgent(home, `rn-r${i}`, [{ ts: T0 + off, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', ...(i >= 2 ? { labels: { respawnOf: 'rn-dead' } } : {}) } }]);
  });
  const storm = getUsage({ home, git: noGit }).spawnStorms.find((s) => s.lane === 'usage' && s.role === 'worker');
  assert.equal(storm.count, 4);
  assert.equal(storm.countExclRespawns, 2);
  assert.ok(storm.countExclRespawns < storm.count);
});

// ---- usa-40 R1 ----
const cu = (i) => Math.round(i * 0.1 * 1e6) / 1e6;
const tail = (home, id, team, toolsFor, n = LEAD_LONG_TURN_MIN + 5, extra = {}) => {
  writeAgent(home, id, leadRun(team, n, toolsFor));
  return getUsage({ home, git: noGit }).leadLongTurns.bySquad.find((r) => r.teamId === team);
};

test('R1 L4: key-order independence inside one agent -> loop', () => {
  const home = tmp();
  const r = tail(home, 'rn-k', 'alpha', (i) => (i === 81 ? [{ name: 'Bash', input: { a: 1, b: 2 } }] : i === 82 ? [{ name: 'Bash', input: { b: 2, a: 1 } }] : i === 83 ? [{ name: 'Bash', input: { a: 1, b: 2 } }] : i === 84 ? [{ name: 'Bash', input: { b: 2, a: 1 } }] : []));
  assert.equal(r.loop.turns, 2); // turns 83, 84 repeat a sig seen >=2 times
});

test('R1 H1: ACP-shaped tools (title only, no input): commit title productive; generic titles never loop', () => {
  const home = tmp();
  const r = tail(home, 'rn-acp', 'alpha', (i) => (i === 85 ? [{ name: 'git commit -m "x"' }] : i > 80 ? [{ name: 'Run shell command' }] : []));
  assert.equal(r.productive.turns, 1);
  assert.equal(r.loop.turns, 0);
  assert.equal(r.other.turns, 4);
});

test('R1 L4: MCP productive tool names; result phase ignored', () => {
  const home = tmp();
  const evs = leadRun('alpha', 85, (i) => (i === 81 ? [{ name: 'mcp__vibesquad__wait', input: { ids: ['x'] } }] : i === 82 ? [{ name: 'mcp__vibesquad__spawn_worker', input: { a: 1 } }] : []));
  // a result-phase tool event with a productive-looking name in turn 83 must be ignored
  const at = evs.findIndex((e) => e.type === 'turn_done' && e.costUsd === cu(83));
  evs.splice(at, 0, { ts: T0 + 83000, type: 'tool', phase: 'result', id: 'r', name: 'git commit', input: { command: 'git commit' } });
  writeAgent(home, 'rn-mcp', evs);
  const r = getUsage({ home, git: noGit }).leadLongTurns.bySquad.find((x) => x.teamId === 'alpha');
  assert.equal(r.productive.turns, 1); // spawn_worker only; the wait is now "waiting" (usa-43)
  assert.equal(r.waiting.turns, 1);
  assert.equal(r.other.turns, 3);
});

test('usa-43: waiting bucket (vs wait / MCP wait only), wait+commit productive, repeated waits not loop', () => {
  const home = tmp();
  const r = tail(home, 'rn-w', 'alpha', (i) => (
    i === 81 || i === 82 || i === 83 ? [bash('vs wait rn-x --timeout 60')] // repeated identical -> waiting, not loop
    : i === 84 ? [{ name: 'mcp__vibesquad__wait_for_agent', input: { id: 'x' } }]
    : i === 85 ? [bash('vs watch add a b'), { name: 'mcp__vibesquad__watch', input: { ids: ['a'] } }]
    : i === 86 ? [bash('vs wait rn-x'), bash('git commit -m x')] // wait + commit -> productive
    : i === 87 ? [bash('git commit -m x && vs wait rn-x')] // one combined command -> productive
    : i === 88 ? [bash('vs wait rn-x'), bash('ls')] // wait + other call -> not waiting
    : []), 90);
  assert.equal(r.waiting.turns, 5);
  assert.equal(r.productive.turns, 2);
  assert.equal(r.loop.turns, 0);
  assert.equal(r.other.turns, 3); // 88 (wait+ls), 89, 90 (no calls)
  assert.equal(r.waiting.turns + r.productive.turns + r.loop.turns + r.other.turns, 10);
});

test('R1 M3: a failed turn (error, no turn_done) does not leak tools into the next turn', () => {
  const home = tmp();
  const evs = leadRun('alpha', 85, (i) => (i === 83 || i === 84 ? [bash('ls')] : []));
  // tools of a failed turn: two identical calls that never reached turn_done, then an error
  const at = evs.findIndex((e) => e.type === 'turn_done' && e.costUsd === cu(84));
  evs.splice(at + 1, 0, { ts: T0 + 84500, type: 'tool', phase: 'call', id: 'f1', name: 'Bash', input: { command: 'ls' } }, { ts: T0 + 84600, type: 'error', message: 'boom' });
  writeAgent(home, 'rn-err', evs);
  const r = getUsage({ home, git: noGit }).leadLongTurns.bySquad.find((x) => x.teamId === 'alpha');
  assert.equal(r.loop.turns, 0, 'only two real ls calls -> no loop; the leaked third would have made turn 85 a loop only if ls repeated');
});

test('R1 L5: invalid-ts turn_done keeps long-tail turns consistent with st.turns', () => {
  const home = tmp();
  const evs = leadRun('alpha', 85, () => []);
  const bad = evs.findIndex((e) => e.type === 'turn_done' && e.costUsd === cu(83));
  evs[bad].ts = 1e20;
  writeAgent(home, 'rn-ts', evs);
  const u = getUsage({ home, git: noGit });
  const p = u.leadLongTurns.pooled;
  assert.equal(p.productive.turns + p.loop.turns + p.other.turns, 4); // 81,82,84,85 (the invalid-ts turn is skipped like st.turns)
});

test('R1 M2: zero-exit storm drops respawned agents from countExclRespawns', () => {
  const home = tmp();
  [0, 20_000, 40_000, 60_000].forEach((off, i) => {
    writeAgent(home, `rn-x${i}`, [
      { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead', ...(i >= 3 ? { labels: { respawnOf: 'rn-dead' } } : {}) } },
      { ts: T0 + 60 * 60_000 + off, type: 'exit', code: 1 },
    ]);
  });
  const s = getUsage({ home, git: noGit }).spawnStorms.filter((x) => x.zeroTurnExits > 0);
  assert.equal(s.length, 1);
  assert.equal(s[0].count, 4);
  assert.equal(s[0].countExclRespawns, 3);
  assert.ok(s[0].countExclRespawns <= s[0].count);
});
