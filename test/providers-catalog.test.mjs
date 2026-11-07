import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalog, clearProbeCache, clearUsageCache, getModels, getProviders, getUsage, handleProvidersApi, LOOP_TURN_THRESHOLD,
  loadRunnerSettings, probeProviders, probeStats, saveRunnerSettings, usageStats,
} from '../server/providers-catalog.mjs';
import { saveUserSettings, loadUserSettings, saveRemoteAccess } from '../server/user-settings.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-catalog-'));
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
  assert.ok(gitCalls.every((c) => c[0] === 'rev-parse' || c[0] === 'log') && gitCalls.filter((c) => c[0] === 'log').length === 1, 'one log in total, no per-merge spawns');
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
