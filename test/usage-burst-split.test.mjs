// usa-59: burstCohorts.byStakes / byLane cross-splits (stakes|lane x burst bucket); existing shape unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBurstCohorts } from '../server/providers-catalog.mjs';
import './helpers/keep-alive.mjs';

const U = (burst, extra = {}) => ({ dispatchBurstSize: burst, reviewRounds: 1, costUsd: 2, inputTokens: 0, outputTokens: 0, fixAfterMerge: false, stakes: 'normal', lane: 'usage', ...extra });
const many = (burst, n, extra) => Array.from({ length: n }, () => U(burst, extra));
const row = (rows, k) => rows.find((r) => r.key === k);
const cell = (r, k) => r.buckets.find((b) => b.key === k);

test('existing buckets / unjoined / minN shape is unchanged', () => {
  const r = buildBurstCohorts([...many(1, 5), ...many(4, 2), U(null)]);
  assert.deepEqual(r.buckets.map((b) => [b.key, b.units]), [['1', 5], ['2-3', 0], ['4+', 2]]);
  assert.equal(r.unjoined, 1); assert.equal(r.minN, 5);
});

test('byStakes: stakes x bucket cells, ordered, unlabeled -> unknown, unjoined left out', () => {
  const r = buildBurstCohorts([
    ...many(1, 5, { reviewRounds: 2, costUsd: 4 }), ...many(4, 5),
    ...many(1, 5, { stakes: 'tierA-security' }), ...many(1, 2, { stakes: 'mechanical' }),
    U(2, { stakes: null }), U(null, { stakes: 'normal' }),
  ]);
  assert.deepEqual(r.byStakes.map((x) => x.key), ['normal', 'tierA-security', 'mechanical', 'unknown']);
  const n = row(r.byStakes, 'normal');
  assert.equal(n.units, 10);
  assert.equal(cell(n, '1').firstTryPassRate, 0); assert.equal(cell(n, '1').costPerUnit, 4);
  assert.equal(cell(n, '4+').firstTryPassRate, 1); assert.equal(cell(n, '4+').costPerUnit, 2);
  assert.equal(cell(n, '2-3').units, 0);
  assert.equal(cell(row(r.byStakes, 'mechanical'), '1').insufficient, true);
  assert.equal(cell(row(r.byStakes, 'mechanical'), '1').firstTryPassRate, null);
  assert.equal(row(r.byStakes, 'unknown').units, 1);
});

test('byLane: lane x bucket, sorted by units desc, same minN rule', () => {
  const r = buildBurstCohorts([...many(1, 6, { lane: 'a' }), ...many(4, 5, { lane: 'b' }), ...many(4, 3, { lane: 'b', reviewRounds: 3 })]);
  assert.deepEqual(r.byLane.map((x) => x.key), ['b', 'a']);
  assert.equal(cell(row(r.byLane, 'b'), '4+').units, 8);
  assert.equal(cell(row(r.byLane, 'b'), '4+').avgReviewRounds, 1.75);
  assert.equal(cell(row(r.byLane, 'a'), '1').units, 6);
});

test('implementerShared: counted in units and rates, left out of cost average', () => {
  const r = buildBurstCohorts([...many(1, 4, { stakes: 'normal' }), U(1, { implementerShared: true, costUsd: null, reviewRounds: 3 })]);
  const c = cell(row(r.byStakes, 'normal'), '1');
  assert.equal(c.units, 5); assert.equal(c.insufficient, false);
  assert.equal(c.firstTryPassRate, 0.8); assert.equal(c.costPerUnit, 2);
  assert.equal(cell(row(r.byLane, 'usage'), '1').costPerUnit, 2);
});

test('cell totals across stakes equal the top-level buckets', () => {
  const r = buildBurstCohorts([...many(1, 3), ...many(1, 4, { stakes: 'mechanical' }), ...many(3, 6, { stakes: 'tierA-invariant' })]);
  for (const b of r.buckets) assert.equal(r.byStakes.reduce((t, x) => t + cell(x, b.key).units, 0), b.units);
  for (const b of r.buckets) assert.equal(r.byLane.reduce((t, x) => t + cell(x, b.key).units, 0), b.units);
});
