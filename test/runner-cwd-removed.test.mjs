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
