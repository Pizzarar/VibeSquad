// idea-1195: a parked agent whose worktree was swept must be refused with "worktree removed: <path>" before any spawn:
// no adapter start (so no ENOENT), the agent stays parked/recoverable, and no provider-fault cap or binary-missing reading.
import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { providerFaultOf } from '../server/backend/runner-backend.mjs';

const dirs = [];
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-cwdrm-')); dirs.push(d); return d; };

test('send to a parked agent whose cwd is gone: clear refusal, no spawn, stays parked, no provider fault', () => {
  const starts = [];
  const adapter = { canPark: true, start: (o) => { starts.push(o); throw new Error('spawn must not be attempted'); } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter } });
  const cwd = tmp();
  const id = 'rn-aaaaaaaaaaaa';
  runner.store.append(id, 'created', { provider: 'claude', model: null, cwd, meta: {} });
  runner.store.append(id, 'parked', { sessionId: 'sess-1', systemPrompt: null });
  runner.store.append(id, 'status', { status: 'parked' });
  rmSync(cwd, { recursive: true, force: true }); // the worktree sweep
  try { runner.send(id, 'resume please'); } catch { /* a refusal may throw or log; both are fine */ }
  assert.equal(starts.length, 0, 'adapter.start never called');
  const tl = runner.timeline(id);
  const err = tl.find((e) => e.type === 'error');
  assert.ok(err, 'error logged');
  assert.equal(err.message, `worktree removed: ${cwd}`);
  assert.ok(!tl.some((e) => e.type === 'exit'), 'agent not closed');
  assert.equal(runner.status(id).status, 'parked');
  assert.equal(providerFaultOf({ type: 'error', message: err.message }, { cwd }), null, 'not a provider/binary fault');
  assert.equal(providerFaultOf({ type: 'exit', error: err.message }, { cwd }), null);
});

test('_start refuses a missing cwd before registering a live entry', () => {
  const adapter = { start: () => { throw new Error('spawn must not be attempted'); } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter } });
  const cwd = path.join(tmp(), 'gone');
  assert.throws(() => runner._start('rn-bbbbbbbbbbbb', { provider: 'claude', cwd, meta: {} }), new RegExp(`^Error: worktree removed: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.equal(runner.live.size, 0);
});

// idea-1198: the cwd check runs before _makeRoom / 'starting', so a doomed start never parks another agent for its slot.
test('at maxLive, a queued create with a missing cwd does not park the idle live agent', () => {
  const started = [];
  const adapter = { canPark: true, start: (o) => { started.push(o); return { send() {}, cancel() {}, kill() {} }; } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, maxLive: 1, parkGraceMs: 60_000 });
  const a = runner.create({ provider: 'claude', cwd: tmp() });
  assert.equal(runner.live.size, 1);
  const gone = tmp();
  let job; runner._admit = (j) => { job = j; }; // hold the create in the queue, then sweep its worktree before its turn
  const b = runner.create({ provider: 'claude', cwd: gone });
  rmSync(gone, { recursive: true, force: true });
  try { job.run(); } catch (err) { runner._failJob(job, err); }
  assert.ok(runner.live.has(a), 'idle agent still live (not parked for a doomed create)');
  assert.equal(started.length, 1, 'only the first agent started');
  assert.ok(!runner.timeline(a).some((e) => e.type === 'parked'), 'no park logged for the idle agent');
  assert.equal(runner.timeline(b).find((e) => e.type === 'error')?.message, `worktree removed: ${gone}`);
});

test('at maxLive, a resume with a missing cwd does not park the idle live agent or log starting', () => {
  const adapter = { canPark: true, start: () => ({ send() {}, cancel() {}, kill() {} }) };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, maxLive: 1, parkGraceMs: 60_000 });
  const a = runner.create({ provider: 'claude', cwd: tmp() });
  const cwd = tmp();
  const p = 'rn-cccccccccccc';
  runner.store.append(p, 'created', { provider: 'claude', model: null, cwd, meta: {} });
  runner.store.append(p, 'parked', { sessionId: 'sess-2', systemPrompt: null });
  runner.store.append(p, 'status', { status: 'parked' });
  rmSync(cwd, { recursive: true, force: true });
  assert.throws(() => runner._resume(p), /worktree removed/);
  assert.ok(runner.live.has(a), 'idle agent still live');
  assert.ok(!runner.timeline(p).some((e) => e.type === 'status' && e.status === 'starting'), 'no starting status');
});

test('a send queued while live (job.spec null) whose worktree is swept after parking leaves the agent parked, not closed', () => {
  const adapter = { canPark: true, start: () => { throw new Error('spawn must not be attempted'); } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter } });
  const cwd = tmp();
  const id = 'rn-dddddddddddd';
  runner.store.append(id, 'created', { provider: 'claude', model: null, cwd, meta: {} });
  runner.store.append(id, 'parked', { sessionId: 'sess-3', systemPrompt: null });
  runner.store.append(id, 'status', { status: 'parked' });
  rmSync(cwd, { recursive: true, force: true });
  const job = { id, spec: null, kind: 'send', text: 'hi', images: [], family: 'claude', needsTurn: true };
  try { runner._deliverJob(job); } catch (err) { runner._failJob(job, err); }
  const tl = runner.timeline(id);
  assert.ok(!tl.some((e) => e.type === 'exit'), 'agent not closed');
  assert.equal(runner.status(id).status, 'parked');
  assert.equal(tl.find((e) => e.type === 'error')?.message, `worktree removed: ${cwd}`);
  assert.equal(providerFaultOf({ type: 'error', message: `worktree removed: ${cwd}` }, { cwd }), null, 'no provider fault');
});
