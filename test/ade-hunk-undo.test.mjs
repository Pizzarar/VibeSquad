import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const H = await import("../src/hunkUndo.ts");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// Same rules as the daemon's parseSectionBody: prefixes stripped, "\ No newline" lines dropped.
function parseHunks(diffText) {
  const hunks = [];
  let cur = null;
  for (const line of diffText.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      cur = { oldStart: +m[1], oldCount: +(m[2] ?? 1), newStart: +m[3], newCount: +(m[4] ?? 1), lines: [{ type: "header", content: line }] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.lines.push({ type: "add", content: line.slice(1) });
    else if (line.startsWith("-")) cur.lines.push({ type: "remove", content: line.slice(1) });
    else if (line.startsWith(" ")) cur.lines.push({ type: "context", content: line.slice(1) });
  }
  return hunks;
}

/** Real git diff of before → after, parsed like the daemon does. */
function gitHunks(before, after) {
  const dir = mkdtempSync(join(tmpdir(), "vs-hunk-"));
  try {
    writeFileSync(join(dir, "a.txt"), before);
    writeFileSync(join(dir, "b.txt"), after);
    let out = "";
    try {
      out = execFileSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "a.txt", "b.txt"], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      out = e.stdout; // exit 1 = files differ
    }
    return parseHunks(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const L = (...xs) => xs.map((x) => x + "\n").join("");
const hunk = (oldStart, oldCount, newStart, newCount, body) => ({
  oldStart, oldCount, newStart, newCount,
  lines: [{ type: "header", content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` }, ...body.map(([t, c]) => ({ type: t, content: c }))],
});

test("add-only hunk: undo removes the added lines", () => {
  const before = L("a", "b", "c", "d");
  const after = L("a", "b", "NEW1", "NEW2", "c", "d");
  const [h] = gitHunks(before, after);
  const r = H.undoHunk(after, h);
  assert.ok(r.ok);
  assert.equal(r.content, before);
});

test("delete-only hunk: undo puts the deleted lines back", () => {
  const before = L("a", "b", "c", "d", "e");
  const after = L("a", "d", "e");
  const [h] = gitHunks(before, after);
  const r = H.undoHunk(after, h);
  assert.ok(r.ok);
  assert.equal(r.content, before);
});

test("mixed hunk: undo restores the replaced lines", () => {
  const before = L("one", "two", "three", "four");
  const after = L("one", "TWO", "2.5", "four");
  const [h] = gitHunks(before, after);
  const r = H.undoHunk(after, h);
  assert.ok(r.ok);
  assert.equal(r.content, before);
});

test("multiple hunks: undoing the top one shifts the next; lineOffset or a unique match finds it", () => {
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const changed = [...base];
  changed.splice(2, 0, "added A1", "added A2", "added A3"); // top hunk: +3
  changed[22] = "changed B"; // lower hunk (line 20 of base)
  const before = L(...base);
  const after = L(...changed);
  const hunks = gitHunks(before, after);
  assert.equal(hunks.length, 2);
  const [top, bottom] = hunks;

  const r1 = H.undoHunk(after, top);
  assert.ok(r1.ok);
  // Positions in `bottom` are from the old diff: 3 lines too low now.
  const offset = H.undoDelta(top);
  assert.equal(offset, -3);
  const r2 = H.undoHunk(r1.content, bottom, offset);
  assert.ok(r2.ok);
  assert.equal(r2.content, before);
  assert.equal(r2.at, bottom.newStart - 1 + offset);

  // Without the offset the unique exact match still lands it.
  const r3 = H.undoHunk(r1.content, bottom);
  assert.ok(r3.ok);
  assert.equal(r3.content, before);

  // Undo all, either order of the list.
  for (const list of [hunks, [...hunks].reverse()]) {
    const all = H.undoHunks(after, list);
    assert.ok(all.ok);
    assert.equal(all.content, before);
  }
});

test("CRLF file: line endings are kept and restored lines get CRLF", () => {
  const before = "a\r\nb\r\nc\r\nd\r\n";
  const after = "a\r\nB!\r\nnew\r\nc\r\nd\r\n";
  const hunks = gitHunks(before, after);
  assert.ok(hunks[0].lines.some((l) => l.content.endsWith("\r")), "git keeps the CR in diff lines");
  const r = H.undoHunk(after, hunks[0]);
  assert.ok(r.ok);
  assert.equal(r.content, before);

  // The same hunk with the CRs normalised away (autocrlf repos) applies too.
  const lf = { ...hunks[0], lines: hunks[0].lines.map((l) => ({ ...l, content: l.content.replace(/\r$/, "") })) };
  const r2 = H.undoHunk(after, lf);
  assert.ok(r2.ok);
  assert.equal(r2.content, before);
  assert.equal(H.dominantEol(after), "\r\n");
});

test("no trailing newline: the file keeps having none", () => {
  const before = "a\nb\nc";
  const after = "a\nB\nc";
  const [h] = gitHunks(before, after);
  const r = H.undoHunk(after, h);
  assert.ok(r.ok);
  assert.equal(r.content, before);

  // Change on the very last line (no newline).
  const before2 = "x\ny\nlast";
  const after2 = "x\ny\nLAST";
  const r2 = H.undoHunk(after2, gitHunks(before2, after2)[0]);
  assert.ok(r2.ok);
  assert.equal(r2.content, before2);

  // Lines added after a last line that has no newline.
  const before3 = "p\nq";
  const after3 = "p\nq\nr\ns";
  const r3 = H.undoHunk(after3, gitHunks(before3, after3)[0]);
  assert.ok(r3.ok);
  assert.equal(r3.content, before3);
});

test("pure deletion with no context: restores at the position", () => {
  // Whole file emptied: @@ -1,2 +0,0 @@
  const h = hunk(1, 2, 0, 0, [["remove", "a"], ["remove", "b"]]);
  const r = H.undoHunk("", h);
  assert.ok(r.ok);
  assert.equal(r.content, "a\nb\n");
  // The file has content again since: refuse rather than prepend.
  const stale = H.undoHunk("someone wrote this\n", h);
  assert.equal(stale.ok, false);
});

test("stale content: refuses instead of corrupting the file", () => {
  const before = L("a", "b", "c", "d", "e", "f");
  const after = L("a", "b", "X", "d", "e", "f");
  const [h] = gitHunks(before, after);
  // Someone edited the hunk's own lines after the diff was taken.
  const edited = L("a", "b", "Y", "d", "e", "f");
  const r = H.undoHunk(edited, h);
  assert.equal(r.ok, false);
  assert.match(r.error, /changed since this diff/);

  // Ambiguous: the hunk's current side appears twice and neither at the expected spot.
  const h2 = hunk(1, 1, 1, 2, [["context", "k"], ["add", "z"]]);
  const twice = L("q", "k", "z", "k", "z");
  const r2 = H.undoHunk(twice, h2);
  assert.equal(r2.ok, false);

  // undoHunks stops at the first stale hunk and reports it.
  const all = H.undoHunks(edited, [h]);
  assert.equal(all.ok, false);
});

test("hunkKey: stable per text and position, different for different hunks", () => {
  const a = hunk(3, 1, 3, 2, [["context", "x"], ["add", "y"]]);
  const b = hunk(3, 1, 3, 2, [["context", "x"], ["add", "z"]]);
  assert.equal(H.hunkKey("f.ts", a), H.hunkKey("f.ts", structuredClone(a)));
  assert.notEqual(H.hunkKey("f.ts", a), H.hunkKey("f.ts", b));
  assert.notEqual(H.hunkKey("f.ts", a), H.hunkKey("g.ts", a));
});

test("ideUrl: vscode uses forward slashes; jetbrains uses the Toolbox navigate form; none is null", () => {
  assert.equal(H.ideUrl("vscode", "C:\\Users\\me\\proj", "src/a b.ts", 12), "vscode://file/C:/Users/me/proj/src/a%20b.ts:12");
  assert.equal(H.ideUrl("vscode", "/home/me/proj", "src/a.ts", 3), "vscode://file/home/me/proj/src/a.ts:3");
  assert.equal(H.ideUrl("vscode", "/home/me/proj", "src/a.ts"), "vscode://file/home/me/proj/src/a.ts");
  assert.equal(
    H.ideUrl("jetbrains", "C:\\Users\\me\\My Proj\\", "src\\deep\\a.ts", 7),
    "jetbrains://idea/navigate/reference?project=My%20Proj&path=src/deep/a.ts:7",
  );
  assert.equal(H.ideUrl("none", "/x", "a", 1), null);
  assert.equal(H.absPath("C:\\w", "src/x.ts"), "C:\\w\\src\\x.ts");
});

test("wiring: Changes has per-hunk Keep/Undo, file Keep all/Undo all, Review spawns Review - Sonnet via spawnTeamAgent", () => {
  const s = src("ChangesPanel.tsx");
  for (const id of ["changes-hunk-keep", "changes-hunk-undo", "changes-file-keep-all", "changes-file-undo-all", "changes-review-diff-btn"]) {
    assert.ok(s.includes(`data-testid="${id}"`), id);
  }
  assert.match(s, /spawnTeamAgent\(/);
  assert.match(s, /"Review - Sonnet"/);
  assert.doesNotMatch(s, /agents\.create\(/, "no second spawn path");
  assert.match(s, /expectedModifiedAt/);
  assert.match(s, /status === "conflict"/);
});

test("wiring: open-in-IDE pref lives in Settings › App and shows in Changes and Files", async () => {
  const mem = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) },
    configurable: true, writable: true,
  });
  const P = await import("../src/prefs.ts");
  const d = P.prefDef("app.openInIde");
  assert.equal(d.section, "app");
  assert.deepEqual(d.options.map((o) => o.value), ["none", "vscode", "jetbrains"]);
  assert.equal(P.PREF_DEFAULTS["app.openInIde"], "none");
  assert.ok(src("ChangesPanel.tsx").includes('data-testid="changes-open-ide"'));
  assert.ok(src("FilesPanel.tsx").includes('data-testid="files-open-ide"'));
});

test("firstChangedLine, clientOnDaemonHost, diffAsText", () => {
  assert.equal(H.firstChangedLine(hunk(10, 4, 10, 5, [["context", "a"], ["context", "b"], ["add", "c"], ["context", "d"]])), 12);
  assert.equal(H.firstChangedLine(hunk(0, 0, 1, 1, [["add", "x"]])), 1);
  assert.equal(H.clientOnDaemonHost("localhost"), true);
  assert.equal(H.clientOnDaemonHost("203.0.113.20"), false);
  const d = H.diffAsText([{ path: "a.ts", hunks: [hunk(1, 1, 1, 1, [["remove", "x"], ["add", "y"]])] }]);
  assert.equal(d.text, "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n");
  assert.equal(H.diffAsText([{ path: "a.ts", hunks: [hunk(1, 1, 1, 1, [["add", "y".repeat(100)]])] }], 50).truncated, true);
});

test("ideUrl encodes #, ?, %, spaces per segment and keeps the drive letter and slashes", () => {
  assert.equal(
    H.ideUrl("vscode", "C:\\src\\C# 100%", "x?/a#b.cs", 4),
    "vscode://file/C:/src/C%23%20100%25/x%3F/a%23b.cs:4",
  );
  assert.equal(H.ideUrl("vscode", "/home/me/C#", "q?.ts", 1), "vscode://file/home/me/C%23/q%3F.ts:1");
  assert.equal(
    H.ideUrl("jetbrains", "D:\\w\\C# app", "src\\a #1?.cs", 9),
    "jetbrains://idea/navigate/reference?project=C%23%20app&path=src/a%20%231%3F.cs:9",
  );
  assert.equal(H.encodePath("C:/a b/c%d"), "C:/a%20b/c%25d");
  // A decoded vscode URL path round-trips to the original file path.
  const u = H.ideUrl("vscode", "C:\\p", "dir#1/f?.ts");
  assert.equal(decodeURIComponent(new URL(u).pathname.replace(/^\/+/, "")), "C:/p/dir#1/f?.ts");
});

test("review prompt: diff fence outruns any backtick run in the diff, and the copy is capped", async () => {
  const A = await import("../src/attachments.ts");
  assert.equal(A.fenceFor("plain"), "```");
  assert.equal(A.fenceFor("has ```` four"), "`````");
  assert.equal(A.longestBacktickRun("a ` b `` c"), 2);
  const s = src("ChangesPanel.tsx");
  assert.match(s, /fenceFor\(diffBody\)/);
  assert.match(s, /diffAsText\(files, REVIEW_DIFF_CAP\)/);
  assert.match(s, /REVIEW_DIFF_CAP = 40_000/);
  assert.doesNotMatch(s, /"```diff"/);
});

test("Changes: git runs through the VS git routes, no workspace registration (N1)", () => {
  const s = src("ChangesPanel.tsx");
  assert.doesNotMatch(s, /noWorkspace|NoWorkspaceBanner|workspaceIdForAgent|usePaseo/);
  // The only daemon calls left are the hunk-undo file read/write/delete (N2 owns file writes).
  const daemon = s.match(/daemonClient\.\w+/g) ?? [];
  assert.deepEqual([...new Set(daemon)].sort(), ["daemonClient.deleteFileEntry", "daemonClient.readFile", "daemonClient.writeFile"]);
  assert.match(s, /vsgit\.vsGitDiff\(cwd, "uncommitted"\)/);
});
