// N4: live model / mode / thinking change on a runner agent. The change is a `meta` patch in the agent log; the NEXT
// process start (process per turn) reads it. A running turn keeps the settings it started with.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner, configPatch } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-liveconf-')); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeChild(onLine) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  child.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { try { onLine(JSON.parse(l), child); } catch { /* not json */ } } }
  });
  return child;
}

// Claude fake: a turn ends only when the test calls child.finish().
function claudeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = fakeChild(() => {});
    child.finish = () => child.push({ type: 'result', subtype: 'success' });
    const sid = `sess-${calls.length + 1}`;
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: sid, model: 'm' }));
    calls.push({ args, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

const claudeRunner = () => {
  const spawnImpl = claudeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, parkGraceMs: 60_000, turnCaps: { claude: 6 } });
  return { runner, spawnImpl };
};

test('claude: idle agent inside the park grace window -> setConfig drops the old process, next turn runs --model/--permission-mode/--effort', async () => {
  const { runner, spawnImpl } = claudeRunner();
  const id = runner.create({ provider: 'claude', model: 'claude-sonnet-5-5', cwd: '.', prompt: 'hi', meta: { permissionMode: 'auto' } });
  await tick();
  spawnImpl.calls[0].child.finish();
  await tick();
  assert.equal(runner.status(id).status, 'idle');
  const r = runner.setConfig(id, { model: 'claude-opus-5-5', modeId: 'plan', thinkingOptionId: 'high' });
  assert.deepEqual(r, { appliesFrom: 'next-turn', busy: false });
  assert.equal(runner.status(id).status, 'parked', 'the stale idle process was parked, not reused');
  assert.equal(runner.status(id).model, 'claude-opus-5-5', 'the record shows the effective model');
  runner.send(id, 'again');
  await tick();
  assert.equal(spawnImpl.calls.length, 2);
  const a = spawnImpl.calls[1].args;
  assert.equal(flag(a, '--model'), 'claude-opus-5-5');
  assert.equal(flag(a, '--permission-mode'), 'plan');
  assert.equal(flag(a, '--effort'), 'high');
  assert.equal(flag(a, '--resume'), 'sess-1', 'the session is resumed, not dropped');
  assert.ok(runner.timeline(id).some((e) => e.type === 'meta' && e.patch.model === 'claude-opus-5-5'));
});

test('claude: a change mid-turn is not applied to the running turn; it applies to the next process', async () => {
  const { runner, spawnImpl } = claudeRunner();
  const id = runner.create({ provider: 'claude', model: 'claude-sonnet-5-5', cwd: '.', prompt: 'work', meta: { permissionMode: 'auto' } });
  await tick();
  assert.equal(runner.status(id).status, 'running');
  const r = runner.setConfig(id, { model: 'claude-opus-5-5' });
  assert.deepEqual(r, { appliesFrom: 'next-turn', busy: true });
  assert.equal(spawnImpl.calls.length, 1, 'no respawn while the turn runs');
  assert.equal(spawnImpl.calls[0].child.exitCode, null, 'the running process was not killed');
  assert.equal(flag(spawnImpl.calls[0].args, '--model'), 'claude-sonnet-5-5');
  spawnImpl.calls[0].child.finish();
  await tick(50);
  assert.equal(runner.status(id).status, 'parked', 'the finished stale process is parked at once despite the long grace');
  runner.send(id, 'next');
  await tick();
  assert.equal(flag(spawnImpl.calls[1].args, '--model'), 'claude-opus-5-5');
});

test('claude: rejects unsupported values with a clear error and appends nothing', async () => {
  const { runner } = claudeRunner();
  const id = runner.create({ provider: 'claude', cwd: '.', meta: {} });
  const before = runner.timeline(id).length;
  assert.throws(() => runner.setConfig(id, { modeId: 'yolo' }), /claude: unsupported mode "yolo"/);
  assert.throws(() => runner.setConfig(id, { thinkingOptionId: 'turbo' }), /claude: unsupported thinking "turbo"/);
  assert.throws(() => runner.setConfig(id, { model: '--dangerous' }), /unsupported model/);
  assert.throws(() => runner.setConfig(id, {}), /nothing to change/);
  assert.throws(() => runner.setConfig('rn-nope', { model: 'x' }), /no such agent/);
  assert.equal(runner.timeline(id).length, before);
});

// ACP fake: advertises models + modes, records set_model / set_mode / resume per process.
function acpSpawn() {
  const state = { procs: [] };
  const impl = () => {
    const proc = { calls: [] };
    state.procs.push(proc);
    return fakeChild((m, child) => {
      if (!m.method) return;
      proc.calls.push({ method: m.method, params: m.params });
      const reply = (result) => child.push({ jsonrpc: '2.0', id: m.id, result });
      const session = { sessionId: 'S1', models: { currentModelId: 'gemini-4-argon-medium', availableModels: [{ modelId: 'gemini-4-argon-medium' }, { modelId: 'gemini-2.5-pro' }] }, modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept-edits' }] } };
      if (m.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
      else if (m.method === 'session/new' || m.method === 'session/resume') reply(session);
      else if (m.method === 'session/prompt') reply({ stopReason: 'end_turn' });
      else reply({});
    });
  };
  impl.state = state;
  return impl;
}

test('antigravity-cli (ACP): next process resumes the session, then session/set_model + session/set_mode; thinking is refused', async () => {
  const spawnImpl = acpSpawn();
  const adapter = createAcpAdapter({ spawnImpl, provider: 'antigravity-cli', mcp: false, resolved: { file: '/bin/fake', args: [] } });
  const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': adapter }, parkGraceMs: 60_000 });
  const id = runner.create({ provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: '.', prompt: 'hi' });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(runner.status(id).status, 'idle');
  assert.throws(() => runner.setConfig(id, { thinkingOptionId: 'high' }), /antigravity-cli: thinking level is not supported/);
  assert.deepEqual(runner.setConfig(id, { model: 'gemini-2.5-pro', modeId: 'accept-edits' }), { appliesFrom: 'next-turn', busy: false });
  runner.send(id, 'again');
  for (let i = 0; i < 8; i++) await tick();
  const second = spawnImpl.state.procs[1].calls;
  assert.deepEqual(second.map((c) => c.method).filter((m) => m.startsWith('session/')), ['session/resume', 'session/set_model', 'session/set_mode', 'session/prompt']);
  assert.equal(second.find((c) => c.method === 'session/resume').params.sessionId, 'S1');
  assert.equal(second.find((c) => c.method === 'session/set_model').params.modelId, 'gemini-2.5-pro');
  assert.equal(second.find((c) => c.method === 'session/set_mode').params.modeId, 'accept-edits');
});

test('opencode (ACP): same patch path; mode lands in meta.acpMode, thinking null clears, thinking value refused', () => {
  assert.deepEqual(configPatch('opencode', { model: 'deepseek/deepseek-flash', modeId: 'build' }), { model: 'deepseek/deepseek-flash', acpMode: 'build' });
  assert.deepEqual(configPatch('opencode', { thinkingOptionId: null }), { thinkingOptionId: null });
  assert.throws(() => configPatch('opencode', { thinkingOptionId: 'low' }), /opencode: thinking level is not supported/);
  assert.deepEqual(configPatch('claude', { modeId: 'acceptEdits', thinkingOptionId: 'max' }), { permissionMode: 'acceptEdits', thinkingOptionId: 'max' });
});

test('route: POST /agents/:id/config -> backend.setAgentConfig; runner 400 message surfaces; runner HTTP route validates', async () => {
  const { handleRunnerApi } = await import('../server/runner-api.mjs');
  const seen = [];
  const backend = { setAgentConfig: async (id, body) => { seen.push({ id, body }); if (body.modeId === 'bad') { const e = new Error('claude: unsupported mode "bad"'); e.status = 400; throw e; } return { appliesFrom: 'next-turn', busy: true }; } };
  const run = async (body) => {
    const out = {};
    await handleRunnerApi({ url: '/__vibesquad/runner/agents/rn-abc/config', method: 'POST' }, {}, { readBody: async () => body, sendJson: (_r, code, json) => Object.assign(out, { code, json }), backend, lanes: () => new Set(['x']) });
    return out;
  };
  assert.deepEqual(await run({ model: 'claude-opus-5-5' }), { code: 200, json: { ok: true, appliesFrom: 'next-turn', busy: true } });
  assert.deepEqual(seen[0], { id: 'rn-abc', body: { model: 'claude-opus-5-5' } });
  const bad = await run({ modeId: 'bad' });
  assert.equal(bad.code, 400);
  assert.match(bad.json.error, /unsupported mode/);
});

test('backend.setAgentConfig posts the runner /config route and returns appliesFrom/busy', async () => {
  const { RunnerBackend } = await import('../server/backend/runner-backend.mjs');
  const calls = [];
  const b = Object.create(RunnerBackend.prototype);
  b.rc = { request: async (method, route, body) => { calls.push({ method, route, body }); return { ok: true, appliesFrom: 'next-turn', busy: true }; } };
  assert.deepEqual(await b.setAgentConfig('rn-1', { model: 'm', thinkingOptionId: null }), { appliesFrom: 'next-turn', busy: true });
  assert.deepEqual(calls, [{ method: 'POST', route: '/agents/rn-1/config', body: { model: 'm', thinkingOptionId: null } }]);
});

test('toAgent exposes currentModeId alongside modeId (the pickers read currentModeId)', async () => {
  const { toAgent } = await import('../server/backend/runner-backend.mjs');
  const a = toAgent({ id: 'rn-1', provider: 'claude', model: 'claude-opus-5-5', cwd: '.', meta: { permissionMode: 'plan' }, status: 'idle' });
  assert.equal(a.currentModeId, 'plan');
  assert.equal(a.modeId, 'plan');
});

test('DrawerHeader pickers call the runner config route and say "Applies from the next turn." only when busy', async () => {
  const src = readFileSync(path.join(ROOT, 'src', 'DrawerHeader.tsx'), 'utf8');
  assert.doesNotMatch(src, /not supported on runner agents yet/);
  assert.match(src, /setModeHelper[\s\S]{0,200}runnerSetConfig\(agent\.id, \{ modeId \}\)/);
  assert.match(src, /setModelHelper[\s\S]{0,200}runnerSetConfig\(agent\.id, \{ model: modelId \}\)/);
  assert.match(src, /setThinkingHelper[\s\S]{0,220}runnerSetConfig\(agent\.id, \{ thinkingOptionId: optionId \}\)/);
  const start = src.indexOf('export const CONFIG_NEXT_TURN');
  const end = src.indexOf('export async function setModeHelper');
  const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(stripTypeScriptTypes(src.slice(start, end)))}`);
  assert.equal(mod.configNote({ busy: true }), 'Applies from the next turn.');
  assert.equal(mod.configNote({ busy: false }), '');
  assert.equal(mod.configNote(undefined), '');
  for (const call of ['setModelHelper(agent, next)', 'setModeHelper(agent, next)', 'setModeHelper(agent, e.target.value)', 'setThinkingHelper(agent, e.target.value || null)']) {
    assert.ok(src.includes(`${call}.then((r) => setReloadError(configNote(r)))`), `${call} shows the note`);
  }
  const bridge = readFileSync(path.join(ROOT, 'src', 'runnerBridge.ts'), 'utf8');
  assert.match(bridge, /runnerSetConfig[\s\S]{0,120}post\(id, "config", cfg\)/);
});

// ---- N4-fix1 ----
test('fix1.1 ACP agent reports the modes/models it really offers; unoffered values are refused with a clear error, never skipped', async () => {
  const { toAgent } = await import('../server/backend/runner-backend.mjs');
  const spawnImpl = acpSpawn();
  const adapter = createAcpAdapter({ spawnImpl, provider: 'antigravity-cli', mcp: false, resolved: { file: '/bin/fake', args: [] } });
  const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': adapter }, parkGraceMs: 60_000 });
  const id = runner.create({ provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: '.', prompt: 'hi' });
  for (let i = 0; i < 8; i++) await tick();
  const rec = runner.status(id);
  assert.deepEqual(rec.offered.modes, ['default', 'accept-edits']);
  const agent = toAgent(rec);
  assert.deepEqual(agent.availableModes.map((m) => m.id), ['default', 'accept-edits'], 'real ACP modes, not claude permission modes');
  assert.deepEqual(agent.thinkingOptions, [], 'no thinking picker for ACP providers');
  const before = runner.timeline(id).length;
  assert.throws(() => runner.setConfig(id, { modeId: 'plan' }), /mode "plan" is not offered \(one of default, accept-edits\)/);
  assert.throws(() => runner.setConfig(id, { model: 'gpt-9' }), /model "gpt-9" is not offered/);
  assert.equal(runner.timeline(id).length, before, 'refused change writes nothing');
  assert.doesNotThrow(() => runner.setConfig(id, { model: 'gemini-2.5-pro', modeId: 'accept-edits' }));
});

test('fix1.1 claude agents carry the 6 permission modes + effort levels; UI helpers use them, fallback only for DEMO/staged', async () => {
  const { toAgent } = await import('../server/backend/runner-backend.mjs');
  const a = toAgent({ id: 'rn-1', provider: 'claude', cwd: '.', meta: {}, status: 'idle' });
  assert.deepEqual(a.availableModes.map((m) => m.id), ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);
  assert.deepEqual(a.thinkingOptions.map((m) => m.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  const g = toAgent({ id: 'rn-2', provider: 'opencode', cwd: '.', meta: {}, status: 'idle' });
  assert.deepEqual(g.availableModes, [], 'no modes known before the first session: no Claude fallback');
  const src = readFileSync(path.join(ROOT, 'src', 'DrawerHeader.tsx'), 'utf8');
  const s = src.indexOf('export const FALLBACK_MODES');
  const e = src.indexOf('export function nextModeInCycle');
  const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(stripTypeScriptTypes(src.slice(s, e)))}`);
  assert.deepEqual(mod.modesFor(g, false), []);
  assert.equal(mod.modesFor(g, true).length, 5, 'DEMO/staged keeps the fallback list');
  assert.deepEqual(mod.thinkingLevelsFor(g, false), []);
  assert.deepEqual(mod.thinkingLevelsFor(a, false), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.doesNotMatch(src, /availableModes\?\.length\) \? agent\.availableModes : FALLBACK_MODES/);
  assert.match(src, /thinkingSelect = !thinkingLevels\.length \? null/);
});

test('fix1.2 readRunnerAgentSync reports the effective (meta) model and offered modes', async () => {
  const { readRunnerAgentSync } = await import('../server/backend/runner-backend.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const home = tmp();
  mkdirSync(path.join(home, 'agents'));
  const ev = (o, seq) => JSON.stringify({ seq, ts: 1000 + seq, ...o });
  writeFileSync(path.join(home, 'agents', 'rn-sync1.jsonl'), [
    ev({ type: 'created', provider: 'antigravity-cli', model: 'gemini-4-argon', cwd: '.', meta: {} }, 1),
    ev({ type: 'session', sessionId: 'S', model: 'gemini-4-argon-medium', modes: ['default', 'accept-edits'], models: ['gemini-2.5-pro'] }, 2),
    ev({ type: 'meta', patch: { model: 'gemini-2.5-pro', acpMode: 'accept-edits' } }, 3),
  ].join('\n') + '\n');
  const a = readRunnerAgentSync('rn-sync1', { home, liveness: null });
  assert.equal(a.model, 'gemini-2.5-pro');
  assert.equal(a.modeId, 'accept-edits');
  assert.deepEqual(a.availableModes.map((m) => m.id), ['default', 'accept-edits']);
});

test('fix1.3 _resume of an unstarted queued agent uses the folded log spec, not the stale job spec', async () => {
  const spawnImpl = claudeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, parkGraceMs: 60_000, turnCaps: { claude: 1 } });
  runner.create({ provider: 'claude', model: 'claude-sonnet-5-5', cwd: '.', prompt: 'A' }); // takes the only turn slot
  const b = runner.create({ provider: 'claude', model: 'claude-sonnet-5-5', cwd: '.', prompt: 'B' });
  await tick();
  assert.equal(runner.status(b).status, 'queued');
  runner.queue = runner.queue.filter((j) => j.id !== b); // the in-memory job is gone (as after a runner restart); the log still says queued
  runner.setConfig(b, { model: 'claude-opus-5-5' });
  const stale = { provider: 'claude', model: 'claude-sonnet-5-5', cwd: '.', meta: {} };
  runner._resume(b, stale);
  await tick();
  assert.equal(flag(spawnImpl.calls.at(-1).args, '--model'), 'claude-opus-5-5');
});
