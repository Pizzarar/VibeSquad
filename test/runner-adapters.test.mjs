import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, defaultAdapters } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { RunnerBackend, toAgent } from '../server/backend/runner-backend.mjs';
import { ACP_PROVIDERS, createAcpAdapter, pickModel } from '../runner/adapters/acp.mjs';
import { resolveExecutable } from '../runner/spawn.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-adapters-'));
const tick = () => new Promise((r) => setTimeout(r, 15));

function fakeSpawn(onStdin) {
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.written = [];
    child.stdin.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) { const m = JSON.parse(l); child.written.push(m); onStdin?.(m, child); }
    });
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    impl.calls.push({ file, args, opts });
    return impl.last = child;
  };
  impl.calls = [];
  return impl;
}

// The fake spawn skips PATH resolution, so these tests need no CLI installed.
const fakeAdapter = (spawnImpl, provider) => {
  const a = createAcpAdapter({ spawnImpl, provider, mcp: false, resolved: { file: '/bin/fake', args: [] } });
  return { start: (o) => a.start(o) };
};

test('every profile provider has a registered adapter (aliases included)', () => {
  const a = defaultAdapters();
  for (const p of ['claude', 'opencode', 'antigravity-cli', 'codex', 'agy']) assert.ok(a[p]?.start, p);
  assert.equal(a.agy, a['antigravity-cli']);
  assert.deepEqual(Object.keys(ACP_PROVIDERS).sort(), ['antigravity-cli', 'codex', 'opencode']);
});

test('pickModel: exact id, variant suffix (prefers medium), provider/model, unknown', () => {
  const av = ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'deepseek/deepseek-flash'].map((modelId) => ({ modelId }));
  assert.equal(pickModel('gemini-4-argon-high', av), 'gemini-4-argon-high');
  assert.equal(pickModel('gemini-4-argon', av), 'gemini-4-argon-medium');
  assert.equal(pickModel('deepseek/deepseek-flash', av), 'deepseek/deepseek-flash');
  assert.equal(pickModel('nope', av), null);
  assert.equal(pickModel('x', undefined), null);
});

for (const [provider, def] of Object.entries(ACP_PROVIDERS)) {
  test(`${provider} adapter (${def.command} ${def.args.join(' ')}): model select, auto-approve, cancel`, async () => {
    const spawnImpl = fakeSpawn((m, child) => {
      if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
      if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S', models: { currentModelId: 'm-medium', availableModels: [{ modelId: 'm-medium' }, { modelId: 'm-high' }] } } });
      if (m.method === 'session/set_model') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
      if (m.method === 'session/prompt') {
        child.push({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { options: [{ optionId: 'rej', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }] } });
        child.push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
        child.push({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
    });
    const runner = new Runner({ dir: tmp(), adapters: { [provider]: fakeAdapter(spawnImpl, provider) } });
    const id = runner.create({ provider, model: 'm-high', cwd: '.', prompt: 'hi' });
    await tick(); await tick(); await tick();
    const child = spawnImpl.last;
    assert.deepEqual(child.written.map((m) => m.method ?? 'response'), ['initialize', 'session/new', 'session/set_model', 'session/prompt', 'response']);
    assert.equal(child.written[2].params.modelId, 'm-high');
    assert.deepEqual(child.written[4].result, { outcome: { outcome: 'selected', optionId: 'yes' } });
    assert.equal(runner.timeline(id).find((e) => e.type === 'session').model, 'm-high');
    runner.cancel(id);
    await tick();
    assert.equal(child.written.at(-1).method, 'session/cancel');
  });
}

test('acp adapter: explicit permissionMode deny denies permission requests', async () => {
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S' } });
    if (m.method === 'session/prompt') child.push({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { options: [{ optionId: 'yes', kind: 'allow_once' }] } });
  });
  const runner = new Runner({ dir: tmp(), adapters: { opencode: fakeAdapter(spawnImpl, 'opencode') } });
  runner.create({ provider: 'opencode', cwd: '.', prompt: 'x', meta: { permissionMode: 'deny' } });
  await tick(); await tick(); await tick();
  assert.deepEqual(spawnImpl.last.written.at(-1).result, { outcome: { outcome: 'cancelled' } });
});

test('antigravity-cli spawn with profile modeId "default" gets approvals and set_mode, via RunnerBackend', async () => {
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S', modes: { currentModeId: 'auto', availableModes: [{ id: 'default' }, { id: 'auto' }] } } });
    if (m.method === 'session/set_mode') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/prompt') child.push({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { options: [{ optionId: 'yes', kind: 'allow_once' }] } });
  });
  const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': fakeAdapter(spawnImpl, 'antigravity-cli') } });
  const calls = [];
  const rc = { requireRunning: async () => {}, request: async (method, route, body) => { if (method === 'POST') { calls.push(body); return { id: runner.create(body) }; } return runner.status(route.split('/')[2]); } };
  const backend = new RunnerBackend({ client: rc, buildPrefix: async () => '' });
  await backend.createAgent({ config: { provider: 'antigravity-cli', model: 'gemini-4-argon', modeId: 'default', cwd: '.' }, prompt: 'x', labels: { role: 'worker' } });
  await tick(); await tick(); await tick();
  assert.equal(calls[0].meta.permissionMode, undefined);
  assert.equal(calls[0].meta.acpMode, 'default');
  const w = spawnImpl.last.written;
  assert.ok(w.some((m) => m.method === 'session/set_mode' && m.params.modeId === 'default'));
  assert.deepEqual(w.at(-1).result, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('acp session that fails to start ends as exited and later sends throw', async () => {
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, error: { message: 'auth required' } });
  });
  const runner = new Runner({ dir: tmp(), adapters: { opencode: fakeAdapter(spawnImpl, 'opencode') } });
  const id = runner.create({ provider: 'opencode', cwd: '.', prompt: 'x' });
  await tick(); await tick(); await tick();
  assert.ok(runner.timeline(id).some((e) => e.type === 'error' && /auth required/.test(e.message)));
  assert.equal(runner.status(id).status, 'exited');
  assert.throws(() => runner.send(id, 'again'), /not running|failed to start/);
});

test('acp cancel drops prompts queued behind the cancelled one', async () => {
  let prompts = 0;
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S' } });
    if (m.method === 'session/prompt') { prompts++; child.pending = m.id; }
    if (m.method === 'session/cancel') child.push({ jsonrpc: '2.0', id: child.pending, result: { stopReason: 'cancelled' } });
  });
  const runner = new Runner({ dir: tmp(), adapters: { opencode: fakeAdapter(spawnImpl, 'opencode') } });
  const id = runner.create({ provider: 'opencode', cwd: '.', prompt: 'one' });
  await tick(); await tick();
  runner.send(id, 'two'); runner.send(id, 'three');
  runner.cancel(id);
  await tick(); await tick(); await tick();
  assert.equal(prompts, 1);
  assert.equal(runner.status(id).status, 'idle');
});

test('codex-style agent (model as a configOption): model set via session/set_config_option, unlisted ids trusted', async () => {
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S', configOptions: [{ id: 'model', category: 'model', currentValue: 'gpt-5.5', options: [{ value: 'gpt-5.5' }, { value: 'gpt-5.4' }] }] } });
    if (m.method === 'session/set_config_option') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
  });
  const runner = new Runner({ dir: tmp(), adapters: { codex: fakeAdapter(spawnImpl, 'codex') } });
  const id = runner.create({ provider: 'codex', model: 'gpt-5.6-sol', cwd: '.' });
  await tick(); await tick(); await tick();
  const set = spawnImpl.last.written.find((m) => m.method === 'session/set_config_option');
  assert.deepEqual(set.params, { sessionId: 'S', configId: 'model', value: 'gpt-5.6-sol' });
  assert.equal(runner.timeline(id).find((e) => e.type === 'session').model, 'gpt-5.6-sol');
});

test('AGY spawned with modeId "default" reports modeId default (acpMode fallback)', () => {
  const a = toAgent({ id: 'rn-1', provider: 'antigravity-cli', cwd: '.', meta: { acpMode: 'default' }, status: 'idle' });
  assert.equal(a.modeId, 'default');
  assert.equal(toAgent({ id: 'rn-2', provider: 'claude', cwd: '.', meta: {}, status: 'idle' }).modeId, 'auto');
});

test('a write racing child exit (EPIPE on stdin) does not crash the process, ACP and claude', async () => {
  const fake = { file: '/bin/fake', args: [] };
  for (const make of [(spawnImpl) => createAcpAdapter({ spawnImpl, provider: 'opencode', mcp: false, resolved: fake }), (spawnImpl) => createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false })]) {
    const spawnImpl = fakeSpawn((m, child) => { if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: {} }); });
    const adapter = make(spawnImpl);
    const runner = new Runner({ dir: tmp(), adapters: { x: adapter } });
    const id = runner.create({ provider: 'x', cwd: '.' });
    spawnImpl.last.stdin.destroy(new Error('EPIPE')); // child gone: the pipe errors on its next write
    try { runner.send(id, 'hi'); } catch { /* sync throw is fine; an unhandled 'error' event is not */ }
    await tick(); await tick();
  }
});

test('unknown ACP provider without an explicit command throws', () => {
  assert.throws(() => createAcpAdapter({ provider: 'nope' }), /no ACP definition/);
});

// Live smoke (spawn, first output, send, cancel) against the real CLIs. Opt in: VS_SMOKE=1 npm test
const has = (cmd) => { try { resolveExecutable(cmd); return true; } catch { return cmd === 'npx' && !!ACP_PROVIDERS.codex.resolve(); } };
const smoke = [
  ['opencode', 'opencode', 'deepseek/deepseek-flash'],
  ['antigravity-cli', 'agy', 'gemini-3.8-flash'],
  ['codex', 'npx', undefined],
];
for (const [provider, bin, model] of smoke) {
  const skip = !process.env.VS_SMOKE ? 'set VS_SMOKE=1 to run live provider smokes' : !has(bin) ? `${bin} not installed` : false;
  test(`live smoke ${provider}`, { skip, timeout: 300000 }, async () => {
    const runner = new Runner({ dir: tmp() });
    const waitFor = async (id, pred, ms = 150000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const e = runner.timeline(id).find(pred);
        if (e) return e;
        if (runner.status(id).status === 'exited') throw new Error(`exited: ${JSON.stringify(runner.status(id).exit)} ${JSON.stringify(runner.timeline(id).slice(-4))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timeout; last events ${JSON.stringify(runner.timeline(id).slice(-4))}`);
    };
    const t0 = Date.now();
    const id = runner.create({ provider, model, cwd: os.tmpdir(), prompt: 'reply with the single word ok' });
    try {
      const first = await waitFor(id, (e) => e.type === 'output');
      console.log(`SMOKE ${provider} create->first output ${first.ts - t0} ms`);
      const done = await waitFor(id, (e) => e.type === 'turn_done');
      runner.send(id, 'reply with the single word again');
      await waitFor(id, (e) => e.type === 'turn_done' && e.seq > done.seq + 1);
      runner.send(id, 'write a 2000 word essay about the history of tea');
      await new Promise((r) => setTimeout(r, 1500));
      runner.cancel(id);
      await waitFor(id, (e) => e.type === 'cancel');
    } finally { runner.shutdown(); }
  });
}

// ---- ACP park/resume (R3) ----
function fakeStatefulAcp({ caps, failLoad = false } = {}) {
  const state = { sessions: new Map(), seq: 0, calls: [] };
  const spawnImpl = fakeSpawn((m, child) => {
    if (!m.method) return;
    state.calls.push(m.method);
    const reply = (result) => child.push({ jsonrpc: '2.0', id: m.id, result });
    const text = (t) => child.push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
    if (m.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: caps });
    else if (m.method === 'session/new') { const sid = `S${++state.seq}`; state.sessions.set(sid, []); reply({ sessionId: sid }); }
    else if (m.method === 'session/load' || m.method === 'session/resume') {
      if (failLoad || !state.sessions.has(m.params.sessionId)) return child.push({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown session' } });
      if (m.method === 'session/load') for (const p of state.sessions.get(m.params.sessionId)) text(`replay:${p}`);
      reply({});
    } else if (m.method === 'session/prompt') {
      const sid = m.params.sessionId;
      const t = m.params.prompt[0].text;
      const seen = state.sessions.get(sid) ?? [];
      state.lastPrompt = t;
      text(`${sid} remembers [${seen.join('|')}]`);
      seen.push(t);
      reply({ stopReason: 'end_turn' });
    }
  });
  return { spawnImpl, state };
}
const acpAdapter = (spawnImpl) => createAcpAdapter({ spawnImpl, provider: 'antigravity-cli', mcp: false, resolved: { file: '/bin/fake', args: [] } });

test('acp park: next send resumes the same session via session/load, remembers the earlier fact, replay not double-logged', async () => {
  const { spawnImpl, state } = fakeStatefulAcp({ caps: { loadSession: true } });
  const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': acpAdapter(spawnImpl) } });
  const id = runner.create({ provider: 'antigravity-cli', cwd: '.', prompt: 'the code is 42' });
  for (let i = 0; i < 6; i++) await tick();
  runner.park(id);
  assert.equal(runner.timeline(id).filter((e) => e.type === 'parked').length, 1);
  runner.send(id, 'what is the code?');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(state.calls.filter((c) => c.startsWith('session/')), ['session/new', 'session/prompt', 'session/load', 'session/prompt']);
  assert.equal(state.sessions.size, 1);
  const outs = runner.timeline(id).filter((e) => e.type === 'output').map((e) => e.text);
  assert.deepEqual(outs, ['S1 remembers []', 'S1 remembers [the code is 42]']);
  assert.ok(!runner.timeline(id).some((e) => e.type === 'resume_fallback'));
});

test('acp park prefers session/resume over session/load when advertised', async () => {
  const { spawnImpl, state } = fakeStatefulAcp({ caps: { loadSession: true, sessionCapabilities: { resume: {}, load: {} } } });
  const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': acpAdapter(spawnImpl) } });
  const id = runner.create({ provider: 'antigravity-cli', cwd: '.', prompt: 'a' });
  for (let i = 0; i < 6; i++) await tick();
  runner.park(id);
  runner.send(id, 'b');
  for (let i = 0; i < 8; i++) await tick();
  assert.ok(state.calls.includes('session/resume') && !state.calls.includes('session/load'));
  assert.equal(runner.timeline(id).filter((e) => e.type === 'output').at(-1).text, 'S1 remembers [a]');
});

for (const [label, opts] of [['no load advertised', { caps: {} }], ['load fails', { caps: { loadSession: true }, failLoad: true }]]) {
  test(`acp park, ${label}: falls back to a primed session/new and logs resume_fallback`, async () => {
    const { spawnImpl, state } = fakeStatefulAcp(opts);
    const runner = new Runner({ dir: tmp(), adapters: { 'antigravity-cli': acpAdapter(spawnImpl) } });
    const id = runner.create({ provider: 'antigravity-cli', cwd: '.', systemPrompt: 'You are Zed.', prompt: 'the code is 42' });
    for (let i = 0; i < 6; i++) await tick();
    runner.park(id);
    runner.send(id, 'what is the code?');
    for (let i = 0; i < 8; i++) await tick();
    assert.equal(state.sessions.size, 2);
    const fb = runner.timeline(id).find((e) => e.type === 'resume_fallback');
    assert.ok(fb && fb.sessionId === 'S1' && fb.reason);
    assert.match(state.lastPrompt, /You are Zed\./);
    assert.match(state.lastPrompt, /User: the code is 42/);
    assert.match(state.lastPrompt, /Assistant: S1 remembers \[\]/);
    assert.match(state.lastPrompt, /what is the code\?$/);
    assert.equal(state.lastPrompt.match(/what is the code\?/g).length, 1);
    assert.ok(state.lastPrompt.length < 9000);
  });
}

test('claude: a 60k system prompt goes via --append-system-prompt-file, never argv, on start and resume', () => {
  const promptsDir = path.join(tmp(), 'prompts');
  const prompt = ('Role prompt ünïcode ✓ ' + 'x'.repeat(100)).repeat(600).slice(0, 60000);
  assert.equal(prompt.length, 60000);
  for (const resume of [undefined, 'sess-1']) {
    const spawnImpl = fakeSpawn();
    const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir });
    adapter.start({ id: 'rn-big', cwd: '.', systemPrompt: prompt, emit() {}, onExit() {}, ...(resume ? { resume } : {}) });
    const { args } = spawnImpl.calls[0];
    const i = args.indexOf('--append-system-prompt-file');
    assert.ok(i >= 0, 'file flag present');
    assert.ok(!args.includes('--append-system-prompt'));
    assert.ok(args.every((a) => !a.includes('Role prompt')), 'no prompt text in argv');
    assert.ok(args.join(' ').length < 8000, `argv ${args.join(' ').length}`);
    if (resume) assert.equal(args[args.indexOf('--resume') + 1], 'sess-1');
    const buf = readFileSync(args[i + 1]);
    assert.notEqual(buf[0], 0xef, 'no BOM');
    assert.equal(buf.toString('utf8'), prompt);
    adapter.cleanup('rn-big');
    assert.ok(!existsSync(args[i + 1]), 'cleanup removes the file');
  }
});

test('Runner: prompt file lives under <home>/prompts, is rewritten on resume, and archive removes it', async () => {
  const home = tmp();
  const spawnImpl = fakeSpawn();
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters: defaultAdapters({ spawnImpl, command: process.execPath, mcp: false, promptsDir: path.join(home, 'prompts') }) });
  const id = runner.create({ provider: 'claude', cwd: '.', systemPrompt: 'PROMPT-A' });
  const file = spawnImpl.calls[0].args[spawnImpl.calls[0].args.indexOf('--append-system-prompt-file') + 1];
  assert.equal(path.dirname(file), path.join(home, 'prompts'));
  assert.equal(readFileSync(file, 'utf8'), 'PROMPT-A');
  runner.archive(id);
  assert.ok(!existsSync(file), 'archive removed the prompt file');
});
