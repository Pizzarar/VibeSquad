// idea-224: a missing/mid-update CLI binary (claude.exe ENOENT at spawn) must fail the run cleanly —
// a clear "binary not found" message and a terminal status, never a stuck 'running' agent.
import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';
import { resolveExecutable, spawnErrorMessage } from '../runner/spawn.mjs';

const dirs = [];
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-binmissing-')); dirs.push(d); return d; };
const tick = () => new Promise((r) => setTimeout(r, 15));

// A fake spawn that returns a child and then emits a spawn `error` (ENOENT) on the next tick,
// mirroring node's behavior when the file vanished between resolve and spawn (a CLI mid-update).
function fakeSpawnEnoent(binPath) {
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => {};
    impl.calls.push({ file, args, opts });
    setTimeout(() => child.emit('error', Object.assign(new Error(`spawn ${binPath} ENOENT`), { code: 'ENOENT', path: binPath })), 5);
    return impl.last = child;
  };
  impl.calls = [];
  return impl;
}

test('resolveExecutable: a missing binary throws a clear "not found" error (not the shell wording)', () => {
  assert.throws(() => resolveExecutable('/nonexistent-dir/claude.exe'), /not found/);
  assert.throws(() => resolveExecutable('vs-definitely-not-a-real-cmd-xyz'), /not found on PATH/);
});

test('spawnErrorMessage: ENOENT reads as "<cmd> binary not found at <path>"; other errors pass through', () => {
  assert.equal(spawnErrorMessage('claude', { code: 'ENOENT', path: 'C:\\x\\claude.exe' }), 'claude binary not found at C:\\x\\claude.exe');
  assert.equal(spawnErrorMessage('claude', { message: 'EACCES: permission denied' }), 'EACCES: permission denied');
  assert.equal(spawnErrorMessage('claude', undefined), 'undefined');
});

test('claude: resolve-time missing binary ends the run cleanly (exited, clear message, slot released)', async () => {
  const missing = path.join(tmp(), 'no-such-claude.exe');
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ command: missing, mcp: false }) }, maxLive: 1 });
  const id = runner.create({ provider: 'claude', cwd: '.', prompt: 'hi' });
  await tick(); await tick();
  assert.equal(runner.status(id).status, 'exited');
  assert.equal(runner.live.size, 0, 'live slot released');
  const tl = runner.timeline(id);
  const exit = tl.find((e) => e.type === 'exit');
  assert.ok(exit, 'exit event logged');
  assert.match(exit.error, /not found/);
  assert.match(exit.error, /no-such-claude\.exe/);
  assert.throws(() => runner.send(id, 'retry'), /not running/);
  // A second run on the SAME runner (maxLive: 1) must start, not queue: the failed agent did not wedge its only live slot.
  const id2 = runner.create({ provider: 'claude', cwd: '.', prompt: 'hi' });
  await tick(); await tick();
  assert.equal(runner.status(id2).status, 'exited');
  assert.equal(runner.live.size, 0, 'live slot released after the second run');
  const exit2 = runner.timeline(id2).find((e) => e.type === 'exit');
  assert.ok(exit2, 'exit event logged for the second run');
  assert.match(exit2.error, /not found/);
});

test('claude: spawn-time ENOENT (file vanished after resolve) ends the run with the same clear message', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'claude.exe');
  writeFileSync(bin, ''); // resolvable at resolve time; the fake spawn then reports it vanished
  const env = { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '') };
  const spawnImpl = fakeSpawnEnoent(bin);
  const adapter = createClaudeAdapter({ spawnImpl, command: 'claude', mcp: false });
  let exit = null;
  adapter.start({ id: 'rn-enoent', cwd: '.', env, emit: () => {}, onExit: (info) => { exit = info; } });
  await tick(); await tick();
  assert.ok(exit, 'onExit called');
  assert.equal(exit.code, null);
  assert.equal(exit.error, `claude binary not found at ${bin}`);
  assert.ok(spawnImpl.calls.length === 1, 'spawn was attempted once');
});

test('claude: spawn-time ENOENT at the Runner level ends exited with a "binary not found" message', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'claude.exe');
  writeFileSync(bin, '');
  // resolveExecutable reads the PATH from the child env (agentEnv spreads process.env); point it at the temp dir.
  const prevPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + (process.env.PATH ?? '');
  try {
    const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl: fakeSpawnEnoent(bin), command: 'claude', mcp: false }) } });
    const id = runner.create({ provider: 'claude', cwd: '.', prompt: 'hi' });
    await tick(); await tick(); await tick();
    assert.equal(runner.status(id).status, 'exited');
    assert.equal(runner.live.size, 0, 'live slot released');
    const exit = runner.timeline(id).find((e) => e.type === 'exit');
    assert.ok(exit, 'exit event logged');
    assert.equal(exit.error, `claude binary not found at ${bin}`);
  } finally { process.env.PATH = prevPath; }
});

test('acp: resolve-time missing binary ends the run cleanly', async () => {
  const missing = path.join(tmp(), 'no-such-opencode.exe');
  const runner = new Runner({ dir: tmp(), adapters: { opencode: createAcpAdapter({ provider: 'opencode', command: missing, mcp: false }) } });
  const id = runner.create({ provider: 'opencode', cwd: '.', prompt: 'hi' });
  await tick(); await tick();
  assert.equal(runner.status(id).status, 'exited');
  assert.equal(runner.live.size, 0, 'live slot released');
  const exit = runner.timeline(id).find((e) => e.type === 'exit');
  assert.ok(exit, 'exit event logged');
  assert.match(exit.error, /not found/);
  assert.match(exit.error, /no-such-opencode\.exe/);
});

test('acp: spawn-time ENOENT ends the run with the same clear message', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'opencode.exe');
  writeFileSync(bin, '');
  const env = { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '') };
  const adapter = createAcpAdapter({ spawnImpl: fakeSpawnEnoent(bin), provider: 'opencode', command: 'opencode', mcp: false });
  let exit = null;
  adapter.start({ id: 'rn-acp-enoent', cwd: '.', env, emit: () => {}, onExit: (info) => { exit = info; } });
  await tick(); await tick();
  assert.ok(exit, 'onExit called');
  assert.equal(exit.code, null);
  assert.equal(exit.error, `opencode binary not found at ${bin}`);
});
