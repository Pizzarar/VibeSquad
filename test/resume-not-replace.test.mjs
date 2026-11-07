// B5: a closed Buddy whose runner status is lost/parked (saved session) resumes in place; the rest are replaced.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { RunnerHttpError } from '../server/backend/runner-client.mjs';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { performBrainstormRestart, resetBrainstormRestartState } from '../server/brainstorm.mjs';

// The brainstorm cases use a mock daemon (Paseo-style); pin lanes to Paseo so the real runner is never started.
process.env.VS_DEFAULT_BACKEND = 'paseo';
delete process.env.VS_BACKEND;

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-resume-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setTimeout(r, 25));

function fakeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.stdin.on('data', () => setImmediate(() => child.push({ type: 'result', subtype: 'success' })));
    const sid = `sess-${calls.length + 1}`;
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: sid, model: 'm' }));
    calls.push({ args, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}
const mkRunner = (dir, spawnImpl) => new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) } });

test('a runner restart makes an idle agent lost; resume() brings it back in place with --resume', async () => {
  const dir = tmp();
  const s1 = fakeSpawn();
  const r1 = mkRunner(dir, s1);
  const id = r1.create({ provider: 'claude', cwd: os.tmpdir(), prompt: 'hello' });
  await tick();
  assert.equal(r1.status(id).status, 'idle');
  // restart: a fresh Runner on the same log dir has no live child
  const s2 = fakeSpawn();
  const r2 = mkRunner(dir, s2);
  assert.equal(r2.status(id).status, 'lost');
  assert.equal(r2.resume(id), true);
  await tick();
  assert.equal(s2.calls.length, 1);
  assert.ok(s2.calls[0].args.includes('--resume') && s2.calls[0].args.includes('sess-1'), s2.calls[0].args.join(' '));
  assert.notEqual(r2.status(id).status, 'lost', 'back in place (starting until its first turn)');
  assert.deepEqual(r2.list(), [id], 'same id, no new agent');
  assert.ok(r2.timeline(id).some((e) => e.type === 'input' && e.text === 'hello'), 'history kept');
});

test('resume() refuses an exited agent, a session-less one, and an unknown id', async () => {
  const dir = tmp();
  const r1 = mkRunner(dir, fakeSpawn());
  const exited = r1.create({ provider: 'claude', cwd: os.tmpdir() });
  await tick();
  r1.shutdown(); // logs exit
  const noSession = 'rn-nosession';
  r1.store.append(noSession, 'created', { provider: 'claude', model: null, cwd: os.tmpdir(), meta: {} });
  r1.store.append(noSession, 'status', { status: 'running' });
  const s2 = fakeSpawn();
  const r2 = mkRunner(dir, s2);
  assert.equal(r2.resume(exited), false);
  assert.equal(r2.resume(noSession), false);
  assert.equal(r2.resume('rn-missing'), false);
  assert.equal(s2.calls.length, 0, 'nothing spawned');
});

test('resume() keeps the role prompt of a lost agent (--append-system-prompt)', async () => {
  const dir = tmp();
  const r1 = mkRunner(dir, fakeSpawn());
  const id = r1.create({ provider: 'claude', cwd: os.tmpdir(), systemPrompt: 'You are the ADE Buddy.', prompt: 'hi' });
  await tick();
  const s2 = fakeSpawn();
  const r2 = mkRunner(dir, s2);
  assert.equal(r2.resume(id), true);
  await tick();
  const args = s2.calls[0].args;
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'You are the ADE Buddy.');
});

test('an archived agent is never resumed (resume() false, nothing spawned)', async () => {
  const dir = tmp();
  const r1 = mkRunner(dir, fakeSpawn());
  const id = r1.create({ provider: 'claude', cwd: os.tmpdir(), prompt: 'hi' });
  await tick();
  r1.archive(id);
  const s2 = fakeSpawn();
  const r2 = mkRunner(dir, s2);
  assert.equal(r2.resume(id), false);
  assert.equal(s2.calls.length, 0);
});

// RunnerBackend.refreshAgent against a stub client.
const rec = (status, archivedAt = null) => ({ id: 'rn-1', provider: 'claude', cwd: '/x', meta: {}, status, createdAt: 't', updatedAt: 't', archivedAt });
function stubBackend({ resumable, failWith, archived = false }) {
  const calls = [];
  const state = { status: 'lost' };
  const client = {
    request: async (method, route) => {
      calls.push(`${method} ${route}`);
      if (route.endsWith('/resume')) {
        if (failWith) throw failWith;
        if (!resumable) throw new RunnerHttpError(409, 'agent cannot be resumed');
        state.status = 'idle';
        return { ok: true };
      }
      return rec(state.status, archived ? Date.now() : null);
    },
  };
  return { backend: new RunnerBackend({ client }), calls };
}

test('RunnerBackend.refreshAgent: a lost (closed) agent resumes in place', async () => {
  const { backend, calls } = stubBackend({ resumable: true });
  const a = await backend.refreshAgent('rn-1');
  assert.equal(a.id, 'rn-1');
  assert.equal(a.status, 'idle');
  assert.ok(calls.includes('POST /agents/rn-1/resume'));
});

test('RunnerBackend.refreshAgent: a non-resumable agent stays closed (caller replaces it)', async () => {
  const { backend } = stubBackend({ resumable: false });
  assert.equal((await backend.refreshAgent('rn-1')).status, 'closed');
});

test('RunnerBackend.refreshAgent: an archived agent is not resumed', async () => {
  const { backend, calls } = stubBackend({ resumable: true, archived: true });
  await backend.refreshAgent('rn-1');
  assert.ok(!calls.some((c) => c.endsWith('/resume')), calls.join(', '));
});

test('RunnerBackend.refreshAgent: a transient failure (503 cap, runner down) is rethrown, not treated as not-resumable', async () => {
  const { backend } = stubBackend({ failWith: new RunnerHttpError(503, 'AGENT_CAP') });
  await assert.rejects(() => backend.refreshAgent('rn-1'), (e) => e.status === 503);
  const { backend: b2 } = stubBackend({ failWith: new Error('ipc broke') });
  await assert.rejects(() => b2.refreshAgent('rn-1'), /ipc broke/);
});

// Brainstorm level: reopen vs replace. The daemon mock stands in for either backend's refreshAgent.
const bs = (status) => ({ id: 'rn-1', title: 'BRAINSTORM · ADE', status, updatedAt: '2026-11-02T04:00:00Z', labels: { team: 'sq', lane: 'ade', role: 'brainstorm' } });
function daemon({ resumable }) {
  const agents = new Map([['rn-1', bs('closed')]]);
  const d = {
    agents,
    created: 0,
    isConnected: () => true,
    fetchAgents: async () => ({ entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchAgent: async (id) => ({ agent: agents.get(id) ?? null }),
    updateAgent: async (id, { labels }) => { const a = agents.get(id); if (a && labels) a.labels = { ...a.labels, ...labels }; },
    archiveAgent: async (id) => { agents.get(id).archivedAt = 'x'; return { archivedAt: 'x' }; },
    cancelAgent: async () => {},
    detachAgent: async () => {},
    refreshAgent: async (id) => { if (resumable) agents.get(id).status = 'idle'; return agents.get(id); },
    createAgent: async (req) => { d.created++; const id = `rn-new-${d.created}`; agents.set(id, { id, status: 'idle', labels: { ...(req.labels ?? {}) } }); return { id, labels: { ...(req.labels ?? {}) } }; },
  };
  return d;
}
async function withHome(fn) {
  const dir = tmp();
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = path.join(dir, '.vibesquad');
  mkdirSync(process.env.VIBESQUAD_HOME, { recursive: true });
  try { return await fn(dir); } finally { prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev); }
}

test('Spin Up on a resumable closed Buddy reopens it: same id, no new agent', () => withHome(async (dir) => {
  resetBrainstormRestartState();
  const d = daemon({ resumable: true });
  const r = await performBrainstormRestart({ reason: 'start-brainstorm', teamId: 'sq', laneId: 'ade', daemonClient: d }, dir);
  assert.equal(r.reused, true);
  assert.equal(r.reopened, true);
  assert.equal(r.newAgentId, 'rn-1');
  assert.equal(d.created, 0);
  assert.equal(d.agents.get('rn-1').status, 'idle');
}));

test('Spin Up on a non-resumable closed Buddy replaces it (new agent, old retired)', () => withHome(async (dir) => {
  resetBrainstormRestartState();
  const d = daemon({ resumable: false });
  const r = await performBrainstormRestart({ reason: 'start-brainstorm', teamId: 'sq', laneId: 'ade', daemonClient: d }, dir);
  assert.notEqual(r.reused, true);
  assert.equal(d.created, 1);
  assert.notEqual(r.newAgentId, 'rn-1');
}));
