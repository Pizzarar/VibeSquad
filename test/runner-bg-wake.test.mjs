// idea-112: an agent that ends its turn on background work it started ("I'll pick it up when it finishes") must hear back
// when that work exits, for every provider. Live hits 11-13: rn-4131b28b10ed (claude: the CLI DID open a turn of its own
// when the task finished, but the adapter never said running, so runner + server saw idle -> idle and the final reached
// nobody) and rn-44a6519ff6db (antigravity-cli / ACP: turns are client-initiated, nothing ever starts one). These run the
// REAL adapters against fake CLIs, through the Runner, and fold the log with the server's reduceTurn, which is what wakes
// the lead (turn_ended).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, bgWakeText } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';
import { reduceTurn } from '../server/backend/runner-backend.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-bgwake-')); dirs.push(d); return d; };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);
// What the server makes of the log: turn_started / turn_ended (the lead's wake + digest hang off turn_ended).
const serverTurns = (runner, id) => { const t = {}; return runner.timeline(id).map((e) => reduceTurn(t, e)).filter(Boolean).map((r) => r.kind); };

const PID = 4242;
function fakeSpawn(onStdin) {
  const impl = () => {
    const child = new EventEmitter();
    child.pid = PID;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.written = [];
    child.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { const m = JSON.parse(l); child.written.push(m); onStdin?.(m, child); } });
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    impl.last = child;
    return child;
  };
  return impl;
}
const SHELL = [{ pid: 9000, name: 'bash', cmd: "eval 'node --test test/restart-runtime.test.mjs'" }];
function probe() { const p = async (pid) => (pid === PID && p.on ? SHELL : []); p.on = false; return p; }
const runnerWith = (adapters, bgProbe, opts = {}) => new Runner({ dir: tmp(), adapters, parkGraceMs: 0, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe, ...opts });

// ---- ACP (antigravity-cli): no agent-initiated turn exists, the runtime wakes it ----
function fakeAgy() {
  const prompts = [];
  const spawnImpl = fakeSpawn((m, child) => {
    const reply = (result) => child.push({ jsonrpc: '2.0', id: m.id, result });
    const update = (u) => child.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: u } });
    if (m.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    else if (m.method === 'session/new') reply({ sessionId: 'S1' });
    else if (m.method === 'session/prompt') {
      const text = m.params.prompt.map((p) => p.text).join('');
      prompts.push(text);
      if (prompts.length === 1) { // the first turn backgrounds a long command (agy moves it to a task) and ends on it
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'node --test test/restart-runtime.test.mjs', kind: 'execute' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running the suite; waiting for completion.' } });
      } else update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PASS 55/55' } });
      reply({ stopReason: 'end_turn' });
    }
  });
  return { spawnImpl, prompts };
}

test('acp (antigravity-cli): held background work exits -> the runtime wakes the agent with a real turn; then it parks', async () => {
  const { spawnImpl, prompts } = fakeAgy();
  const bg = probe();
  bg.on = true; // the command is running when the first turn ends
  const runner = runnerWith({ 'antigravity-cli': createAcpAdapter({ spawnImpl, provider: 'antigravity-cli', mcp: false, resolved: { file: '/bin/fake', args: [] } }) }, bg);
  try {
    const id = runner.create({ provider: 'antigravity-cli', cwd: os.tmpdir(), prompt: 'review 1c2d2bf' });
    await until(() => types(runner, id).includes('park-held'));
    await tick(80);
    assert.equal(prompts.length, 1, 'nothing wakes it while the work runs');
    assert.equal(runner.status(id).status, 'idle');
    // the task exits; agy reports the backgrounded call completed (session/update while idle), but starts no turn
    bg.on = false;
    spawnImpl.last.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' } } });
    await until(() => prompts.length === 2);
    assert.equal(prompts[1], bgWakeText(SHELL), 'the wake is a session/prompt naming the work');
    await until(() => runner.status(id).status === 'parked');
    const tl = runner.timeline(id);
    assert.equal(tl.filter((e) => e.type === 'bg-wake').length, 1);
    assert.equal(tl.filter((e) => e.type === 'input').at(-1).origin, 'bg-wake');
    assert.deepEqual(serverTurns(runner, id), ['turn_started', 'turn_ended', 'turn_started', 'turn_ended'], 'the server sees the woken turn end: the lead hears the final');
    assert.equal(tl.filter((e) => e.type === 'output').at(-1).text, 'PASS 55/55');
  } finally { runner.shutdown(); }
});

// ---- claude: the CLI opens its own turn on the task-completion notice; the adapter must report it ----
function fakeClaude() {
  const users = [];
  const spawnImpl = fakeSpawn((m) => { if (m.type === 'user') users.push(m.message.content); });
  const turn = (child, text) => {
    child.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5-5' });
    child.push({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    child.push({ type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 0.1 });
  };
  return { spawnImpl, users, turn };
}
const claudeAdapter = (spawnImpl) => createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir: path.join(tmp(), 'prompts') });

test('claude: the CLI self-starts a turn when the held task exits -> running -> idle reaches the server; no runtime wake on top', async () => {
  const { spawnImpl, users, turn } = fakeClaude();
  const bg = probe();
  const runner = runnerWith({ claude: claudeAdapter(spawnImpl) }, bg);
  try {
    const id = runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt: 'implement idea-217' });
    await until(() => users.length === 1);
    bg.on = true;
    turn(spawnImpl.last, "The test run is still going in the background. I'll pick it up when it finishes.");
    await until(() => types(runner, id).includes('park-held'));
    bg.on = false;
    turn(spawnImpl.last, 'Both items are done and committed as 1c2d2bf. 55/55 pass.'); // the CLI's own turn: no stdin behind it
    await until(() => runner.status(id).status === 'parked');
    assert.equal(users.length, 1, 'no runtime wake written: the CLI already woke itself');
    assert.ok(!types(runner, id).includes('bg-wake'));
    const statuses = runner.timeline(id).filter((e) => e.type === 'status').map((e) => e.status);
    assert.deepEqual(statuses.filter((s) => s === 'running' || s === 'idle'), ['running', 'idle', 'running', 'idle'], 'the self turn reads running');
    assert.deepEqual(serverTurns(runner, id), ['turn_started', 'turn_ended', 'turn_started', 'turn_ended'], 'the server sees the self turn end: the lead hears the final');
  } finally { runner.shutdown(); }
});

test('claude: a CLI that does not wake itself gets the runtime wake (fallback), once', async () => {
  const { spawnImpl, users, turn } = fakeClaude();
  const bg = probe();
  const runner = runnerWith({ claude: claudeAdapter(spawnImpl) }, bg);
  try {
    const id = runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt: 'implement idea-217' });
    await until(() => users.length === 1);
    bg.on = true;
    turn(spawnImpl.last, "I'll pick it up when it finishes.");
    await until(() => types(runner, id).includes('park-held'));
    bg.on = false;
    await until(() => users.length === 2);
    assert.equal(users[1], bgWakeText(SHELL));
    assert.equal(runner.status(id).status, 'running');
    turn(spawnImpl.last, '55/55 pass.');
    await until(() => runner.status(id).status === 'parked');
    assert.equal(users.length, 2);
    assert.equal(types(runner, id).filter((t) => t === 'bg-wake').length, 1);
    assert.deepEqual(serverTurns(runner, id), ['turn_started', 'turn_ended', 'turn_started', 'turn_ended']);
  } finally { runner.shutdown(); }
});

// ---- no wake owed / drain ----
function fakeHarness(opts) {
  const ems = new Map();
  const sends = [];
  const kills = [];
  const work = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) { const pid = nextPid++; ems.set(id, emit); return { pid, send(text) { sends.push({ id, text }); emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(id); } }; },
  };
  const runner = runnerWith({ fake: adapter }, async (pid) => work.get(pid) ?? [], opts);
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  const pidOf = (id) => runner.live.get(id)?.handle.pid;
  return { runner, ems, sends, kills, work, create, endTurn, pidOf };
}

test('no wake when a prompted turn ran after the hold (it already saw the work) or when nothing was held', async () => {
  const h = fakeHarness();
  try {
    const a = h.create();
    h.work.set(h.pidOf(a), SHELL);
    h.endTurn(a);
    await until(() => types(h.runner, a).includes('park-held'));
    h.runner.send(a, 'status?'); // the lead pings it mid-hold
    h.work.delete(h.pidOf(a));
    h.endTurn(a);
    const b = h.create();
    h.endTurn(b); // never held
    await until(() => h.kills.length === 2);
    assert.ok(!types(h.runner, a).includes('bg-wake'));
    assert.ok(!types(h.runner, b).includes('bg-wake'));
    assert.deepEqual(h.sends.map((s) => s.text), ['go', 'status?', 'go']);
  } finally { h.runner.shutdown(); }
});

test('forced park past the max hold kills the work and sends no wake (the work never finished)', async () => {
  const h = fakeHarness({ parkHoldMaxMs: 60 });
  try {
    const id = h.create();
    h.work.set(h.pidOf(id), SHELL);
    h.endTurn(id);
    await until(() => h.kills.length === 1);
    assert.ok(types(h.runner, id).includes('park-forced'));
    assert.ok(!types(h.runner, id).includes('bg-wake'));
    assert.equal(h.sends.length, 1);
  } finally { h.runner.shutdown(); }
});

test('drain: a pre-drain hold still wakes when its work exits, and the woken turn may not start NEW held work', async () => {
  const h = fakeHarness();
  try {
    const id = h.create();
    h.work.set(h.pidOf(id), [{ ...SHELL[0], createdMs: Date.now() - 10_000 }]);
    h.endTurn(id);
    await until(() => types(h.runner, id).includes('park-held'));
    const drain = h.runner.setDrain({ ttlMs: 60_000, reason: 'vs restart' });
    h.work.delete(h.pidOf(id));
    await until(() => h.sends.length === 2);
    assert.equal(h.sends[1].text, bgWakeText(SHELL), 'woken during the drain: it reports before the restart cuts it');
    h.work.set(h.pidOf(id), [{ pid: 9100, name: 'bash', cmd: "eval 'npm test'", createdMs: drain.since + 5 }]); // the woken turn starts new background work
    h.endTurn(id);
    await until(() => h.kills.length === 1);
    assert.equal(types(h.runner, id).filter((t) => t === 'park-drain-refused').length, 1, 'the drain still refuses the new hold');
    assert.equal(types(h.runner, id).filter((t) => t === 'park-held').length, 1);
    assert.equal(h.runner.status(id).status, 'parked');
  } finally { h.runner.shutdown(); }
});
