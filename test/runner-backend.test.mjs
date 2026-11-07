import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { killTree } from '../runner/spawn.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend, SPAWN_TIMING, toTimeline } from '../server/backend/runner-backend.mjs';
import { RoutingBackend, runnerLanes } from '../server/backend/lane-routing.mjs';
import { getBackend, PaseoBackend } from '../server/backend/index.mjs';

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
  assert.deepEqual(Object.keys(parts), ['requireRunning', 'hookHost', 'hook', 'prefix', 'post', 'fetch', 'whos']);
  assert.ok(parts.hook >= 15, `hook=${parts.hook}ms should reflect the slow before() hook`);
  assert.ok(parts.post >= 30, `post=${parts.post}ms should reflect the slow POST /agents`);
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

test('getBackend with no switched lane returns the plain PaseoBackend (default = paseo)', () => {
  const c = fakePaseoClient('p');
  const b = getBackend(c, { lanes: () => new Set() });
  assert.ok(b instanceof PaseoBackend);
  assert.equal(getBackend(null), null);
  assert.equal(getBackend(b), b);
});

test('every lane defaults to the runner; teams.json backend:"paseo" / VS_PASEO_LANES pin a lane to Paseo', () => {
  const file = path.join(tmp(), 'teams.json');
  writeFileSync(file, JSON.stringify({ teams: [{ id: 't', lanes: [{ id: 'Alpha', aliases: ['al'], backend: 'runner' }, { id: 'beta' }, { id: 'Legacy', aliases: ['lg'], backend: 'paseo' }] }] }));
  const set = runnerLanes({ env: { VS_RUNNER_LANES: ' Gamma , delta', VS_PASEO_LANES: 'pinned' }, teamsFile: file });
  assert.deepEqual([...set].sort(), ['al', 'alpha', 'delta', 'gamma']); // explicit runner lanes stay iterable
  assert.equal(set.defaultRunner, true);
  for (const lane of ['alpha', 'beta', 'unlisted', '', 'gamma']) assert.equal(set.has(lane), true, `lane "${lane}" -> runner`);
  for (const lane of ['legacy', 'lg', 'pinned']) assert.equal(set.has(lane), false, `lane "${lane}" -> paseo`);
  assert.deepEqual([...set.paseoLanes].sort(), ['legacy', 'lg', 'pinned']);
  const none = runnerLanes({ env: {}, teamsFile: path.join(tmp(), 'missing.json') });
  assert.ok(none.size >= 1, 'size is always truthy so callers treat the runner as on');
  assert.equal(none.has('anything'), true);
  const legacy = runnerLanes({ env: { VS_DEFAULT_BACKEND: 'paseo', VS_RUNNER_LANES: 'only' }, teamsFile: path.join(tmp(), 'missing.json') });
  assert.equal(legacy.has('only'), true);
  assert.equal(legacy.has('other'), false, 'VS_DEFAULT_BACKEND=paseo is the global rollback');
  assert.equal(runnerLanes({ env: { VS_DEFAULT_BACKEND: 'paseo' }, teamsFile: path.join(tmp(), 'missing.json') }).size, 0);
});

test('default lanes create on the runner, Paseo ids still reach Paseo, and a dead daemon is not connected to', async () => {
  const c = fakePaseoClient('p');
  const r = fakeRunnerBackend();
  const lanes = () => runnerLanes({ env: {}, teamsFile: path.join(tmp(), 'missing.json') });
  const dead = new RoutingBackend(new PaseoBackend(c), r, { lanes, paseoAlive: async () => false });
  assert.equal((await dead.createAgent({ labels: { lane: 'never-configured' }, config: {} })).id, 'rn-aaa');
  assert.equal((await dead.createAgent({ labels: {}, config: {} })).id, 'rn-aaa');
  assert.equal(c.calls.some((x) => x[0] === 'createAgent'), false);
  await dead.connect();
  assert.equal(c.calls.filter((x) => x[0] === 'connect').length, 0, 'dead Paseo: connect is skipped (no 5s timeout)');
  const alive = new RoutingBackend(new PaseoBackend(c), r, { lanes, paseoAlive: async () => true });
  await alive.connect();
  assert.equal(c.calls.filter((x) => x[0] === 'connect').length, 1);
  await alive.sendAgentPrompt('11111111-uuid', 'yo');
  assert.equal(c.calls.filter((x) => x[0] === 'sendAgentPrompt').length, 1);
});

test('routing: create goes by lane, per-id calls go to the owner, lists merge, no cross-talk', async () => {
  const c = fakePaseoClient('p');
  const r = fakeRunnerBackend();
  const b = getBackend(c, { lanes: () => new Set(['own']), runner: r });
  assert.ok(b instanceof RoutingBackend);

  assert.equal((await b.createAgent({ labels: { lane: 'own' }, config: {} })).id, 'rn-aaa');
  assert.equal((await b.createAgent({ labels: {}, env: { VS_LANE: 'OWN' }, config: {} })).id, 'rn-aaa');
  assert.equal((await b.createAgent({ labels: { lane: 'other' }, config: {} })).id, 'p-uuid');
  assert.equal(r.calls.filter((x) => x[0] === 'createAgent').length, 2);
  assert.equal(c.calls.filter((x) => x[0] === 'createAgent').length, 1);

  await b.sendAgentPrompt('rn-aaa', 'hi');
  await b.sendAgentPrompt('11111111-uuid', 'yo');
  assert.deepEqual(r.calls.filter((x) => x[0] === 'sendAgentPrompt'), [['sendAgentPrompt', 'rn-aaa', 'hi']]);
  assert.deepEqual(c.calls.filter((x) => x[0] === 'sendAgentPrompt'), [['sendAgentPrompt', '11111111-uuid', 'yo']]);
  await b.cancelAgent('rn-aaa');
  assert.equal(c.calls.some((x) => x[0] === 'cancelAgent'), false);

  const merged = await b.fetchAgents();
  assert.deepEqual(merged.entries.map((e) => e.agent.id), ['p-1', 'rn-aaa']);
  // paseo-only methods stay paseo; absent methods stay undefined (typeof guards)
  assert.equal(typeof b.connect, 'function');
  assert.equal(b.listAgents, undefined);
});

test('routing: a Paseo id for a method the raw client lacks is a silent no-op, like the typeof guard it replaces', async () => {
  const c = fakePaseoClient('p');
  delete c.sendAgentPrompt;
  const r = fakeRunnerBackend();
  const b = getBackend(c, { lanes: () => new Set(['own']), runner: r });
  assert.equal(await b.sendAgentPrompt('11111111-uuid', 'x'), undefined);
  assert.equal(r.calls.length, 0);
  await b.sendAgentPrompt('rn-aaa', 'x');
  assert.equal(r.calls.length, 1);
});

test('routing: a dead runner never breaks Paseo lists', async () => {
  const c = fakePaseoClient('p');
  const r = { fetchAgents: () => Promise.reject(new Error('down')) };
  const b = getBackend(c, { lanes: () => new Set(['own']), runner: r });
  assert.deepEqual((await b.fetchAgents()).entries.map((e) => e.agent.id), ['p-1']);
});

test('lead-handoff list path (listDaemonAgents) sees runner leads when a lane is switched, and pages do not repeat them', async () => {
  const { listDaemonAgents } = await import('../server/detach-children.mjs');
  const pages = [];
  const c = {
    fetchAgents: async (o) => {
      pages.push(o.page?.cursor ?? null);
      return o.page?.cursor
        ? { entries: [{ agent: { id: 'p-2' } }], pageInfo: { hasMore: false } }
        : { entries: [{ agent: { id: 'p-1' } }], pageInfo: { hasMore: true, nextCursor: 'c1' } };
    },
  };
  const runnerLead = { id: 'rn-lead', labels: { role: 'lead', lane: 'own' } };
  const r = { fetchAgents: async () => ({ entries: [{ agent: runnerLead }] }) };
  const routed = getBackend(c, { lanes: () => new Set(['own']), runner: r });
  const got = await listDaemonAgents(routed);
  assert.deepEqual(got.map((a) => a.id), ['p-1', 'rn-lead', 'p-2']);
  assert.deepEqual(pages, [null, 'c1']);
  // Paseo-only: no switched lane -> plain PaseoBackend, list is exactly Paseo's
  const plain = await listDaemonAgents(getBackend(c, { lanes: () => new Set() }));
  assert.deepEqual(plain.map((a) => a.id), ['p-1', 'p-2']);
});

test('runtime sync and desktop build ship runner/ (RUNNER_ENTRY)', () => {
  const entryList = /\["dist", "public", "server", "cli", "plugin", "runner"\]/;
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
  const run = (url) => handleRunnerApi({ url, method: 'GET' }, {}, { readBody: async () => ({}), sendJson: () => {}, backend, lanes: () => new Set(['x']) });
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

test('a Paseo-bound call after a dead-daemon connect rejects with PASEO_UNAVAILABLE instead of looking connected', async () => {
  const c = fakePaseoClient('p');
  const r = fakeRunnerBackend();
  const lanes = () => new Set(['own']); // 'pinned' is not a runner lane here
  const b = new RoutingBackend(new PaseoBackend(c), r, { lanes, paseoAlive: async () => false });
  await b.connect();
  assert.equal(b.paseoUnavailable, true);
  await assert.rejects(b.createAgent({ labels: { lane: 'pinned' }, config: {} }), { code: 'PASEO_UNAVAILABLE' });
  await assert.rejects(b.cancelAgent('11111111-uuid'), { code: 'PASEO_UNAVAILABLE' });
  assert.equal((await b.createAgent({ labels: { lane: 'own' }, config: {} })).id, 'rn-aaa');
  assert.equal((await b.cancelAgent('rn-aaa'), true), true);
  // Lists: runner agents plus a paseoUnavailable marker, whether or not Paseo is wanted (never a rejection).
  const list = await b.fetchAgents({});
  assert.deepEqual(list.entries.map((e) => e.agent.id), ['rn-aaa']);
  assert.equal(list.paseoUnavailable, true);
});

test('createPaseoProbe: custom options never touch the shared probe, reset() discards an in-flight result', async () => {
  const { createPaseoProbe, paseoDaemonAlive, resetPaseoProbe } = await import('../server/backend/lane-routing.mjs');
  let release;
  const gate = new Promise((ok) => (release = ok));
  const probe = createPaseoProbe({ check: async () => { await gate; return true; } });
  const first = probe();
  probe.reset();
  release();
  assert.equal(await first, true);
  let calls = 0;
  const again = createPaseoProbe({ check: async () => { calls += 1; return false; } });
  assert.equal(await again(), false);
  assert.equal(calls, 1);
  assert.equal(await createPaseoProbe({ check: async () => true })(), true);
  resetPaseoProbe();
  assert.equal(await paseoDaemonAlive({ check: async () => true }), true, 'custom options use their own instance');
});

test('runner status tells the browser the default is the runner; a UI spawn on an unlisted or empty lane hits the runner', async () => {
  const { handleRunnerApi, runnerStatus } = await import('../server/runner-api.mjs');
  const laneSet = runnerLanes({ env: {}, teamsFile: path.join(tmp(), 'missing.json') });
  const st = await runnerStatus(laneSet, { alive: async () => false, expected: () => false });
  assert.equal(st.enabled, true);
  assert.equal(st.defaultBackend, 'runner');
  assert.deepEqual(st.paseoLanes, []);
  assert.deepEqual(st.paseo, { expected: false, reachable: false });
  const pinned = await runnerStatus(runnerLanes({ env: { VS_PASEO_LANES: 'Old' }, teamsFile: path.join(tmp(), 'missing.json') }), { alive: async () => true, expected: () => true });
  assert.deepEqual(pinned.paseoLanes, ['old']);
  assert.equal(pinned.paseo.reachable, true);

  const spawned = [];
  const backend = { createAgent: async (req) => { spawned.push(req); return { id: 'rn-ui1' }; } };
  const run = async (body, lanes = laneSet) => {
    const out = {};
    await handleRunnerApi({ url: '/__vibesquad/runner/spawn', method: 'POST', on() {} }, {}, { readBody: async () => body, sendJson: (_r, code, json) => Object.assign(out, { code, json }), backend, lanes: () => lanes });
    return out;
  };
  assert.equal((await run({ labels: { lane: 'never-listed' }, config: {} })).code, 201);
  assert.equal((await run({ labels: {}, config: {} })).code, 201, 'a create with no lane is a runner create too');
  const pinnedSet = runnerLanes({ env: { VS_PASEO_LANES: 'old' }, teamsFile: path.join(tmp(), 'missing.json') });
  assert.equal((await run({ labels: { lane: 'old' }, config: {} }, pinnedSet)).code, 400, 'a Paseo-pinned lane is not a runner create');
  assert.equal(spawned.length, 2);
});
