import "./setup/hermetic.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileFindings, staleUsageReviewFindings, transcriptFindings, newModelFindings, AUDIT_SOURCE } from '../scripts/audit-perfection.mjs';
import { readInboxCards, addInboxCards } from '../server/inbox.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-audit-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} } });
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
  cards[0].updatedAt = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(cards));
  assert.equal(fileFindings([f('k')], { baseHome }).filed.length, 1);
});

for (const status of ['archived', 'rejected']) {
  test(`a key on a ${status} card is not re-filed within 14 days, but is after`, () => {
    const baseHome = tmp();
    fileFindings([f('scriptable:abc')], { baseHome });
    const file = path.join(baseHome, 'inbox.json');
    const cards = JSON.parse(fs.readFileSync(file, 'utf8'));
    cards[0].status = status;
    cards[0].updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(cards));
    const r = fileFindings([f('scriptable:abc')], { baseHome });
    assert.equal(r.filed.length, 0);
    assert.deepEqual(r.skipped, ['scriptable:abc']);
    const later = Date.now() + 15 * 24 * 3600 * 1000;
    assert.equal(fileFindings([f('scriptable:abc')], { baseHome, now: later }).filed.length, 1);
  });
}

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
  addInboxCards({ ideas: ['Old review bullet about loops'], laneId: 'perfection', source: 'usage-review:opus', baseHome });
  addInboxCards({ ideas: ['Other lane review bullet'], laneId: 'bug-chaser', source: 'usage-review:opus', baseHome });
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

test('newModelFindings flags a new catalog model once, ignores ladder models and effort variants, and dedupes across runs', async () => {
  const baseHome = tmp();
  const ladder = {
    claude: {
      top: { model: 'claude-opus-5-5', effort: 'high' },
      mid: { model: 'claude-sonnet-5-5', effort: 'medium' },
    },
    'antigravity-cli': {
      top: { model: 'gemini-4-neon', effort: 'high' },
      cheap: { model: 'gemini-3.8-flash' },
    },
  };
  const catalog = {
    claude: {
      provider: 'claude',
      models: [
        { id: 'claude-opus-5-5', source: 'built-in' },
        { id: 'claude-sonnet-5-5-high', source: 'built-in' },
      ],
    },
    'antigravity-cli': {
      provider: 'antigravity-cli',
      models: [
        { id: 'gemini-4-neon-low', source: 'cli probe' },
        { id: 'gemini-4-neon-high', source: 'cli probe' },
        { id: 'gemini-4-argon-high', source: 'cli probe' },
        { id: 'gemini-3.8-flash', source: 'cli probe' },
        { id: 'gemini-4-carbon-low', source: 'cli probe' },
        { id: 'gemini-4-carbon-high', source: 'cli probe' },
      ],
    },
  };

  const findings = await newModelFindings({ catalog, ladder });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'new-model:antigravity-cli/gemini-4-carbon');
  assert.equal(findings[0].text, 'antigravity-cli/gemini-4-carbon seen in catalog, not on ladder: trial it as an arm?');
  assert.match(findings[0].evidence, /providers-catalog antigravity-cli/);

  const first = fileFindings(findings, { baseHome });
  assert.equal(first.filed.length, 1);
  const cards = readInboxCards(baseHome);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].laneId, 'perfection');
  assert.equal(cards[0].source, AUDIT_SOURCE);
  assert.match(cards[0].text, /antigravity-cli\/gemini-4-carbon seen in catalog, not on ladder: trial it as an arm\?/);

  const second = fileFindings(await newModelFindings({ catalog, ladder }), { baseHome });
  assert.equal(second.filed.length, 0);
  assert.deepEqual(second.skipped, ['new-model:antigravity-cli/gemini-4-carbon']);
  assert.equal(readInboxCards(baseHome).length, 1);
});

test('newModelFindings respects stored ladder overrides in baseHome', async () => {
  const baseHome = tmp();
  fs.writeFileSync(
    path.join(baseHome, 'stakes-ladder.json'),
    JSON.stringify({ 'antigravity-cli': { mid: { model: 'gemini-4-carbon' } } }),
  );
  const catalog = {
    'antigravity-cli': {
      provider: 'antigravity-cli',
      models: [
        { id: 'gemini-4-neon-high', source: 'cli probe' },
        { id: 'gemini-4-carbon-medium', source: 'cli probe' },
      ],
    },
  };
  const findings = await newModelFindings({ baseHome, catalog });
  assert.deepEqual(findings, []);
});

test('newModelFindings returns no findings and does not throw when catalog read fails', async () => {
  const ladder = { claude: { top: { model: 'claude-opus-5-5' } } };
  const warnings = [];
  const asyncFail = await newModelFindings({
    readCatalog: async () => { throw new Error('provider offline'); },
    ladder,
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(asyncFail, []);

  const syncFail = await newModelFindings({
    readCatalog: () => { throw new Error('ENOENT'); },
    ladder,
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(syncFail, []);
  assert.equal(warnings.length, 2);
});

test('newModelFindings skips cross-provider models and orchestrator wrappers while keeping same-family models', async () => {
  const ladder = {
    claude: { top: { model: 'claude-opus-5-5' }, mid: { model: 'claude-sonnet-5-5' } },
    'antigravity-cli': { top: { model: 'gemini-4-neon' }, cheap: { model: 'gemini-3.8-flash' } },
  };
  const catalog = {
    claude: {
      provider: 'claude',
      models: [
        { id: 'claude-opus-5-5', source: 'built-in' },
        { id: 'claude-sonnet-5-5', source: 'built-in' },
        { id: 'claude-haiku-5-5', source: 'built-in' },
        { id: 'claude-fable-5-1', source: 'built-in' },
      ],
    },
    'antigravity-cli': {
      provider: 'antigravity-cli',
      models: [
        { id: 'gemini-4-neon-high', source: 'cli probe' },
        { id: 'gemini-4-carbon-medium', source: 'cli probe' },
        { id: 'gemini-4-hydrogen-high', source: 'cli probe' },
        { id: 'gemini-pro-orchestrator', source: 'cli probe' },
        { id: 'gemini-pro-orchestrator-neon', source: 'cli probe' },
        { id: 'gemini-pro-orchestrator-argon', source: 'cli probe' },
        { id: 'claude-opus-5-5-low', source: 'cli probe' },
        { id: 'claude-sonnet-5-5-low', source: 'cli probe' },
        { id: 'gpt-oss-120b-medium', source: 'cli probe' },
      ],
    },
  };
  const findings = await newModelFindings({ catalog, ladder });
  assert.deepEqual(
    findings.map((x) => x.key),
    [
      'new-model:claude/claude-haiku-5-5',
      'new-model:claude/claude-fable-5-1',
      'new-model:antigravity-cli/gemini-4-carbon',
      'new-model:antigravity-cli/gemini-4-hydrogen',
    ],
  );
});

for (const status of ['archived', 'rejected']) {
  test(`a ${status} new-model: key never re-files even past the 14-day judged window`, () => {
    const baseHome = tmp();
    const finding = {
      key: 'new-model:antigravity-cli/gemini-4-hydrogen',
      text: 'antigravity-cli/gemini-4-hydrogen seen in catalog, not on ladder: trial it as an arm?',
      evidence: 'providers-catalog antigravity-cli (gemini-4-hydrogen, cli probe) not on stakes-ladder',
    };
    assert.equal(fileFindings([finding], { baseHome }).filed.length, 1);
    const file = path.join(baseHome, 'inbox.json');
    const cards = JSON.parse(fs.readFileSync(file, 'utf8'));
    cards[0].status = status;
    cards[0].updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(cards));
    const wayLater = Date.now() + 90 * 24 * 3600 * 1000;
    const r = fileFindings([finding], { baseHome, now: wayLater });
    assert.equal(r.filed.length, 0);
    assert.deepEqual(r.skipped, ['new-model:antigravity-cli/gemini-4-hydrogen']);
  });
}

test('newModelFindings logs a warning when live probe fails and falls back to static catalog', async () => {
  const warnings = [];
  const ladder = { 'antigravity-cli': { top: { model: 'gemini-4-neon' } } };
  const findings = await newModelFindings({
    ladder,
    probeLists: async () => ({
      'antigravity-cli': { models: [], source: 'static', at: null, error: 'timed out after 15000ms' },
    }),
    loadCatalog: () => ({ 'antigravity-cli': { provider: 'antigravity-cli', models: [] } }),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(findings, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /antigravity-cli/);
  assert.match(warnings[0], /static/);
  assert.match(warnings[0], /timed out/);
});

test('newModelFindings checks a gpt-* model under the openai provider instead of skipping it', async () => {
  const ladder = { openai: { top: { model: 'gpt-5-top' } } };
  const catalog = { openai: { provider: 'openai', models: [{ id: 'gpt-5-top' }, { id: 'gpt-6-new' }] } };
  const findings = await newModelFindings({ catalog, ladder });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'new-model:openai/gpt-6-new');
});
