// R52 pass4 (idea-1164 cycle with 2 need-a-look cards, before any send). Derived from R52 pass3 = R50 pass4 + 1600 config + need-a-look click cycle (idea-1164) + Sent row geometry (idea-1165). Was: R50 pass4 (L3: Last sent persistence, re-send replaces, need-a-look probe, long text wrap). Base = R50 pass2 (R48 pass2 + idea-1150 redundant-source cards 10-12, server summary via real choiceLabel, Details banner probe): mock backend (real buildAnswerPrompt/validateAnswerBatch) with bare-letter leans,
// None-of-these cards, classic lean cards; sends a mixed batch and captures prompts + the on-screen summary.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, findBrowser, resolvePlaywright } from "../../../scripts/ui-overlap/env.mjs";
import { buildAnswerPrompt, validateAnswerBatch, choiceLabel } from "../../../server/decisions.mjs";
const SHOTS = path.join(REPO_ROOT, "docs", "ux-review-r52");
const TEAMS = [{ id: "vibesquad", name: "VibeSquad", color: "#58a6ff", paths: [], lanes: [{ id: "vibesquad", name: "Hub", hub: true }, { id: "desk", name: "Desk", code: "desk" }] }];
const base0 = { source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", kind: "yesno" };
const mk = (n, o) => ({ ...base0, id: `ny-000000000000000002${String(n).padStart(2, "0")}`, askerId: `a${n}`, asker: { id: `a${n}`, title: o.t ?? "Desk · Lead 2", live: true }, ...o });
let items, delivered;
const reset = () => { const now = Date.now(); delivered = []; items = [
  mk(1, { ask: "Storage backend for run history: A, B or C?", decides: "Where run history lives next year", lean: "B", inferred: true, structured: false,
    alts: ["A: keep JSONL files per squad, rotated nightly", "B: SQLite in the server process with WAL mode", "C: DuckDB read replicas built on demand"], context: "A) JSONL\nB) SQLite (my pick)\nC) DuckDB", ts: now - 900000 }),
  mk(2, { ask: "U11 universe: a or b?", decides: "Backtest coverage", lean: "(b)", inferred: true, structured: false, t: "Overlord",
    alts: ["a: survivor-only — keep only listed tickers and report coverage %", "b: stop at A1 — ship the A1 universe and defer delisted data"], context: "a) survivor-only\nb) stop at A1", ts: now - 800000 }),
  mk(3, { ask: "Retry policy: A or B?", decides: "Retry behaviour on 5xx", lean: "B)", structured: true,
    alts: ["A: retry 3x with backoff", "B: fail fast and surface the error"], ts: now - 700000 }),
  mk(4, { ask: "Atlas packer?", decides: "VRAM and manifests", lean: "B", structured: true,
    alts: ["Keep shelf packer", "Switch to maxrects"], ts: now - 600000 }),
  mk(5, { ask: "Cache tier: A, B or C?", decides: "Cache cost", lean: "C", structured: true,
    alts: ["A: in-memory only", "B: Redis sidecar"], ts: now - 500000 }),
  mk(6, { ask: "Partial-fill entry handling: A, B, or C? Also add a veto window?", decides: "Partial-fill spec + veto window", lean: "", inferred: true, structured: false, t: "Overlord",
    alts: ["A: fill-or-kill at entry — cancel the order unless it fills completely", "B: keep the partial fill and resize the stop to the filled size", "C: top up the remainder at the next bar's open"],
    context: "A) fill-or-kill\nB) keep partial\nC) top up\nSeparately: veto window?", ts: now - 400000 }),
  mk(7, { ask: "Rename the beta channel to preview?", decides: "Updater channel name", lean: "", structured: true, alts: ["Keep beta"], ts: now - 300000 }),
  mk(8, { ask: "Merge URL history cleanup now?", decides: "Ships U1+U2 ahead of beta", lean: "Merge after green suite", structured: true, alts: ["Hold for D4 bundle"], ts: now - 200000 }),
  mk(9, { ask: "Which timeout (ms)?", decides: "Health check timeout", lean: "", alts: [], kind: "answer", structured: true, t: "Bugs · Lead 1", ts: now - 100000 }),
  mk(10, { ask: "Ship the tray icon refresh in beta 41?", decides: "Beta 41 scope", lean: "Yes", inferred: true, structured: false, alts: ["Hold to beta 42"], context: "Ship the tray icon refresh in beta 41?", ts: now - 90000 }),
  mk(11, { ask: "Turn on   crash upload by default?", decides: "Telemetry default", lean: "No", inferred: true, structured: false, alts: ["Yes, opt-out"], context: "turn on crash upload\n by default?", ts: now - 80000 }),
  mk(12, { ask: "Raise the worker cap to 6?", decides: "Parallel worker limit", lean: "Yes", structured: true, alts: ["Keep 4"], context: "Raise the worker cap to 6? CPU stays under 60% with 6 in the last soak; memory peaks at 11 GB.", ts: now - 70000 }),
]; };
reset();
const dist = path.join(REPO_ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/api/teams") { res.end(JSON.stringify({ teams: TEAMS, folders: [], revision: "r49" })); return; }
  if (p === "/__vibesquad/decisions" && req.method === "GET") { res.end(JSON.stringify({ ok: true, items, count: items.length, agentsOk: true, generatedAt: new Date().toISOString() })); return; }
  if (p === "/__vibesquad/decisions/answer") { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { const body = JSON.parse(raw || "{}"); const results = [];
    for (const ans of validateAnswerBatch(body)) { const it = items.find((i) => i.id === ans.id); const prompt = buildAnswerPrompt(it, ans, { ownerName: "Owner", target: it.asker.title, via: "asker" }); delivered.push({ ans, prompt }); items = items.filter((i) => i.id !== ans.id); results.push({ id: ans.id, choice: ans.choice, status: "delivered", target: it.askerId, via: "asker", logged: true, summary: choiceLabel(it, ans) }); }
    res.end(JSON.stringify({ ok: true, results })); }); return; }
  if (p.startsWith("/__vibesquad") || p.startsWith("/api")) { res.end("[]"); return; }
  let fp = path.join(dist, p === "/" ? "index.html" : p); if (!existsSync(fp) || statSync(fp).isDirectory()) fp = path.join(dist, "index.html");
  res.setHeader("content-type", MIME[path.extname(fp)] ?? "application/octet-stream"); createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await resolvePlaywright().chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
const id = (n) => `ny-000000000000000002${String(n).padStart(2, "0")}`;
const out = {};
for (const cfg of [{ name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1 }, { name: "light-1920", theme: "light", width: 1920, height: 1080, dpr: 1 }, { name: "dark-3200", theme: "dark", width: 3200, height: 1800, dpr: 1.2 }, { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2 }, { name: "dark-1600", theme: "dark", width: 1600, height: 1000, dpr: 1 }, { name: "light-1600", theme: "light", width: 1600, height: 1000, dpr: 1 }]) {
  reset(); const r = (out[cfg.name] = { cards: {} });
  const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, deviceScaleFactor: cfg.dpr, colorScheme: cfg.theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); localStorage.setItem("vs.prefs.v1", JSON.stringify({"app.theme":"${cfg.theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${base}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="boring-decision-card-${id(1)}"]`, { timeout: 20000 }); await page.waitForTimeout(400);
  r.cycle = [];
  for (let k = 0; k < 5; k++) {
    const nl = page.locator('[data-testid="boring-decision-need-look"]'); if (!(await nl.count())) { r.cycle.push("no button"); break; }
    const t = await nl.innerText(); await nl.click(); await page.waitForTimeout(450);
    r.cycle.push({ label: t, ...(await page.evaluate(() => { const c = document.activeElement?.closest?.('[data-testid^="boring-decision-card-"]'); const rr = c?.getBoundingClientRect(); return { card: c?.dataset.testid.slice(-2) ?? null, top: rr && Math.round(rr.top), flash: [...document.querySelectorAll('.boring-decision-card.is-flash')].map((e) => e.dataset.testid.slice(-2)), scrollY: Math.round(document.querySelector('[data-testid="boring-decision-card-ny-00000000000000000201"]').getBoundingClientRect().top) }; })) });
    if (k < 2) await page.screenshot({ path: path.join(SHOTS, `r52-${cfg.name}-cycle${k + 1}.png`) });
  }
  // answer card 4 by clicking its first option, then cycle again
  await page.locator(`[data-testid="boring-decision-alt-${id(4)}-0"]`).click(); await page.waitForTimeout(150);
  const nl = page.locator('[data-testid="boring-decision-need-look"]'); r.afterAnswer4 = (await nl.count()) ? await nl.innerText() : null;
  if (r.afterAnswer4) { await nl.click(); await page.waitForTimeout(400); r.afterAnswer4Jump = await page.evaluate(() => document.activeElement?.closest?.('[data-testid^="boring-decision-card-"]')?.dataset.testid.slice(-2)); }
  await page.mouse.move(5, 5); await page.waitForTimeout(200);
  r.bar = await page.locator('[data-testid="boring-decision-bar"]').innerText();
  await page.locator('[data-testid="boring-decision-bar"]').screenshot({ path: path.join(SHOTS, `r52-${cfg.name}-bar-needlook.png`) });
  r.errs = errs; await ctx.close();
}
await browser.close(); server.close();
writeFileSync(path.join(SHOTS, "logs", "pass4.json"), JSON.stringify(out, null, 1)); console.log("ok");
