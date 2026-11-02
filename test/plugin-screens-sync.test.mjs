import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

test("plugin-screens shared sources are in sync (run sync-shared.mjs after editing src/identity.ts)", () => {
  const script = fileURLToPath(new URL("../plugin-screens/scripts/sync-shared.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8", cwd: dirname(script) });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
