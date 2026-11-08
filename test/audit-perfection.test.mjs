import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileFindings, staleUsageReviewFindings, transcriptFindings, AUDIT_SOURCE } from '../scripts/audit-perfection.mjs';
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

test('daily series: an open card of the same series is updated in place, not duplicated', () => {
  const baseHome = tmp();
  const day = (d, n) => ({ key: `rubber-stamps:${d}`, text: `${n} owner rubber-stamp replies.`, evidence: `bucket 1, ${n}` });
  fileFindings([day('2026-11-07', 17)], { baseHome });
  const r = fileFindings([day('2026-11-08', 9)], { baseHome });
  assert.equal(r.filed.length, 0);
  assert.equal(r.updated.length, 1);
  const cards = readInboxCards(baseHome);
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /9 owner rubber-stamp/);
  assert.match(cards[0].text, /audit-key: rubber-stamps:2026-11-08/);
  assert.equal(fileFindings([day('2026-11-08', 9)], { baseHome }).skipped.length, 1);
  assert.equal(readInboxCards(baseHome).length, 1);
});

test('series update refreshes the title too', () => {
  const baseHome = tmp();
  fileFindings([{ key: 'rubber-stamps:2026-11-07', text: '17 owner rubber-stamp replies.', evidence: 'b1' }], { baseHome });
  fileFindings([{ key: 'rubber-stamps:2026-11-08', text: '3 owner rubber-stamp replies.', evidence: 'b1' }], { baseHome });
  const [c] = readInboxCards(baseHome);
  assert.match(c.title, /^3 owner/);
});

test('early-handoffs only counts handoffs inside the window', () => {
  const dir = tmp();
  const ev = (o) => JSON.stringify(o) + '\n';
  const day = 24 * 3600 * 1000, now = Date.now();
  const lead = (id, ts, from) => ev({ type: 'created', ts, cwd: 'C:/x', meta: { role: 'lead', lane: 'a', team: 't', labels: from ? { 'vs.handoff-from': from } : {} } });
  const old = now - 10 * day;
  fs.writeFileSync(path.join(dir, 'p.jsonl'), lead('p', old - day) + ev({ type: 'usage', ts: old - day, contextTokens: 50000 }));
  fs.writeFileSync(path.join(dir, 's.jsonl'), lead('s', old, 'p'));
  const noRepo = tmp();
  const since = now - day;
  assert.equal(transcriptFindings({ dir, since, repo: noRepo, now }).some((f) => f.key.startsWith('early-handoffs')), false);
  assert.equal(transcriptFindings({ dir, since: old - 1, repo: noRepo, now }).some((f) => f.key.startsWith('early-handoffs')), true);
});

test('vs inbox add --source tags the card', () => {
  const home = tmp();
  const vs = path.resolve(import.meta.dirname, '..', 'cli', 'vs.mjs');
  execFileSync(process.execPath, [vs, 'inbox', 'add', 'Check the sidebar density', '--lane', 'perfection', '--source', 'audit:perfection'], { env: { ...process.env, VIBESQUAD_HOME: home }, stdio: 'pipe' });
  const [c] = readInboxCards(home);
  assert.equal(c.source, 'audit:perfection');
  assert.equal(c.laneId, 'perfection');
});
