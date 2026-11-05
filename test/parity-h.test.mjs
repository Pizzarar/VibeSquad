import assert from "node:assert/strict";
import test from "node:test";
import {
  addRule, buildKeepPlanning, buildPlanApprove, orderPlanActions, parseRules, planWasEdited,
  removeRule, splitRule, suggestionLabel, suggestionScope,
} from "../src/paseoPermissionsLogic.ts";

test("suggestionScope maps Claude destinations", () => {
  assert.equal(suggestionScope({ destination: "userSettings" }), "user");
  assert.equal(suggestionScope({ destination: "projectSettings" }), "project");
  assert.equal(suggestionScope({ destination: "localSettings" }), "local");
  assert.equal(suggestionScope({ destination: "session" }), "session");
  assert.equal(suggestionScope({}), "session");
});

test("suggestionLabel names rule and scope", () => {
  const s = { type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }] };
  assert.equal(suggestionLabel(s), "Always allow Bash(npm test:*) · this project (private)");
  assert.match(suggestionLabel({ type: "setMode", mode: "acceptEdits", destination: "session" }), /acceptEdits · this session/);
  assert.match(suggestionLabel({ label: "Allow reads", destination: "userSettings" }), /Allow reads · all projects/);
});

test("plan: allow actions first, approve carries action id, edit sends updatedInput", () => {
  const acts = [
    { id: "k", label: "Keep", behavior: "deny" },
    { id: "a", label: "Auto", behavior: "allow" },
    { id: "m", label: "Manual", behavior: "allow" },
  ];
  assert.deepEqual(orderPlanActions(acts).map((a) => a.id), ["a", "m", "k"]);
  assert.deepEqual(buildPlanApprove(acts[1]), { behavior: "allow", selectedActionId: "a" });
  assert.deepEqual(buildPlanApprove(acts[1], "new", { plan: "old", x: 1 }), {
    behavior: "allow", selectedActionId: "a", updatedInput: { plan: "new", x: 1 },
  });
});

test("keep planning is a non-interrupting deny with feedback", () => {
  assert.deepEqual(buildKeepPlanning("  add tests "), { behavior: "deny", interrupt: false, message: "add tests" });
  assert.match(buildKeepPlanning("").message, /Keep planning/);
  assert.equal(planWasEdited("a", "a"), false);
  assert.equal(planWasEdited("a", "  "), false);
  assert.equal(planWasEdited("a", "b"), true);
});

test("parseRules reads allow/deny/ask, tolerates empty and rejects bad JSON", () => {
  assert.deepEqual(parseRules(""), { allow: [], deny: [], ask: [] });
  assert.deepEqual(parseRules('{"permissions":{"allow":["Bash(ls)",3],"deny":["Read(.env)"]},"x":1}'), { allow: ["Bash(ls)"], deny: ["Read(.env)"], ask: [] });
  assert.deepEqual(parseRules('{"a":1}'), { allow: [], deny: [], ask: [] });
  assert.throws(() => parseRules("{nope"), /not valid JSON/);
});

test("removeRule / addRule keep other keys and avoid duplicates", () => {
  const t = '{"model":"x","permissions":{"allow":["A","B"],"deny":["A"]}}';
  const r = JSON.parse(removeRule(t, "allow", "A"));
  assert.deepEqual(r.permissions, { allow: ["B"], deny: ["A"] });
  assert.equal(r.model, "x");
  assert.equal(removeRule("{}", "allow", "A"), "{}");
  const a = JSON.parse(addRule("", "allow", "Bash(x)"));
  assert.deepEqual(a, { permissions: { allow: ["Bash(x)"] } });
  assert.deepEqual(JSON.parse(addRule(JSON.stringify(a), "allow", "Bash(x)")).permissions.allow, ["Bash(x)"]);
});

test("splitRule", () => {
  assert.deepEqual(splitRule("Bash(npm run test:*)"), { tool: "Bash", pattern: "npm run test:*" });
  assert.deepEqual(splitRule("WebSearch"), { tool: "WebSearch", pattern: "" });
});
