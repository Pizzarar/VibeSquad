// R50 driver: serves dist statically with NO backend so ?demo falls back to demoDecisionItems().
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, findBrowser, resolvePlaywright } from "../../../scripts/ui-overlap/env.mjs";
export { REPO_ROOT };
export const SHOTS = path.join(REPO_ROOT, "docs", "ux-review-r50");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
export let server, baseUrl, browser, pw;
export async function start() {
  pw = resolvePlaywright();
  const dist = path.join(REPO_ROOT, "dist");
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = decodeURIComponent(u.pathname);
    let fp = path.join(dist, p === "/" ? "index.html" : p);
    if (p.startsWith("/api") || p.startsWith("/__vibesquad")) { res.statusCode = 404; res.end("nf"); return; }
    if (!existsSync(fp) || statSync(fp).isDirectory()) fp = path.join(dist, "index.html");
    res.setHeader("content-type", MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream");
    createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
}
export async function stop() { await browser?.close(); await new Promise((r) => server.close(r)); }
export async function open({ theme, width, height, dpr = 1 }, q = "?demo=") {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme });
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/404|Failed to load/.test(m.text())) errs.push("console:" + m.text()); });
  await page.goto(`${baseUrl}/${q}`, { waitUntil: "domcontentloaded" });
  return { context, page, errs };
}
export const CFGS = [
  { name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1 },
  { name: "light-1920", theme: "light", width: 1920, height: 1080, dpr: 1 },
  { name: "dark-3200", theme: "dark", width: 3200, height: 1800, dpr: 1.2 },
  { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2 },
];
