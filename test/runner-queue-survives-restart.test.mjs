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

// Two agents: `busy` holds the only slot, `q` is queued behind it; then the runner "restarts" (shutdown, new Runner).
function queuedAgent(meta = {}, extra = {}) {
  const dir = tmp();
  const r1 = boot(dir, fakeSpawn());
  r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'busy' });
  const q = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'waiting', meta, ...extra });
  return { dir, r1, q };
}

test('R1#1 a retired role (former-lead/former-brainstorm in meta) is not revived', async () => {
  const { dir, r1, q } = queuedAgent({ role: 'lead', lane: 'bug', team: 't' });
  await tick();
  r1.updateMeta(q, { role: 'former-lead' }); // what retirePredecessors / confirmTakeover write; never archives
  r1.shutdown();
  const r2 = boot(dir, fakeSpawn());
  assert.deepEqual(r2.recoverQueued(), []);
  const { dir: d2, r1: o1, q: q2 } = queuedAgent({ role: 'brainstorm' });
  await tick();
  o1.updateMeta(q2, { labels: { role: 'former-brainstorm' } });
  o1.shutdown();
  assert.deepEqual(boot(d2, fakeSpawn()).recoverQueued(), []);
  r2.shutdown();
});

test('R1#1 a superseded lead (newer live lead in the same team/lane) is not revived; a lone lead is', async () => {
  const { dir, r1, q } = queuedAgent({ role: 'lead', lane: 'bug', team: 't' });
  await tick();
  await tick(5);
  r1.create({ provider: 'claude', cwd: process.cwd(), meta: { role: 'lead', lane: 'bug', team: 't' } }); // the successor, no prompt
  r1.shutdown();
  const r2 = boot(dir, fakeSpawn());
  assert.deepEqual(r2.recoverQueued(), []);
  const lone = queuedAgent({ role: 'lead', lane: 'other', team: 't' });
  await tick();
  lone.r1.shutdown();
  const r3 = boot(lone.dir, fakeSpawn());
  assert.deepEqual(r3.recoverQueued(), [lone.q]);
  r2.shutdown();
  r3.shutdown();
  void q;
});

test('R1#1 a stale queued input (older than the bound) is not replayed', async () => {
  const { dir, r1, q } = queuedAgent();
  await tick();
  r1.shutdown();
  await tick(30);
  assert.deepEqual(boot(dir, fakeSpawn(), { queueMaxAgeMs: 10 }).recoverQueued(), []);
  const fresh = boot(dir, fakeSpawn(), { queueMaxAgeMs: 60_000 });
  assert.deepEqual(fresh.recoverQueued(), [q]);
  fresh.shutdown();
});

test('R1#2 send to a still-queued create coalesces: the prompt runs once, one process', async () => {
  const dir = tmp();
  const s = fakeSpawn();
  const r = boot(dir, s);
  r.create({ provider: 'claude', cwd: process.cwd(), prompt: 'busy' });
  const q = r.create({ provider: 'claude', cwd: process.cwd(), prompt: 'first' });
  r.send(q, 'second', { owner: true }); // owner: would have run immediately over the cap as a second job
  await tick();
  assert.equal(r.queue.filter((j) => j.id === q).length <= 1, true);
  const ran = s.calls.filter((c) => c.child.texts.length);
  assert.equal(ran.length, 2); // busy + the single merged q process
  assert.deepEqual(ran[1].child.texts, ['first\n\nsecond']);
  r.shutdown();
});

test('R1#3 send to an agent with a prior session carries the pre-restart queued input', async () => {
  const dir = tmp();
  const s1 = fakeSpawn();
  const r1 = boot(dir, s1, { turnCaps: { claude: 2 } });
  const q = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'turn1' });
  await tick();
  s1.calls[0].child.finish();
  await tick();
  r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'b1' });
  r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'b2' }); // both slots busy
  await tick();
  r1.send(q, 'queued-before-restart'); // q is parked with a session; its send is queued over the cap
  assert.equal(r1.queuePosition(q).queued, true);
  r1.shutdown();
  const s2 = fakeSpawn();
  const r2 = boot(dir, s2, { turnCaps: { claude: 2 } });
  r2.send(q, 'after-restart'); // before recoverQueued: must not drop the earlier input
  await tick();
  const texts = s2.calls.flatMap((c) => c.child.texts).join('|');
  assert.match(texts, /queued-before-restart/);
  assert.match(texts, /after-restart/);
  assert.equal(r2.recoverQueued().includes(q), false);
  r2.shutdown();
});

test('R1#4 owner inputs take free slots before older non-owner ones on boot', async () => {
  const dir = tmp();
  const r1 = boot(dir, fakeSpawn());
  r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'busy' });
  const old = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'old non-owner' });
  const own = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'new owner' });
  r1.store.append(own, 'input', { text: 'owner nudge', owner: true }); // a human line logged while it waited (as send() logs it)
  await tick();
  r1.shutdown();
  const s2 = fakeSpawn();
  const r2 = boot(dir, s2);
  r2.recoverQueued();
  await tick();
  assert.equal(s2.calls.length, 1); // one free slot
  assert.match(s2.calls[0].child.texts.join('|'), /new owner\n\nowner nudge/); // went to the owner input, not the older one
  assert.equal(r2.status(old).status, 'queued');
  r2.shutdown();
});

test('R2 successor exited / retired / archived before boot: the old queued lead is still superseded', async () => {
  for (const fate of ['exit', 'former-lead', 'archive']) {
    const { dir, r1, q } = queuedAgent({ role: 'lead', lane: 'bug', team: 't' });
    await tick();
    await tick(5);
    const succ = r1.create({ provider: 'claude', cwd: process.cwd(), meta: { role: 'lead', lane: 'bug', team: 't' } });
    r1.shutdown(); // logs exit for the live successor
    const r2 = boot(dir, fakeSpawn());
    if (fate === 'former-lead') r2.updateMeta(succ, { role: 'former-lead' });
    if (fate === 'archive') r2.archive(succ);
    assert.ok(r2.status(succ), fate);
    assert.deepEqual(r2.recoverQueued(), [], fate);
    r2.shutdown();
    void q;
  }
});

test('R2 a Buddy is superseded only by a newer Buddy with the same topic; role is read from labels.role too', async () => {
  const { dir, r1, q } = queuedAgent({ role: 'brainstorm', lane: 'bug', team: 't', labels: { topic: 'a' } });
  await tick();
  await tick(5);
  r1.create({ provider: 'claude', cwd: process.cwd(), meta: { role: 'brainstorm', lane: 'bug', team: 't', labels: { topic: 'b' } } });
  r1.shutdown();
  const r2 = boot(dir, fakeSpawn());
  assert.deepEqual(r2.recoverQueued(), [q]); // different topic: not a successor
  r2.shutdown();
  const lab = queuedAgent({ labels: { role: 'lead' }, lane: 'bug', team: 't' });
  await tick();
  await tick(5);
  lab.r1.create({ provider: 'claude', cwd: process.cwd(), meta: { labels: { role: 'lead' }, lane: 'bug', team: 't' } });
  lab.r1.shutdown();
  assert.deepEqual(boot(lab.dir, fakeSpawn()).recoverQueued(), []);
});

test('R2 send to a superseded agent names the successor; send to a stale one does not smuggle the old input', async () => {
  const { dir, r1, q } = queuedAgent({ role: 'lead', lane: 'bug', team: 't' });
  await tick();
  await tick(5);
  const succ = r1.create({ provider: 'claude', cwd: process.cwd(), meta: { role: 'lead', lane: 'bug', team: 't' } });
  r1.shutdown();
  const r2 = boot(dir, fakeSpawn());
  assert.throws(() => r2.send(q, 'hello'), (e) => e.message.includes(`superseded by ${succ}`) && !/retired/.test(e.message));
  r2.shutdown();
  const st = queuedAgent();
  await tick();
  st.r1.shutdown();
  await tick(30);
  const r3 = boot(st.dir, fakeSpawn(), { queueMaxAgeMs: 10 });
  assert.throws(() => r3.send(st.q, 'late'), /not running/); // stale input is not revived by a send either
  r3.shutdown();
});

test('boot recovery parses each log once (fold warm, no second read) and still recovers the queued ones', async () => {
  const dir = tmp();
  const s1 = fakeSpawn();
  const r1 = boot(dir, s1);
  const a = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'first' });
  const b = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'second' });
  const c = r1.create({ provider: 'claude', cwd: process.cwd(), prompt: 'third' });
  await tick();
  r1.shutdown();

  const r2 = boot(dir, fakeSpawn());
  const reads = new Map();
  const count = (id, n) => reads.set(id, (reads.get(id) ?? 0) + n);
  const { read, readFrom } = r2.store;
  r2.store.read = (id, ...rest) => { count(id, 1); return read.call(r2.store, id, ...rest); };
  r2.store.readFrom = (id, ...rest) => { count(id, 1); return readFrom.call(r2.store, id, ...rest); };
  const back = r2.recoverQueued();
  assert.deepEqual(back.sort(), [b, c].sort());
  const nonQueued = reads.get(a); // (queued logs also get read by the jobs they start, so only non-queued ones are counted)
  assert.equal(nonQueued, 1, 'a non-queued log is parsed exactly once at boot');
  assert.ok(r2.folds.has(a), 'folds stay warm');
  await tick();
  r2.shutdown();
  await tick();
});
