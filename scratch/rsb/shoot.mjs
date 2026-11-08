// RS-b shooter: starts the harness vite server, freezes rAF (manual stepping, fake clock) and captures slam frames.
// usage: node scratch/rsb/shoot.mjs   -> scratch/shots/rsb-{4k|1080}-{dark|light}-*.png (+ reduced-motion check)
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const require = createRequire("C:/Users/Fugma/projects/VibeSquad/scratch/pw/package.json");
const { chromium } = require("playwright-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "shots");
fs.mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: path.join(here, "vite.config.mjs"), server: { port: 5231, strictPort: true } });
await server.listen();
const base = "http://localhost:5231/";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const freeze = () => {
  let now = 1000;
  let q = [];
  window.requestAnimationFrame = (cb) => (q.push(cb), q.length);
  window.cancelAnimationFrame = () => { q = []; };
  window.__step = (ms) => { now += ms; const run = q; q = []; run.forEach((cb) => cb(now)); return run.length; };
};
const rows = [];
const VIEWS = [
  { name: "4k", w: 3200, h: 1800, dpr: 1.2 },
  { name: "1080", w: 1920, h: 1080, dpr: 1 },
];
for (const v of VIEWS) for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: v.dpr });
  const page = await ctx.newPage();
  await page.addInitScript(freeze);
  await page.goto(`${base}?theme=${theme}`);
  await page.waitForSelector('[data-testid="sky-face-overlord"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="sky-face-overlord"]')?.style.backgroundImage.includes("face-overlord"));
  await page.waitForTimeout(400);
  const sky = page.locator('[data-testid="sky-zones"]');
  const info = async (tag) => {
    const d = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="sky-face-overlord"]');
      const fx = document.querySelector('[data-testid="sky-slam-fx"]');
      return { mode: f?.dataset.faceMode, k: f?.style.transform, zoom: fx?.dataset.zoomStep, puffFrame: fx?.dataset.puffFrame, rects: document.querySelectorAll('[data-testid="sky-zoom-rect"]').length, puffs: document.querySelectorAll('[data-testid="sky-slam-puff"]').length, panelOpacity: getComputedStyle(document.querySelector('[data-testid="sky-chat-riffbot"]')).opacity, panelHidden: document.querySelector('[data-testid="sky-chat-riffbot"]').hidden };
    });
    rows.push({ shot: `${v.name}-${theme}-${tag}`, ...d });
  };
  const step = async (ms) => { await page.evaluate((m) => window.__step(m), ms); await page.waitForTimeout(80); };
  const shot = async (tag) => { await info(tag); await sky.screenshot({ path: path.join(out, `rsb-${v.name}-${theme}-${tag}.png`) }); };
  await shot("rest");
  await page.click('[data-testid="sky-face-hit-riffbot"]');
  await page.waitForTimeout(100);
  await step(0); // first tick: t = 0
  await step(100); // t = 100: zoom step 2
  await shot("zoom-mid");
  await step(165); // t = 265: landed, squash frame, puff frame 0
  await shot("landed-squash");
  await step(70); // t = 335: puff frame 1, shake
  await shot("puff");
  await step(1000);
  await shot("open-settled");
  await page.click('[data-testid="sky-chat-close-riffbot"]');
  await page.waitForTimeout(100);
  await step(0);
  await step(90); // close t = 90: reverse zoom
  await shot("close-zoom");
  await step(410); // close t = 500: dizzy
  await shot("dizzy-after-close");
  await step(1000); // past 1s: back to idle
  await shot("dizzy-done-idle");
  await ctx.close();
}
// reduced motion: instant open/close, no fx
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript(freeze);
  await page.goto(`${base}?theme=dark`);
  await page.waitForSelector('[data-testid="sky-face-overlord"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="sky-face-hit-riffbot"]');
  await page.waitForTimeout(150);
  const d = await page.evaluate(() => ({ open: document.querySelector('[data-testid="sky-zones"]').dataset.open, rects: document.querySelectorAll('[data-testid="sky-zoom-rect"]').length, puffs: document.querySelectorAll('[data-testid="sky-slam-puff"]').length, fxDisplay: getComputedStyle(document.querySelector('[data-testid="sky-slam-fx"]')).display, panelOpacity: getComputedStyle(document.querySelector('[data-testid="sky-chat-riffbot"]')).opacity, panelTransform: getComputedStyle(document.querySelector('[data-testid="sky-chat-riffbot"]')).transform, animation: getComputedStyle(document.querySelector('[data-testid="sky-chat-riffbot"]')).animationName, mode: document.querySelector('[data-testid="sky-face-overlord"]').dataset.faceMode }));
  rows.push({ shot: "reduced-open", ...d });
  await page.click('[data-testid="sky-chat-close-riffbot"]');
  await page.waitForTimeout(150);
  rows.push({ shot: "reduced-closed", ...(await page.evaluate(() => ({ open: document.querySelector('[data-testid="sky-zones"]').dataset.open, rects: document.querySelectorAll('[data-testid="sky-zoom-rect"]').length, puffs: document.querySelectorAll('[data-testid="sky-slam-puff"]').length, mode: document.querySelector('[data-testid="sky-face-overlord"]').dataset.faceMode }))) });
  await page.locator('[data-testid="sky-zones"]').screenshot({ path: path.join(out, "rsb-1080-dark-reduced-closed.png") });
  await ctx.close();
}
await browser.close();
await server.close();
console.log(JSON.stringify(rows, null, 1));
