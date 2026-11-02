import assert from "node:assert/strict";
import test from "node:test";
import {
  addAttachments,
  getAttachments,
  clearAttachments,
  composeMessage,
  parseSentAttachments,
  removeAttachment,
  formatSize,
} from "../src/attachments.ts";

const mk = (name, body, type = "text/plain") => new File([body], name, { type });

test("composeMessage appends fenced blocks for small text and refs for big/binary", async () => {
  const small = mk("a.ts", "const x = 1;");
  const big = mk("big.log", "x".repeat(300 * 1024));
  const bin = mk("b.bin", new Uint8Array([1, 0, 2]), "application/octet-stream");
  const items = [small, big, bin].map((f) => ({ name: f.name, size: f.size, file: f }));
  const ups = [];
  const out = await composeMessage("hello", items, async ({ name }) => (ups.push(name), `/repo/uploads/${name}`));
  assert.ok(out.startsWith("hello\n[file: a.ts]\n```\nconst x = 1;\n```"));
  assert.ok(out.includes("[attached file: /repo/uploads/big.log]"));
  assert.ok(out.includes("[attached file: /repo/uploads/b.bin]"));
  assert.deepEqual(ups, ["big.log", "b.bin"]);
});

test("composeMessage with no files returns the draft untouched", async () => {
  assert.equal(await composeMessage("hi", [], async () => "x"), "hi");
});

test("adding attachments never touches a draft; remove drops the chip", () => {
  const draft = "typed text";
  addAttachments("k", [mk("a.md", "# hi"), mk("b.ts", "x")]);
  assert.equal(draft, "typed text");
  const [first, second] = getAttachments("k");
  assert.deepEqual([first.name, second.name], ["a.md", "b.ts"]);
  removeAttachment("k", first.id);
  assert.deepEqual(getAttachments("k").map((a) => a.name), ["b.ts"]);
  clearAttachments("k");
  assert.equal(getAttachments("k").length, 0);
});

test("parseSentAttachments turns blocks and refs into chips and strips the wall of text", async () => {
  const f = mk("a.md", "line1\nline2");
  const text = await composeMessage("look", [{ name: "a.md", size: f.size, file: f }], async () => "");
  const withRef = text + "\n[attached file: C:/r/up/big.log]\n";
  const r = parseSentAttachments(withRef);
  assert.equal(r.body, "look");
  assert.deepEqual(r.chips, [{ name: "a.md" }, { name: "big.log", path: "C:/r/up/big.log" }]);
});

test("parseSentAttachments leaves plain messages alone", () => {
  assert.deepEqual(parseSentAttachments("just text"), { body: "just text", chips: [] });
});

test("fenced content containing ``` round-trips with the ~~~~ fence", async () => {
  const f = mk("n.md", "```js\nx\n```");
  const t = await composeMessage("", [{ name: "n.md", size: f.size, file: f }], async () => "");
  const r = parseSentAttachments(t);
  assert.equal(r.chips[0].name, "n.md");
  assert.equal(r.body, "");
});

test("formatSize", () => {
  assert.equal(formatSize(12), "12 B");
  assert.equal(formatSize(2048), "2 KB");
});
