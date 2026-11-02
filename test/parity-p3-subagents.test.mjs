import assert from "node:assert/strict";
import test from "node:test";
import { mergeSubagents, scrapedSubagents, sortSubagents, subagentSignature, subagentStatusLabel, subagentTitle } from "../src/paseoSubagentsLogic.ts";

const isSub = (it, d) => d.type === "sub_agent";
const tc = (callId, status, extra = {}) => ({ item: { type: "tool_call", callId, status, detail: { type: "sub_agent", ...extra } } });

test("status labels", () => {
  assert.equal(subagentStatusLabel("completed"), "done");
  assert.equal(subagentStatusLabel("running"), "running");
  assert.equal(subagentStatusLabel(null), "");
  assert.equal(subagentStatusLabel("weird"), "weird");
});

test("title falls back title -> description -> subtitle -> id", () => {
  assert.equal(subagentTitle({ id: "abcdefghij", title: " T ", description: "D" }), "T");
  assert.equal(subagentTitle({ id: "abcdefghij", title: null, description: "D" }), "D");
  assert.equal(subagentTitle({ id: "abcdefghij", title: null, description: null, subtitle: "S" }), "S");
  assert.equal(subagentTitle({ id: "abcdefghij" }), "sub-agent abcdefgh");
});

test("merge: api wins, scraped-only kept, toolCallId dedupes", () => {
  const rows = mergeSubagents(
    [{ id: "a", title: "API A", status: "completed", updatedAt: "2026-01-01", toolCallId: "call1" }],
    [{ id: "a", title: "scraped A" }, { id: "call1", title: "dup by tool call" }, { id: "b", title: "scraped B", status: "running" }],
  );
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
  assert.equal(rows.find((r) => r.id === "a").title, "API A");
  assert.equal(rows.find((r) => r.id === "b").fromApi, false);
});

test("merge handles null / empty", () => {
  assert.deepEqual(mergeSubagents(null, []), []);
  assert.deepEqual(mergeSubagents([], undefined), []);
});

test("sort: running first, then newest, then title", () => {
  const mk = (id, status, updatedAt, title = id) => ({ id, title, status, updatedAt, fromApi: true });
  const out = sortSubagents([mk("old", "completed", "2026-01-01"), mk("new", "completed", "2026-02-01"), mk("run", "running", "2025-01-01")]);
  assert.deepEqual(out.map((r) => r.id), ["run", "new", "old"]);
});

test("signature changes when a sub_agent appears or finishes, not for other tools", () => {
  const base = [tc("c1", "running"), { item: { type: "tool_call", callId: "x", status: "running", detail: { type: "shell" } } }];
  const s1 = subagentSignature(base, isSub);
  assert.equal(subagentSignature([...base, { item: { type: "assistant_message" } }], isSub), s1);
  assert.notEqual(subagentSignature([tc("c1", "completed"), base[1]], isSub), s1);
  assert.notEqual(subagentSignature([...base, tc("c2", "running")], isSub), s1);
});

test("scraped ids prefer subAgentId over callId", () => {
  const out = scrapedSubagents([tc("c1", "running", { subAgentId: "s1", description: "do it" })], isSub);
  assert.deepEqual(out, [{ id: "s1", title: "do it", status: "running" }]);
});

test("scraped ids honor it.subagentId like isSubAgentTool", () => {
  const e = { item: { type: "tool_call", callId: "c9", subagentId: "s9", status: "running", detail: {} } };
  const out = scrapedSubagents([e], (it) => !!it.subagentId);
  assert.equal(out[0].id, "s9");
});

test("SubagentList is mounted outside the tl-head guard", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/Timeline.tsx", import.meta.url), "utf8");
  const head = src.indexOf("{(barOpen || pinnedTodo) && <div className=\"tl-head\">");
  const close = src.indexOf("</div>}", head);
  const at = src.indexOf("<SubagentList");
  assert.ok(head > 0 && close > head && at > close);
});
