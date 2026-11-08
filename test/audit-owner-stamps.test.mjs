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
