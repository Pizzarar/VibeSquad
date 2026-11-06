import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { decideOverlay, usesPaseoBackend, statusDot } = await import('../src/daemonOverlay.ts');

const base = { remote: false, runnerConn: 'up', paseoDown: true, authFailureReason: null, usesPaseo: false };
const runnerOn = { enabled: true, defaultBackend: 'runner', lanes: [], paseoLanes: [] };

test('Paseo down + runner up: no scrim, no notice', () => {
  assert.equal(decideOverlay(base), 'none');
  assert.equal(decideOverlay({ ...base, runnerConn: 'unknown' }), 'none');
});

test('Paseo down + runner down: non-blocking runner notice, never the scrim', () => {
  assert.equal(decideOverlay({ ...base, runnerConn: 'down' }), 'runner-notice');
});

test('Paseo auth failure with no paseo lanes shows nothing blocking', () => {
  const i = { ...base, authFailureReason: 'password_required' };
  assert.equal(usesPaseoBackend(runnerOn, ['rn-1', 'rn-2']), false);
  assert.equal(decideOverlay(i), 'none');
  assert.equal(decideOverlay({ ...i, usesPaseo: true }), 'scrim'); // locked form stays for real Paseo users
});

test('usesPaseoBackend: runner off, pinned lane, expected daemon or a daemon agent', () => {
  assert.equal(usesPaseoBackend({ ...runnerOn, enabled: false }, []), true);
  assert.equal(usesPaseoBackend({ ...runnerOn, paseoLanes: ['old'] }, []), true);
  assert.equal(usesPaseoBackend({ ...runnerOn, paseo: { expected: true, reachable: false } }, []), true);
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

test('the banner is wired to decideOverlay and renders the runner notice text', () => {
  const src = readFileSync(new URL('../src/DiagnosticsModal.tsx', import.meta.url), 'utf8');
  assert.match(src, /decideOverlay\(/);
  assert.match(src, /VS runner disconnected · reconnecting/);
});
