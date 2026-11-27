// cleanupShotsDir is an allow-list: it only deletes dirs shotsDir created. (@bug PLAN_INBOX_1127Q Q2 idea-1163)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, shotsDir, cleanupShotsDir } from "../scripts/ui-overlap/env.mjs";

test("dir created by shotsDir is deleted", () => {
  delete process.env.UPDATE_SHOTS;
  const d = shotsDir("unit-x");
  fs.writeFileSync(path.join(d, "a.png"), "x");
  assert.ok(d.startsWith(os.tmpdir()));
  cleanupShotsDir(d);
  assert.equal(fs.existsSync(d), false);
});

test("unknown tmp dir is not deleted", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vs-shots-unknown-"));
  try { cleanupShotsDir(d); assert.equal(fs.existsSync(d), true); } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("relative docs path is not deleted (temp fixture cwd)", () => {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-shots-rel-"));
  fs.mkdirSync(path.join(root, "docs", "shots", "desk-c2"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "shots", "desk-c2", "a.png"), "x");
  try {
    process.chdir(root);
    cleanupShotsDir("docs/shots/desk-c2");
    cleanupShotsDir("docs/../docs/shots/desk-c2");
    assert.equal(fs.existsSync(path.join(root, "docs", "shots", "desk-c2", "a.png")), true);
  } finally { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); }
});

test("REPO_ROOT is not deleted", () => {
  cleanupShotsDir(REPO_ROOT);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "package.json")), true);
});

test("deleting twice is a no-op; UPDATE_SHOTS=1 dir is never deleted", () => {
  const d = shotsDir("unit-y");
  cleanupShotsDir(d); cleanupShotsDir(d);
  process.env.UPDATE_SHOTS = "1";
  try {
    const t = shotsDir("unit-z");
    assert.equal(t, path.join(REPO_ROOT, "docs", "shots", "unit-z"));
    cleanupShotsDir(t);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "docs")), true);
  } finally { delete process.env.UPDATE_SHOTS; }
});
