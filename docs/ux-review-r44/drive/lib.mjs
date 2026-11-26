// R44 helpers (copied from R43): open a page, snapshot state (URL, selected rows, breadcrumb, main header).
import path from "node:path";
import { startServer, server, resetBackend } from "./mock.mjs";
import { ROOT, OUT, LOGS, pw, findBrowser, prefsInit } from "./common.mjs";
export { OUT, LOGS, server, resetBackend };
export async function boot(port) { await startServer(path.join(ROOT, "dist"), port); return pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] }); }
export async function open(browser, { port, theme = "dark", w = 1920, h = 1080, dsf = 1, q = "?demo=" }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, colorScheme: theme });
  await ctx.addInitScript(prefsInit(theme));
  await ctx.addInitScript(WRAP);
  const page = await ctx.newPage(); page.setDefaultTimeout(6000); page.errs = []; page.on("pageerror", (e) => page.errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  return { ctx, page };
}
export const state = (page) => page.evaluate(() => {
  const qa = (s) => [...document.querySelectorAll(s)];
  const sel = qa('.boring-sidebar [aria-current="true"], .boring-sidebar [aria-current="page"], .boring-sidebar .on, .boring-sidebar .is-selected');
  const crumb = document.querySelector('[data-testid="boring-breadcrumb"], .boring-breadcrumb');
  const head = document.querySelector('[data-testid="boring-lane-no-agent-head"]') || document.querySelector('.boring-agent-header') || document.querySelector('[data-testid="boring-overview"], .boring-overview');
  return {
    url: location.search, hist: history.length,
    selected: [...new Set(sel.map((e) => (e.dataset.testid || e.className.toString().slice(0, 40)) + " | " + e.innerText.replace(/\n/g, " / ").slice(0, 50)))],
    crumb: crumb ? crumb.innerText.replace(/\n/g, " ") : null,
    head: head ? head.innerText.replace(/\n/g, " / ").slice(0, 120) : null,
    empty: !!document.querySelector('[data-testid="boring-lane-no-agent"]'),
    title: document.title,
    split: !!document.querySelector('[data-testid="boring-pane-right"]'),
    right: (document.querySelector('[data-testid="boring-pane-right"]')?.innerText || '').replace(/\n/g, ' / ').slice(0, 90) || null,
  };
});

// History-call wrapper + per-frame screen signature log (to catch a flash of another screen during Back/Forward/reload).
const WRAP = `(() => {
  window.__h = []; window.__sig = [];
  for (const k of ["pushState", "replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__h.push(k + " " + String(a[2] ?? "").replace(location.origin, "")); return o(...a); }; }
  addEventListener("popstate", () => window.__h.push("POP"));
  const sig = () => { const e = document.querySelector('[data-testid="boring-lane-no-agent-head"]'); const c = document.querySelector('[data-testid="boring-breadcrumb"]');
    return (e ? "CARD " + e.textContent.trim() : "") + " @ " + (c ? c.textContent.trim() : "-"); };
  const tick = () => { const s = sig(); if (window.__sig[window.__sig.length - 1] !== s) window.__sig.push(s); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`;
export const take = (page) => page.evaluate(() => ({ h: window.__h.splice(0), sig: window.__sig.splice(0), hlen: history.length }));
export async function step(page, label, fn, wait = 900) {
  await take(page); await fn(); await page.waitForTimeout(wait);
  const t = await take(page); const s = await state(page);
  return { label, ...s, h: t.h, frames: t.sig };
}
