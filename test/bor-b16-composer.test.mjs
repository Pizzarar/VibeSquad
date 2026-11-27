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
import { resolvePlaywright, findBrowser, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

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

// ---- The REAL useAgentConfig, transformed with stubbed imports and a recording React shim (no mocks of its own output). ----
const hookSrc = transformSync("useAgentConfig.tsx", read("src", "useAgentConfig.tsx"), { lang: "tsx", jsx: { runtime: "classic" } }).code
  .replace(/^import type .*$/gm, "")
  .replace(/^import \{[^}]*\} from "react";$/m, 'const { useState, useRef, useEffect } = globalThis.__shim;')
  .replace(/^import \{[^\n]*\} from "\.\/DrawerHeader";$/m, "const { PROVIDER_OPTIONS, buildProviderModelOptions, configNote, modesFor, nextModeInCycle, normalizeProviderId, oppositeProviderTarget, providerModelsCache, resolveProviderSwitchTarget, setModeHelper, setModelHelper, setThinkingHelper, thinkingLevelsFor } = globalThis.__dh;")
  .replace(/^import \{[^}]*\} from "\.\/(paseo|demoFlag|paseoProviders|runnerBridge|pixel|teams|panes|pinActions)";$/gm, (m, mod) => `const { ${m.match(/\{([^}]*)\}/)[1]} } = globalThis.__stubs.${mod};`);
writeFileSync(join(dir, "Hook.mjs"), `import React from ${JSON.stringify(import.meta.resolve("react"))};\n` + hookSrc);
const calls = { fetch: 0, listen: 0 };
globalThis.__stubs = {
  paseo: { updateAgent() {}, upsertLocalAgent() {} }, demoFlag: { DEMO: false },
  paseoProviders: { listProviderModels: () => { calls.fetch++; return Promise.resolve({ models: [] }); } },
  runnerBridge: { runnerSpawn() {} }, pixel: { providerSpec: () => ({ name: "Claude", color: "#fff" }) },
  teams: { kindOf: () => "worker" }, panes: { openAgentInTab() {} }, pinActions: { setLastBrainstormProfile() {} },
};
globalThis.__dh = {
  PROVIDER_OPTIONS: [{ id: "claude", label: "Claude" }, { id: "gemini", label: "Gemini" }], buildProviderModelOptions: () => ["m1"], configNote: () => "",
  modesFor: () => [{ id: "auto", label: "Auto" }], nextModeInCycle: () => "auto", normalizeProviderId: (x) => x, oppositeProviderTarget: () => ({ provider: "gemini", label: "⇄ Switch to Gemini" }),
  providerModelsCache: new Map(), resolveProviderSwitchTarget: () => null, setModeHelper() {}, setModelHelper() {}, setThinkingHelper() {}, thinkingLevelsFor: () => ["low", "high"],
};
globalThis.window = { addEventListener: () => { calls.listen++; }, removeEventListener() {} };
const runHook = async (args) => {
  const effects = [];
  globalThis.__shim = { useState: (i) => [typeof i === "function" ? i() : i, () => {}], useRef: (v) => ({ current: v }), useEffect: (fn) => effects.push(fn) };
  const { useAgentConfig } = await import(pathToFileURL(join(dir, "Hook.mjs")).href + "?" + Math.random());
  calls.fetch = 0; calls.listen = 0;
  const cfg = useAgentConfig({ agent: { id: "a", provider: "claude", model: "m1", currentModeId: "auto", labels: {} }, active: true, isBs: false, doRestart: async () => {}, ...args });
  for (const fx of effects) fx();
  return cfg;
};
const labelOf = (el) => el?.props?.["aria-label"];

test("REAL useAgentConfig: Provider, Model, Thinking and Mode selects carry accessible names (aria-label + title)", async () => {
  const cfg = await runHook({});
  assert.equal(labelOf(cfg.providerSelect), "Provider");
  assert.equal(labelOf(cfg.modelControl), "Model");
  assert.equal(labelOf(cfg.thinkingSelect), "Thinking");
  assert.equal(labelOf(cfg.modeSelect), "Mode");
  for (const k of ["providerSelect", "modelControl", "thinkingSelect", "modeSelect"]) assert.ok(cfg[k].props.title, `${k} has a title`);
  assert.ok(cfg.providerSwitchBtn, "one-click Switch to X is exposed for the bar");
});

test("REAL useAgentConfig: enabled=false is inert (no model-list fetch, no Shift+Tab listener); default stays live", async () => {
  await runHook({ enabled: false });
  assert.deepEqual(calls, { fetch: 0, listen: 0 });
  await runHook({});
  assert.deepEqual(calls, { fetch: 1, listen: 1 });
});

test("bar renders the switch button, visible Think/Mode hints and the staged hint", () => {
  const html = renderToStaticMarkup(React.createElement(BoringComposerBar, base({ providerSwitchBtn: React.createElement("button", { "data-testid": "drawer-switch-provider-btn" }, "⇄ Switch to Gemini"), stagedHint: "Switching to Gemini on your next message" })));
  assert.ok(html.includes("drawer-switch-provider-btn"));
  assert.ok(html.includes(">Think<") && html.includes(">Mode<"));
  assert.ok(html.includes('data-testid="boring-composer-staged"'));
  assert.ok(!renderToStaticMarkup(React.createElement(BoringComposerBar, base())).includes("boring-composer-staged"));
});

const chromium = resolvePlaywright({ npx: false })?.chromium ?? null;
const exe = findBrowser();
const skip = browserSkipReason({ pw: chromium, exe });
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

const measureBar = () => {
  const card = document.querySelector(".boring-composer-row").getBoundingClientRect();
  const kids = [...document.querySelectorAll(".boring-composer-bar button, .boring-composer-bar select, .boring-composer-bar input")]
    .map((e) => ({ id: e.getAttribute("data-testid") || e.getAttribute("aria-label"), r: e.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  const rows = [];
  for (const k of kids) {
    const cy = (k.r.top + k.r.bottom) / 2;
    const hit = rows.find((row) => Math.abs(row.cy - cy) < 16);
    if (hit) hit.ids.push(k.id);
    else rows.push({ cy, ids: [k.id] });
  }
  const overlaps = [];
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const a = kids[i].r, b = kids[j].r;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push([kids[i].id, kids[j].id]);
  }
  const outside = kids.filter((k) => k.r.right > card.right + 0.5 || k.r.left < card.left - 0.5).map((k) => k.id);
  const rowLists = rows.map((r) => r.ids);
  const thinkRow = rowLists.findIndex((r) => r.includes("drawer-thinking-select") || r.includes("Thinking"));
  const modeRow = rowLists.findIndex((r) => r.includes("drawer-mode-select") || r.includes("Mode"));
  return { rowCount: rowLists.length, rows: rowLists, overlaps, outside, thinkRow, modeRow, modeOrphan: modeRow >= 0 && rowLists[modeRow].length === 1 };
};

test("B18b DOM: at 530px (1280x720 ctx open, 482px card) and 550px split-pane width, <= 2 rows and Mode never orphans alone", { skip }, async () => {
  const sw = React.createElement("button", { type: "button", className: "btn small", "data-testid": "drawer-switch-provider-btn" }, "⇄ Switch to Claude");
  for (const width of [530, 550]) {
    const r = await launch(page("dark", "boring", width, { isBs: false, running: true, providerSwitchBtn: sw }), (p) => p.evaluate(measureBar));
    assert.deepEqual(r.overlaps, [], `no overlaps at ${width}px`);
    assert.deepEqual(r.outside, [], `no clipping at ${width}px`);
    assert.ok(r.rowCount <= 2, `at most 2 rows at ${width}px, got ${r.rowCount}: ${JSON.stringify(r.rows)}`);
    assert.equal(r.modeOrphan, false, `Mode must not orphan alone at ${width}px: ${JSON.stringify(r.rows)}`);
    assert.equal(r.thinkRow, r.modeRow, `Think and Mode stay paired at ${width}px: ${JSON.stringify(r.rows)}`);
  }
});

test("B18b browser: real app at 1280x720 (ctx panel open) and narrow ~550px split keeps <= 2 composer rows and no orphaned Mode", { skip, timeout: 120000 }, async () => {
  const E = await import(pathToFileURL(join(root, "scripts", "ui-overlap", "env.mjs")).href);
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    for (const [label, w, h, ctxOpen, split] of [["1280x720 ctx open", 1280, 720, true, false], ["narrow split (~550px pane)", 1400, 800, false, true]]) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: "dark" });
      await ctx.addInitScript(`try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");localStorage.setItem("vs.context-panel.open","${ctxOpen ? "1" : "0"}");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"boring","app.theme":"dark"}));}catch{}`);
      await E.installRoutes(ctx);
      const p = await ctx.newPage();
      await p.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
      await p.locator('[data-testid="boring-worker-demo-aud"]').click({ timeout: 15000 });
      await p.locator('[data-testid="boring-composer-bar"]').first().waitFor({ timeout: 10000 });
      await p.waitForTimeout(300);
      if (split) {
        await p.locator('[data-testid="boring-split-toggle"]').click();
        await p.locator('[data-testid="boring-pp-active"] [data-testid^="boring-pp-agent-"]').nth(1).click({ timeout: 5000 });
        await p.waitForTimeout(300);
      }
      const bars = await p.evaluate(() => [...document.querySelectorAll(".boring-composer-row")].map((row) => {
        const card = row.getBoundingClientRect();
        const kids = [...row.querySelectorAll(".boring-composer-bar button, .boring-composer-bar select, .boring-composer-bar input")]
          .map((e) => ({ id: e.getAttribute("data-testid") || e.getAttribute("aria-label"), r: e.getBoundingClientRect() }))
          .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
        const rows = [];
        for (const k of kids) {
          const cy = (k.r.top + k.r.bottom) / 2;
          const hit = rows.find((rw) => Math.abs(rw.cy - cy) < 16);
          if (hit) hit.ids.push(k.id);
          else rows.push({ cy, ids: [k.id] });
        }
        const rowLists = rows.map((rw) => rw.ids);
        const overlaps = [];
        for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].r, bb = kids[j].r;
          if (a.left < bb.right - 1 && bb.left < a.right - 1 && a.top < bb.bottom - 1 && bb.top < a.bottom - 1) overlaps.push([kids[i].id, kids[j].id]);
        }
        const outside = kids.filter((k) => k.r.right > card.right + 0.5 || k.r.left < card.left - 0.5).map((k) => k.id);
        const thinkRow = rowLists.findIndex((rw) => rw.includes("drawer-thinking-select") || rw.includes("Thinking"));
        const modeRow = rowLists.findIndex((rw) => rw.includes("drawer-mode-select") || rw.includes("Mode"));
        return { cardW: Math.round(card.width), rowCount: rowLists.length, rows: rowLists, overlaps, outside, thinkRow, modeRow, modeOrphan: modeRow >= 0 && rowLists[modeRow].length === 1 };
      }));
      assert.ok(bars.length >= (split ? 2 : 1), `${label}: expected composer bar(s)`);
      for (const r of bars) {
        assert.deepEqual(r.overlaps, [], `${label}: overlaps`);
        assert.deepEqual(r.outside, [], `${label}: clipped`);
        assert.ok(r.rowCount <= 2, `${label} (${r.cardW}px): <= 2 rows, got ${r.rowCount}: ${JSON.stringify(r.rows)}`);
        assert.equal(r.modeOrphan, false, `${label} (${r.cardW}px): Mode orphaned: ${JSON.stringify(r.rows)}`);
        assert.equal(r.thinkRow, r.modeRow, `${label} (${r.cardW}px): Think+Mode paired: ${JSON.stringify(r.rows)}`);
      }
      await ctx.close();
    }
  } finally { await b.close(); server.close(); }
});

// Measure only once layout is settled (fonts ready + rects unchanged across two frames), so a late font/@import/container reflow under
// suite load can't be read mid-flight. Rows are clustered by vertical overlap (not fixed 8px buckets, which split one row whenever
// align-items:center offsets differ by a few px), then read top-to-bottom, left-to-right.
const probeComposer = async (extra) => {
  const q = (s) => document.querySelector(s);
  if (extra) document.head.appendChild(Object.assign(document.createElement("style"), { textContent: extra }));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const snap = () => [...document.querySelectorAll(".boring-composer-bar *")].map((e) => { const r = e.getBoundingClientRect(); return `${r.left},${r.top},${r.width},${r.height}`; }).join("|");
  await document.fonts.ready;
  for (let prev = null, same = 0, i = 0; same < 2 && i < 200; i++) { await frame(); const cur = snap(); same = cur === prev ? same + 1 : 0; prev = cur; }
  const els = { actions: q(".boring-composer-actions"), cfg: q(".boring-composer-cfg"), staged: q(".boring-composer-staged"), send: q(".boring-composer-send") };
  const present = Object.entries(els).filter(([, e]) => e);
  const items = present.map(([k, e]) => ({ k, r: e.getBoundingClientRect() })).sort((a, b) => a.r.top - b.r.top);
  const rows = [];
  for (const it of items) { const row = rows.find((w) => it.r.top < w.bottom && it.r.bottom > w.top); if (row) { row.items.push(it); row.top = Math.min(row.top, it.r.top); row.bottom = Math.max(row.bottom, it.r.bottom); } else rows.push({ top: it.r.top, bottom: it.r.bottom, items: [it] }); }
  const visual = rows.sort((a, b) => a.top - b.top).flatMap((w) => w.items.sort((a, b) => a.r.left - b.r.left).map((x) => x.k));
  const sm = q(".boring-composer-bar > .btn.small");
  return { visual, orders: Object.fromEntries(present.map(([k, e]) => [k, getComputedStyle(e).order])), smFont: getComputedStyle(sm).fontSize, modelGrow: getComputedStyle(q('.boring-composer-cfg select[aria-label="Model"], .boring-composer-cfg input[aria-label="Model"]')).flexGrow, cfgBasis: getComputedStyle(q(".boring-composer-cfg")).flexBasis };
};

test("B18b merge fix 2: wide composer keeps DOM order (actions, cfg, staged, send) with 12px btn.small; narrow (~456px) gets the 2-row order/11px", { skip }, async () => {
  const sw = React.createElement("button", { type: "button", className: "btn small", "data-testid": "drawer-switch-provider-btn" }, "⇄ Switch to Claude");
  const props = { isBs: false, running: true, providerSwitchBtn: sw, stagedHint: "Switching on your next message" };
  const wide = await launch(page("dark", "boring", 1100, props), (p) => p.evaluate(probeComposer));
  assert.deepEqual(wide.visual, ["actions", "cfg", "staged", "send"], `wide visual order ${JSON.stringify(wide)}`);
  assert.ok(Object.values(wide.orders).every((o) => o === "0"), `wide order values all 0: ${JSON.stringify(wide.orders)}`);
  assert.equal(wide.smFont, "12px");
  assert.equal(wide.modelGrow, "0");
  const narrow = await launch(page("dark", "boring", 456, props), (p) => p.evaluate(probeComposer));
  assert.equal(narrow.orders.cfg, "1");
  assert.equal(narrow.orders.actions, "2");
  assert.equal(narrow.orders.send, "4");
  assert.equal(narrow.smFont, "11px");
  assert.equal(narrow.modelGrow, "1");
  assert.equal(narrow.visual[0], "cfg", `narrow: cfg takes the first row: ${JSON.stringify(narrow.visual)}`);
});

test("B18b merge fix 2b: rows are clustered by overlap, so a few px of vertical offset inside one row can't reorder it (idea-1201)", { skip }, async () => {
  const props = { isBs: false, running: true, providerSwitchBtn: React.createElement("button", { type: "button", className: "btn small" }, "⇄ Switch to Claude"), stagedHint: "Switching on your next message" };
  const r = await launch(page("dark", "boring", 1100, props), (p) => p.evaluate(probeComposer, ".boring-composer-actions{margin-top:6px}"));
  assert.deepEqual(r.visual, ["actions", "cfg", "staged", "send"], `offset row order ${JSON.stringify(r)}`);
});
