import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffStats, foldLines, formatDuration, summarizeTools, toolDurationMs, toolKind, TOOL_OUTPUT_FOLD_LINES } from "../src/toolRows.ts";
import { toolStartsExpanded } from "../src/prefs.ts";
import { isFailedTool } from "../src/toolRuns.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tc = (name, extra = {}, detail = {}) => ({ type: "tool_call", name, status: "completed", detail, ...extra });

test("summary: counts, edits with +/-, failures and total duration", () => {
  const items = [
    tc("Grep", { durationMs: 500 }, { query: "x" }),
    tc("Edit", { durationMs: 700 }, { filePath: "a.ts", unifiedDiff: "@@\n-old\n+new1\n+new2\n ctx" }),
    tc("Bash", { status: "failed", durationMs: 800 }, { type: "shell", command: "tsc", exitCode: 2 }),
  ];
  assert.equal(summarizeTools(items), "3 tools · 1 edit (+2 −1) · 1 failed · 2.0s");
});

test("summary omits unknown segments instead of faking them", () => {
  assert.equal(summarizeTools([tc("Grep"), tc("Read")]), "2 tools");
  assert.equal(summarizeTools([tc("Edit", {}, { filePath: "a" }), tc("Edit", {}, { filePath: "b" })]), "2 tools · 2 edits");
});

test("diff stats ignore file headers; absent without data", () => {
  assert.deepEqual(diffStats({ unifiedDiff: "--- a\n+++ b\n-x\n+y\n+z" }), { add: 2, del: 1 });
  assert.deepEqual(diffStats({ oldString: "a", newString: "a\nb" }), { add: 2, del: 1 });
  assert.equal(diffStats({ filePath: "a" }), null);
});

test("kind and duration derivation", () => {
  assert.equal(toolKind(tc("PowerShell", {}, { type: "shell" })), "shell");
  assert.equal(toolKind(tc("Edit")), "edit");
  assert.equal(toolKind(tc("Grep")), "search");
  assert.equal(toolDurationMs(tc("x", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:02Z" })), 2000);
  assert.equal(toolDurationMs(tc("x")), null);
  assert.equal(formatDuration(3100), "3.1s");
  assert.equal(formatDuration(250), "250ms");
});

test("failed rows auto-expand even when collapse pref is on", () => {
  const failed = tc("Bash", { status: "failed" });
  assert.equal(isFailedTool(failed), true);
  assert.equal(toolStartsExpanded(true, true), true);
  assert.equal(toolStartsExpanded(false, true), false);
});

test("output folds at 12 lines", () => {
  assert.equal(TOOL_OUTPUT_FOLD_LINES, 12);
  const text = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const f = foldLines(text);
  assert.equal(f.head.split("\n").length, 12);
  assert.equal(f.hidden, 8);
  assert.equal(foldLines("a\nb").hidden, 0);
});

test("Timeline wires Normal-only rendering with the required test ids", () => {
  const src = fs.readFileSync(path.join(root, "src/Timeline.tsx"), "utf8");
  for (const id of ["boring-toolgroup-summary", "boring-toolrow", "tl-tool-run", "tl-tool-row", "tl-tool-detail"]) assert.ok(src.includes(`"${id}"`), id);
  assert.match(src, /if \(boring\) \{\s*const kind = toolKind/);
  assert.match(src, /Show \$\{hidden\} more lines/);
});
