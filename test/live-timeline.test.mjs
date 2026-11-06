import assert from "node:assert/strict";
import test from "node:test";
import { defaultSpawnConfigFor } from "../src/antigravity.ts";
import { filterEntries, latestReasoningIndex, mergeLiveItem, reasoningText } from "../src/timelineFilter.ts";

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

test("live text -> thought -> text stays one assistant message", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "Hello " }, 1));
  e = apply(e, ev({ type: "reasoning", text: "hmm" }, 2));
  e = apply(e, ev({ type: "assistant_message", text: "world" }, 3));
  const said = e.filter((x) => x.item.type === "assistant_message");
  assert.equal(said.length, 1);
  assert.equal(said[0].item.text, "Hello world");
  assert.equal(filterEntries(e, "all").length, e.length);
});

test("rejoined segment judges snapshots against its own text only", () => {
  // cumulative snapshots after a thought: no duplication
  let e = apply(base, ev({ type: "assistant_message", text: "Hello " }, 1));
  e = apply(e, ev({ type: "reasoning", text: "hmm" }, 2));
  for (const [t, s] of [["wor", 3], ["world", 4], ["world!", 5]]) e = apply(e, ev({ type: "assistant_message", text: t }, s));
  assert.equal(e.at(-1).item.text, "Hello world!");
  // a segment that starts with the first segment's text must not truncate it
  let f = apply(base, ev({ type: "assistant_message", text: "Yes" }, 1));
  f = apply(f, ev({ type: "reasoning", text: "hmm" }, 2));
  f = apply(f, ev({ type: "assistant_message", text: "Yes, I checked" }, 3));
  f = apply(f, ev({ type: "assistant_message", text: "Yes, I checked it" }, 4));
  assert.equal(f.at(-1).item.text, "YesYes, I checked it");
});

test("no rejoin across a user message, a seq gap, or a different message id", () => {
  let e = apply(base, ev({ type: "assistant_message", text: "A" }, 1));
  e = apply(e, ev({ type: "reasoning", text: "t" }, 2));
  e = apply(e, ev({ type: "user_message", text: "next" }, 3));
  e = apply(e, ev({ type: "assistant_message", text: "B" }, 4));
  assert.deepEqual(e.slice(1).map((x) => x.item.type + ":" + x.item.text), ["assistant_message:A", "reasoning:t", "user_message:next", "assistant_message:B"]);
  let g = apply(base, ev({ type: "assistant_message", text: "A" }, 1));
  g = apply(g, ev({ type: "reasoning", text: "t" }, 2));
  g = apply(g, ev({ type: "assistant_message", text: "B" }, 9));
  assert.equal(g.filter((x) => x.item.type === "assistant_message").length, 2);
  let h = apply(base, ev({ type: "assistant_message", text: "A", messageId: "m1" }, 1));
  h = apply(h, ev({ type: "reasoning", text: "t" }, 2));
  h = apply(h, ev({ type: "assistant_message", text: "B", messageId: "m2" }, 3));
  assert.equal(h.filter((x) => x.item.type === "assistant_message").length, 2);
});

test("rejoined reply ends the list with the thought moved ahead of it", () => {
  let e = apply(base, ev({ type: "reasoning", text: "T1" }, 1));
  e = apply(e, ev({ type: "assistant_message", text: "A" }, 2));
  e = apply(e, ev({ type: "reasoning", text: "T2" }, 3));
  e = apply(e, ev({ type: "assistant_message", text: "B" }, 4));
  assert.deepEqual(e.slice(1).map((x) => x.item.type + ":" + x.item.text), ["reasoning:T1", "reasoning:T2", "assistant_message:AB"]);
  assert.equal(latestReasoningIndex(e), 2); // the finished reply is last, so no thought sits under it
});

test("a projected refetch of text -> thought -> text yields one reply, with the same guards", async () => {
  const { coalesceReplies } = await import("../src/timelineFilter.ts");
  const row = (type, text, a, b = a, extra = {}) => ({ item: { type, text, ...extra }, seqStart: a, seqEnd: b });
  const out = coalesceReplies([row("user_message", "hi", 0), row("assistant_message", "Hello ", 1), row("reasoning", "hmm", 2), row("assistant_message", "world", 3, 5)]);
  assert.deepEqual(out.map((x) => x.item.type + ":" + x.item.text), ["user_message:hi", "reasoning:hmm", "assistant_message:Hello world"]);
  assert.equal(out[2].seqStart, 1);
  assert.equal(out[2].seqEnd, 5);
  const types = (l) => l.map((x) => x.item.type);
  // user message between, seq gap, different message id: left as separate rows
  assert.deepEqual(types(coalesceReplies([row("assistant_message", "A", 1), row("reasoning", "t", 2), row("user_message", "q", 3), row("assistant_message", "B", 4)])), ["assistant_message", "reasoning", "user_message", "assistant_message"]);
  assert.equal(coalesceReplies([row("assistant_message", "A", 1), row("reasoning", "t", 2), row("assistant_message", "B", 9)]).length, 3);
  assert.equal(coalesceReplies([row("assistant_message", "A", 1, 1, { messageId: "m1" }), row("reasoning", "t", 2), row("assistant_message", "B", 3, 3, { messageId: "m2" })]).length, 3);
});
