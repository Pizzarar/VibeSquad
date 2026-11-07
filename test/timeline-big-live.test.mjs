// Bug21: a big timeline (>500 events, pages of 60 rows) must keep updating live. Tail refetches overlap and can complete
// out of order, and each one used to replace every row, dropping "Load older" pages and letting an older snapshot win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toTimeline } from '../server/backend/runner-backend.mjs';
import { coalesceReplies, createLoadGate, joinPages, maxEntrySeq, mergeTail } from '../src/timelineFilter.ts';
import { addPending, getPending, markDelivered, noteAgentSeq, reconcile, resetPending } from '../src/pendingSend.ts';

const PAGE = 60;
const bigLog = (turns) => {
  const ev = [];
  let seq = 0;
  for (let i = 0; i < turns; i++) {
    ev.push({ seq: ++seq, ts: 1e12 + seq * 1000, type: 'input', text: `ask ${i}` });
    ev.push({ seq: ++seq, ts: 1e12 + seq * 1000, type: 'tool', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` }, status: 'running' });
    ev.push({ seq: ++seq, ts: 1e12 + seq * 1000, type: 'output', text: `answer ${i}` });
    ev.push({ seq: ++seq, ts: 1e12 + seq * 1000, type: 'turn_done' });
  }
  return ev;
};
const tailOf = (events) => {
  const rows = toTimeline(events);
  return { entries: rows.slice(-PAGE), hasOlder: rows.length > PAGE };
};
const asc = (rows) => rows.every((e, i) => i === 0 || e.seqStart >= rows[i - 1].seqStart);

test('fixture is a big timeline: >500 events, far more rows than one page', () => {
  const ev = bigLog(150);
  assert.ok(ev.length > 500);
  assert.ok(toTimeline(ev).length > PAGE * 2);
});

test('a tail refetch keeps loaded older pages and shows the new message (no wipe on every event)', () => {
  const ev = bigLog(150);
  const first = coalesceReplies(tailOf(ev).entries);
  // the user pages back twice
  const rows = toTimeline(ev);
  const older = coalesceReplies(rows.slice(-PAGE * 3, -PAGE * 2));
  const older2 = coalesceReplies(rows.slice(-PAGE * 2, -PAGE));
  let shown = joinPages(older2, first);
  shown = joinPages(older, shown);
  const before = shown.length;
  assert.ok(before > 100);
  // a send lands, then the leading refetch returns only the newest page
  const next = [...ev, { seq: ev.length + 1, ts: 2e12, type: 'input', text: 'ping now' }, { seq: ev.length + 2, ts: 2e12 + 1, type: 'output', text: 'pong' }];
  const merged = mergeTail(shown, coalesceReplies(tailOf(next).entries));
  assert.ok(merged.length > before, `older pages kept (${merged.length} > ${before})`);
  assert.ok(asc(merged), 'rows stay in seq order');
  assert.ok(merged.some((e) => e.item.type === 'user_message' && e.item.text === 'ping now'), 'new user message shown');
  assert.ok(merged.some((e) => e.item.type === 'assistant_message' && /pong/.test(e.item.text)), 'reply shown');
  assert.equal(merged[0].seqStart, shown[0].seqStart, 'oldest loaded row unchanged');
});

test('a tail refetch with no older pages loaded is just the new page', () => {
  const ev = bigLog(150);
  const tail = coalesceReplies(tailOf(ev).entries);
  assert.deepEqual(mergeTail(tail, tail), tail);
  assert.deepEqual(mergeTail([], tail), tail);
});

test('out-of-order responses: the older snapshot completing last cannot overwrite the newer', () => {
  const ev = bigLog(150);
  const gate = createLoadGate();
  const leading = gate.begin(); // fired on the input event
  const trailing = gate.begin(); // fired ~800ms later, after the reply
  let shown = [];
  const snapshotWithReply = coalesceReplies(tailOf([...ev, { seq: 9001, ts: 3e12, type: 'input', text: 'ping now' }, { seq: 9002, ts: 3e12 + 1, type: 'output', text: 'pong' }]).entries);
  const snapshotBefore = coalesceReplies(tailOf(ev).entries);
  // trailing (newer) returns first, the slow leading (older) one returns last
  if (gate.accept(trailing)) shown = snapshotWithReply;
  if (gate.accept(leading)) shown = snapshotBefore;
  assert.ok(shown.some((e) => /pong/.test(e.item.text ?? '')), 'newer snapshot (with the reply) still shown');
  assert.equal(gate.accept(trailing), false, 'a ticket applies once');
});

test('in-order responses all apply', () => {
  const gate = createLoadGate();
  const a = gate.begin();
  const b = gate.begin();
  assert.equal(gate.accept(a), true);
  assert.equal(gate.accept(b), true);
});

test('Sending… reconciles against a >100-event tail window after the merge', () => {
  resetPending();
  const ev = bigLog(150);
  const shown = coalesceReplies(tailOf(ev).entries);
  noteAgentSeq('rn-big', maxEntrySeq(shown));
  const id = addPending('rn-big', 'ping now', Date.now());
  markDelivered(id);
  const next = [...ev, { seq: ev.length + 1, ts: Date.now(), type: 'input', text: 'ping now' }];
  const merged = mergeTail(shown, coalesceReplies(tailOf(next).entries));
  assert.equal(reconcile(getPending(), merged).length, 1);
  resetPending();
});
