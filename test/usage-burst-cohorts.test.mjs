// usa-51: buildBurstCohorts buckets + buildPlanScores plans[] rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBurstCohorts, buildPlanScores } from '../server/providers-catalog.mjs';
import './helpers/keep-alive.mjs';

const U = (burst, extra = {}) => ({ dispatchBurstSize: burst, reviewRounds: 1, costUsd: 2, inputTokens: 0, outputTokens: 0, fixAfterMerge: false, ...extra });
const many = (burst, n, extra) => Array.from({ length: n }, () => U(burst, extra));
const by = (r, k) => r.buckets.find((b) => b.key === k);

test('bucket edges: 1 -> solo, 2 and 3 -> 2-3, 4 -> 4+', () => {
  const r = buildBurstCohorts([U(1), U(2), U(3), U(4), U(7)]);
  assert.equal(by(r, '1').units, 1);
  assert.equal(by(r, '2-3').units, 2);
  assert.equal(by(r, '4+').units, 2);
  assert.equal(r.unjoined, 0);
});

test('null / invalid burst counts toward unjoined only', () => {
  const r = buildBurstCohorts([U(null), U(undefined), U(0), U(1)]);
  assert.equal(r.unjoined, 3);
  assert.equal(r.buckets.reduce((t, b) => t + b.units, 0), 1);
});

test('n<5 bucket is insufficient with null metrics; n=5 reports them', () => {
  const r = buildBurstCohorts([...many(4, 4), ...many(1, 5, { reviewRounds: 2, fixAfterMerge: true })]);
  assert.equal(by(r, '4+').units, 4);
  assert.equal(by(r, '4+').insufficient, true);
  assert.equal(by(r, '4+').firstTryPassRate, null);
  const solo = by(r, '1');
  assert.equal(solo.insufficient, false);
  assert.equal(solo.firstTryPassRate, 0);
  assert.equal(solo.avgReviewRounds, 2);
  assert.equal(solo.fixAfterMergeRate, 1);
  assert.equal(solo.costPerUnit, 2);
  assert.equal(r.minN, 5);
});

const NOW = Date.UTC(2026, 10, 24, 12);
const DAY = 86400_000;
const P = (n) => `docs/PLAN_Y${n}.md`;
const buddy = (plan, ago, o = {}) => ({ ts: NOW - ago * DAY, lane: 'usage', squad: 'vibesquad', type: 'handoff', agent: 'rn-buddy', text: `buddy -> lead plan=${plan}`, plan, ...o });
const done = (plan, ago, o = {}) => ({ ts: NOW - ago * DAY, lane: 'usage', squad: 'vibesquad', type: 'done', agent: 'rn-lead', text: `done ${plan}`, plan, pass: true, ...o });

test('plans[]: open / done / stale status, path, team, buddy, cycleMs, newest first', () => {
  const r = buildPlanScores([buddy(P(1), 10), done(P(1), 9), buddy(P(2), 2), buddy(P(3), 9)], { now: NOW });
  assert.deepEqual(r.plans.map((p) => [p.path, p.status]), [[P(2), 'open'], [P(3), 'stale'], [P(1), 'done']]);
  const d = r.plans[2];
  assert.equal(d.team, 'vibesquad'); assert.equal(d.lane, 'usage'); assert.equal(d.buddy, 'rn-buddy');
  assert.equal(d.cycleMs, DAY); assert.equal(d.doneAt - d.startedAt, DAY);
  assert.equal(r.plans[0].cycleMs, null);
  assert.equal(r.plans[0].doneAt, null);
});

test('plans[]: lead->lead transfer shows the current lead', () => {
  const tr = { ts: NOW - 5 * DAY, lane: 'usage', squad: 'vibesquad', type: 'handoff', agent: 'rn-a', text: 'lead rn-a -> rn-b (restart)', plan: P(1) };
  const open = buildPlanScores([buddy(P(1), 6), tr], { now: NOW }).plans[0];
  assert.equal(open.currentLead, 'rn-b');
  const dn = buildPlanScores([buddy(P(1), 6), tr, done(P(1), 4, { agent: 'rn-b' })], { now: NOW }).plans[0];
  assert.equal(dn.currentLead, 'rn-b'); assert.equal(dn.status, 'done');
});

test('plans[] is capped at 50, newest kept', () => {
  const es = Array.from({ length: 60 }, (_, i) => buddy(P(i), 60 - i - 0.5 > 0 ? (60 - i) / 10 : 0.1));
  const r = buildPlanScores(es, { now: NOW });
  assert.equal(r.plans.length, 50);
  assert.equal(r.plans[0].path, P(59));
  assert.equal(r.pooled.started, 60);
});
