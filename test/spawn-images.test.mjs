import test from "node:test";
import assert from "node:assert/strict";
import { withImages } from "../src/spawnImages.ts";

const req = { provider: "claude", model: "m", prompt: "hi", labels: { team: "t" } };

test("no images: request is returned untouched (no images key)", () => {
  const out = withImages(req, []);
  assert.equal(out, req);
  assert.ok(!("images" in out));
});
test("images: added to a copy, other fields (labels, prompt) preserved", () => {
  const imgs = [{ data: "AAAA", mimeType: "image/png" }];
  const out = withImages(req, imgs);
  assert.deepEqual(out.images, imgs);
  assert.deepEqual(out.labels, { team: "t" });
  assert.equal(out.prompt, "hi");
  assert.ok(!("images" in req));
});
