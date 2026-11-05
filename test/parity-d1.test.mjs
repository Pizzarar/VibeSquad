import test from "node:test";
import assert from "node:assert/strict";
import { remapPath, isUnder, validateEntryName, parentPath, baseName, joinPath, nameTaken, captureText, captureFileName } from "../src/fileOps.ts";

test("validateEntryName", () => {
  assert.equal(validateEntryName("notes.md"), null);
  assert.equal(validateEntryName(".gitignore"), null);
  for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "..\\evil", "sub\\file","a:b", "x?", "end.", "CON", "nul.txt", "a".repeat(256)]) {
    assert.notEqual(validateEntryName(bad), null, JSON.stringify(bad));
  }
});

test("path helpers", () => {
  assert.equal(parentPath("src/a/b.ts"), "src/a");
  assert.equal(parentPath("README.md"), "");
  assert.equal(baseName("src/a/b.ts"), "b.ts");
  assert.equal(baseName("b.ts"), "b.ts");
  assert.equal(joinPath("", "x"), "x");
  assert.equal(joinPath("src/", "x"), "src/x");
});

test("nameTaken is case-insensitive and ignores the entry being renamed", () => {
  assert.equal(nameTaken(["A.md", "b.md"], "a.MD"), true);
  assert.equal(nameTaken(["A.md", "b.md"], "A.md", "A.md"), false);
  assert.equal(nameTaken(["A.md"], "c.md"), false);
});

test("captureText trims trailing blanks", () => {
  assert.equal(captureText(["a", "b", "", "  "]), "a\nb\n");
  assert.equal(captureText(["", ""]), "");
});

test("captureFileName", () => {
  assert.equal(captureFileName("Build & Test!", new Date(2026, 10, 2, 14, 5)), "terminal-build-test-20261102-1405.txt");
  assert.equal(captureFileName("???", new Date(2026, 0, 3, 1, 2)), "terminal-capture-20260103-0102.txt");
});

test("remapPath / isUnder", () => {
  assert.equal(remapPath("src/old", "src/old", "src/new"), "src/new");
  assert.equal(remapPath("src/old/a.ts", "src/old", "src/new"), "src/new/a.ts");
  assert.equal(remapPath("src/older/a.ts", "src/old", "src/new"), "src/older/a.ts");
  assert.equal(isUnder("a/b/c", "a/b"), true);
  assert.equal(isUnder("a/bc", "a/b"), false);
});
