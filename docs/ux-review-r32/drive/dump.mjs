import { createRequire } from "node:module";
const require = createRequire("/tmp/pwtool/");
const { chromium } = require("playwright-core");
const [port, w, h, theme, q = "?demo=1&riff=1", rewrites = "[]", shot = ""] = process.argv.slice(2);
const rw = JSON.parse(rewrites);
const b = await chromium.launch({ executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: +w, height: +h }, colorScheme: theme });
await ctx.addInitScript(`try{localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.theme":"${theme}"}));}catch{}`);
if (rw.length) await ctx.route(/\/assets\/index-.*\.js$/, async (route) => {
  const r = await route.fetch(); let body = await r.text();
  for (const [a, c] of rw) body = body.split(a).join(c);
  route.fulfill({ response: r, body, headers: { ...r.headers(), "content-type": "text/javascript" } });
});
const page = await ctx.newPage(); const errs = []; page.on("pageerror", e => errs.push(e.message));
await page.goto(`http://127.0.0.1:${port}/${q}`);
await page.waitForSelector('[data-testid="boring-needs-you-item"]', { timeout: 20000 });
await page.waitForTimeout(800);
const out = await page.evaluate(() => {
  const sb = document.querySelector(".boring-sidebar");
  const rows = [...document.querySelectorAll('[data-testid="boring-needs-you-item"]')].map(li => {
    const q = s => li.querySelector(s); const bx = el => el ? Math.round(el.getBoundingClientRect().width) : null;
    const who = q(".boring-needs-who"), where = q('[data-testid="boring-needs-where"]'), lane = q(".boring-needs-lane"), proj = q(".boring-needs-proj"), open = q(".boring-needs-open"), reason = q(".boring-needs-reason");
    const fs = parseFloat(getComputedStyle(who).fontSize);
    // estimate visible chars: ratio of clientWidth to scrollWidth * text length
    const vis = (el) => el && el.textContent ? Math.min(el.textContent.length, Math.floor(el.textContent.length * el.clientWidth / Math.max(el.scrollWidth,1))) : 0;
    return { who: who.textContent, whoW: bx(who), whoCh: +(bx(who)/ (fs*0.5)).toFixed(1), whoVis: vis(who), whoTrunc: who.scrollWidth > who.clientWidth,
      lane: lane?.textContent, laneW: bx(lane), laneVis: vis(lane), laneTrunc: lane && lane.scrollWidth > lane.clientWidth,
      proj: proj?.textContent, projW: bx(proj), projVis: vis(proj), projTrunc: proj && proj.scrollWidth > proj.clientWidth,
      sep: getComputedStyle(proj, "::before").content, title: where.getAttribute("title"), whereText: where.innerText,
      whereOverflow: where.getBoundingClientRect().right > open.getBoundingClientRect().right + 0.5,
      reason: reason?.textContent?.slice(0,50), reasonTrunc: reason && reason.scrollWidth > reason.clientWidth,
      h: Math.round(li.getBoundingClientRect().height) };
  });
  return { sbW: sb.getBoundingClientRect().width, sbScroll: sb.scrollWidth > sb.clientWidth, header: document.querySelector('[data-testid="boring-needs-you"]')?.innerText.split("\n")[0], rows };
});
console.log(JSON.stringify({ errs, ...out }, null, 1));
if (shot) await page.locator('[data-testid="boring-needs-you"]').screenshot({ path: shot });
await b.close();
