import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { killTree } from '../runner/spawn.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend, SPAWN_TIMING, isTurnProgressEvent, scanLogProgress, toTimeline } from '../server/backend/runner-backend.mjs';
import { getBackend } from '../server/backend/index.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-rb-'));
const TOKEN = 'test-token';

// Fake provider: each send() emits status + output + turn_done.
function fakeAdapters() {
  const adapter = {
    start({ emit, systemPrompt, model }) {
      adapter.lastStart = { systemPrompt, model };
      return {
        send(text) {
          emit('status', { status: 'running' });
          emit('output', { text: `echo:${text}` });
          emit('turn_done', {});
          emit('status', { status: 'idle' });
        },
        cancel() {},
        kill() {},
      };
    },
  };
  return { claude: adapter, adapter };
}

async function boot({ token = TOKEN, maxBodyBytes } = {}) {
  const { claude, adapter } = fakeAdapters();
  const runner = new Runner({ dir: tmp(), adapters: { claude } });
  const server = createServer(runner, { token, maxBodyBytes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const home = tmp();
  writeDiscovery(home, { port, token });
  const rc = new RunnerClient({ home });
  const backend = new RunnerBackend({ client: rc, buildPrefix: async (role) => (role ? `PREFIX[${role}]` : '') });
  return {
    runner, server, port, home, rc, backend, adapter,
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

const spawnReq = (lane, over = {}) => ({
  config: { provider: 'claude', model: 'claude-haiku-5-5', cwd: process.cwd(), title: 'T', modeId: 'default' },
  initialPrompt: 'hi',
  labels: { team: 'vibesquad', lane, role: 'worker', ord: '2', profile: 'cheap', 'vs.x': 'y', ...over },
  env: {},
});

test('isTurnProgressEvent: classifies turn-progress vs non-progress events', () => {
  assert.equal(isTurnProgressEvent({ type: 'output' }), true);
  assert.equal(isTurnProgressEvent({ type: 'tool' }), true);
  assert.equal(isTurnProgressEvent({ type: 'usage' }), true);
  assert.equal(isTurnProgressEvent({ type: 'turn_done' }), true);
  assert.equal(isTurnProgressEvent({ type: 'status', status: 'running' }), true);
  assert.equal(isTurnProgressEvent({ type: 'status', status: 'idle' }), true);
  assert.equal(isTurnProgressEvent({ type: 'meta' }), false);
  assert.equal(isTurnProgressEvent({ type: 'stderr' }), false);
  assert.equal(isTurnProgressEvent({ type: 'raw' }), false);
  assert.equal(isTurnProgressEvent({ type: 'limit' }), false);
  assert.equal(isTurnProgressEvent({ type: 'status', status: 'starting' }), false);
  assert.equal(isTurnProgressEvent({ type: 'status', status: 'queued' }), false);
  assert.equal(isTurnProgressEvent({ type: 'status', status: 'parked' }), false);
  assert.equal(isTurnProgressEvent({ type: 'input' }), false);
  assert.equal(isTurnProgressEvent({ type: 'created' }), false);
  assert.equal(isTurnProgressEvent({ type: 'error' }), false);
  assert.equal(isTurnProgressEvent(null), false);
});

test('scanLogProgress: stops at the first prompt and bounds its read to a 64KB tail', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'rn-big.jsonl');
    // A prompt at the very start, then >64KB of output: the prompt is beyond the bounded tail, so it is NOT read back.
    const lines = [JSON.stringify({ seq: 1, ts: 1000, type: 'input', text: 'go' })];
    const pad = 'x'.repeat(1024);
    for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ seq: i + 2, ts: 2000 + i, type: 'output', text: pad }));
    writeFileSync(file, lines.join('\n') + '\n');
    assert.ok(statSync(file).size > 64 * 1024, 'log is larger than the bounded window');
    const res = scanLogProgress(file);
    assert.equal(res.lastPromptAt, null, 'prompt beyond the bounded 64KB window is not read back');
    assert.equal(res.lastProgressAt, 2000 + 199, 'most recent progress is read');
    // A prompt as the LAST event: stop there — no progress after it.
    const file2 = path.join(dir, 'rn-stop.jsonl');
    writeFileSync(file2, JSON.stringify({ seq: 1, ts: 3000, type: 'input', text: 'go' }) + '\n');
    const res2 = scanLogProgress(file2);
    assert.equal(res2.lastPromptAt, 3000);
    assert.equal(res2.lastProgressAt, null, 'no progress after the prompt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('progressFor: skips the scan for running/idle, scans (bounded) only for starting/queued', () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, 'agents'), { recursive: true });
    const file = path.join(dir, 'agents', 'rn-big.jsonl');
    const lines = [JSON.stringify({ seq: 1, ts: 1000, type: 'input', text: 'go' })];
    const pad = 'x'.repeat(1024);
    for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ seq: i + 2, ts: 2000 + i, type: 'output', text: pad }));
    writeFileSync(file, lines.join('\n') + '\n');
    const backend = new RunnerBackend({ client: { home: dir }, hooks: false });
    // running: the status guard returns without scanning (no fields).
    const running = backend.progressFor({ id: 'rn-big', status: 'running', createdAt: 1000, updatedAt: 2199 });
    assert.equal(running.lastPromptAt, undefined, 'running status triggers no scan');
    assert.equal(running.lastProgressAt, undefined);
    // queued: scans, bounded (the prompt beyond the 64KB window stays unset), but reads the most recent progress.
    const queued = backend.progressFor({ id: 'rn-big', status: 'queued', createdAt: 1000, updatedAt: 2199 });
    assert.equal(queued.lastPromptAt, undefined, 'prompt beyond the window is left unset');
    assert.equal(queued.lastProgressAt, 2199);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RunnerBackend: create maps first-class fields, labels, status and timeline into the Paseo shapes', async () => {
  const b = await boot();
  try {
    const agent = await b.backend.createAgent(spawnReq('own'));
    assert.match(agent.id, /^rn-/);
    assert.equal(agent.title, 'T');
    assert.equal(agent.labels.lane, 'own');
    assert.equal(agent.labels.role, 'worker');
    assert.equal(agent.labels.ord, '2');
    assert.equal(agent.labels['vs.x'], 'y');
    assert.equal(agent.labels.backend, 'runner');
    assert.equal(agent.modeId, 'default');
    // first-class on the record, not labels
    const rec = b.runner.status(agent.id);
    assert.deepEqual(
      { lane: rec.meta.lane, role: rec.meta.role, team: rec.meta.team, profile: rec.meta.profile },
      { lane: 'own', role: 'worker', team: 'vibesquad', profile: 'cheap' },
    );
    assert.equal(rec.meta.labels['vs.x'], 'y');
    assert.equal(b.adapter.lastStart.systemPrompt, 'PREFIX[worker]');

    const one = await b.backend.fetchAgent(agent.id);
    assert.equal(one.agent.id, agent.id);
    assert.equal((await b.backend.fetchAgents()).entries[0].agent.id, agent.id);
    assert.equal((await b.backend.listAgents())[0].id, agent.id);
    const tl = await b.backend.fetchAgentTimeline(agent.id, { direction: 'tail', limit: 60 });
    assert.deepEqual(tl.entries.map((e) => [e.item.type, e.item.text]), [['user_message', 'hi'], ['assistant_message', 'echo:hi']]);
    await b.backend.sendAgentPrompt(agent.id, 'again');
    assert.equal((await b.backend.getAgentTimeline(agent.id)).at(-1).item.text, 'echo:again');
    assert.equal((await b.backend.waitForFinish(agent.id, 1000)).status, 'idle');

    await b.backend.updateAgent(agent.id, { name: 'New', labels: { lane: 'other', note: 'n' } });
    const upd = (await b.backend.fetchAgent(agent.id)).agent;
    assert.equal(upd.title, 'New');
    assert.equal(upd.labels.lane, 'other');
    assert.equal(upd.labels.note, 'n');
    await b.backend.archiveAgent(agent.id);
    assert.equal((await b.backend.fetchAgents()).entries.length, 0);
    assert.equal((await b.backend.fetchAgents({ filter: { includeArchived: true } })).entries.length, 1);
  } finally { b.close(); }
});

test('RunnerBackend.createAgent records per-await timing (slow hook + post) under SPAWN_TIMING', async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const client = {
    async requireRunning() {},
    async request(method, route) {
      if (method === 'POST' && route === '/agents') { await delay(40); return { id: 'rn-slow' }; }
      if (method === 'GET' && route === '/agents/rn-slow') return { id: 'rn-slow', provider: 'claude', cwd: '.', status: 'idle', meta: { title: 'T' } };
      throw new Error(`unexpected ${method} ${route}`);
    },
  };
  const backend = new RunnerBackend({
    client,
    buildPrefix: async () => '',
    whosHere: async () => {},
    lanes: () => new Set(),
    hooks: { before: async () => { await delay(20); return undefined; } },
  });
  const agent = await backend.createAgent({ config: { provider: 'claude', cwd: '.' }, labels: {}, env: {} });
  const parts = agent[SPAWN_TIMING];
  assert.ok(parts, 'timing attached to the created agent');
  assert.deepEqual(Object.keys(parts), ['req', 'hh', 'hk', 'pfx', 'post', 'get', 'whos']);
  assert.ok(parts.hk >= 15, `hk=${parts.hk}ms should reflect the slow before() hook`);
  assert.ok(parts.post >= 30, `post=${parts.post}ms should reflect the slow POST /agents`);
});

test('RunnerBackend.createAgent attaches partial timing to a rejecting POST', async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const client = {
    async requireRunning() {},
    async request(method, route) {
      if (method === 'POST' && route === '/agents') { await delay(40); throw new Error('runner down'); }
      throw new Error(`unexpected ${method} ${route}`);
    },
  };
  const backend = new RunnerBackend({
    client,
    buildPrefix: async () => '',
    whosHere: async () => {},
    lanes: () => new Set(),
    hooks: { before: async () => { await delay(20); return undefined; } },
  });
  let caught = null;
  try {
    await backend.createAgent({ config: { provider: 'claude', cwd: '.' }, labels: {}, env: {} });
  } catch (err) { caught = err; }
  assert.ok(caught, 'createAgent should reject');
  const parts = caught[SPAWN_TIMING];
  assert.ok(parts, 'partial timing attached to the thrown error');
  assert.deepEqual(Object.keys(parts), ['req', 'hh', 'hk', 'pfx', 'post']);
  assert.ok(parts.post >= 30, `post=${parts.post}ms should reflect the rejecting POST`);
});

test('toTimeline merges streamed chunks and closes tool calls', () => {
  const ev = (seq, type, o) => ({ seq, ts: 1000 + seq, type, ...o });
  const e = toTimeline([
    ev(0, 'output', { text: 'a' }), ev(1, 'output', { text: 'b' }),
    ev(2, 'tool', { phase: 'call', id: 't', name: 'Bash' }), ev(3, 'tool', { phase: 'result', id: 't', isError: false }),
  ]);
  assert.equal(e[0].item.text, 'ab');
  assert.equal(e[1].item.status, 'completed');
});

test('runner HTTP: every request needs the bearer token', async () => {
  const b = await boot();
  try {
    const url = `http://127.0.0.1:${b.port}/health`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/agents`, { headers: { authorization: 'Bearer ' } })).status, 401);
  } finally { b.close(); }
});

test('runner HTTP: body size cap answers 413', async () => {
  const b = await boot({ maxBodyBytes: 200 });
  try {
    const res = await fetch(`http://127.0.0.1:${b.port}/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', cwd: '.', prompt: 'x'.repeat(500) }),
    });
    assert.equal(res.status, 413);
    assert.equal(b.runner.list().length, 0);
  } finally { b.close(); }
});

test('runner create: rejects flag-like model/permissionMode and a missing cwd', async () => {
  const b = await boot();
  try {
    const base = { provider: 'claude', cwd: process.cwd() };
    assert.throws(() => b.runner.create({ ...base, model: '--dangerously-skip-permissions' }), /invalid model/);
    assert.throws(() => b.runner.create({ ...base, meta: { permissionMode: '-x' } }), /invalid permissionMode/);
    assert.throws(() => b.runner.create({ ...base, cwd: path.join(os.tmpdir(), 'vs-no-such-dir-xyz') }), /cwd does not exist/);
    const file = path.join(tmp(), 'f.txt');
    writeFileSync(file, 'x');
    assert.throws(() => b.runner.create({ ...base, cwd: file }), /not a directory/);
    assert.throws(() => b.runner.create({ provider: 'claude' }), /cwd is required/);
    await assert.rejects(b.backend.createAgent({ ...spawnReq('own'), config: { provider: 'claude', model: '-bad', cwd: process.cwd() } }), /invalid model/);
    assert.equal(b.runner.list().length, 0, 'rejected creates leave no log');
  } finally { b.close(); }
});

test('discovery token file is 0600 on posix', () => {
  const home = tmp();
  writeDiscovery(home, { port: 1, token: 't' });
  if (process.platform !== 'win32') assert.equal(statSync(path.join(home, 'token')).mode & 0o777, 0o600);
  assert.equal(new RunnerClient({ home }).conn, null);
});

test('killTree on win32 runs taskkill /T /F without a shell; elsewhere kills the child', () => {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  assert.ok(killTree({ pid: 42, exitCode: null, kill() { throw new Error('should not'); } }, { platform: 'win32', spawnImpl }));
  assert.deepEqual(calls[0].args, ['/pid', '42', '/T', '/F']);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.equal(calls[0].opts.shell, false);
  let killed = 0;
  killTree({ pid: 1, exitCode: null, kill() { killed++; } }, { platform: 'linux', spawnImpl });
  assert.equal(killed, 1);
  assert.equal(killTree({ pid: 1, exitCode: 0 }, { platform: 'win32', spawnImpl }), false);
});

test('runner shutdown marks live agents exited', async () => {
  const b = await boot();
  try {
    const a = await b.backend.createAgent(spawnReq('own'));
    b.runner.shutdown();
    assert.equal(b.runner.status(a.id).status, 'exited');
    assert.equal(b.runner.status(a.id).exit.reason, 'runner-shutdown');
  } finally { b.close(); }
});

// ---- lane routing -------------------------------------------------------------------------------

function fakePaseoClient(tag) {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };
  return {
    calls,
    connect: rec('connect'),
    close: rec('close'),
    createAgent: rec('createAgent', { id: `${tag}-uuid`, labels: {} }),
    fetchAgent: rec('fetchAgent', (id) => ({ agent: { id } })),
    fetchAgents: rec('fetchAgents', { entries: [{ agent: { id: `${tag}-1` } }] }),
    sendAgentPrompt: rec('sendAgentPrompt'),
    cancelAgent: rec('cancelAgent'),
  };
}

function fakeRunnerBackend() {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(ret); };
  return {
    calls,
    createAgent: rec('createAgent', { id: 'rn-aaa' }),
    fetchAgent: rec('fetchAgent', { agent: { id: 'rn-aaa' } }),
    fetchAgents: rec('fetchAgents', { entries: [{ agent: { id: 'rn-aaa' } }] }),
    sendAgentPrompt: rec('sendAgentPrompt'),
    cancelAgent: rec('cancelAgent'),
  };
}

test('getBackend passes an injected client through and leaves null alone', () => {
  const fake = { listAgents: async () => [] };
  assert.equal(getBackend(fake), fake);
  assert.equal(getBackend(null), null);
  assert.equal(getBackend(undefined), undefined);
});
test('lead-handoff list path (listDaemonAgents) pages through the backend list without repeating entries', async () => {
  const { listDaemonAgents } = await import('../server/detach-children.mjs');
  const pages = [];
  const c = {
    fetchAgents: async (o) => {
      pages.push(o.page?.cursor ?? null);
      return o.page?.cursor
        ? { entries: [{ agent: { id: 'rn-2' } }], pageInfo: { hasMore: false } }
        : { entries: [{ agent: { id: 'rn-1' } }], pageInfo: { hasMore: true, nextCursor: 'c1' } };
    },
  };
  const got = await listDaemonAgents(getBackend(c));
  assert.deepEqual(got.map((a) => a.id), ['rn-1', 'rn-2']);
  assert.deepEqual(pages, [null, 'c1']);
});

test('runtime sync and desktop build ship runner/ (RUNNER_ENTRY)', () => {
  const entryList = /\["dist", "public", "server", "cli", "runner"\]/;
  for (const rel of ['server/sync-runtime.mjs', 'server/build-desktop.mjs']) {
    const src = readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
    assert.match(src, entryList, `${rel} should ship runner/`);
  }
});

test('startOwned starts the runner detached, hidden, unref-ed, with stdio in runner.log', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-detach-'));
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.at(-1).unref = true; } }; };
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 150 });
  await assert.rejects(rc.startOwned(), /did not start/);
  const { opts, unref } = calls[0];
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.shell, false);
  assert.equal(opts.stdio[0], 'ignore');
  assert.ok(Number.isInteger(opts.stdio[1]) && opts.stdio[1] === opts.stdio[2]);
  assert.equal(unref, true);
  assert.ok(existsSync(path.join(home, 'runner.log')));
});

const rev = (seq, type, o) => ({ seq, ts: 1000 + seq, type, ...o });
const rsum = (e) => e.map((x) => `${x.item.type}:${x.item.text ?? ''}`);

test('toTimeline: a thought mid-reply does not split it; rows stay in place with unique, increasing seqStart', () => {
  const e = toTimeline([rev(0, 'input', { text: 'q' }), rev(1, 'output', { text: 'Hello ' }), rev(2, 'thought', { text: 'hmm' }), rev(3, 'output', { text: 'world' })]);
  assert.deepEqual(rsum(e), ['user_message:q', 'assistant_message:Hello world', 'reasoning:hmm']);
  assert.deepEqual([e[1].seqStart, e[1].seqEnd, e[2].seqStart], [1, 3, 2]);
  assert.ok(e.every((x, i) => i === 0 || x.seqStart > e[i - 1].seqStart));
});

test('toTimeline: stderr / raw / meta lines mid-reply do not split it', () => {
  const e = toTimeline([rev(0, 'output', { text: 'A' }), rev(1, 'stderr', { line: 'warn' }), rev(2, 'thought', { text: 't' }), rev(3, 'meta', { patch: {} }), rev(4, 'output', { text: 'B' }), rev(5, 'raw', { line: '?' }), rev(6, 'output', { text: 'C' })]);
  assert.deepEqual(rsum(e), ['assistant_message:ABC', 'reasoning:t']);
});

test('toTimeline: user message, tool call, error and turn_done are the separators', () => {
  for (const sep of [rev(2, 'input', { text: 'q' }), rev(2, 'tool', { phase: 'call', id: 'x', name: 'Bash' }), rev(2, 'error', { message: 'boom' }), rev(2, 'turn_done')]) {
    const e = toTimeline([rev(0, 'output', { text: 'A' }), rev(1, 'thought', { text: 't' }), sep, rev(3, 'output', { text: 'B' })]);
    assert.equal(e.filter((x) => x.item.type === 'assistant_message').length, 2, sep.type);
  }
  // back-to-back turns with no user row: turn_done on the reply itself blocks the tail merge
  const t = toTimeline([rev(0, 'output', { text: 'A' }), rev(1, 'turn_done'), rev(2, 'output', { text: 'B' })]);
  assert.deepEqual(rsum(t), ['assistant_message:A', 'assistant_message:B']);
});

test('RunnerBackend.fetchAgentTimeline: before-cursor paging walks the whole log with no duplicates or gaps', async () => {
  const events = [rev(0, 'input', { text: 'q' }), rev(1, 'output', { text: 'A' }), rev(2, 'thought', { text: 't' }), rev(3, 'output', { text: 'B' }), rev(4, 'tool', { phase: 'call', id: 'x', name: 'Bash' }), rev(5, 'output', { text: 'C' }), rev(6, 'stderr', { line: 'x' }), rev(7, 'input', { text: 'q2' })];
  const b = new RunnerBackend({ client: { request: async () => ({ events }) } });
  const all = (await b.fetchAgentTimeline('rn-x')).entries;
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 10; guard++) {
    const page = await b.fetchAgentTimeline('rn-x', { limit: 2, ...(cursor ? { direction: 'before', cursor } : {}) });
    seen.unshift(...rsum(page.entries));
    if (!page.hasOlder) break;
    cursor = page.startCursor;
  }
  assert.deepEqual(seen, rsum(all));
});

test('runner API: the timeline route forwards direction + cursor to fetchAgentTimeline', async () => {
  const { handleRunnerApi } = await import('../server/runner-api.mjs');
  const calls = [];
  const backend = { fetchAgentTimeline: async (id, opts) => { calls.push(opts); return { entries: [], hasOlder: false }; } };
  const run = (url) => handleRunnerApi({ url, method: 'GET' }, {}, { readBody: async () => ({}), sendJson: () => {}, backend });
  await run('/__vibesquad/runner/agents/rn-abc/timeline?limit=60');
  await run('/__vibesquad/runner/agents/rn-abc/timeline?limit=60&direction=before&cursor=42');
  assert.deepEqual(calls[0], { limit: 60 });
  assert.deepEqual(calls[1], { limit: 60, direction: 'before', cursor: { epoch: 'runner', seq: 42 } });
});

test('fetchAgentTimeline lastSeq advances with absorbed post-thought text while the newest row (a thought) does not', async () => {
  const mk = (n) => [rev(1, 'output', { text: 'Hello ' }), rev(2, 'thought', { text: 'hmm' }), ...Array.from({ length: n }, (_, i) => rev(3 + i, 'output', { text: 'x' }))];
  const seqs = [];
  for (const n of [1, 2, 3]) {
    const b = new RunnerBackend({ client: { request: async () => ({ events: mk(n) }) } });
    const r = await b.fetchAgentTimeline('rn-x', { limit: 1 });
    assert.equal(r.entries.at(-1).item.type, 'reasoning');
    assert.equal(r.entries.at(-1).seqEnd, 2); // the old change signal: stuck
    seqs.push(r.lastSeq);
  }
  assert.deepEqual(seqs, [3, 4, 5]);
});

test('runner status says the runner is on; a UI spawn on any lane (or none) hits the runner', async () => {
  const { handleRunnerApi, runnerStatus } = await import('../server/runner-api.mjs');
  assert.deepEqual(await runnerStatus(), { enabled: true });
  const spawned = [];
  const backend = { createAgent: async (req) => { spawned.push(req); return { id: 'rn-ui1' }; } };
  const run = async (body) => {
    const out = {};
    await handleRunnerApi({ url: '/__vibesquad/runner/spawn', method: 'POST', on() {} }, {}, { readBody: async () => body, sendJson: (_r, code, json) => Object.assign(out, { code, json }), backend });
    return out;
  };
  assert.equal((await run({ labels: { lane: 'never-listed' }, config: {} })).code, 201);
  assert.equal((await run({ labels: {}, config: {} })).code, 201, 'a create with no lane is a runner create too');
  assert.equal(spawned.length, 2);
});
