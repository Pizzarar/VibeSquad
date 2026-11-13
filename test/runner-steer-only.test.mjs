// idea-169 (follow-up of idea-162, 47f3310): runner.send(id, text, { steerOnly: true }) joins the agent's OPEN turn or is
// dropped. It never starts, resumes, queues or coalesces a turn, so a guard/nudge input can never wake an idle agent.
// Default send behavior is unchanged (last block).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, droppedSteerSeqs } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { handleRunnerApi } from '../server/runner-api.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-steeronly-')); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

// A controllable adapter: each send is recorded; the test drives idle/running with emit.
function controlledAdapter() {
  const started = [];
  const adapter = {
    canPark: true,
    start({ emit, onExit }) {
      const rec = { emit, onExit, sends: [] };
      started.push(rec);
      return { send(text, opts) { rec.sends.push({ text, opts }); emit('status', { status: 'running' }); }, cancel() {}, kill() {} };
    },
  };
  adapter.started = started;
  return adapter;
}

// The real claude adapter over a fake child: user messages written to stdin are captured; child.result() ends a turn.
function fakeClaudeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); };
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.result = () => child.push({ type: 'result', subtype: 'success' });
    child.users = [];
    child.stdin.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) {
        try { const m = JSON.parse(l); if (m.type === 'user') child.users.push(m.message.content); } catch { /* partial */ }
      }
    });
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: `sess-${calls.length}`, model: 'm' }));
    calls.push({ file, args, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}

// An ACP adapter over a fake child: session/prompt requests are captured with their text; finishPrompt() answers the oldest.
function fakeAcpSpawn() {
  const prompts = [];
  const sentTexts = [];
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.stdin.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) {
        const m = JSON.parse(l);
        if (m.method === 'initialize') child.push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
        else if (m.method === 'session/new') child.push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S' } });
        else if (m.method === 'session/prompt') { prompts.push({ id: m.id, child }); sentTexts.push(m.params.prompt[0].text); }
      }
    });
    return child;
  };
  impl.prompts = prompts;
  impl.sentTexts = sentTexts;
  impl.finishPrompt = () => { const p = prompts.shift(); p.child.push({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'end_turn' } }); };
  return impl;
}

const acpRunner = (spawnImpl, extra = {}) => new Runner({ dir: tmp(), adapters: { 'antigravity-cli': createAcpAdapter({ spawnImpl, provider: 'antigravity-cli', mcp: false, resolved: { file: '/bin/fake', args: [] } }) }, turnCaps: { antigravity: 4 }, parkGraceMs: 60_000, ...extra });
const mk = (runner, extra = {}) => runner.create({ provider: 'claude', cwd: os.tmpdir(), ...extra });
const inputs = (runner, id) => runner.timeline(id).filter((e) => e.type === 'input');
const statuses = (runner, id) => runner.timeline(id).filter((e) => e.type === 'status').map((e) => e.status);

// ---- idle -> dropped ----

test('idle -> dropped: no input logged, adapter never called, no turn opened', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  adapter.started[0].emit('status', { status: 'idle' });
  const before = { inputs: inputs(runner, a).length, statuses: statuses(runner, a).length, sends: adapter.started[0].sends.length };

  const r = runner.send(a, 'wrap up', { steerOnly: true });
  assert.deepEqual(r, { queued: false, delivered: false, reason: 'idle' });
  assert.equal(adapter.started[0].sends.length, before.sends, 'adapter.send not called');
  assert.equal(inputs(runner, a).length, before.inputs, 'no input event');
  assert.equal(statuses(runner, a).length, before.statuses, 'no status event (no running, no queued)');
  assert.equal(runner.live.get(a).inflight, 0, 'no turn slot taken');
  runner.shutdown();
});

test('parked -> dropped (not-running): the agent is not resumed', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  adapter.started[0].emit('session', { sessionId: 'sess-1' });
  adapter.started[0].emit('status', { status: 'idle' });
  runner.park(a);
  assert.equal(runner.status(a).status, 'parked');

  const r = runner.send(a, 'wrap up', { steerOnly: true });
  assert.deepEqual(r, { queued: false, delivered: false, reason: 'not-running' });
  assert.equal(adapter.started.length, 1, 'no new process started');
  assert.equal(runner.live.has(a), false);
  assert.equal(runner.status(a).status, 'parked', 'still parked');
  assert.equal(runner.queuePosition(a).queued, false, 'nothing queued');
  runner.shutdown();
});

test('queued (its turn waits for a slot) -> dropped: never coalesced into the queued job', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000 });
  mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.queuePosition(b).queued, true);

  const r = runner.send(b, 'wrap up', { steerOnly: true });
  assert.deepEqual(r, { queued: false, delivered: false, reason: 'queued' });
  assert.equal(runner.queue.find((j) => j.id === b).text, 'b', 'queued job text unchanged');
  runner.shutdown();
});

test('unknown agent: throws like a plain send', () => {
  const runner = new Runner({ dir: tmp(), adapters: { claude: controlledAdapter() } });
  assert.throws(() => runner.send('rn-nope', 'x', { steerOnly: true }), /not running/);
  runner.shutdown();
});

// ---- running -> delivered as steer ----

test('running -> delivered as a steer into the open turn (real claude adapter): one turn, one result, then parks', async () => {
  const spawnImpl = fakeClaudeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, parkGraceMs: 0 });
  const a = mk(runner, { prompt: 'one' });
  await tick();
  assert.equal(runner.live.get(a).inflight, 1);

  const r = runner.send(a, 'wrap up', { steerOnly: true });
  assert.deepEqual(r, { queued: false, delivered: true, steer: true });
  await tick();
  const child = spawnImpl.calls[0].child;
  assert.deepEqual(child.users, ['one', 'wrap up'], 'written into the running session');
  const inp = inputs(runner, a).at(-1);
  assert.equal(inp.text, 'wrap up');
  assert.equal(inp.steerOnly, true, 'logged as a steer-only input');
  assert.equal(runner.live.get(a).inflight, 1, 'merged: no extra slot');

  child.result(); // the single result of the merged turn
  await tick(30);
  assert.equal(runner.status(a).status, 'parked', 'one idle ends it: no follow-up turn');
  runner.shutdown();
});

test('running but interrupted (turn ending) -> dropped on the claude adapter', async () => {
  const spawnImpl = fakeClaudeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'one' });
  await tick();
  runner.cancel(a); // interrupt sent; the turn is ending, its result not in yet
  assert.equal(runner.live.get(a).inflight, 1, 'still inflight until the result');

  const r = runner.send(a, 'wrap up', { steerOnly: true });
  assert.deepEqual(r, { queued: false, delivered: false, reason: 'turn-ending' });
  await tick();
  assert.deepEqual(spawnImpl.calls[0].child.users, ['one'], 'nothing written: it would have started a new turn after the interrupt');
  runner.shutdown();
});

test('claude adapter: send({ steerOnly }) with no open turn returns false and writes nothing', async () => {
  const spawnImpl = fakeClaudeSpawn();
  const handle = createClaudeAdapter({ spawnImpl, mcp: false }).start({ id: 'x', env: { ...process.env }, cwd: os.tmpdir(), meta: {}, emit() {}, onExit() {} });
  await tick();
  assert.equal(handle.steerable(), false);
  assert.equal(handle.send('nudge', { steerOnly: true }), false);
  await tick();
  assert.deepEqual(spawnImpl.calls[0].child.users, []);
  handle.kill();
});

// ---- queued-then-turn-ends -> dropped (ACP: no in-turn injection) ----

test('ACP: a steer queued behind the running prompt is dropped when that prompt ends (no second session/prompt, agent idles)', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  assert.equal(spawnImpl.prompts.length, 1, 'turn 1 in flight');

  const r = runner.send(a, 'wrap up', { steerOnly: true });
  assert.deepEqual(r, { queued: false, delivered: true, steer: true }, 'accepted while the turn is open');

  spawnImpl.finishPrompt();
  await settle();
  assert.deepEqual(spawnImpl.sentTexts, ['one'], 'the steer never ran as its own prompt');
  assert.equal(spawnImpl.prompts.length, 0);
  assert.equal(runner.live.get(a).inflight, 0, 'agent went idle');
  assert.equal(runner.live.get(a).status, 'idle');
  const dropped = runner.timeline(a).filter((e) => e.type === 'steer_dropped');
  assert.equal(dropped.length, 1, 'the drop is in the log');
  assert.equal(dropped[0].reason, 'turn-ended');
  runner.shutdown();
});

test('ACP: a steer rides along with a real prompt queued behind it (one prompt, steer text first)', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  runner.send(a, 'wrap up', { steerOnly: true });
  runner.send(a, 'two'); // a plain send queued behind it
  spawnImpl.finishPrompt();
  await settle();
  assert.deepEqual(spawnImpl.sentTexts, ['one', 'wrap up\n\ntwo'], 'merged into the next real prompt, in arrival order');
  spawnImpl.finishPrompt();
  await settle();
  assert.equal(runner.live.get(a).status, 'idle');
  assert.equal(runner.timeline(a).filter((e) => e.type === 'steer_dropped').length, 0);
  runner.shutdown();
});

test('ACP: a steer accepted mid-prompt survives until the prompt ends (a real send a tick later still carries it)', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  runner.send(a, 'wrap up', { steerOnly: true });
  await settle(); // the adapter's pump ran while turn 1 is in flight: it must not drop the steer yet
  assert.equal(runner.timeline(a).filter((e) => e.type === 'steer_dropped').length, 0, 'not dropped while the prompt is in flight');
  runner.send(a, 'two');
  spawnImpl.finishPrompt();
  await settle();
  assert.deepEqual(spawnImpl.sentTexts, ['one', 'wrap up\n\ntwo']);
  spawnImpl.finishPrompt();
  await settle();
  runner.shutdown();
});

test('ACP: a steer queued after the last real prompt is dropped when that prompt ends', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  runner.send(a, 'two');
  runner.send(a, 'wrap up', { steerOnly: true });
  spawnImpl.finishPrompt();
  await settle();
  assert.deepEqual(spawnImpl.sentTexts, ['one', 'two'], 'the real follow-up runs on its own');
  spawnImpl.finishPrompt();
  await settle();
  assert.deepEqual(spawnImpl.sentTexts, ['one', 'two'], 'the steer never started a third prompt');
  assert.equal(runner.live.get(a).status, 'idle');
  assert.equal(runner.timeline(a).filter((e) => e.type === 'steer_dropped').length, 1);
  runner.shutdown();
});

test('ACP: idle -> dropped synchronously, nothing queued in the adapter', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  spawnImpl.finishPrompt();
  await settle();
  assert.equal(runner.live.get(a).status, 'idle');
  assert.deepEqual(runner.send(a, 'wrap up', { steerOnly: true }), { queued: false, delivered: false, reason: 'idle' });
  await settle();
  assert.deepEqual(spawnImpl.sentTexts, ['one']);
  runner.shutdown();
});

test('a steer-only input in the log is never replayed as an unstarted input after a restart', () => {
  const adapter = controlledAdapter();
  const dir = tmp();
  const runner = new Runner({ dir, adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  runner.send(a, 'wrap up', { steerOnly: true });
  // Simulate a turn that later went back to queued (a restart while waiting): only real inputs after the cut count.
  runner.store.append(a, 'status', { status: 'queued', ahead: 0, family: 'claude' });
  runner.live.delete(a);
  const plan = runner._unstartedPlan(a);
  assert.equal(plan, null, 'the steer-only input after the last real status is not a pending prompt');
  runner.shutdown();
});

// ---- HTTP route ----

test('POST /agents/:id/input { steerOnly } answers 202 with delivered:false for an idle agent', async () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  adapter.started[0].emit('status', { status: 'idle' });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const post = (body) => fetch(`http://127.0.0.1:${port}/agents/${a}/input`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let res = await post({ text: 'wrap up', steerOnly: true });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true, queued: false, delivered: false, reason: 'idle' });
    assert.equal(runner.live.get(a).inflight, 0, 'still idle');
    adapter.started[0].emit('status', { status: 'running' });
    res = await post({ text: 'wrap up', steerOnly: true });
    assert.deepEqual(await res.json(), { ok: true, queued: false, delivered: true, steer: true });
  } finally { server.close(); server.closeAllConnections?.(); runner.shutdown(); }
});

// ---- default send unchanged ----

test('default send unchanged: an idle agent starts a new turn', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  adapter.started[0].emit('status', { status: 'idle' });
  const r = runner.send(a, 'next');
  assert.deepEqual(r, { queued: false });
  assert.equal(runner.live.get(a).inflight, 1, 'a fresh turn took its slot');
  assert.equal(adapter.started[0].sends.at(-1).text, 'next');
  assert.equal(adapter.started[0].sends.at(-1).opts, undefined, 'no steerOnly flag reaches the adapter');
  assert.equal(inputs(runner, a).at(-1).steerOnly, undefined);
  runner.shutdown();
});

test('default send unchanged: a queued agent coalesces, a running one steers', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'a' });
  const b = mk(runner, { prompt: 'b' });
  assert.equal(runner.send(b, 'more').queued, true);
  assert.equal(runner.queue.find((j) => j.id === b).text, 'b\n\nmore', 'coalesced into the queued job');
  runner.send(a, 'steer');
  assert.equal(adapter.started[0].sends.at(-1).text, 'steer');
  assert.equal(runner.live.get(a).inflight, 1);
  runner.shutdown();
});

test('default send unchanged: a parked agent resumes', () => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  adapter.started[0].emit('session', { sessionId: 'sess-1' });
  adapter.started[0].emit('status', { status: 'idle' });
  runner.park(a);
  runner.send(a, 'back');
  assert.equal(adapter.started.length, 2, 'a new process resumed the session');
  assert.equal(adapter.started[1].sends.at(-1).text, 'back');
  runner.shutdown();
});

// ---- idea-214 (1): the VS server's own input route forwards steerOnly end to end (route -> RunnerBackend -> runner) ----

async function bootRoute() {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), hooks: false, buildPrefix: async () => '' });
  const post = async (id, body) => {
    const out = {};
    await handleRunnerApi({ url: `/__vibesquad/runner/agents/${id}/input`, method: 'POST', headers: {} }, {}, {
      readBody: async () => body, sendJson: (_r, code, json) => Object.assign(out, { code, json }), backend, caller: { kind: 'owner' },
    });
    return out;
  };
  return { adapter, runner, post, close: () => { server.close(); server.closeAllConnections?.(); runner.shutdown(); } };
}

test('server input route: { steerOnly } to an idle agent is dropped end to end (no turn, no input) and says so', async () => {
  const t = await bootRoute();
  try {
    const a = mk(t.runner, { prompt: 'work' });
    t.adapter.started[0].emit('status', { status: 'idle' });
    const before = t.adapter.started[0].sends.length;
    const r = await t.post(a, { text: 'wrap up', steerOnly: true });
    assert.deepEqual(r, { code: 200, json: { ok: true, delivered: false, reason: 'idle' } });
    assert.equal(t.runner.live.get(a).inflight, 0, 'still idle: the route never started a turn');
    assert.equal(t.adapter.started[0].sends.length, before, 'nothing reached the adapter');
    assert.deepEqual(inputs(t.runner, a).map((e) => e.text), ['work'], 'no input logged');
  } finally { t.close(); }
});

test('server input route: { steerOnly } to a running agent joins its turn (delivered, logged steer-only)', async () => {
  const t = await bootRoute();
  try {
    const a = mk(t.runner, { prompt: 'work' });
    const r = await t.post(a, { text: 'wrap up', steerOnly: true, activeTurnBehavior: 'interrupt' });
    assert.deepEqual(r, { code: 200, json: { ok: true, delivered: true } });
    assert.equal(t.adapter.started[0].sends.at(-1).text, 'wrap up');
    assert.equal(t.adapter.started[0].sends.at(-1).opts.steerOnly, true);
    assert.equal(inputs(t.runner, a).at(-1).steerOnly, true);
    assert.equal(t.runner.live.get(a).inflight, 1, 'one turn, never interrupted');
  } finally { t.close(); }
});

test('server input route: a plain send is unchanged (wakes an idle agent, answers { ok })', async () => {
  const t = await bootRoute();
  try {
    const a = mk(t.runner, { prompt: 'work' });
    t.adapter.started[0].emit('status', { status: 'idle' });
    const r = await t.post(a, { text: 'next' });
    assert.deepEqual(r, { code: 200, json: { ok: true } });
    assert.equal(t.runner.live.get(a).inflight, 1, 'a fresh turn');
    assert.equal(inputs(t.runner, a).at(-1).steerOnly, undefined);
  } finally { t.close(); }
});

// ---- idea-214 (3): a dropped steer is not part of the fresh-session recap ----

test('ACP: a steer dropped at prompt end names its input, and the fresh-session primer skips it', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  runner.send(a, 'wrap up', { steerOnly: true });
  spawnImpl.finishPrompt();
  await settle();
  const steerIn = inputs(runner, a).find((e) => e.text === 'wrap up');
  const [drop] = runner.timeline(a).filter((e) => e.type === 'steer_dropped');
  assert.equal(drop.input, steerIn.seq, 'the drop names the input it drops');
  runner.store.append(a, 'input', { text: 'resume trigger' }); // the prompt a resume would send right after the primer
  const primer = runner._primer(a);
  assert.match(primer, /User: one/);
  assert.doesNotMatch(primer, /wrap up/, 'the dropped steer never reached the agent');
  runner.shutdown();
});

test('ACP: a steer that rode along with a real prompt stays in the primer', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  runner.send(a, 'wrap up', { steerOnly: true });
  runner.send(a, 'two');
  spawnImpl.finishPrompt();
  await settle();
  spawnImpl.finishPrompt();
  await settle();
  runner.store.append(a, 'input', { text: 'resume trigger' });
  const primer = runner._primer(a);
  assert.match(primer, /User: wrap up/);
  assert.match(primer, /User: two/);
  runner.shutdown();
});

test('ACP: cancel drops a queued steer with a logged steer_dropped (reason cancelled), so the primer skips it too', async () => {
  const spawnImpl = fakeAcpSpawn();
  const runner = acpRunner(spawnImpl);
  const a = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'one' });
  await settle();
  runner.send(a, 'wrap up', { steerOnly: true });
  runner.cancel(a);
  await settle();
  const drops = runner.timeline(a).filter((e) => e.type === 'steer_dropped');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, 'cancelled');
  assert.equal(drops[0].input, inputs(runner, a).find((e) => e.text === 'wrap up').seq);
  runner.store.append(a, 'input', { text: 'resume trigger' });
  assert.doesNotMatch(runner._primer(a), /wrap up/);
  runner.shutdown();
});

test('runner-side drop (adapter refuses the steer) names its input; the primer skips it, earlier joined steers stay', () => {
  const started = [];
  const adapter = {
    canPark: true,
    start({ emit }) {
      const rec = { emit, sends: [], refuse: false };
      started.push(rec);
      return { send(text, opts) { if (opts?.steerOnly && rec.refuse) return false; rec.sends.push({ text, opts }); emit('status', { status: 'running' }); return true; }, cancel() {}, kill() {} };
    },
  };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, parkGraceMs: 60_000 });
  const a = mk(runner, { prompt: 'work' });
  assert.equal(runner.send(a, 'joined steer', { steerOnly: true }).delivered, true);
  started[0].refuse = true;
  assert.deepEqual(runner.send(a, 'refused steer', { steerOnly: true }), { queued: false, delivered: false, reason: 'turn-ending' });
  const refused = inputs(runner, a).find((e) => e.text === 'refused steer');
  assert.equal(runner.timeline(a).find((e) => e.type === 'steer_dropped').input, refused.seq);
  runner.store.append(a, 'input', { text: 'resume trigger' });
  const primer = runner._primer(a);
  assert.match(primer, /User: joined steer/);
  assert.doesNotMatch(primer, /refused steer/);
  runner.shutdown();
});

test('droppedSteerSeqs: logs from before the input field resolve by position (turn-ended = oldest pending, runner-side = newest)', () => {
  const ev = (seq, type, extra = {}) => ({ seq, type, ...extra });
  // ACP turn-end drop of two queued steers, after a real input; an earlier steer rode along with that real input.
  const acp = [
    ev(0, 'input', { text: 'one' }), ev(1, 'input', { text: 's0', steerOnly: true }), ev(2, 'input', { text: 'two' }),
    ev(3, 'input', { text: 's1', steerOnly: true }), ev(4, 'input', { text: 's2', steerOnly: true }),
    ev(5, 'steer_dropped', { reason: 'turn-ended' }), ev(6, 'steer_dropped', { reason: 'turn-ended' }),
  ];
  assert.deepEqual([...droppedSteerSeqs(acp)].sort(), [3, 4], 's0 rode along with "two"; s1 and s2 dropped');
  // claude: a joined steer, then a refused one right after its own input.
  const claude = [ev(0, 'input', { text: 'w' }), ev(1, 'input', { text: 'j', steerOnly: true }), ev(2, 'input', { text: 'r', steerOnly: true }), ev(3, 'steer_dropped', { reason: 'turn-ending' })];
  assert.deepEqual([...droppedSteerSeqs(claude)], [2]);
  // New logs name the input exactly; a drop with nothing pending is ignored.
  assert.deepEqual([...droppedSteerSeqs([ev(0, 'input', { text: 'x', steerOnly: true }), ev(1, 'steer_dropped', { reason: 'turn-ended', input: 0 }), ev(2, 'steer_dropped', { reason: 'turn-ended' })])], [0]);
});
