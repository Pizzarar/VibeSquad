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

import { isImplementer, classifySuccessor, ownUnitFromText } from '../scripts/audit-owner-stamps.mjs';

const wk = (o) => run({ role: 'worker', profile: 'Implement - Sonnet', outputs: 5, lastStatus: 'idle', ...o, inputs: [{ text: o.text || 'TASK: unit-x ROLE: implement' }] });

test('isImplementer excludes digests, art duet, leads, reviewers, verify/triage/pre-check', () => {
  assert.equal(isImplementer(wk({ id: 'a' })), true);
  assert.equal(isImplementer(wk({ id: 'a', labels: { job: 'fix B6 review' } })), true);
  assert.equal(isImplementer(wk({ id: 'b', labels: { digestFor: 'rn-1' } })), false);
  assert.equal(isImplementer(wk({ id: 'b', profile: 'Pre-check - Flash', text: 'You are a digest agent. Inspect' })), false);
  assert.equal(isImplementer(wk({ id: 'c', text: 'You are a digest agent. Inspect the final result' })), false);
  for (const profile of ['Art Painter - Opus', 'Art Director - Gemini', 'Review - Gemini', 'Lead - Claude']) assert.equal(isImplementer(wk({ id: 'd', profile })), false, profile);
  for (const job of ['C2 joint verify', 'triage AGY test fails', 'spawn probe 3', 'review D5']) assert.equal(isImplementer(wk({ id: 'e', labels: { job } })), false, job);
  assert.equal(isImplementer(run({ id: 'f', role: 'lead', inputs: [{ text: 'x' }] })), false);
});

test('ownUnitFromText ignores units named only in prose', () => {
  assert.equal(ownUnitFromText('Branch `unit-a-b` (0e44c2e)'), 'unit-a-b');
  assert.equal(ownUnitFromText('@bugc B5 `unit-resume-x`. You are'), 'unit-resume-x');
  assert.equal(ownUnitFromText('Doc-only task, read merged unit-stream-s2 for context'), null);
});

test('classifySuccessor covers the five classes', () => {
  const pred = wk({ id: 'p', ts: 1000, endTs: 2000, labels: { job: 'B1 foo' } });
  const next = (o) => wk({ id: 'n', ts: 3000, endTs: 4000, ...o });
  assert.equal(classifySuccessor(wk({ id: 'p', outputs: 0, lastStatus: 'queued' }), next({})), 'respawn after stall');
  assert.equal(classifySuccessor(wk({ id: 'p', lastStatus: 'running' }), next({})), 'respawn after stall');
  assert.equal(classifySuccessor(pred, next({ labels: { job: 'B1 foo' } })), 'duplicate dispatch');
  assert.equal(classifySuccessor(pred, next({ ts: 2010, labels: { job: 'other' } })), 'duplicate dispatch');
  assert.equal(classifySuccessor(pred, next({ labels: { job: 'B1 fix1' } })), 'review-fix round');
  assert.equal(classifySuccessor(pred, next({ ts: 2000 + 2 * 3600 * 1000, labels: { job: 'B1 rework' } })), 'lead re-dispatch');
  assert.equal(classifySuccessor(pred, next({ ts: 2000 + 600000, labels: { job: 'B2 next block' } })), 'follow-up');
  assert.equal(classifySuccessor(pred, next({ ts: 2000 + 2 * 3600 * 1000, labels: { job: 'B1 rebase' } })), 'follow-up');
});

test('fixerBucket counts only implementers and classes each unit by its worst successor', () => {
  const d = (i) => wk({ id: 'd' + i, labels: { digestFor: 'rn-a' }, text: 'TASK: unit-u ROLE: x' });
  const runs = [
    wk({ id: 'a', ts: 1000, endTs: 2000, labels: { job: 'U one' }, text: 'Branch unit-u' }),
    d(1), d(2),
    wk({ id: 'b', ts: 3000, endTs: 4000, labels: { job: 'U fix1' }, text: 'Branch unit-u' }),
    wk({ id: 'solo', labels: { job: 'S' }, text: 'Branch unit-solo' }),
  ];
  const r = fixerBucket(runs);
  assert.deepEqual(r.multiWorker, [['unit-u', 2]]);
  assert.deepEqual(r.classes['review-fix round'], ['unit-u']);
  assert.equal(r.successorClasses['review-fix round'], 1);
});

// ---- S6 bucket 5: fix offered as a question. Fixtures are trimmed real @ui-bois (and one @site-polish) agent outputs. ----
import { offersFix, fixOfferBucket } from '../scripts/audit-owner-stamps.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIX_OFFERS = [
  'Gemini passed it and @usa is OK with it. **It needs your OK**, then it merges after the sky fix.\n\nThe deadlock is a VibeSquad bug: a Buddy can\'t replace a live lead. Want me to send it to @bug?',
  'The bug: when needs-you is set or cleared, the time it was set isn\'t recorded. It also skews the oldest-first order in the queue we just shipped.\n\nOne screenshot caught a setup checklist instead of the menu. That\'s only the evidence file; the fix itself isn\'t affected.\n\nShould I send the timestamp fix to the lead?',
  'I lean toward sending it to UI3 as a tiny M3: a one-line fix plus a test.\n\nAfter that, the only thing left in this lane is Squad floor Phase 2, which is waiting on @art. Send M3?',
  'For Phase 2 there are two ways to go:\n- **(a)** Wait for @art to unblock the floor frame.\n- **(b)** Build the floor now with plain CSS desks, then swap the art in later.\n\nI lean (b). The layout and markers don\'t depend on what the art looks like.\n\nGo on spawning a lead for B2?',
  'The time it was set isn\'t recorded, so the queue shows the age from the first flag. I lean toward giving it to the same lead as a tiny M2 once M1 merges. Okay with that?',
  '**The real fix** is getting those changes off master. Until then, every build skips this step, for you and for every lead.\n\nThe Android App lane has a Buddy but no lead running. Want me to ask that Buddy to put the changes on a branch or commit them?',
  'It\'s a small fix: `setNeedsYou` and `clearNeedsYou` in `src/paseo.ts:328-340` should also set and clear the timestamp.\n\nIf you want it done now, say so and I\'ll dispatch it. One Implement - Sonnet worker would do it, then a Review - Gemini pass.',
];
const NOT_FIX_OFFERS = [
  // owner approval of an already-built thing / real owner decision, not a fix offer
  'P4b passed Gemini and the screenshots are in the lane folder.\n\nDo you OK P4b so it can merge and V1 can start?',
  'Two layouts are possible.\n\nWhich layout?',
  // option list, no stated lean: a real choice
  'There are two ways to go:\n- **(a)** keep UI3 parked until @art delivers\n- **(b)** start Phase 2 now with plain CSS desks\n\nWant me to write the plan for whichever you pick?',
  // question that itself offers alternatives
  'Both are ready.\n\nWant me to spawn the Lead for **A**, or fold them in for **B**?',
  // risky step confirmations
  'If you\'d rather, I can run the build myself. It only rebuilds and copies into the app, but it does replace the app you\'re running, so say the word first.',
  'The stale worktree is still on disk.\n\nWant me to delete it and force-push the cleaned branch?',
  // statements and short text
  'Done. Merged 7a638bf and pushed.',
  'ok?',
];
test('offersFix catches real fix-offer messages', () => {
  FIX_OFFERS.forEach((t, i) => assert.equal(offersFix(t), true, `fixture ${i}`));
});
test('offersFix skips real choices, owner approvals and risky steps', () => {
  NOT_FIX_OFFERS.forEach((t, i) => assert.equal(offersFix(t), false, `near-miss ${i}`));
});
test('fixOfferBucket counts per lane and role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-'));
  const ev = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(dir, 'rn-a.jsonl'), [
    ev({ type: 'created', ts: 1, meta: { lane: 'ui-bois', role: 'brainstorm' } }),
    ev({ type: 'output', ts: 2, text: FIX_OFFERS[0] }),
    ev({ type: 'output', ts: 3, text: NOT_FIX_OFFERS[1] }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'rn-b.jsonl'), [
    ev({ type: 'created', ts: 1, meta: { lane: 'art', role: 'worker' } }),
    ev({ type: 'output', ts: 2, text: FIX_OFFERS[2] }),
  ].join('\n'));
  const r = fixOfferBucket(dir);
  assert.equal(r.total, 2);
  assert.equal(r.outputs, 3);
  assert.deepEqual(r.byLane, { 'ui-bois': 1, art: 1 });
  assert.deepEqual(r.byRole, { brainstorm: 1, worker: 1 });
  assert.equal(fixOfferBucket(dir, { since: 3 }).total, 0);
});
