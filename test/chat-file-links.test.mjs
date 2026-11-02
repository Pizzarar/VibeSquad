import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFileToken, bareFileTargets } from "../src/fileLinks.ts";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// renderInline (inline-code and bare-text branches) classifies tokens with these helpers.
test("backticked path is a file target", () => {
  assert.deepEqual(parseFileToken("docs/brainstorm/vibesquad.md"), { path: "docs/brainstorm/vibesquad.md", line: null, isDir: false });
});
test("bare path in prose is a file target", () => {
  assert.deepEqual(bareFileTargets("read docs/art/PIXELLAB_PROMPTS.md first."), [{ path: "docs/art/PIXELLAB_PROMPTS.md", line: null, isDir: false }]);
});
test("path:line and path#L12 carry the line", () => {
  assert.equal(parseFileToken("src/Timeline.tsx:200").line, 200);
  assert.equal(parseFileToken("src/Timeline.tsx#L12").line, 12);
});
test("folder with trailing slash is a dir target", () => {
  assert.deepEqual(parseFileToken("scratch/"), { path: "scratch", line: null, isDir: true });
  assert.deepEqual(bareFileTargets("see scratch/pixellab/ now"), [{ path: "scratch/pixellab", line: null, isDir: true }]);
});
test("URLs are not links", () => {
  assert.equal(parseFileToken("https://example.com/a/b.md"), null);
  assert.deepEqual(bareFileTargets("go to https://example.com/a/b.md or http://x.dev/docs/"), []);
});
test("@scope/pkg is not a link", () => {
  assert.equal(parseFileToken("@types/node"), null);
  assert.deepEqual(bareFileTargets("install @types/node and @scope/pkg.js"), []);
});
test("plain slashed words and versions are not links", () => {
  assert.equal(parseFileToken("and/or"), null);
  assert.deepEqual(bareFileTargets("either and/or 1.5/2.5 on 11/01/2026"), []);
});
test("backslash paths normalise; trailing sentence dot is not part of the path", () => {
  assert.equal(parseFileToken("src" + String.fromCharCode(92) + "App.tsx").path, "src/App.tsx");
  assert.equal(bareFileTargets("open src/App.tsx.")[0].path, "src/App.tsx");
});

test("Timeline wires inline code + bare paths to openRightDockTab without copying", () => {
  const t = src("src/Timeline.tsx");
  assert.match(t, /parseFileToken\(m\[7\]\)/);
  assert.match(t, /key: "barepath"/);
  assert.doesNotMatch(t, /clipboard\.writeText\(fp\)/);
});

test("FilesPanel renders .md by default, toggles to source, reports missing files", () => {
  const f = src("src/FilesPanel.tsx");
  assert.match(f, /MarkdownRenderer/);
  assert.match(f, /isMd && !sourceView/);
  assert.match(f, /data-testid="files-source-btn"/);
  assert.match(f, /setSourceView\(\(v\) => !v\)/);
  assert.match(f, /File not found: \{openFile\}/);
  assert.match(f, /revealFolder/);
});
