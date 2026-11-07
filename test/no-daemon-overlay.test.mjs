import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { decideOverlay, statusDot, pillText } = await import('../src/daemonOverlay.ts');

test('only a down runner stream shows anything, and it is a pill (never a blocking scrim)', () => {
  assert.equal(decideOverlay({ runnerConn: 'up' }), 'none');
  assert.equal(decideOverlay({ runnerConn: 'unknown' }), 'none');
  assert.equal(decideOverlay({ runnerConn: 'down' }), 'pill');
});

test('pill text names the runner', () => {
  assert.match(pillText({ runnerConn: 'down' }), /Runner disconnected/);
});

test('header dot follows the runner stream', () => {
  assert.deepEqual(statusDot({ runnerConn: 'up' }), { conn: 'connected', title: 'runner: connected' });
  assert.deepEqual(statusDot({ runnerConn: 'down' }), { conn: 'disconnected', title: 'runner: disconnected' });
  assert.deepEqual(statusDot({ runnerConn: 'unknown' }), { conn: 'connecting', title: 'runner: connecting' });
});

test('the banner renders a clickable pill to Diagnostics; no unlock form, scrim or Paseo retry remains', () => {
  const src = readFileSync(new URL('../src/DiagnosticsModal.tsx', import.meta.url), 'utf8');
  assert.match(src, /decideOverlay\(/);
  assert.match(src, /data-testid="daemon-status-pill"[^>]*onClick=\{props\.onOpenDiagnostics\}/);
  assert.match(src, /<RunnerConnectionSection \/>/);
  assert.doesNotMatch(src, /diagnostics-unlock-form|daemon-banner-password-input|daemon-disconnect-scrim|diagnostics-paseo-retry|reconnectWithDaemonPassword/);
});

test('a /status change notifies listeners (so usePaseo subscribers re-render); an identical probe does not', async () => {
  const { fetchRunnerStatus, onRunnerStatusChange } = await import('../src/runnerBridge.ts');
  let n = 0;
  onRunnerStatusChange(() => n++);
  const real = globalThis.fetch;
  const serve = (body) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body }); };
  try {
    serve({ enabled: false });
    await fetchRunnerStatus();
    assert.equal(n, 1);
    await fetchRunnerStatus();
    assert.equal(n, 1);
    serve({ enabled: true });
    await fetchRunnerStatus();
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = real;
  }
  const src = readFileSync(new URL('../src/paseo.ts', import.meta.url), 'utf8');
  assert.match(src, /onRunnerStatusChange\(\(\) => set\(\{\}\)\)/);
});

test('the store has no Paseo websocket state', () => {
  const src = readFileSync(new URL('../src/paseo.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /paseoConn|authFailureReason|daemonClient|@getpaseo/);
});
