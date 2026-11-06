import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalog, clearProbeCache, clearUsageCache, getModels, getProviders, getUsage, handleProvidersApi,
  loadRunnerSettings, probeProviders, probeStats, saveRunnerSettings, usageStats,
} from '../server/providers-catalog.mjs';
import { saveUserSettings, loadUserSettings } from '../server/user-settings.mjs';

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
  const saved = saveRunnerSettings({ providers: { claude: { enabled: false }, agy: { models: ['m1', 'm1', ' m2 '], defaultModel: 'm2' } } }, home);
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
