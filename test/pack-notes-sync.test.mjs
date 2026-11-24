// docs/profiles/vibesquad-profiles-pack.json notes must equal server/profiles.mjs DEFAULT_PACK_PROFILES notes (idea-714 drift guard).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_PACK_PROFILES } from "../server/profiles.mjs";

test("profiles pack notes match DEFAULT_PACK_PROFILES (regenerate notes from server/profiles.mjs on drift)", () => {
  const pack = JSON.parse(fs.readFileSync(new URL("../docs/profiles/vibesquad-profiles-pack.json", import.meta.url), "utf8"));
  assert.equal(pack.profiles.length, DEFAULT_PACK_PROFILES.length);
  for (const x of pack.profiles) {
    const c = DEFAULT_PACK_PROFILES.find((d) => d.name === x.name);
    assert.ok(c, `${x.name} missing from DEFAULT_PACK_PROFILES`);
    assert.equal(x.notes, c.notes, `${x.name} pack notes drifted from server/profiles.mjs`);
  }
});
