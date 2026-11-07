import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend, toAgent } from '../server/backend/runner-backend.mjs';
import { handleRunnerApi } from '../server/runner-api.mjs';
import { watchRunnerTransitions } from '../server/push.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-stream-'));
const TOKEN = 'tok';
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

// Fake provider: records what reached the adapter; a turn stays "running" until finish() so steer/interrupt can be observed.
function fakeAdapter() {
  const a = {
    calls: [],
    start({ emit }) {
      a.emit = emit;
      return {
        send(text, opts) { a.calls.push(['send', text, opts]); emit('status', { status: 'running' }); },
        cancel() { a.calls.push(['cancel']); },
        kill() {},
      };
    },
  };
  return a;
}

async function boot(adapter = fakeAdapter()) {
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter } });
  const server = createServer(runner, { token: TOKEN, heartbeatMs: 50 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const home = tmp();
  writeDiscovery(home, { port, token: TOKEN });
  const rc = new RunnerClient({ home });
  const whos = [];
  const backend = new RunnerBackend({ client: rc, buildPrefix: async () => '', whosHere: (a) => whos.push(a), rootDir: '/root', lanes: () => new Set(['own']) });
  return { runner, server, port, adapter, rc, backend, whos, close: () => { server.close(); server.closeAllConnections?.(); } };
}

const spawnReq = (lane = 'own') => ({ config: { provider: 'claude', cwd: process.cwd(), title: 'T' }, labels: { team: 'vibesquad', lane, role: 'worker' }, env: {} });

test('runner /events SSE: frames arrive, client disconnect removes the listener', async () => {
  const b = await boot();
  try {
    assert.equal(b.runner.store.listeners.size, 0);
    const frames = [];
    const req = http.get({ port: b.port, path: '/events', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.setEncoding('utf8');
      res.on('data', (d) => frames.push(d));
    });
    await until(() => b.runner.store.listeners.size === 1);
    const id = b.runner.create({ provider: 'claude', cwd: process.cwd(), prompt: 'hello', meta: { lane: 'own' } });
    await until(() => frames.join('').includes('"type":"input"'));
    const data = frames.join('').split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
    assert.ok(data.every((d) => d.id === id));
    assert.deepEqual(data.map((d) => d.event.type).slice(0, 2), ['created', 'input']);
    await until(() => frames.join('').includes(': hb')); // heartbeat keeps proxies from idling the stream out
    req.destroy();
    await until(() => b.runner.store.listeners.size === 0);
  } finally { b.close(); }
});

test('runner /events requires the bearer token', async () => {
  const b = await boot();
  try {
    const status = await new Promise((r) => http.get({ port: b.port, path: '/events' }, (res) => { r(res.statusCode); res.resume(); }));
    assert.equal(status, 401);
  } finally { b.close(); }
});

test('RunnerBackend.subscribeEvents: roster, agent upserts, status transitions, timeline; last unsubscribe closes the stream', async () => {
  const b = await boot();
  try {
    const evs = [];
    const off = b.backend.subscribeEvents((e) => evs.push(e));
    await until(() => evs.some((e) => e.kind === 'connected'));
    assert.equal(evs[0].kind, 'roster');
    const agent = await b.backend.createAgent(spawnReq());
    await b.backend.sendAgentPrompt(agent.id, 'go');
    await until(() => evs.some((e) => e.kind === 'status' && e.to === 'running'));
    b.adapter.emit('turn_done', {});
    b.adapter.emit('status', { status: 'idle' });
    await until(() => evs.some((e) => e.kind === 'status' && e.from === 'running' && e.to === 'idle'));
    assert.ok(evs.some((e) => e.kind === 'agent' && e.agent.id === agent.id));
    assert.ok(evs.some((e) => e.kind === 'timeline' && e.type === 'input'));
    // an error event before the turn ends reads as an error transition (what push pages on)
    await b.backend.sendAgentPrompt(agent.id, 'again');
    await until(() => evs.filter((e) => e.kind === 'status' && e.to === 'running').length === 2);
    b.adapter.emit('error', { message: 'boom' });
    b.adapter.emit('status', { status: 'idle' });
    await until(() => evs.some((e) => e.kind === 'status' && e.to === 'error'));
    const off2 = b.backend.subscribeEvents(() => {});
    off();
    assert.equal(b.runner.store.listeners.size, 1, 'second listener keeps the shared stream open');
    off2();
    await until(() => b.runner.store.listeners.size === 0);
    await b.backend.archiveAgent(agent.id);
  } finally { b.close(); }
});

test('RunnerBackend.subscribeEvents with no runner: no throw, retries quietly, close stops it', async () => {
  const rc = new RunnerClient({ home: tmp() });
  const backend = new RunnerBackend({ client: rc });
  const off = backend.subscribeEvents(() => {});
  await new Promise((r) => setTimeout(r, 30));
  off();
});

test('GET /__vibesquad/runner/events: starts with the roster, releases the listener on disconnect', async () => {
  const listeners = new Set();
  const backend = {
    subscribeEvents(fn) { listeners.add(fn); fn({ kind: 'roster', agents: [{ id: 'rn-1' }] }); return () => listeners.delete(fn); },
  };
  const req = new EventEmitter();
  req.url = '/__vibesquad/runner/events';
  req.method = 'GET';
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (code, h) => { res.code = code; res.headers = h; };
  res.write = (c) => { res.chunks.push(c); return true; };
  await handleRunnerApi(req, res, { readBody: async () => ({}), sendJson: () => {}, backend, lanes: () => new Set(['own']) });
  assert.equal(res.code, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(listeners.size, 1);
  for (const fn of listeners) fn({ kind: 'timeline', agentId: 'rn-1', seq: 3, type: 'output' });
  const body = res.chunks.join('');
  assert.match(body, /data: \{"kind":"roster","agents":\[\{"id":"rn-1"\}\]\}/);
  assert.match(body, /"kind":"timeline"/);
  req.emit('close');
  res.emit('close');
  assert.equal(listeners.size, 0);
});

test('push: runner running->idle/error and needs-you fire notifications; roster seed does not re-page', () => {
  let fire;
  let unsubbed = false;
  const runner = { subscribeEvents(fn) { fire = fn; return () => { unsubbed = true; }; } };
  const notes = [];
  const off = watchRunnerTransitions(runner, { notify: (n) => notes.push(n) });
  const base = { id: 'rn-a', title: 'Worker', labels: { role: 'worker' }, status: 'running' };
  fire({ kind: 'roster', agents: [{ ...base, labels: { role: 'worker', 'needs-you': 'old ask' } }] });
  fire({ kind: 'agent', agent: { ...base, labels: { role: 'worker', 'needs-you': 'old ask' }, status: 'running' } });
  assert.equal(notes.length, 0);
  fire({ kind: 'agent', agent: { ...base, labels: { role: 'worker', 'needs-you': 'old ask' }, status: 'idle', updatedAt: 't1' } });
  assert.deepEqual(notes.map((n) => n.kind), ['finished']);
  fire({ kind: 'agent', agent: { ...base, labels: { role: 'worker', 'needs-you': 'new ask' }, status: 'idle' } });
  assert.equal(notes.at(-1).kind, 'needs-you');
  fire({ kind: 'agent', agent: { ...base, status: 'running' } });
  fire({ kind: 'agent', agent: { ...base, status: 'error', updatedAt: 't2' } });
  assert.equal(notes.at(-1).kind, 'error');
  const withPerm = { ...base, status: 'running', pendingPermissions: [{ id: 'p1', toolName: 'Bash' }] };
  fire({ kind: 'agent', agent: withPerm });
  fire({ kind: 'permission', agentId: 'rn-a', request: { id: 'p1', toolName: 'Bash' } }); // the duplicate path is gone
  fire({ kind: 'agent', agent: withPerm });
  assert.equal(notes.filter((n) => n.kind === 'permission').length, 1);
  off();
  assert.ok(unsubbed);
});

test('interrupt cancels the running turn before sending; steer (default) does not; idle agent is not cancelled', async () => {
  const b = await boot();
  try {
    const agent = await b.backend.createAgent(spawnReq());
    await b.backend.sendAgentPrompt(agent.id, 'one'); // running
    await b.backend.sendAgentPrompt(agent.id, 'two'); // steer
    assert.deepEqual(b.adapter.calls.map((c) => c[0]), ['send', 'send']);
    await b.backend.sendAgentPrompt(agent.id, 'three', { activeTurnBehavior: 'interrupt' });
    assert.deepEqual(b.adapter.calls.map((c) => c[0]), ['send', 'send', 'cancel', 'send']);
    assert.equal(b.adapter.calls.at(-1)[1], 'three');
    b.adapter.emit('status', { status: 'idle' });
    await until(() => b.runner.status(agent.id).status === 'idle');
    await b.backend.sendAgentPrompt(agent.id, 'four', { activeTurnBehavior: 'interrupt' });
    assert.deepEqual(b.adapter.calls.map((c) => c[0]).slice(4), ['send']);
  } finally { b.close(); }
});

test('images pass /input -> adapter; the log keeps a count, not the payload', async () => {
  const b = await boot();
  try {
    const agent = await b.backend.createAgent(spawnReq());
    const img = { data: 'AAAA', mimeType: 'image/png' };
    await b.backend.sendAgentPrompt(agent.id, 'look', { images: [img, { bad: 1 }] });
    assert.deepEqual(b.adapter.calls[0][2], { images: [img] });
    const input = b.runner.timeline(agent.id).find((e) => e.type === 'input');
    assert.equal(input.images, 1);
    assert.ok(!JSON.stringify(input).includes('AAAA'));
    const tl = await b.backend.fetchAgentTimeline(agent.id);
    assert.equal(tl.entries[0].item.images, 1);
  } finally { b.close(); }
});

function fakeSpawn() {
  const impl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.written = [];
    child.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) child.written.push(JSON.parse(l)); });
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    return (impl.last = child);
  };
  return impl;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('claude adapter: images become base64 image blocks ahead of the text; usage events carry context size', async () => {
  const spawnImpl = fakeSpawn();
  const events = [];
  const h = createClaudeAdapter({ spawnImpl, mcp: false }).start({ cwd: '.', emit: (t, d) => events.push([t, d]), onExit() {} });
  h.send('what is this', { images: [{ data: 'QUJD', mimeType: 'image/png' }] });
  const msg = spawnImpl.last.written[0];
  assert.deepEqual(msg.message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    { type: 'text', text: 'what is this' },
  ]);
  h.send('plain');
  assert.equal(spawnImpl.last.written[1].message.content, 'plain');
  spawnImpl.last.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 } } });
  await tick();
  const usage = events.find(([t]) => t === 'usage')[1];
  assert.deepEqual(usage, { contextTokens: 112, inputTokens: 105, outputTokens: 7 });
});

test('ACP adapter: image content blocks when the agent advertises them, an explicit note when it does not; usage_update', async () => {
  for (const imageCapable of [true, false]) {
    const spawnImpl = fakeSpawn();
    const events = [];
    const a = createAcpAdapter({ spawnImpl, provider: 'opencode', mcp: false, resolved: { file: '/bin/fake', args: [] } });
    const h = a.start({ cwd: '.', emit: (t, d) => events.push([t, d]), onExit() {} });
    const child = spawnImpl.last;
    const reply = (id, result) => child.push({ jsonrpc: '2.0', id, result });
    await tick();
    reply(1, { agentCapabilities: { promptCapabilities: { image: imageCapable } } });
    await tick();
    reply(2, { sessionId: 's1' });
    await tick();
    h.send('see', { images: [{ data: 'QUJD', mimeType: 'image/jpeg' }] });
    await tick();
    const prompt = child.written.find((m) => m.method === 'session/prompt');
    if (imageCapable) assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'see' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]);
    else {
      assert.equal(prompt.params.prompt.length, 1);
      assert.match(prompt.params.prompt[0].text, /image attachment\(s\) omitted/);
    }
    child.push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update', used: 4321, size: 200000 } } });
    await tick();
    assert.deepEqual(events.find(([t]) => t === 'usage')[1], { contextTokens: 4321, contextMax: 200000 });
  }
});

test('ACP permission requests are logged request+resolved (pendingPermissions derives from the log)', async () => {
  const spawnImpl = fakeSpawn();
  const events = [];
  createAcpAdapter({ spawnImpl, provider: 'opencode', mcp: false, resolved: { file: '/bin/fake', args: [] } })
    .start({ cwd: '.', emit: (t, d) => events.push([t, d]), onExit() {} });
  spawnImpl.last.push({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { toolCall: { toolCallId: 't1', title: 'Bash' }, options: [{ kind: 'allow_once', optionId: 'o1' }] } });
  await tick();
  assert.deepEqual(events.filter(([t]) => t === 'permission').map(([, d]) => [d.phase, d.id]), [['request', 't1'], ['resolved', 't1']]);
});

test('toAgent: usage -> lastUsage/tokenUsage (lead-handoff reads it), pendingPermissions surfaced', async () => {
  const { leadUsedTokens } = await import('../server/lead-handoff.mjs');
  const base = { id: 'rn-x', provider: 'claude', cwd: '.', status: 'idle', createdAt: 1, meta: {} };
  assert.equal(toAgent(base).tokenUsage, undefined);
  const a = toAgent({ ...base, usage: { contextTokens: 777_000, contextMax: 1_000_000, inputTokens: 770_000, outputTokens: 7000 }, pendingPermissions: [{ id: 'p', toolName: 'Bash' }] });
  assert.equal(a.lastUsage.contextWindowUsedTokens, 777_000);
  assert.equal(a.lastUsage.contextWindowMaxTokens, 1_000_000);
  assert.equal(a.tokenUsage.usedTokens, 777_000);
  assert.equal(leadUsedTokens(a), 777_000);
  assert.deepEqual(a.pendingPermissions, [{ id: 'p', toolName: 'Bash' }]);
  assert.equal(a.requiresAttention, true);
});

test('runner status carries usage + pendingPermissions from the log; createAgent refreshes Who\'s here for its lane', async () => {
  const b = await boot();
  try {
    const agent = await b.backend.createAgent(spawnReq('own'));
    assert.equal(b.whos.length, 1);
    assert.equal(b.whos[0].laneId, 'own');
    assert.equal(b.whos[0].rootDir, '/root');
    assert.deepEqual(b.whos[0].agents.map((x) => x.id), [agent.id]);
    b.adapter.emit('usage', { contextTokens: 5000, inputTokens: 4900, outputTokens: 100 });
    b.adapter.emit('permission', { phase: 'request', id: 'p1', toolName: 'Edit' });
    const live = (await b.backend.fetchAgent(agent.id)).agent;
    assert.equal(live.lastUsage.contextWindowUsedTokens, 5000);
    assert.equal(live.pendingPermissions.length, 1);
    b.adapter.emit('permission', { phase: 'resolved', id: 'p1' });
    assert.equal((await b.backend.fetchAgent(agent.id)).agent.pendingPermissions.length, 0);
    // a brief refresh failure never fails the spawn
    const flaky = new RunnerBackend({ client: b.rc, buildPrefix: async () => '', whosHere: () => { throw new Error('disk'); } });
    assert.ok((await flaky.createAgent(spawnReq('own'))).id);
  } finally { b.close(); }
});

test('runner unreachable: the events stream says disconnected, never an empty roster', async () => {
  const backend = new RunnerBackend({ client: new RunnerClient({ home: tmp() }) });
  const evs = [];
  const off = backend.subscribeEvents((e) => evs.push(e));
  await until(() => evs.length > 0);
  off();
  assert.deepEqual(evs.map((e) => e.kind), ['disconnected']);
  // and over HTTP: no roster frame at all
  const req = new EventEmitter();
  req.url = '/__vibesquad/runner/events';
  req.method = 'GET';
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = () => {};
  res.write = (c) => { res.chunks.push(c); return true; };
  await handleRunnerApi(req, res, { readBody: async () => ({}), sendJson: () => {}, backend, lanes: () => new Set(['own']) });
  await until(() => res.chunks.join('').includes('"disconnected"'));
  assert.ok(!res.chunks.join('').includes('"roster"'));
  req.emit('close');
  res.emit('close');
});

test('initial roster goes through the event chain: a slow roster never lands after a newer agent event; stale work is dropped after unsubscribe', async () => {
  const backend = new RunnerBackend({ client: { stream: () => ({ close() {} }) } });
  let release;
  const gate = new Promise((r) => { release = r; });
  backend.listAgents = async () => { await gate; return [{ id: 'rn-1', status: 'idle' }]; };
  backend.fetchAgent = async () => ({ agent: { id: 'rn-1', status: 'running' } });
  const evs = [];
  const off = backend.subscribeEvents((e) => evs.push(e.kind === 'agent' ? `agent:${e.agent.status}` : e.kind));
  backend.enqueue((gen) => backend.handleLogEvent({ id: 'rn-1', event: { type: 'status', seq: 1 } }, gen));
  release();
  await until(() => evs.includes('agent:running'));
  assert.deepEqual(evs.filter((k) => k !== 'timeline' && k !== 'status'), ['roster', 'connected', 'agent:running']);
  // work queued for a closed stream is dropped (generation bump), even if its fetch resolves later
  const seen = [];
  const off2 = backend.subscribeEvents((e) => seen.push(e.kind));
  await until(() => seen.includes('connected'));
  let late;
  backend.fetchAgent = () => new Promise((r) => { late = r; });
  backend.enqueue((gen) => backend.handleLogEvent({ id: 'rn-1', event: { type: 'status', seq: 2 } }, gen));
  await until(() => late);
  off(); off2();
  const after = [];
  const off3 = backend.subscribeEvents((e) => after.push(e.kind));
  late({ agent: { id: 'rn-1', status: 'idle' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!after.includes('agent'), 'a stale in-flight event must not reach the new subscriber');
  off3();
});

test('error turns: one "error" transition + push, status stays error until the next turn; no "Turn Complete"', async () => {
  const b = await boot();
  try {
    const evs = [];
    const notes = [];
    const stopPush = watchRunnerTransitions(b.backend, { notify: (n) => notes.push(n) });
    const off = b.backend.subscribeEvents((e) => evs.push(e));
    await until(() => evs.some((e) => e.kind === 'connected'));
    const agent = await b.backend.createAgent(spawnReq());
    await b.backend.sendAgentPrompt(agent.id, 'go');
    await until(() => evs.some((e) => e.kind === 'status' && e.to === 'running'));
    b.adapter.emit('error', { message: 'boom' });
    b.adapter.emit('status', { status: 'idle' });
    await until(() => evs.some((e) => e.kind === 'status' && e.to === 'error'));
    // later roster events while idle (usage, meta) must not flip the shown status back
    b.adapter.emit('usage', { contextTokens: 10, inputTokens: 10, outputTokens: 0 });
    await b.backend.updateAgent(agent.id, { name: 'renamed' });
    await until(() => evs.some((e) => e.kind === 'timeline' && e.type === 'meta'));
    await new Promise((r) => setTimeout(r, 80));
    const shown = evs.filter((e) => e.kind === 'agent' && e.agent.id === agent.id).map((e) => e.agent.status);
    assert.ok(shown.length >= 3);
    assert.ok(!shown.slice(shown.indexOf('error')).includes('idle'), shown.join());
    assert.equal(shown.at(-1), 'error');
    assert.deepEqual(notes.map((n) => n.kind), ['error']);
    assert.equal(notes[0].title, 'VibeSquad · Agent Error');
    assert.equal(evs.filter((e) => e.kind === 'status' && e.to === 'error').length, 1);
    // next turn starts: error clears
    await b.backend.sendAgentPrompt(agent.id, 'retry');
    await until(() => evs.some((e) => e.kind === 'status' && e.from === 'error' && e.to === 'running'));
    stopPush();
    off();
  } finally { b.close(); }
});

test('claude adapter: a failed result (is_error / error_* subtype) emits an error event before turn_done', async () => {
  for (const result of [{ is_error: true, subtype: 'success', result: 'API Error' }, { subtype: 'error_during_execution' }]) {
    const spawnImpl = fakeSpawn();
    const events = [];
    createClaudeAdapter({ spawnImpl, mcp: false }).start({ cwd: '.', emit: (t) => events.push(t), onExit() {} });
    spawnImpl.last.push({ type: 'result', ...result });
    await tick();
    assert.deepEqual(events, ['error', 'turn_done', 'status']);
  }
  const spawnImpl = fakeSpawn();
  const events = [];
  createClaudeAdapter({ spawnImpl, mcp: false }).start({ cwd: '.', emit: (t) => events.push(t), onExit() {} });
  spawnImpl.last.push({ type: 'result', subtype: 'success' });
  await tick();
  assert.deepEqual(events, ['turn_done', 'status']);
});

test('shown status follows the log order, not fetchAgent tail: usage, error, idle logged back-to-back still reads as one error; seeds overlay error', async () => {
  const backend = new RunnerBackend({ client: { stream: (h) => { queueMicrotask(() => h.onOpen()); return { close() {} }; } } });
  let listed = 'running';
  backend.listAgents = async () => [{ id: 'rn-1', status: listed }];
  backend.fetchAgent = async () => ({ agent: { id: 'rn-1', status: 'idle' } }); // already at the end of the log
  const evs = [];
  const off = backend.subscribeEvents((e) => evs.push(e));
  await until(() => evs.some((e) => e.kind === 'connected'));
  const feed = (event) => backend.enqueue((gen) => backend.handleLogEvent({ id: 'rn-1', event }, gen));
  feed({ type: 'usage', seq: 1 });
  feed({ type: 'error', seq: 2 });
  feed({ type: 'status', seq: 3, status: 'idle' });
  feed({ type: 'usage', seq: 4 });
  await until(() => evs.filter((e) => e.kind === 'timeline').length === 4);
  await new Promise((r) => setTimeout(r, 30));
  const trans = evs.filter((e) => e.kind === 'status').map((e) => `${e.from}>${e.to}`);
  assert.deepEqual(trans, ['running>error']);
  assert.equal(evs.filter((e) => e.kind === 'agent').at(-1).agent.status, 'error');
  // a new listener / reconnect roster of an idle-but-errored agent still says error
  listed = 'idle';
  const late = [];
  const off2 = backend.subscribeEvents((e) => late.push(e));
  await until(() => late.some((e) => e.kind === 'roster'));
  assert.equal(late.find((e) => e.kind === 'roster').agents[0].status, 'error');
  // next turn clears it
  feed({ type: 'status', seq: 5, status: 'running' });
  await until(() => evs.some((e) => e.kind === 'status' && e.from === 'error' && e.to === 'running'));
  off(); off2();
});

test('every log event emits a timeline event, including post-thought text that the timeline absorbs into an earlier row', async () => {
  const backend = new RunnerBackend({ client: { stream: (h) => { queueMicrotask(() => h.onOpen()); return { close() {} }; } } });
  backend.listAgents = async () => [{ id: 'rn-1', status: 'running' }];
  backend.fetchAgent = async () => ({ agent: { id: 'rn-1', status: 'running' } });
  const evs = [];
  const off = backend.subscribeEvents((e) => evs.push(e));
  await until(() => evs.some((e) => e.kind === 'connected'));
  const seqs = [[1, 'output'], [2, 'thought'], [3, 'output'], [4, 'output'], [5, 'stderr']];
  for (const [seq, type] of seqs) backend.enqueue((gen) => backend.handleLogEvent({ id: 'rn-1', event: { type, seq } }, gen));
  await until(() => evs.filter((e) => e.kind === 'timeline').length === seqs.length);
  assert.deepEqual(evs.filter((e) => e.kind === 'timeline').map((e) => e.seq), [1, 2, 3, 4, 5]);
  off();
});
