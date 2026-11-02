import assert from "node:assert/strict";
import test from "node:test";
import { adjacentPrompt, entryIndexForSeq, filterEntries, localPrompts, localSearch, matchesFilter, sortedHits, stepIndex } from "../src/timelineFilter.ts";

const e = (item, seqStart) => ({ item, seqStart });
const entries = [
  e({ type: "user_message", text: "fix the Bug" }, 0),
  e({ type: "tool_call", name: "Bash", status: "completed" }, 2),
  e({ type: "tool_call", name: "Bash", status: "failed" }, 3),
  e({ type: "assistant_message", text: "bug fixed, bug gone" }, 5),
  e({ type: "error", message: "boom" }, 6),
];

test("filters pick the right item kinds", () => {
  assert.equal(filterEntries(entries, "all").length, 5);
  assert.deepEqual(filterEntries(entries, "text").map((x) => x.seqStart), [0, 5]);
  assert.deepEqual(filterEntries(entries, "tools").map((x) => x.seqStart), [2, 3]);
  assert.deepEqual(filterEntries(entries, "errors").map((x) => x.seqStart), [3, 6]);
  assert.equal(matchesFilter(null, "text"), false);
});

test("search hits sort, dedupe and map to entries", () => {
  const hits = sortedHits([{ seq: 5, role: "assistant" }, { seq: 0, role: "user" }, { seq: 5, role: "assistant" }]);
  assert.deepEqual(hits.map((h) => h.seq), [0, 5]);
  assert.equal(entryIndexForSeq(entries, 3), 2);
  assert.equal(entryIndexForSeq(entries, 4), 2); // between entries: the one containing it
  assert.equal(entryIndexForSeq([e({}, 10)], 4), -1);
});

test("step wraps and handles empty", () => {
  assert.equal(stepIndex(-1, 1, 3), 0);
  assert.equal(stepIndex(-1, -1, 3), 2);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(0, 1, 0), -1);
});

test("prompt navigation and local search", () => {
  const prompts = [{ seq: 10 }, { seq: 0 }, { seq: 20 }];
  assert.equal(adjacentPrompt(prompts, 10, 1).seq, 20);
  assert.equal(adjacentPrompt(prompts, 10, -1).seq, 0);
  assert.equal(adjacentPrompt(prompts, 20, 1), null);
  assert.equal(adjacentPrompt(prompts, -1, -1), null);
  assert.deepEqual(localSearch(entries, "BUG"), [{ seq: 0, role: "user", count: 1 }, { seq: 5, role: "assistant", count: 2 }]);
  assert.deepEqual(localSearch(entries, " "), []);
  assert.deepEqual(localPrompts(entries), [{ seq: 0, timestamp: "", preview: "fix the Bug" }]);
});
