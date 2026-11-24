import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNoteHistory } from "../server/profiles.mjs";
import { vsImportClosure } from "../cli/vs.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("loadNoteHistory: missing file -> empty set + one warning", () => {
  const warns = [];
  const set = loadNoteHistory(join(tmpdir(), "nope-772", "x.json"), (m) => warns.push(m));
  assert.equal(set.size, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /missing/);
});

test("loadNoteHistory: bad JSON / wrong shape -> empty set + warning; good file loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "nh772-"));
  try {
    const bad = join(dir, "bad.json"); writeFileSync(bad, "{not json");
    const obj = join(dir, "obj.json"); writeFileSync(obj, "{}");
    const good = join(dir, "good.json"); writeFileSync(good, JSON.stringify(["a", "b"]));
    const warns = [];
    assert.equal(loadNoteHistory(bad, (m) => warns.push(m)).size, 0);
    assert.equal(loadNoteHistory(obj, (m) => warns.push(m)).size, 0);
    assert.equal(warns.length, 2);
    const w2 = [];
    assert.deepEqual([...loadNoteHistory(good, (m) => w2.push(m))], ["a", "b"]);
    assert.equal(w2.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vs install runtime copy list includes server/profile-note-history.json (data file beside profiles.mjs)", () => {
  assert.ok(vsImportClosure(repo).includes("server/profile-note-history.json"));
});

test("vsImportClosure: every returned path exists (no bogus data-file entries)", () => {
  for (const rel of vsImportClosure(repo)) assert.ok(existsSync(join(repo, rel)), `${rel} does not exist`);
});

test("vsImportClosure: a ../ JSON reference escaping the repo root is rejected; an in-repo one is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "nh772c-"));
  try {
    const root = join(dir, "repo");
    mkdirSync(join(root, "cli"), { recursive: true });
    writeFileSync(join(dir, "outside.json"), "[]");
    writeFileSync(join(root, "ok.json"), "[]");
    writeFileSync(join(root, "cli", "vs.mjs"),
      'const a = new URL("../../outside.json", import.meta.url);\nconst b = new URL("../ok.json", import.meta.url);\n');
    const got = vsImportClosure(root);
    assert.ok(!got.some((p) => p.includes("outside")), JSON.stringify(got));
    assert.ok(got.includes("ok.json"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
