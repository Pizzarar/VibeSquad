// Bug2 block 4: the Changes tab must end in an error state instead of spinning forever.
import assert from "node:assert/strict";
import test from "node:test";
import { CHANGES_TIMEOUT_MS, changesErrorText, withTimeout } from "../src/changesLoad.ts";

test("withTimeout rejects a never-settling load with a readable error", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), /did not answer within/);
});

test("withTimeout passes through a fast result and a fast failure", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
});

test("changesErrorText never returns an empty string", () => {
  assert.equal(changesErrorText(new Error("  ")), "Could not load changes");
  assert.equal(changesErrorText("x"), "x");
  assert.ok(CHANGES_TIMEOUT_MS > 0);
});
