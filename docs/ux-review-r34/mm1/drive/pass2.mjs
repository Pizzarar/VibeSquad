// R34 MM1 pass 2: flows with a Main project set: select the Main row (.on), Open (Buddy chat), Ctrl+J away,
// expand Main + another project, hover, click on the marker spot. 3200@1.2 + 1280x720, dark + light.
import path from "node:path"; import fs from "node:fs";
import { startServer } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r34/mm1");
const PORT = 5962; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const VP = { "4k120": [{ width: 3200, height: 1800 }, 1.2], "720": [{ width: 1280, height: 720 }, 1], "1080": [{ width: 1920, height: 1080 }, 1] };
const all = {};
const anon = (page) => page.evaluate(() => { const map = new Map(); let i = 0; document.querySelectorAll(".boring-project-name").forEach((e) => { const k = e.getAttribute("title") || e.textContent; if (!map.has(k)) map.set(k, "Project " + "ABCDEFG"[i++]); e.textContent = map.get(k); }); });
const probe = (page) => page.evaluate(() => {
  const r = (e) => e ? (({ x, y, width, height }) => ({ x: +x.toFixed(1), y: +y.toFixed(1), w: +width.toFixed(1), h: +height.toFixed(1) }))(e.getBoundingClientRect()) : null;
  const pin = document.querySelector(".boring-main-pin"); const line = pin?.querySelector(".boring-main-line"); const row = line?.querySelector(".boring-project-row");
  const mk = document.querySelector('[data-testid="boring-main-marker"]');
  return { url: location.search, markers: document.querySelectorAll('[data-testid="boring-main-marker"]').length, marker: r(mk), line: r(line), pin: r(pin),
    rowOn: row?.classList.contains("on"), rowBg: row ? getComputedStyle(row).backgroundColor : null, lineBg: line ? getComputedStyle(line).backgroundColor : null,
    onRows: document.querySelectorAll(".boring-sidebar .on").length, open: line?.querySelector(".boring-chevron-btn")?.getAttribute("aria-expanded"),
    head: document.querySelector(".boring-agent-header, .boring-main-head, h1, h2")?.innerText?.slice(0, 80), pinScroll: pin ? [pin.scrollTop, pin.scrollHeight, pin.clientHeight] : null };
});
for (const vk of ["4k120", "720", "1080"]) for (const theme of ["dark", "light"]) {
  const [viewport, dsf] = VP[vk]; const name = `${theme}-${vk}`; const steps = {};
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, colorScheme: theme });
  let saved = null;
  await ctx.route("**/api/teams", async (route) => { const req = route.request();
    if (req.method() === "PUT") { saved = JSON.parse(req.postData() || "{}").teams; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, revision: "r" + Date.now() }) }); }
    if (saved) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ teams: saved, revision: "r1" }) });
    return route.fulfill({ status: 404, body: "nf" }); });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-project-row", { timeout: 20000 }); await page.waitForTimeout(1500);
  const ids = await page.$$eval('[data-testid^="boring-project-menu-"]', (es) => es.map((e) => e.dataset.testid.replace("boring-project-menu-", "")));
  let made = false;
  for (let k = 0; k < 3 && !made; k++) { await page.click(`[data-testid="boring-project-menu-${ids[1]}"]`); await page.waitForTimeout(300);
    try { await page.getByText("Make main project", { exact: true }).click({ timeout: 3000 }); made = true; } catch { await page.keyboard.press("Escape"); } }
  await page.waitForTimeout(1000); steps.made = made; steps.afterMain = await probe(page);
  // select Main row
  await page.click(".boring-main-pin .boring-project-row"); await page.waitForTimeout(800); steps.selected = await probe(page);
  await page.mouse.move(5, 5); await page.waitForTimeout(200);
  await anon(page); let p = steps.selected.pin; const clip = (p) => ({ x: Math.max(0, p.x - 6), y: Math.max(0, p.y - 6), width: p.w + 12, height: Math.min(p.h, 90) + 12 });
  if (p) await page.screenshot({ path: path.join(OUT, `mm1-${name}-selected-pin.png`), clip: clip(p) });
  await page.screenshot({ path: path.join(OUT, `mm1-${name}-selected-window.png`) });
  // hover row
  await page.hover(".boring-main-pin .boring-project-name"); await page.waitForTimeout(250);
  if (p) await page.screenshot({ path: path.join(OUT, `mm1-${name}-hover-pin.png`), clip: clip(p) });
  // click on the marker spot
  const before = await probe(page); const mr = before.marker;
  if (mr) { await page.mouse.click(mr.x + mr.w / 2, mr.y + mr.h / 2); await page.waitForTimeout(600); }
  steps.markerClick = { before: before.url, after: (await probe(page)).url, menuOpen: await page.evaluate(() => !!document.querySelector('[role="menu"]')) };
  await page.keyboard.press("Escape");
  // Open -> Buddy chat
  await page.click('[data-testid="boring-main-open"]'); await page.waitForTimeout(900); steps.open = await probe(page);
  // Ctrl+J away
  await page.keyboard.press("Control+j"); await page.waitForTimeout(600);
  steps.ctrlJ = await page.evaluate(() => document.querySelector('[role="dialog"], .command-palette, [class*="palette"]')?.innerText?.slice(0, 200));
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await page.waitForTimeout(900); steps.afterJ = await probe(page);
  // expand Main + another project
  const ch = page.locator(".boring-main-pin .boring-main-line > .boring-chevron-btn"); if (await ch.count()) { if ((await ch.getAttribute("aria-expanded")) !== "true") await ch.click(); }
  await page.waitForTimeout(600); steps.expanded = await probe(page);
  await page.evaluate(() => { const pin = document.querySelector(".boring-main-pin"); if (pin) pin.scrollTop = 120; }); await page.waitForTimeout(300);
  steps.expandedScrolled = await probe(page);
  await anon(page); p = steps.expandedScrolled.pin;
  if (p) await page.screenshot({ path: path.join(OUT, `mm1-${name}-expanded-scrolled-pin.png`), clip: { x: Math.max(0, p.x - 6), y: Math.max(0, p.y - 6), width: p.w + 12, height: Math.min(p.h, 260) + 12 } });
  await page.screenshot({ path: path.join(OUT, `mm1-${name}-expanded-window.png`) });
  all[name] = { steps, errs }; console.log(name, JSON.stringify(all[name]));
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, "logs/pass2.json"), JSON.stringify(all, null, 2));
await browser.close(); process.exit(0);
