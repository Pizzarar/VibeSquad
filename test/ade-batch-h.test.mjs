import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRewindRequest,
  exportFileName,
  forkSummaryPrompt,
  forkTitle,
  nextScheduleStatus,
  popClosed,
  pushClosed,
  rewindMessageId,
  scheduleActionsFor,
  transcriptToJson,
  transcriptToMarkdown,
  truncateAfter,
  CLOSED_TABS_MAX,
} from "../src/sessionLifecycle.ts";

const entries = [
  { seqStart: 1, timestamp: "t1", item: { type: "user_message", text: "hello" } },
  { seqStart: 2, timestamp: "t2", item: { type: "assistant_message", text: "hi there" } },
  { seqStart: 3, item: { type: "tool_call", name: "Read" } },
  { seqStart: 4, item: { type: "user_message", text: "again", messageId: "m4" } },
];

test("H1: rewind id prefers messageId, falls back to seq", () => {
  assert.equal(rewindMessageId(entries[3]), "m4");
  assert.equal(rewindMessageId(entries[0]), "1");
  assert.equal(rewindMessageId({ item: {} }), null);
});

test("H2: rewind request carries mode and only resends edited text", () => {
  const same = buildRewindRequest("a1", entries[0], "both", "hello");
  assert.deepEqual(same, { agentId: "a1", messageId: "1", mode: "both", resend: null });
  const edited = buildRewindRequest("a1", entries[0], "conversation", "hello world");
  assert.equal(edited.resend, "hello world");
  assert.equal(buildRewindRequest("a1", { item: {} }, "files"), null);
});

test("H3: demo rewind truncates entries after the message", () => {
  assert.equal(truncateAfter(entries, entries[1]).length, 2);
  assert.equal(truncateAfter(entries, { seqStart: 99 }).length, entries.length);
});

test("H4: markdown export has roles and skips non-message noise", () => {
  const md = transcriptToMarkdown("My Chat", entries);
  assert.ok(md.startsWith("# My Chat"));
  assert.match(md, /## User · t1\n\nhello/);
  assert.match(md, /## Assistant · t2\n\nhi there/);
  assert.match(md, /> tool: Read/);
});

test("H5: json export round-trips", () => {
  const parsed = JSON.parse(transcriptToJson("a1", "T", entries));
  assert.equal(parsed.agentId, "a1");
  assert.equal(parsed.exportedEntries, 4);
  assert.equal(parsed.entries.length, 4);
  assert.equal(exportFileName("Fix: the Bug!", "md"), "fix-the-bug.md");
  assert.equal(exportFileName("", "json"), "transcript.json");
});

test("H6: fork helpers", () => {
  assert.equal(forkTitle("Chat"), "⑂ Chat");
  assert.equal(forkTitle("⑂ Chat"), "⑂ Chat");
  const p = forkSummaryPrompt("Chat", entries, 2);
  assert.match(p, /Forked from "Chat"/);
  assert.match(p, /User: again/);
  assert.doesNotMatch(p, /User: hello/);
});

test("H7: schedule state transitions", () => {
  assert.deepEqual(scheduleActionsFor("active"), ["pause", "run"]);
  assert.deepEqual(scheduleActionsFor("paused"), ["resume", "run"]);
  assert.deepEqual(scheduleActionsFor("completed"), []);
  assert.equal(nextScheduleStatus("active", "pause"), "paused");
  assert.equal(nextScheduleStatus("paused", "resume"), "active");
  assert.equal(nextScheduleStatus("active", "run"), "active");
  assert.equal(nextScheduleStatus("paused", "pause"), "paused");
});

test("H8: closed-tab stack reopens newest first, skips open tabs, caps size", () => {
  let st = pushClosed([], "a");
  st = pushClosed(st, "b");
  st = pushClosed(st, "a");
  assert.deepEqual(st, ["b", "a"]);
  const r = popClosed(st, (id) => id === "a");
  assert.equal(r.id, "b");
  assert.deepEqual(r.rest, []);
  assert.deepEqual(popClosed([], () => false), { id: null, rest: [] });
  let big = [];
  for (let i = 0; i < CLOSED_TABS_MAX + 5; i++) big = pushClosed(big, `t${i}`);
  assert.equal(big.length, CLOSED_TABS_MAX);
  assert.equal(big.at(-1), `t${CLOSED_TABS_MAX + 4}`);
});
