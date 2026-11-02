import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentTemplate, commandTemplate, hookRows, normalizeName, parseFrontmatter, parseSettingsJson, serializeFrontmatter,
  stemOf, validName, validateAgent, validateCommand, COMMAND_KEYS, AGENT_KEYS,
} from "../src/claudeConfigLogic.ts";

test("parseFrontmatter reads flat fields, quotes and CRLF", () => {
  const p = parseFrontmatter('---\r\ndescription: "Run: tests"\r\nmodel: haiku\r\nextra-key: keep me\r\n---\r\n\r\nBody $ARGUMENTS\r\n');
  assert.equal(p.fields.description, "Run: tests");
  assert.equal(p.fields.model, "haiku");
  assert.deepEqual(p.order, ["description", "model", "extra-key"]);
  assert.match(p.body, /Body \$ARGUMENTS/);
});

test("parseFrontmatter: no frontmatter keeps the whole text as body", () => {
  const p = parseFrontmatter("just a prompt\n---\nnot front\n");
  assert.deepEqual(p.fields, {});
  assert.equal(p.body, "just a prompt\n---\nnot front\n");
});

test("serialize then parse round-trips, quoting risky values and keeping unknown keys", () => {
  const fields = { description: "Review: the diff # now", tools: "Read, Grep", "extra-key": "x", model: "" };
  const text = serializeFrontmatter(fields, "\nDo it.\n\n", ["name", "description", "tools", "model"], ["extra-key"]);
  assert.match(text, /^---\ndescription: "Review: the diff # now"\ntools: Read, Grep\nextra-key: x\n---\n\nDo it\.\n$/);
  const back = parseFrontmatter(text);
  assert.equal(back.fields.description, fields.description);
  assert.equal(back.fields["extra-key"], "x");
  assert.equal(back.fields.model, undefined);
});

test("serialize with no fields emits just the body", () => {
  assert.equal(serializeFrontmatter({ description: " " }, "hi", COMMAND_KEYS), "hi\n");
});

test("names: normalize and validate", () => {
  assert.equal(normalizeName("  Review PR.md "), "review-pr");
  assert.equal(normalizeName("Foo_Bar!!"), "foo-bar");
  assert.equal(normalizeName("../evil"), "evil");
  assert.ok(validName("a-b-1"));
  for (const bad of ["", "-a", "a--b", "A", "a/b", "a".repeat(65)]) assert.ok(!validName(bad), bad);
  assert.equal(stemOf("x.md"), "x");
});

test("validateCommand", () => {
  assert.match(validateCommand("Bad Name", {}, "x", [], null), /lowercase/);
  assert.match(validateCommand("a", {}, "x", ["a"], null), /already exists/);
  assert.equal(validateCommand("a", {}, "x", ["a"], "a"), null);
  assert.match(validateCommand("a", {}, " ", [], null), /prompt body/);
  assert.equal(validateCommand("a", { description: "d" }, "", [], null), null);
});

test("validateAgent needs description and prompt", () => {
  assert.match(validateAgent("a", {}, "x", [], null), /Description/);
  assert.match(validateAgent("a", { description: "d" }, "", [], null), /system prompt/);
  assert.match(validateAgent("a", { description: "d" }, "x", ["a"], null), /already exists/);
  assert.equal(validateAgent("a", { description: "d" }, "x", [], null), null);
});

test("templates validate and serialize", () => {
  const c = commandTemplate("ship");
  assert.equal(validateCommand("ship", c.fields, c.body, [], null), null);
  const a = agentTemplate("rev");
  assert.equal(validateAgent("rev", a.fields, a.body, [], null), null);
  assert.match(serializeFrontmatter(a.fields, a.body, AGENT_KEYS), /^---\nname: rev\n/);
});

test("hookRows flattens events, matchers and non-command hooks; tolerates junk", () => {
  const rows = hookRows({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "check" }, { type: "command", command: "x" }] }],
      Bad: "nope",
      AlsoBad: [null, { hooks: "x" }],
    },
  }, "settings.json");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { event: "PreToolUse", matcher: "Bash", type: "command", command: "echo hi", source: "settings.json" });
  assert.equal(rows[1].type, "prompt");
  assert.deepEqual(hookRows(null, "s"), []);
  assert.deepEqual(hookRows({ hooks: [] }, "s"), []);
});

test("parseSettingsJson reports errors and strips BOM", () => {
  assert.equal(parseSettingsJson('﻿{"a":1}').value.a, 1);
  assert.ok(parseSettingsJson("{nope").error);
});
