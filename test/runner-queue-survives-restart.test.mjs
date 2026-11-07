// A queued (turn-cap) input survives a runner restart: the queue is in memory, so boot re-enqueues agents whose log ends
// in `queued` with an unstarted input; it runs once, and a send to such an agent is never "not running"/lost.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-qrestart-')); dirs.push(d); return d; };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function fakeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.finish = () => child.push({ type: 'result', subtype: 'success' });
    child.texts = [];
    child.stdin.on('data', (b) => { for (const l of String(b).split('\n').filter(Boolean)) { try { const m = JSON.parse(l); if (m.type === 'user') child.texts.push(typeof m.message?.content === 'string' ? m.message.content : m.message?.content?.map((c) => c.text).join('')); } catch { /* not json */ } } });
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: `sess-${calls.length}`, model: 'm' }));
    calls.push({ file, args, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}
const boot = (dir, spawnImpl, opts = {}) => new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl, mcp: false }) }, maxLive: 16, parkGraceMs: 60_000, turnCaps: { claude: 1 }, ...opts });
const events = (dir, id) => readFileSync(path.join(dir, `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a queued create is re-enqueued on boot, runs once, in original order', async () => {
  const dir = tmp();
  const s1 = fakeSpawn();
  const r1 = boot(dir, s1);
  const a = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'first' }); // runs, holds the only slot
  const b = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'second' }); // queued
  const c = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'third' }); // queued
  await tick();
  assert.equal(r1.queuePosition(b).queued, true);
  assert.equal(r1.status(b).queued.ahead, 0);
  r1.shutdown(); // runner restart: memory queue gone, log says queued
  assert.equal(events(dir, b).at(-1).status, 'queued');
  assert.ok(!events(dir, b).some((e) => e.type === 'exit'));

  const s2 = fakeSpawn();
  const r2 = boot(dir, s2);
  const back = r2.recoverQueued();
  assert.deepEqual(back.sort(), [b, c].sort()); // a was running (exit logged by shutdown), not queued
  assert.notEqual(r2.status(b).status, 'lost'); // 'lost' maps to closed -> "retired" in the roster
  assert.equal(r2.status(c).status, 'queued'); // the slot went to the oldest input, the next stays queued behind it
  assert.equal(r2.status(c).queued.ahead, 0);
  assert.equal(s2.calls.length, 1); // cap 1: only the oldest input starts
  await tick();
  assert.deepEqual(s2.calls[0].child.texts, ['second']);
  s2.calls[0].child.finish();
  await tick(80);
  assert.equal(s2.calls.length, 2);
  assert.deepEqual(s2.calls[1].child.texts, ['third']);

  // a second restart never replays an input that already started
  r2.shutdown();
  const s3 = fakeSpawn();
  const r3 = boot(dir, s3);
  const again = r3.recoverQueued();
  assert.ok(!again.includes(b));
  assert.equal(events(dir, b).filter((e) => e.type === 'input').length, 1);
  assert.equal(r3.recoverQueued().length, 0); // and idempotent within a boot
  r3.shutdown();
  void a;
});

test('send to a queued-then-lost agent works (not "not running"), and coalesces into its recovered job', async () => {
  const dir = tmp();
  const r1 = boot(dir, fakeSpawn());
  r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'busy' });
  const q = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'waiting' });
  await tick();
  r1.shutdown();
  const s2 = fakeSpawn();
  const r2 = boot(dir, s2, { turnCaps: { claude: 1 } });
  // before recovery: no memory queue, but send must still accept it
  const pos = r2.send(q, 'extra', { owner: true });
  assert.ok(pos.queued === false || pos.queued === true);
  await tick();
  assert.equal(r2.recoverQueued().includes(q), false); // already started by the send: nothing left to replay
  assert.equal(s2.calls.length, 1);
  assert.match(s2.calls[0].child.texts.join('|'), /waiting/);
  assert.match(s2.calls[0].child.texts.join('|'), /extra/);
  assert.equal(r2.status(q).status === 'lost', false);
  r2.shutdown();
});

test('an archived or exited queued agent is not revived', async () => {
  const dir = tmp();
  const r1 = boot(dir, fakeSpawn());
  r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'busy' });
  const q = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'waiting' });
  await tick();
  r1.archive(q);
  r1.shutdown();
  const r2 = boot(dir, fakeSpawn());
  assert.deepEqual(r2.recoverQueued(), []);
  r2.shutdown();
});
