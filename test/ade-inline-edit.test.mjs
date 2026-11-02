import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const I = await import("../src/inlineEditLogic.ts");
const H = await import("../src/hunkUndo.ts");
const K = await import("../src/keymap.ts");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

const L = (...xs) => xs.map((x) => x + "\n").join("");
const headers = (hs) => hs.map((h) => h.lines[0].content);

// ---- line ranges ----

test("lineRangeFromOffsets: partial lines, trailing newline, caret, reversed", () => {
  const t = L("aa", "bb", "cc", "dd");
  assert.deepEqual(I.lineRangeFromOffsets(t, 1, 7), { from: 1, to: 3 }, "mid-line to mid-line");
  assert.deepEqual(I.lineRangeFromOffsets(t, 3, 9), { from: 2, to: 3 }, "ends right after a newline: next line not included");
  assert.deepEqual(I.lineRangeFromOffsets(t, 4, 4), { from: 2, to: 2 }, "caret = its line");
  assert.deepEqual(I.lineRangeFromOffsets(t, 9, 3), { from: 2, to: 3 }, "reversed");
  assert.deepEqual(I.lineRangeFromOffsets(t, 0, t.length), { from: 1, to: 4 }, "select all");
  assert.deepEqual(I.lineRangeFromOffsets("a\r\nb\r\n", 0, 6), { from: 1, to: 2 }, "CRLF");
  assert.deepEqual(I.lineRangeFromOffsets("", 0, 0), { from: 1, to: 1 }, "empty file");
});

test("clampRange + sliceLines + rangeLabel", () => {
  assert.deepEqual(I.clampRange({ from: 9, to: 2 }, 5), { from: 2, to: 5 });
  assert.deepEqual(I.clampRange({ from: 0, to: 0 }, 0), { from: 1, to: 1 });
  assert.equal(I.sliceLines(L("a", "b", "c"), { from: 2, to: 3 }), "b\nc");
  assert.equal(I.sliceLines("a\r\nb\r\nc", { from: 1, to: 2 }), "a\nb");
  assert.equal(I.rangeLabel({ from: 4, to: 4 }), "line 4");
  assert.equal(I.rangeLabel({ from: 4, to: 9 }), "lines 4–9");
});

// ---- prompt ----

test("buildInlineEditPrompt: wording, range, safe fence", () => {
  const p = I.buildInlineEditPrompt("src/a.ts", { from: 3, to: 5 }, "  rename x to count.  ", "let x = 1;\nx++;\nreturn x;");
  assert.equal(
    p,
    "Edit src/a.ts lines 3–5: rename x to count. Only change those lines unless needed. Here is the current selection:\n```\nlet x = 1;\nx++;\nreturn x;\n```\n",
  );
  const withTicks = I.buildInlineEditPrompt("README.md", { from: 1, to: 1 }, "fix", "````js\ncode\n````");
  assert.match(withTicks, /^Edit README\.md line 1: fix\./);
  assert.match(withTicks, /\n`````\n````js\ncode\n````\n`````\n$/, "fence is longer than the selection's backtick run");
});

// ---- targets ----

test("editTargets: cwd must contain the file; path is relative to each agent; preferred first; archived and closed out", () => {
  const agents = [
    { id: "a1", cwd: "C:\\repo", title: "Lead" },
    { id: "a2", cwd: "C:/Repo/sub", title: "Sub" },
    { id: "a3", cwd: "C:\\repo-other", title: "Other" },
    { id: "a4", cwd: "C:\\repo", title: "Old", archivedAt: "2026-01-01" },
    { id: "a5", cwd: "C:\\repo\\sub\\", title: "" },
    { id: "a6", cwd: "C:\\repo", title: "Closed", status: "closed" },
  ];
  const t = I.editTargets(agents, "C:\\repo", "sub/x.ts", "a2");
  assert.deepEqual(t.map((x) => x.id), ["a2", "a1", "a5"]);
  assert.deepEqual(t.map((x) => x.rel), ["x.ts", "sub/x.ts", "x.ts"]);
  assert.equal(t[2].title, "a5", "untitled agent falls back to its id");
  assert.deepEqual(I.editTargets(agents, "C:\\repo", "top.ts").map((x) => x.id), ["a1"]);
  assert.deepEqual(I.editTargets([{ id: "p", cwd: "/home/u/r" }], "/home/u/r", "a/b.ts").map((x) => x.rel), ["a/b.ts"]);
  assert.equal(I.relativeTo("/home/u/r", "/home/u/R/a"), null, "POSIX paths stay case-sensitive");
});

// ---- snapshot diff → hunks ----

test("diffHunks: matches git numbering for change / insert / delete / two hunks", () => {
  const before = L("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20");
  const changed = before.replace("5\n", "five\n").replace("17\n", "seventeen\n");
  assert.deepEqual(headers(I.diffHunks(before, changed)), ["@@ -2,7 +2,7 @@", "@@ -14,7 +14,7 @@"]);
  // Close changes merge into one hunk (gap <= 6 context lines).
  const near = before.replace("5\n", "five\n").replace("10\n", "ten\n");
  assert.deepEqual(headers(I.diffHunks(before, near)), ["@@ -2,12 +2,12 @@"]);
  assert.deepEqual(headers(I.diffHunks(L("a", "b"), L("a", "x", "b"))), ["@@ -1,2 +1,3 @@"]);
  assert.deepEqual(headers(I.diffHunks(L("a"), "")), ["@@ -1,1 +0,0 @@"], "deleting everything");
  assert.deepEqual(headers(I.diffHunks("", L("a", "b"))), ["@@ -0,0 +1,2 @@"], "new content in an empty file");
  assert.deepEqual(I.diffHunks(L("same"), L("same")), []);
  assert.deepEqual(I.diffHunks("a\r\nb\r\n", "a\nb\n"), [], "line endings alone aren't a change");
  const ins = I.diffHunks(L("a", "b", "c", "d", "e"), L("a", "b", "c", "d", "e", "f"))[0];
  assert.deepEqual(ins.lines.slice(1).map((l) => l.type), ["context", "context", "context", "add"]);
});

test("diffHunks + undoHunk round-trip: each hunk alone, and all together", () => {
  const before = L("import a", "", "function f() {", "  let x = 1;", "  x++;", "  return x;", "}", "", "a", "b", "c", "d", "e", "f", "g", "end");
  const after = L("import a", "import b", "", "function f() {", "  let count = 1;", "  count += 1;", "  return count;", "}", "", "a", "b", "c", "d", "e", "f", "end", "tail");
  const hunks = I.diffHunks(before, after);
  assert.ok(hunks.length >= 2, "separate hunks");
  for (const h of hunks) {
    const r = H.undoHunk(after, h);
    assert.ok(r.ok, "every hunk applies to the current file");
    // Undoing one hunk leaves exactly the others: re-diffing gives the remaining hunks.
    assert.equal(I.diffHunks(before, r.content).length, hunks.length - 1);
  }
  const all = H.undoHunks(after, hunks);
  assert.ok(all.ok);
  assert.equal(all.content, before);
});

test("undo keeps CRLF and a missing final newline", () => {
  const before = "a\r\nb\r\nc";
  const after = "a\r\nB\r\nc";
  const [h] = I.diffHunks(before, after);
  const r = H.undoHunk(after, h);
  assert.ok(r.ok);
  assert.equal(r.content, before);
});

test("big middles fall back to one replace hunk instead of a huge LCS table", () => {
  const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n") + "\n";
  const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n") + "\n";
  const hs = I.diffHunks(a, b);
  assert.equal(hs.length, 1);
  assert.deepEqual(I.hunkStats(hs), { add: 2500, del: 2500 });
  const r = H.undoHunk(b, hs[0]);
  assert.ok(r.ok);
  assert.equal(r.content, a);
});

test("snapshotHunkKey: stable after an earlier hunk is undone", () => {
  const before = L("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20");
  const after = before.replace("3\n", "3a\n3b\n3c\n").replace("17\n", "seventeen\n");
  const [h1, h2] = I.diffHunks(before, after);
  const r = H.undoHunk(after, h1);
  assert.ok(r.ok);
  const [h2again] = I.diffHunks(before, r.content);
  assert.notEqual(h2again.newStart, h2.newStart, "the later hunk moved");
  assert.equal(I.snapshotHunkKey("f", h2again), I.snapshotHunkKey("f", h2));
  assert.notEqual(I.snapshotHunkKey("f", h1), I.snapshotHunkKey("f", h2));
});

// ---- wiring ----

test("keymap: inline edit is a rebindable Ctrl+K scoped to the Files editor, beating the palette there only", () => {
  const cmd = K.KEY_COMMANDS.find((c) => c.id === "inlineEdit");
  assert.ok(cmd);
  assert.equal(cmd.scope, "files-editor");
  assert.deepEqual(cmd.defaults, ["Ctrl+K"]);
  const b = K.effectiveBindings({});
  assert.equal(K.resolveCommand("Ctrl+K", b, ["files-editor"]), "inlineEdit");
  assert.equal(K.resolveCommand("Ctrl+K", b, []), "palette");
  assert.equal(K.findConflicts(b).size, 0);
  const moved = K.effectiveBindings(K.setBinding({}, "inlineEdit", ["Ctrl+Alt+E"]));
  assert.equal(K.resolveCommand("Ctrl+K", moved, ["files-editor"]), "palette", "rebinding frees Ctrl+K in the editor");
  assert.equal(K.resolveCommand("Ctrl+Alt+E", moved, ["files-editor"]), "inlineEdit");
});

test("FilesPanel / InlineEdit wiring: keyscope, key-command event, existing send path, mtime-checked undo", () => {
  const fp = src("FilesPanel.tsx");
  assert.match(fp, /data-keyscope="files-editor"/);
  assert.match(fp, /KEY_COMMAND_EVENT/);
  const ie = src("InlineEdit.tsx");
  assert.match(ie, /sendMessage\(/, "uses the composer's send path");
  assert.doesNotMatch(ie, /spawnTeamAgent|createAgent|SpawnRequest/, "no new spawn paths");
  assert.match(ie, /subscribeFile\(/);
  assert.match(ie, /expectedModifiedAt/);
  assert.match(ie, /openRightDockTab\("Changes"\)/);
});
