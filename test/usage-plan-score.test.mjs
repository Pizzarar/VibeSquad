import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanScores, PLAN_SCORE_MIN_N } from '../server/providers-catalog.mjs';
import { planScoreText, plansSummary } from '../src/usageHelpers.ts';
import './helpers/keep-alive.mjs';

const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 24, 12);
const buddy = (plan, ago, lane = 'usage', squad = 'vibesquad') => ({ ts: NOW - ago * DAY, lane, squad, type: 'handoff', agent: 'rn-buddy', text: `buddy -> lead plan handoff (send) plan=${plan}`, plan });
const done = (plan, ago, extra = {}) => ({ ts: NOW - ago * DAY, lane: 'usage', squad: 'vibesquad', type: 'done', agent: 'rn-lead', text: `done ${plan}`, plan, ...extra });
const P = (n) => `docs/PLAN_X${n}.md`;

test('Buddy handoff + done --pass = 1/1', () => {
  const r = buildPlanScores([buddy(P(1), 10), done(P(1), 9, { pass: true })], { now: NOW });
  assert.equal(r.pooled.started, 1);
  assert.equal(r.pooled.done, 1);
  assert.equal(r.pooled.scored, 1);
  assert.equal(r.pooled.scoredDone, 1);
  assert.equal(r.byLane[0].lane, 'usage');
  assert.equal(r.pooled.medianCycleMs, DAY);
  assert.equal(r.minN, PLAN_SCORE_MIN_N);
});

test('lead->lead transfer adds no start and credits the receiving lead', () => {
  const transfer = { ts: NOW - 8 * DAY, lane: 'usage', squad: 'vibesquad', type: 'handoff', agent: 'rn-b', text: `lead rn-a -> rn-b (ord1 -> ord2): handoff plan=${P(1)}`, plan: P(1) };
  const r = buildPlanScores([buddy(P(1), 10), transfer, done(P(1), 5, { pass: true, agent: 'rn-b' })], { now: NOW });
  assert.equal(r.pooled.started, 1);
  const by = Object.fromEntries(r.byLead.map((l) => [l.lead, l]));
  assert.equal(by['rn-a'].started, 1);
  assert.equal(by['rn-b'].done, 1);
  assert.equal(by['rn-b'].started, 0);
  // a transfer alone (no Buddy handoff) is not a start
  assert.equal(buildPlanScores([transfer], { now: NOW }).pooled.started, 0);
});

test('a plan handed off 1 day ago is excluded from the score but counted open', () => {
  const r = buildPlanScores([buddy(P(1), 1), buddy(P(2), 10), done(P(2), 9, { pass: true })], { now: NOW });
  assert.equal(r.pooled.started, 2);
  assert.equal(r.pooled.open, 1);
  assert.equal(r.pooled.scored, 1);
  assert.equal(r.pooled.stale, 0);
});

test('a non-PASS done does not count as done; stale = open > 7d', () => {
  const r = buildPlanScores([buddy(P(1), 10), done(P(1), 9, { text: 'done FAIL: broke' })], { now: NOW });
  assert.equal(r.pooled.done, 0);
  assert.equal(r.pooled.open, 1);
  assert.equal(r.pooled.stale, 1);
});

test('old text-only plan= line is parsed, PASS in text counts', () => {
  const entries = [
    { ts: NOW - 10 * DAY, lane: 'old', squad: 's', type: 'handoff', agent: 'b', text: `buddy -> lead plan handoff (spawn) plan=${P(9)}` },
    { ts: NOW - 9 * DAY, lane: 'old', squad: 's', type: 'done', agent: 'l', text: `X PASS plan=${P(9)}` },
  ];
  const r = buildPlanScores(entries, { now: NOW });
  assert.equal(r.byLane[0].lane, 'old');
  assert.equal(r.pooled.done, 1);
});

test('fewer than 5 scored plans -> n<5 plans; 5 plans -> a percentage; squad filter applies', () => {
  const four = [1, 2, 3, 4].flatMap((n) => [buddy(P(n), 10), done(P(n), 9, { pass: true })]);
  const r4 = buildPlanScores(four, { now: NOW });
  assert.equal(r4.pooled.insufficient, true);
  assert.equal(r4.pooled.score, null);
  assert.equal(planScoreText(r4.pooled, r4.minN), 'n<5 plans');
  const five = [...four, buddy(P(5), 10)];
  const r5 = buildPlanScores(five, { now: NOW });
  assert.equal(r5.pooled.score, 0.8);
  assert.equal(planScoreText(r5.pooled, 5), '80%');
  assert.equal(buildPlanScores(five, { now: NOW, squad: 'other' }).pooled.started, 0);
  assert.match(plansSummary(r5), /Plan completion · 80% · 4\/5 done/);
  assert.match(plansSummary(null), /no plan-tagged/);
});

test('Buddy handoff without a role field resolves via agent id -> role=brainstorm; case-insensitive Plan=', () => {
  const manual = { ts: NOW - 10 * DAY, lane: 'usage', squad: 'vibesquad', type: 'handoff', agent: 'rn-b1', text: 'manual handoff Plan=docs/PLAN_Y.md', plan: null };
  assert.equal(buildPlanScores([manual], { now: NOW }).pooled.started, 0); // unknown agent: not a Buddy
  const r = buildPlanScores([manual], { now: NOW, roleByAgent: new Map([['rn-b1', 'brainstorm'], ['rn-l1', 'lead']]) });
  assert.equal(r.pooled.started, 1);
  assert.equal(buildPlanScores([{ ...manual, agent: 'rn-l1' }], { now: NOW, roleByAgent: new Map([['rn-l1', 'lead']]) }).pooled.started, 0);
});
