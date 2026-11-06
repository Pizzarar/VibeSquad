import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, defaultAdapters } from '../runner/runner.mjs';
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

test('acp adapter: permissionMode default denies permission requests', async () => {
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S' } });
    if (m.method === 'session/prompt') child.push({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { options: [{ optionId: 'yes', kind: 'allow_once' }] } });
  });
  const runner = new Runner({ dir: tmp(), adapters: { opencode: fakeAdapter(spawnImpl, 'opencode') } });
  runner.create({ provider: 'opencode', cwd: '.', prompt: 'x', meta: { permissionMode: 'default' } });
  await tick(); await tick(); await tick();
  assert.deepEqual(spawnImpl.last.written.at(-1).result, { outcome: { outcome: 'cancelled' } });
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
