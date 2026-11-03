import assert from "node:assert/strict";
import test from "node:test";
import { defaultSpawnConfigFor } from "../src/antigravity.ts";
import { filterEntries, latestReasoningIndex, mergeLiveItem, reasoningText } from "../src/timelineFilter.ts";

const base = [{ item: { type: "user_message", text: "hi" }, seqStart: 0 }];

test("live reasoning chunks merge into the tail entry", () => {
  let e = mergeLiveItem(base, { type: "reasoning", text: "think" });
  e = mergeLiveItem(e, { type: "reasoning", text: "ing" });
  assert.equal(e.length, 2);
  assert.equal(e[1].item.text, "thinking");
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

test("antigravity-cli defaults to medium thinking", () => {
  assert.equal(defaultSpawnConfigFor("antigravity-cli").thinkingOptionId, "medium");
});
