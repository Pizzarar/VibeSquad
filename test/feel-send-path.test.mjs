import assert from "node:assert/strict";
import test from "node:test";
import { maxEntrySeq, mergeLiveItem, syncNeeded } from "../src/timelineFilter.ts";
import { addPending, dismissPending, dropReconciled, failPending, getPending, pendingFor, reconciledIds, resetPending, retryPending } from "../src/pendingSend.ts";

// ── coalescing: which live events may trigger a healing refetch ──
test("maxEntrySeq reads seqEnd, liveSeqs and source ranges", () => {
  assert.equal(maxEntrySeq([]), null);
  assert.equal(maxEntrySeq([{ item: {}, seqStart: 3, seqEnd: 7 }, { item: {}, liveSeqs: [9, 8] }, { item: {}, sourceSeqRanges: [{ startSeq: 1, endSeq: 12 }] }]), 12);
});

test("contiguous and redelivered seqs need no refetch", () => {
  assert.equal(syncNeeded(10, 11), "none");
  assert.equal(syncNeeded(10, 10), "none");
  assert.equal(syncNeeded(10, 4), "none");
});

test("a seq gap or an unverifiable event does need one", () => {
  assert.equal(syncNeeded(10, 12), "gap");
  assert.equal(syncNeeded(10, undefined), "unverified");
  assert.equal(syncNeeded(null, 5), "unverified");
});

test("a 200-chunk streamed reply triggers zero refetches and loses/duplicates nothing", () => {
  let entries = [{ item: { type: "user_message", text: "hi" }, seqStart: 1 }];
  let last = maxEntrySeq(entries);
  let refetches = 0;
  for (let seq = 2; seq < 202; seq++) {
    entries = mergeLiveItem(entries, { type: "assistant_message", text: "x" }, "t", seq);
    if (syncNeeded(last, seq) !== "none") refetches++;
    if (last == null || seq > last) last = seq;
    // redelivery of the same seq must not duplicate text
    entries = mergeLiveItem(entries, { type: "assistant_message", text: "x" }, "t", seq);
  }
  assert.equal(refetches, 0);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].item.text.length, 200);
});

test("a dropped event is detected as a gap on the next one", () => {
  let last = 5;
  assert.equal(syncNeeded(last, 6), "none");
  last = 6;
  assert.equal(syncNeeded(last, 8), "gap"); // 7 lost
});

// ── optimistic send reconcile ──
test("pending bubble is reconciled with the daemon's user_message exactly once", () => {
  resetPending();
  const id = addPending("a1", "do the thing", 1000);
  const mk = (text, ts) => ({ item: { type: "user_message", text }, timestamp: new Date(ts).toISOString() });
  assert.deepEqual(reconciledIds(pendingFor(getPending(), "a1"), [mk("other", 1100)]), []);
  assert.deepEqual(reconciledIds(pendingFor(getPending(), "a1"), [mk("do the thing", 1200)]), [id]);
  dropReconciled([id]);
  assert.equal(getPending().length, 0);
});

test("an older identical message does not swallow a new pending send", () => {
  resetPending();
  const now = Date.parse("2026-11-05T12:00:00Z");
  const id = addPending("a1", "go", now);
  const old = { item: { type: "user_message", text: "go" }, timestamp: new Date(now - 60000).toISOString() };
  assert.deepEqual(reconciledIds(getPending(), [old]), []);
  assert.deepEqual(reconciledIds(getPending(), [old, { item: { type: "user_message", text: " go " }, timestamp: new Date(now + 300).toISOString() }]), [id]);
});

test("two identical pending sends need two daemon entries", () => {
  resetPending();
  const t = Date.now();
  const a = addPending("a1", "again", t);
  const b = addPending("a1", "again", t + 1);
  const e = (n) => ({ item: { type: "user_message", text: "again" }, timestamp: new Date(t + n).toISOString() });
  assert.deepEqual(reconciledIds(getPending(), [e(10)]), [a]);
  assert.deepEqual(reconciledIds(getPending(), [e(10), e(20)]).sort(), [a, b].sort());
});

test("failed send keeps the text with the error, is not reconciled, and can retry or dismiss", () => {
  resetPending();
  const id = addPending("a1", "keep me", 5000);
  failPending(id, "daemon down");
  const p = getPending()[0];
  assert.equal(p.state, "failed");
  assert.equal(p.error, "daemon down");
  assert.equal(p.text, "keep me");
  assert.deepEqual(reconciledIds(getPending(), [{ item: { type: "user_message", text: "keep me" }, timestamp: new Date(6000).toISOString() }]), []);
  const r = retryPending(id, 7000);
  assert.equal(r.text, "keep me");
  assert.equal(getPending()[0].state, "pending");
  assert.equal(getPending()[0].error, undefined);
  dismissPending(id);
  assert.equal(getPending().length, 0);
});

test("pending is scoped per agent", () => {
  resetPending();
  addPending("a1", "x");
  addPending("a2", "y");
  assert.equal(pendingFor(getPending(), "a2").length, 1);
});

test("agent switch: a stale higher seq is cleared, so the new agent's stream is unverified and refetches", () => {
  let lastSeq = 100; // agent A
  assert.equal(syncNeeded(lastSeq, 5), "none"); // the bug: stale baseline suppresses B's refetch
  lastSeq = null; // reset on agentId change (Timeline.tsx useTimeline effect)
  assert.equal(syncNeeded(lastSeq, 5), "unverified");
});

test("pending bubbles never leak to another agent's timeline after a switch", () => {
  resetPending();
  addPending("A", "for A");
  assert.equal(pendingFor(getPending(), "B").length, 0);
  assert.equal(pendingFor(getPending(), "A").length, 1);
});
