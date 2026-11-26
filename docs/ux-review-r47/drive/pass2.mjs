// R47 pass2: mock backend (real buildAnswerPrompt) with stress items: long alts, long excerpt, unbroken URL;
// captures the delivered prompt for mixed (B + reply) and Not-that + reply.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, findBrowser, resolvePlaywright } from "../../../scripts/ui-overlap/env.mjs";
import { buildAnswerPrompt, validateAnswerBatch } from "../../../server/decisions.mjs";
const SHOTS = path.join(REPO_ROOT, "docs", "ux-review-r47");
const TEAMS = [{ id: "vibesquad", name: "VibeSquad", color: "#58a6ff", paths: [], lanes: [{ id: "vibesquad", name: "Hub", hub: true }, { id: "desk", name: "Desk", code: "desk" }] }];
const long = "x".repeat(0);
const ctxLines = ["Long context, 40 lines:"]; for (let i = 1; i <= 40; i++) ctxLines.push(`${i}. line of the asker message describing option detail ${i}`);
ctxLines.splice(5, 0, "See https://example.invalid/" + "averyveryverylongpathsegment".repeat(12));
let items, delivered;
const reset = () => { const now = Date.now(); delivered = []; items = [
  { id: "ny-00000000000000000101", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "a1", asker: { id: "a1", title: "Overlord", live: true }, ask: "Partial-fill entry handling: A, B, or C? Also add a veto window on the check-5 same-ticker block?", decides: "Partial-fill spec + veto window", lean: "", kind: "yesno", structured: false, inferred: true,
    alts: ["A: fill-or-kill at entry — cancel the order unless it fills completely", "B: keep the partial fill and resize the stop to the filled size", "C: top up the remainder at the next bar's open"],
    rawText: "Partial-fill entry handling: A, B, or C? Also add a veto window?", context: "A) fill-or-kill\nB) keep partial\nC) top up\nSeparately: veto window?", ts: now - 600000 },
  { id: "ny-00000000000000000102", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "a2", asker: { id: "a2", title: "Desk · Lead 2", live: true }, ask: "Storage backend for run history: A, B, C or D?", decides: "Where run history lives for the next year", lean: "B", kind: "yesno", structured: false, inferred: true,
    alts: ["A: keep JSONL files per squad under ~/.vibesquad/history, rotated nightly with a 30-day cap and no index, which keeps the current tooling working but makes cross-squad search slow",
      "B: SQLite in the server process with WAL mode, one table per entity, migrations shipped with the app, and a nightly vacuum; search becomes instant but the file format changes",
      "C: DuckDB read replicas built from the JSONL on demand",
      "D: https://example.invalid/" + "averyveryverylongpathsegment".repeat(6)],
    rawText: "Storage backend: A, B, C or D?", context: ctxLines.join("\n"), ts: now - 300000 },
  { id: "ny-00000000000000000103", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "a3", asker: { id: "a3", title: "Bugs · Lead 1", live: true }, ask: "Which timeout (ms)?", decides: "Health check timeout", lean: "", alts: [], kind: "answer", structured: true, ts: now - 200000 },
]; };
reset();
const dist = path.join(REPO_ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/api/teams") { res.end(JSON.stringify({ teams: TEAMS, folders: [], revision: "r47" })); return; }
  if (p === "/__vibesquad/decisions" && req.method === "GET") { res.end(JSON.stringify({ ok: true, items, count: items.length, agentsOk: true, generatedAt: new Date().toISOString() })); return; }
  if (p === "/__vibesquad/decisions/answer") { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { const body = JSON.parse(raw || "{}"); const results = [];
    for (const ans of validateAnswerBatch(body)) { const it = items.find((i) => i.id === ans.id); const prompt = buildAnswerPrompt(it, ans, { ownerName: "Aub", target: it.asker.title, via: "asker" }); delivered.push({ raw: body, ans, prompt }); items = items.filter((i) => i.id !== ans.id); results.push({ id: ans.id, choice: ans.choice, status: "delivered", target: it.askerId, via: "asker", logged: true }); }
    res.end(JSON.stringify({ ok: true, results })); }); return; }
  if (p.startsWith("/__vibesquad") || p.startsWith("/api")) { res.end("[]"); return; }
  let fp = path.join(dist, p === "/" ? "index.html" : p); if (!existsSync(fp) || statSync(fp).isDirectory()) fp = path.join(dist, "index.html");
  res.setHeader("content-type", MIME[path.extname(fp)] ?? "application/octet-stream"); createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await resolvePlaywright().chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
const out = {};
for (const cfg of [{ name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1 }, { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2 }, { name: "dark-1280", theme: "dark", width: 1280, height: 800, dpr: 1 }]) {
  reset(); const r = (out[cfg.name] = {});
  const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, deviceScaleFactor: cfg.dpr, colorScheme: cfg.theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); localStorage.setItem("vs.prefs.v1", JSON.stringify({"app.theme":"${cfg.theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${base}/?demo=`, { waitUntil: "domcontentloaded" });
  const L = "ny-00000000000000000102", PF = "ny-00000000000000000101";
  await page.waitForSelector(`[data-testid="boring-decision-card-${L}"]`, { timeout: 20000 });
  await page.waitForTimeout(400);
  const card = page.locator(`[data-testid="boring-decision-card-${L}"]`);
  r.longAlts = await page.evaluate((id) => [...document.querySelectorAll(`[data-testid^="boring-decision-alt-${id}-"]`)].map((b) => ({ w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), overflowX: b.scrollWidth > b.clientWidth + 1, textAlign: getComputedStyle(b).textAlign, owrap: getComputedStyle(b).overflowWrap, wb: getComputedStyle(b).wordBreak })), L);
  r.cardW = await card.evaluate((c) => Math.round(c.getBoundingClientRect().width));
  r.cardOverflow = await card.evaluate((c) => c.scrollWidth > c.clientWidth + 1);
  r.cardH = await card.evaluate((c) => Math.round(c.getBoundingClientRect().height));
  await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: path.join(SHOTS, `r47-${cfg.name}-longalts.png`) });
  await page.locator(`[data-testid="boring-decision-source-toggle-${L}"]`).click(); await page.waitForTimeout(150);
  r.longSrc = await page.evaluate((id) => { const b = document.getElementById(`boring-decision-source-body-${id}`); const cs = getComputedStyle(b); return { h: Math.round(b.getBoundingClientRect().height), scrollH: b.scrollHeight, hOverflow: b.scrollWidth > b.clientWidth + 1, owrap: cs.overflowWrap, wb: cs.wordBreak, lh: cs.lineHeight, visibleLines: Math.round(b.clientHeight / parseFloat(cs.lineHeight)) }; }, L);
  r.cardHOpen = await card.evaluate((c) => Math.round(c.getBoundingClientRect().height));
  // keyboard scroll of the region
  await page.locator(`[data-testid="boring-decision-source-body-${L}"]`).focus(); await page.keyboard.press("PageDown"); await page.waitForTimeout(150);
  r.kbScrollTop = await page.evaluate((id) => document.getElementById(`boring-decision-source-body-${id}`).scrollTop, L);
  await card.screenshot({ path: path.join(SHOTS, `r47-${cfg.name}-longsrc.png`) });
  // mixed ask on PF
  await page.locator(`[data-testid="boring-decision-alt-${PF}-1"]`).click();
  await page.locator(`[data-testid="boring-decision-input-${PF}"]`).fill("Yes, add the 30s veto window");
  // Not that + text on L
  await page.locator(`[data-testid="boring-decision-not-${L}"]`).click();
  await page.locator(`[data-testid="boring-decision-input-${L}"]`).fill("Neither; use Postgres");
  // type-first then pick on 103? it has no alts; type plain answer
  await page.locator(`[data-testid="boring-decision-input-ny-00000000000000000103"]`).fill("45000");
  r.send = await page.locator('[data-testid="boring-decision-send-btn"]').innerText();
  await page.locator('[data-testid="boring-decision-send-btn"]').click();
  await page.locator('[data-testid="boring-decision-send-now-btn"]').click();
  await page.waitForTimeout(1200);
  r.delivered = delivered.map((d) => ({ ans: d.ans, prompt: d.prompt }));
  r.afterSendCards = await page.locator('[data-testid^="boring-decision-card-"]').count();
  r.afterText = (await page.locator("main").innerText().catch(() => "")).slice(0, 400);
  await page.screenshot({ path: path.join(SHOTS, `r47-${cfg.name}-after-send.png`) });
  r.errs = errs; await ctx.close();
}
await browser.close(); server.close();
writeFileSync(path.join(SHOTS, "logs", "pass2.json"), JSON.stringify(out, null, 1)); console.log("ok");
