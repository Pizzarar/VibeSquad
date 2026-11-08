import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isOwnerInput, wordCount } from '../scripts/audit-owner-stamps.mjs';

const cases = {
  'rubber stamp': ['send it', 'Send', 'yeah send it', 'yup send it!', 'go for a send', 'do it', 'yes', 'ok'],
  'real pick': ['a', 'B', '2', 'go for b', 'option c', '3'],
  'reply ok': ['reply ok', 'Reply OK.'],
  other: ['what is the status', 'fix the sidebar', 'not yet'],
};
for (const [bucket, phrases] of Object.entries(cases)) {
  test(`classify ${bucket}`, () => {
    for (const p of phrases) assert.equal(classify(p), bucket, p);
  });
}
test('owner input filter and word count', () => {
  assert.equal(isOwnerInput('From x: hi'), false);
  assert.equal(isOwnerInput('You are Foo'), false);
  assert.equal(isOwnerInput('x'.repeat(401)), false);
  assert.equal(isOwnerInput('send it'), true);
  assert.equal(wordCount(' a  b c '), 3);
});

import { isSystemNotice, isAgentReport, relayBucket, handoffBucket, fixerBucket, unitOf, isReviewer } from '../scripts/audit-owner-stamps.mjs';

test('system notices and forwarded reports are not relays', () => {
  for (const t of ['New team log event in vibesquad: x', 'Idea sent over from Perfection: x', 'Report to ★ Art5 (rn-0ac9049c7e0d).']) {
    assert.equal(isSystemNotice(t), true, t);
    assert.equal(isAgentReport(t), false, t);
  }
  assert.equal(isAgentReport('Bug2: PLAN_PIN_BRIEF_HOME PASS. B1+B2 116d2dc, merged'), true);
  assert.equal(isAgentReport('@usa B7 merged 26e9280 (Review-Gemini PASS)'), true);
  assert.equal(isAgentReport('i think the faces are meh, send it'), false);
});

const run = (o) => ({ outputs: 0, maxCtx: 0, inputs: [], labels: {}, cwd: '', ts: 1, ...o });

test('relayBucket separates owner-marked from unmarked and drops system notices', () => {
  const runs = [run({ id: 'b', role: 'brainstorm', inputs: [
    { ts: 1, text: 'UI3 lead: M3 PASS d6f3975', owner: true },
    { ts: 2, text: 'UI3 lead: M3 PASS d6f3975' },
    { ts: 3, text: 'Report to ★ Art5 (rn-0ac9049c7e0d).', owner: true },
    { ts: 4, text: 'From x: hi' },
  ] })];
  const r = relayBucket(runs);
  assert.deepEqual([r.strict, r.unmarkedUpperBound, r.systemOrForwardedExcluded], [1, 1, 1]);
});

test('handoffBucket excludes fixtures and splits by predecessor tokens', () => {
  const runs = [
    run({ id: 'p1', role: 'lead', team: 't', lane: 'l', maxCtx: 50000 }),
    run({ id: 'p2', role: 'lead', team: 't', lane: 'l', maxCtx: 250000 }),
    run({ id: 's1', role: 'lead', team: 't', lane: 'l', labels: { 'vs.handoff-from': 'p1', 'vs.handoff-trigger': 'self' } }),
    run({ id: 's2', role: 'lead', team: 't', lane: 'l', labels: { 'vs.handoff-from': 'p2', 'vs.handoff-trigger': 'auto-250' } }),
    run({ id: 's3', role: 'lead', team: 't', lane: 'l', labels: { 'vs.handoff-from': 'gone' } }),
    run({ id: 'f', role: 'lead', team: 'hub', lane: 'hub', cwd: '/tmp/handoff-test-abc' }),
  ];
  const r = handoffBucket(runs);
  assert.equal(r.fixtureRuns, 1);
  assert.deepEqual(r.handoffs, { total: 3, under100k: 1, atOrOver100k: 1, predecessorUnknown: 1 });
  assert.equal(r.churn['t/l'].runs, 5);
});

test('fixerBucket finds multi-worker, lane bounce and fix-after-merge; skips reviewers', () => {
  const w = (id, lane, text, profile = 'Implement - Sonnet', ts = 10) => run({ id, role: 'worker', lane, profile, ts, inputs: [{ text }] });
  const runs = [
    w('a', 'x', 'TASK: unit-foo-bar ROLE: implement'),
    w('b', 'y', 'TASK: unit-foo-bar ROLE: implement'),
    w('c', 'x', 'TASK: review unit-foo-bar R1 ROLE: review', 'Review - Gemini'),
    w('d', 'x', 'TASK: unit-foo-bar-fix ROLE: implement', 'Implement - Sonnet', 1000),
  ];
  const r = fixerBucket(runs, [{ ts: 500, branch: 'unit-foo-bar' }]);
  assert.deepEqual(r.multiWorker, [['unit-foo-bar', 2]]);
  assert.deepEqual(r.laneBounce, [['unit-foo-bar', 'x,y']]);
  assert.deepEqual(r.fixAfterMerge, [['unit-foo-bar-fix', 'unit-foo-bar']]);
  assert.equal(unitOf('Branch unit-a-b, commit'), 'unit-a-b');
  assert.equal(isReviewer('Review - Gemini', 'x'), true);
});
