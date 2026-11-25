// idea-631 (review H1/H2/L1): the LIVE path. Runner.status() -> RunnerBackend.fetchAgent() -> watch classifyItem must see a held
// worker as waiting-bg, including in the post-turn probe window (before park-held is logged), and drop it once the hold ends.
import "./helpers/clean-env.mjs";
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { classifyItem } from '../server/watch-sets.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const GRACE = 3000;

function harness(t) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-25T12:00:00Z') });
  t.after(() => mock.timers.reset());
  const probes = [];
  const ems = new Map();
  let nextPid = 1000;
  const adapter = { canPark: true, start({ id, emit }) { ems.set(id, emit); return { pid: nextPid++, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; } };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-bgheld-')); dirs.push(dir);
  const runner = new Runner({ dir, adapters: { fake: adapter }, parkGraceMs: GRACE, parkHoldPollMs: 15_000, parkHoldMaxMs: 3_600_000, bgProbe: () => new Promise((resolve) => probes.push({ resolve })), pidAlive: () => true, killPid: () => {} });
  t.after(() => { for (const e of runner.live.values()) clearTimeout(e.parkTimer); });
  const backend = new RunnerBackend({ client: { request: async (_m, p) => runner.status(decodeURIComponent(p.split('/').pop())), stream: () => ({ close() {} }) }, hooks: false });
  const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' });
  ems.get(id)('session', { sessionId: 's1' });
  const tick = async (ms) => { mock.timers.tick(ms); await flush(); };
  return { runner, backend, probes, id, em: (...a) => ems.get(id)(...a), tick };
}

const classify = (agent) => {
  const T = Date.now();
  const o = { status: agent.status, finalText: 'still running, ending turn', activeAt: T - 1000, progressAtMs: T - 1000, bgHeld: agent.bgHeld === true };
  return classifyItem({ kind: 'agent', ref: 'w' }, { createdAt: new Date(T - 3_600_000).toISOString(), stallMin: 20 }, { now: T, startedAt: T - 3_600_000, agents: new Map([['w', o]]), reports: new Map() });
};

test('live path: post-turn probe window, then a held shell, is waiting-bg via fetchAgent; done once the shell ends and the agent parks', async (t) => {
  const h = harness(t);
  h.em('turn_done', {}); h.em('status', { status: 'idle' });
  // H2: before the grace/probe settle (no park-held logged yet) the agent already reads held.
  let a = (await h.backend.fetchAgent(h.id)).agent;
  assert.equal(a.bgHeld, true, 'unprobed post-turn window is held');
  assert.equal(classify(a).phase, 'waiting-bg');

  await h.tick(GRACE); // park check starts a probe
  h.probes[0].resolve([{ pid: 4242, name: 'bash', cmd: 'npm test' }]);
  await h.tick(0);
  assert.ok(h.runner.timeline(h.id).some((e) => e.type === 'park-held'));
  a = (await h.backend.fetchAgent(h.id)).agent;
  assert.equal(a.bgHeld, true, 'held shell');
  assert.equal(classify(a).state, 'waiting');

  // The hold drops (stop --background / shells dead): not held any more.
  Object.assign(h.runner.live.get(h.id), { heldSince: null, heldWork: null, work: [] }); // stop --background: no wake owed
  a = (await h.backend.fetchAgent(h.id)).agent;
  assert.notEqual(a.bgHeld, true, 'hold dropped');
  assert.equal(classify(a).state, 'done');
});

test('live path: a clean probe parks the agent and it reads done, never held', async (t) => {
  const h = harness(t);
  h.em('turn_done', {}); h.em('status', { status: 'idle' });
  await h.tick(GRACE);
  h.probes[0].resolve([]);
  await h.tick(0);
  const a = (await h.backend.fetchAgent(h.id)).agent;
  assert.notEqual(a.bgHeld, true);
  assert.equal(classify(a).state, 'done');
});

test('live path: a running agent is never bgHeld', async (t) => {
  const h = harness(t);
  const a = (await h.backend.fetchAgent(h.id)).agent;
  assert.notEqual(a.bgHeld, true);
});

test('live path (review H1): shells exited after a long hold (held-dead), the wake is still owed: stays held until the wake turn', async (t) => {
  const h = harness(t);
  h.em('turn_done', {}); h.em('status', { status: 'idle' });
  await h.tick(GRACE);
  h.probes[0].resolve([{ pid: 4242, name: 'bash', cmd: 'npm test' }]);
  await h.tick(0);
  assert.equal((await h.backend.fetchAgent(h.id)).agent.bgHeld, true);
  // The next poll's probe sees the shell gone: hold ends, the grace before the wake runs.
  await h.tick(15_000);
  h.probes[1]?.resolve([]);
  await h.tick(0);
  const types = h.runner.timeline(h.id).map((e) => e.type);
  assert.ok(!types.includes('bg-wake'), 'wake not sent yet');
  const a = (await h.backend.fetchAgent(h.id)).agent;
  assert.equal(a.bgHeld, true, 'held until the wake turn starts');
  assert.equal(classify(a).phase, 'waiting-bg');
});

test('live path (review M1): an idle agent with a pending permission is not bgHeld (it reads blocked)', async (t) => {
  const h = harness(t);
  h.em('turn_done', {}); h.em('status', { status: 'idle' });
  assert.equal((await h.backend.fetchAgent(h.id)).agent.bgHeld, true);
  h.runner.live.get(h.id).perms.add('p1');
  assert.notEqual((await h.backend.fetchAgent(h.id)).agent.bgHeld, true);
});

test('live path (review M1): the unprobed window ends when no park check is coming', async (t) => {
  const h = harness(t);
  h.em('turn_done', {}); h.em('status', { status: 'idle' });
  const e = h.runner.live.get(h.id);
  clearTimeout(e.parkTimer); e.parkTimer = null; e.probing = false;
  assert.notEqual((await h.backend.fetchAgent(h.id)).agent.bgHeld, true);
});
