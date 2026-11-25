// A2 L1: src/roleSpawn.ts tierFor (New Agent badge) must equal the server's stakes -> tier mapping
// (server/stakes-ladder.mjs stakesTier, applied in server/role-route.mjs: forced ?? role tier).
import assert from "node:assert/strict";
import test from "node:test";
import { stakesTier } from "../server/stakes-ladder.mjs";
import { STAKES_CHOICES, tierFor } from "../src/roleSpawn.ts";

test("tierFor (src) matches server stakesTier + role tier fallback for every stakes value", () => {
  for (const stakes of [...STAKES_CHOICES, "", "bogus", "TIERA-SECURITY"]) {
    for (const tier of ["top", "mid", "cheap"]) {
      const role = { name: "R", tier, providers: ["claude"] };
      assert.equal(tierFor(role, stakes), stakesTier(stakes) ?? tier, `stakes=${JSON.stringify(stakes)} role tier=${tier}`);
    }
  }
});
