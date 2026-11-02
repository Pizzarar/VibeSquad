import test from "node:test";
import assert from "node:assert/strict";
import { planFirstPrompt } from "../src/spawnImages.ts";

test("no images: prompt rides on create", () => {
  assert.deepEqual(planFirstPrompt("hi", 0), { createPrompt: "hi", firstSend: null });
});
test("images: create bare, first send carries prompt + images", () => {
  assert.deepEqual(planFirstPrompt("hi", 2), { createPrompt: "", firstSend: { text: "hi", withImages: true } });
});
