// New Squad seeds the hub brief server-side: hub lane only, new Teams only, never overwrites, seed parses as 0 unsplit.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedHubBriefs } from "../server/hub-seed.mjs";
import { countUnsplit } from "../src/hubBarLogic.ts";

const mk = () => mkdtempSync(join(tmpdir(), "hub-seed-"));
const squad = { id: "team-x", name: "X", lanes: [{ id: "x", name: "X", hub: true }, { id: "side", name: "Side" }], paths: ["x"] };

test("a new Squad seeds the hub brief only, and it parses as 0 unsplit", () => {
  const root = mk();
  try {
    const written = seedHubBriefs([], [squad], "/unused", () => root);
    assert.deepEqual(written, [join(root, "docs", "brainstorm", "x.md")]);
    const text = readFileSync(written[0], "utf8");
    assert.match(text, /## Teams\n[\s\S]*## Unsplit threads\n- \(none yet\)/);
    assert.equal(countUnsplit(text), 0);
    assert.ok(!existsSync(join(root, "docs", "brainstorm", "side.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing brief is untouched; existing Teams and unflagged lanes are not seeded", () => {
  const root = mk();
  try {
    mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
    const f = join(root, "docs", "brainstorm", "x.md");
    writeFileSync(f, "mine");
    assert.deepEqual(seedHubBriefs([], [squad], "/unused", () => root), []);
    assert.equal(readFileSync(f, "utf8"), "mine");
    rmSync(f);
    assert.deepEqual(seedHubBriefs([squad], [squad], "/unused", () => root), [], "Team already registered");
    const noFlag = { ...squad, id: "y", lanes: [{ id: "y", name: "Y" }] };
    assert.deepEqual(seedHubBriefs([], [noFlag], "/unused", () => root), [], "no hub: true flag, no seed");
    assert.deepEqual(seedHubBriefs([], [squad], "/unused", () => null), [], "no project dir resolves");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
