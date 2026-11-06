import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");

test("guide-to-wiki mirrors guide/ with 0 unresolved links", () => {
  const out = mkdtempSync(join(tmpdir(), "vs-wiki-"));
  try {
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", join(REPO_ROOT, "guide"), "--out", out, "--tag", "v0.0.0-test"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unresolved=0/);
    assert.ok(existsSync(join(out, "Home.md")));
    assert.ok(existsSync(join(out, "_Sidebar.md")));
    assert.ok(readdirSync(join(out, "assets")).some((f) => f.endsWith(".png")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("guide-to-wiki refuses an --out that contains the source", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", join(REPO_ROOT, "guide"), "--out", REPO_ROOT], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(existsSync(join(REPO_ROOT, "guide", "README.md")));
});
