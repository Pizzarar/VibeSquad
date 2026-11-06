import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { decideOverlay, usesPaseoBackend, paseoIsDown, showsPaseoDot, statusDot, pillText } = await import('../src/daemonOverlay.ts');

const base = { remote: false, runnerConn: 'up', paseoDown: true, authFailureReason: null, usesPaseo: false };
const runnerOn = { enabled: true, defaultBackend: 'runner', lanes: [], paseoLanes: [] };

test('Paseo down + runner up, Paseo unused: nothing at all', () => {
  assert.equal(decideOverlay(base), 'none');
  assert.equal(decideOverlay({ ...base, runnerConn: 'unknown' }), 'none');
});

test('locally nothing ever returns the scrim', () => {
  for (const runnerConn of ['unknown', 'up', 'down'])
    for (const paseoDown of [true, false])
      for (const authFailureReason of [null, 'password_required', 'incorrect_password'])
        for (const usesPaseo of [true, false])
          assert.notEqual(decideOverlay({ remote: false, runnerConn, paseoDown, authFailureReason, usesPaseo }), 'scrim');
});

test('Paseo down while in use, runner down, or Paseo locked: a header pill', () => {
  assert.equal(decideOverlay({ ...base, usesPaseo: true }), 'pill');
  assert.equal(decideOverlay({ ...base, runnerConn: 'down' }), 'pill');
  assert.equal(decideOverlay({ ...base, authFailureReason: 'password_required', usesPaseo: true }), 'pill');
  assert.equal(decideOverlay({ ...base, authFailureReason: 'password_required' }), 'none'); // auth failure alone, Paseo unused
  assert.equal(decideOverlay({ ...base, paseoDown: false, usesPaseo: true }), 'none');
  assert.equal(usesPaseoBackend(runnerOn, ['rn-1', 'rn-2']), false);
});

test('pill text names the problem', () => {
  assert.equal(pillText({ runnerConn: 'down', authFailureReason: null }), 'Runner disconnected · reconnecting');
  assert.equal(pillText({ runnerConn: 'up', authFailureReason: 'incorrect_password' }), 'Paseo locked · unlock in Diagnostics');
  assert.equal(pillText({ runnerConn: 'up', authFailureReason: null }), 'Paseo disconnected · reconnecting');
});

test('usesPaseoBackend: runner off, pinned lane, expected daemon or a daemon agent', () => {
  assert.equal(usesPaseoBackend({ ...runnerOn, enabled: false }, []), true);
  assert.equal(usesPaseoBackend({ ...runnerOn, paseoLanes: ['old'] }, []), true);
  assert.equal(usesPaseoBackend({ ...runnerOn, defaultBackend: 'paseo' }, []), true);
  // legacy "daemon expected" alone is not use: only the quiet dot shows, nothing that looks Paseo-backed
  const expected = { ...runnerOn, paseo: { expected: true, reachable: false } };
  assert.equal(usesPaseoBackend(expected, []), false);
  assert.equal(showsPaseoDot(expected, []), true);
  assert.equal(showsPaseoDot(runnerOn, []), false);
  assert.notEqual(decideOverlay({ ...base, usesPaseo: usesPaseoBackend(expected, []) }), 'scrim');
  assert.equal(decideOverlay({ ...base, usesPaseo: usesPaseoBackend(expected, []) }), 'none');
  assert.equal(usesPaseoBackend(runnerOn, ['rn-1', 'abc-daemon']), true);
  assert.equal(usesPaseoBackend(null, []), false);
});

test('remote mode keeps the old behaviour: Paseo down blocks, regardless of the runner', () => {
  assert.equal(decideOverlay({ ...base, remote: true }), 'scrim');
  assert.equal(decideOverlay({ ...base, remote: true, runnerConn: 'down' }), 'scrim');
  assert.equal(decideOverlay({ ...base, remote: true, paseoDown: false }), 'none');
});

test('header dot shows Paseo only when in use, else the runner', () => {
  assert.deepEqual(statusDot({ remote: false, usesPaseo: false, paseoConn: 'disconnected', runnerConn: 'up' }), { conn: 'connected', title: 'runner: connected' });
  assert.equal(statusDot({ remote: false, usesPaseo: true, paseoConn: 'disconnected', runnerConn: 'up' }).title, 'daemon: disconnected');
  assert.equal(statusDot({ remote: true, usesPaseo: false, paseoConn: 'connected', runnerConn: 'down' }).conn, 'connected');
});

test('the banner renders a clickable pill to Diagnostics, and Diagnostics keeps the unlock form', () => {
  const src = readFileSync(new URL('../src/DiagnosticsModal.tsx', import.meta.url), 'utf8');
  assert.match(src, /decideOverlay\(/);
  assert.match(src, /data-testid="daemon-status-pill"[^>]*onClick=\{props\.onOpenDiagnostics\}/);
  assert.match(src, /<PaseoConnectionSection \/>/);
  assert.match(src, /data-testid="diagnostics-unlock-form"/);
});

test('a /status change notifies listeners (so usePaseo subscribers re-render); an identical probe does not', async () => {
  const { fetchRunnerStatus, onRunnerStatusChange } = await import('../src/runnerBridge.ts');
  let n = 0;
  onRunnerStatusChange(() => n++);
  const real = globalThis.fetch;
  const serve = (body) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body }); };
  try {
    serve({ enabled: false, lanes: [] });
    await fetchRunnerStatus();
    assert.equal(n, 1);
    await fetchRunnerStatus();
    assert.equal(n, 1);
    serve({ enabled: true, defaultBackend: 'runner', lanes: [], paseoLanes: ['old'] });
    await fetchRunnerStatus();
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = real;
  }
  const src = readFileSync(new URL('../src/paseo.ts', import.meta.url), 'utf8');
  assert.match(src, /onRunnerStatusChange\(\(\) => set\(\{\}\)\)/);
});

test('locally Paseo state is the Paseo socket alone, not the combined runner+Paseo conn; remote keeps the combined conn', () => {
  // runner up makes the combined conn/status "connected" while Paseo is down or locked
  assert.equal(paseoIsDown({ remote: false, conn: 'connected', status: 'connected', paseoConn: false }), true);
  assert.equal(paseoIsDown({ remote: false, conn: 'connected', status: 'connected', paseoConn: true }), false);
  assert.equal(paseoIsDown({ remote: true, conn: 'connected', status: 'connected', paseoConn: false }), false);
  assert.equal(paseoIsDown({ remote: true, conn: 'disconnected', status: 'error', paseoConn: true }), true);
  assert.equal(decideOverlay({ ...base, usesPaseo: true, paseoDown: paseoIsDown({ remote: false, conn: 'connected', status: 'connected', paseoConn: false }) }), 'pill');
  const src = readFileSync(new URL('../src/paseo.ts', import.meta.url), 'utf8');
  assert.match(src, /set\(\{ paseoConn: link\.paseoConn \}\)/);
  const modal = readFileSync(new URL('../src/DiagnosticsModal.tsx', import.meta.url), 'utf8');
  assert.equal((modal.match(/paseoIsDown\(/g) ?? []).length >= 2, true); // banner + PaseoConnectionSection
});
