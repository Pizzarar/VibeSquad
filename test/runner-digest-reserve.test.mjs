// idea-203: worker digests are admitted ahead of plain queued turns and may start over their family's turn cap within a
// small reserve (+digestReserve per family), never beyond it. Hermetic: temp log dirs, a controlled in-process adapter.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, OWNER_OVER_CAP, DEFAULT_DIGEST_RESERVE, digestReserveFromEnv, isDigestMeta } from '../runner/runner.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-digestq-')); dirs.push(d); return d; };

// Captures each started agent's emit/onExit (by agent id) so the test drives turn ends synchronously.
function controlledAdapter() {
  const byId = new Map();
  const adapter = {
    canPark: true,
    throwSend: 0, // the next N sends throw synchronously (an adapter whose child stdin is gone)
    start({ id, emit, onExit }) {
      byId.set(id, { emit, onExit });
      return {
        send() {
          if (adapter.throwSend > 0) { adapter.throwSend--; throw new Error('send failed (test)'); }
          emit('status', { status: 'running' });
        },
        cancel() {}, kill() {},
      };
    },
  };
  adapter.idle = (id) => byId.get(id).emit('status', { status: 'idle' });
  adapter.exit = (id) => byId.get(id).onExit({ code: 1 });
  return adapter;
}

const DIGEST_META = (forId = 'rn-worker') => ({ profile: 'Pre-check - Flash', labels: { digestFor: forId } });
const mkRunner = (opts = {}) => {
  const adapter = controlledAdapter();
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, ...opts });
  return { runner, adapter };
};
const plain = (runner, prompt = 'work') => runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt });
const digest = (runner, forId) => runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt: 'digest', meta: DIGEST_META(forId) });
const owner = (runner, id) => runner.send(id, 'owner line', { owner: true });
const queuedIds = (runner) => runner.queue.map((j) => j.id);
const isRunning = (runner, id) => runner.live.get(id)?.inflight > 0;

test('isDigestMeta: needs the digest profile AND labels.digestFor', () => {
  assert.equal(isDigestMeta(DIGEST_META()), true);
  assert.equal(isDigestMeta({ profile: 'Pre-check - Flash', labels: {} }), false, 'profile alone is not a digest');
  assert.equal(isDigestMeta({ profile: 'Implement - Sonnet', labels: { digestFor: 'rn-x' } }), false, 'digestFor alone is not a digest');
  assert.equal(isDigestMeta({ labels: { profile: 'Pre-check - Flash', digestFor: 'rn-x' } }), true, 'profile as a label counts (identityOf)');
  assert.equal(isDigestMeta(undefined), false);
});

test('digestReserveFromEnv: default 1, 0 allowed, junk ignored', () => {
  assert.equal(DEFAULT_DIGEST_RESERVE, 1);
  assert.equal(digestReserveFromEnv({}), 1);
  assert.equal(digestReserveFromEnv({ VS_RUNNER_DIGEST_RESERVE: '0' }), 0);
  assert.equal(digestReserveFromEnv({ VS_RUNNER_DIGEST_RESERVE: '3' }), 3);
  assert.equal(digestReserveFromEnv({ VS_RUNNER_DIGEST_RESERVE: '-1' }), 1);
  assert.equal(digestReserveFromEnv({ VS_RUNNER_DIGEST_RESERVE: 'x' }), 1);
  assert.equal(digestReserveFromEnv({ VS_RUNNER_DIGEST_RESERVE: '' }), 1);
});

test('ordering (reserve 0): a queued digest jumps plain queued turns and starts first when a slot frees', () => {
  const { runner, adapter } = mkRunner({ digestReserve: 0 });
  const a = plain(runner, 'a');
  const b = plain(runner, 'b');
  const c = plain(runner, 'c');
  const d = digest(runner);
  assert.ok(isRunning(runner, a));
  assert.ok(!isRunning(runner, d), 'no reserve: the digest waits for a slot');
  assert.deepEqual(queuedIds(runner), [d, b, c], 'digest sits ahead of the plain backlog');
  assert.deepEqual(runner.queuePosition(d), { queued: true, ahead: 0 });
  adapter.idle(a);
  assert.ok(isRunning(runner, d), 'the freed slot went to the digest');
  assert.deepEqual(queuedIds(runner), [b, c]);
  adapter.idle(d);
  assert.ok(isRunning(runner, b), 'then FIFO resumes');
  runner.shutdown();
});

test('ordering: digests stay FIFO among themselves and behind queued owner jobs', () => {
  const { runner } = mkRunner({ digestReserve: 0 });
  const a = plain(runner, 'a');
  const b = plain(runner, 'b'); // queued plain
  for (let i = 0; i < OWNER_OVER_CAP; i++) owner(runner, plain(runner, `o${i}`)); // spend the owner over-cap budget
  const p = plain(runner, 'p'); // queued plain; becomes an owner job that must wait (budget spent)
  owner(runner, p);
  const d1 = digest(runner, 'rn-w1');
  const d2 = digest(runner, 'rn-w2');
  assert.ok(isRunning(runner, a));
  assert.deepEqual(queuedIds(runner), [p, d1, d2, b]);
  runner.shutdown();
});

test('reserve: over the cap a digest starts at once; a second waits, ahead of plain jobs, until the reserve frees', () => {
  const { runner, adapter } = mkRunner(); // cap 1, reserve 1
  const a = plain(runner, 'a');
  const b = plain(runner, 'b');
  const d1 = digest(runner, 'rn-w1');
  assert.ok(isRunning(runner, d1), 'digest started over the cap from the reserve');
  assert.equal(runner._running('claude'), 2, 'cap 1 + reserve 1');
  assert.equal(runner.overCapDigest.get('claude'), 1);
  const d2 = digest(runner, 'rn-w2');
  assert.ok(!isRunning(runner, d2), 'reserve spent: the second digest queues');
  assert.deepEqual(queuedIds(runner), [d2, b]);
  adapter.idle(d1);
  assert.equal(runner.live.get(d1).digestOverCap, 0, 'the over-cap digest turn released its reserve on idle');
  assert.ok(isRunning(runner, d2), 'the next digest takes the reserve');
  assert.equal(runner.overCapDigest.get('claude'), 1, 'one over-cap digest at a time');
  assert.ok(!isRunning(runner, b), 'the plain job still waits for a real slot (a holds it)');
  adapter.idle(a);
  assert.ok(!isRunning(runner, b), 'running = d2 (1) = cap: still no room for a plain turn');
  adapter.idle(d2);
  assert.ok(isRunning(runner, b));
  assert.equal(runner._running('claude'), 1);
  runner.shutdown();
});

test('reserve: a digest under the cap uses a normal slot and takes no reserve', () => {
  const { runner, adapter } = mkRunner({ turnCaps: { claude: 2 } });
  const d = digest(runner);
  assert.ok(isRunning(runner, d));
  assert.equal(runner.overCapDigest.get('claude') ?? 0, 0);
  adapter.idle(d);
  runner.shutdown();
});

test('reserve: a digest process that exits mid-turn releases its reserve (no leak)', () => {
  const { runner, adapter } = mkRunner();
  plain(runner, 'a');
  const d1 = digest(runner, 'rn-w1');
  assert.equal(runner.overCapDigest.get('claude'), 1);
  adapter.exit(d1);
  assert.equal(runner.overCapDigest.get('claude'), 0);
  const d2 = digest(runner, 'rn-w2');
  assert.ok(isRunning(runner, d2), 'the reserve is free again');
  runner.shutdown();
});

test('reserve: a digest whose send throws synchronously gives its reserve back (the next digest starts)', () => {
  const { runner, adapter } = mkRunner();
  plain(runner, 'a'); // holds the single slot
  adapter.throwSend = 1;
  const d1 = digest(runner, 'rn-w1'); // create -> _noteOverCap (reserve) -> _deliver throws -> _failJob
  assert.ok(!isRunning(runner, d1), 'the failed digest holds no turn');
  assert.equal(runner.overCapDigest.get('claude') ?? 0, 0, 'reserve released on the sync send failure');
  assert.equal(runner.live.get(d1)?.digestOverCap ?? 0, 0);
  const d2 = digest(runner, 'rn-w2');
  assert.ok(isRunning(runner, d2), 'the reserve is free for the next digest');
  assert.equal(runner.overCapDigest.get('claude'), 1);
  runner.shutdown();
});

test('owner over-cap: a send that throws synchronously gives the owner budget back', () => {
  const { runner, adapter } = mkRunner();
  plain(runner, 'a'); // holds the single slot
  const o = plain(runner, 'o'); // queued plain create
  owner(runner, o); // coalesces: starts over the cap as an owner turn
  assert.ok(isRunning(runner, o));
  assert.equal(runner.overCapOwner.get('claude'), 1);
  adapter.idle(o); // releases; o is now a live idle agent
  assert.equal(runner.overCapOwner.get('claude'), 0);
  adapter.throwSend = 1;
  owner(runner, o); // _deliverJob -> _noteOverCap (owner) -> _deliver throws -> _failJob
  assert.ok(!isRunning(runner, o));
  assert.equal(runner.overCapOwner.get('claude') ?? 0, 0, 'owner budget released on the sync send failure');
  assert.equal(runner.live.get(o)?.ownerOverCap ?? 0, 0);
  runner.shutdown();
});

test('reserve: an owner job blocked on its spent budget does not block a digest behind it', () => {
  const { runner, adapter } = mkRunner();
  const a = plain(runner, 'a');
  // Spend the owner over-cap budget.
  const owners = [];
  for (let i = 0; i < OWNER_OVER_CAP; i++) { const o = plain(runner, `o${i}`); owner(runner, o); owners.push(o); }
  for (const o of owners) assert.ok(isRunning(runner, o), 'owner turn started over the cap');
  const o3 = plain(runner, 'o3');
  owner(runner, o3);
  assert.ok(!isRunning(runner, o3), 'owner budget spent: queued');
  const d = digest(runner);
  assert.ok(isRunning(runner, d), 'the digest used its own reserve, not blocked by the owner job ahead of it');
  assert.equal(runner._running('claude'), 1 + OWNER_OVER_CAP + 1);
  adapter.idle(a);
  runner.shutdown();
});

test('reserve: a send to a parked/idle digest keeps the digest priority', () => {
  const { runner, adapter } = mkRunner({ digestReserve: 0 });
  const d = digest(runner);
  adapter.idle(d); // the digest's first turn ends; it stays live (grace) and idle
  const a = plain(runner, 'a'); // takes the only slot
  const b = plain(runner, 'b'); // queued plain
  runner.send(d, 'retry: continue');
  assert.deepEqual(queuedIds(runner), [d, b], 'the digest follow-up queued ahead of the plain job');
  adapter.idle(a);
  assert.ok(isRunning(runner, d));
  runner.shutdown();
});

// A seeded walk over random creates (plain / digest / owner sends) and random turn ends: the family's running turns
// never exceed cap + reserve without owners, never exceed cap + OWNER_OVER_CAP + reserve with them, and the digest
// over-cap count never exceeds the reserve. Every queued job eventually runs once everything drains.
for (const { name, owners, reserve, cap } of [
  { name: 'digests + plain', owners: false, reserve: 1, cap: 3 },
  { name: 'digests + plain + owners', owners: true, reserve: 1, cap: 3 },
  { name: 'reserve 2, cap 1', owners: true, reserve: 2, cap: 1 },
]) {
  test(`cap never exceeded (${name})`, () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const { runner, adapter } = mkRunner({ turnCaps: { claude: cap }, digestReserve: reserve, maxLive: 1000 });
    const limit = cap + reserve + (owners ? OWNER_OVER_CAP : 0);
    const started = new Set();
    const all = [];
    let maxSeen = 0;
    const check = () => {
      const r = runner._running('claude');
      maxSeen = Math.max(maxSeen, r);
      assert.ok(r <= limit, `running ${r} > limit ${limit}`);
      assert.ok((runner.overCapDigest.get('claude') ?? 0) <= reserve, 'digest over-cap within the reserve');
      assert.ok((runner.overCapOwner.get('claude') ?? 0) <= OWNER_OVER_CAP);
      for (const [id, e] of runner.live) if (e.inflight > 0) started.add(id);
    };
    for (let step = 0; step < 400; step++) {
      const x = rnd();
      if (x < 0.25) all.push(plain(runner, `p${step}`));
      else if (x < 0.45) all.push(digest(runner, `rn-w${step}`));
      else if (owners && x < 0.52) { const id = plain(runner, `o${step}`); all.push(id); owner(runner, id); }
      else {
        const running = [...runner.live.entries()].filter(([, e]) => e.inflight > 0).map(([id]) => id);
        if (running.length) adapter.idle(running[Math.floor(rnd() * running.length)]);
      }
      check();
    }
    for (let guard = 0; guard < 2000; guard++) { // drain
      const running = [...runner.live.entries()].filter(([, e]) => e.inflight > 0).map(([id]) => id);
      if (!running.length) break;
      adapter.idle(running[0]);
      check();
    }
    assert.equal(runner.queue.length, 0, 'everything drained');
    for (const id of all) assert.ok(started.has(id), `${id} ran`);
    assert.ok(maxSeen > cap, 'the walk actually exercised the over-cap budgets');
    runner.shutdown();
  });
}
