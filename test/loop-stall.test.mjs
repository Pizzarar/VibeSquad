// unit-loop-stall regressions: coalesced roster reads, per-lane Who's here coalescing, and the EOF tail reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { linesFromEnd, linesFromEndSync, tailLines, tailLinesSync } from '../server/log-tail.mjs';
import { recentLaneLog } from '../server/in-flight.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-loopstall-'));
const deferred = () => {
  let resolve;
  const p = new Promise((r) => (resolve = r));
  return { p, resolve };
};
const rec = (id, lane = 'own') => ({ id, provider: 'claude', cwd: '.', status: 'idle', meta: { title: id, labels: { lane, role: 'worker' } } });

/** A fake RunnerClient: counts GETs, holds each roster GET until released, bumps writeSeq when a write settles (like the real one). */
function fakeClient() {
  const c = {
    writeSeq: 0,
    gets: 0,
    gates: [],
    roster: [rec('rn-a')],
    async requireRunning() {},
    async request(method, route) {
      if (method !== 'GET') {
        try {
          if (method === 'POST' && route === '/agents') c.roster = [...c.roster, rec(`rn-${c.roster.length}`)];
          return { ok: true };
        } finally {
          c.writeSeq++;
        }
      }
      if (route.startsWith('/agents?full=1')) {
        c.gets++;
        const snapshot = c.roster; // what the runner serialises when the GET arrives
        const g = deferred();
        c.gates.push(g);
        await g.p;
        return { agents: snapshot };
      }
      throw new Error(`unexpected ${method} ${route}`);
    },
    release() {
      for (const g of c.gates.splice(0)) g.resolve();
    },
  };
  return c;
}

const backendFor = (client, whosHere = () => {}) =>
  new RunnerBackend({ client, buildPrefix: async () => '', whosHere, lanes: () => new Set(['own']) });

test('concurrent listAgents share one roster GET', async () => {
  const c = fakeClient();
  const b = backendFor(c);
  const all = Promise.all([b.listAgents(), b.listAgents(), b.listAgents()]);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, 1, 'three concurrent readers, one GET');
  c.release();
  const [x, y, z] = await all;
  assert.deepEqual(x.map((a) => a.id), ['rn-a']);
  assert.deepEqual(y.map((a) => a.id), ['rn-a']);
  assert.deepEqual(z.map((a) => a.id), ['rn-a']);
  // Once answered there is no cache: the next read is a fresh GET.
  const next = b.listAgents();
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, 2);
  c.release();
  await next;
});

test('a write between two readers forces a fresh roster GET that sees it', async () => {
  const c = fakeClient();
  const b = backendFor(c);
  const before = b.listAgents();
  await new Promise((r) => setImmediate(r));
  await c.request('POST', '/agents'); // settles: writeSeq bumps while the first read is still in flight
  const after = b.listAgents();
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, 2, 'the post-write reader must not join the pre-write read');
  c.release();
  assert.deepEqual((await before).map((a) => a.id), ['rn-a']);
  assert.deepEqual((await after).map((a) => a.id), ['rn-a', 'rn-1']);
});

test('a client without writeSeq never coalesces', async () => {
  const c = fakeClient();
  delete c.writeSeq;
  const b = backendFor(c);
  const all = Promise.all([b.listAgents(), b.listAgents()]);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, 2);
  c.release();
  await all;
});

test("refreshLaneWhosHere: a burst in one lane costs one run plus one shared rerun; lanes are independent", async () => {
  const c = fakeClient();
  const calls = [];
  const b = backendFor(c, ({ laneId, agents }) => calls.push([laneId, agents.length]));
  const first = b.refreshLaneWhosHere('own');
  await new Promise((r) => setImmediate(r));
  // Arrive while the first refresh is reading the roster: all share one queued rerun that starts after it.
  await c.request('POST', '/agents');
  const burst = [b.refreshLaneWhosHere('own'), b.refreshLaneWhosHere('own'), b.refreshLaneWhosHere('own')];
  assert.equal(burst[0], burst[1]);
  assert.equal(burst[1], burst[2]);
  const other = b.refreshLaneWhosHere('other');
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, 2, "lane 'other' reads now; lane 'own' rerun waits for the first");
  c.release();
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, 3, 'one rerun for the whole burst');
  c.release();
  await Promise.all([...burst, other]);
  assert.deepEqual(calls.filter(([l]) => l === 'own'), [['own', 1], ['own', 2]], 'the rerun saw the write made during the first run');
  assert.deepEqual(calls.filter(([l]) => l === 'other'), [['other', 2]]);
  assert.equal(b.whosFlights.size, 0, 'no flight state left behind');
  // No write since the running refresh started: later callers join it (one GET, one whosHere), no serial rerun.
  calls.length = 0;
  const gets = c.gets;
  const joined = [b.refreshLaneWhosHere('own'), b.refreshLaneWhosHere('own'), b.refreshLaneWhosHere('own')];
  await new Promise((r) => setImmediate(r));
  assert.equal(c.gets, gets + 1);
  c.release();
  await Promise.all(joined);
  assert.deepEqual(calls, [['own', 2]]);
  // A refresh failure (whosHere throws) is swallowed and does not wedge the lane.
  const bad = backendFor(c, () => { throw new Error('disk'); });
  const p = bad.refreshLaneWhosHere('own');
  await new Promise((r) => setImmediate(r));
  c.release();
  await p;
  assert.equal(bad.whosFlights.size, 0);
});

// ---- tail reader --------------------------------------------------------------------------------------------------------

const naive = (file, n) => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n);
const collectAsync = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

test('tail reader matches readFileSync+split across chunk boundaries, CRLF, multi-byte UTF-8, empty and missing files', async () => {
  const dir = tmp();
  try {
    const cases = {
      empty: '',
      onlyNewlines: '\n\n\r\n',
      noTrailingNewline: 'a\nbb\nccc',
      lf: Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, text: 'x'.repeat(i % 13) })).join('\n') + '\n',
      crlf: Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(i % 7)}`).join('\r\n') + '\r\n',
      mixed: 'one\r\ntwo\n\nthree\r\n\r\nfour\n',
      utf8: Array.from({ length: 40 }, (_, i) => `é漢字🙂 ${i} ${'ü'.repeat(i % 5)}`).join('\n') + '\n',
      longLine: `${'z'.repeat(1000)}\nshort\n${'w'.repeat(777)}`,
    };
    for (const [name, body] of Object.entries(cases)) {
      const f = path.join(dir, `${name}.jsonl`);
      writeFileSync(f, body, 'utf8');
      const all = naive(f, Infinity);
      for (const chunkSize of [1, 2, 3, 5, 7, 64, 65536]) {
        const msg = `${name} chunk=${chunkSize}`;
        assert.deepEqual([...linesFromEndSync(f, { chunkSize })], [...all].reverse(), msg);
        assert.deepEqual(await collectAsync(linesFromEnd(f, { chunkSize })), [...all].reverse(), msg);
        for (const n of [0, 1, 3, 100]) {
          const want = n > 0 ? all.slice(-n) : [];
          assert.deepEqual(tailLinesSync(f, n, { chunkSize }), want, `${msg} n=${n}`);
          assert.deepEqual(await tailLines(f, n, { chunkSize }), want, `${msg} n=${n} async`);
        }
      }
    }
    const missing = path.join(dir, 'nope.jsonl');
    assert.throws(() => tailLinesSync(missing, 5), { code: 'ENOENT' });
    await assert.rejects(tailLines(missing, 5), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recentLaneLog gives the same entries as the whole-file scan', () => {
  const home = tmp();
  try {
    const dir = path.join(home, 'teams', 'vibesquad');
    mkdirSync(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 3000; i++) {
      const lane = i % 97 === 0 ? 'rare' : i % 3 ? 'busy' : 'Own';
      lines.push(JSON.stringify({ ts: `t${i}`, agent: 'a', lane, type: i % 5 ? 'decision' : 'metric', text: `e${i} ${'p'.repeat(i % 50)}`, refs: [] }));
      if (i % 400 === 0) lines.push('{garbled');
    }
    writeFileSync(path.join(dir, 'log.jsonl'), lines.join('\r\n') + '\r\n', 'utf8');
    const old = (laneId, n) => {
      const all = readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
      const out = [];
      for (let i = all.length - 1; i >= 0 && out.length < n; i--) {
        try {
          const e = JSON.parse(all[i]);
          if (String(e.lane ?? '').toLowerCase() === laneId.toLowerCase() && e.type !== 'metric') out.push(e);
        } catch {}
      }
      return out.reverse();
    };
    for (const [lane, n] of [['own', 5], ['rare', 5], ['rare', 100], ['busy', 1], ['none', 5], ['own', 0]]) {
      assert.deepEqual(recentLaneLog({ teamId: 'vibesquad', laneId: lane, n, home }), old(lane, n), `${lane} n=${n}`);
    }
    assert.deepEqual(recentLaneLog({ teamId: 'missing', laneId: 'own', home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
