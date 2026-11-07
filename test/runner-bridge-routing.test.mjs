import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

// src/runnerBridge.ts is plain TypeScript with no DOM imports at load: node strips the types. fetch is stubbed per case.
const { fetchRunnerStatus } = await import('../src/runnerBridge.ts');


test('MCP withBackend: an rn- id with the runner down is RUNNER_DOWN and never spawns; with it up the call runs', async () => {
  const { sharedRunnerBackend } = await import('../server/backend/index.mjs');
  const { createContext } = await import('../server/mcp/tools.mjs');
  const runner = sharedRunnerBackend();
  const calls = [];
  const had = Object.getOwnPropertyDescriptor(runner, 'requireRunning');
  let up = false;
  runner.requireRunning = async () => { calls.push('require'); if (!up) { const e = new Error('RUNNER_DOWN: x'); e.code = 'RUNNER_DOWN'; throw e; } };
  runner.startOwned = () => { calls.push('SPAWN'); return Promise.resolve(true); };
  try {
    const ctx = createContext({ env: { ...process.env }, identity: { agentId: 'rn-caller', team: '', lane: '', role: '' } });
    await assert.rejects(ctx.withBackend({ id: 'rn-abc123' }, async () => { calls.push('fn'); }), { code: 'RUNNER_DOWN' });
    up = true;
    const seen = await ctx.withBackend({ id: 'rn-abc123' }, async (b) => { calls.push('fn'); return b === runner; });
    assert.equal(seen, true, 'the shared runner backend is used');
    assert.deepEqual(calls, ['require', 'require', 'fn'], 'only connect checks, never a spawn');
  } finally {
    if (had) Object.defineProperty(runner, 'requireRunning', had);
    else delete runner.requireRunning;
    delete runner.startOwned;
  }
});

test('the browser has no per-lane routing any more: every spawn is a runner spawn', async () => {
  const bridge = await import('../src/runnerBridge.ts');
  assert.equal('isRunnerLane' in bridge, false);
  assert.equal(typeof fetchRunnerStatus, 'function');
});
