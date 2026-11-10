// Boring Mode B3 (docs/PLAN_BORING_MODE.md): AngelBezel renders a compact corporate header when <html data-vibe="boring">.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const src = readFileSync(resolve(import.meta.dirname, "..", "src", "AngelBezel.tsx"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "vs-boring-b3-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
const stub = (name, body) => writeFileSync(join(dir, name), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);
globalThis.__opened = [];
globalThis.__toasts = [];
stub("PinIdeas.mjs", "export const showPinToast = (m) => globalThis.__toasts.push(m);");
stub("pinFocus.mjs", "export const openPinMember = (pin, id) => globalThis.__opened.push([pin.lane.id, id]);");
stub("SkyZones.mjs", `export const FaceStage = () => React.createElement("i", { "data-stub": "face" });\nexport const useSkyBezel = () => ({ frameStyle: null });`);
stub("skyZonesLogic.mjs", "export const angelCssScale = () => 4; export const cloudStripStyle = () => undefined; export const faceBg = () => null; export const SKY_CLOUDS_URL = () => '';");
stub("uiScale.mjs", "export const useUiScale = () => 1;");
stub(
  "useBotFace.mjs",
  "export const useBotFace = () => null; export const useDpr = () => 1; export const useFacesModel = () => null; export const useImageOk = () => false; export const usePrefersReducedMotion = () => false; export const useSkyCloudsModel = () => null; export const useTheme = () => 'dark';",
);
const code = transformSync("AngelBezel.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from ${JSON.stringify(reactUrl)}`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "AngelBezel.mjs"), code);
const { AngelBezel, BoringPerfectionBar, isBoringVibe } = await import(pathToFileURL(join(dir, "AngelBezel.mjs")).href);

const member = (id) => ({ agent: { id } });
const pin = (over = {}) => ({ lane: { id: "per", name: "Perfection" }, brainstorm: member("bs"), lead: member("ld"), ...over });
const bar = (p, onOpen) => React.createElement(BoringPerfectionBar, { pin: p, onOpen });
// Walk the element tree (function components are called with their props) to find a button by testid.
function find(node, testid) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((n) => find(n, testid)).find(Boolean) ?? null;
  if (node.props?.["data-testid"] === testid) return node;
  return find(node.props?.children, testid);
}
const tree = (p, onOpen) => BoringPerfectionBar({ pin: p, onOpen });

test("isBoringVibe: only 'boring' is boring; unset/fun/other default to fun", () => {
  assert.equal(isBoringVibe("boring"), true);
  for (const v of [null, undefined, "", "fun", "Boring"]) assert.equal(isBoringVibe(v), false);
});

test("fun mode (no document / default): AngelBezel renders the CRT strip and bezel, no boring bar", () => {
  const html = renderToStaticMarkup(React.createElement(AngelBezel, { pin: pin(), onOpen: () => {} }));
  assert.match(html, /data-testid="angel-strip"/);
  assert.match(html, /data-testid="angel-bezel"/);
  assert.match(html, /data-testid="angel-hit"/);
  assert.doesNotMatch(html, /angel-boring-bar/);
});

test("boring bar markup: title, @per badge, both buttons; no CRT bezel", () => {
  const html = renderToStaticMarkup(bar(pin(), () => {}));
  assert.match(html, /data-testid="angel-boring-bar"/);
  assert.match(html, /aria-label="Workflows &amp; Perfection"/);
  assert.match(html, /data-testid="angel-boring-title">Workflows &amp; Perfection</);
  assert.match(html, /<code class="angel-boring-code">@per<\/code>/);
  assert.match(html, /data-testid="angel-open-brainstorm"/);
  assert.match(html, /data-testid="angel-open-lead"/);
  assert.doesNotMatch(html, /angel-bezel|angel-strip/);
});

test("boring bar: no pin disables both; no lead disables Lead only", () => {
  let t = tree(null, () => {});
  assert.equal(find(t, "angel-open-brainstorm").props.disabled, true);
  assert.equal(find(t, "angel-open-lead").props.disabled, true);
  t = tree(pin(), undefined);
  assert.equal(find(t, "angel-open-brainstorm").props.disabled, true);
  t = tree(pin({ lead: null }), () => {});
  assert.equal(find(t, "angel-open-brainstorm").props.disabled, false);
  assert.equal(find(t, "angel-open-lead").props.disabled, true);
  assert.equal(find(t, "angel-open-lead").props.title, "Lead (none)");
});

test("boring bar: Brainstorm calls onOpen(pin); Lead calls openPinMember(pin, lead id); rejected onOpen toasts", async () => {
  const p = pin();
  const seen = [];
  const t = tree(p, (x) => void seen.push(x));
  find(t, "angel-open-brainstorm").props.onClick();
  assert.deepEqual(seen, [p]);
  find(t, "angel-open-lead").props.onClick();
  assert.deepEqual(globalThis.__opened, [["per", "ld"]]);
  find(tree(p, () => Promise.reject("boom")), "angel-open-brainstorm").props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(globalThis.__toasts.length, 1);
  assert.match(globalThis.__toasts[0], /Could not open Perfection: boom/);
});
