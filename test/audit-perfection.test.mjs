import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileFindings, staleUsageReviewFindings, AUDIT_SOURCE } from '../scripts/audit-perfection.mjs';
import { readInboxCards, addInboxCards } from '../server/inbox.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-audit-'));
const f = (key, extra = {}) => ({ key, text: `Panel ${key} opens expanded.`, evidence: `src/X.tsx:10 ${key}`, ...extra });

test('files with source audit:perfection, lane perfection, and a second run files nothing', () => {
  const baseHome = tmp();
  const a = fileFindings([f('ui-compact:a'), f('ui-compact:b')], { baseHome });
  assert.equal(a.filed.length, 2);
  const cards = readInboxCards(baseHome);
  assert.equal(cards.length, 2);
  for (const c of cards) { assert.equal(c.source, AUDIT_SOURCE); assert.equal(c.laneId, 'perfection'); assert.match(c.text, /Evidence: src\/X\.tsx:10/); }
  const b = fileFindings([f('ui-compact:a'), f('ui-compact:b')], { baseHome });
  assert.equal(b.filed.length, 0);
  assert.deepEqual(b.skipped, ['ui-compact:a', 'ui-compact:b']);
  assert.equal(readInboxCards(baseHome).length, 2);
});

test('dedupes within a batch, refiles once the old item is closed, dry-run writes nothing', () => {
  const baseHome = tmp();
  assert.equal(fileFindings([f('k'), f('k')], { baseHome, dryRun: true }).filed.length, 1);
  assert.equal(readInboxCards(baseHome).length, 0);
  assert.equal(fileFindings([f('k'), f('k')], { baseHome }).filed.length, 1);
  const file = path.join(baseHome, 'inbox.json');
  const cards = JSON.parse(fs.readFileSync(file, 'utf8'));
  cards[0].status = 'archived';
  fs.writeFileSync(file, JSON.stringify(cards));
  assert.equal(fileFindings([f('k')], { baseHome }).filed.length, 1);
});

test('risky findings call needsYou only when filed; missing evidence throws', () => {
  const baseHome = tmp();
  const seen = [];
  fileFindings([f('r', { risky: true }), f('n')], { baseHome, needsYou: (t) => seen.push(t) });
  fileFindings([f('r', { risky: true })], { baseHome, needsYou: (t) => seen.push(t) });
  assert.equal(seen.length, 1);
  assert.throws(() => fileFindings([{ key: 'x', text: 't' }], { baseHome }), /evidence/);
});

test('stale usage-review items older than 3 days become findings', () => {
  const baseHome = tmp();
  addInboxCards({ ideas: ['Old review bullet about loops'], laneId: 'bug-chaser', source: 'usage-review:opus', baseHome });
  addInboxCards({ ideas: ['Unrelated manual idea'], laneId: 'bug-chaser', source: 'ui', baseHome });
  const now = Date.now() + 4 * 24 * 3600 * 1000;
  const out = staleUsageReviewFindings({ baseHome, now });
  assert.equal(out.length, 1);
  assert.match(out[0].key, /^stale-usage-review:idea-/);
  assert.equal(staleUsageReviewFindings({ baseHome, now: Date.now() }).length, 0);
});
