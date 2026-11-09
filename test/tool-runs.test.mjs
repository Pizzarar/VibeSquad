import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatToolNames,
  formatToolRunLabel,
  groupToolRuns,
  isFailedTool,
  isFoldableToolEntry,
  isRunningTool,
  isSubAgentTool,
  toolRunToggleKey,
  uniqueToolNames,
} from "../src/toolRuns.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tc = (name, extra = {}, detail = {}, seqStart = undefined) => ({
  item: { type: "tool_call", name, status: "completed", detail, ...extra },
  ...(seqStart !== undefined ? { seqStart } : {}),
});

const msg = (type, text, seqStart = undefined) => ({
  item: { type, text },
  ...(seqStart !== undefined ? { seqStart } : {}),
});

test("single successful tool call is never folded", () => {
  const entries = [
    msg("user_message", "hi", 1),
    tc("Grep", {}, { query: "foo" }, 2),
    msg("assistant_message", "done", 3),
  ];
  const grouped = groupToolRuns(entries, true);
  assert.equal(grouped.length, 3);
  assert.deepEqual(
    grouped.map((g) => g.kind),
    ["entry", "entry", "entry"],
  );
  assert.equal(grouped[1].entry, entries[1]);
  assert.equal(grouped[1].index, 1);
});

test("2+ consecutive successful tool calls fold into one run with unique truncated names", () => {
  const entries = [
    msg("user_message", "find & edit", 1),
    tc("Grep", {}, {}, 2),
    tc("Grep", {}, {}, 3),
    tc("PowerShell", {}, {}, 4),
    tc("Edit", {}, {}, 5),
    tc("Read", {}, {}, 6),
    msg("assistant_message", "updated", 7),
  ];
  const grouped = groupToolRuns(entries, true);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].kind, "entry");
  assert.equal(grouped[1].kind, "run");
  assert.equal(grouped[1].count, 5);
  assert.equal(grouped[1].startIndex, 1);
  assert.deepEqual(grouped[1].names, ["Grep", "PowerShell", "Edit", "Read"]);
  assert.equal(grouped[1].truncatedNames, "Grep, PowerShell, Edit…");
  assert.equal(grouped[1].label, "5 tool calls · Grep, PowerShell, Edit…");
  assert.equal(grouped[2].kind, "entry");
  assert.equal(grouped[2].index, 6);
});

test("2 consecutive calls with <=3 unique names do not add ellipsis", () => {
  const entries = [tc("Grep"), tc("PowerShell"), tc("Grep")];
  const grouped = groupToolRuns(entries, true);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "run");
  assert.equal(grouped[0].count, 3);
  assert.deepEqual(grouped[0].names, ["Grep", "PowerShell"]);
  assert.equal(grouped[0].truncatedNames, "Grep, PowerShell");
  assert.equal(grouped[0].label, "3 tool calls · Grep, PowerShell");
});

test("failed tool call breaks the run and stays its own entry", () => {
  const entries = [
    tc("Grep", {}, {}, 1),
    tc("Read", {}, {}, 2),
    tc("PowerShell", { status: "failed", error: "exit 1" }, { exitCode: 1 }, 3),
    tc("Edit", {}, {}, 4),
    tc("Write", {}, {}, 5),
  ];
  const grouped = groupToolRuns(entries, true);
  assert.deepEqual(
    grouped.map((g) => (g.kind === "run" ? `run:${g.count}` : `entry:${g.entry.item.name}`)),
    ["run:2", "entry:PowerShell", "run:2"],
  );
  // When a failure splits a sequence leaving only 1 call on one side, that single call stays unfolded.
  const withSingleAfter = [
    tc("Grep"),
    tc("Read"),
    tc("Bash", {}, { exitCode: 2 }),
    tc("Edit"),
  ];
  assert.deepEqual(
    groupToolRuns(withSingleAfter, true).map((g) => (g.kind === "run" ? `run:${g.count}` : `entry:${g.entry.item.name}`)),
    ["run:2", "entry:Bash", "entry:Edit"],
  );
});

test("running / in-progress / pending tool call stays visible and breaks the run", () => {
  for (const status of ["running", "in_progress", "pending"]) {
    assert.equal(isRunningTool({ type: "tool_call", name: "Bash", status }), true);
    assert.equal(isFoldableToolEntry(tc("Bash", { status })), false);
  }
  const entries = [
    tc("Grep"),
    tc("Read"),
    tc("Bash", { status: "running" }),
  ];
  const grouped = groupToolRuns(entries, true);
  assert.deepEqual(
    grouped.map((g) => (g.kind === "run" ? `run:${g.count}` : `entry:${g.entry.item.name}`)),
    ["run:2", "entry:Bash"],
  );
});

test("sub-agent tool call is not folded into a tool run", () => {
  assert.equal(isSubAgentTool({ name: "Task" }, {}), true);
  assert.equal(isSubAgentTool({ name: "Agent" }, { type: "sub_agent" }), true);
  const entries = [
    tc("create_agent"),
    tc("create_agent"),
    tc("Agent", { status: "completed" }, { type: "sub_agent", subAgentType: "Explore" }),
    tc("Read"),
  ];
  const grouped = groupToolRuns(entries, true);
  assert.deepEqual(
    grouped.map((g) => (g.kind === "run" ? `run:${g.count}` : `entry:${g.entry.item.name}`)),
    ["run:2", "entry:Agent", "entry:Read"],
  );
});

test("pref off (collapseToolCalls = false) leaves every row unchanged", () => {
  const entries = [tc("Grep"), tc("PowerShell"), tc("Edit")];
  const grouped = groupToolRuns(entries, false);
  assert.equal(grouped.length, 3);
  assert.ok(grouped.every((g, i) => g.kind === "entry" && g.entry === entries[i] && g.index === i));
});

test("keyboard helper and Timeline wiring: aria-expanded, Enter/Space, collapseToolCalls gate", () => {
  assert.equal(toolRunToggleKey("Enter"), true);
  assert.equal(toolRunToggleKey(" "), true);
  assert.equal(toolRunToggleKey("Escape"), false);
  assert.deepEqual(uniqueToolNames([tc("Read"), tc("Read"), tc("")]), ["Read", "tool"]);
  assert.equal(formatToolNames(["A", "B", "C", "D"], 3), "A, B, C…");
  assert.equal(formatToolRunLabel(4, ["A", "B", "C", "D"], 3), "4 tool calls · A, B, C…");
  assert.equal(isFailedTool({ status: "completed" }, { exitCode: 0 }), false);

  const tl = fs.readFileSync(path.join(root, "src/Timeline.tsx"), "utf8");
  assert.match(tl, /groupToolRuns/);
  assert.match(tl, /data-testid="tl-tool-run"/);
  assert.match(tl, /aria-expanded=/);
});
