import assert from "node:assert/strict";
import test from "node:test";
import { CHECKIN_PROMPT, checkinAction, leadLine, runCheckin } from "../src/railCheckin.ts";

const pinWith = (status) => ({ lead: status ? { agent: { id: "L1", status } } : null });

test("null lead -> none, nothing opened or sent", async () => {
  const calls = [];
  assert.equal(checkinAction(pinWith(null)), "none");
  await runCheckin(pinWith(null), { open: (i) => calls.push(["open", i]), send: async (i) => calls.push(["send", i]) });
  assert.deepEqual(calls, []);
});

test("running lead -> busy, no open, no send", async () => {
  const calls = [];
  assert.equal(await runCheckin(pinWith("running"), { open: () => calls.push("open"), send: async () => calls.push("send") }), "busy");
  assert.deepEqual(calls, []);
});

test("idle lead -> open then send exact prompt", async () => {
  const calls = [];
  await runCheckin(pinWith("idle"), { open: (i) => calls.push(["open", i]), send: async (i, t) => calls.push(["send", i, t]) });
  assert.deepEqual(calls, [["open", "L1"], ["send", "L1", "Check-in from Aub: status in 3 lines: done / doing / blocked."]]);
  assert.equal(CHECKIN_PROMPT, calls[1][2]);
});

test("leadLine", () => {
  assert.equal(leadLine(pinWith(null)), "No lead running");
  assert.equal(leadLine(pinWith("idle"), { who: "agent", text: "shipping" }), "Lead · shipping");
});
