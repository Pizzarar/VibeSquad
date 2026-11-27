// R34 MM1 Main marker: 3200x1800@1.2, 1920x1080, 1280x720 x dark/light (+ reduced motion). Makes the first
// project Main via its ⋯ menu ("Make main project"; /api/teams PUT is answered by a route so the save sticks),
// then measures the marker vs Open / ⋯ / chevron / name, row height with vs without the marker, blink frames.
import path from "node:path"; import fs from "node:fs";
import { startServer } from "./mock.mjs";
import { resolvePlaywright, findBrowser } from "../../../../scripts/ui-overlap/env.mjs";
const pw = resolvePlaywright();
const ROOT = process.cwd(); const OUT = path.join(ROOT, "docs/ux-review-r34/mm1"); fs.mkdirSync(path.join(OUT, "logs"), { recursive: true });
const PORT = 5961; await startServer(path.join(ROOT, "dist"), PORT);
const browser = await pw.chromium.launch({ executablePath: findBrowser(), args: ["--no-sandbox"] });
const VP = { "4k120": [{ width: 3200, height: 1800 }, 1.2], "1080": [{ width: 1920, height: 1080 }, 1], "720": [{ width: 1280, height: 720 }, 1] };
const MAINIDX = Number(process.env.MAINIDX ?? 1); const runs = []; for (const v of Object.keys(VP)) for (const t of ["dark", "light"]) runs.push([v, t, "no-preference"]);
runs.push(["4k120", "dark", "reduce"], ["1080", "light", "reduce"]);
const all = {};
for (const [vk, theme, rm] of runs) {
  const [viewport, dsf] = VP[vk];
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, colorScheme: theme, reducedMotion: rm });
  let saved = null;
  await ctx.route("**/api/teams", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") { saved = JSON.parse(req.postData() || "{}").teams; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, revision: "r" + Date.now() }) }); }
    if (saved) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ teams: saved, revision: "r1" }) });
    return route.fulfill({ status: 404, body: "nf" });
  });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-project-row", { timeout: 20000 }); await page.waitForTimeout(1500);
  const name = `${theme}-${vk}${rm === "reduce" ? "-rm" : ""}${MAINIDX === 0 ? "-active" : ""}`;
  // pick the 2nd project (not the active one) so we also see Main + non-active, then Make main via ⋯ menu
  const ids = await page.$$eval('[data-testid^="boring-project-menu-"]', (es) => es.map((e) => e.dataset.testid.replace("boring-project-menu-", "")));
  const target = (MAINIDX === 0 ? ids[0] : ids[1]) ?? ids[0]; const name0 = `${theme}-${vk}`;
  await page.click(`[data-testid="boring-project-menu-${target}"]`);
  try { await page.getByText("Make main project", { exact: true }).click({ timeout: 5000 }); } catch (e) { const t = await page.evaluate(() => [...document.querySelectorAll('[role="menu"], .ctx-menu, [class*="context"]')].map((x) => x.innerText.slice(0, 300))); console.log("MENU-FAIL", name0, JSON.stringify(t)); await page.screenshot({ path: path.join(OUT, `fail-${name0}.png`) }); await ctx.close(); continue; }
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const r = (e) => e ? (({ x, y, width, height }) => ({ x: +x.toFixed(2), y: +y.toFixed(2), w: +width.toFixed(2), h: +height.toFixed(2) }))(e.getBoundingClientRect()) : null;
    const ov = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const pin = document.querySelector(".boring-main-pin"); const line = pin?.querySelector(".boring-main-line");
    const mk = document.querySelector('[data-testid="boring-main-marker"]');
    const open = pin?.querySelector('[data-testid="boring-main-open"]'); const menu = line?.querySelector(".boring-row-menu-btn");
    const chev = line?.querySelector(".boring-chevron-btn"); const nm = line?.querySelector(".boring-project-name"); const row = line?.querySelector(".boring-project-row");
    const add = line?.querySelector(".boring-lane-add");
    const cs = mk ? getComputedStyle(mk) : null;
    const R = { marker: r(mk), open: r(open), menu: r(menu), chev: r(chev), name: r(nm), row: r(row), add: r(add), line: r(line), pin: r(pin) };
    const lineH = line?.getBoundingClientRect().height; const pinH = pin?.getBoundingClientRect().height;
    if (mk) mk.style.display = "none"; const lineH0 = line?.getBoundingClientRect().height; const pinH0 = pin?.getBoundingClientRect().height;
    const nameW0 = nm?.getBoundingClientRect().width; if (mk) mk.style.display = "";
    return { R, dpr: devicePixelRatio, devicePx: mk ? +(mk.getBoundingClientRect().width * devicePixelRatio).toFixed(3) : null,
      bg: cs?.backgroundImage?.replace(/^.*\/ui\//, "").replace(/"\)$/, ""), anim: cs?.animationName, rendering: cs?.imageRendering, bgSize: cs?.backgroundSize,
      lineH, lineH0, pinH, pinH0, nameW: nm?.getBoundingClientRect().width, nameW0, nameTrunc: nm ? nm.scrollWidth > nm.clientWidth + 1 : null,
      rowOn: row?.classList.contains("on"), rowBg: row ? getComputedStyle(row).backgroundColor : null, lineBg: line ? getComputedStyle(line).backgroundColor : null,
      overlaps: { open: ov(R.marker, R.open), menu: ov(R.marker, R.menu), chev: ov(R.marker, R.chev), name: ov(R.marker, R.name), add: ov(R.marker, R.add) },
      gapToMenu: R.marker && R.menu ? +(R.menu.x - (R.marker.x + R.marker.w)).toFixed(2) : null, gapFromOpen: R.marker && R.open ? +(R.marker.x - (R.open.x + R.open.w)).toFixed(2) : null,
      markerCount: document.querySelectorAll('[data-testid="boring-main-marker"]').length, sidebarW: document.querySelector(".boring-sidebar")?.getBoundingClientRect().width };
  });
  all[name] = { ...m, errs, target: ids.indexOf(target) };
  // anonymize project names on screen before any screenshot (no real names in saved shots)
  await page.evaluate(() => { let i = 0; document.querySelectorAll(".boring-project-name").forEach((e) => { e.textContent = "Project " + "ABCDEFG"[i++]; }); document.querySelectorAll(".brand-name, .boring-breadcrumb").forEach(() => {}); });
  await page.screenshot({ path: path.join(OUT, `mm1-${name}-window.png`) });
  if (m.R.pin) {
    const p = m.R.pin; const clip = { x: Math.max(0, p.x - 6), y: Math.max(0, p.y - 6), width: p.w + 12, height: Math.min(p.h, 90) + 12 };
    await page.screenshot({ path: path.join(OUT, `mm1-${name}-pin.png`), clip });
    if (rm !== "reduce") {
      for (const [f, t] of [["blink0", 3820], ["blink1", 3920]]) {
        await page.evaluate((t) => { const a = document.querySelector('[data-testid="boring-main-marker"]')?.getAnimations()[0]; if (a) { a.pause(); a.currentTime = t; } }, t);
        await page.waitForTimeout(100);
        await page.screenshot({ path: path.join(OUT, `mm1-${name}-pin-${f}.png`), clip });
      }
    }
  }
  console.log(name, JSON.stringify(all[name]));
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, `logs/pass1-main${MAINIDX}.json`), JSON.stringify(all, null, 2));
await browser.close(); process.exit(0);
