import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { killTree } from '../runner/spawn.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend, toTimeline } from '../server/backend/runner-backend.mjs';
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

test('lanes come from VS_RUNNER_LANES and teams.json backend:"runner"', () => {
  const file = path.join(tmp(), 'teams.json');
  writeFileSync(file, JSON.stringify({ teams: [{ id: 't', lanes: [{ id: 'Alpha', aliases: ['al'], backend: 'runner' }, { id: 'beta' }] }] }));
  const set = runnerLanes({ env: { VS_RUNNER_LANES: ' Gamma , delta' }, teamsFile: file });
  assert.deepEqual([...set].sort(), ['al', 'alpha', 'delta', 'gamma']);
  assert.equal(runnerLanes({ env: {}, teamsFile: path.join(tmp(), 'missing.json') }).size, 0);
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

test('ensureRunning starts the runner detached, hidden, unref-ed, with stdio in runner.log', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-detach-'));
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.at(-1).unref = true; } }; };
  const rc = new RunnerClient({ home, spawnImpl, startTimeoutMs: 150 });
  await assert.rejects(rc.ensureRunning(), /did not start/);
  const { opts, unref } = calls[0];
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.shell, false);
  assert.equal(opts.stdio[0], 'ignore');
  assert.ok(Number.isInteger(opts.stdio[1]) && opts.stdio[1] === opts.stdio[2]);
  assert.equal(unref, true);
  assert.ok(existsSync(path.join(home, 'runner.log')));
});

test('toTimeline: a thought mid-reply does not split the assistant message', () => {
  const ev = (seq, type, o) => ({ seq, ts: 1000 + seq, type, ...o });
  const e = toTimeline([
    ev(0, 'output', { text: 'Hello ' }), ev(1, 'thought', { text: 'hmm' }), ev(2, 'output', { text: 'world' }),
  ]);
  const said = e.filter((x) => x.item.type === 'assistant_message');
  assert.equal(said.length, 1);
  assert.equal(said[0].item.text, 'Hello world');
  assert.equal(e.filter((x) => x.item.type === 'reasoning').length, 1);
});
