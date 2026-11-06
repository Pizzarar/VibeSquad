import assert from "node:assert/strict";
import test from "node:test";
import { defaultSpawnConfigFor } from "../src/antigravity.ts";
import { coalesceReplies, filterEntries, joinPages, latestReasoningIndex, markTurnBoundary, mergeLiveItem, reasoningText } from "../src/timelineFilter.ts";

const base = [{ item: { type: "user_message", text: "hi" }, seqStart: 0 }];

// Real subscribe payload: { agentId, event: { type: "timeline", item }, timestamp, seq } (client index.d.ts:220-242).
const apply = (entries, payload) =>
  payload.event.type === "timeline" ? mergeLiveItem(entries, payload.event.item, payload.timestamp, payload.seq) : entries;
const ev = (item, seq) => ({ agentId: "a", event: { type: "timeline", provider: "antigravity-cli", item }, timestamp: "t", seq });

test("live reasoning chunks merge into the tail entry", () => {
  let e = apply(base, ev({ type: "reasoning", text: "think" }, 1));
  e = apply(e, ev({ type: "reasoning", text: "ing" }, 2));
  assert.equal(e.length, 2);
  assert.equal(e[1].item.text, "thinking");
});

test("a duplicate seq never doubles the text", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "ab" }, 5));
  e = apply(e, ev({ type: "assistant_message", text: "ab" }, 5));
  e = apply(e, ev({ type: "assistant_message", text: "c" }, 6));
  e = apply(e, ev({ type: "assistant_message", text: "c" }, 6));
  assert.equal(e[1].item.text, "abc");
  // a seq already loaded from the projected refetch is ignored too
  const loaded = [{ item: { type: "assistant_message", text: "x" }, seqStart: 3, seqEnd: 7, sourceSeqRanges: [{ startSeq: 3, endSeq: 7 }] }];
  assert.equal(apply(loaded, ev({ type: "assistant_message", text: "x" }, 7)), loaded);
  // non-timeline events are ignored
  assert.equal(apply(base, { agentId: "a", event: { type: "turn_started" } }), base);
});

test("live assistant text extends tail; tool_call by callId updates in place", () => {
  let e = mergeLiveItem(base, { type: "assistant_message", text: "a" });
  e = mergeLiveItem(e, { type: "assistant_message", text: "b" });
  assert.equal(e[1].item.text, "ab");
  e = mergeLiveItem(e, { type: "tool_call", callId: "c1", status: "running", detail: { x: 1 } });
  e = mergeLiveItem(e, { type: "tool_call", callId: "c1", status: "completed", detail: { y: 2 } });
  assert.equal(e.length, 3);
  assert.equal(e[2].item.status, "completed");
  assert.deepEqual(e[2].item.detail, { x: 1, y: 2 });
});

test("refetch result replaces optimistic entries without duplicates", () => {
  const optimistic = mergeLiveItem(base, { type: "reasoning", text: "x" });
  const refetched = [...base, { item: { type: "reasoning", text: "x" }, seqStart: 1 }];
  // useTimeline does setEntries(refetched): the optimistic list is discarded wholesale.
  assert.equal(optimistic.length, refetched.length);
  assert.equal(refetched.filter((x) => x.item.type === "reasoning").length, 1);
});

test("reasoning text normalizes provider shapes; latest index", () => {
  assert.equal(reasoningText({ summary: "s" }), "s");
  assert.equal(reasoningText({ thinking: "t" }), "t");
  assert.equal(reasoningText({ detail: { text: "d" } }), "d");
  assert.equal(reasoningText({}), "");
  assert.equal(latestReasoningIndex([{ item: { type: "reasoning" } }, { item: { type: "reasoning" } }, { item: { type: "tool_call" } }]), 1);
});

test("text filter includes reasoning", () => {
  const es = [...base, { item: { type: "reasoning", text: "x" }, seqStart: 1 }, { item: { type: "tool_call" }, seqStart: 2 }];
  assert.deepEqual(filterEntries(es, "text").map((x) => x.seqStart), [0, 1]);
});

test("antigravity-cli sets no thinking option (effort is part of the model id)", () => {
  assert.equal(defaultSpawnConfigFor("antigravity-cli").thinkingOptionId, undefined);
});

test("cumulative snapshots with the same id replace instead of doubling", () => {
  let e = apply(base, ev({ type: "assistant_message", id: "t:1", messageId: "t:1", text: "Hel" }, 1));
  e = apply(e, ev({ type: "assistant_message", id: "t:1", messageId: "t:1", text: "Hello" }, 2));
  e = apply(e, ev({ type: "assistant_message", id: "t:1", messageId: "t:1", text: "Hello world" }, 3));
  assert.equal(e.length, 2);
  assert.equal(e[1].item.text, "Hello world");
});

test("deltas append, with or without a (shared) messageId", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "foo" }, 1));
  e = apply(e, ev({ type: "assistant_message", text: "bar" }, 2));
  assert.equal(e[1].item.text, "foobar");
  let c = apply(base, ev({ type: "assistant_message", messageId: "m", text: "ab" }, 1));
  c = apply(c, ev({ type: "assistant_message", messageId: "m", text: "cd" }, 2));
  c = apply(c, ev({ type: "assistant_message", messageId: "m", text: "ab" }, 3)); // repeated delta text, new seq
  assert.equal(c[1].item.text, "abcdab");
});

const summary = (e) => e.map((x) => `${x.item.type}:${x.item.text ?? ""}`);
const strictlyIncreasing = (e) => e.every((x, i) => i === 0 || x.seqStart > e[i - 1].seqStart);

test("live text -> thought -> text is one reply; rows never move and seqStart stays unique", () => {
  const loaded = [{ item: { type: "user_message", text: "hi" }, seqStart: 0 }, { item: { type: "assistant_message", text: "Hello " }, seqStart: 10, seqEnd: 10 }];
  let e = apply(loaded, ev({ type: "reasoning", text: "hmm" }, 11));
  e = apply(e, ev({ type: "assistant_message", text: "world" }, 12));
  assert.deepEqual(summary(e), ["user_message:hi", "assistant_message:Hello world", "reasoning:hmm"]);
  assert.deepEqual([e[1].seqStart, e[1].seqEnd], [10, 12]);
  assert.equal(e[2].seqStart, undefined); // the live thought row keeps its own identity (no seqStart tie, no move)
  const input = structuredClone(e);
  apply(e, ev({ type: "assistant_message", text: "!" }, 13));
  assert.deepEqual(e, input, "mergeLiveItem must not mutate its input");
});

test("refetched rows keep strictly increasing seqStart after coalescing", () => {
  const row = (type, text, a, b = a) => ({ item: { type, text }, seqStart: a, seqEnd: b });
  const out = coalesceReplies([row("user_message", "q", 9), row("assistant_message", "A", 10), row("reasoning", "T1", 11), row("assistant_message", "B", 12), row("reasoning", "T2", 13), row("assistant_message", "C", 14), row("tool_call", "x", 15)]);
  assert.deepEqual(summary(out), ["user_message:q", "assistant_message:ABC", "reasoning:T1", "reasoning:T2", "tool_call:x"]);
  assert.ok(strictlyIncreasing(out));
  assert.deepEqual([out[1].seqStart, out[1].seqEnd], [10, 14]);
});

test("cumulative snapshots after a thought are judged against their own segment", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "Hello " }, 1));
  e = apply(e, ev({ type: "reasoning", text: "hmm" }, 2));
  for (const [t, s] of [["wor", 3], ["world", 4], ["world!", 5]]) e = apply(e, ev({ type: "assistant_message", text: t }, s));
  assert.equal(e[1].item.text, "Hello world!");
  let f = apply(base, ev({ type: "assistant_message", text: "Yes" }, 1));
  f = apply(f, ev({ type: "reasoning", text: "hmm" }, 2));
  f = apply(f, ev({ type: "assistant_message", text: "Yes, I checked" }, 3));
  f = apply(f, ev({ type: "assistant_message", text: "Yes, I checked it" }, 4));
  assert.equal(f[1].item.text, "YesYes, I checked it");
});

test("no rejoin across a user message, a tool call, a different message id or turn id", () => {
  const sep = (item) => {
    let e = apply(base, ev({ type: "assistant_message", text: "A" }, 1));
    e = apply(e, ev({ type: "reasoning", text: "t" }, 2));
    e = apply(e, ev(item, 3));
    return apply(e, ev({ type: "assistant_message", text: "B" }, 4));
  };
  assert.equal(sep({ type: "user_message", text: "q" }).filter((x) => x.item.type === "assistant_message").length, 2);
  assert.equal(sep({ type: "tool_call", callId: "c", status: "running" }).filter((x) => x.item.type === "assistant_message").length, 2);
  let h = apply(base, ev({ type: "assistant_message", text: "A", messageId: "m1" }, 1));
  h = apply(h, ev({ type: "reasoning", text: "t" }, 2));
  h = apply(h, ev({ type: "assistant_message", text: "B", messageId: "m2" }, 3));
  assert.equal(h.filter((x) => x.item.type === "assistant_message").length, 2);
  let t = mergeLiveItem(base, { type: "assistant_message", text: "t1" }, "t", 1, "t1");
  t = mergeLiveItem(t, { type: "assistant_message", text: "t2" }, "t", 2, "t2");
  assert.equal(t.filter((x) => x.item.type === "assistant_message").length, 2);
});

test("back-to-back turns with no user row: a turn boundary stops the tail merge and never overwrites the old segment", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "Yes" }, 1));
  e = apply(e, ev({ type: "reasoning", text: "r" }, 2));
  e = apply(e, ev({ type: "assistant_message", text: "ok" }, 3));
  e = markTurnBoundary(e);
  e = apply(e, ev({ type: "assistant_message", text: "ok, next turn" }, 4));
  assert.deepEqual(summary(e.filter((x) => x.item.type === "assistant_message")), ["assistant_message:Yesok", "assistant_message:ok, next turn"]);
  // and a turn boundary on a trailing thought blocks the rejoin too
  let f = apply(base, ev({ type: "assistant_message", text: "A" }, 1));
  f = markTurnBoundary(apply(f, ev({ type: "reasoning", text: "r" }, 2)));
  f = apply(f, ev({ type: "assistant_message", text: "B" }, 3));
  assert.equal(f.filter((x) => x.item.type === "assistant_message").length, 2);
});

test("joinPages rejoins a reply cut by a page boundary at every position, keeping segStart", () => {
  const row = (type, text, a, b = a) => ({ item: { type, text }, seqStart: a, seqEnd: b });
  const flat = [row("assistant_message", "A", 10), row("reasoning", "T1", 11), row("assistant_message", "B", 12), row("reasoning", "T2", 13), row("assistant_message", "C", 14), row("tool_call", "x", 15)];
  const whole = coalesceReplies(flat);
  for (const cutAt of [1, 2, 3, 4, 5]) {
    const joined = joinPages(coalesceReplies(flat.slice(0, cutAt)), coalesceReplies(flat.slice(cutAt)));
    assert.deepEqual(joined.map((x) => [x.item.type, x.item.text, x.seqStart, x.seqEnd, x.segStart]), whole.map((x) => [x.item.type, x.item.text, x.seqStart, x.seqEnd, x.segStart]), `cut at ${cutAt}`);
    assert.ok(strictlyIncreasing(joined));
  }
  assert.equal(whole[0].segStart, 2); // the latest segment ("C") starts after "AB"
});

test("a settled thought is not the latest-reasoning row; tailSig-relevant reply length is on the message", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "A" }, 10));
  e = apply(e, ev({ type: "reasoning", text: "t" }, 11));
  assert.equal(latestReasoningIndex(e), 2); // still thinking: the thought is the live tail
  e = apply(e, ev({ type: "assistant_message", text: "B" }, 12));
  assert.equal(latestReasoningIndex(e), -1); // reply carried on past it
  assert.equal(e[1].item.text, "AB");
  assert.deepEqual([e[1].seqStart, e[1].seqEnd], [undefined, 12]);
});

test("lastAssistantText returns the whole reply from a split Paseo projection", async () => {
  const { lastAssistantText } = await import("../server/mcp/tools.mjs");
  const row = (type, text, a) => ({ item: { type, text }, seqStart: a, seqEnd: a });
  assert.equal(lastAssistantText({ entries: [row("assistant_message", "Hello ", 1), row("reasoning", "hmm", 2), row("assistant_message", "world", 3)] }), "Hello world");
});

test("A,T1,B,T2,C: toTimeline, mergeLiveItem and coalesceReplies agree (a second thought is a new row)", async () => {
  const { toTimeline } = await import("../server/backend/runner-backend.mjs");
  const want = ["assistant_message:ABC", "reasoning:T1", "reasoning:T2"];
  const ev1 = (seq, type, text) => ({ seq, ts: 1000 + seq, type, text });
  const fromRunner = toTimeline([ev1(1, "output", "A"), ev1(2, "thought", "T1"), ev1(3, "output", "B"), ev1(4, "thought", "T2"), ev1(5, "output", "C")]);
  assert.deepEqual(summary(fromRunner), want);
  let live = [];
  for (const [t, x, s] of [["assistant_message", "A", 1], ["reasoning", "T1", 2], ["assistant_message", "B", 3], ["reasoning", "T2", 4], ["assistant_message", "C", 5]]) live = apply(live, ev({ type: t, text: x }, s));
  assert.deepEqual(summary(live), want);
  const row = (type, text, a) => ({ item: { type, text }, seqStart: a, seqEnd: a });
  const projected = coalesceReplies([row("assistant_message", "A", 1), row("reasoning", "T1", 2), row("assistant_message", "B", 3), row("reasoning", "T2", 4), row("assistant_message", "C", 5)]);
  assert.deepEqual(summary(projected), want);
  // a T2 that starts with T1 must not overwrite it either
  let snap = apply(apply(apply([], ev({ type: "assistant_message", text: "A" }, 1)), ev({ type: "reasoning", text: "T" }, 2)), ev({ type: "assistant_message", text: "B" }, 3));
  snap = apply(snap, ev({ type: "reasoning", text: "T and more" }, 4));
  assert.deepEqual(summary(snap), ["assistant_message:AB", "reasoning:T", "reasoning:T and more"]);
});

test("coalesce only merges when a thought separates the pieces; segStart only moves on a new segment", async () => {
  const row = (type, text, a) => ({ item: { type, text }, seqStart: a, seqEnd: a });
  // (a) B and C are adjacent with no thought between them: they stay two messages
  assert.deepEqual(summary(coalesceReplies([row("assistant_message", "A", 10), row("reasoning", "T", 11), row("assistant_message", "B", 12), row("assistant_message", "C", 13)])), ["assistant_message:AB", "reasoning:T", "assistant_message:C"]);
  // (b) joinPages never joins two plain assistant messages
  assert.deepEqual(summary(joinPages([row("assistant_message", "A", 10)], [row("assistant_message", "B", 11)])), ["assistant_message:A", "assistant_message:B"]);
  assert.deepEqual(summary(joinPages([row("assistant_message", "A", 10), row("reasoning", "T", 11)], [row("assistant_message", "B", 12)])), ["assistant_message:AB", "reasoning:T"]);
  // (c) Hello / T / wor / ld through the runner, then a live cumulative snapshot of the post-thought segment
  const { toTimeline } = await import("../server/backend/runner-backend.mjs");
  const ev1 = (seq, type, text) => ({ seq, ts: 1000 + seq, type, text });
  const built = toTimeline([ev1(10, "output", "Hello "), ev1(11, "thought", "T"), ev1(12, "output", "wor"), ev1(13, "output", "ld")]);
  assert.equal(built[0].item.text, "Hello world");
  assert.equal(built[0].segStart, 6);
  const live = apply(built, ev({ type: "assistant_message", text: "world!" }, 14));
  assert.equal(live[0].item.text, "Hello world!");
});

test("entryIndexForSeq prefers the row whose range holds the seq; hasMoreOf uses the raw page", async () => {
  const { entryIndexForSeq, hasMoreOf } = await import("../src/timelineFilter.ts");
  const e = [{ item: { type: "assistant_message" }, seqStart: 10, seqEnd: 12 }, { item: { type: "reasoning" }, seqStart: 11, seqEnd: 11 }];
  assert.equal(entryIndexForSeq(e, 12), 0);
  assert.equal(entryIndexForSeq(e, 11), 0);
  assert.equal(entryIndexForSeq(e, 99), 1); // beyond every range: the old "last row at or before" rule
  assert.equal(hasMoreOf({ entries: new Array(60).fill({}) }), true);
  assert.equal(hasMoreOf({ entries: new Array(10).fill({}) }), false);
  assert.equal(hasMoreOf({ hasOlder: false, entries: new Array(60).fill({}) }), false);
});
