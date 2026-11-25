import { createRequire } from "node:module";
const require = createRequire("/home/brimblebean/.npm/_npx/9833c18b2d85bc59/node_modules/");
export const pw = require("playwright-core");
export async function open(port, { w, h, zoom = 1, theme = "dark" }, q = "?demo") {
  const browser = await pw.chromium.launch({ executablePath: "/usr/bin/chromium-browser", headless: true });
  const ctx = await browser.newContext({ viewport: { width: Math.round(w / zoom), height: Math.round(h / zoom) }, deviceScaleFactor: zoom, colorScheme: theme });
  await ctx.addInitScript(`try{ if(!sessionStorage.getItem("_init")){sessionStorage.setItem("_init","1"); localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"}));}}catch{}`);
  await ctx.addInitScript(`(()=>{window.__h=[];for(const k of ["pushState","replaceState","back","forward","go"]){const o=history[k].bind(history);history[k]=(...a)=>{window.__h.push(k+" "+(typeof a[2]==="string"?a[2].replace(/^.*\\?/,"?"):(a[0]??"")));return o(...a)}}addEventListener("popstate",()=>window.__h.push("POP "+location.search))})()`);
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/${q}`);
  await page.waitForSelector(".boring-sidebar", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { browser, page, errs };
}
export async function state(page) {
  return page.evaluate(() => {
    const t = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const on = [...document.querySelectorAll(".boring-sidebar .on")].filter(e => e.offsetParent).map(e => `${e.className.split(" ")[0]}:${t(e).slice(0, 40)}`);
    const crumb = t(document.querySelector(".boring-crumb-seg")?.parentElement);
    const hdr = document.querySelector(".boring-agent-header, [class*=agent-header]");
    const composer = document.querySelector("textarea");
    const tab = t(document.querySelector(".boring-overview-tabs .on"));
    const hist = (window.__h||[]).splice(0).join(" | "); return { hist, hlen: history.length, url: location.search, on, crumb, tab, chat: !!document.querySelector(".boring-timeline, .timeline") , head: t(hdr).slice(0, 60), placeholder: composer?.getAttribute("placeholder") || "", theme: document.documentElement.dataset.theme, vibe: document.documentElement.dataset.vibe };
  });
}
