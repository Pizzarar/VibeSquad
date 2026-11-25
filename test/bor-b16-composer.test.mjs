// B16 (@bor): Normal-mode two-row composer bar. The real BoringComposerBar is transformed and (a) walked as an element tree to check
// controls + callbacks, (b) rendered to markup and mounted in Chromium with the real boring.css to measure wrap/overlap and WCAG contrast.
// The browser half skips cleanly when Playwright/Chromium is unavailable.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const dir = mkdtempSync(join(tmpdir(), "vs-b16-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const code = transformSync("BoringComposerBar.tsx", read("src", "BoringComposerBar.tsx"), { lang: "tsx", jsx: { runtime: "classic" } }).code.replace(/^import type .*$/gm, "");
writeFileSync(join(dir, "Bar.mjs"), `import React from ${JSON.stringify(import.meta.resolve("react"))};\n` + code);
const { BoringComposerBar } = await import(pathToFileURL(join(dir, "Bar.mjs")).href);

const sel = (label, opts) => React.createElement("select", { "aria-label": label }, ...opts.map((o) => React.createElement("option", { key: o }, o)));
const base = (over = {}) => ({
  providerSelect: sel("Provider", ["Claude", "Gemini"]), modelControl: sel("Model", ["claude-opus-5-5", "Custom model…"]),
  thinkingSelect: sel("Thinking", ["medium", "high"]), modeSelect: sel("Mode", ["Auto", "Plan"]),
  isBs: false, inboxParking: false, running: false, sendDisabled: false, interruptDisabled: false, interruptTitle: "Interrupt",
  onAttach() {}, onSecret() {}, onPark() {}, onStop() {}, onInterrupt() {}, onSend() {}, ...over,
});
const find = (node, pred, acc = []) => {
  if (!node || typeof node !== "object") return acc;
  if (React.isValidElement(node)) { if (pred(node)) acc.push(node); find(node.props?.children, pred, acc); }
  else if (Array.isArray(node)) node.forEach((n) => find(n, pred, acc));
  return acc;
};
const byId = (tree, id) => find(tree, (n) => n.props["data-testid"] === id)[0];

test("bar exposes attach, secure input, provider/model/thinking/mode and Send; Park only for Brainstorm", () => {
  const worker = renderToStaticMarkup(React.createElement(BoringComposerBar, base()));
  for (const id of ["boring-composer-bar", "boring-composer-attach-btn", "boring-composer-secret-btn", "boring-composer-send-btn"]) assert.ok(worker.includes(`data-testid="${id}"`), id);
  for (const l of ["Provider", "Model", "Thinking", "Mode"]) assert.ok(worker.includes(`aria-label="${l}"`), l);
  assert.ok(!worker.includes("boring-composer-park-btn"));
  assert.ok(!worker.includes("composer-stop-btn"));
  assert.ok(renderToStaticMarkup(React.createElement(BoringComposerBar, base({ isBs: true }))).includes("boring-composer-park-btn"));
  assert.ok(renderToStaticMarkup(React.createElement(BoringComposerBar, base({ thinkingSelect: null, modeSelect: null }))).includes('aria-label="Model"'));
});

test("buttons call their handlers; running swaps Send for Queue and adds Stop + Interrupt", () => {
  const calls = [];
  const h = Object.fromEntries(["onAttach", "onSecret", "onPark", "onStop", "onInterrupt", "onSend"].map((k) => [k, () => calls.push(k)]));
  const tree = BoringComposerBar(base({ ...h, isBs: true, running: true }));
  for (const id of ["boring-composer-attach-btn", "boring-composer-secret-btn", "boring-composer-park-btn", "composer-stop-btn", "composer-interrupt-btn", "boring-composer-send-btn"]) byId(tree, id).props.onClick();
  assert.deepEqual(calls, ["onAttach", "onSecret", "onPark", "onStop", "onInterrupt", "onSend"]);
  assert.equal(byId(tree, "boring-composer-send-btn").props.children, "Queue");
  assert.equal(byId(BoringComposerBar(base()), "boring-composer-send-btn").props.children, "Send");
  assert.equal(byId(BoringComposerBar(base({ sendDisabled: true })), "boring-composer-send-btn").props.disabled, true);
  assert.equal(byId(BoringComposerBar(base({ isBs: true, inboxParking: true })), "boring-composer-park-btn").props.disabled, true);
});

const { chromium } = await (async () => {
  try {
    const d = process.env.PLAYWRIGHT_DIR;
    const pw = d ? await import(pathToFileURL(join(d, "playwright-core", "index.mjs")).href).catch(() => import(pathToFileURL(join(d, "playwright-core", "index.js")).href)) : null;
    return { chromium: pw?.chromium ?? pw?.default?.chromium ?? null };
  } catch { return { chromium: null }; }
})();
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const skip = chromium && exe ? false : "no Playwright/Chromium (set PLAYWRIGHT_DIR + PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)";
const page = (theme, vibe, width, over = {}) => `<!doctype html><html data-vibe="${vibe}" data-theme="${theme}"><head><meta charset="utf-8"><style>${read("src", "styles.css")}\n${read("src", "boring.css")}</style></head><body style="margin:0;width:${width}px"><footer class="composer"><div class="composer-row boring-composer-row"><textarea placeholder="Message Worker…"></textarea>${renderToStaticMarkup(React.createElement(BoringComposerBar, base({ running: true, isBs: true, ...over })))}</div></footer></body></html>`;
const launch = async (html, fn) => {
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try { const p = await b.newPage({ viewport: { width: 1280, height: 720 } }); await p.setContent(html); return await fn(p); } finally { await b.close(); }
};

test("DOM: at 560px (context panel open) the bar wraps, nothing overlaps or clips, Send stays inside the card", { skip }, async () => {
  const r = await launch(page("dark", "boring", 560), (p) => p.evaluate(() => {
    const card = document.querySelector(".boring-composer-row").getBoundingClientRect();
    const kids = [...document.querySelectorAll(".boring-composer-bar button, .boring-composer-bar select")].map((e) => ({ id: e.getAttribute("data-testid") || e.getAttribute("aria-label"), r: e.getBoundingClientRect() }));
    const overlaps = [];
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) { const a = kids[i].r, b = kids[j].r; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push([kids[i].id, kids[j].id]); }
    return { overlaps, outside: kids.filter((k) => k.r.right > card.right + 0.5 || k.r.left < card.left - 0.5).map((k) => k.id), rows: new Set(kids.map((k) => Math.round(k.r.top / 10))).size, ids: kids.map((k) => k.id) };
  }));
  assert.deepEqual(r.overlaps, []);
  assert.deepEqual(r.outside, []);
  assert.ok(r.ids.includes("boring-composer-send-btn") && r.ids.includes("composer-interrupt-btn"));
  assert.ok(r.rows >= 2, "controls wrap onto more than one row at narrow width");
});

const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
for (const theme of ["dark", "light"]) {
  test(`DOM: ${theme} theme, enabled Send / Interrupt / selects / icons meet WCAG 4.5:1`, { skip }, async () => {
    const m = await launch(page(theme, "boring", 900), (p) => p.evaluate(() => {
      // Resolve any CSS colour (incl. color-mix / color(srgb)) to 0-255 rgb through a 1px canvas.
      const cv = document.createElement("canvas"); cv.width = cv.height = 1; const x = cv.getContext("2d", { willReadFrequently: true });
      const rgb = (c) => { x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const bgOf = (el) => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return rgb(c); } return [255, 255, 255]; };
      const out = {};
      for (const [k, s] of [["send", ".boring-composer-send-btn"], ["interrupt", ".composer-interrupt-btn"], ["provider", ".boring-composer-cfg select"], ["attach", ".boring-composer-icon"]]) { const el = document.querySelector(s); out[k] = { fg: rgb(getComputedStyle(el).color), bg: bgOf(el) }; }
      return out;
    }));
    for (const [k, v] of Object.entries(m)) assert.ok(ratio(v.fg, v.bg) >= 4.5, `${theme} ${k} ${ratio(v.fg, v.bg).toFixed(2)}`);
  });
}

test("DOM: Psycho (data-vibe=fun) does not pick up the bar layout rules", { skip }, async () => {
  const d = await launch(page("dark", "fun", 900), (p) => p.evaluate(() => getComputedStyle(document.querySelector(".boring-composer-cfg")).flexWrap));
  assert.notEqual(d, "wrap");
});
