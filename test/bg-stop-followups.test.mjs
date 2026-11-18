// idea-230 (follow-ups to idea-228): `vs stop <agent> --background`, heldWork in the restart deferral, the drain ask naming
// the verb, the agent's notice after a bg-stop, and the park re-arm after a permission resolves while idle.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { runAgentVerb, parseArgs } from '../cli/vs.mjs';
import { callTool } from '../server/mcp/tools.mjs';
import { deferralMessage, drainAskText } from '../server/restart-coord.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-bgstopfu-')); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);
const SHELL = { pid: 4242, name: 'bash', cmd: 'bash tools/run_suite.sh > /tmp/suite.out 2>&1' };

function harness() {
  const work = new Map();
  const alive = new Set();
  const treeKills = [];
  const ems = new Map();
  const handles = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      const handle = { pid, sends: [], send(t) { this.sends.push(t); emit('status', { status: 'running' }); }, cancel() {}, kill() {} };
      handles.set(id, handle);
      return handle;
    },
  };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 60_000, parkHoldMaxMs: 3_600_000, bgProbe: async (pid) => work.get(pid) ?? [], pidAlive: (pid) => alive.has(pid), killPid: (pid) => { treeKills.push(pid); alive.delete(pid); } });
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { ems.get(id)('turn_done', {}); ems.get(id)('status', { status: 'idle' }); };
  return { runner, work, alive, ems, handles, create, endTurn };
}

// ---- 1. the verb ----------------------------------------------------------------------------------------------------

test('vs stop <agent> --background: parses, calls backend.stopBackground (not cancelAgent) and reports what was stopped', async () => {
  assert.equal(parseArgs(['rn-x', '--background']).background, true);
  const calls = [];
  const ctx = { identity: { agentId: '', team: 'vibesquad', lane: 'bug-chaser', role: 'lead' }, withBackend: async (_o, fn) => fn({
    cancelAgent: async (id) => void calls.push(['cancel', id]),
    stopBackground: async (id) => { calls.push(['stopBackground', id]); return { stopped: [SHELL] }; },
  }) };
  const r = await runAgentVerb('stop', { _: ['rn-x'], background: true }, ctx);
  assert.deepEqual(r, { id: 'rn-x', stoppedBackground: [SHELL] });
  assert.deepEqual(calls, [['stopBackground', 'rn-x']]);
  assert.deepEqual(await callTool(ctx, 'cancel', { id: 'rn-x' }), { id: 'rn-x', cancelled: true }, 'without --background: still the turn cancel');
  assert.deepEqual(calls[1], ['cancel', 'rn-x']);
});

// ---- 2 + 3. deferral message / ask ---------------------------------------------------------------------------------

const lead = { lane: 'bug-chaser', leadId: 'rn-lead', leadTitle: 'Bug1', heldAgents: ['rn-w'], heldWork: { 'rn-w': [SHELL] } };

test('deferralMessage copies heldWork (pid + command) into the line, and names the stop verb', () => {
  const msg = deferralMessage({ held: 1, heldAgents: ['rn-w'], waitSec: 60, leads: [lead], unresolved: [], heldWork: { 'rn-w': [SHELL] } });
  assert.match(msg, /rn-w \(pid 4242: .*run_suite\.sh/);
  assert.match(msg, /vs stop rn-w --background/);
});

test('drainAskText names the work and vs stop <id> --background; no quotes or backticks that break vs send', () => {
  const ask = drainAskText(lead, 'now');
  assert.match(ask, /vs stop rn-w --background/);
  assert.match(ask, /pid 4242/);
  assert.ok(!/["`]/.test(ask));
});

// ---- 4. notice after a bg-stop --------------------------------------------------------------------------------------

test('after a bg-stop the next input to the (parked) agent leads with a notice; only once', async () => {
  const h = harness();
  const id = h.create();
  h.work.set(h.handles.get(id).pid, [SHELL]); h.alive.add(SHELL.pid);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  await h.runner.stopBackground(id, { by: 'rn-lead' });
  h.work.clear();
  await until(() => h.runner.status(id).status === 'parked');
  h.runner.send(id, 'status?');
  await until(() => h.handles.size && h.runner.live.get(id)?.handle?.sends?.length);
  const first = h.runner.live.get(id).handle.sends[0];
  assert.match(first, /\[VibeSquad runtime\].*stopped/s);
  assert.match(first, /run_suite\.sh/);
  assert.match(first, /status\?$/);
  assert.ok(types(h.runner, id).includes('bg-stop-notice'));
  h.runner.shutdown();
});

test('after a bg-stop of a LIVE (still idle) agent the next send carries the notice, then it is cleared', async () => {
  const h = harness();
  const id = h.create();
  h.work.set(h.handles.get(id).pid, [SHELL]); h.alive.add(SHELL.pid);
  h.endTurn(id);
  await until(() => types(h.runner, id).includes('park-held'));
  await h.runner.stopBackground(id);
  const entry = h.runner.live.get(id);
  if (entry) { // not yet parked
    h.runner.send(id, 'hi');
    assert.match(entry.handle.sends[1], /\[VibeSquad runtime\].*stopped/s);
    h.ems.get(id)('turn_done', {}); h.ems.get(id)('status', { status: 'idle' });
    h.runner.send(id, 'again');
    assert.equal(entry.handle.sends[2], 'again');
  }
  h.runner.shutdown();
});

// ---- 5. _armPark with a pending permission ---------------------------------------------------------------------------

test('a permission that resolves while the agent is idle re-arms the park (the timer skipped it while pending)', async () => {
  const h = harness();
  const id = h.create();
  const em = h.ems.get(id);
  em('permission', { phase: 'request', id: 'p1', toolName: 'Bash' });
  h.endTurn(id);
  await tick(80);
  assert.equal(h.runner.live.has(id), true, 'pending permission: not parked');
  em('permission', { phase: 'response', id: 'p1' });
  await until(() => h.runner.status(id).status === 'parked');
  h.runner.shutdown();
});

// ---- 6. idea-315: --background works mid-turn ----------------------------------------------------------------------------

test('stopBackground works mid-turn: kills the held shells, spares the caller\'s own vs stop shell, never cancels the turn', async () => {
  const h = harness();
  const id = h.create(); // the create prompt's turn is still running
  const SELF = { pid: 4243, name: 'bash', cmd: 'vs stop rn-self --background' };
  h.work.set(h.handles.get(id).pid, [SHELL, SELF]); h.alive.add(SHELL.pid); h.alive.add(SELF.pid);
  assert.equal(h.runner.live.get(id).inflight > 0, true, 'mid-turn');
  let cancelled = false;
  h.handles.get(id).cancel = () => { cancelled = true; };
  const r = await h.runner.stopBackground(id, { by: id });
  assert.deepEqual(r.stopped, [SHELL]);
  assert.equal(h.alive.has(SELF.pid), true, 'own vs stop shell survives');
  assert.equal(h.alive.has(SHELL.pid), false);
  assert.equal(cancelled, false, 'turn not cancelled');
  assert.equal(h.runner.live.get(id).inflight > 0, true, 'turn still open');
  h.runner.shutdown();
});
