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
  b.rc = { request: async (_m, p) => {
    b.calls.push(p);
    const q = new URLSearchParams(p.split('?')[1] ?? '');
    const tail = Number(q.get('tail') ?? 0);
    const after = tail > 0 ? Math.max(0, events.length - tail) : Number(q.get('after') ?? 0);
    return { events: events.slice(after), from: after };
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
