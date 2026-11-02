import assert from "node:assert/strict";
import test from "node:test";
import { EVERYONE_LAYER, dedupeNotesAgainst, injectedPrefix } from "../plugin/index.server.ts";
import { SHARED_NOTE_PREFIX } from "../server/profiles.mjs";

test("block 1: R1-R7 rules appear once when profile notes repeat them", () => {
  const prefix = injectedPrefix("worker", "");
  const notes = `${SHARED_NOTE_PREFIX}\nRole-specific line.`;
  const composed = [prefix, dedupeNotesAgainst(notes, prefix)].join("\n\n");
  for (const tag of ["R1 (Search/Read)", "R3 (Images)", "R4 (Large files)", "R6 (Waiting)", "R2/R7 (Git state)"]) {
    assert.equal(composed.split(tag).length - 1, 1, tag);
  }
  assert.ok(composed.includes("Role-specific line."));
  assert.ok(composed.includes("Project rules first"));
  assert.ok(!/Roster:/.test(composed));
});

test("block 1: bold-style rules in notes are deduped too", () => {
  const out = dedupeNotesAgainst("- **R1 (Search/Read):** x\nkeep me", EVERYONE_LAYER);
  assert.equal(out, "keep me");
});
