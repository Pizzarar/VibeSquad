// R29 probe: after a Back with NO user input (pop stays armed in r5), do non-input sources write history?
// P1 clock fast-forward 15 min (workers cross the 10-min stall line -> Needs-you arrivals, Done recently churn)
// P2 a second tab changes prefs (storage event) ; P3 programmatic vs:boring-open-agent (no input) ; then walk Back/Forward to check entries
import { pw, state } from "./lib.mjs";
const [port, w, h, theme, out] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5], process.argv[6]];
const browser = await pw.chromium.launch({ executablePath: "/usr/bin/chromium-browser", headless: true });
const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
await ctx.addInitScript(`try{ if(!sessionStorage.getItem("_init")){sessionStorage.setItem("_init","1"); localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"}));}}catch{}`);
await ctx.addInitScript(`(()=>{window.__h=[];for(const k of ["pushState","replaceState","back","forward","go"]){const o=history[k].bind(history);history[k]=(...a)=>{window.__h.push(k+" "+(typeof a[2]==="string"?a[2].replace(/^.*\\?/,"?"):(a[0]??"")));return o(...a)}}addEventListener("popstate",()=>window.__h.push("POP "+location.search))})()`);
const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.clock.install();
await page.goto(`http://127.0.0.1:${port}/?demo=&team=vibesquad`); await page.waitForSelector(".boring-sidebar"); await page.clock.runFor(800);
const tag = `${theme}-${w}`;
const needsCount = () => page.evaluate(() => (document.querySelector("[data-testid=boring-needs-you-count]")?.textContent || "").trim());
const step = async (n, shot) => { await page.clock.runFor(700); const s = await state(page); const nc = await needsCount(); if (shot && out) await page.screenshot({ path: `${out}/${tag}-ni-${n}.png` }); const inv = s.on.length === 1 && (s.chat ? /agent=/.test(s.url) : !/agent=/.test(s.url)); console.log(`${n.padEnd(18)} ${s.url.padEnd(44)} ${s.chat ? "chat" : "ov"}:${s.crumb} needs=${nc} on=${s.on.length} inv=${inv} len=${s.hlen} :: ${s.hist}`); return s; };
const needs = (t) => page.locator(".boring-sidebar .boring-needs-open", { hasText: t }).first().click();
await step("0-start");
await needs("Audit - token scout"); await step("1-aud");
await needs("Review - Sonnet"); await step("2-rev");
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await step("3-efi");
await page.goBack(); await step("4-back(rev)", true);
// P1: 15 minutes pass with no input
for (let i = 0; i < 15; i++) await page.clock.runFor(60_000);
await step("5-+15min", true);
// P2: another tab flips the theme pref and a Normal pref
const p2 = await ctx.newPage(); await p2.goto(`http://127.0.0.1:${port}/?demo=&team=efi`); await p2.waitForSelector(".boring-sidebar").catch(() => {});
await p2.evaluate((t) => { const p = JSON.parse(localStorage.getItem("vs.prefs.v1") || "{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({ ...p, "app.theme": t })); }, theme === "dark" ? "light" : "dark");
await p2.close(); await page.bringToFront();
await step("6-other-tab-pref", true);
await page.goForward(); await step("7-fwd(efi)");
await page.goBack(); await step("8-back(rev)");
await page.goBack(); await step("9-back(aud)");
await page.goForward(); await page.goForward(); await step("10-fwd2(efi)");
// P3: programmatic open (no input) while armed
await page.goBack(); await step("11-back(rev)");
await page.evaluate(() => window.dispatchEvent(new CustomEvent("vs:boring-open-agent", { detail: { agentId: "demo-aud" }, cancelable: true })));
await step("12-prog-open(aud)", true);
await page.goForward(); await step("13-fwd");
await page.goBack(); await step("14-back");
await page.goBack(); await step("15-back");
console.log("pageerrors=" + errs.length + (errs.length ? " " + errs.join(" ; ") : ""));
await browser.close();
