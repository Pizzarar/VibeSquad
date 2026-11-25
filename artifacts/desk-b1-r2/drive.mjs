import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const pw = createRequire("/tmp/pwtool/node_modules/")("playwright-core");
const dist = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const server = createServer((req, res) => { const p = decodeURIComponent(new URL(req.url, "http://x").pathname); const fp = path.join(dist, p === "/" ? "index.html" : p); if (!existsSync(fp) || statSync(fp).isDirectory()) { res.statusCode = 404; return res.end(); } res.setHeader("content-type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" }[path.extname(fp)] ?? "application/octet-stream"); createReadStream(fp).pipe(res); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ executablePath: "/usr/bin/chromium-browser", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
await ctx.addInitScript(`try{localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.theme":"dark"}));}catch{}`);
await ctx.addInitScript(`(()=>{window.__h=[];for(const k of ["pushState","replaceState"]){const o=history[k].bind(history);history[k]=(...a)=>{window.__h.push(k+" "+(typeof a[2]==="string"?a[2].replace(/^.*\\?/,"?"):""));return o(...a)}}addEventListener("popstate",()=>window.__h.push("POP "+location.search))})()`);
const page = await ctx.newPage();
const log = [];
const step = async (name, fn) => { await fn?.(); await page.waitForTimeout(900); const s = await page.evaluate(() => ({ calls: window.__h.splice(0), hlen: history.length, url: location.search, chat: !!document.querySelector(".boring-timeline, .timeline"), crumb: (document.querySelector(".boring-crumb-seg")?.parentElement?.textContent || "").replace(/\s+/g, " ").trim() })); log.push({ step: name, ...s }); console.log(name, JSON.stringify(s)); await page.screenshot({ path: path.join(out, `${String(log.length).padStart(2, "0")}-${name}.png`) }); };
const needs = () => page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
await page.goto(`${base}/?demo=&team=vibesquad`); await page.waitForSelector(".boring-sidebar"); await page.waitForTimeout(900);
await step("start");
// Flow A: chat -> (project row) -> Back -> Forward
await step("A1-chat", needs);
await step("A2-project-row", () => page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click());
await step("A3-back", () => page.goBack());
await step("A4-forward", () => page.goForward());
// Flow B: chat -> Open in Inbox -> Back
await step("B1-chat", needs);
const inbox = page.getByText("Open in Inbox").first();
if (await inbox.count()) await step("B2-open-in-inbox", () => inbox.click({ force: true })); else log.push({ step: "B2-open-in-inbox", skipped: "no ref popover in demo chat" });
await step("B3-back", () => page.goBack());
// Flow C: Ctrl+K cross-project pick -> Back -> Forward
await step("C1-ctrlk", async () => { await page.keyboard.press("Control+k"); });
await step("C2-pick", async () => { await page.keyboard.type("Main Game"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); });
await step("C3-back", () => page.goBack());
await step("C4-forward", () => page.goForward());
writeFileSync(path.join(out, "steps.json"), JSON.stringify(log, null, 1));
await browser.close(); server.close();
