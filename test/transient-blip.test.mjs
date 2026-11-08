import assert from "node:assert/strict";
import test from "node:test";
import { BLIP_LINES, blipLine, isTransientErrorText, transientBlip } from "../src/transientBlip.ts";

const e = (item, seqStart) => ({ item, seqStart });
const EOF_ERR = "⚠ API error (attempt 1): Post https://example.googleapis.com/v1: unexpected EOF";

test("classifier reuse: transient texts yes, quota/other/empty no", () => {
  assert.equal(isTransientErrorText(EOF_ERR), true);
  assert.equal(isTransientErrorText("dial tcp: no such host"), true);
  assert.equal(isTransientErrorText("read ECONNRESET"), true);
  assert.equal(isTransientErrorText("429 rate limit"), false);
  assert.equal(isTransientErrorText("boom"), false);
  assert.equal(isTransientErrorText(""), false);
});

test("transient error followed by activity -> blip with raw preserved", () => {
  const list = [e({ type: "user_message", text: "go" }, 0), e({ type: "error", message: EOF_ERR }, 1), e({ type: "assistant_message", text: "ok" }, 2)];
  const b = transientBlip(list, 1);
  assert.ok(b);
  assert.equal(b.raw, EOF_ERR);
  assert.ok(BLIP_LINES.includes(b.line));
});

test("non-transient error stays an error even with later activity", () => {
  const list = [e({ type: "error", message: "boom" }, 1), e({ type: "assistant_message", text: "ok" }, 2)];
  assert.equal(transientBlip(list, 0), null);
});

test("transient error with no recovery (last item / only errors after) stays an error", () => {
  assert.equal(transientBlip([e({ type: "error", message: EOF_ERR }, 1)], 0), null);
  const list = [e({ type: "error", message: EOF_ERR }, 1), e({ type: "error", message: EOF_ERR }, 2)];
  assert.equal(transientBlip(list, 0), null);
  assert.equal(transientBlip(list, 1), null);
});

test("non-error items are never blips", () => {
  assert.equal(transientBlip([e({ type: "assistant_message", text: EOF_ERR }, 1), e({ type: "assistant_message", text: "x" }, 2)], 0), null);
});

test("line choice is deterministic and rotates", () => {
  assert.equal(blipLine(7), blipLine(7));
  assert.notEqual(blipLine(0), blipLine(1));
  assert.equal(blipLine(0), blipLine(BLIP_LINES.length));
  assert.ok(BLIP_LINES.includes(blipLine(NaN)));
});
