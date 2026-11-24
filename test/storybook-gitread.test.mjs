import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeRepo, git } from "./storybook-fake-repo.mjs";
import { resolveRef, readFile, listTree, exists, makeReader, fetchRepo, fetchStampPath, defaultBranch } from "../server/storybook/git-read.mjs";
import { parseCsv, parseCsvObjects } from "../server/storybook/csv.mjs";

const fake = makeFakeRepo();
after(() => fake.cleanup());

test("resolveRef: origin/<default> detected, explicit sha and bad refs", async () => {
  assert.equal(await defaultBranch(fake.clone), "main");
  assert.equal(await resolveRef(fake.clone), fake.sha);
  assert.equal(await resolveRef(fake.clone, "origin/main"), fake.sha);
  assert.equal(await resolveRef(fake.clone, fake.sha), fake.sha);
  await assert.rejects(resolveRef(fake.clone, "origin/nope"), /cannot resolve/);
  await assert.rejects(resolveRef(fake.clone, "--upload-pack=x"), /bad ref/);
});

test("reads the pinned sha, never the working tree", async () => {
  fs.writeFileSync(path.join(fake.clone, "data/items.json"), "DIRTY WORKING TREE");
  const txt = await readFile(fake.clone, fake.sha, "data/items.json");
  assert.match(txt, /scrap_metal/);
  assert.doesNotMatch(txt, /DIRTY/);
  assert.equal(await readFile(fake.clone, fake.sha, "data/nope.json"), null);
  assert.equal(await exists(fake.clone, fake.sha, "data/items.json"), true);
  assert.equal(await exists(fake.clone, fake.sha, "data"), true);
  assert.equal(await exists(fake.clone, fake.sha, "data/nope.json"), false);
  await assert.rejects(readFile(fake.clone, fake.sha, "../etc/passwd"), /bad path/);
  git(fake.clone, "checkout", "--", "data/items.json");
});

test("listTree: dir, recursive, missing", async () => {
  const flat = await listTree(fake.clone, fake.sha, "data");
  assert.ok(flat.some((e) => e.path === "data/traders.json" && e.type === "blob"));
  const rec = await listTree(fake.clone, fake.sha, "docs", { recursive: true });
  assert.ok(rec.some((e) => e.path === "docs/narrative/VOICE_BIBLE.md"));
  assert.deepEqual(await listTree(fake.clone, fake.sha, "nope"), []);
  const top = await listTree(fake.clone, fake.sha, "");
  assert.ok(top.some((e) => e.path === "data" && e.type === "tree"));
});

test("makeReader binds repo+sha", async () => {
  const r = makeReader(fake.clone, fake.sha);
  assert.equal(r.sha, fake.sha);
  assert.match(await r.readFile("data/rooms.json"), /Barracks/);
  assert.equal(await r.exists("systems/ScavengingSystem.gd"), true);
});

test("fetchRepo is rate limited to once per hour per repo via a stamp file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-home-"));
  try {
    const t0 = 1_000_000_000_000;
    const a = await fetchRepo(fake.clone, { home, now: t0 });
    assert.equal(a.ok, true); assert.equal(a.fetched, true);
    assert.ok(fs.existsSync(fetchStampPath(fake.clone, { home })));
    assert.ok(fetchStampPath(fake.clone, { home }).startsWith(path.join(home, "storybook")));
    const b = await fetchRepo(fake.clone, { home, now: t0 + 59 * 60_000 });
    assert.equal(b.fetched, false); assert.equal(b.skipped, "rate-limited");
    assert.equal(b.nextAllowedAt, t0 + 3_600_000);
    const c = await fetchRepo(fake.clone, { home, now: t0 + 61 * 60_000 });
    assert.equal(c.fetched, true);
    // a different repo has its own stamp
    assert.notEqual(fetchStampPath(fake.clone, { home }), fetchStampPath(fake.origin, { home }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("CSV: quoted newlines, escaped quotes, CRLF, BOM, trailing newline", () => {
  const { rows } = parseCsv('﻿a,b\r\n"x\ny","he said ""hi"""\r\n,\r\n');
  assert.deepEqual(rows, [["a", "b"], ["x\ny", 'he said "hi"'], ["", ""]]);
  const { records } = parseCsvObjects('h1,h2\n"l1\nl2",z\nq,r');
  assert.equal(records.length, 2);
  assert.equal(records[0].row.h1, "l1\nl2");
  assert.equal(records[0].line, 2);
  assert.equal(records[1].line, 4);
});
