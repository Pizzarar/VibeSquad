import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerBackend, toTimeline } from '../server/backend/runner-backend.mjs';

// Synthetic log: turns of user input, thoughts, split replies (thought between), tool calls (some results far later), errors.
function makeLog(turns) {
  const ev = []; const add = (type, d = {}) => ev.push({ seq: ev.length, ts: 1700000000000 + ev.length, type, ...d });
  for (let t = 0; t < turns; t++) {
    add('input', { text: `q${t}` });
    add('thought', { text: `th${t}a` }); add('thought', { text: `th${t}b` });
    add('output', { text: `a${t}-1 ` });
    add('thought', { text: `mid${t}` });
    add('output', { text: `a${t}-2 ` });
    add('output', { text: `a${t}-3` });
    if (t % 3 === 0) { add('tool', { phase: 'call', id: `c${t}`, name: 'x' }); add('tool', { phase: 'call', id: `d${t}`, name: 'y' }); add('output', { text: 'between' }); add('tool', { phase: 'result', id: `c${t}`, status: 'completed' }); add('tool', { phase: 'result', id: `d${t}`, status: 'completed' }); }
    if (t % 7 === 0) add('error', { message: `e${t}` });
    add('turn_done');
  }
  return ev;
}
function backendFor(events) {
  const b = Object.create(RunnerBackend.prototype);
  b.calls = [];
  b.rawRead = 0; // raw events the fake runner sent back, summed over requests
  b.rc = { request: async (_m, p) => {
    b.calls.push(p);
    const q = new URLSearchParams(p.split('?')[1] ?? '');
    const tail = Number(q.get('tail') ?? 0);
    const after = tail > 0 ? Math.max(0, events.length - tail) : Number(q.get('after') ?? 0);
    const until = q.has('until') ? Number(q.get('until')) : Infinity;
    const types = q.get('types');
    const out = events.slice(after).filter((e) => e.seq < until && (!types || e.type === types));
    b.rawRead += out.length;
    return { events: out, from: after, total: events.length };
  } };
  return b;
}
const full = (events, limit, cursor) => {
  let entries = toTimeline(events);
  if (cursor) entries = entries.filter((e) => e.seqStart < cursor.seq);
  const lastSeq = entries.reduce((m, e) => Math.max(m, e.seqEnd ?? -1), -1);
  const hasOlder = entries.length > limit;
  entries = entries.slice(-limit);
  return { entries, hasOlder, lastSeq, startCursor: entries[0] ? { epoch: 'runner', seq: entries[0].seqStart } : null };
};

test('tail of a large log equals the last N rows of the full timeline, from a small raw window', async () => {
  const events = makeLog(400);
  for (const limit of [1, 5, 20, 60]) {
    const b = backendFor(events);
    const got = await b.fetchAgentTimeline('a', { direction: 'tail', limit });
    assert.deepEqual(got, full(events, limit), `limit ${limit}`);
  }
  const b = backendFor(events);
  await b.fetchAgentTimeline('a', { direction: 'tail', limit: 20 });
  assert.equal(b.calls.length, 1);
  assert.match(b.calls[0], /\?tail=400$/);
});

test('every tail size matches the full read across window edges (merge at the edge grows the window)', async () => {
  const events = makeLog(40);
  for (let limit = 1; limit <= 120; limit++) {
    const got = await backendFor(events).fetchAgentTimeline('a', { limit });
    assert.deepEqual(got, full(events, limit), `limit ${limit}`);
  }
});

test('paging older from the cursor to the start reproduces the full timeline', async () => {
  const events = makeLog(120);
  const all = toTimeline(events);
  for (const limit of [7, 25]) {
    let rows = []; let cursor = null; let guard = 0;
    for (;;) {
      const b = backendFor(events);
      const r = await b.fetchAgentTimeline('a', cursor ? { direction: 'before', cursor, limit } : { direction: 'tail', limit });
      assert.deepEqual(r, full(events, limit, cursor), 'page equals the full-read page');
      rows = [...r.entries, ...rows]; cursor = r.startCursor;
      if (!r.hasOlder || ++guard > 1000) break;
    }
    assert.deepEqual(rows, all);
  }
});

test('no limit reads the whole log, as before', async () => {
  const events = makeLog(30);
  const b = backendFor(events);
  assert.deepEqual(await b.fetchAgentTimeline('a'), full(events, Infinity));
  assert.equal(b.calls[0].includes('?'), false);
});

test('before-page lastSeq matches the full read when a call before the window resolves at/after the cursor', async () => {
  const events = [];
  const add = (type, d = {}) => events.push({ seq: events.length, ts: 1700000000000 + events.length, type, ...d });
  add('input', { text: 'start' });
  add('tool', { phase: 'call', id: 'long', name: 'slow' }); // opens far before any window
  for (let t = 0; t < 300; t++) { add('input', { text: `q${t}` }); add('output', { text: `a${t}` }); add('turn_done'); }
  add('tool', { phase: 'result', id: 'long', status: 'completed' }); // resolves after the cursor
  for (let t = 0; t < 30; t++) { add('input', { text: `r${t}` }); add('output', { text: `b${t}` }); add('turn_done'); }
  const cursor = { epoch: 'runner', seq: 700 };
  for (const limit of [3, 10, 40]) {
    const got = await backendFor(events).fetchAgentTimeline('a', { direction: 'before', cursor, limit });
    assert.deepEqual(got, full(events, limit, cursor), `limit ${limit}`);
  }
  // cursor right behind the long call too: window start falls between call and result
  const got = await backendFor(events).fetchAgentTimeline('a', { direction: 'before', cursor: { epoch: 'runner', seq: 500 }, limit: 5 });
  assert.deepEqual(got, full(events, 5, { seq: 500 }));
});

test('a before page of a big log does not request the whole log (bounded window + tool events only)', async () => {
  const events = makeLog(3000); // ~30k raw events
  const cursor = { epoch: 'runner', seq: events.length - 200 };
  const b = backendFor(events);
  const got = await b.fetchAgentTimeline('a', { direction: 'before', cursor, limit: 20 });
  assert.deepEqual(got, full(events, 20, cursor));
  assert.ok(b.calls.every((c) => /until=|types=tool|tail=/.test(c)), `no unbounded read: ${b.calls}`);
  assert.ok(b.rawRead < events.length / 5, `read ${b.rawRead} of ${events.length}`);
  // a far-back page with an open tool call below the window still matches
  const mid = { epoch: 'runner', seq: 12000 };
  const b2 = backendFor(events);
  assert.deepEqual(await b2.fetchAgentTimeline('a', { direction: 'before', cursor: mid, limit: 20 }), full(events, 20, mid));
  assert.ok(b2.rawRead < events.length / 2);
});

test('random logs: tail and before pages equal the full read (bounded windows, tool results far past the cursor)', async () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let it = 0; it < 200; it++) {
    const ev = []; const add = (type, d = {}) => ev.push({ seq: ev.length, ts: 1, type, ...d }); const open = []; let id = 0;
    const n = 300 + Math.floor(rnd() * 900);
    while (ev.length < n) {
      const r = rnd();
      if (r < .1) add('input', { text: 'q' }); else if (r < .25) add('thought', { text: 't' }); else if (r < .5) add('output', { text: 'o' });
      else if (r < .6) { add('tool', { phase: 'call', id: 'c' + id, name: 'x' }); open.push('c' + id++); }
      else if (r < .65 && open.length) add('tool', { phase: 'result', id: open.splice(Math.floor(rnd() * open.length), 1)[0], status: 'completed' });
      else if (r < .7) add('error', { message: 'e' }); else if (r < .9) add('turn_done'); else add('status', { status: 'x' });
    }
    const limit = 1 + Math.floor(rnd() * 12); const cur = rnd() < .3 ? null : { epoch: 'runner', seq: Math.floor(rnd() * ev.length) };
    const got = await backendFor(ev).fetchAgentTimeline('a', cur ? { direction: 'before', cursor: cur, limit } : { limit });
    assert.deepEqual(got, full(ev, limit, cur), `it ${it} limit ${limit} cursor ${cur?.seq}`);
  }
});
