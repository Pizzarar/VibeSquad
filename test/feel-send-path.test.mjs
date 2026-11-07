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

// ── reconcile when exact text + timestamp cannot match ──
import { markDelivered, noteAgentSeq } from "../src/pendingSend.ts";
const um = (text, seq, ts) => ({ item: { type: "user_message", text }, seqStart: seq, ...(ts ? { timestamp: new Date(ts).toISOString() } : {}) });

test("a hook-rewritten user_message clears a delivered send, but not an undelivered one", () => {
  resetPending();
  noteAgentSeq("h1", 10);
  const id = addPending("h1", "original", 1000);
  const entries = [um("old", 5), um("[hook] original + context", 12)];
  assert.deepEqual(reconciledIds(getPending(), entries), []);
  markDelivered(id);
  assert.deepEqual(reconciledIds(getPending(), entries), [id]);
  assert.deepEqual(reconciledIds(getPending(), [um("old", 5)]), [], "an entry before the baseline is not it");
});

test("a user_message pushed out of the 60-entry tail still clears a delivered send", () => {
  resetPending();
  noteAgentSeq("w1", 100);
  const id = addPending("w1", "scrolled", 1000);
  markDelivered(id);
  const tail = Array.from({ length: 60 }, (_, i) => ({ item: { type: "assistant_message", text: "x" }, seqStart: 150 + i }));
  assert.deepEqual(reconciledIds(getPending(), tail), [id]);
  assert.deepEqual(reconciledIds(getPending(), [{ item: { type: "assistant_message" }, seqStart: 90 }]), [], "window still starts before the baseline");
});

test("more than 5s of clock skew no longer sticks a delivered send", () => {
  resetPending();
  noteAgentSeq("c1", 3);
  const id = addPending("c1", "skewed", 1_000_000);
  markDelivered(id);
  assert.deepEqual(reconciledIds(getPending(), [um("skewed", 4, 1_000_000 - 60_000)]), [id]);
});

test("seq fallback gives each pending its own user_message", () => {
  resetPending();
  noteAgentSeq("m1", 1);
  const a = addPending("m1", "one", 1);
  const b = addPending("m1", "two", 2);
  markDelivered(a); markDelivered(b);
  assert.deepEqual(reconciledIds(getPending(), [um("X", 2)]), [a]);
  assert.deepEqual(reconciledIds(getPending(), [um("X", 2), um("Y", 3)]).sort(), [a, b].sort());
});

import { dropMatched, reconcile } from "../src/pendingSend.ts";

test("a claimed seq is not reused on the next render (p2 cannot steal p1's user_message)", () => {
  resetPending();
  noteAgentSeq("r1", 10);
  const p1 = addPending("r1", "one", 1);
  const p2 = addPending("r1", "two", 2);
  markDelivered(p1); markDelivered(p2);
  const entries = [um("one", 11)];
  const m = reconcile(getPending(), entries);
  assert.deepEqual(m.map((x) => x.id), [p1]);
  dropMatched(m);
  assert.deepEqual(reconciledIds(getPending(), entries), [], "second render: p2 stays pending");
  assert.deepEqual(reconciledIds(getPending(), [um("one", 11), um("two", 12)]), [p2]);
});

test("exact text is matched across all pendings first, and an unmatched earlier send blocks later seq fallbacks (FIFO)", () => {
  resetPending();
  noteAgentSeq("f1", 10);
  const p1 = addPending("f1", "one", 1); // never delivered: its message was hook-rewritten
  const p2 = addPending("f1", "two", 2);
  markDelivered(p2);
  const entries = [um("[hook] one", 11)];
  assert.deepEqual(reconciledIds(getPending(), entries), [], "p2 must not claim p1's seq");
  markDelivered(p1);
  assert.deepEqual(reconciledIds(getPending(), entries), [p1]);
  // exact text for p2 beats p1's seq fallback even though p1 is earlier
  assert.deepEqual(reconciledIds(getPending(), [um("two", 11)]), [p2], "p1 cannot grab the entry p2 matches by text");
});
