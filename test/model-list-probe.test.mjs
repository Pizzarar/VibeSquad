import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, cachedModelLists, clearModelProbeCache, modelProbeStats, parseModelList, probeModelLists } from '../server/providers-catalog.mjs';

const SAMPLE = 'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\r\ngemini-4-neon-high\tdup\n\x1b[0mgemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nnot a model line\n';
const resolveImpl = (cmd) => ({ file: `/bin/${cmd}`, args: [] });
const okExec = (calls) => (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, SAMPLE); };

test('parseModelList skips header/noise, dedupes, strips ANSI', () => {
  assert.deepEqual(parseModelList(SAMPLE), [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]);
  assert.deepEqual(parseModelList(''), []);
});

test('probe runs `agy models` async with a timeout and caches the result', async () => {
  clearModelProbeCache();
  const calls = [];
  const before = modelProbeStats().runs;
  const a = await probeModelLists({ now: 1000, execImpl: okExec(calls), resolveImpl, timeout: 5000 });
  assert.equal(a['antigravity-cli'].source, 'probe');
  assert.equal(a['antigravity-cli'].models.length, 2);
  assert.deepEqual(calls[0].args, ['models']);
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(calls[0].opts.shell, false);
  await probeModelLists({ now: 2000, execImpl: okExec(calls), resolveImpl });
  assert.equal(calls.length, 1, 'second call within TTL hits the cache');
  await probeModelLists({ now: 3000, refresh: true, execImpl: okExec(calls), resolveImpl });
  assert.equal(calls.length, 2, 'refresh re-runs');
  assert.equal(modelProbeStats().runs - before, 2);
  assert.equal(cachedModelLists()['antigravity-cli'].models.length, 2);
});

test('failed/timed-out probe keeps the last good list; first failure falls back to static (empty)', async () => {
  clearModelProbeCache();
  const failExec = (file, args, opts, cb) => cb(Object.assign(new Error('boom'), { killed: true }));
  const first = await probeModelLists({ now: 1, execImpl: failExec, resolveImpl });
  assert.equal(first['antigravity-cli'].source, 'static');
  assert.deepEqual(first['antigravity-cli'].models, []);
  assert.match(first['antigravity-cli'].error, /timed out/);
  await probeModelLists({ now: 2, refresh: true, execImpl: okExec([]), resolveImpl });
  const kept = await probeModelLists({ now: 3, refresh: true, execImpl: failExec, resolveImpl });
  assert.equal(kept['antigravity-cli'].source, 'cache');
  assert.equal(kept['antigravity-cli'].models.length, 2, 'last good list survives');
  const missing = await probeModelLists({ now: 4, refresh: true, execImpl: failExec, resolveImpl: () => { throw new Error('x'); } });
  assert.equal(missing['antigravity-cli'].models.length, 2);
  const empty = await probeModelLists({ now: 5, refresh: true, execImpl: (f, a, o, cb) => cb(null, 'Fetching...\n'), resolveImpl });
  assert.equal(empty['antigravity-cli'].source, 'cache', 'empty output counts as failure');
});

test('buildCatalog folds cached probed models into the provider list', async () => {
  clearModelProbeCache();
  assert.equal(buildCatalog({ home: process.cwd() })['antigravity-cli'].models.some((m) => m.source === 'cli probe'), false);
  await probeModelLists({ now: 1, execImpl: okExec([]), resolveImpl });
  const m = buildCatalog({ home: process.cwd() })['antigravity-cli'].models.find((x) => x.id === 'gemini-4-neon-high');
  assert.equal(m.source, 'cli probe');
  clearModelProbeCache();
});
