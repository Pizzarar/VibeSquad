import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { detectPromisedRunIdle } from "../src/antigravity.ts";

const idleAgyAgent = (over = {}) => ({
  id: "agy-1",
  provider: "antigravity-cli",
  status: "idle",
  pendingPermissions: [],
  ...over,
});

const assistantEvents = (text) => [
  { item: { type: "assistant_message", text } },
];

test("detectPromisedRunIdle does not flag completed summary sentences containing running/checking", () => {
  const s1 =
    'Updated [flushWake](file:///C:/Users/you/projects/VibeSquad/plugin/index.server.ts) to re-check lead.status === "idle" before sending, coalesce wakeups within a 3s cooldown window, cap running re-checks.';
  assert.equal(detectPromisedRunIdle(idleAgyAgent(), assistantEvents(s1)), null);

  const s2 = "Finished running non-daemon background commands and checking logs.";
  assert.equal(detectPromisedRunIdle(idleAgyAgent(), assistantEvents(s2)), null);
});

test("detectPromisedRunIdle flags genuine in-progress promises and strips markdown link targets from excerpt", () => {
  const r1 = detectPromisedRunIdle(idleAgyAgent(), assistantEvents("Let me check the logs now."));
  assert.deepEqual(r1, { flagged: true, excerpt: "Let me check the logs now." });

  const r2 = detectPromisedRunIdle(idleAgyAgent(), assistantEvents("I'm running the test suite next."));
  assert.deepEqual(r2, { flagged: true, excerpt: "I'm running the test suite next." });

  const r3 = detectPromisedRunIdle(
    idleAgyAgent(),
    assistantEvents("Running [the build](file:///C:/Users/you/projects/VibeSquad/package.json) to verify"),
  );
  assert.deepEqual(r3, { flagged: true, excerpt: "Running the build to verify" });
  assert.equal(r3.excerpt.includes("file://"), false);
});

test("src/styles.css defines wrapping rules for .hard-bar, .hard-text, .hard-bar > .btn, and .pin-rail-active-inspector .hard-bar", () => {
  const cssPath = new URL("../src/styles.css", import.meta.url);
  const css = readFileSync(cssPath, "utf8");

  const ruleBody = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const m = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `Expected CSS rule for "${selector}"`);
    return m[1];
  };

  const hardBar = ruleBody(".hard-bar");
  for (const prop of ["flex-wrap: wrap", "min-width: 0", "max-width: 100%", "box-sizing: border-box"]) {
    assert.ok(hardBar.includes(prop), `.hard-bar missing "${prop}"`);
  }

  const hardText = ruleBody(".hard-text");
  for (const prop of [
    "flex: 1 1 160px",
    "min-width: 0",
    "max-width: 100%",
    "overflow-wrap: anywhere",
    "word-break: break-word",
    "white-space: normal",
  ]) {
    assert.ok(hardText.includes(prop), `.hard-text missing "${prop}"`);
  }

  const hardBarBtn = ruleBody(".hard-bar > .btn");
  for (const prop of ["flex: 0 0 auto", "max-width: 100%", "white-space: normal"]) {
    assert.ok(hardBarBtn.includes(prop), `.hard-bar > .btn missing "${prop}"`);
  }

  const inspectorHardBar = ruleBody(".pin-rail-active-inspector .hard-bar");
  assert.ok(inspectorHardBar.includes("margin: 4px 0 0"), `.pin-rail-active-inspector .hard-bar missing "margin: 4px 0 0"`);
});
