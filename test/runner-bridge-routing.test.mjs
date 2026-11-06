import assert from 'node:assert/strict';
import test from 'node:test';

// src/runnerBridge.ts is plain TypeScript with no DOM imports at load: node strips the types. fetch is stubbed per case.
const { fetchRunnerStatus, isRunnerLane } = await import('../src/runnerBridge.ts');

const withStatus = async (status, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => status });
  try {
    await fetchRunnerStatus();
    return fn();
  } finally {
    globalThis.fetch = real;
  }
};

test('browser routing: defaultBackend runner sends every lane (and no lane) to the runner except Paseo-pinned ones', async () => {
  await withStatus({ enabled: true, defaultBackend: 'runner', lanes: [], paseoLanes: ['old'] }, () => {
    for (const lane of ['bug-chaser', 'Whatever', undefined, '']) assert.equal(isRunnerLane(lane), true, `lane ${JSON.stringify(lane)}`);
    assert.equal(isRunnerLane('OLD'), false);
  });
});

test('browser routing: a legacy status (defaultBackend paseo) still honours the explicit lane list only', async () => {
  await withStatus({ enabled: true, defaultBackend: 'paseo', lanes: ['own'] }, () => {
    assert.equal(isRunnerLane('own'), true);
    assert.equal(isRunnerLane('other'), false);
    assert.equal(isRunnerLane(undefined), false);
  });
  await withStatus({ enabled: false, lanes: [] }, () => assert.equal(isRunnerLane('own'), false));
});

test('MCP withBackend: a non-runner id goes through the RoutingBackend and records a dead Paseo instead of waiting on it', async () => {
  const prev = process.env.PASEO_DAEMON;
  process.env.PASEO_DAEMON = '127.0.0.1:9'; // nothing listens here
  try {
    const { resetPaseoProbe, RoutingBackend } = await import('../server/backend/lane-routing.mjs');
    resetPaseoProbe();
    const { createContext } = await import('../server/mcp/tools.mjs');
    const ctx = createContext({ env: { ...process.env, VS_DEFAULT_BACKEND: 'runner' }, identity: { agentId: 'rn-caller', team: '', lane: 'x', role: '' } });
    const seen = await ctx.withBackend({ lane: 'x' }, async (b) => ({ routing: b instanceof RoutingBackend, down: b.paseoUnavailable }));
    assert.deepEqual(seen, { routing: true, down: true });
  } finally {
    if (prev === undefined) delete process.env.PASEO_DAEMON;
    else process.env.PASEO_DAEMON = prev;
  }
});
