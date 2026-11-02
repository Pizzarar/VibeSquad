import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";


// Compile the real messageCtxItems out of src/CommandPalette.tsx (no DOM needed).
const src = readFileSync(new URL("../src/CommandPalette.tsx", import.meta.url), "utf8");
const start = src.indexOf("export function messageCtxItems");
const body = src.slice(start, src.indexOf("// ---- context menu store"));
const js = stripTypeScriptTypes("type CtxItem = { label: string; run: () => void };" + "\n" + body.replace("export ", "") + "\n" + "globalThis.__m = messageCtxItems;");
const written = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: (t) => (written.push(t), Promise.resolve()) } } });
new Function(js)();
const messageCtxItems = globalThis.__m;

test("selection inside message -> first item Copy writes only the selection", () => {
  const items = messageCtxItems("whole message text", "agent1", () => {}, "message");
  assert.deepEqual(items.map((i) => i.label), ["Copy", "Park in Inbox", "Copy Agent ID"]);
  items[0].run();
  assert.equal(written.at(-1), "message");
});

test("no selection -> no copy item; whole-message copy is not offered", () => {
  const items = messageCtxItems("whole message text", "agent1", () => {});
  assert.deepEqual(items.map((i) => i.label), ["Park in Inbox", "Copy Agent ID"]);
  assert.ok(!items.some((i) => /Copy Message Text/.test(i.label)));
});

test("Park in Inbox parks the selection when there is one, else the whole text", () => {
  const parked = [];
  messageCtxItems("whole", "a", (t) => parked.push(t), "who")[1].run();
  messageCtxItems("whole", "a", (t) => parked.push(t))[0].run();
  assert.deepEqual(parked, ["who", "whole"]);
});

test("hover Copy button still copies the whole message", () => {
  const tl = readFileSync(new URL("../src/Timeline.tsx", import.meta.url), "utf8");
  assert.match(tl, /function CopyMsgButton\(\{ text \}[^]*?navigator\.clipboard\.writeText\(text\)/);
  assert.equal((tl.match(/<CopyMsgButton text=\{it\.text \?\? ""\} \/>/g) ?? []).length, 2);
});

// ---- selectionWithin, compiled from the real source with a fake Selection/Range ----
const sStart = src.indexOf("export function selectionWithin");
const sBody = src.slice(sStart, src.indexOf("// Whole-message copy"));
globalThis.__sw = null;
const swJs = stripTypeScriptTypes(sBody.replace("export ", "") + "\n" + "globalThis.__sw = selectionWithin;");
new Function(swJs)();
const selectionWithin = globalThis.__sw;

// Elements are plain tokens; a range "touches" the nodes listed in its `hits`.
const fakeSel = (text, hits, collapsed = false) => ({
  isCollapsed: collapsed,
  rangeCount: hits ? 1 : 0,
  getRangeAt: () => ({ intersectsNode: (n) => hits.includes(n) }),
  toString: () => text,
});
const withSel = (sel, fn) => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { getSelection: () => sel } });
  try { return fn(); } finally { delete globalThis.window; }
};
const A = { id: "A" }, B = { id: "B" }, C = { id: "C" };

test("selectionWithin: inside only", () => {
  assert.equal(withSel(fakeSel("hi", [A]), () => selectionWithin(A)), "hi");
});
test("selectionWithin: starts outside and ends inside -> Copy offered with whole highlight", () => {
  assert.equal(withSel(fakeSel("tail of A + head of B", [A, B]), () => selectionWithin(B)), "tail of A + head of B");
});
test("selectionWithin: spans A->B, both offer Copy", () => {
  const s = fakeSel("A..B", [A, B]);
  assert.equal(withSel(s, () => selectionWithin(A)), "A..B");
  assert.equal(withSel(s, () => selectionWithin(B)), "A..B");
});
test("selectionWithin: collapsed / none / elsewhere / null root -> empty", () => {
  assert.equal(withSel(fakeSel("", [A], true), () => selectionWithin(A)), "");
  assert.equal(withSel(fakeSel("x", null), () => selectionWithin(A)), "");
  assert.equal(withSel(fakeSel("x", [C]), () => selectionWithin(A)), "");
  assert.equal(withSel(fakeSel("x", [A]), () => selectionWithin(null)), "");
});
