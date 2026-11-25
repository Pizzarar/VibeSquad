// @desk B2 measure: from a chat in project A (VibeSquad, Audit - token scout), open project B (Main Game Project / efi) via
// (a) Ctrl+K agent pick, (b) Needs-you row, (c) sidebar agent row, (d) project row, (e)-(g) notification click (see below). Logs every history write, history.length delta,
// mixed entries (a written URL that is neither the start nor the final URL), and whether one Back changes the screen back to the chat.
// Usage: PLAYWRIGHT_DIR=… PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=… node artifacts/desk-b2/drive/measure.mjs [dark|light] (needs a built dist/)
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { resolvePlaywright, findBrowser, REPO_ROOT } from "../../../scripts/ui-overlap/env.mjs";
const theme = process.argv[2] || "dark";
const pw = resolvePlaywright(); const exe = findBrowser();
const dist = path.join(REPO_ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((req, res) => { const p = decodeURIComponent(new URL(req.url, "http://x").pathname); const fp = path.join(dist, p === "/" ? "index.html" : p); if (!existsSync(fp) || statSync(fp).isDirectory()) { res.statusCode = 404; return res.end(); } res.setHeader("content-type", MIME[path.extname(fp)] || "application/octet-stream"); createReadStream(fp).pipe(res); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
const WRAP = `(()=>{window.__h=[];for(const k of ["pushState","replaceState"]){const o=history[k].bind(history);history[k]=(...a)=>{window.__h.push(k.replace("State","")+" "+String(a[2]).replace(/^.*\\?/,"?"));return o(...a)}}addEventListener("popstate",()=>window.__h.push("POP "+location.search))})()`;
const SEQ = {
  "a-ctrlk": async (p) => { await p.keyboard.press("Control+k"); await p.waitForTimeout(400); await p.keyboard.type("UI Lab"); await p.waitForTimeout(400); await p.keyboard.press("Enter"); },
  "b-needs": async (p) => { await p.locator(".boring-sidebar .boring-needs-open", { hasText: "Main Game Project" }).first().click(); },
  "c-sidebar": async (p) => { // expand Main Game Project, then its UI Lab lane, then click the lane's Lead row
    await p.locator(".boring-sidebar .boring-chevron-btn").first().click(); await p.waitForTimeout(500);
    await p.locator(".boring-sidebar .boring-conv-title", { hasText: "UI Lab" }).locator("xpath=..").locator(".boring-chevron-btn").first().click(); await p.waitForTimeout(500);
    await p.locator(".boring-sidebar .boring-conv-title", { hasText: "UI Lab" }).locator("xpath=../following-sibling::*").locator(".boring-worker-row", { hasText: "Lead" }).first().click()
      .catch(() => p.locator(".boring-sidebar .boring-worker-row", { hasText: /^Lead/ }).first().click());
    await p.waitForTimeout(300); 
  },
  "d-project": async (p) => { await p.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); },
  // (e) extra: a notification click (service-worker vs:select-agent) opens the agent first; the team follows in BoringApp's landing effect.
  "e-notify": async (p) => { await p.evaluate(() => window.postMessage({ type: "vs:select-agent", agentId: "demo-lead-ui" }, "*")); },
  // (f)/(g) round 2 (Review-Gemini M1): the notification opens the agent a commit before the team; a pinsHome / pinLayout flip in that commit
  // used to fire the URL sync with the old team and the new (live) agent. (f) starts on VibeSquad's Overview, (g) on the chat with focus=needs-you.
  "f-notify-ov": async (p) => { await p.evaluate(() => window.postMessage({ type: "vs:select-agent", agentId: "demo-lead-ui" }, "*")); },
  "g-notify-focus": async (p) => { await p.evaluate(() => window.postMessage({ type: "vs:select-agent", agentId: "demo-lead-ui", url: "/?focus=needs-you" }, "*")); },
};
const snap = (p) => p.evaluate(() => { const t = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim(); return { h: window.__h.splice(0), hlen: history.length, url: location.search, chat: !!document.querySelector(".boring-timeline, .timeline"), crumb: t(document.querySelector(".boring-crumb-seg")?.parentElement).slice(0, 60) }; });
const results = [];
for (const [name, act] of Object.entries(SEQ)) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: theme });
  await ctx.addInitScript(`try{localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.theme":"${theme}"}))}catch{}`);
  await ctx.addInitScript(WRAP);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/?demo=&team=vibesquad`);
  await page.waitForSelector(".boring-sidebar"); await page.waitForTimeout(900);
  if (name !== "f-notify-ov") { await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click(); await page.waitForTimeout(900); }
  const s0 = await snap(page);
  await act(page); await page.waitForTimeout(900);
  const s1 = await snap(page);
  await page.goBack(); await page.waitForTimeout(900);
  const s2 = await snap(page);
  await page.goBack(); await page.waitForTimeout(900);
  const s3 = await snap(page);
  const written = s1.h.map((x) => x.split(" ")[1]);
  const mixed = written.filter((u) => u !== s0.url && u !== s1.url);
  const dead = s2.url === s1.url && s2.chat === s1.chat && s2.crumb === s1.crumb;
  const backOk = s2.url === s0.url && s2.chat === s0.chat;
  const r = { seq: name, start: s0.url, final: s1.url, writes: s1.h, dLen: s1.hlen - s0.hlen, mixed, back: { url: s2.url, chat: s2.chat, writes: s2.h }, deadBack: dead, backToStart: backOk, back2: { url: s3.url, chat: s3.chat, crumb: s3.crumb, writes: s3.h, dead: s3.url === s2.url && s3.chat === s2.chat && s3.crumb === s2.crumb }, errs: errs.length };
  results.push(r);
  console.log(`${name.padEnd(10)} start=${s0.url} -> final=${s1.url} (${s1.chat ? "chat" : "ov"}) dLen=+${r.dLen} writes=[${s1.h.join(" | ")}] mixed=${JSON.stringify(mixed)}`);
  console.log(`${"".padEnd(10)} Back -> ${s2.url} (${s2.chat ? "chat" : "ov"}:${s2.crumb}) writes=[${s2.h.join(" | ")}] deadBack=${dead} backToStart=${backOk} pageerrors=${errs.length}`);
  console.log(`${"".padEnd(10)} Back#2 -> ${s3.url} (${s3.chat ? "chat" : "ov"}:${s3.crumb}) writes=[${s3.h.join(" | ")}] dead=${r.back2.dead}`);
  await ctx.close();
}
console.log("JSON " + JSON.stringify(results));
await browser.close(); server.close();
