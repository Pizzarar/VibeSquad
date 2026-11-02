import assert from "node:assert/strict";
import test from "node:test";
import { addRule, isSettingsFile, parseRules, parseSettingsObject, removeRule, validateRule } from "../src/paseoPermissionsLogic.ts";

test("validateRule accepts the documented Claude Code forms", () => {
  for (const ok of [
    "Bash", "Bash(npm run test:*)", "Bash(git commit *)", "Read(./src/**)", "Read(//tmp/**)",
    "WebFetch(domain:example.com)", "mcp__server__tool", "mcp__github__get_*", "Agent(model:opus)",
    'Bash(echo "a (b)")',
  ]) assert.equal(validateRule(ok), null, ok);
});

test("validateRule rejects control chars, bad shape and unbalanced parens", () => {
  assert.match(validateRule("Bash(ls)\nBash(rm)"), /control/);
  assert.match(validateRule("Bash(a\u0000b)"), /control/);
  assert.match(validateRule("  "), /empty/);
  assert.match(validateRule("Bash(rm -rf *"), /ToolName|unbalanced/);
  assert.match(validateRule("Bash(a))"), /ToolName|unbalanced/);
  assert.match(validateRule("Bash(a (b)"), /unbalanced/);
  assert.match(validateRule("two words"), /ToolName/);
  assert.match(validateRule("Bash()"), /ToolName/);
  assert.match(validateRule("mcp__s__t(x)"), /mcp__/);
  assert.match(validateRule("*", "allow"), /\*/);
  assert.match(validateRule("mcp__*", "allow"), /\*/);
  assert.equal(validateRule("mcp__*", "deny"), null);
});

test("addRule enforces validation", () => {
  assert.throws(() => addRule("", "allow", "Bash(rm -rf *"), /ToolName|unbalanced/);
  assert.throws(() => addRule("", "allow", "Bash\nRead"), /control/);
  assert.deepEqual(JSON.parse(addRule("", "allow", "  Bash(ls)  ")).permissions.allow, ["Bash(ls)"]);
});

test("non-object JSON roots are refused, never rewritten", () => {
  for (const bad of ["null", "[]", '"str"', "123", "true", '{"permissions":[]}', '{"permissions":null}']) {
    assert.throws(() => parseRules(bad), /not a JSON object|not an object/, bad);
    assert.throws(() => addRule(bad, "allow", "Bash(ls)"), /not a JSON object|not an object/, bad);
    assert.throws(() => removeRule(bad, "allow", "Bash(ls)"), /not a JSON object|not an object/, bad);
  }
  assert.deepEqual(parseSettingsObject("   "), {});
  assert.throws(() => parseSettingsObject("{oops"), /not valid JSON/);
});

test("only the two settings files are allowed paths", () => {
  assert.equal(isSettingsFile(".claude/settings.local.json"), true);
  assert.equal(isSettingsFile(".claude/settings.json"), true);
  assert.equal(isSettingsFile("../.claude/settings.json"), false);
  assert.equal(isSettingsFile(".claude/settings.local.json/../../x"), false);
  assert.equal(isSettingsFile("package.json"), false);
});
