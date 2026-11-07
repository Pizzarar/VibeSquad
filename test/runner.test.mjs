import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnNoShell } from '../runner/spawn.mjs';
import { LogStore } from '../runner/log.mjs';
import { Runner } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-runner-'));
const tick = () => new Promise((r) => setTimeout(r, 15));

// Fake child process: captures stdin lines, lets the test push stdout lines.
function fakeSpawn(onStdin) {
  const calls = [];
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.written = [];
    child.stdin.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) {
        const m = JSON.parse(l);
        child.written.push(m);
        onStdin?.(m, child);
      }
    });
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    calls.push({ file, args, opts, child });
    return impl.last = child;
  };
  impl.calls = calls;
  return impl;
}
const resolved = { file: '/bin/fake', args: [] };

test('spawnNoShell never uses a shell and keeps multi-line args intact', () => {
  const spawnImpl = fakeSpawn();
  const arg = 'line one\nline two "quoted"';
  spawnNoShell('x', ['-p', arg], { cwd: '/w', resolved }, spawnImpl);
  const c = spawnImpl.calls[0];
  assert.equal(c.opts.shell, false);
  assert.equal(c.file, '/bin/fake');
  assert.deepEqual(c.args, ['-p', arg]);
  assert.equal(c.opts.windowsHide, true);
  // even if a caller tries to force a shell, it is overridden
  spawnNoShell('x', [], { shell: true, resolved }, spawnImpl);
  assert.equal(spawnImpl.calls[1].opts.shell, false);
});

test('log append is ordered, seq-numbered and tailable', () => {
  const store = new LogStore(tmp());
  store.append('a1', 'created', { provider: 'claude' });
  store.append('a1', 'input', { text: 'hi' });
  store.append('a1', 'output', { text: 'ok' });
  const all = store.read('a1');
  assert.deepEqual(all.map((e) => e.seq), [0, 1, 2]);
  assert.deepEqual(store.read('a1', 2).map((e) => e.type), ['output']);
  assert.equal(store.read('a1', 1, 1).length, 1);
  // a fresh store (runner restart) continues the sequence from disk
  const again = new LogStore(store.dir);
  assert.equal(again.append('a1', 'status', { status: 'idle' }).seq, 3);
});

test('lazy index: startup and status() never read other agents logs', () => {
  const dir = tmp();
  for (let i = 0; i < 50; i++) writeFileSync(path.join(dir, `old${i}.jsonl`), 'NOT JSON AT ALL\n');
  const runner = new Runner({ dir, adapters: {} });
  assert.equal(runner.store.idx.size, 0, 'nothing indexed at startup');
  assert.equal(runner.list().length, 50, 'listing is by file name only');
  const s = new LogStore(dir);
  s.append('fresh', 'created', { provider: 'claude', meta: {} });
  assert.equal(runner.status('fresh').id, 'fresh');
  assert.equal(runner.store.idx.size, 1, 'status() reads and indexes only the one file');
});

test('claude adapter: create, input, output, status, cancel, exit; meta fields are first-class', async () => {
  const spawnImpl = fakeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, command: process.execPath }) } });
  const id = runner.create({
    provider: 'claude', model: 'claude-haiku-5-5', cwd: process.cwd(), prompt: 'reply ok',
    meta: { squad: 's', team: 't', lane: 'own', role: 'worker', ord: 2, profile: 'p', junk: 'dropped' },
  });
  const child = spawnImpl.last;
  assert.deepEqual(spawnImpl.calls[0].args.slice(0, 5), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.ok(spawnImpl.calls[0].args.includes('claude-haiku-5-5'));
  assert.equal(spawnImpl.calls[0].opts.shell, false);
  assert.deepEqual(child.written[0], { type: 'user', message: { role: 'user', content: 'reply ok' } });

  child.push({ type: 'system', subtype: 'init', session_id: 'sess', model: 'claude-haiku-5-5' });
  child.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  child.push({ type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 0.001 });
  await tick();
  let st = runner.status(id);
  assert.equal(st.status, 'idle');
  assert.deepEqual(st.meta, { squad: 's', team: 't', lane: 'own', role: 'worker', ord: 2, profile: 'p' });
  const types = runner.timeline(id).map((e) => e.type);
  assert.deepEqual(types, ['created', 'input', 'status', 'session', 'output', 'turn_done', 'status']);

  // second turn: send + cancel (interrupt control request)
  runner.send(id, 'again');
  runner.cancel(id);
  await tick();
  assert.equal(child.written[1].message.content, 'again');
  assert.equal(child.written[2].request.subtype, 'interrupt');
  assert.ok(runner.timeline(id).some((e) => e.type === 'cancel'));

  runner.kill(id);
  await tick();
  st = runner.status(id);
  assert.equal(st.status, 'exited');
  assert.throws(() => runner.send(id, 'x'), /not running/);
});

test('tailing the timeline by seq returns only new events', async () => {
  const spawnImpl = fakeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, command: process.execPath }) } });
  const id = runner.create({ provider: 'claude', cwd: '.', prompt: 'hi' });
  const next = runner.status(id).lastSeq + 1;
  spawnImpl.last.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'later' }] } });
  await tick();
  const tail = runner.timeline(id, next);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].text, 'later');
});

test('acp adapter: initialize, session/new, prompt, streamed chunks, cancel', async () => {
  const spawnImpl = fakeSpawn((m, child) => {
    if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
    if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S1' } });
    if (m.method === 'session/prompt') {
      child.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
      child.push({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    }
  });
  const runner = new Runner({ dir: tmp(), adapters: { opencode: createAcpAdapter({ spawnImpl, command: process.execPath }) } });
  const id = runner.create({ provider: 'opencode', cwd: '.', prompt: 'reply ok' });
  await tick(); await tick();
  const child = spawnImpl.last;
  assert.equal(spawnImpl.calls[0].opts.shell, false);
  assert.deepEqual(child.written.map((m) => m.method), ['initialize', 'session/new', 'session/prompt']);
  assert.equal(child.written[2].params.prompt[0].text, 'reply ok');
  const ev = runner.timeline(id);
  assert.ok(ev.some((e) => e.type === 'output' && e.text === 'ok'));
  assert.ok(ev.some((e) => e.type === 'turn_done' && e.stopReason === 'end_turn'));
  assert.equal(runner.status(id).status, 'idle');
  runner.cancel(id);
  await tick();
  assert.equal(child.written.at(-1).method, 'session/cancel');
});

test('status of a log with no live child is "lost" (runner restarted)', () => {
  const dir = tmp();
  new LogStore(dir).append('zz', 'created', { provider: 'claude', meta: {} });
  const runner = new Runner({ dir, adapters: {} });
  assert.equal(runner.status('zz').status, 'lost');
  assert.equal(runner.status('nope'), null);
});
