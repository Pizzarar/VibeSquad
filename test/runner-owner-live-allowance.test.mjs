// idea-896 (PLAN_OWNER_LIVE_ALLOWANCE_1125 O1): an owner job may start over maxLive by up to OWNER_OVER_CAP extra live
// processes, machine-wide. Live (11-24): ~10 opencode processes plus held suite slots filled maxLive while owner chats sat at
// "Queued, 0 ahead": OWNER_OVER_CAP only bypassed the per-family turn caps, never the live-process ceiling (_fits -> _makeRoom).
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, OWNER_OVER_CAP } from '../runner/runner.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-ownerlive-')); dirs.push(d); return d; };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const types = (runner, id) => runner.timeline(id).map((e) => e.type);
const SUITE = [{ pid: 9000, name: 'bash', cmd: 'npm test' }];

function harness(opts = {}) {
  const ems = new Map();
  const exits = new Map();
  const kills = [];
  const work = new Map();
  let nextPid = 1000;
  let peak = 0;
  let runner;
  const adapter = {
    canPark: true,
    start({ id, emit, onExit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      exits.set(id, onExit);
      peak = Math.max(peak, runner.live.size); // _start has put this entry in live already
      return {
        pid,
        send() { emit('status', { status: 'running' }); },
        cancel() { emit('turn_done', {}); emit('status', { status: 'idle' }); }, // a cancelled turn ends like the real adapters'
        kill() { kills.push(id); },
      };
    },
  };
  runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 60_000, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe: async (pid) => work.get(pid) ?? [], ...opts });
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)?.('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  // A parked agent to send to: created, its turn ended, parked (with room to spare: call before the busy agents exist).
  const parked = async () => { const id = create(); endTurn(id); if (runner.live.has(id)) runner.park(id); await until(() => runner.status(id).status === 'parked'); return id; };
  const status = (id) => runner.status(id).status;
  return { runner, ems, exits, kills, work, create, endTurn, parked, status, pidOf: (id) => runner.live.get(id)?.handle.pid, peak: () => peak };
}

test('896: an owner send starts with live == maxLive; a non-owner send still queues; nothing busy is evicted', async () => {
  const h = harness({ maxLive: 2 });
  try {
    const c = await h.parked();
    const d = await h.parked();
    const a = h.create();
    const b = h.create(); // a and b mid-turn: live == maxLive, nothing idle
    assert.equal(h.runner.live.size, 2);
    h.kills.length = 0;
    h.runner.send(d, 'worker ping'); // non-owner: still needs room under maxLive
    assert.equal(h.status(d), 'queued');
    h.runner.send(c, 'owner here', { owner: true });
    assert.equal(h.status(c), 'running', 'owner job starts at once over maxLive');
    assert.equal(h.runner.live.size, 3);
    assert.deepEqual(h.kills, [], 'no busy agent was parked for it');
    assert.equal(h.status(a), 'running');
    assert.equal(h.status(b), 'running');
    assert.equal(h.status(d), 'queued', 'the non-owner job is still queued');
  } finally { h.runner.shutdown(); }
});

test('896: live never exceeds maxLive + OWNER_OVER_CAP; the next owner job queues', async () => {
  assert.equal(OWNER_OVER_CAP, 2);
  const h = harness({ maxLive: 2 });
  try {
    const cs = [];
    for (let i = 0; i < OWNER_OVER_CAP + 1; i++) cs.push(await h.parked());
    h.create(); h.create();
    for (const c of cs) h.runner.send(c, 'owner here', { owner: true });
    assert.deepEqual(cs.map(h.status), ['running', 'running', 'queued']);
    assert.equal(h.runner.live.size, 2 + OWNER_OVER_CAP);
    assert.ok(h.peak() <= 2 + OWNER_OVER_CAP, `peak live ${h.peak()}`);
  } finally { h.runner.shutdown(); }
});

// Over-allowance owner turns c1, c2 running, c3 queued behind them. `free(h, c1)` ends c1's hold on the allowance one way;
// c3 must start without any other agent being parked, and live stays within maxLive + OWNER_OVER_CAP.
async function released(free, opts = {}) {
  const h = harness({ maxLive: 2, ...opts });
  try {
    const [c1, c2, c3] = [await h.parked(), await h.parked(), await h.parked()];
    const [a, b] = [h.create(), h.create()];
    for (const c of [c1, c2, c3]) h.runner.send(c, 'owner here', { owner: true });
    assert.equal(h.status(c3), 'queued');
    h.kills.length = 0;
    await free(h, c1);
    await until(() => h.status(c3) === 'running');
    assert.deepEqual(h.kills.filter((k) => k !== c1), [], 'only c1 gave its slot up');
    assert.ok(!h.runner.live.has(c1));
    for (const id of [a, b, c2]) assert.equal(h.status(id), 'running');
    assert.equal(h.runner.live.size, 2 + OWNER_OVER_CAP);
    assert.ok(h.peak() <= 2 + OWNER_OVER_CAP, `peak live ${h.peak()}`);
  } finally { h.runner.shutdown(); }
}

test('896: the allowance is released at turn end (the idle over process is the first room, no grace wait)', () =>
  released(async (h, c1) => { h.endTurn(c1); }));

test('896: the allowance is released when the owner turn is cancelled', () =>
  released(async (h, c1) => { h.runner.cancel(c1); }));

test('896: the allowance is released when the over process crashes', () =>
  released(async (h, c1) => { h.exits.get(c1)({ code: 1, signal: null }); }));

test('896: the allowance is released when the over process is parked (grace park after its turn)', () =>
  released(async (h, c1) => { h.endTurn(c1); await until(() => h.status(c1) === 'parked'); }, { parkGraceMs: 0 }));

test('896: a non-owner job needs live back under maxLive; idle over processes are parked first', async () => {
  const h = harness({ maxLive: 2 });
  try {
    const [c1, c2, d] = [await h.parked(), await h.parked(), await h.parked()];
    const [a] = [h.create(), h.create()];
    h.runner.send(c1, 'owner', { owner: true });
    h.runner.send(c2, 'owner', { owner: true });
    h.runner.send(d, 'worker');
    h.endTurn(c1);
    h.endTurn(c2);
    await tick(80);
    assert.equal(h.status(d), 'queued', 'two idle over processes free live 4 -> 2, still not below maxLive');
    h.endTurn(a);
    await until(() => h.status(d) === 'running');
    assert.equal(h.runner.live.size, 2);
    assert.ok(!h.runner.live.has(c1) && !h.runner.live.has(c2) && !h.runner.live.has(a));
  } finally { h.runner.shutdown(); }
});

test('896: an owner job over both the family turn cap and maxLive takes one mark of each, released once (no double count)', async () => {
  const h = harness({ maxLive: 2, turnCaps: { other: 2 } });
  try {
    const cs = [await h.parked(), await h.parked(), await h.parked()];
    h.create(); h.create(); // family at its turn cap AND live at maxLive
    for (const c of cs) h.runner.send(c, 'owner', { owner: true });
    // Both budgets are OWNER_OVER_CAP; were one start counted twice against either, only one owner job would get in.
    assert.deepEqual(cs.map(h.status), ['running', 'running', 'queued']);
    assert.equal(h.runner.overCapOwner.get('other'), 2);
    assert.equal(h.runner.live.size, 4);
    h.endTurn(cs[0]);
    await until(() => h.status(cs[2]) === 'running');
    assert.equal(h.runner.overCapOwner.get('other'), 2, 'c1 released its mark once, c3 took one');
    assert.equal(h.runner.live.size, 4);
    h.endTurn(cs[1]);
    h.endTurn(cs[2]);
    await tick(30);
    assert.equal(h.runner.overCapOwner.get('other'), 0, 'never negative, never leaked');
    for (const c of cs) assert.equal(h.runner.live.get(c)?.ownerOverCap ?? 0, 0);
  } finally { h.runner.shutdown(); }
});

test('896: within the allowance an owner job never force-parks a held agent; past it the old yield still applies', async () => {
  const h = harness({ maxLive: 1, parkGraceMs: 0, parkHoldYieldMs: 40 });
  try {
    const cs = [await h.parked(), await h.parked(), await h.parked()];
    const held = h.create();
    h.work.set(h.pidOf(held), SUITE);
    h.endTurn(held);
    await until(() => types(h.runner, held).includes('park-held'));
    await tick(80); // past its yield age: a non-owner job would force-park it for room
    h.runner.send(cs[0], 'owner', { owner: true });
    h.runner.send(cs[1], 'owner', { owner: true });
    assert.equal(h.status(cs[0]), 'running');
    assert.equal(h.status(cs[1]), 'running');
    assert.ok(h.runner.live.has(held), 'the held agent keeps its slot');
    assert.ok(!types(h.runner, held).includes('park-forced'));
    h.runner.send(cs[2], 'owner', { owner: true }); // live 3 == maxLive + OWNER_OVER_CAP: only a yield makes room
    await until(() => h.status(cs[2]) === 'running');
    assert.ok(types(h.runner, held).includes('park-forced'));
    assert.ok(h.peak() <= 1 + OWNER_OVER_CAP, `peak live ${h.peak()}`);
  } finally { h.runner.shutdown(); }
});
