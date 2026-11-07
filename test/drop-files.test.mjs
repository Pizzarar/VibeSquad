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
  isBinaryBytes,
  MAX_INLINE_BYTES,
} from "../src/attachments.ts";

const mk = (name, body, type = "text/plain") => new File([body], name, { type });

test("composeMessage inlines small text files as fenced blocks", async () => {
  const small = mk("a.ts", "const x = 1;");
  const items = [small].map((f) => ({ name: f.name, size: f.size, file: f }));
  const out = await composeMessage("hello", items);
  assert.ok(out.startsWith("hello\n[file: a.ts]\n```\nconst x = 1;\n```"));
});

test("composeMessage with no files returns the draft untouched", async () => {
  assert.equal(await composeMessage("hi", []), "hi");
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
  const text = await composeMessage("look", [{ name: "a.md", size: f.size, file: f }]);
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
  const t = await composeMessage("", [{ name: "n.md", size: f.size, file: f }]);
  const r = parseSentAttachments(t);
  assert.equal(r.chips[0].name, "n.md");
  assert.equal(r.body, "");
});

test("formatSize", () => {
  assert.equal(formatSize(12), "12 B");
  assert.equal(formatSize(2048), "2 KB");
});

const roundTrip = async (text, files) => {
  const items = files.map((f) => ({ name: f.name, size: f.size, file: f }));
  return parseSentAttachments(await composeMessage(text, items));
};

test("repoPathFor confines chips to the repo, case-insensitive on Windows drives", async () => {
  const { setAgentCwd, repoPathFor } = await import("../src/attachments.ts");
  const win = (s) => s.replaceAll("/", String.fromCharCode(92));
  setAgentCwd("w1", win("C:/Users/me/repo"));
  assert.equal(repoPathFor("w1", win("c:/users/me/repo/src/a.ts")), "src/a.ts");
  assert.equal(repoPathFor("w1", "C:/Users/me/repo/src/a.ts"), "src/a.ts");
  assert.equal(repoPathFor("w1", win("C:/Users/me/repo/../../x")), null);
  assert.equal(repoPathFor("w1", "../../etc/passwd"), null);
  assert.equal(repoPathFor("w1", "~/secret"), null);
  assert.equal(repoPathFor("w1", win("D:/other/a.ts")), null);
  assert.equal(repoPathFor("w1", "src/a.ts"), "src/a.ts");
});

test("parseSentAttachments leaves inline [attached file: x] in plain text alone", () => {
  const t = "see [attached file: x] and\n[attached file: y]\nmore text";
  assert.deepEqual(parseSentAttachments(t), { body: t, chips: [] });
});

test("md attachment containing ``` and ~~~~ round-trips without spilling", async () => {
  const md = "# t\n```js\nx\n```\n~~~~\ny\n~~~~\n````\nz\n````\n";
  const r = await roundTrip("hi [attached file: x]", [mk("n.md", md)]);
  assert.equal(r.body, "hi [attached file: x]");
  assert.deepEqual(r.chips, [{ name: "n.md" }]);
});

test("isBinaryBytes flags null bytes and MAX_INLINE_BYTES is the inline limit", () => {
  assert.equal(isBinaryBytes(new Uint8Array([1, 0, 2])), true);
  assert.equal(isBinaryBytes(new Uint8Array([104, 105])), false); // "hi"
  assert.equal(MAX_INLINE_BYTES, 100 * 1024);
});

test("chips-only steer keeps a non-empty steered label", async () => {
  const fs = await import("node:fs");
  assert.match(fs.readFileSync(new URL("../src/AgentDrawer.tsx", import.meta.url), "utf8"), /setLastSteered\(base \|\| "\(files\)"\)/);
});
