import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpFile, toView, validateDraft, emptyDraft, draftToConfig, draftFromView, applyOp, maskedJson, diffLines, hasChanges, MASKED } from "../src/paseoMcpLogic.ts";

const FILE = JSON.stringify({
  other: 1,
  mcpServers: {
    a: { command: "node", args: ["x.js"], env: { TOKEN: "sk-secret123456" } },
    b: { type: "http", url: "https://e.test/mcp", headers: { Authorization: "Bearer abc" } },
    c: { type: "sse", url: "https://e.test/sse" },
  },
});

test("parse: transports inferred, empty and bad files", () => {
  const p = parseMcpFile(FILE);
  assert.deepEqual(p.servers.map((s) => [s.name, s.transport]), [["a", "stdio"], ["b", "http"], ["c", "sse"]]);
  assert.equal(parseMcpFile("  ").servers.length, 0);
  assert.match(parseMcpFile("{nope").error, /valid JSON/);
  assert.match(parseMcpFile("[]").error, /object/);
  assert.match(parseMcpFile('{"mcpServers":[]}').error, /mcpServers/);
  assert.equal(toView("x", { url: "https://u" }).transport, "http");
  assert.equal(toView("x", { command: "c", disabled: true }).enabled, false);
});

test("validate: name, required fields, duplicates", () => {
  const d = emptyDraft();
  assert.equal(validateDraft(d, [], null).length, 2);
  assert.deepEqual(validateDraft({ ...d, name: "ok", command: "node" }, [], null), []);
  assert.match(validateDraft({ ...d, name: "a", command: "n" }, ["a"], null)[0], /already exists/);
  assert.deepEqual(validateDraft({ ...d, name: "a", command: "n" }, ["a"], "a"), []);
  assert.match(validateDraft({ ...d, name: "h", transport: "http", url: "ftp://x" }, [], null)[0], /http/);
  assert.match(validateDraft({ ...d, name: "k", command: "n", env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }, [], null)[0], /Duplicate/);
});

test("draft round trip keeps unknown keys, drops stale transport fields", () => {
  const prev = { command: "node", args: ["x"], env: { A: "1" }, alwaysLoad: true };
  const d = draftFromView(toView("a", prev));
  assert.equal(d.args, "x");
  const cfg = draftToConfig({ ...d, transport: "http", url: " https://u " }, prev);
  assert.deepEqual(cfg, { type: "http", url: "https://u", alwaysLoad: true });
  assert.deepEqual(draftToConfig({ ...emptyDraft(), name: "n", command: "node", args: "-e\n\n--x" }), { type: "stdio", command: "node", args: ["-e", "--x"] });
});

test("applyOp: add, edit in place, rename, remove; other keys preserved", () => {
  const { doc } = parseMcpFile(FILE);
  const added = JSON.parse(applyOp(doc, { kind: "upsert", name: "z", config: { type: "stdio", command: "n" } }));
  assert.deepEqual(Object.keys(added.mcpServers), ["a", "b", "c", "z"]);
  assert.equal(added.other, 1);
  const edited = JSON.parse(applyOp(doc, { kind: "upsert", name: "b", config: { type: "http", url: "https://n" } }));
  assert.deepEqual(Object.keys(edited.mcpServers), ["a", "b", "c"]);
  assert.equal(edited.mcpServers.b.url, "https://n");
  const renamed = JSON.parse(applyOp(doc, { kind: "upsert", name: "bb", renameFrom: "b", config: { type: "http", url: "https://n" } }));
  assert.deepEqual(Object.keys(renamed.mcpServers), ["a", "bb", "c"]);
  const removed = JSON.parse(applyOp(doc, { kind: "remove", name: "a" }));
  assert.deepEqual(Object.keys(removed.mcpServers), ["b", "c"]);
  assert.deepEqual(JSON.parse(applyOp({}, { kind: "upsert", name: "n", config: {} })).mcpServers, { n: {} });
});

test("masking hides env + header values everywhere, keeps keys", () => {
  const { doc } = parseMcpFile(FILE);
  const out = maskedJson(doc);
  assert.ok(!out.includes("sk-secret") && !out.includes("Bearer abc"));
  assert.ok(out.includes("TOKEN") && out.includes(MASKED) && out.includes("Authorization"));
});

test("diff: only changed lines + context; no-change detected", () => {
  const { doc } = parseMcpFile(FILE);
  const before = maskedJson(doc);
  const after = maskedJson(JSON.parse(applyOp(doc, { kind: "remove", name: "c" })));
  const d = diffLines(before, after);
  assert.ok(hasChanges(d));
  assert.ok(d.some((l) => l.sign === "-" && l.text.includes('"c"')));
  assert.ok(d.length < before.split("\n").length);
  assert.equal(hasChanges(diffLines(before, before)), false);
});

test("unsafe keys rejected; server named env/headers/__proto__ survives ops and masking", () => {
  const d = { ...emptyDraft(), command: "n" };
  for (const n of ["__proto__", "constructor", "prototype"]) assert.match(validateDraft({ ...d, name: n }, [], null)[0], /Name/);
  assert.match(validateDraft({ ...d, name: "ok", env: [{ key: "__proto__", value: "x" }] }, [], null)[0], /not allowed/);
  assert.match(validateDraft({ ...d, name: "h", transport: "http", url: "http://" }, [], null)[0], /valid/);
  const doc = JSON.parse('{"mcpServers":{"env":{"command":"n","env":{"A":"secret"}},"headers":{"type":"http","url":"https://h.test"}}}');
  const out = JSON.parse(maskedJson(doc));
  assert.equal(out.mcpServers.env.command, "n");
  assert.equal(out.mcpServers.env.env.A, MASKED);
  assert.equal(out.mcpServers.headers.url, "https://h.test");
  const parsed = parseMcpFile('{"mcpServers":{"__proto__":{"command":"x"}}}');
  assert.deepEqual(parsed.servers.map((s) => s.name), ["__proto__"]);
  assert.ok(applyOp(parsed.doc, { kind: "upsert", name: "z", config: {} }).includes("__proto__"));
});
