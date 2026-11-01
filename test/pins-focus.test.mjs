import assert from "node:assert/strict";
import test from "node:test";
import { escGoesHome, reconcilePinFocus } from "../src/pinFocusLogic.ts";

const shown = (agentId) => ({ agentId, gone: false, held: null });

test("focus stays while the pin's Brainstorm is the active tab", () => {
  assert.deepEqual(reconcilePinFocus(shown("a"), "a", "a"), { kind: "keep" });
});

test("restart in the drawer (openAgentInTab successor) follows the new Brainstorm", () => {
  // The successor already replaced the tab: follow without reopening.
  assert.deepEqual(reconcilePinFocus(shown("a"), "b", "b"), { kind: "follow", agentId: "b", open: false });
  // A successor that appeared elsewhere (another tab, the lead): follow and open it.
  assert.deepEqual(reconcilePinFocus(shown("a"), "b", "a"), { kind: "follow", agentId: "b", open: true });
});

test("retired / archived / auto-retired Brainstorm keeps the pin focused as gone", () => {
  assert.deepEqual(reconcilePinFocus(shown("a"), null, "a"), { kind: "gone" });
  // Already gone: no churn.
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, null, "a"), { kind: "keep" });
});

test("while gone or starting, opening another agent exits instead of hiding it", () => {
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, null, "lead-1"), { kind: "exit" });
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: false, held: null }, null, "lead-1"), { kind: "exit" });
});

test("a gone pin picks up a fresh Brainstorm when one appears", () => {
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, "c", "a"), { kind: "follow", agentId: "c", open: true });
});

test("a quick start in flight is left alone", () => {
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: false, held: "a" }, null, "a"), { kind: "keep" });
});

test("opening an unrelated agent over the focused drawer exits", () => {
  assert.deepEqual(reconcilePinFocus(shown("a"), "a", "lead-1"), { kind: "exit" });
});

test("Esc goes home only with an empty composer, outside modals, permission cards and other fields", () => {
  const base = { inModal: false, inPerm: false, target: "none", draft: "" };
  assert.equal(escGoesHome(base), true);
  assert.equal(escGoesHome({ ...base, target: "composer" }), true);
  assert.equal(escGoesHome({ ...base, draft: "half a thought" }), false);
  assert.equal(escGoesHome({ ...base, target: "composer", draft: "  hi " }), false);
  assert.equal(escGoesHome({ ...base, draft: "   " }), true);
  assert.equal(escGoesHome({ ...base, inPerm: true }), false);
  assert.equal(escGoesHome({ ...base, target: "field" }), false);
  assert.equal(escGoesHome({ ...base, inModal: true }), false);
});
