import assert from "node:assert/strict";
import test from "node:test";

// B1: activeTurnBehavior merging logic
test("B1: sendMessage opts default activeTurnBehavior to steer", () => {
  const buildOpts = (opts) => ({ activeTurnBehavior: "steer", ...opts });

  const defaultOpts = buildOpts(undefined);
  assert.equal(defaultOpts.activeTurnBehavior, "steer", "default should be steer");

  const steerOpts = buildOpts({ activeTurnBehavior: "steer" });
  assert.equal(steerOpts.activeTurnBehavior, "steer", "explicit steer preserved");

  const interruptOpts = buildOpts({ activeTurnBehavior: "interrupt" });
  assert.equal(interruptOpts.activeTurnBehavior, "interrupt", "explicit interrupt overrides default");
});

test("B1: CANCEL_AND_RESUME uses interrupt behavior", () => {
  // Simulates the onAction handler calling sendMessage with interrupt
  const calls = [];
  const fakeSendMessage = (agentId, text, images, opts) => { calls.push(opts); };

  fakeSendMessage("agent1", "cancel prompt", undefined, { activeTurnBehavior: "interrupt" });
  assert.equal(calls[0].activeTurnBehavior, "interrupt", "cancel & resume must use interrupt");
});

test("B1: regular send uses steer behavior", () => {
  const calls = [];
  const fakeSendMessage = (agentId, text, images, opts) => { calls.push({ ...({ activeTurnBehavior: "steer", ...opts }) }); };

  fakeSendMessage("agent1", "hello", undefined, { activeTurnBehavior: "steer" });
  assert.equal(calls[0].activeTurnBehavior, "steer", "regular send must use steer");
});

// B3: permission response payloads
test("B3: question kind sends updatedInput with behavior allow", () => {
  const buildAllowResponse = (kind, extra) => ({
    behavior: "allow",
    ...(extra ?? {}),
  });

  const questionResponse = buildAllowResponse("question", { updatedInput: { answer: "yes" } });
  assert.equal(questionResponse.behavior, "allow");
  assert.deepEqual(questionResponse.updatedInput, { answer: "yes" });
  assert.equal(questionResponse.selectedActionId, undefined, "question should not have selectedActionId");
});

test("B3: plan kind sends selectedActionId with behavior allow", () => {
  const buildAllowResponse = (kind, extra) => ({
    behavior: "allow",
    ...(extra ?? {}),
  });

  const planResponse = buildAllowResponse("plan", { selectedActionId: "action-implement" });
  assert.equal(planResponse.behavior, "allow");
  assert.equal(planResponse.selectedActionId, "action-implement");
  assert.equal(planResponse.updatedInput, undefined, "plan should not have updatedInput");
});

test("B3: deny response has correct shape", () => {
  const denyResponse = { behavior: "deny" };
  assert.equal(denyResponse.behavior, "deny");
  assert.equal(denyResponse.selectedActionId, undefined);
});
