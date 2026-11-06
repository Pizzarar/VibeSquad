import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalog, clearProbeCache, clearUsageCache, getModels, getProviders, getUsage, handleProvidersApi,
  loadRunnerSettings, probeProviders, probeStats, saveRunnerSettings, usageStats,
} from '../server/providers-catalog.mjs';
import { saveUserSettings, loadUserSettings, saveRemoteAccess } from '../server/user-settings.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-catalog-'));
const okExec = (file, args, o, cb) => cb(null, `${path.basename(file)} 1.2.3\n`);
const resolveImpl = (cmd) => {
  if (cmd === 'opencode') throw new Error('nope');
  return { file: `/bin/${cmd}`, args: [] };
};
const probeOpts = { execImpl: okExec, resolveImpl };

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
  let u = getUsage({ home });
  assert.equal(u.files, 2);
  assert.equal(u.totals.turns, 3);
  assert.ok(Math.abs(u.totals.costUsd - 1.5) < 1e-9, 'cumulative cost counted as deltas');
  assert.equal(u.byProvider.find((r) => r.provider === 'claude').turns, 2);
  assert.equal(u.byDay.length, 2);
  assert.equal(u.byLane.find((r) => r.lane === 'x').costUsd, 1.5);
  assert.equal(getUsage({ home, since: '2026-11-02' }).totals.turns, 1);
  const read = usageStats().readBytes;
  getUsage({ home });
  assert.equal(usageStats().readBytes, read, 'unchanged files are not re-read');
  const size = fs.statSync(a).size;
  fs.appendFileSync(a, ev({ seq: 3, ts: d2, type: 'turn_done', costUsd: 2 }) + '{"seq":4,"ts":');
  u = getUsage({ home });
  assert.equal(u.totals.turns, 4);
  assert.ok(Math.abs(u.totals.costUsd - 2) < 1e-9);
  assert.ok(usageStats().readBytes - read <= fs.statSync(a).size - size, 'only the tail was read');
  fs.appendFileSync(a, `${d2},"type":"turn_done","costUsd":2.25}\n`);
  assert.equal(getUsage({ home }).totals.turns, 5);
  fs.rmSync(a);
  assert.equal(getUsage({ home }).files, 1);
  assert.equal(getUsage({ home: tmp() }).totals.turns, 0);
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
  let u = getUsage({ home });
  assert.equal(u.totals.turns, 1, 'bad-ts turn skipped, good one counted');
  assert.equal(u.byLane.find((r) => r.lane === 'lane-a').turns, 1);
  assert.equal(u.totals.inputTokens, 100);
  assert.equal(u.totals.outputTokens, 20);
  assert.ok(Math.abs(u.totals.costUsd - 2) < 1e-9, 'cost delta from the skipped turn is not double counted');
  const read = usageStats().readBytes;
  getUsage({ home });
  assert.equal(usageStats().readBytes, read, 'offset advanced past the bad line; nothing re-read');
  fs.appendFileSync(a, ev({ seq: 7, ts: d1, type: 'meta', patch: { labels: { lane: 'lane-b' } } }) + ev({ seq: 8, ts: d1, type: 'turn_done', costUsd: 4 }));
  u = getUsage({ home });
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
