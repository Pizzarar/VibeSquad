import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentTemplate, commandTemplate, hookRows, normalizeName, parseFrontmatter, parseSettingsJson, serializeFrontmatter,
  stemOf, validName, confineConfigPath, confineSettingsPath, validScopeCwd, validateAgent, validateCommand, COMMAND_KEYS, AGENT_KEYS,
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

test("validName rejects Windows reserved device names", () => {
  for (const n of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) assert.ok(!validName(n), n);
  for (const n of ["com0", "com10", "con-test", "my-nul", "lpt", "console"]) assert.ok(validName(n), n);
  assert.equal(normalizeName("CON.md"), "con");
  assert.match(validateCommand("nul", { description: "d" }, "x", [], null), /lowercase/);
});

test("confineConfigPath accepts only .claude/<kind>/<validName>.md", () => {
  assert.equal(confineConfigPath("command", "review-pr"), ".claude/commands/review-pr.md");
  assert.equal(confineConfigPath("command", "review-pr.md"), ".claude/commands/review-pr.md");
  assert.equal(confineConfigPath("agent", ".claude/agents/rev.md"), ".claude/agents/rev.md");
  const bad = [
    "", ".", "..", "../x", "..\\x", "a/b", "a\\b", "/etc/passwd", "\\x", "C:\\x.md", "C:/x.md", "c:x",
    ".claude/commands/../../x.md", ".claude/commands/../settings.json", ".claude/agents/x.md", // wrong dir for a command
    "%2e%2e", "%2e%2e%2fx", "..%2fx", "x%00", "x\0y", "x.md.md", "x.txt", "X", "a b", "a.b", "con", "nul.md", " x", "x ",
    ".claude/commands/", ".claude/commands//x.md", "./x", ".\\x", "~/x", "//server/share/x.md", "x::$DATA", "x.",
  ];
  for (const b of bad) assert.throws(() => confineConfigPath("command", b), /Refusing/, JSON.stringify(b));
  assert.throws(() => confineConfigPath("agent", ".claude/commands/x.md"), /Refusing/);
  assert.throws(() => confineConfigPath("command", null), /Refusing/);
});

test("confineSettingsPath allows exactly the two settings files", () => {
  assert.equal(confineSettingsPath("settings.json"), ".claude/settings.json");
  assert.equal(confineSettingsPath("settings.local.json"), ".claude/settings.local.json");
  for (const b of ["", "../settings.json", ".claude/settings.json", "settings.json/", "SETTINGS.json", "credentials.json", "settings.json\0"]) {
    assert.throws(() => confineSettingsPath(b), /Refusing/, JSON.stringify(b));
  }
});

test("validScopeCwd: normalized absolute paths only", () => {
  for (const ok of ["C:\\Users\\Fugma\\proj", "C:/Users/x", "c:\\", "/", "/home/u/proj", "/home/u/proj/", "D:\\a b\\c"]) assert.ok(validScopeCwd(ok), ok);
  const bad = [
    "", " ", "relative/path", "./x", "..", "../x", "C:", "C:x", "C:\\a\\..\\b", "C:\\..\\x", "/a/../b", "/a/./b", "/a//b", "C:\\a\\\\b",
    "//server/share", "\\\\server\\share", "/a/%2e%2e/b", "/a/%2E%2E%2Fb", "/a%5cb", "/a\0b", "/a\nb", " /a", "/a ", "~", "~/x", "x".repeat(1100),
  ];
  for (const b of bad) assert.ok(!validScopeCwd(b), JSON.stringify(b));
  assert.ok(!validScopeCwd(undefined));
});

test("frontmatter: block lists and folded text are flattened, not dropped", () => {
  const p = parseFrontmatter("---\nname: x\nallowed-tools:\n  - Bash(git status:*)\n  - Read\ndescription: >\n  line one\n  line two\n---\nbody\n");
  assert.equal(p.fields["allowed-tools"], "Bash(git status:*), Read");
  assert.equal(p.fields.description, "line one line two");
  const out = serializeFrontmatter(p.fields, p.body, ["name", "description"], p.order);
  assert.match(out, /allowed-tools: "Bash\(git status:\*\), Read"/);
  assert.equal(parseFrontmatter(out).fields["allowed-tools"], "Bash(git status:*), Read");
});

test("serialize quotes any value containing a colon", () => {
  assert.match(serializeFrontmatter({ description: "a:b" }, "x", ["description"]), /description: "a:b"/);
});
