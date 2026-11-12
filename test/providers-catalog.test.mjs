import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalog, buildUsageReviewPrompt, clearProbeCache, clearUsageCache, DEFAULT_USAGE_REVIEW_PROMPT, getModels, getProviders, getUsage, handleProvidersApi, intervalMs,
  loadRunnerSettings, loadUsageReviewPrompt, LOOP_TURN_THRESHOLD, normalizeRunnerSettings, oneShotReviewRun, parseReviewBullets, probeProviders, probeStats,
  readBootSizes, foldBootSizes, readMergedUnits, readUsageLedger, readUsageLogSignals, readUsageReviews, resetUsageReviewPromptWarnForTest, resolveUsageReviewPromptPath,
  runUsageReview, saveRunnerSettings, syncUsageLedger, USAGE_REVIEW_PROMPT_REL_PATH, usageStats, withPoolAgents,
} from '../server/providers-catalog.mjs';
import { saveUserSettings, loadUserSettings, saveRemoteAccess } from '../server/user-settings.mjs';
import { addInboxCards, readInboxCards, triageInboxCards } from '../server/inbox.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-catalog-'));
// Declares a temp dir as "the real ~/.vibesquad" (VS_TEST_REAL_HOME) so forbidden-home guards are exercised without touching the developer's actual home.
function withFakeRealHome(fn) {
  const fakeReal = tmp();
  const prev = process.env.VS_TEST_REAL_HOME;
  process.env.VS_TEST_REAL_HOME = fakeReal;
  try { return fn(fakeReal); } finally { prev === undefined ? delete process.env.VS_TEST_REAL_HOME : (process.env.VS_TEST_REAL_HOME = prev); }
}
const okExec = (file, args, o, cb) => cb(null, `${path.basename(file)} 1.2.3\n`);
const resolveImpl = (cmd) => {
  if (cmd === 'opencode') throw new Error('nope');
  return { file: `/bin/${cmd}`, args: [] };
};
const noGit = () => '';
const probeOpts = { execImpl: okExec, resolveImpl, git: noGit };

test('catalog shape matches the daemon payloads the dropdowns consume', async () => {
  const home = tmp();
  clearProbeCache();
  const { providers } = await getProviders({ home, ...probeOpts });
  const ids = providers.map((p) => p.provider).sort();
  assert.deepEqual(ids, ['antigravity-cli', 'claude', 'codex', 'opencode']);
  const claude = providers.find((p) => p.provider === 'claude');
  assert.equal(claude.available, true);
  assert.equal(claude.version, 'claude 1.2.3');
  assert.equal(providers.find((p) => p.provider === 'opencode').available, false);
  assert.match(providers.find((p) => p.provider === 'opencode').error, /not found/);
  const { models } = await getModels('claude', { home, ...probeOpts });
  assert.ok(models.every((m) => typeof m.id === 'string' && typeof m.label === 'string'));
  assert.ok(models.some((m) => m.id === 'claude-opus-5-5'));
  assert.ok(buildCatalog({ home }).claude.modes.some((m) => m.id === 'auto'));
  const agy = await getModels('agy', { home, ...probeOpts });
  assert.ok(agy.models.some((m) => m.id === 'gemini-4-argon'), 'profile models are folded in, alias resolves');
});

test('probe results are cached until refresh or TTL', async () => {
  clearProbeCache();
  const before = probeStats().runs;
  await probeProviders({ now: 1000, ...probeOpts });
  await probeProviders({ now: 2000, ...probeOpts });
  assert.equal(probeStats().runs - before, 4, 'second call hits the cache');
  await probeProviders({ now: 3000, refresh: true, ...probeOpts });
  assert.equal(probeStats().runs - before, 8);
  await probeProviders({ now: 3000 + 11 * 60_000, ...probeOpts });
  assert.equal(probeStats().runs - before, 12, 'expired entries reprobe');
});

test('settings merge-save keeps other keys and normalises', () => {
  const home = tmp();
  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ userName: 'Zed', custom: { keep: 1 }, runner: { other: true, providers: { claude: { models: ['a'] } } } }));
  const saved = saveRunnerSettings({ providers: { claude: { enabled: false, models: ['a'] }, agy: { models: ['m1', 'm1', ' m2 '], defaultModel: 'm2' } } }, home);
  assert.deepEqual(saved.providers.claude, { enabled: false, models: ['a'] });
  assert.deepEqual(saved.providers['antigravity-cli'], { models: ['m1', 'm2'], defaultModel: 'm2' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.userName, 'Zed');
  assert.deepEqual(raw.custom, { keep: 1 });
  assert.equal(raw.runner.other, true);
  assert.deepEqual(loadRunnerSettings(home), saved);
  assert.equal(saveRunnerSettings({ providers: { claude: null } }, home).providers.claude, undefined);
  saveUserSettings({ userName: 'Y' }, home);
  assert.ok(loadUserSettings(home).runner);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runner.providers['antigravity-cli'].defaultModel, 'm2');
});

test('settings drive the catalog (extra models, disabled provider)', () => {
  const home = tmp();
  saveRunnerSettings({ providers: { codex: { models: ['gpt-x'], enabled: false } } }, home);
  const c = buildCatalog({ home, probes: [{ provider: 'codex', available: true }] });
  assert.ok(c.codex.models.some((m) => m.id === 'gpt-x'));
  assert.equal(c.codex.available, false);
});

const ev = (o) => JSON.stringify(o) + '\n';
test('usage rollup by provider/model/lane/day, incremental and lazy', () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d1 = Date.UTC(2026, 10, 1, 12), d2 = Date.UTC(2026, 10, 2, 12);
  const a = path.join(dir, 'rn-a.jsonl');
  fs.writeFileSync(a,
    ev({ seq: 0, ts: d1, type: 'created', provider: 'claude', model: 'm-1', meta: { lane: 'x' } }) +
    ev({ seq: 1, ts: d1, type: 'turn_done', costUsd: 1 }) +
    ev({ seq: 2, ts: d2, type: 'turn_done', costUsd: 1.5 }));
  fs.writeFileSync(path.join(dir, 'rn-b.jsonl'),
    ev({ seq: 0, ts: d1, type: 'created', provider: 'codex', model: 'g', meta: { lane: 'y' } }) +
    ev({ seq: 1, ts: d1, type: 'turn_done' }) + 'not json\n');
  clearUsageCache();
  let u = getUsage({ home, git: noGit });
  assert.equal(u.files, 2);
  assert.equal(u.totals.turns, 3);
  assert.ok(Math.abs(u.totals.costUsd - 1.5) < 1e-9, 'cumulative cost counted as deltas');
  assert.equal(u.byProvider.find((r) => r.provider === 'claude').turns, 2);
  assert.equal(u.byDay.length, 2);
  assert.equal(u.byLane.find((r) => r.lane === 'x').costUsd, 1.5);
  assert.equal(getUsage({ home, since: '2026-11-02', git: noGit }).totals.turns, 1);
  const read = usageStats().readBytes;
  getUsage({ home, git: noGit });
  assert.equal(usageStats().readBytes, read, 'unchanged files are not re-read');
  const size = fs.statSync(a).size;
  fs.appendFileSync(a, ev({ seq: 3, ts: d2, type: 'turn_done', costUsd: 2 }) + '{"seq":4,"ts":');
  u = getUsage({ home, git: noGit });
  assert.equal(u.totals.turns, 4);
  assert.ok(Math.abs(u.totals.costUsd - 2) < 1e-9);
  assert.ok(usageStats().readBytes - read <= fs.statSync(a).size - size, 'only the tail was read');
  fs.appendFileSync(a, `${d2},"type":"turn_done","costUsd":2.25}\n`);
  assert.equal(getUsage({ home, git: noGit }).totals.turns, 5);
  fs.rmSync(a);
  assert.equal(getUsage({ home, git: noGit }).files, 1);
  assert.equal(getUsage({ home: tmp(), git: noGit }).totals.turns, 0);
});

test('HTTP handler routes', async () => {
  const home = tmp();
  const call = async (method, url, body) => {
    let out;
    await handleProvidersApi({ method, url }, {}, {
      home, ...probeOpts,
      readBody: async () => body,
      sendJson: (_r, code, data) => { out = { code, data }; },
    });
    return out;
  };
  assert.equal((await call('GET', '/__vibesquad/providers')).code, 200);
  assert.ok((await call('GET', '/__vibesquad/providers/modes?provider=claude')).data.modes.length > 0);
  assert.equal((await call('GET', '/__vibesquad/providers/usage')).data.totals.turns, 0);
  const saved = await call('POST', '/__vibesquad/providers/settings', { runner: { providers: { opencode: { models: ['z'] } } } });
  assert.deepEqual(saved.data.runner.providers.opencode.models, ['z']);
  assert.equal((await call('GET', '/__vibesquad/providers/nope')).code, 404);
  assert.equal((await call('DELETE', '/__vibesquad/providers')).code, 405);
});

test('settings save: atomic, no temp leftovers, refuses to clobber unparseable settings.json', () => {
  const home = tmp();
  const file = path.join(home, 'settings.json');
  saveRunnerSettings({ providers: { claude: { models: ['a'] } } }, home);
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith('.tmp')), []);
  const bad = '{"userName": "Zed", "custom": {';
  fs.writeFileSync(file, bad);
  assert.throws(() => saveRunnerSettings({ providers: { claude: { models: ['b'] } } }, home), /refusing to save/);
  assert.throws(() => saveUserSettings({ userName: 'Q' }, home), /refusing to save/);
  assert.throws(() => saveRemoteAccess(true, home), /refusing to save/);
  assert.equal(fs.readFileSync(file, 'utf8'), bad, 'unparseable file left untouched');
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith('.tmp')), []);
});

test('settings save: clearing a field clears it (replace per provider)', () => {
  const home = tmp();
  saveRunnerSettings({ providers: { claude: { enabled: false, models: ['a', 'b'], modes: ['m'], defaultModel: 'a', defaultMode: 'm' } } }, home);
  let s = saveRunnerSettings({ providers: { claude: { enabled: false, models: [], modes: [], defaultModel: '  ', defaultMode: '' } } }, home);
  assert.deepEqual(s.providers.claude, { enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).runner.providers.claude, { enabled: false });
  saveRunnerSettings({ providers: { codex: { models: ['x'] }, claude: { models: ['q'] } } }, home);
  s = saveRunnerSettings({ providers: { claude: { models: [] } } }, home);
  assert.equal(s.providers.claude, undefined, 'fully emptied provider is removed');
  assert.deepEqual(s.providers.codex, { models: ['x'] }, 'providers absent from the patch are untouched');
});

test('usage rollup: invalid ts skips the event but offsets advance; lane from meta patch; tokens from usage events', () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d1 = Date.UTC(2026, 10, 1, 12);
  const a = path.join(dir, 'rn-a.jsonl');
  const body =
    ev({ seq: 0, ts: d1, type: 'created', provider: 'claude', model: 'm-1', meta: {} }) +
    ev({ seq: 1, ts: d1, type: 'meta', patch: { lane: 'lane-a' } }) +
    ev({ seq: 2, ts: 'garbage', type: 'turn_done', costUsd: 1 }) +
    ev({ seq: 3, ts: 1e20, type: 'usage', inputTokens: 5, outputTokens: 1 }) +
    ev({ seq: 4, ts: d1, type: 'usage', inputTokens: 100, outputTokens: 20 }) +
    ev({ seq: 5, ts: d1, type: 'usage', contextTokens: 999, contextMax: 1000 }) +
    ev({ seq: 6, ts: d1, type: 'turn_done', costUsd: 3 });
  fs.writeFileSync(a, body);
  clearUsageCache();
  let u = getUsage({ home, git: noGit });
  assert.equal(u.totals.turns, 1, 'bad-ts turn skipped, good one counted');
  assert.equal(u.byLane.find((r) => r.lane === 'lane-a').turns, 1);
  assert.equal(u.totals.inputTokens, 100);
  assert.equal(u.totals.outputTokens, 20);
  assert.ok(Math.abs(u.totals.costUsd - 2) < 1e-9, 'cost delta from the skipped turn is not double counted');
  const read = usageStats().readBytes;
  getUsage({ home, git: noGit });
  assert.equal(usageStats().readBytes, read, 'offset advanced past the bad line; nothing re-read');
  fs.appendFileSync(a, ev({ seq: 7, ts: d1, type: 'meta', patch: { labels: { lane: 'lane-b' } } }) + ev({ seq: 8, ts: d1, type: 'turn_done', costUsd: 4 }));
  u = getUsage({ home, git: noGit });
  assert.equal(u.totals.turns, 2);
  assert.equal(u.byLane.find((r) => r.lane === 'lane-b').turns, 1);
});

test('isGatedRead gates providers ?refresh=1 for non-owners', async () => {
  const { isGatedRead } = await import('../server/vibesquad-api.mjs');
  assert.equal(isGatedRead('/__vibesquad/providers', '/__vibesquad/providers?refresh=1'), true);
  assert.equal(isGatedRead('/__vibesquad/providers/models', '/__vibesquad/providers/models?provider=claude&refresh=1'), true);
  assert.equal(isGatedRead('/__vibesquad/providers', '/__vibesquad/providers'), false);
});

test('writeSettingsAtomic: unique tmp per call, retries EPERM/EACCES/EBUSY, cleans tmp on final failure', async () => {
  const { writeSettingsAtomic } = await import('../server/user-settings.mjs');
  const home = tmp();
  const file = path.join(home, 'settings.json');
  const seen = [];
  const spy = (a, b) => { seen.push(a); fs.renameSync(a, b); };
  writeSettingsAtomic(file, { n: 1 }, { renameImpl: spy });
  writeSettingsAtomic(file, { n: 2 }, { renameImpl: spy });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'tmp names differ even within the same millisecond');
  // transient EPERM then success
  let calls = 0;
  const naps = [];
  const flaky = (a, b) => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' }); fs.renameSync(a, b); };
  writeSettingsAtomic(file, { n: 3 }, { renameImpl: flaky, sleepImpl: (ms) => naps.push(ms) });
  assert.equal(calls, 3);
  assert.equal(naps.length, 2);
  assert.ok(naps[1] > naps[0], 'backoff grows');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3);
  // persistent failure: gives up, no tmp left, original intact
  const always = () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); };
  assert.throws(() => writeSettingsAtomic(file, { n: 4 }, { renameImpl: always, sleepImpl: () => {}, retries: 2 }), /locked/);
  assert.deepEqual(fs.readdirSync(home), ['settings.json']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3);
  // non-retryable code throws immediately
  let n2 = 0;
  assert.throws(() => writeSettingsAtomic(file, {}, { renameImpl: () => { n2++; throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, sleepImpl: () => {} }));
  assert.equal(n2, 1);
});

test('settings: non-object JSON counts as unreadable; saves merge into the raw object', () => {
  const home = tmp();
  const file = path.join(home, 'settings.json');
  for (const body of ['[]', 'null', '123', '"s"']) {
    fs.writeFileSync(file, body);
    assert.ok(loadUserSettings(home).parseError, `${body} reports parseError`);
    assert.throws(() => saveUserSettings({ userName: 'Q' }, home), (e) => e.code === 'SETTINGS_UNREADABLE');
    assert.throws(() => saveRemoteAccess(true, home), /refusing to save/);
    assert.equal(fs.readFileSync(file, 'utf8'), body, 'file untouched');
  }
  fs.writeFileSync(file, JSON.stringify({ custom: { keep: 1 }, runner: { providers: { claude: { models: ['a'] } } }, remote: { enabled: true, extra: 1 }, pushEvents: { finished: false } }));
  const saved = saveUserSettings({ userName: 'Zed', lanEnabled: true }, home);
  assert.equal(saved.userName, 'Zed');
  assert.equal(saved.custom, undefined, 'unknown keys are not exposed in the returned view');
  let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.custom, { keep: 1 });
  assert.deepEqual(raw.runner.providers.claude.models, ['a']);
  assert.deepEqual(raw.remote, { enabled: true, extra: 1 });
  assert.deepEqual(raw.pushEvents, { finished: false });
  saveRemoteAccess(false, home);
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.custom, { keep: 1 });
  assert.equal(raw.userName, 'Zed');
  assert.deepEqual(raw.remote, { enabled: false });
});

// ---------------------------------------------------------------- usage dashboard API (usa-2)
const fixtureAgents = (home) => {
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 3, 12);
  const mk = (id, meta, evs) => fs.writeFileSync(path.join(dir, `${id}.jsonl`),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta }) + evs.map((e, i) => ev({ seq: i + 1, ts: d, ...e })).join(''));
  const turn = (cost) => [{ type: 'usage', inputTokens: 900, outputTokens: 100 }, { type: 'turn_done', costUsd: cost }];
  mk('rn-bs1', { lane: 'usage', role: 'brainstorm' }, turn(1));
  mk('rn-ld1', { lane: 'usage', role: 'lead' }, turn(1));
  mk('rn-ld2', { lane: 'usage', role: 'lead', labels: { 'vs.handoff-from': 'rn-ld1' } }, turn(2));
  mk('rn-w1', { lane: 'usage', role: 'worker' }, [...turn(1), ...turn(2), { type: 'output', text: 'PASS: done' }]);
  const loopy = [];
  for (let i = 0; i < LOOP_TURN_THRESHOLD + 1; i++) loopy.push({ type: 'turn_done' });
  mk('rn-w2', { lane: 'other', role: 'worker', title: 'spinner' }, loopy);
  // role arriving later via meta patch
  mk('rn-w3', { lane: 'other' }, [{ type: 'meta', patch: { role: 'worker' } }, ...turn(1)]);
};
const gitCalls = [];
const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const fakeGit = (args) => {
  gitCalls.push(args);
  if (args[0] === 'rev-parse') return 'm2\n';
  if (args[0] === 'log') {
    return [
      L('m2', 'm1 b2', '1793000100', "Merge branch 'unit-x'"),
      L('b2', 'm1', '1793000090', 'feat: y (@oth) review r1 - a'),
      L('m1', 'a1 b1', '1793000000', "Merge branch 'unit-usage-api' (@usa)"),
      L('b1', 'b1b', '1793000050', 'fix(x): review r1 - first'),
      L('b1b', 'a1', '1793000040', 'fix(x): review r2 - more'),
      L('a1', 'root', '1793000010', 'mainline work'),
      L('root', '', '1793000000', 'init'),
    ].join('\n');
  }
  return '';
};

test('usage: per lane/role stats, coordination split, restarts, loop flag', () => {
  const home = tmp();
  fixtureAgents(home);
  clearUsageCache();
  const u = getUsage({ home, git: fakeGit, laneCodes: { usa: 'usage', oth: 'other' } });
  const lane = (id) => u.lanes.find((l) => l.lane === id);
  assert.equal(lane('usage').agents, 4);
  assert.equal(lane('usage').restarts, 1, 'second lead = one restart');
  assert.equal(lane('usage').handoffs, 1);
  assert.equal(lane('usage').turns, 5);
  assert.equal(lane('usage').byRole.worker.turns, 2);
  assert.equal(lane('usage').byRole.worker.avgTokensPerTurn, 1000);
  assert.equal(lane('usage').coordinationTokens, 3000);
  assert.equal(lane('usage').executionTokens, 2000);
  assert.equal(lane('usage').coordinationShare, 0.6);
  assert.deepEqual(u.byRole.map((r) => r.role), ['brainstorm', 'lead', 'worker']);
  assert.equal(u.byRole.find((r) => r.role === 'worker').turns, 2 + 41 + 1, 'late meta role counts for later events');
  assert.equal(u.coordination.coordinationTokens, 3000);
  assert.equal(u.loops.threshold, LOOP_TURN_THRESHOLD);
  assert.deepEqual(u.loops.flagged.map((l) => [l.agentId, l.turns, l.title]), [['rn-w2', 41, 'spinner']]);
  assert.ok(u.totals.turns > 0 && Array.isArray(u.rows), 'old fields intact');
});

test('usage: merged units, review rounds, cost per merged unit', () => {
  const home = tmp();
  fixtureAgents(home);
  clearUsageCache();
  const u = getUsage({ home, git: fakeGit, laneCodes: { usa: 'usage', oth: 'other' } });
  assert.equal(u.merged.units.length, 2, 'only merge commits become units');
  const m1 = u.merged.units.find((m) => m.sha === 'm1');
  assert.deepEqual([m1.unit, m1.lane, m1.reviewRounds], ['unit-usage-api', 'usage', 2]);
  const m2 = u.merged.units.find((m) => m.sha === 'm2');
  assert.deepEqual([m2.lane, m2.reviewRounds], ['other', 1], 'lane from a branch commit tag when the merge has none');
  const pl = u.merged.perLane.find((l) => l.lane === 'usage');
  assert.equal(pl.mergedUnits, 1);
  assert.ok(Math.abs(pl.costPerMergedUnit - 6) < 1e-9);
  assert.equal(getUsage({ home, git: () => { throw new Error('no git'); } }).merged.units.length, 0);
  const calls = gitCalls.length;
  getUsage({ home, git: fakeGit, laneCodes: { usa: 'usage' } });
  assert.equal(gitCalls.length, calls + 1, 'same HEAD: only rev-parse, merged units come from the cache');
  assert.ok(gitCalls.every((c) => c[0] === 'rev-parse' || c[0] === 'log') && gitCalls.filter((c) => c[0] === 'log').length === 2, 'two bounded git logs (commits + numstat), no per-merge spawns');
});

test('usage: limits from limits.jsonl with burn rate and ETA', () => {
  const home = tmp();
  assert.deepEqual(getUsage({ home, git: () => '' }).limits, [], 'missing file -> empty');
  const dir = path.join(home, 'runner');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.UTC(2026, 10, 6, 10);
  const reset = new Date(t0 + 5 * 3600_000).toISOString();
  const line = (o) => JSON.stringify({ provider: 'antigravity-cli', window: '5h', source: 'provider', agentId: 'rn-1', resetsAt: reset, ...o }) + '\n';
  fs.writeFileSync(path.join(dir, 'limits.jsonl'),
    line({ at: t0 - 4 * 3600_000, usedPct: 90, resetsAt: new Date(t0 - 3600_000).toISOString() }) + // previous window
    line({ at: new Date(t0).toISOString(), usedPct: 20 }) +
    'garbage\n' +
    line({ at: new Date(t0 + 3600_000).toISOString(), usedPct: 30 }) +
    JSON.stringify({ at: t0 + 3600_000, provider: 'claude', window: 'weekly', usedPct: 50, resetsAt: reset, source: 'estimate' }) + '\n' +
    JSON.stringify({ at: t0 + 7200_000, provider: 'claude', window: 'weekly', usedPct: 51, resetsAt: reset, source: 'estimate' }) + '\n');
  const lim = getUsage({ home, git: () => '' }).limits;
  const g = lim.find((l) => l.provider === 'antigravity-cli');
  assert.equal(g.usedPct, 30);
  assert.equal(g.burnPctPerHour, 10);
  assert.equal(g.etaToCap, null, '7h to cap lands after the reset at +5h');
  const c = lim.find((l) => l.provider === 'claude');
  assert.equal(c.source, 'estimate');
  assert.equal(c.burnPctPerHour, 1);
  assert.equal(c.etaToCap, null);
  // faster burn -> ETA before reset
  fs.appendFileSync(path.join(dir, 'limits.jsonl'), line({ at: t0 + 2 * 3600_000, usedPct: 70 }));
  const g2 = getUsage({ home, git: () => '' }).limits.find((l) => l.provider === 'antigravity-cli');
  assert.equal(g2.burnPctPerHour, 25);
  assert.equal(g2.etaToCap, new Date(t0 + 2 * 3600_000 + 1.2 * 3600_000).toISOString());
});

test('usage: PASS only counts at the start of a line of the agent message, not in an echoed prompt', () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 3, 12);
  const mk = (id, evs) => fs.writeFileSync(path.join(dir, `${id}.jsonl`),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'l', role: 'worker' } }) + evs.map((e, i) => ev({ seq: i + 1, ts: d, ...e })).join(''));
  const turns = Array.from({ length: LOOP_TURN_THRESHOLD + 1 }, () => ({ type: 'turn_done' }));
  mk('rn-echo', [{ type: 'input', text: 'report PASS when done' }, { type: 'output', text: 'echo: report PASS when done, ok' }, ...turns]);
  mk('rn-pass', [{ type: 'output', text: 'work...\nVerdict: PASS\n' }, ...turns]);
  mk('rn-split', [{ type: 'output', text: 'done\nPA' }, { type: 'output', text: 'SS - all green' }, ...turns]);
  clearUsageCache();
  const u = getUsage({ home, git: noGit });
  assert.deepEqual(u.loops.flagged.map((l) => l.agentId), ['rn-echo']);
});

test('usage: rows[].agents counts distinct agents even when the role changes mid-day', () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 3, 12);
  fs.writeFileSync(path.join(dir, 'rn-r.jsonl'),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'l', role: 'worker' } }) +
    ev({ seq: 1, ts: d, type: 'turn_done' }) +
    ev({ seq: 2, ts: d, type: 'meta', patch: { role: 'lead' } }) +
    ev({ seq: 3, ts: d, type: 'turn_done' }));
  clearUsageCache();
  const u = getUsage({ home, git: noGit });
  assert.equal(u.rows.length, 1);
  assert.equal(u.rows[0].agents, 1);
  assert.equal(u.rows[0].turns, 2);
});

test('usage: limits treat a usedPct drop as a window reset, tolerate null resetsAt, never go negative', () => {
  const home = tmp();
  const dir = path.join(home, 'runner');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.UTC(2026, 10, 6, 10);
  const l = (min, used, extra = {}) => JSON.stringify({ at: t0 + min * 60_000, provider: 'p', window: 'weekly', usedPct: used, resetsAt: null, source: 'estimate', ...extra }) + '\n';
  fs.writeFileSync(path.join(dir, 'limits.jsonl'), l(0, 80) + l(30, 95) + l(60, 2) + l(90, 4));
  let p = getUsage({ home, git: noGit }).limits[0];
  assert.equal(p.resetsAt, null);
  assert.equal(p.burnPctPerHour, 4, 'only samples after the drop: 2% -> 4% over 30 min');
  assert.equal(p.etaToCap, new Date(t0 + 90 * 60_000 + 24 * 3600_000).toISOString());
  fs.writeFileSync(path.join(dir, 'limits.jsonl'), l(0, 50) + l(30, 40, { source: 'estimate' }));
  p = getUsage({ home, git: noGit }).limits[0];
  assert.equal(p.burnPctPerHour, 0);
  assert.equal(p.etaToCap, null);
});

// ---------------------------------------------------------------- usage dashboard API v2 (usa-5)
const sec = (ms) => String(Math.round(ms / 1000));
const v2Dir = (home) => { const d = path.join(home, 'runner', 'agents'); fs.mkdirSync(d, { recursive: true }); return d; };
const writeAgent = (home, id, evs) => fs.writeFileSync(path.join(v2Dir(home), `${id}.jsonl`), evs.map((e, i) => ev({ seq: i, ...e })).join(''));
const byProfileOf = (u, profile) => u.byProfile.find((p) => p.profile === profile);

test('usage v2: byProfile compares Implement - Sonnet vs a Gemini implementer via cwd-basename attribution', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  writeAgent(home, 'rn-sonnet', [
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: '/worktrees/unit-sonnet', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'usage', inputTokens: 500, outputTokens: 100 },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 0.5 },
  ]);
  writeAgent(home, 'rn-gemini', [
    { ts: T0 + 5000, type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: '/worktrees/unit-gemini', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Gemini' } },
    { ts: T0 + 6000, type: 'usage', inputTokens: 900, outputTokens: 200 },
    { ts: T0 + 6000, type: 'turn_done', costUsd: 1.5 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm2\n';
    if (args[0] === 'log') return [
      L('m2', 'm1 b2', sec(T0 + 100000), "Merge branch 'unit-gemini' (@usa)"),
      L('b2', 'm1', sec(T0 + 90000), 'feat: gemini (@usa) review r1'),
      L('m1', 'a1 b1', sec(T0 + 50000), "Merge branch 'unit-sonnet' (@usa)"),
      L('b1', 'a1', sec(T0 + 40000), 'feat: sonnet (@usa) review r2'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const sonnet = byProfileOf(u, 'Implement - Sonnet');
  const gemini = byProfileOf(u, 'Implement - Gemini');
  assert.ok(sonnet && gemini, 'both profiles present');
  assert.equal(sonnet.provider, 'claude');
  assert.equal(sonnet.role, 'worker');
  assert.equal(sonnet.runs, 1);
  assert.equal(sonnet.turns, 1);
  assert.equal(sonnet.mergedUnits, 1);
  assert.equal(sonnet.reviewRounds, 2, 'reviewRounds from side commits');
  assert.equal(gemini.provider, 'antigravity-cli');
  assert.equal(gemini.mergedUnits, 1);
  assert.ok(Math.abs(sonnet.costPerMergedUnit - 0.5) < 1e-9);
  assert.ok(Math.abs(gemini.costPerMergedUnit - 1.5) < 1e-9);
  const su = u.merged.units.find((x) => x.unit === 'unit-sonnet');
  assert.equal(su.implementerAgentId, 'rn-sonnet');
  assert.equal(su.implementerProfile, 'Implement - Sonnet');
  assert.equal(su.unitCycleMs, 50000, 'worker createdAt -> mergedAt');
  // usa-12: implementer success = first-try review PASS (reviewRounds <= 1); passRate stays for back-compat
  assert.equal(sonnet.successRate, 0, 'sonnet needed 2 review rounds');
  assert.equal(sonnet.successBasis, 'implementer-first-try-pass');
  assert.equal(gemini.successRate, 1, 'gemini passed on round 1');
  assert.equal(gemini.successBasis, 'implementer-first-try-pass');
  assert.equal(typeof sonnet.passRate, 'number');
  const workerRole = u.byRole.find((r) => r.role === 'worker');
  assert.equal(workerRole.successRate, 0.5);
  assert.equal(workerRole.successBasis, 'implementer-first-try-pass');
});

test('usa-12: lead and Buddy report null / no-signal; reviewer uses PASS lines; implementer with no merged unit is no-signal', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  const mk = (id, role, profile, lines) => writeAgent(home, id, [
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: '/w/' + id, meta: { lane: 'usage', role, profile } },
    { ts: T0 + 1000, type: 'usage', inputTokens: 10, outputTokens: 5 },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 0.1 },
    ...lines,
  ]);
  mk('rn-lead', 'lead', 'Lead - Claude', []);
  mk('rn-buddy', 'brainstorm', 'Buddy', []);
  mk('rn-impl', 'worker', 'Implement - Sonnet', []);
  mk('rn-rev', 'worker', 'Review - Gemini', [{ ts: T0 + 2000, type: 'output', text: 'PASS 0/0/0\n' }]);
  const u = getUsage({ home, git: noGit });
  for (const profile of ['Lead - Claude', 'Buddy']) {
    const p = byProfileOf(u, profile);
    assert.equal(p.successRate, null, profile);
    assert.equal(p.successBasis, 'no-signal', profile);
  }
  assert.deepEqual([byProfileOf(u, 'Implement - Sonnet').successRate, byProfileOf(u, 'Implement - Sonnet').successBasis], [null, 'no-signal']);
  assert.equal(byProfileOf(u, 'Review - Gemini').successBasis, 'reviewer-pass-lines');
  assert.equal(u.byRole.find((r) => r.role === 'lead').successBasis, 'no-signal');
});

test('usage v2: byProfile falls back to the single worker in the lane when cwd does not match', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 4, 12);
  writeAgent(home, 'rn-w', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/somewhere-else', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 2 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm1\n';
    if (args[0] === 'log') return [
      L('m1', 'a1 b1', sec(T0 + 500000), "Merge branch 'unit-fallback' (@usa)"),
      L('b1', 'a1', sec(T0 + 400000), 'feat: x (@usa)'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const sonnet = byProfileOf(u, 'Implement - Sonnet');
  assert.equal(sonnet.mergedUnits, 1, 'attributed via lane fallback (single worker)');
  assert.equal(u.merged.units[0].implementerAgentId, 'rn-w');
});

test('usage v2: working vs idle time from status running->idle intervals', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 5, 12);
  writeAgent(home, 'rn-w', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'status', status: 'running' },
    { ts: T0 + 3000, type: 'status', status: 'idle' },
    { ts: T0 + 5000, type: 'status', status: 'running' },
    { ts: T0 + 8000, type: 'status', status: 'idle' },
    { ts: T0 + 8000, type: 'exit', code: 0 },
  ]);
  const u = getUsage({ home, git: noGit });
  const lane = u.lanes.find((l) => l.lane === 'usage');
  assert.equal(lane.workingMs, 5000);
  assert.equal(lane.idleMs, 3000);
  assert.equal(lane.workPct, 0.625);
  const p = byProfileOf(u, 'Implement - Sonnet');
  assert.equal(p.workingMs, 5000);
  assert.equal(p.idleMs, 3000);
});

test('usage v2: unit cycle time (worker createdAt and first-branch-commit fallback) and plan cycle time', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 6, 12);
  writeAgent(home, 'rn-w', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/unit-a', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm2\n';
    if (args[0] === 'log') return [
      L('m2', 'm1 b2', sec(T0 + 120000), "Merge branch 'unit-b' (@oth)"),
      L('b2', 'm1', sec(T0 + 90000), 'feat: b (@oth)'),
      L('m1', 'a1 b1', sec(T0 + 60000), "Merge branch 'unit-a' (@usa)"),
      L('b1', 'a1', sec(T0 + 30000), 'feat: a (@usa)'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'vibesquad--usage.jsonl'),
    ev({ ts: new Date(T0).toISOString(), agent: 'lead', lane: 'usage', type: 'handoff', text: 'handoff 1' }) +
    ev({ ts: new Date(T0 + 180000).toISOString(), agent: 'lead', lane: 'usage', type: 'handoff', text: 'handoff 2' }));
  const u = getUsage({ home, git, laneCodes: { usa: 'usage', oth: 'other' } });
  const unitA = u.merged.units.find((x) => x.unit === 'unit-a');
  const unitB = u.merged.units.find((x) => x.unit === 'unit-b');
  assert.equal(unitA.unitCycleMs, 60000, 'worker createdAt -> mergedAt');
  assert.equal(unitB.unitCycleMs, 30000, 'unattributed: first branch commit ct -> mergedAt');
  const lane = u.lanes.find((l) => l.lane === 'usage');
  assert.equal(lane.avgUnitCycleMs, 60000);
  assert.equal(lane.planCycleMs, 60000);
  assert.deepEqual(lane.planCycles, [60000]);
});

test('usage v2: fix-after-merge flags only units with a prior merge on the lane within 24h', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 7, 12);
  writeAgent(home, 'rn-w', [
    { ts: T0 - 3600_000, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/elsewhere', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 - 3500_000, type: 'turn_done', costUsd: 1 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm3\n';
    if (args[0] === 'log') return [
      L('m3', 'm2 b3', sec(T0 + 3 * 3600_000), "Merge branch 'fix-x' (@usa)"),
      L('b3', 'm2', sec(T0 + 2 * 3600_000), 'fix: y (@usa)'),
      L('m2', 'm1 b2', sec(T0 + 3600_000), "Merge branch 'unit-y' (@usa)"),
      L('b2', 'm1', sec(T0 + 3600_000), 'feat: y (@usa)'),
      L('m1', 'a1 b1', sec(T0), "Merge branch 'unit-x' (@usa)"),
      L('b1', 'a1', sec(T0), 'feat: x (@usa)'),
      L('a1', 'root', sec(T0 - 3600_000), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const byUnit = Object.fromEntries(u.merged.units.map((x) => [x.unit, x]));
  assert.equal(byUnit['fix-x'].fixAfterMerge, true, 'fix within 24h of a prior merge');
  assert.equal(byUnit['unit-y'].fixAfterMerge, false);
  assert.equal(byUnit['unit-x'].fixAfterMerge, false, 'first merge: no prior merge');
  const pl = u.merged.perLane.find((l) => l.lane === 'usage');
  assert.equal(pl.fixAfterMergeCount, 1);
  assert.equal(pl.fixAfterMergeRate, 0.333);
  const lane = u.lanes.find((l) => l.lane === 'usage');
  assert.equal(lane.fixAfterMergeCount, 1);
  assert.equal(lane.fixAfterMergeRate, 0.333);
});

test('usage v2: spawn storms detect spawn bursts and zero-turn exits, skip non-storms', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 8, 12);
  for (const [id, ts] of [['rn-b1', T0], ['rn-b2', T0 + 30000], ['rn-b3', T0 + 60000]]) {
    writeAgent(home, id, [{ ts, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } }]);
  }
  const exits = [[T0 + 30 * 60_000, T0], [T0 + 30 * 60_000 + 30000, T0 + 5 * 60_000], [T0 + 30 * 60_000 + 60000, T0 + 10 * 60_000]];
  exits.forEach(([exitTs, createdTs], i) => {
    writeAgent(home, `rn-z${i + 1}`, [
      { ts: createdTs, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead', profile: 'Lead' } },
      { ts: exitTs, type: 'exit', code: 1 },
    ]);
  });
  writeAgent(home, 'rn-n1', [{ ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'other', role: 'worker', profile: 'Implement - Sonnet' } }]);
  writeAgent(home, 'rn-n2', [{ ts: T0 + 30000, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'other', role: 'worker', profile: 'Implement - Sonnet' } }]);

  const u = getUsage({ home, git: noGit });
  const storms = u.spawnStorms;
  const burst = storms.find((s) => s.lane === 'usage' && s.role === 'worker');
  assert.ok(burst, 'spawn burst detected');
  assert.equal(burst.count, 3);
  assert.equal(burst.zeroTurnExits, 0);
  const zero = storms.find((s) => s.lane === 'usage' && s.role === 'lead');
  assert.ok(zero, 'zero-turn exit storm detected');
  assert.equal(zero.count, 3);
  assert.equal(zero.zeroTurnExits, 3);
  assert.ok(!storms.some((s) => s.lane === 'other'), 'non-storm lane has no entry');
});

// ---------------------------------------------------------------- usage review API (usa-7)
test('usage review: intervalMs + settings normalize/persist (invalid -> default "1d")', () => {
  assert.equal(intervalMs('off'), null);
  assert.equal(intervalMs('6h'), 6 * 3600_000);
  assert.equal(intervalMs('12h'), 12 * 3600_000);
  assert.equal(intervalMs('1d'), 24 * 3600_000);
  assert.equal(intervalMs('3d'), 3 * 24 * 3600_000);
  assert.equal(intervalMs('5d'), 5 * 24 * 3600_000);
  assert.equal(intervalMs('2w'), 14 * 24 * 3600_000);
  assert.equal(intervalMs('bogus'), null);
  assert.equal(normalizeRunnerSettings({}).usageReview.interval, '1d');
  assert.equal(normalizeRunnerSettings({ usageReview: { interval: 'bogus' } }).usageReview.interval, '1d');
  assert.equal(normalizeRunnerSettings({ usageReview: { interval: '2w' } }).usageReview.interval, '2w');

  const home = tmp();
  saveRunnerSettings({ usageReview: { interval: '6h' } }, home);
  assert.equal(loadRunnerSettings(home).usageReview.interval, '6h');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).runner.usageReview.interval, '6h');
  const saved = saveRunnerSettings({ usageReview: { interval: 'nope' } }, home);
  assert.equal(saved.usageReview.interval, '1d');
  assert.equal(loadRunnerSettings(home).usageReview.interval, '1d');
});

test('usage review: readUsageReviews reads newest last, tolerates missing file and bad lines', () => {
  const home = tmp();
  assert.deepEqual(readUsageReviews(home), [], 'missing file -> []');
  const file = path.join(home, 'runner', 'usage-reviews.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: 'a', trigger: 'manual' }) + '\nnot json\n' + JSON.stringify({ at: 'b', trigger: 'scheduled' }) + '\n');
  const out = readUsageReviews(home);
  assert.equal(out.length, 2);
  assert.equal(out[0].at, 'a');
  assert.equal(out[1].at, 'b', 'newest last');
});

test('usage review: runUsageReview runs both providers in parallel, survives one failing, appends one line', async () => {
  const home = tmp();
  const calls = [];
  const runOpus = async ({ prompt }) => { calls.push(['opus', prompt]); return { ok: true, text: 'routing tip', ms: 5 }; };
  const runGemini = async ({ prompt }) => { calls.push(['gemini', prompt]); throw new Error('gemini boom'); };
  const rec = await runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 7, costUsd: 2.5 } }, runOpus, runGemini });
  assert.equal(rec.trigger, 'manual');
  assert.equal(rec.turnsAtRun, 7);
  assert.equal(rec.interval, '1d', 'default interval from settings');
  assert.deepEqual(rec.opus, { ok: true, text: 'routing tip', ms: 5 });
  assert.equal(rec.gemini.ok, false);
  assert.match(rec.gemini.error, /gemini boom/);
  assert.equal(calls.length, 2, 'both providers invoked in parallel');
  const lines = fs.readFileSync(path.join(home, 'runner', 'usage-reviews.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), rec);
});

test('usage review: a second call while one runs returns the in-flight promise (no second spawn)', async () => {
  const home = tmp();
  let resolveOpus;
  let opusCalls = 0;
  const runOpus = () => { opusCalls++; return new Promise((r) => { resolveOpus = r; }); };
  const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
  const p1 = runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 1 } }, runOpus, runGemini });
  const p2 = runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 2 } }, runOpus, runGemini });
  assert.equal(p2, p1, 'same in-flight promise returned');
  assert.equal(opusCalls, 1, 'opus spawned once');
  resolveOpus({ ok: true, text: 'o', ms: 1 });
  const rec = await p1;
  assert.equal(rec.turnsAtRun, 1);
  assert.equal(fs.readFileSync(path.join(home, 'runner', 'usage-reviews.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('usage review: scheduled check fires when due + new turns, skips off / not-due / no-new-turns', async () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 9, 12);
  const agentFile = path.join(dir, 'rn-a.jsonl');
  let seq = 0;
  const turn = (ts) => fs.appendFileSync(agentFile, ev({ seq: ++seq, ts, type: 'turn_done', costUsd: 1 }));
  fs.writeFileSync(agentFile, ev({ seq: ++seq, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'x', role: 'worker' } }));
  turn(d);
  clearUsageCache();
  let now = d;
  let opusCalls = 0;
  const runOpus = async () => { opusCalls++; return { ok: true, text: 'o', ms: 1 }; };
  const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
  const opts = { runOpus, runGemini, now: () => now };
  const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

  // 1) no last review + turns > 0 -> fires
  getUsage({ home, git: noGit, usageReview: opts });
  await settle();
  assert.equal(opusCalls, 1);
  let recs = readUsageReviews(home);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].trigger, 'scheduled');
  assert.equal(recs[0].turnsAtRun, 1);

  // 2) not due (+1h) -> skips
  now = d + 3600_000;
  getUsage({ home, git: noGit, usageReview: opts });
  await settle();
  assert.equal(opusCalls, 1, 'not due: no new spawn');

  // 3) due (+2d) but no new turns -> skips
  now = d + 2 * 24 * 3600_000;
  getUsage({ home, git: noGit, usageReview: opts });
  await settle();
  assert.equal(opusCalls, 1, 'no new turns since last review: skip');
  assert.equal(readUsageReviews(home).length, 1);

  // 4) due + new turns -> fires again
  turn(d + 2 * 24 * 3600_000);
  getUsage({ home, git: noGit, usageReview: opts });
  await settle();
  assert.equal(opusCalls, 2);
  recs = readUsageReviews(home);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].turnsAtRun, 2);
});

test('usage review: scheduled check skips when interval is off', async () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 9, 12);
  fs.writeFileSync(path.join(dir, 'rn-a.jsonl'),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'x', role: 'worker' } }) +
    ev({ seq: 1, ts: d, type: 'turn_done', costUsd: 1 }));
  clearUsageCache();
  saveRunnerSettings({ usageReview: { interval: 'off' } }, home);
  let opusCalls = 0;
  const runOpus = async () => { opusCalls++; return { ok: true, text: 'o', ms: 1 }; };
  const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
  const u = getUsage({ home, git: noGit, usageReview: { runOpus, runGemini, now: () => d } });
  assert.equal(u.usageReview.interval, 'off');
  assert.equal(u.usageReview.inFlight, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(opusCalls, 0);
  assert.deepEqual(readUsageReviews(home), []);
});

test('usage review: scheduled check does not fire while a review is in flight', async () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 9, 12);
  fs.writeFileSync(path.join(dir, 'rn-a.jsonl'),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'x', role: 'worker' } }) +
    ev({ seq: 1, ts: d, type: 'turn_done', costUsd: 1 }));
  clearUsageCache();
  let resolveOpus;
  let opusCalls = 0;
  const runOpus = () => { opusCalls++; return new Promise((r) => { resolveOpus = r; }); };
  const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
  const opts = { runOpus, runGemini, now: () => d };
  getUsage({ home, git: noGit, usageReview: opts });
  assert.equal(opusCalls, 1);
  const second = getUsage({ home, git: noGit, usageReview: opts });
  assert.equal(second.usageReview.inFlight, true);
  assert.equal(opusCalls, 1, 'in flight: no second spawn');
  resolveOpus({ ok: true, text: 'o', ms: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(readUsageReviews(home).length, 1);
});

test('usage review: GET /usage-review returns the review state shape', async () => {
  const home = tmp();
  const call = async (method, url, body, opts = {}) => {
    let out;
    await handleProvidersApi({ method, url }, {}, { home, ...probeOpts, ...opts, readBody: async () => body, sendJson: (_r, code, data) => { out = { code, data }; } });
    return out;
  };
  const res = await call('GET', '/__vibesquad/providers/usage-review');
  assert.equal(res.code, 200);
  const ur = res.data.usageReview;
  assert.equal(ur.interval, '1d');
  assert.equal(ur.inFlight, false);
  assert.equal(ur.last, null);
  assert.equal(ur.nextAt, null);
  assert.deepEqual(ur.history, []);
  assert.equal(typeof ur.waitingForTurns, 'boolean');
});

test('usage review: POST /usage-review validates interval, persists it, and runNow triggers a manual review', async () => {
  const home = tmp();
  const call = async (method, url, body, opts = {}) => {
    let out;
    await handleProvidersApi({ method, url }, {}, { home, ...probeOpts, ...opts, readBody: async () => body, sendJson: (_r, code, data) => { out = { code, data }; } });
    return out;
  };
  const bad = await call('POST', '/__vibesquad/providers/usage-review', { interval: 'bogus' });
  assert.equal(bad.code, 400);
  assert.match(bad.data.error, /bad interval/);

  const ok = await call('POST', '/__vibesquad/providers/usage-review', { interval: '6h' });
  assert.equal(ok.code, 200);
  assert.equal(ok.data.usageReview.interval, '6h');
  assert.equal(loadRunnerSettings(home).usageReview.interval, '6h');

  const calls = [];
  const runOpus = async ({ prompt }) => { calls.push(['opus', prompt]); return { ok: true, text: 'route', ms: 1 }; };
  const runGemini = async ({ prompt }) => { calls.push(['gemini', prompt]); return { ok: true, text: 'tool', ms: 2 }; };
  const run = await call('POST', '/__vibesquad/providers/usage-review', { runNow: true }, { usageReview: { runOpus, runGemini, now: () => Date.UTC(2026, 10, 9, 12) } });
  assert.equal(run.code, 200);
  assert.equal(run.data.usageReview.inFlight, true, 'manual run started');
  await new Promise((r) => setImmediate(r));
  const recs = readUsageReviews(home);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].trigger, 'manual');
  assert.deepEqual(recs[0].opus, { ok: true, text: 'route', ms: 1 });
  assert.deepEqual(recs[0].gemini, { ok: true, text: 'tool', ms: 2 });
});

test('usage review: non-owner POST to /usage-review is rejected like other owner writes', async () => {
  const prevHome = process.env.VIBESQUAD_HOME;
  const home = tmp();
  process.env.VIBESQUAD_HOME = home;
  const { createVibesquadMiddleware } = await import('../server/vibesquad-api.mjs');
  const { createServer, request } = await import('node:http');
  const rootDir = path.resolve(import.meta.dirname, '..');
  const srv = createServer(createVibesquadMiddleware(rootDir));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  const post = () => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/__vibesquad/providers/usage-review', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => ok({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', fail);
    req.end(JSON.stringify({ interval: '2w' }));
  });
  try {
    const res = await post();
    assert.equal(res.status, 403);
    assert.equal(res.body.readOnly, true);
    assert.match(res.body.error, /read-only/);
    assert.equal(loadRunnerSettings(home).usageReview.interval, '1d', 'rejected before the handler: interval not persisted');
  } finally {
    await new Promise((ok) => srv.close(ok));
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
  }
});

// A spawnImpl that returns a child whose stdout/stderr/exit are driven by `emit(child)` on the next tick.
const reviewSpawn = (emit) => (file, args, opts) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  process.nextTick(() => emit(child));
  return child;
};

test('usage review: oneShotReviewRun resolves ok:false with stderr tail on a nonzero exit', async () => {
  const res = await oneShotReviewRun('claude', ['-p'])({
    prompt: 'hi',
    spawnImpl: reviewSpawn((c) => { c.stderr.emit('data', 'boom: quota exceeded'); c.emit('exit', 1); }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'boom: quota exceeded');
});

test('usage review: oneShotReviewRun resolves text on exit 0', async () => {
  const res = await oneShotReviewRun('agy', ['-p'])({
    prompt: 'hi',
    spawnImpl: reviewSpawn((c) => { c.stdout.emit('data', 'route via gemini'); c.emit('exit', 0); }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'route via gemini');
});

test('usage review: oneShotReviewRun nonzero exit with no stderr -> "exit <code>"', async () => {
  const res = await oneShotReviewRun('agy', ['-p'])({ prompt: 'hi', spawnImpl: reviewSpawn((c) => c.emit('exit', 2)) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'exit 2');
});

test('usage review: POST runNow only accepts exactly true', async () => {
  const home = tmp();
  const call = async (method, url, body, opts = {}) => {
    let out;
    await handleProvidersApi({ method, url }, {}, { home, ...probeOpts, ...opts, readBody: async () => body, sendJson: (_r, code, data) => { out = { code, data }; } });
    return out;
  };
  let calls = 0;
  const runOpus = async () => { calls++; return { ok: true, text: 'o', ms: 1 }; };
  const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
  const res = await call('POST', '/__vibesquad/providers/usage-review', { runNow: 'yes' }, { usageReview: { runOpus, runGemini, now: () => Date.UTC(2026, 10, 9, 12) } });
  assert.equal(res.code, 200);
  assert.equal(res.data.usageReview.inFlight, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0, 'runNow:"yes" is not true: no review started');
  assert.deepEqual(readUsageReviews(home), []);
});

test('usage review: manual Run-now is recorded as "manual" even when a scheduled run is also due', async () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 10, 12);
  fs.writeFileSync(path.join(dir, 'rn-a.jsonl'),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'x', role: 'worker' } }) +
    ev({ seq: 1, ts: d, type: 'turn_done', costUsd: 1 }));
  clearUsageCache();
  const call = async (method, url, body, opts = {}) => {
    let out;
    await handleProvidersApi({ method, url }, {}, { home, ...probeOpts, ...opts, readBody: async () => body, sendJson: (_r, code, data) => { out = { code, data }; } });
    return out;
  };
  const runOpus = async () => ({ ok: true, text: 'o', ms: 1 });
  const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
  const res = await call('POST', '/__vibesquad/providers/usage-review', { runNow: true }, { usageReview: { runOpus, runGemini, now: () => d } });
  assert.equal(res.code, 200);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const recs = readUsageReviews(home);
  assert.equal(recs.length, 1, 'exactly one review, not a scheduled one plus a manual one');
  assert.equal(recs[0].trigger, 'manual');
});

// ---- usa-9: review-context enrichment (log signals, error rollups, prompt context) ----

/** Write a vs-log entry (shape: { ts, agent, lane, type, text }) into <home>/logs/<file>.jsonl or <home>/teams/<t>/log.jsonl. */
const writeLog = (home, file, e) => {
  const p = path.join(home, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(e) + '\n');
};
const L_ENTRY = (ts, agent, lane, type, text) => ({ ts: new Date(ts).toISOString(), agent, lane, type, text, refs: [] });

test('usage review context: readUsageLogSignals harvests @usa/usage notes, friction, and mcp-alias counts with sinceMs filtering', () => {
  const home = tmp();
  const t0 = Date.UTC(2026, 10, 7, 12);
  // notes
  writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0, 'rn-lead', 'usage', 'decision', '@usa: shift implementation to Gemini'));
  writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0 + 1000, 'rn-buddy', 'usage', 'metric', 'spawn-timing new-buddy total=10ms'));
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 2000, 'rn-x', 'other', 'handoff', '@usa plan ready for review'));
  // plugin metric noise (usage lane) must NOT become a note
  writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0 + 3000, 'plugin', 'usage', 'metric', 'hook-timing hook=before.agent.create total=21'));
  writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0 + 4000, 'plugin', 'usage', 'metric', 'prompt-injection role=worker chars=5'));
  // friction
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 5000, 'rn-w', 'other', 'blocker', 'gemini turn cap hit'));
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 6000, 'rn-w2', 'other', 'done', 'FAIL: merge conflict on unit-x'));
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 7000, 'rn-w3', 'other', 'metric', 'restart-feedback: good (from X -> Y)'));
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 8000, 'rn-ld', 'other', 'decision', 'gemini queue jam -> re-dispatch'));
  // mcp-alias counts (compact, not note lines)
  writeLog(home, 'logs/vibesquad--art.jsonl', L_ENTRY(t0 + 9000, 'rn-a', 'art-direction', 'metric', 'mcp-alias: tool=create_agent caller=rn-a lane=art-direction'));
  writeLog(home, 'logs/vibesquad--art.jsonl', L_ENTRY(t0 + 10000, 'rn-b', 'art-direction', 'metric', 'mcp-alias: tool=create_agent caller=rn-b lane=art-direction'));
  writeLog(home, 'logs/vibesquad--uib.jsonl', L_ENTRY(t0 + 11000, 'rn-c', 'ui-bois', 'metric', 'mcp-alias: tool=send_agent_prompt caller=rn-c lane=ui-bois'));
  // duplicate of the first note landing in the teams log too -> deduped
  writeLog(home, 'teams/vibesquad/log.jsonl', L_ENTRY(t0, 'rn-lead', 'usage', 'decision', '@usa: shift implementation to Gemini'));

  const s = readUsageLogSignals(home, { sinceMs: null });
  assert.equal(s.notes.length, 3, 'notes = @usa or usage-lane, plugin noise excluded, deduped');
  assert.deepEqual(s.notes.map((n) => n.type).sort(), ['decision', 'handoff', 'metric']);
  assert.ok(s.notes.some((n) => n.type === 'decision' && n.text.startsWith('@usa: shift implementation')), 'decision @usa note harvested');
  assert.ok(s.notes.some((n) => n.type === 'handoff' && n.text.includes('@usa plan ready')), 'handoff @usa note harvested');
  assert.ok(s.notes.some((n) => n.type === 'metric' && n.text.startsWith('spawn-timing')), 'usage-lane metric note harvested');
  assert.ok(!s.notes.some((n) => n.text.includes('hook-timing') || n.text.includes('prompt-injection')), 'plugin metric noise excluded');
  assert.deepEqual(s.friction.map((f) => f.type).sort(), ['blocker', 'decision', 'done', 'metric'], 'blocker + FAIL done + restart-feedback(metric) + cap decision');
  assert.ok(s.friction.some((f) => f.type === 'metric' && f.text.startsWith('restart-feedback:')), 'restart-feedback classified as friction');
  assert.deepEqual(s.mcpAlias, [
    { tool: 'create_agent', lane: 'art-direction', count: 2 },
    { tool: 'send_agent_prompt', lane: 'ui-bois', count: 1 },
  ], 'mcp-alias compact counts grouped by tool+lane');

  // sinceMs filtering: only entries strictly after t0+8500 survive
  const s2 = readUsageLogSignals(home, { sinceMs: t0 + 8500 });
  assert.deepEqual(s2.notes, [], 'no note after the cut');
  assert.deepEqual(s2.friction, [], 'no friction after the cut');
  assert.deepEqual(s2.mcpAlias, [
    { tool: 'create_agent', lane: 'art-direction', count: 2 },
    { tool: 'send_agent_prompt', lane: 'ui-bois', count: 1 },
  ], 'mcp-alias hits after the cut survive');

  assert.deepEqual(readUsageLogSignals(path.join(home, 'does-not-exist')), { notes: [], friction: [], mcpAlias: [] }, 'missing dirs -> empty');
});

test('usage review context: error events and error exits roll up to byProfile.errorCount and recentErrors', () => {
  const home = tmp();
  clearUsageCache();
  const d = Date.UTC(2026, 10, 3, 12);
  writeAgent(home, 'rn-e1', [
    { ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: d + 1000, type: 'error', message: 'boom A' },
    { ts: d + 2000, type: 'exit', code: null, error: 'boom B' },
    { ts: d + 3000, type: 'exit', code: 0 }, // clean exit: not an error
  ]);
  writeAgent(home, 'rn-e2', [
    { ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: d + 1000, type: 'exit', code: 1, error: 'nonzero exit' },
  ]);
  const u = getUsage({ home, git: () => '' });
  const sonnet = byProfileOf(u, 'Implement - Sonnet');
  assert.equal(sonnet.errorCount, 3, 'rn-e1: error + error-exit (clean exit not counted); rn-e2: error-exit');
  assert.equal(u.recentErrors.length, 2);
  const byId = Object.fromEntries(u.recentErrors.map((e) => [e.agentId, e]));
  assert.equal(byId['rn-e1'].message, 'boom B', 'lastError is the most recent error message');
  assert.equal(byId['rn-e1'].errors, 2);
  assert.equal(byId['rn-e2'].message, 'nonzero exit');
  assert.equal(byId['rn-e2'].profile, 'Implement - Sonnet');
  assert.ok(u.recentErrors[0].agentId === 'rn-e2' || u.recentErrors[0].agentId === 'rn-e1', 'ordered by last error time');
});

test('usage review context: prompt includes @usa notes, friction, mcp-alias counts, profile catalog, and turn caps', async () => {
  const home = tmp();
  const t0 = Date.UTC(2026, 10, 7, 12);
  writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0, 'rn-lead', 'usage', 'decision', '@usa: shift implementation to Gemini'));
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 1000, 'rn-w', 'other', 'blocker', 'gemini turn cap hit'));
  writeLog(home, 'logs/vibesquad--art.jsonl', L_ENTRY(t0 + 2000, 'rn-a', 'art-direction', 'metric', 'mcp-alias: tool=create_agent caller=rn-a lane=art-direction'));
  const prev = process.env.VS_RUNNER_TURN_CAP_CLAUDE;
  process.env.VS_RUNNER_TURN_CAP_CLAUDE = '7';
  try {
    const prompts = [];
    const runOpus = async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: 'o', ms: 1 }; };
    const runGemini = async () => ({ ok: true, text: 'g', ms: 1 });
    await runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 3, costUsd: 1.25 }, recentErrors: [{ agentId: 'rn-e', profile: 'Implement - Sonnet', message: 'boom' }] }, runOpus, runGemini });
    const prompt = prompts[0];
    assert.match(prompt, /@usa: shift implementation to Gemini/, 'harvested @usa note in the prompt');
    assert.match(prompt, /Recent friction signals:/, 'friction section present');
    assert.match(prompt, /gemini turn cap hit/, 'blocker text in the prompt');
    assert.match(prompt, /mcp-alias tool hits: create_agent@art-direction x1/, 'mcp-alias counts in the prompt');
    assert.match(prompt, /Recent agent errors:/, 'recent errors section present');
    assert.match(prompt, /Implement - Sonnet \(rn-e\): boom/, 'error message in the prompt');
    assert.match(prompt, /Active profiles: .*Lead - Claude \(lead\/claude\/claude-opus-5-5\)/, 'profile catalog in the prompt');
    assert.match(prompt, /Runner turn caps: .*claude=7/, 'turn caps (env-overridden) in the prompt');
  } finally {
    if (prev === undefined) delete process.env.VS_RUNNER_TURN_CAP_CLAUDE;
    else process.env.VS_RUNNER_TURN_CAP_CLAUDE = prev;
  }
});

// ---------------------------------------------------------------- usa-10: benchmark ledger, A/B workflow, savings, cohorts, floor

test('usa-10 root cause: Windows-style worktree cwd (backslash + case) attributes merged units', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  // backslash worktree path + a case mismatch on the directory name vs the branch name
  writeAgent(home, 'rn-w1', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: 'C:\\Users\\dev\\AppData\\Local\\VibeSquad\\worktrees\\VibeSquad\\Unit-Foo', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1 },
  ]);
  writeAgent(home, 'rn-w2', [
    { ts: T0, type: 'created', provider: 'antigravity-cli', model: 'g', cwd: 'C:/Users/dev/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-bar', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Gemini' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 2 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm2\n';
    if (args[0] === 'log') return [
      L('m2', 'm1 b2', sec(T0 + 100000), "Merge branch 'unit-bar' (@usa)"),
      L('b2', 'm1', sec(T0 + 90000), 'feat (@usa)'),
      L('m1', 'a1 b1', sec(T0 + 50000), "Merge branch 'unit-foo' (@usa)"),
      L('b1', 'a1', sec(T0 + 40000), 'feat (@usa)'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const byUnit = Object.fromEntries(u.merged.units.map((x) => [x.unit, x]));
  assert.equal(byUnit['unit-foo'].implementerAgentId, 'rn-w1', 'backslash cwd basename, case-insensitive match');
  assert.equal(byUnit['unit-bar'].implementerAgentId, 'rn-w2', 'forward-slash cwd basename');
  assert.equal(byProfileOf(u, 'Implement - Sonnet').mergedUnits, 1);
  assert.equal(byProfileOf(u, 'Implement - Gemini').mergedUnits, 1);
});

test('usa-10: readMergedUnits parses --first-parent --numstat into locAdded/locDeleted/filesChanged', () => {
  const M1 = 'a'.repeat(40), A1 = 'b'.repeat(40), B1 = 'c'.repeat(40), ROOT = 'd'.repeat(40);
  const git = (args) => {
    if (args[0] === 'rev-parse') return `${M1}\n`;
    if (args.includes('--numstat')) {
      return [M1, '10\t2\tsrc/a.ts', '3\t0\tsrc/b.ts', '', A1, '1\t1\tx', ''].join('\n');
    }
    return [
      L(M1, `${A1} ${B1}`, '1793000000', "Merge branch 'unit-x' (@usa)"),
      L(B1, A1, '1793000050', 'feat (@usa) review r2'),
      L(A1, ROOT, '1793000010', 'mainline'),
      L(ROOT, '', '1793000000', 'init'),
    ].join('\n');
  };
  const units = readMergedUnits(git);
  const u = units.find((x) => x.sha === M1);
  assert.equal(u.locAdded, 13);
  assert.equal(u.locDeleted, 2);
  assert.equal(u.filesChanged, 2);
});

test('usa-10: usage-ledger write/read/fold, idempotent sync, no double count, forbidden-home guard', () => {
  const home = tmp();
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const d = Date.UTC(2026, 10, 9, 12);
  const now = () => Date.UTC(2026, 10, 10, 12); // today UTC = 2026-11-10, so 2026-11-09 is a completed day
  fs.writeFileSync(path.join(dir, 'rn-a.jsonl'),
    ev({ seq: 0, ts: d, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'x', role: 'worker' } }) +
    ev({ seq: 1, ts: d, type: 'turn_done', costUsd: 1 }));
  clearUsageCache();

  getUsage({ home, git: noGit, now });
  let ledger = readUsageLedger(home);
  assert.ok(ledger.some((r) => r.kind === 'day' && r.day === '2026-11-09'), 'completed day record synced');
  assert.equal(ledger.filter((r) => r.kind === 'day' && r.day === '2026-11-09').length, 1, 'one day record');

  const before = fs.readFileSync(path.join(home, 'runner', 'usage-ledger.jsonl'), 'utf8');
  getUsage({ home, git: noGit, now });
  assert.equal(fs.readFileSync(path.join(home, 'runner', 'usage-ledger.jsonl'), 'utf8'), before, 'idempotent sync');
  assert.equal(getUsage({ home, git: noGit, now }).totals.turns, 1, 'raw day not double counted');

  // A ledger day absent from raw agent logs is folded back into totals + byDay.
  fs.appendFileSync(path.join(home, 'runner', 'usage-ledger.jsonl'),
    JSON.stringify({ kind: 'day', day: '2026-11-01', costUsd: 2, totalTokens: 200, inputTokens: 100, outputTokens: 100, turns: 2, unitsMerged: 0, locChanged: 0, byProvider: {} }) + '\n');
  const u = getUsage({ home, git: noGit, now });
  assert.equal(u.totals.turns, 3, 'folded day turns added (1 raw + 2 ledger)');
  assert.ok(u.byDay.some((r) => r.day === '2026-11-01'), 'folded day appears in byDay');

  withFakeRealHome((fakeReal) => {
    assert.equal(syncUsageLedger(fakeReal, [{ kind: 'day', day: '2099-01-01', turns: 1 }]), 0, 'forbidden real home: no write');
    assert.deepEqual(fs.readdirSync(fakeReal), [], 'forbidden real home: nothing created');
  });
});

test('usa-10: syncUsageLedger only writes completed days (day < today UTC)', () => {
  const home = tmp();
  const now = () => Date.UTC(2026, 10, 10, 12); // today UTC = 2026-11-10
  const written = syncUsageLedger(home, [
    { kind: 'day', day: '2026-11-09', turns: 1, costUsd: 1, totalTokens: 0, inputTokens: 0, outputTokens: 0, unitsMerged: 0, locChanged: 0, byProvider: {} },
    { kind: 'day', day: '2026-11-10', turns: 2, costUsd: 2, totalTokens: 0, inputTokens: 0, outputTokens: 0, unitsMerged: 0, locChanged: 0, byProvider: {} },
    { kind: 'day', day: '2026-11-11', turns: 3, costUsd: 3, totalTokens: 0, inputTokens: 0, outputTokens: 0, unitsMerged: 0, locChanged: 0, byProvider: {} },
  ], now);
  assert.equal(written, 1, 'only the completed (past) day is written');
  assert.deepEqual(readUsageLedger(home).map((r) => r.day), ['2026-11-09']);
});

test('usa-10: workflowMode from [wf:] tag wins, else derived from provider/profile', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  writeAgent(home, 'rn-dsp', [
    { ts: T0, type: 'created', provider: 'opencode', model: 'deepseek/deepseek-v4-pro', cwd: '/worktrees/unit-a', meta: { lane: 'usage', role: 'worker', profile: 'Work Order - DSP' } },
    { ts: T0 + 1000, type: 'turn_done' },
  ]);
  writeAgent(home, 'rn-sonnet', [
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: '/worktrees/unit-b', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1 },
  ]);
  writeAgent(home, 'rn-gemini', [
    { ts: T0, type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: '/worktrees/unit-c', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Gemini' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm4\n';
    if (args[0] === 'log') return [
      L('m4', 'm3 b4', sec(T0 + 400000), "Merge branch 'unit-c' (@usa) [wf:gemini]"),
      L('b4', 'm3', sec(T0 + 300000), 'feat (@usa)'),
      L('m3', 'm2 b3', sec(T0 + 300000), "Merge branch 'unit-b' (@usa) [wf:sonnet]"),
      L('b3', 'm2', sec(T0 + 200000), 'feat (@usa) review r1'),
      L('m2', 'm1 b2', sec(T0 + 200000), "Merge branch 'unit-a' (@usa)"),
      L('b2', 'm1', sec(T0 + 100000), 'feat (@usa) review r2'),
      L('m1', 'a1 b1', sec(T0 + 100000), "Merge branch 'unit-d' (@usa)"),
      L('b1', 'a1', sec(T0 + 50000), 'feat (@usa)'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const mode = Object.fromEntries(u.byWorkflow.map((w) => [w.workflowMode, w]));
  assert.equal(mode['dsp+gemini-review']?.units, 1, 'DSP implementer derived dsp+gemini-review');
  assert.equal(mode['sonnet']?.units, 1, '[wf:sonnet] tag kept as the mode');
  assert.equal(mode['gemini']?.units, 1, '[wf:gemini] tag kept as the mode');
  assert.equal(mode['unattributed']?.units, 1, 'unit without implementer or tag');
  assert.equal(mode['dsp+gemini-review'].costPerUnit, 0, 'DSP cost unknown (no turn_done cost)');
  assert.equal(mode['dsp+gemini-review'].costCoverage, 0, 'non-Claude cost marked unknown');
  assert.equal(mode['sonnet'].costCoverage, 1, 'Claude cost known');
});

test('usa-10: savings baseline formulas (all-Opus routing, context isolation, parallel speedup)', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  writeAgent(home, 'rn-w', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/unit-a', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0, type: 'status', status: 'running' },
    { ts: T0 + 1000, type: 'usage', inputTokens: 1000, outputTokens: 100 },
    { ts: T0 + 2000, type: 'status', status: 'idle' },
    { ts: T0 + 2000, type: 'turn_done', costUsd: 0.02 },
  ]);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm1\n';
    if (args[0] === 'log') return [
      L('m1', 'a1 b1', sec(T0 + 50000), "Merge branch 'unit-a' (@usa)"),
      L('b1', 'a1', sec(T0 + 40000), 'feat (@usa)'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const s = u.savings;
  // all-Opus: 1000 in * $15/MTok + 100 out * $75/MTok = 0.015 + 0.0075 = 0.0225
  assert.ok(Math.abs(s.soloOpusBaselineUsd - 0.0225) < 1e-9, `baseline ${s.soloOpusBaselineUsd}`);
  assert.ok(Math.abs(s.actualCostUsd - 0.02) < 1e-9);
  assert.ok(Math.abs(s.routingSavingsUsd - 0.0025) < 1e-9);
  assert.equal(s.contextSavingsTokens, 4000, 'monolithic 5000 (1*brief) vs 1000 actual');
  assert.equal(s.monolithicBaselineTokens, 5000);
  assert.equal(s.parallelSpeedup, 1, 'working 2000ms over span 2000ms');
});

test('usa-10: cohorts compare Last 10 vs Prior 10 (delta = recent - prior)', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  const chainGit = (units) => (args) => {
    if (args[0] === 'rev-parse') return `m${units.length}\n`;
    if (args[0] === 'log') {
      const lines = [];
      let prev = 'root';
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        const mi = `m${i + 1}`, bi = `b${i + 1}`;
        lines.push(L(mi, `${prev} ${bi}`, String(u.ctSec), `Merge branch '${u.unit}' (@usa)`));
        lines.push(L(bi, prev, String(u.ctSec - 1), `feat (@usa) review r${u.reviewRounds}`));
        prev = mi;
      }
      lines.push(L('root', '', '0', 'init'));
      return lines.reverse().join('\n');
    }
    return '';
  };
  const units = [];
  for (let i = 0; i < 12; i++) units.push({ unit: `unit-${i}`, reviewRounds: i < 2 ? 2 : 0, ctSec: sec(T0 + i * 1000) });
  const u = getUsage({ home, git: chainGit(units), laneCodes: { usa: 'usage' } });
  const c = u.cohorts;
  assert.equal(c.recent.units, 10);
  assert.equal(c.prior.units, 2);
  assert.equal(c.recent.firstTryPassRate, 1, 'recent all clean');
  assert.equal(c.recent.avgReviewRounds, 0);
  assert.equal(c.prior.firstTryPassRate, 0, 'prior all rework');
  assert.equal(c.prior.avgReviewRounds, 2);
  assert.equal(c.delta.firstTryPassRate, 1);
  assert.equal(c.delta.avgReviewRounds, -2);
});

test('usa-10: floor splits spend into clean vs rework/loops/fix/restart buckets', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 3, 12);
  writeAgent(home, 'rn-clean', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/unit-clean', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1 },
  ]);
  writeAgent(home, 'rn-rework', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/unit-rework', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 2 },
  ]);
  const loopEvents = [{ ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/worktrees/nowhere', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } }];
  for (let i = 0; i < LOOP_TURN_THRESHOLD + 1; i++) loopEvents.push({ ts: T0 + 1000, type: 'turn_done', costUsd: 3 });
  writeAgent(home, 'rn-loop', loopEvents);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm2\n';
    if (args[0] === 'log') return [
      L('m2', 'm1 b2', sec(T0 + 200000), "Merge branch 'unit-rework' (@usa)"),
      L('b2', 'm1', sec(T0 + 190000), 'feat (@usa) review r2'),
      L('m1', 'a1 b1', sec(T0 + 100000), "Merge branch 'unit-clean' (@usa)"),
      L('b1', 'a1', sec(T0 + 90000), 'feat (@usa)'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage' } });
  const f = u.floor;
  assert.equal(f.reworkCostUsd, 2, 'unit-rework (r2) cost 2');
  assert.equal(f.loopAndAbandonedCostUsd, 3, 'loop worker cost 3');
  assert.equal(f.fixAfterMergeCostUsd, 0);
  assert.equal(f.restartOverheadCostUsd, 0);
  assert.equal(f.cleanCostUsd, 1, 'total 6 - 2 - 3');
  assert.equal(f.cleanShare, 0.17);
  assert.equal(f.wasteShare, 0.83);
});

test('usa-10: review records store kpis and the prompt grades prior recommendations against KPI deltas', async () => {
  const home = tmp();
  // Point the prompt at a temp file seeded with the built-in text so this test is independent of the
  // @perfection-owned live USAGE_REVIEW_PROMPT.md (edited on purpose, prompt v2).
  const promptFile = path.join(home, 'review-prompt.md');
  fs.writeFileSync(promptFile, DEFAULT_USAGE_REVIEW_PROMPT, 'utf8');
  const prompts = [];
  const runOpus = async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: 'route via gemini', ms: 1 }; };
  const runGemini = async () => ({ ok: true, text: 'reduce review rounds', ms: 1 });
  const usage1 = {
    totals: { turns: 1, costUsd: 1 },
    merged: { units: [{ reviewRounds: 2, fixAfterMerge: false, costUsd: 1, inputTokens: 0, outputTokens: 0 }] },
    floor: { cleanShare: 0.5 },
  };
  await runUsageReview({ home, trigger: 'manual', usage: usage1, runOpus, runGemini, promptPath: promptFile });
  const rec1 = readUsageReviews(home)[0];
  assert.ok(rec1.kpis, 'kpis stored on the review record');
  assert.equal(rec1.kpis.unitsMerged, 1);
  assert.equal(rec1.kpis.avgReviewRounds, 2);

  const usage2 = {
    totals: { turns: 2, costUsd: 2 },
    merged: { units: [{ reviewRounds: 0, fixAfterMerge: false, costUsd: 1, inputTokens: 0, outputTokens: 0 }] },
    floor: { cleanShare: 1 },
  };
  await runUsageReview({ home, trigger: 'manual', usage: usage2, runOpus, runGemini, promptPath: promptFile });
  const prompt2 = prompts[1];
  assert.match(prompt2, /Previous review Opus said: route via gemini/, 'prior opus bullet included');
  assert.match(prompt2, /KPI delta since last review/, 'kpi delta section present');
  assert.match(prompt2, /firstTryPassRate 0->1/, 'firstTryPassRate delta 0->1');
  assert.match(prompt2, /avgReviewRounds 2->0/, 'avgReviewRounds delta 2->0');
  assert.match(prompt2, /grade in one line whether the previous review's recommendations improved the KPIs/, 'grading instruction present');
});

test('usa-10: GET /usage-export returns json or markdown, 400 on bad format', async () => {
  const home = tmp();
  const call = async (method, url, opts = {}) => {
    let out;
    await handleProvidersApi({ method, url }, {}, { home, ...probeOpts, ...opts, readBody: async () => ({}), sendJson: (_r, code, data) => { out = { code, data }; } });
    return out;
  };
  const json = await call('GET', '/__vibesquad/providers/usage-export?format=json');
  assert.equal(json.code, 200);
  assert.equal(json.data.ok, true);
  assert.ok(Array.isArray(json.data.byWorkflow));
  assert.ok(json.data.savings && json.data.cohorts && json.data.floor, 'benchmark sections present');
  const md = await call('GET', '/__vibesquad/providers/usage-export?format=md');
  assert.equal(md.code, 200);
  assert.match(md.data.markdown, /# VibeSquad usage benchmark/);
  const bad = await call('GET', '/__vibesquad/providers/usage-export?format=xml');
  assert.equal(bad.code, 400);
  assert.match(bad.data.error, /bad format/);
  const post = await call('POST', '/__vibesquad/providers/usage-export');
  assert.equal(post.code, 405);
});

// ---------------------------------------------------------------- usa-15 / usa-19: auto-route review bullets to perfection inbox

test('usa-15: parseReviewBullets strips markers/headings, skips the self-grade line, caps and truncates', () => {
  const text = [
    'Grade: prior review improved firstTryPassRate 0->1.',
    '- Profile/Provider routing: shift implementation to Gemini for low-risk units.',
    '2. Reduce review rounds by having Buddy pre-check the plan.',
    'Loops/Tool friction:',
    '* Cache tool results to cut re-fetching.',
    'Previous review: no prior review.',
    'a'.repeat(300),
  ].join('\n');
  const bullets = parseReviewBullets(text, { max: 5, maxLen: 100 });
  assert.equal(bullets.length, 4);
  assert.equal(bullets[0], 'Profile/Provider routing: shift implementation to Gemini for low-risk units.');
  assert.equal(bullets[1], 'Reduce review rounds by having Buddy pre-check the plan.');
  assert.equal(bullets[2], 'Cache tool results to cut re-fetching.');
  assert.equal(bullets[3], `${'a'.repeat(99)}…`);
});

test('usa-15: parseReviewBullets skips the first line of a multi-line reply and treats a lone grade line as empty', () => {
  assert.deepEqual(parseReviewBullets('No prior review yet.'), [], 'lone grade line -> no bullets');
  assert.deepEqual(parseReviewBullets('- Use Gemini more for implementation.'), ['Use Gemini more for implementation.'], 'single bullet line kept');
  assert.deepEqual(
    parseReviewBullets('The prior suggestions moved firstTryPassRate up.\n- Route to Gemini.'),
    ['Route to Gemini.'],
    'first line dropped even when it does not match the grade regex',
  );
  assert.deepEqual(parseReviewBullets(undefined), []);
  assert.deepEqual(parseReviewBullets(''), []);
});

test('usa-15 / usa-19: runUsageReview routes deduped bullets to the perfection inbox and records sentCardIds', async () => {
  const home = tmp();
  const root = path.resolve(import.meta.dirname, '..');
  addInboxCards(
    { ideas: ['Route implementation to Gemini'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home },
    root,
  );

  const runOpus = async () => ({
    ok: true,
    text: [
      'Grade: prior review improved KPIs.',
      '- Route implementation to Gemini', // deduped against the open perfection seed card
      '- Cache tool results to cut re-fetching', // new opus bullet
      '- Cache tool results to cut re-fetching', // deduped against the previous opus bullet
    ].join('\n'),
    ms: 1,
  });
  const runGemini = async () => ({
    ok: true,
    text: [
      'No prior review.',
      '- Cache tool results to cut re-fetching', // deduped against the opus bullet
      '- Reduce review rounds by pre-checking the plan', // new gemini bullet
    ].join('\n'),
    ms: 1,
  });

  const rec = await runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 2 } }, runOpus, runGemini });
  assert.equal(rec.sentCardIds.length, 2, 'two non-duplicate bullets routed');

  const cards = readInboxCards(home).filter((c) => c.laneId === 'perfection');
  assert.equal(cards.length, 3, 'seed + 2 routed');
  assert.equal(cards.filter((c) => c.text === 'Route implementation to Gemini').length, 1, 'seed not duplicated');
  assert.ok(cards.some((c) => c.text === 'Cache tool results to cut re-fetching' && c.source === 'usage-review:opus'));
  assert.ok(cards.some((c) => c.text === 'Reduce review rounds by pre-checking the plan' && c.source === 'usage-review:gemini'));
  assert.equal(readInboxCards(home).filter((c) => c.laneId === 'bug-chaser').length, 0, 'nothing routed to bug-chaser');

  const recs = readUsageReviews(home);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].sentCardIds, rec.sentCardIds);
});

test('usa-15 / usa-19: a model that fails to return ok contributes no inbox cards', async () => {
  const home = tmp();
  const runOpus = async () => ({ ok: false, error: 'quota exceeded', ms: 1 });
  const runGemini = async () => ({ ok: true, text: 'No prior review.\n- Reduce review rounds.', ms: 1 });
  const rec = await runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 1 } }, runOpus, runGemini });
  assert.equal(rec.sentCardIds.length, 1, 'only the gemini bullet routed');
  const cards = readInboxCards(home).filter((c) => c.laneId === 'perfection');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].source, 'usage-review:gemini');
});

test('usa-15: forbidden real home -> no inbox write, empty sentCardIds', async () => {
  const runOpus = async () => ({ ok: true, text: 'No prior review.\n- Route to Gemini.', ms: 1 });
  const runGemini = async () => ({ ok: true, text: 'No prior review.\n- Reduce rounds.', ms: 1 });
  const fakeReal = tmp();
  const prev = process.env.VS_TEST_REAL_HOME;
  process.env.VS_TEST_REAL_HOME = fakeReal;
  try {
    const rec = await runUsageReview({ home: fakeReal, trigger: 'manual', usage: { totals: { turns: 1 } }, runOpus, runGemini });
    assert.deepEqual(rec.sentCardIds, [], 'forbidden real home: nothing enqueued');
    assert.equal(rec.opus.ok, true);
    assert.deepEqual(fs.readdirSync(fakeReal), [], 'forbidden real home: no file or dir created (no review record, no inbox)');
  } finally {
    prev === undefined ? delete process.env.VS_TEST_REAL_HOME : (process.env.VS_TEST_REAL_HOME = prev);
  }
});

test('usa-15: triageInboxCards update accepts accepted/rejected and rejects bogus statuses', () => {
  const home = tmp();
  const root = path.resolve(import.meta.dirname, '..');
  const seeded = addInboxCards(
    { ideas: ['Route implementation to Gemini'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home },
    root,
  );
  const cardId = seeded.added[0].id;

  assert.equal(triageInboxCards({ action: 'update', cardId, patch: { status: 'accepted' }, baseHome: home }, root).card.status, 'accepted');
  assert.equal(triageInboxCards({ action: 'update', cardId, patch: { status: 'rejected' }, baseHome: home }, root).card.status, 'rejected');
  assert.equal(triageInboxCards({ action: 'update', cardId, patch: { status: 'parked' }, baseHome: home }, root).card.status, 'parked');
  assert.equal(triageInboxCards({ action: 'update', cardId, patch: { status: 'handed-off' }, baseHome: home }, root).card.status, 'handed-off');
  assert.equal(triageInboxCards({ action: 'update', cardId, patch: { status: 'archived' }, baseHome: home }, root).card.status, 'archived');

  assert.throws(() => triageInboxCards({ action: 'update', cardId, patch: { status: 'bogus' }, baseHome: home }, root), /Unknown inbox status "bogus"/);
  assert.throws(() => triageInboxCards({ action: 'update', cardId, patch: { status: 'accept' }, baseHome: home }, root), /Unknown inbox status "accept"/);
});

// ---------------------------------------------------------------- usa-19: prompt loader, path resolution, open-card dedupe, multi-Squad pooling

test('usa-19: loader returns the live repo prompt verbatim (independent of its content) and buildUsageReviewPrompt appends it', () => {
  const home = tmp();
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const repoPromptFile = path.join(repoRoot, USAGE_REVIEW_PROMPT_REL_PATH);
  // @perfection owns USAGE_REVIEW_PROMPT.md and edits it on purpose (prompt v2), so never assert it equals the
  // built-in DEFAULT_USAGE_REVIEW_PROMPT. Instead assert the loader returns the repo file's own trimmed content.
  const repoPrompt = fs.readFileSync(repoPromptFile, 'utf8').trim();
  assert.ok(repoPrompt.length > 0, 'repo prompt file is non-empty');
  assert.equal(loadUsageReviewPrompt({ runtimeRoot: repoRoot, envRoot: '' }), repoPrompt, 'loader returns the repo file content verbatim');

  const sampleUsage = {
    totals: { turns: 12, costUsd: 1.5, inputTokens: 4000, outputTokens: 800 },
    limits: [{ provider: 'claude', window: 'weekly', usedPct: 42, resetsAt: '2026-11-12T00:00:00.000Z' }],
    byProfile: [{ provider: 'claude', profile: 'Implement - Sonnet', role: 'worker', runs: 3, turns: 12, costUsd: 1.5, passRate: 1, costPerMergedUnit: 0.5, avgReviewRounds: 0.3, fixAfterMergeRate: 0 }],
    merged: { perLane: [{ lane: 'usage', mergedUnits: 3, reviewRounds: 1, costPerMergedUnit: 0.5, fixAfterMergeRate: 0 }] },
    lanes: [{ lane: 'usage', handoffs: 1, workPct: 0.75 }],
    byWorkflow: [{ workflowMode: 'sonnet+gemini-review', units: 3, firstTryPassRate: 1, costPerUnit: 0.5, costPer100Loc: 0.25, fixAfterMergeRate: 0 }],
    cohorts: { recent: { units: 3, firstTryPassRate: 1, costPerUnit: 0.5, fixAfterMergeRate: 0 }, prior: { units: 2, firstTryPassRate: 0.5, costPerUnit: 0.8, fixAfterMergeRate: 0 }, delta: { firstTryPassRate: 0.5, costPerUnit: -0.3, fixAfterMergeRate: 0 } },
    floor: { cleanShare: 0.9, cleanCostPerUnit: 0.45, reworkCostUsd: 0.15, loopAndAbandonedCostUsd: 0, fixAfterMergeCostUsd: 0, restartOverheadCostUsd: 0 },
  };
  const fromRepoFile = buildUsageReviewPrompt(sampleUsage, { home, runtimeRoot: repoRoot, envRoot: '' });
  assert.ok(fromRepoFile.endsWith(`\n${repoPrompt}`), 'repo instruction text appended at the end');

  // Byte-identity check stays, but against a temp root seeded with DEFAULT_USAGE_REVIEW_PROMPT (VIBESQUAD_ROOT
  // pointed at the temp dir), not the live repo file.
  const seededRoot = tmp();
  const seededPromptFile = path.join(seededRoot, USAGE_REVIEW_PROMPT_REL_PATH);
  fs.mkdirSync(path.dirname(seededPromptFile), { recursive: true });
  fs.writeFileSync(seededPromptFile, DEFAULT_USAGE_REVIEW_PROMPT, 'utf8');
  assert.equal(loadUsageReviewPrompt({ runtimeRoot: seededRoot, envRoot: seededRoot }), DEFAULT_USAGE_REVIEW_PROMPT, 'seeded temp root returns the built-in text verbatim');
  const fromSeeded = buildUsageReviewPrompt(sampleUsage, { home, runtimeRoot: seededRoot, envRoot: seededRoot });
  const fromFallback = buildUsageReviewPrompt(sampleUsage, { home, promptPath: path.join(home, 'missing.md'), warn: () => {} });
  assert.equal(fromSeeded, fromFallback, 'seeded prompt assembles a byte-identical prompt');
  assert.ok(fromSeeded.endsWith(`\n${DEFAULT_USAGE_REVIEW_PROMPT}`), 'built-in instruction text appended at the end');
});

test('usa-19: resolveUsageReviewPromptPath resolves live repo via build-stamp.json or VIBESQUAD_ROOT so edits take effect without sync-runtime', () => {
  const liveRepo = tmp();
  const runtimeDir = tmp();
  const overrideRepo = tmp();

  // Simulated runtime copy: no docs/ in runtimeDir, only build-stamp.json pointing at liveRepo/.git
  fs.writeFileSync(
    path.join(runtimeDir, 'build-stamp.json'),
    JSON.stringify({ commit: 'abc1234', repo: path.join(liveRepo, '.git'), builtAt: '2026-11-09T00:00:00.000Z' }),
    'utf8',
  );
  const livePromptFile = path.join(liveRepo, USAGE_REVIEW_PROMPT_REL_PATH);
  fs.mkdirSync(path.dirname(livePromptFile), { recursive: true });
  fs.writeFileSync(livePromptFile, 'Custom instruction v1 from Workflows.', 'utf8');

  assert.equal(
    resolveUsageReviewPromptPath({ runtimeRoot: runtimeDir, envRoot: '' }),
    path.join(path.resolve(liveRepo), USAGE_REVIEW_PROMPT_REL_PATH),
    'runtime build-stamp.json resolves to the live repo checkout',
  );
  assert.equal(
    loadUsageReviewPrompt({ runtimeRoot: runtimeDir, envRoot: '' }),
    'Custom instruction v1 from Workflows.',
  );

  // Edit the live repo file without touching runtimeDir -> next load sees v2 immediately
  fs.writeFileSync(livePromptFile, 'Custom instruction v2 after live repo edit.\n', 'utf8');
  assert.equal(
    loadUsageReviewPrompt({ runtimeRoot: runtimeDir, envRoot: '' }),
    'Custom instruction v2 after live repo edit.',
    'edit to live repo takes effect immediately without sync-runtime',
  );

  // VIBESQUAD_ROOT (envRoot) overrides both runtimeDir and build-stamp.json
  assert.equal(
    resolveUsageReviewPromptPath({ runtimeRoot: runtimeDir, envRoot: overrideRepo }),
    path.join(path.resolve(overrideRepo), USAGE_REVIEW_PROMPT_REL_PATH),
    'envRoot override wins over build-stamp.json',
  );

  // Dev checkout (no build-stamp.json, no envRoot) resolves directly against runtimeRoot
  const devRepo = tmp();
  assert.equal(
    resolveUsageReviewPromptPath({ runtimeRoot: devRepo, envRoot: '' }),
    path.join(path.resolve(devRepo), USAGE_REVIEW_PROMPT_REL_PATH),
  );
});

test('usa-19: missing or blank USAGE_REVIEW_PROMPT.md falls back to built-in text and warns only once per process', () => {
  const dir = tmp();
  const missingFile = path.join(dir, 'does-not-exist.md');
  const emptyFile = path.join(dir, 'empty.md');
  fs.writeFileSync(emptyFile, '   \n\t  ', 'utf8');

  resetUsageReviewPromptWarnForTest();
  const warnings = [];
  const warn = (msg) => warnings.push(msg);

  assert.equal(loadUsageReviewPrompt({ promptPath: missingFile, warn }), DEFAULT_USAGE_REVIEW_PROMPT);
  assert.equal(loadUsageReviewPrompt({ promptPath: missingFile, warn }), DEFAULT_USAGE_REVIEW_PROMPT);
  assert.equal(loadUsageReviewPrompt({ promptPath: emptyFile, warn }), DEFAULT_USAGE_REVIEW_PROMPT);
  assert.equal(warnings.length, 1, 'fallback warning logged at most once per process');
  assert.match(warnings[0], /usage-review:.*using built-in fallback/);

  // After reset, an empty file also warns once and falls back
  resetUsageReviewPromptWarnForTest();
  const warnings2 = [];
  assert.equal(loadUsageReviewPrompt({ promptPath: emptyFile, warn: (m) => warnings2.push(m) }), DEFAULT_USAGE_REVIEW_PROMPT);
  assert.equal(loadUsageReviewPrompt({ promptPath: emptyFile, warn: (m) => warnings2.push(m) }), DEFAULT_USAGE_REVIEW_PROMPT);
  assert.equal(warnings2.length, 1);
  assert.match(warnings2[0], /empty/);
});

test('usa-19: routeReviewToInbox dedupes only against open (parked/accepted) perfection cards, not closed perfection or bug-chaser cards', async () => {
  const home = tmp();
  const root = path.resolve(import.meta.dirname, '..');

  // 1) Open perfection cards (parked + accepted) should dedupe
  addInboxCards({ ideas: ['Parked perfection recommendation'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home }, root);
  const acc = addInboxCards({ ideas: ['Accepted perfection recommendation'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home }, root);
  triageInboxCards({ action: 'update', cardId: acc.added[0].id, patch: { status: 'accepted' }, baseHome: home }, root);

  // 2) Closed perfection cards (rejected, archived, handed-off) must NOT block re-routing
  const rej = addInboxCards({ ideas: ['Rejected workflow tweak'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home }, root);
  triageInboxCards({ action: 'update', cardId: rej.added[0].id, patch: { status: 'rejected' }, baseHome: home }, root);
  const arch = addInboxCards({ ideas: ['Archived routing rule'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home }, root);
  triageInboxCards({ action: 'update', cardId: arch.added[0].id, patch: { status: 'archived' }, baseHome: home }, root);
  const hand = addInboxCards({ ideas: ['Handed off cap adjustment'], laneId: 'perfection', teamId: 'vibesquad', source: 'seed', baseHome: home }, root);
  triageInboxCards({ action: 'update', cardId: hand.added[0].id, patch: { status: 'handed-off' }, baseHome: home }, root);

  // 3) Open bug-chaser card must NOT dedupe perfection bullets
  addInboxCards({ ideas: ['Shift implementation to Gemini'], laneId: 'bug-chaser', teamId: 'vibesquad', source: 'seed', baseHome: home }, root);

  const runOpus = async () => ({
    ok: true,
    text: [
      'Grade: KPIs steady.',
      '- Parked perfection recommendation', // deduped (parked)
      '- Accepted perfection recommendation', // deduped (accepted)
      '- Rejected workflow tweak', // allowed (was rejected)
      '- Archived routing rule', // allowed (was archived)
    ].join('\n'),
    ms: 1,
  });
  const runGemini = async () => ({
    ok: true,
    text: [
      'Grade: KPIs steady.',
      '- Handed off cap adjustment', // allowed (was handed-off)
      '- Shift implementation to Gemini', // allowed (only open in bug-chaser, not perfection)
    ].join('\n'),
    ms: 1,
  });

  const rec = await runUsageReview({ home, trigger: 'manual', usage: { totals: { turns: 5 } }, runOpus, runGemini });
  assert.equal(rec.sentCardIds.length, 4, 'only the 4 bullets not open in perfection are added');
  const addedCards = readInboxCards(home).filter((c) => rec.sentCardIds.includes(c.id));
  assert.equal(addedCards.length, 4);
  assert.ok(addedCards.every((c) => c.laneId === 'perfection' && c.status === 'parked'));
  assert.deepEqual(
    addedCards.map((c) => [c.text, c.source]),
    [
      ['Rejected workflow tweak', 'usage-review:opus'],
      ['Archived routing rule', 'usage-review:opus'],
      ['Handed off cap adjustment', 'usage-review:gemini'],
      ['Shift implementation to Gemini', 'usage-review:gemini'],
    ],
  );
});

test('usa-19: getUsage and readUsageLogSignals pool agent runs, logs, handoffs, and lane codes across multiple Squads', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 8, 12);

  // Two Squads in teams.json: vibesquad + a second Squad ("other-squad")
  fs.writeFileSync(
    path.join(home, 'teams.json'),
    JSON.stringify({
      teams: [
        { id: 'vibesquad', name: 'VibeSquad', lanes: [{ id: 'usage', code: 'usa' }] },
        { id: 'other-squad', name: 'Other Squad', lanes: [{ id: 'combat-loop', code: 'cbt' }] },
      ],
    }),
    'utf8',
  );

  writeAgent(home, 'rn-vs', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1.25 },
  ]);
  writeAgent(home, 'rn-other', [
    { ts: T0, type: 'created', provider: 'antigravity-cli', model: 'g', meta: { lane: 'combat-loop', role: 'worker', profile: 'Implement - Gemini' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 0.75 },
  ]);

  // Log signals and handoffs from both Squads
  writeLog(home, 'teams/vibesquad/log.jsonl', L_ENTRY(T0 + 2000, 'rn-lead', 'usage', 'decision', '@usa: pool all squads'));
  writeLog(home, 'teams/other-squad/log.jsonl', L_ENTRY(T0 + 3000, 'rn-other-w', 'combat-loop', 'blocker', 'other-squad turn cap hit'));
  writeLog(home, 'logs/other-squad--combat-loop.jsonl', L_ENTRY(T0 + 4000, 'rn-other-b', 'combat-loop', 'handoff', 'combat plan ready'));

  const u = getUsage({ home, git: noGit });
  assert.equal(u.totals.turns, 2, 'turns pooled across both Squads');
  assert.equal(u.totals.costUsd, 2, 'cost pooled across both Squads');
  assert.deepEqual(u.byLane.map((l) => l.lane).sort(), ['combat-loop', 'usage']);

  const prompt = buildUsageReviewPrompt(u, { home });
  assert.match(prompt, /@usa: pool all squads/, 'vibesquad team log note included');
  assert.match(prompt, /other-squad turn cap hit/, 'other-squad team log friction included');
});

// ---------------------------------------------------------------- usa-20: merged units pooled across Squad repos
test('usage: merged units pool across every Squad repo, tagged repo/squad, attributed within their own Squad', async () => {
  const { execFileSync } = await import('node:child_process');
  const base = tmp();
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });
  const mkRepo = (name, unit, code) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    g(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'init');
    if (unit) {
      g(dir, 'checkout', '-q', '-b', unit);
      fs.writeFileSync(path.join(dir, 'g.txt'), `${name}\n`);
      g(dir, 'add', '.');
      g(dir, 'commit', '-q', '-m', `feat: ${name} (@${code}) review r1`);
      g(dir, 'checkout', '-q', 'main');
      g(dir, 'merge', '-q', '--no-ff', '-m', `Merge branch '${unit}' (@${code})`, unit);
    }
    return dir;
  };
  mkRepo('main', null);
  mkRepo('alpha', 'unit-shared', 'usa');
  mkRepo('beta', 'unit-shared', 'usa');
  mkRepo('plain-dir-not-git', null);
  fs.rmSync(path.join(base, 'plain-dir-not-git', '.git'), { recursive: true, force: true });
  const home = tmp();
  fs.writeFileSync(path.join(home, 'teams.json'), JSON.stringify({ teams: [
    { id: 'sq-a', paths: ['alpha'], lanes: [{ id: 'usage', code: 'usa' }] },
    { id: 'sq-b', paths: [path.join(base, 'beta')], lanes: [{ id: 'usage', code: 'usa' }] },
    { id: 'sq-c', paths: ['plain-dir-not-git', 'does-not-exist'], lanes: [] },
  ] }));
  const T0 = Date.now() - 3600_000;
  for (const [id, team] of [['rn-a', 'sq-a'], ['rn-b', 'sq-b']]) {
    writeAgent(home, id, [
      { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/wt/unit-shared', meta: { lane: 'usage', role: 'worker', profile: `Impl ${team}`, labels: { team } } },
      { ts: T0 + 1000, type: 'turn_done', costUsd: team === 'sq-a' ? 1 : 3 },
    ]);
  }
  const prevRoot = process.env.VIBESQUAD_ROOT;
  process.env.VIBESQUAD_ROOT = path.join(base, 'main');
  try {
    clearUsageCache();
    let t = Date.now();
    const u = getUsage({ home, now: () => t });
    const units = u.merged.units.filter((x) => x.unit === 'unit-shared');
    assert.equal(units.length, 2, 'same unit name in two repos stays two units');
    const a = units.find((x) => x.repo === 'alpha');
    const b = units.find((x) => x.repo === 'beta');
    assert.equal(a.squad, 'sq-a');
    assert.equal(b.squad, 'sq-b');
    assert.notEqual(a.sha, b.sha);
    assert.equal(a.lane, 'usage');
    assert.equal(a.implementerAgentId, 'rn-a', 'attributed to its own Squad worker, not the other Squad\'s same-named unit');
    assert.equal(b.implementerAgentId, 'rn-b');
    assert.equal(a.costUsd, 1);
    assert.equal(b.costUsd, 3);
    assert.equal(a.reviewRounds, 1);
    assert.equal(u.byProfile.find((p) => p.profile === 'Impl sq-a').mergedUnits, 1);
    assert.equal(u.byProfile.find((p) => p.profile === 'Impl sq-b').mergedUnits, 1);
    assert.ok(!u.merged.units.some((x) => x.repo === 'plain-dir-not-git'), 'non-git paths skipped silently');
    // ledger: new records carry squad/repo; an old record without them still loads and folds.
    const ledger = readUsageLedger(home);
    assert.equal(ledger.find((r) => r.sha === a.sha).squad, 'sq-a');
    assert.equal(ledger.find((r) => r.sha === b.sha).repo, 'beta');
    fs.appendFileSync(path.join(home, 'runner', 'usage-ledger.jsonl'), JSON.stringify({ kind: 'unit', unit: 'old-unit', sha: 'deadbeef', ts: new Date(T0).toISOString(), lane: 'usage', reviewRounds: 1 }) + '\n');
    clearUsageCache();
    const u2 = getUsage({ home, now: () => t });
    const old = u2.merged.units.find((x) => x.sha === 'deadbeef');
    assert.ok(old && old.fromLedger && old.squad === null, 'legacy ledger record without squad/repo still folds');
    // cost bound: a new merge in alpha is not seen inside the HEAD-check TTL, but is after it.
    g(path.join(base, 'alpha'), 'checkout', '-q', '-b', 'unit-late');
    fs.writeFileSync(path.join(base, 'alpha', 'h.txt'), 'h\n');
    g(path.join(base, 'alpha'), 'add', '.');
    g(path.join(base, 'alpha'), 'commit', '-q', '-m', 'feat: late (@usa)');
    g(path.join(base, 'alpha'), 'checkout', '-q', 'main');
    g(path.join(base, 'alpha'), 'merge', '-q', '--no-ff', '-m', "Merge branch 'unit-late' (@usa)", 'unit-late');
    clearUsageCache();
    assert.equal(getUsage({ home, now: () => t + 1000 }).merged.units.filter((x) => x.repo === 'alpha').length, 1, 'within TTL: no git re-run');
    t += 60_000;
    clearUsageCache();
    assert.equal(getUsage({ home, now: () => t }).merged.units.filter((x) => x.repo === 'alpha').length, 2, 'after TTL: new HEAD picked up');
    // Remove the synthetic ledger record so subsequent tests using the same fake shas (m1..m3) don't fold 'deadbeef'.
    fs.rmSync(path.join(home, 'runner', 'usage-ledger.jsonl'), { force: true });
  } finally {
    if (prevRoot === undefined) delete process.env.VIBESQUAD_ROOT; else process.env.VIBESQUAD_ROOT = prevRoot;
  }
});

// ---------------------------------------------------------------- usa-21: EXP2 review-round parse, verdict parse, sanctuary worktree attribution

test('usa-21 (idea-38): review-round parser extracts max R<n> or fixN count from merge and branch subjects', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 8, 12);
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm7\n';
    if (args[0] === 'log') {
      return [
        // 1) "Review-Gemini R1 FAIL -> R2 PASS" (ea23807 / 920254b pattern) -> 2
        L('m7', 'm6 b7', sec(T0 + 70000), "Merge branch 'unit-argv-mcp-config': claude adapter passes --mcp-config [wf:sonnet] (@bug; Review-Gemini R1 FAIL -> R2 PASS)"),
        L('b7', 'm6', sec(T0 + 65000), 'Claude adapter: pass --mcp-config via per-agent temp file'),
        // 2) "R1 FAIL -> R2 FAIL -> R3 PASS" (8c87f2b pattern) -> 3
        L('m6', 'm5 b6', sec(T0 + 60000), "Merge branch 'unit-wiki-link-check': guide-to-wiki test audits [wf:gemini] (@wik; Implement-Sonnet-as-reviewer R1 FAIL -> R2 FAIL -> R3 PASS)"),
        L('b6', 'm5', sec(T0 + 55000), 'test(wiki): check link targets'),
        // 3) "R1-R3 FAIL -> R4 PASS" (b5e230e pattern) -> 4
        L('m5', 'm4 b5', sec(T0 + 50000), "Merge branch 'unit-digest-waste-dedupe': one digest per worker turn [wf:gemini] (@per; Implement-Sonnet-as-reviewer R1-R3 FAIL -> R4 PASS)"),
        L('b5', 'm4', sec(T0 + 45000), 'fix(hooks): scope null-turnId digest dedupe'),
        // 4) "R3 PASS 0/0/0" and "after R1 FAIL" -> 3
        L('m4', 'm3 b4', sec(T0 + 40000), "Merge branch 'unit-after-r1': clean up after R1 FAIL, R3 PASS 0/0/0 [wf:sonnet] (@usa)"),
        L('b4', 'm3', sec(T0 + 35000), 'feat: initial'),
        // 5) "Review-Gemini R1 contrast FAIL -> ... fix1" -> max R<n> is 1, fix1 is 1 -> 1; with fix1+fix2 and no R<n> -> 2
        L('m3', 'm2 b3', sec(T0 + 30000), "Merge branch 'unit-fix-counts': Sonnet read-only review PASS 0/0/1L -> fix1 -> fix2 [wf:gemini] (@usa)"),
        L('b3', 'm2', sec(T0 + 25000), 'feat: loader'),
        // 6) Rule names like R11 / R12 / R13 in subject must NOT count as review rounds; plain "Review-Gemini PASS 0/0/0" -> 0
        L('m2', 'm1 b2', sec(T0 + 20000), "Merge branch 'unit-r11-act-on-lean': R11 tightened; new R13 act on your lean [wf:sonnet] (@per; Review-Gemini PASS 0/0/0)"),
        L('b2', 'm1', sec(T0 + 15000), 'docs: R11 and R12 updates'),
        // 7) Legacy side-commit "review r2" format still works -> 2
        L('m1', 'a1 b1', sec(T0 + 10000), "Merge branch 'unit-legacy-r2' (@usa)"),
        L('b1', 'a1', sec(T0 + 5000), 'fix(x): review r2 - address findings'),
        L('a1', 'root', sec(T0), 'mainline'),
        L('root', '', '0', 'init'),
      ].join('\n');
    }
    return '';
  };
  const u = getUsage({ home, git, laneCodes: { usa: 'usage', bug: 'bug-chaser', wik: 'wiki', per: 'perfection' } });
  const roundsByUnit = Object.fromEntries(u.merged.units.map((x) => [x.unit, x.reviewRounds]));
  assert.equal(roundsByUnit['unit-argv-mcp-config'], 2, 'R1 FAIL -> R2 PASS = 2 rounds');
  assert.equal(roundsByUnit['unit-wiki-link-check'], 3, 'R1 FAIL -> R2 FAIL -> R3 PASS = 3 rounds');
  assert.equal(roundsByUnit['unit-digest-waste-dedupe'], 4, 'R1-R3 FAIL -> R4 PASS = 4 rounds');
  assert.equal(roundsByUnit['unit-after-r1'], 3, 'after R1 FAIL + R3 PASS 0/0/0 = 3 rounds');
  assert.equal(roundsByUnit['unit-fix-counts'], 2, 'fix1 -> fix2 without R<n> = 2 rounds');
  assert.equal(roundsByUnit['unit-r11-act-on-lean'], 0, 'R11/R13 rule names ignored, plain PASS = 0');
  assert.equal(roundsByUnit['unit-legacy-r2'], 2, 'legacy side-commit review r2 preserved');

  const sonnetWf = u.byWorkflow.find((w) => w.workflowMode === 'sonnet');
  const geminiWf = u.byWorkflow.find((w) => w.workflowMode === 'gemini');
  assert.ok(sonnetWf.avgReviewRounds > 0 && sonnetWf.firstTryPassRate < 1, 'sonnet arm reflects R2/R3 rework');
  assert.ok(geminiWf.avgReviewRounds > 0 && geminiWf.firstTryPassRate < 1, 'gemini arm reflects R3/R4/fix2 rework');
});

test('usa-21 (idea-51): verdict parser accepts **PASS**, VERDICT: PASS, R2 PASS in first/last line, FAIL wins, ignores prose passes/passed', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 8, 12);
  const turns = Array.from({ length: LOOP_TURN_THRESHOLD + 1 }, () => ({ ts: T0 + 1000, type: 'turn_done' }));
  const mkReviewer = (id, text) => writeAgent(home, id, [
    { ts: T0, type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', meta: { lane: 'usage', role: 'worker', profile: 'Review - Gemini' } },
    { ts: T0 + 100, type: 'output', text },
    ...turns,
  ]);

  // Should count as PASS:
  mkReviewer('rn-bold-pass', '**PASS** — all checks green (`abc1234`, 42/42 tests).\n- Details here.');
  mkReviewer('rn-verdict-pass', 'Reviewed diff and tests.\n- Guard intact.\nVERDICT: PASS (0H/0M/1L)');
  mkReviewer('rn-r2-pass', 'Reported R2 PASS (`dd0baf1`, 35/35 tests passing) to lead.\nDone.');
  mkReviewer('rn-backtick-pass', 'Summary line.\nCompleted at R5 `PASS` (0 findings).');

  // Should NOT count as PASS (FAIL wins or prose only):
  mkReviewer('rn-verdict-fail', 'Verdict: FAIL\n- 1H issue found.');
  mkReviewer('rn-fail-wins-same-line', 'All tests **PASS** but FAIL here\nDetails.');
  mkReviewer('rn-fail-wins-first-last', '**PASS** on unit tests\nOverall Verdict: FAIL (1H)');
  writeAgent(home, 'rn-fail-wins-streamed', [
    { ts: T0, type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', meta: { lane: 'usage', role: 'worker', profile: 'Review - Gemini' } },
    { ts: T0 + 100, type: 'output', text: '**PASS** on unit tests\n' },
    { ts: T0 + 200, type: 'output', text: 'Middle line.\nOverall Verdict: FAIL (1H)\n' },
    ...turns,
  ]);
  mkReviewer('rn-prose-only', 'The test suite passes and all checks passed without errors.\nEverything passed.');

  const u = getUsage({ home, git: noGit });
  const revProfile = u.byProfile.find((p) => p.profile === 'Review - Gemini');
  assert.equal(revProfile.runs, 9);
  assert.equal(revProfile.passCount, 4, 'exactly the 4 PASS variants count');
  assert.equal(revProfile.passRate, 0.444);
  assert.deepEqual(
    u.loops.flagged.map((l) => l.agentId).sort(),
    ['rn-fail-wins-first-last', 'rn-fail-wins-same-line', 'rn-fail-wins-streamed', 'rn-prose-only', 'rn-verdict-fail'],
    'all 5 non-PASS runs (including anchored PASS + unanchored FAIL and multi-chunk first-line PASS + last-line FAIL) are flagged as loops',
  );
});

test('usa-21 (idea-39): sanctuary worktree attribution normalizes paths, disambiguates implementers from reviewers/digests, and keeps lane fallback + sameSquad', async () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 8, 12);

  // Unit 1: Windows sanctuary path with trailing backslash + uppercase drive, alongside Pre-check - Flash digest and Review - Gemini in the SAME worktree
  const wt1 = 'C:\\Users\\alice\\AppData\\Local\\VibeSquad\\worktrees\\VibeSquad\\unit-sanctuary-sonnet\\';
  writeAgent(home, 'rn-sonnet-impl', [
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: wt1, meta: { team: 'vibesquad', lane: 'usage', role: 'worker', profile: 'agent_profile_mut1e4lx_us7pdrypi8q', title: 'Usa1 · sonnet impl' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1.25 },
  ]);
  writeAgent(home, 'rn-sonnet-digest', [
    { ts: T0 + 2000, type: 'created', provider: 'antigravity-cli', model: 'gemini-3.8-flash', cwd: wt1, meta: { team: 'vibesquad', lane: 'usage', role: 'worker', profile: 'Pre-check - Flash', title: 'Pre-check - Flash digest' } },
    { ts: T0 + 2500, type: 'turn_done', costUsd: 0.01 },
  ]);
  writeAgent(home, 'rn-sonnet-rev', [
    { ts: T0 + 3000, type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: wt1, meta: { team: 'vibesquad', lane: 'usage', role: 'worker', profile: 'Review - Gemini', title: 'Usa1 · review sonnet impl' } },
    { ts: T0 + 3500, type: 'turn_done', costUsd: 0.2 },
  ]);

  // Unit 2: Forward-slash sanctuary path with lowercase drive, Gemini trial implementer + Implement-Sonnet-as-reviewer (ROLE: reviewer) in the SAME worktree
  const wt2 = 'c:/Users/alice/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-sanctuary-gemini/';
  writeAgent(home, 'rn-gemini-impl', [
    { ts: T0, type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: wt2, meta: { team: 'vibesquad', lane: 'perfection', role: 'worker', profile: 'Implement - Gemini (trial)', title: 'Per1 · gemini impl' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 0.45 },
  ]);
  writeAgent(home, 'rn-sonnet-as-rev', [
    { ts: T0 + 2000, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: wt2, meta: { team: 'vibesquad', lane: 'perfection', role: 'worker', profile: 'Implement - Sonnet', title: 'Per1 · review gemini impl' } },
    { ts: T0 + 2100, type: 'input', text: 'ROLE: reviewer (read-only: do NOT edit files or commit). Review branch unit-sanctuary-gemini.' },
    { ts: T0 + 2500, type: 'turn_done', costUsd: 0.3 },
  ]);

  // Unit 3: DSP implementer in sanctuary worktree (with digest worker in same worktree)
  const wt3 = 'C:/Users/alice/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-sanctuary-dsp';
  writeAgent(home, 'rn-dsp-impl', [
    { ts: T0, type: 'created', provider: 'opencode', model: 'deepseek/deepseek-v4-pro', cwd: wt3, meta: { team: 'vibesquad', lane: 'usage', role: 'worker', profile: 'Work Order - DSP', title: 'Usa2 · dsp impl' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 0.1 },
  ]);
  writeAgent(home, 'rn-dsp-digest', [
    { ts: T0 + 1500, type: 'created', provider: 'antigravity-cli', model: 'gemini-3.8-flash', cwd: wt3, meta: { team: 'vibesquad', lane: 'usage', role: 'worker', profile: 'Pre-check - Flash', title: 'Pre-check - Flash digest' } },
    { ts: T0 + 2000, type: 'turn_done', costUsd: 0.01 },
  ]);

  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm3\n';
    if (args[0] === 'log') {
      return [
        L('m3', 'm2 b3', sec(T0 + 30000), "Merge branch 'unit-sanctuary-dsp' [wf:dsp] (@usa)"),
        L('b3', 'm2', sec(T0 + 25000), 'feat: dsp (@usa)'),
        L('m2', 'm1 b2', sec(T0 + 20000), "Merge branch 'unit-sanctuary-gemini' [wf:gemini] (@per; Implement-Sonnet-as-reviewer R1 FAIL -> R2 PASS)"),
        L('b2', 'm1', sec(T0 + 15000), 'feat: gemini (@per)'),
        L('m1', 'a1 b1', sec(T0 + 10000), "Merge branch 'unit-sanctuary-sonnet' [wf:sonnet] (@usa; Review-Gemini R1 PASS)"),
        L('b1', 'a1', sec(T0 + 5000), 'feat: sonnet (@usa)'),
        L('a1', 'root', sec(T0), 'mainline'),
        L('root', '', '0', 'init'),
      ].join('\n');
    }
    return '';
  };

  const u = getUsage({ home, git, laneCodes: { usa: 'usage', per: 'perfection' } });
  const byUnit = Object.fromEntries(u.merged.units.map((x) => [x.unit, x]));
  assert.equal(byUnit['unit-sanctuary-sonnet'].implementerAgentId, 'rn-sonnet-impl', 'Sonnet implementer wins over digest + Review-Gemini in same worktree; profile id normalized');
  assert.equal(byUnit['unit-sanctuary-sonnet'].implementerProfile, 'Implement - Sonnet');
  assert.equal(byUnit['unit-sanctuary-gemini'].implementerAgentId, 'rn-gemini-impl', 'Gemini implementer wins over Sonnet-as-reviewer in same worktree');
  assert.equal(byUnit['unit-sanctuary-gemini'].reviewRounds, 2);

  assert.equal(byProfileOf(u, 'Implement - Sonnet').mergedUnits, 1);
  assert.equal(byProfileOf(u, 'Implement - Sonnet').costPerMergedUnit, 1.55, 'total profile cost (1.25 + 0.30) / 1 merged unit');
  assert.equal(byProfileOf(u, 'Implement - Gemini (trial)').mergedUnits, 1);
  assert.equal(byProfileOf(u, 'Implement - Gemini (trial)').costPerMergedUnit, 0.45);
  assert.equal(byProfileOf(u, 'Work Order - DSP').mergedUnits, 1);

  // Also verify sameSquad + lane fallback when unit.squad is set (e.g. pooled multi-repo unit)
  const { execFileSync } = await import('node:child_process');
  const repoDir = tmp();
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const runG = (...args) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });
  runG('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'f.txt'), '1\n');
  runG('add', '.');
  runG('commit', '-q', '-m', 'init');
  runG('checkout', '-q', '-b', 'unit-sanctuary-dsp');
  fs.writeFileSync(path.join(repoDir, 'f.txt'), '2\n');
  runG('add', '.');
  runG('commit', '-q', '-m', 'feat: dsp (@usa)');
  runG('checkout', '-q', 'main');
  runG('merge', '-q', '--no-ff', '-m', "Merge branch 'unit-sanctuary-dsp' [wf:dsp] (@usa)", 'unit-sanctuary-dsp');

  const home2 = tmp();
  fs.writeFileSync(path.join(home2, 'teams.json'), JSON.stringify({
    teams: [{ id: 'vibesquad', paths: [repoDir], lanes: [{ id: 'usage', code: 'usa' }] }],
  }));
  writeAgent(home2, 'rn-dsp-impl', [
    { ts: T0, type: 'created', provider: 'opencode', model: 'deepseek/deepseek-v4-pro', cwd: wt3, meta: { team: 'vibesquad', lane: 'usage', role: 'worker', profile: 'Work Order - DSP', title: 'Usa2 · dsp impl' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 0.1 },
  ]);
  writeAgent(home2, 'rn-other-squad', [
    { ts: T0, type: 'created', provider: 'claude', model: 'claude-sonnet-5-5', cwd: 'C:/Users/alice/AppData/Local/VibeSquad/worktrees/OtherRepo/unit-sanctuary-dsp', meta: { team: 'other-squad', lane: 'usage', role: 'worker', profile: 'Implement - Sonnet', title: 'Other · impl' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 9.99 },
  ]);
  const prevRoot = process.env.VIBESQUAD_ROOT;
  process.env.VIBESQUAD_ROOT = repoDir;
  try {
    clearUsageCache();
    const uPooled = getUsage({ home: home2, now: () => T0 + 60000 });
    const dspUnit = uPooled.merged.units.find((x) => x.unit === 'unit-sanctuary-dsp');
    assert.equal(dspUnit.squad, 'vibesquad');
    assert.equal(dspUnit.implementerAgentId, 'rn-dsp-impl', 'sameSquad guard excludes other-squad worker on the same unit name');
    assert.equal(byProfileOf(uPooled, 'Work Order - DSP').mergedUnits, 1);
    assert.equal(byProfileOf(uPooled, 'Implement - Sonnet').mergedUnits, 0);
  } finally {
    if (prevRoot === undefined) delete process.env.VIBESQUAD_ROOT;
    else process.env.VIBESQUAD_ROOT = prevRoot;
  }
});

test('usa-22: bootSize rollup folds boot-size metrics by role/provider/lane (avg + p90), tolerates legacy lines, shows in getUsage + md export', async () => {
  const home = tmp();
  const t0 = Date.UTC(2026, 10, 9, 12);
  const line = (role, prov, lane, total, sys, plugin, artifact, brief, first) =>
    `boot-size role=${role} provider=${prov} lane=${lane} chars=${total - first} total=${total} sys=${sys} plugin=${plugin} artifact=${artifact} brief=${brief} first=${first} estTok=${Math.ceil(total / 4)}`;
  for (let i = 1; i <= 10; i++) writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0 + i * 1000, 'plugin', 'usage', 'metric', line('worker', 'claude', 'usage', i * 100, 10, 20, 30, 0, 5)));
  writeLog(home, 'logs/vibesquad--other.jsonl', L_ENTRY(t0 + 20000, 'plugin', 'other', 'metric', 'boot-size role=lead chars=4000')); // legacy: total only
  writeLog(home, 'teams/vibesquad/log.jsonl', L_ENTRY(t0 + 1000, 'plugin', 'usage', 'metric', line('worker', 'claude', 'usage', 100, 10, 20, 30, 0, 5))); // dup -> deduped
  writeLog(home, 'logs/vibesquad--usage.jsonl', L_ENTRY(t0 + 30000, 'plugin', 'usage', 'metric', 'prompt-injection role=lead provider=claude chars=999')); // not a boot-size line

  const rows = readBootSizes(home);
  const w = rows.find((r) => r.role === 'worker');
  assert.equal(w.count, 10, 'dup deduped');
  assert.equal(w.provider, 'claude');
  assert.equal(w.lane, 'usage');
  assert.equal(w.avgChars, 550);
  assert.equal(w.p90Chars, 900);
  assert.equal(w.p90EstTok, 225);
  assert.deepEqual(w.avgParts, { sys: 10, plugin: 20, artifact: 30, brief: 0, first: 5 });
  const l = rows.find((r) => r.role === 'lead');
  assert.deepEqual([l.provider, l.lane, l.count, l.avgChars, l.avgEstTok], ['unknown', 'other', 1, 4000, 1000], 'legacy line counts as total-only');
  assert.equal(rows.length, 2);
  assert.deepEqual(foldBootSizes([{ lane: '', text: 'boot-size role=x chars=notanumber' }]), [], 'garbage skipped');
  assert.deepEqual(readBootSizes(home, { since: '2026-11-10' }), [], 'day filter');

  clearUsageCache();
  const usage = getUsage({ home, git: noGit });
  assert.equal(usage.bootSize.length, 2, 'exposed in getUsage');
  let md;
  await handleProvidersApi({ method: 'GET', url: '/__vibesquad/providers/usage-export?format=md' }, {}, { home, ...probeOpts, readBody: async () => ({}), sendJson: (_r, _c, data) => { md = data.markdown; } });
  assert.match(md, /## Boot size/);
  assert.match(md, /\| worker \| claude \| usage \| 10 \| 550 \| 900 \|/);
});

test('usa-14: withPoolAgents attributes antigravity-cli claude-*/gpt-* agents to the 3rd-party pool row only', () => {
  const rows = [
    { provider: 'antigravity-cli', window: '5h', usedPct: 4 },
    { provider: 'antigravity-cli/claude-gpt', window: 'weekly', usedPct: 19 },
  ];
  const none = withPoolAgents(rows, [{ agentId: 'a', provider: 'antigravity-cli', model: 'gemini-4-argon' }, { agentId: 'b', provider: 'claude', model: 'claude-sonnet-5-5' }]);
  assert.equal(none[0].poolAgents, undefined, 'Gemini pool row untouched');
  assert.deepEqual(none[1].poolAgents, { count: 0, agentIds: [], text: '0 VibeSquad agents (used outside VibeSquad)' });
  const some = withPoolAgents(rows, [{ agentId: 'a', provider: 'antigravity-cli', model: 'claude-sonnet-5-5' }, { agentId: 'c', provider: 'antigravity-cli', model: 'gpt-5' }, { agentId: 'd', provider: 'antigravity-cli', model: 'gemini-4' }]);
  assert.deepEqual(some[1].poolAgents, { count: 2, agentIds: ['a', 'c'], text: '2 VibeSquad agents' });
});

test('usa-12 fix1: review prompt emits successRate + basis per profile row, "-" for no-signal, not passRate', () => {
  const usage = {
    totals: { turns: 1 },
    byProfile: [
      { provider: 'claude', profile: 'Implement - Sonnet', role: 'worker', runs: 3, turns: 12, costUsd: 1.5, passRate: 0, successRate: 0.667, successBasis: 'implementer-first-try-pass', costPerMergedUnit: 0.5, avgReviewRounds: 1.3, fixAfterMergeRate: 0 },
      { provider: 'claude', profile: 'Lead - Claude', role: 'lead', runs: 1, turns: 5, costUsd: 1, passRate: 0, successRate: null, successBasis: 'no-signal', costPerMergedUnit: null, avgReviewRounds: 0, fixAfterMergeRate: 0 },
    ],
  };
  const prompt = buildUsageReviewPrompt(usage, { home: tmp(), promptPath: path.join(tmp(), 'missing.md'), warn: () => {} });
  assert.match(prompt, /successRate \(basis\)/);
  assert.match(prompt, /Implement - Sonnet \| worker \| 3 \| 12 \| 1\.5 \| 0\.667 \(implementer-first-try-pass\) \|/);
  assert.match(prompt, /Lead - Claude \| lead \| 1 \| 5 \| 1 \| - \(no-signal\) \|/);
  assert.doesNotMatch(prompt, /\| passRate \|/);
});

// ---------------------------------------------------------------- usa-24: per-Squad filter + autonomy scorecard
function setupAutonomyHome() {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 10, 12);
  fs.writeFileSync(path.join(home, 'teams.json'), JSON.stringify({ teams: [
    { id: 'efi', lanes: [{ id: 'game', code: 'gam' }] },
    { id: 'vibesquad', lanes: [{ id: 'usage', code: 'usa' }] },
  ] }));
  // efi agent resolves its Squad from the team label, vibesquad agent via the lane -> teams.json fallback
  writeAgent(home, 'rn-e', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/wt/unit-e1', meta: { lane: 'game', role: 'worker', profile: 'Implement - Sonnet', labels: { team: 'efi' } } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 2 },
  ]);
  writeAgent(home, 'rn-v', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', cwd: '/wt/unit-v1', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } },
    { ts: T0 + 1000, type: 'turn_done', costUsd: 1 },
    { ts: T0 + 2000, type: 'turn_done', costUsd: 1 },
  ]);
  const at = (s) => T0 + s * 1000;
  // efi: handoff@10, merge e1@100, xsquad decision@120, needs-you@150 (stalls), blocker@210, decision@260 (unblocks), merge e2@300, you@310
  writeLog(home, 'teams/efi/log.jsonl', L_ENTRY(at(10), 'rn-l', 'game', 'handoff', 'plan A'));
  writeLog(home, 'teams/efi/log.jsonl', L_ENTRY(at(120), 'rn-l', 'game', 'decision', 'xsquad input: need art from VibeSquad'));
  writeLog(home, 'teams/efi/log.jsonl', L_ENTRY(at(150), 'rn-l', 'game', 'needs-you', 'pick a boss'));
  writeLog(home, 'teams/efi/log.jsonl', L_ENTRY(at(210), 'rn-w', 'game', 'blocker', 'turn cap'));
  writeLog(home, 'teams/efi/log.jsonl', L_ENTRY(at(260), 'rn-l', 'game', 'decision', 'bump the cap'));
  writeLog(home, 'teams/efi/log.jsonl', L_ENTRY(at(310), 'rn-l', 'game', 'you', 'thanks'));
  // same needs-you also lands in logs/ (deduped); vibesquad has one quiet decision
  writeLog(home, 'logs/efi--game.jsonl', L_ENTRY(at(150), 'rn-l', 'game', 'needs-you', 'pick a boss'));
  writeLog(home, 'teams/vibesquad/log.jsonl', L_ENTRY(at(50), 'rn-l', 'usage', 'decision', 'ship it'));
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm3\n';
    if (args[0] === 'log') return [
      L('m3', 'm2 b3', sec(at(300)), "Merge branch 'unit-e2' (@gam)"),
      L('b3', 'm2', sec(at(290)), 'feat: e2 (@gam) review r1'),
      L('m2', 'm1 b2', sec(at(200)), "Merge branch 'unit-v1' (@usa)"),
      L('b2', 'm1', sec(at(190)), 'feat: v1 (@usa) review r1'),
      L('m1', 'a1 b1', sec(at(100)), "Merge branch 'unit-e1' (@gam)"),
      L('b1', 'a1', sec(at(90)), 'feat: e1 (@gam) review r1'),
      L('a1', 'root', sec(T0), 'mainline'),
      L('root', '', '0', 'init'),
    ].join('\n');
    return '';
  };
  return { home, git, laneCodes: { gam: 'game', usa: 'usage' } };
}

test('usa-24: getUsage({squad}) filters to one Squad, lists all squads, and computes autonomy KPIs', () => {
  const { home, git, laneCodes } = setupAutonomyHome();
  const all = getUsage({ home, git, laneCodes });
  assert.equal(all.squad, null);
  assert.deepEqual(all.squads, ['efi', 'vibesquad']);
  assert.equal(all.totals.turns, 3);
  assert.equal(all.merged.units.length, 3);

  const u = getUsage({ home, git, laneCodes, squad: 'efi' });
  assert.equal(u.squad, 'efi');
  assert.deepEqual(u.squads, ['efi', 'vibesquad'], 'squads stay complete when filtered');
  assert.equal(u.totals.turns, 1, 'only efi turns');
  assert.equal(u.totals.costUsd, 2);
  assert.deepEqual(u.merged.units.map((x) => x.unit).sort(), ['unit-e1', 'unit-e2']);
  assert.deepEqual(u.byLane.map((l) => l.lane), ['game']);

  const a = u.autonomy;
  assert.deepEqual(a.ownerTouches, { total: 3, needsYou: 1, you: 1, xsquadInput: 1, perMergedUnit: 1.5, unitsPerOwnerTouch: 0.67, perHandoff: 3 });
  assert.deepEqual(a.unassistedStreak, { current: 0, longest: 1 }, 'e1 unassisted, e2 had touches since e1');
  // needs-you@150 -> decision@260 = 110s; blocker@210 -> decision@260 = 50s
  assert.deepEqual(a.stalls, { total: 1, blockers: 1, failRuns: 0, medianUnblockMs: 50000, p90UnblockMs: 110000 });
  assert.deepEqual(a.planAutonomy, { handoffs: 1, mergedUnits: 2, unitsPerHandoff: 2, avgPlanCycleMs: 290000 });

  const v = getUsage({ home, git, laneCodes, squad: 'vibesquad' }).autonomy;
  assert.equal(v.ownerTouches.total, 0);
  assert.equal(v.ownerTouches.unitsPerOwnerTouch, null);
  assert.deepEqual(v.unassistedStreak, { current: 1, longest: 1 });
  assert.equal(v.stalls.medianUnblockMs, null);
});

test('usa-24: autonomy.bySquad compares every Squad side by side, also when filtered', () => {
  const { home, git, laneCodes } = setupAutonomyHome();
  for (const squad of [undefined, 'efi']) {
    const rows = getUsage({ home, git, laneCodes, squad }).autonomy.bySquad;
    assert.deepEqual(rows.map((r) => r.squad), ['efi', 'vibesquad']);
    const { squad: _s, ...efi } = rows[0];
    assert.deepEqual(efi, {
      mergedUnits: 2, turns: 1, costUsd: 2, firstTryPassRate: 1, avgReviewRounds: 1, costPerUnit: 1,
      ownerTouches: 3, unitsPerOwnerTouch: 0.67, longestUnassistedStreak: 1, stalls: 1, medianUnblockMs: 50000,
    });
    assert.equal(rows[1].mergedUnits, 1);
    assert.equal(rows[1].turns, 2);
    assert.equal(rows[1].ownerTouches, 0);
  }
});

test('usa-24: filtered view never archives partial data to the ledger', () => {
  const { home, git, laneCodes } = setupAutonomyHome();
  getUsage({ home, git, laneCodes, squad: 'efi' });
  assert.deepEqual(readUsageLedger(home), [], 'squad-filtered call must not sync the ledger');
  getUsage({ home, git, laneCodes });
  assert.ok(readUsageLedger(home).some((r) => r.kind === 'unit'));
});

test('usa-24: review prompt carries the Autonomy by squad block', () => {
  const { home, git, laneCodes } = setupAutonomyHome();
  const prompt = buildUsageReviewPrompt(getUsage({ home, git, laneCodes }), { home });
  assert.match(prompt, /Autonomy by squad/);
  assert.match(prompt, /- efi \| 2 \| 3 \| 0\.67 \| 1 \| 1 \| 50000 \|/);
  assert.match(prompt, /- vibesquad \| 1 \| 0 \|/);
});

test('usa-24: /usage and /usage-export honour ?squad=, markdown has the Autonomy scorecard', async () => {
  const { home, git } = setupAutonomyHome(); // lane codes come from the home teams.json over HTTP
  const call = async (url) => {
    let out;
    await handleProvidersApi({ method: 'GET', url }, {}, {
      home, ...probeOpts, git,
      readBody: async () => ({}),
      sendJson: (_r, code, data) => { out = { code, data }; },
    });
    return out;
  };
  const j = await call('/__vibesquad/providers/usage-export?format=json&squad=efi');
  assert.equal(j.code, 200);
  assert.equal(j.data.squad, 'efi');
  assert.equal(j.data.autonomy.ownerTouches.total, 3);
  const live = await call('/__vibesquad/providers/usage?squad=vibesquad');
  assert.equal(live.data.squad, 'vibesquad');
  assert.equal(live.data.totals.turns, 2);
  const md = await call('/__vibesquad/providers/usage-export?format=md&squad=efi');
  assert.match(md.data.markdown, /## Autonomy scorecard \(efi\)/);
  assert.match(md.data.markdown, /owner touches: 3 \(needs-you 1, you 1, xsquad input 1\)/);
  assert.match(md.data.markdown, /unassisted merge streak: current 0, longest 1/);
  assert.match(md.data.markdown, /\| efi \| 2 \| 1 \|/);
  assert.match((await call('/__vibesquad/providers/usage-export?format=md')).data.markdown, /## Autonomy scorecard\n/);
});

// ---- usa-26: ready-time gauge + compaction cost (idea-153, idea-132) ----

test('usage ready-time: median/p90 first response + first text, excl/incl queue, per provider; restarts and outliers skipped', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 10, 12);
  const mk = (id, provider, evs, meta = { lane: 'usage', role: 'worker' }) =>
    writeAgent(home, id, [{ ts: T0, type: 'created', provider, model: 'm', meta }, ...evs.map((e) => ({ ...e, ts: T0 + e.at }))]);
  // claude: no queue, first output at 10s / 20s
  mk('c1', 'claude', [{ at: 10_000, type: 'output', text: 'hi' }]);
  mk('c2', 'claude', [{ at: 20_000, type: 'output', text: 'hi' }]);
  // gemini: thought at 4s, text at 30s; queued 0..20s -> excl queue 4s-... (first response 4s... queue 20s clamps to 0)
  mk('g1', 'gemini', [{ at: 100, type: 'status', status: 'queued' }, { at: 20_100, type: 'status', status: 'running' }, { at: 24_000, type: 'thought', text: 'x' }, { at: 30_000, type: 'output', text: 'y' }]);
  // restarted (label) and resumed (event) runs are excluded
  mk('r1', 'claude', [{ at: 1000, type: 'output', text: 'hi' }], { lane: 'usage', role: 'worker', labels: { 'vs.restarted-from': 'rn-old' } });
  mk('r2', 'claude', [{ at: 500, type: 'resume' }, { at: 1000, type: 'output', text: 'hi' }]);
  // outlier > 30 min and a run that never answered
  mk('o1', 'claude', [{ at: 31 * 60_000, type: 'output', text: 'late' }]);
  mk('n1', 'claude', [{ at: 1000, type: 'status', status: 'running' }]);
  const rt = getUsage({ home, git: noGit }).readyTime;
  assert.deepEqual(rt.baseline, { paseoSpawnMedianMs: 165000, runnerSpawnMedianMs: 450 });
  assert.equal(rt.overall.count, 3);
  assert.equal(rt.overall.queuedCount, 1);
  assert.equal(rt.overall.queuedShare, 0.333);
  const c = rt.byProvider.find((g) => g.provider === 'claude');
  assert.equal(c.count, 2);
  assert.equal(c.medianFirstResponseMs, 10_000);
  assert.equal(c.p90FirstResponseMs, 20_000);
  assert.equal(c.medianQueuedMs, null);
  const g = rt.byProvider.find((x) => x.provider === 'gemini');
  assert.equal(g.count, 1);
  assert.equal(g.medianFirstResponseMs, 24_000); // thought beats text
  assert.equal(g.medianFirstResponseExclQueueMs, 4_000); // minus the 20s queue
  assert.equal(g.medianReadyMs, 30_000);
  assert.equal(g.medianReadyExclQueueMs, 10_000);
  assert.equal(g.medianQueuedMs, 20_000);
  assert.equal(rt.byProvider[0].provider, 'claude'); // sorted by count desc
});

test('usage ready-time: empty home yields null stats and zeroed compaction', () => {
  const home = tmp();
  clearUsageCache();
  const u = getUsage({ home, git: noGit });
  assert.equal(u.readyTime.overall.count, 0);
  assert.equal(u.readyTime.overall.medianFirstResponseMs, null);
  assert.deepEqual(u.readyTime.byProvider, []);
  assert.equal(u.compaction.runs, 0);
  assert.equal(u.compaction.avgCostUsd, null);
});

test('usage compaction: /compact turn cost + tokens, tokens saved, and handoff overhead', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 10, 12);
  writeAgent(home, 'rn-l', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead' } },
    { ts: T0 + 1, type: 'input', text: 'work' },
    { ts: T0 + 2, type: 'usage', inputTokens: 5000, outputTokens: 500 },
    { ts: T0 + 3, type: 'turn_done', costUsd: 1.0 },
    { ts: T0 + 4, type: 'input', text: '/compact keep the brief' },
    { ts: T0 + 6, type: 'compacted', before: 150000, after: 40000 }, // real /compact: no usage before compacted
    { ts: T0 + 6.5, type: 'usage', contextTokens: 40000, inputTokens: 40000, outputTokens: 0 }, // adapter post_tokens
    { ts: T0 + 7, type: 'turn_done', costUsd: 1.25 },
    { ts: T0 + 8, type: 'input', text: 'more work' },
    { ts: T0 + 9, type: 'usage', inputTokens: 300, outputTokens: 50 },
    { ts: T0 + 10, type: 'turn_done', costUsd: 1.5 },
  ]);
  writeAgent(home, 'rn-h', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead', labels: { 'vs.handoff-from': 'rn-l' } } },
    { ts: T0 + 1, type: 'input', text: 'continue' },
    { ts: T0 + 2, type: 'turn_done', costUsd: 0.6 },
  ]);
  const cp = getUsage({ home, git: noGit }).compaction;
  assert.equal(cp.runs, 1);
  assert.equal(cp.totalCostUsd, 0.25); // only the turn answering /compact
  assert.equal(cp.avgCostUsd, 0.25);
  assert.equal(cp.totalTokens, 40000);
  assert.equal(cp.avgTokens, 40000);
  assert.equal(cp.tokensSaved, 110000);
  assert.equal(cp.handoffRuns, 1);
  assert.equal(cp.avgHandoffCostUsd, 0.6);
  assert.ok(cp.restartOverheadCostUsd >= 0.6);
});

test('usage compaction: /compact arriving mid-turn is not charged the prior turn (real shape: input, usage, turn_done, usage, compacted, turn_done)', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 10, 12);
  writeAgent(home, 'rn-m', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead' } },
    { ts: T0 + 1, type: 'input', text: 'work' },
    { ts: T0 + 2, type: 'input', text: '/compact keep the brief' }, // steered into the live turn
    { ts: T0 + 3, type: 'usage', inputTokens: 120000, outputTokens: 20000 }, // old turn's call
    { ts: T0 + 4, type: 'turn_done', costUsd: 2.0 }, // old turn ends first: must not be consumed
    { ts: T0 + 6, type: 'compacted', before: 150000, after: 12000 },
    { ts: T0 + 7, type: 'usage', contextTokens: 12000, inputTokens: 12000, outputTokens: 0 }, // the turn's only usage: adapter post_tokens
    { ts: T0 + 8, type: 'turn_done', costUsd: 2.1 },
  ]);
  const cp = getUsage({ home, git: noGit }).compaction;
  assert.equal(cp.runs, 1);
  assert.equal(cp.totalTokens, 12000);
  assert.equal(cp.totalCostUsd, 0.1);
  assert.equal(cp.tokensSaved, 138000);
});

test('usage ready-time: a queued status after the first response (follow-up turn behind the cap) does not redefine the spawn queue wait', () => {
  const home = tmp();
  clearUsageCache();
  const T0 = Date.UTC(2026, 10, 10, 12);
  writeAgent(home, 'late-q', [
    { ts: T0, type: 'created', provider: 'gemini', model: 'm', meta: { lane: 'usage', role: 'worker' } },
    { ts: T0 + 1000, type: 'status', status: 'running' },
    { ts: T0 + 5000, type: 'output', text: 'hi' },
    { ts: T0 + 6000, type: 'status', status: 'idle' },
    { ts: T0 + 60_000, type: 'status', status: 'queued' }, // later follow-up queued
    { ts: T0 + 90_000, type: 'status', status: 'running' },
  ]);
  const g = getUsage({ home, git: noGit }).readyTime.byProvider[0];
  assert.equal(g.count, 1);
  assert.equal(g.queuedCount, 0);
  assert.equal(g.medianQueuedMs, null);
  assert.equal(g.medianFirstResponseExclQueueMs, 5000);
});
