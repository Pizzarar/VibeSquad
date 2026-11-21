import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptableTurnsBucket, normalizeInputHead } from '../scripts/audit-owner-stamps.mjs';
import { transcriptFindings, fileFindings } from '../scripts/audit-perfection.mjs';

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-10T10:00:00Z');
const jl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const meta = { role: 'lead', lane: 'efi', team: 'efi', profile: 'Lead - Claude' };

// polls: input, usage (100+10), Bash `vs who lead` call, short output, turn_done with cumulative cost (0.10, 0.25, ...).
function pollTurns(runIdx, count, startCost, ts0) {
  const ev = [{ seq: 0, ts: ts0, type: 'created', meta }];
  let cost = startCost;
  for (let i = 0; i < count; i++) {
    const ts = ts0 + 1000 + i * 60000;
    cost += 0.05 * (i + 1);
    ev.push({ type: 'input', ts, text: `[vs watch] rn-${'abcdef0123456789'.slice(0, 12)}${i} is done at 2026-11-10T10:0${i}:00Z, 4${i} items` });
    ev.push({ type: 'usage', ts, inputTokens: 100, outputTokens: 10 });
    ev.push({ type: 'tool', ts, phase: 'call', id: `t${i}`, name: 'Bash', input: { command: `node C:/x/cli/vs.mjs who lead --run ${i}` } });
    ev.push({ type: 'output', ts, text: 'still running' });
    ev.push({ type: 'turn_done', ts, costUsd: Number(cost.toFixed(6)) });
  }
  return ev;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-scriptable-'));
  fs.writeFileSync(path.join(dir, 'rn-a.jsonl'), jl(pollTurns(0, 3, 0, T0)));
  const b = pollTurns(1, 3, 1.0, T0 + DAY); // second run, next day, cumulative cost starts at 1.0
  b.push({ type: 'input', ts: T0 + DAY + 900000, text: 'Please write a long design essay about caching' });
  b.push({ type: 'usage', ts: T0 + DAY + 900001, inputTokens: 5000, outputTokens: 900 });
  b.push({ type: 'output', ts: T0 + DAY + 900002, text: 'x'.repeat(3000) });
  b.push({ type: 'turn_done', ts: T0 + DAY + 900003, costUsd: 3.0 });
  fs.writeFileSync(path.join(dir, 'rn-b.jsonl'), jl(b));
  return dir;
}

test('normalizeInputHead strips ids, hashes, numbers, times, paths', () => {
  assert.equal(normalizeInputHead('Run rn-0123456789ab at 2026-11-10T10:00:00Z in C:\\a\\b abcdef1234 x 42'), 'run at in x');
});

test('one cluster: n=6, summed usage tokens, cost = sum of deltas, vs watch hint, one-off not listed', () => {
  const dir = fixture();
  const r = scriptableTurnsBucket(dir, {});
  assert.equal(r.clusters.length, 1);
  const c = r.clusters[0];
  assert.equal(c.n, 6);
  assert.equal(c.runs, 2);
  assert.equal(c.tokens, 6 * 110);
  // run a deltas: .05+.10+.15 = .30; run b: 1.05-1.0.. cumulative starts 1.0 -> first delta from base 0 is 1.05 (new log = base 0), then .10,.15
  assert.equal(c.costUsd, Number((0.05 + 0.1 + 0.15 + 1.05 + 0.1 + 0.15).toFixed(6)));
  assert.match(c.hint, /vs watch/);
  assert.equal(c.examples.length, 2);
  assert.ok(!r.clusters.some((x) => /design essay/.test(x.signature)));
});

test('since/until window and thresholds drop the cluster', () => {
  const dir = fixture();
  assert.equal(scriptableTurnsBucket(dir, { since: T0 + DAY }).clusters.length, 0);
});

test('transcriptFindings emits one stable scriptable:<hash> finding; fileFindings dedupes it', () => {
  const dir = fixture();
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-norepo-'));
  const now = T0 + 5 * DAY;
  const fs1 = transcriptFindings({ dir, since: T0 - 1, repo: noRepo, now }).filter((f) => f.key.startsWith('scriptable:'));
  assert.equal(fs1.length, 1);
  assert.match(fs1[0].key, /^scriptable:[0-9a-f]{8}$/);
  assert.match(fs1[0].text, /6 turns.*660 tokens.*vs watch/);
  assert.ok(fs1[0].evidence.includes('rn-a'));
  const later = transcriptFindings({ dir, since: T0 - 1, repo: noRepo, now: now + 3 * DAY }).filter((f) => f.key.startsWith('scriptable:'));
  assert.equal(later[0].key, fs1[0].key);
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-home-'));
  assert.equal(fileFindings(fs1, { baseHome }).filed.length, 1);
  assert.equal(fileFindings(fs1, { baseHome }).filed.length, 0);
});

// generic fixture: `count` identical-shape turns over 2 runs/days; cost per turn = costs[i % costs.length]
function shapeDir(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-shape-'));
  specs.forEach((s, k) => {
    for (let r = 0; r < 2; r++) {
      const ts0 = T0 + r * DAY, ev = [{ seq: 0, ts: ts0, type: 'created', meta: { role: s.role || 'lead', lane: 'efi' } }];
      let cost = 0;
      for (let i = 0; i < 3; i++) {
        const ts = ts0 + 1000 + i * 60000;
        cost += s.cost;
        ev.push({ type: 'input', ts, text: s.input });
        ev.push({ type: 'usage', ts, inputTokens: s.tokens, outputTokens: 0 });
        if (s.cmd) ev.push({ type: 'tool', ts, phase: 'call', id: `t${i}`, name: 'Bash', input: { command: s.cmd } });
        ev.push({ type: 'output', ts, text: s.out });
        ev.push({ type: 'turn_done', ts, costUsd: Number(cost.toFixed(6)) });
      }
      fs.writeFileSync(path.join(dir, `rn-${k}${r}.jsonl`), jl(ev));
    }
  });
  return dir;
}

test('clusters rank by total $, not tokens', () => {
  const dir = shapeDir([
    { input: 'cheap but huge context', tokens: 900000, cost: 0.01, out: 'ok', cmd: 'vs who lead' },
    { input: 'pricey but small context', tokens: 10, cost: 1.0, out: 'ok', cmd: 'vs who lead' },
  ]);
  const r = scriptableTurnsBucket(dir, {});
  assert.equal(r.clusters.length, 2);
  assert.match(r.clusters[0].signature, /pricey/);
  assert.ok(r.clusters[0].costUsd > r.clusters[1].costUsd && r.clusters[0].tokens < r.clusters[1].tokens);
});

test('restart/drain input gets a restart hint (idea-347), not auto-gen; soft-limit input does not get hooks', () => {
  const dir = shapeDir([
    { input: 'Rif3: RESTART DRAIN (hub, vibesquad) hold all background work', tokens: 10, cost: 0.1, out: 'drained', cmd: 'vs log restart-feedback "drained restart"' },
    { input: 'restart-done: resume', tokens: 10, cost: 0.1, out: 'ok', cmd: 'vs log restart-feedback x' },
    { input: 'hold lifted, carry on', tokens: 10, cost: 0.1, out: 'ok', cmd: 'vs log x' },
    { input: 'Context check: past worker soft limit, wrap up and hand off', tokens: 10, cost: 0.1, out: 'ok' },
    { input: 'unrelated note', tokens: 10, cost: 0.1, out: 'ok', cmd: 'vs log restart-feedback x' },
  ]);
  const byHead = Object.fromEntries(scriptableTurnsBucket(dir, {}).clusters.map((c) => [c.signature.split(' | ')[1].split(' ')[0], c.hint]));
  for (const k of ['rif:', 'restart-done:', 'hold']) { assert.match(byHead[k], /idea-347/); assert.doesNotMatch(byHead[k], /auto-gen/); }
  assert.doesNotMatch(byHead.context, /hooks/);
  assert.match(byHead.unrelated, /auto-gen/); // a mere `vs log` call still maps to auto-gen when the input isn't restart-shaped
});

test('fixed-shape input with real output (median >= 1000) is not-scriptable: in --waste, no finding; keys stable', () => {
  const dir = shapeDir([
    { input: 'Context check: past worker soft limit, wrap up', tokens: 10, cost: 0.5, out: 'h'.repeat(1500) },
    { input: '[vs watch] stall notice', tokens: 10, cost: 0.1, out: 'ok', cmd: 'vs inspect x' },
  ]);
  const r = scriptableTurnsBucket(dir, {});
  const big = r.clusters.find((c) => /soft limit/.test(c.signature));
  assert.equal(big.notScriptable, true);
  assert.equal(r.clusters.find((c) => /stall/.test(c.signature)).notScriptable, false);
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-norepo-'));
  const f = transcriptFindings({ dir, since: T0 - 1, repo: noRepo, now: T0 + 5 * DAY }).filter((x) => x.key.startsWith('scriptable:'));
  assert.equal(f.length, 1);
  assert.match(f[0].text, /stall/);
  assert.match(f[0].key, /^scriptable:[0-9a-f]{8}$/);
});
