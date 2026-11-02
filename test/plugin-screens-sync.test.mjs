import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("plugin-screens shared sources are in sync (run sync-shared.mjs after editing src/identity.ts)", () => {
  const r = spawnSync(process.execPath, ["plugin-screens/scripts/sync-shared.mjs", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
