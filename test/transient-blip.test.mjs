import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BLIP_LINES, blipLine, isTransientErrorText, recoveredBlips } from "../src/transientBlip.ts";

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

const blipAt = (list, i, status) => recoveredBlips(list, status).get(list[i]) ?? null;
const err = (seq) => e({ type: "error", message: EOF_ERR }, seq);
const msg = (seq) => e({ type: "assistant_message", text: "ok" }, seq);
const usr = (seq) => e({ type: "user_message", text: "previous turn failed on a transient network error" }, seq);

test("transient error followed by activity -> blip with raw preserved", () => {
  const list = [e({ type: "user_message", text: "go" }, 0), err(1), msg(2)];
  const b = blipAt(list, 1);
  assert.ok(b);
  assert.equal(b.raw, EOF_ERR);
  assert.ok(BLIP_LINES.includes(b.line));
});

test("non-transient error stays an error even with later activity", () => {
  const list = [e({ type: "error", message: "boom" }, 1), msg(2)];
  assert.equal(blipAt(list, 0), null);
});

test("no recovery: last item / only errors and retry user_messages after stay errors", () => {
  assert.equal(blipAt([err(1)], 0), null);
  const chain = [err(1), usr(2), err(3), usr(4), err(5)];
  for (let i = 0; i < chain.length; i += 2) assert.equal(blipAt(chain, i), null);
  assert.equal(blipAt([err(1), usr(2)], 0), null);
});

test("activity then a later terminal error: first blips, terminal stays", () => {
  const list = [err(1), msg(2), err(3)];
  assert.ok(blipAt(list, 0));
  assert.equal(blipAt(list, 2), null);
});

test("agentStatus=error keeps the last error as error even if activity follows it", () => {
  const list = [err(1), msg(2)];
  assert.ok(blipAt(list, 0, "idle"));
  assert.equal(blipAt(list, 0, "error"), null);
  const two = [err(1), msg(2), err(3), msg(4)];
  assert.equal(blipAt(two, 0, "error") !== null, true);
  assert.equal(blipAt(two, 2, "error"), null);
});

test("object error payloads classify and tooltip carries real text", () => {
  const list = [e({ type: "error", error: { message: EOF_ERR } }, 1), msg(2)];
  const b = blipAt(list, 0);
  assert.ok(b);
  assert.equal(b.raw, EOF_ERR);
  const custom = recoveredBlips(list, undefined, () => "read ECONNRESET").get(list[0]);
  assert.equal(custom.raw, "read ECONNRESET");
});

test("cut/rewind: computing over the truncated list drops the recovery", () => {
  const full = [err(1), msg(2)];
  assert.ok(blipAt(full, 0));
  const cut = full.slice(0, 1);
  assert.equal(blipAt(cut, 0), null);
});

test("Timeline wires blips from base and renders tl-blip with title = raw", () => {
  const src = readFileSync(new URL("../src/Timeline.tsx", import.meta.url), "utf8");
  assert.match(src, /recoveredBlips\(base, agentStatus, formatToolError\)/);
  assert.match(src, /data-testid="tl-blip" title=\{blip\.raw\}/);
});

test("line choice is deterministic and rotates", () => {
  assert.equal(blipLine(7), blipLine(7));
  assert.notEqual(blipLine(0), blipLine(1));
  assert.equal(blipLine(0), blipLine(BLIP_LINES.length));
  assert.ok(BLIP_LINES.includes(blipLine(NaN)));
});
