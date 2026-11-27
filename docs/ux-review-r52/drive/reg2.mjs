// R50 pass2 (R48 pass2 + idea-1150 redundant-source cards 10-12, server summary via real choiceLabel, Details banner probe): mock backend (real buildAnswerPrompt/validateAnswerBatch) with bare-letter leans,
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
for (const cfg of [{ name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1 }, { name: "light-1920", theme: "light", width: 1920, height: 1080, dpr: 1 }, { name: "dark-3200", theme: "dark", width: 3200, height: 1800, dpr: 1.2 }, { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2 }]) {
  reset(); const r = (out[cfg.name] = { cards: {} });
  const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, deviceScaleFactor: cfg.dpr, colorScheme: cfg.theme });
  await ctx.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); localStorage.setItem("vs.prefs.v1", JSON.stringify({"app.theme":"${cfg.theme}"})); }catch{}`);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${base}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="boring-decision-card-${id(1)}"]`, { timeout: 20000 }); await page.waitForTimeout(400);
  for (let n = 1; n <= 12; n++) {
    const card = page.locator(`[data-testid="boring-decision-card-${id(n)}"]`);
    r.cards[n] = await card.evaluate((c) => {
      const btns = [...c.querySelectorAll("button")].filter((b) => /alt-|lean-|not-/.test(b.dataset.testid || ""));
      const tags = [...c.querySelectorAll("*")].filter((e) => e.children.length === 0 && /^lean$/i.test(e.textContent.trim())).map((e) => { const cs = getComputedStyle(e); return { tag: e.tagName, cls: e.className, fs: cs.fontSize, fw: cs.fontWeight, color: cs.color, bg: cs.backgroundColor, tt: cs.textTransform, parent: e.parentElement?.dataset?.testid, ariaHidden: e.getAttribute("aria-hidden") }; });
      return { h: Math.round(c.getBoundingClientRect().height), toggle: !!c.querySelector('[data-testid^="boring-decision-source-toggle-"]'), hint: c.querySelector('.boring-decision-lean-hint')?.innerText ?? null, buttons: btns.map((b) => ({ tid: b.dataset.testid.replace(/ny-0+/, ""), text: b.innerText.replace(/\n/g, " ⏎ "), aria: b.getAttribute("aria-label"), title: b.title, bg: getComputedStyle(b).backgroundColor, bc: getComputedStyle(b).borderColor })), tags };
    });
    await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-card${n}.png`) });
  }
  // picks: 1 = click the Lean-tagged option + reply; 2 = pick a; 6 = None of these + reply; 8 = lean chip; 9 = typed; 4 = whatever is first button
  const clickLeanish = async (n) => { const b = page.locator(`[data-testid="boring-decision-card-${id(n)}"] button`).filter({ hasText: /lean/i }).first(); if (await b.count()) { await b.click(); return await b.getAttribute("data-testid"); } return null; };
  r.click1 = await clickLeanish(1);
  await page.locator(`[data-testid="boring-decision-input-${id(1)}"]`).fill("Yes, and keep JSONL export for one release");
  await page.locator(`[data-testid="boring-decision-alt-${id(2)}-0"]`).click();
  await page.locator(`[data-testid="boring-decision-not-${id(6)}"]`).click();
  await page.locator(`[data-testid="boring-decision-input-${id(6)}"]`).fill("Neither: reject partials and log them");
  r.click8 = await clickLeanish(8);
  await page.locator(`[data-testid="boring-decision-input-${id(9)}"]`).fill("45000");
  r.click3 = await clickLeanish(3);
  await page.locator(`[data-testid="boring-decision-card-${id(1)}"]`).screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-card1-picked.png`) });
  await page.locator(`[data-testid="boring-decision-card-${id(6)}"]`).screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-card6-none-picked.png`) });
  r.send = await page.locator('[data-testid="boring-decision-send-btn"]').innerText();
  await page.locator('[data-testid="boring-decision-send-btn"]').click(); await page.waitForTimeout(300);
  r.pending = await page.evaluate(() => document.querySelector('[data-testid="boring-decision-undo-msg"]')?.parentElement?.innerText ?? null);
  await page.locator('[data-testid="boring-decision-send-now-btn"]').click(); await page.waitForTimeout(1500);
  r.delivered = delivered.map((d) => ({ id: d.ans.id.slice(-2), ans: d.ans, prompt: d.prompt.split("\n").filter((l) => /answer|reply|Owner|option|None|Not that/i.test(l)).slice(0, 8) }));
  r.summary = await page.evaluate(() => { const els = [...document.querySelectorAll('[data-testid="boring-decision-banner"],[data-testid="boring-decision-undo-msg"],[data-testid="boring-decision-bar"],[role="status"]')]; return els.map((e) => (e.dataset.testid || e.getAttribute("role")) + ": " + e.innerText.slice(0, 1500)); });
  r.mainTop = (await page.locator('[data-testid="boring-decision-desk"]').innerText().catch(() => "")).slice(0, 1500);
  await page.screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-after-send.png`) });
  const bar = page.locator('[data-testid="boring-decision-bar"]');
  const tg = page.locator('[data-testid="boring-decision-banner-toggle"]');
  r.toggleStyle = await tg.evaluate((b) => { const cs = getComputedStyle(b); const bn = document.querySelector('[data-testid="boring-decision-banner"]'); const bcs = getComputedStyle(bn); return { text: b.innerText, fs: cs.fontSize, fw: cs.fontWeight, color: cs.color, bg: cs.backgroundColor, border: cs.borderColor, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), expanded: b.getAttribute("aria-expanded"), bannerColor: bcs.color, bannerFs: bcs.fontSize, gapPx: Math.round(b.getBoundingClientRect().left - bn.getBoundingClientRect().right) }; });
  await bar.screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-banner-closed.png`) });
  // keyboard: Tab from the banner text region reaches the toggle?
  await page.locator('[data-testid="boring-decision-refresh"], button:has-text("Refresh")').first().focus().catch(() => {});
  const seq = []; for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); const t = await page.evaluate(() => document.activeElement?.dataset?.testid || document.activeElement?.innerText?.slice(0, 20)); seq.push(t); if (t === "boring-decision-banner-toggle") break; }
  r.tabToToggle = { reached: seq.at(-1) === "boring-decision-banner-toggle", steps: seq.length, prev: seq.slice(-4) };
  await tg.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  r.expanded = await page.evaluate(() => { const l = document.querySelector('[data-testid="boring-decision-banner-details"]'); if (!l) return null; const cs = getComputedStyle(l); const t = document.querySelector('[data-testid="boring-decision-banner-toggle"]');
    return { toggleText: t.innerText, ariaExpanded: t.getAttribute("aria-expanded"), h: Math.round(l.getBoundingClientRect().height), scrollH: l.scrollHeight, maxH: cs.maxHeight, w: Math.round(l.getBoundingClientRect().width), barH: Math.round(document.querySelector('[data-testid="boring-decision-bar"]').getBoundingClientRect().height),
      items: [...l.querySelectorAll("li")].map((li) => { const s = li.querySelector(".boring-decision-banner-summary"), a = li.querySelector(".boring-decision-banner-ask"), ln = li.querySelector(".boring-decision-banner-lane"); return { lane: ln.innerText, summary: s.innerText, ask: a.innerText, lines: Math.round(li.getBoundingClientRect().height / 17), sumColor: getComputedStyle(s).color, askColor: getComputedStyle(a).color, laneColor: getComputedStyle(ln).color, fs: getComputedStyle(li).fontSize }; }) }; });
  await bar.screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-banner-open.png`) });
  await page.screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-after-send-open.png`) });
  await page.locator('[data-testid="boring-decision-banner-details"]').evaluate((l) => { l.scrollTop = l.scrollHeight; });
  await bar.screenshot({ path: path.join(SHOTS, `r52reg-${cfg.name}-banner-open-scrolled.png`) });
  await tg.focus(); await page.keyboard.press("Space"); await page.waitForTimeout(150);
  r.spaceCollapses = (await page.locator('[data-testid="boring-decision-banner-details"]').count()) === 0;
  // touching a card clears the banner?
  await page.locator('[data-testid^="boring-decision-input-"]').first().fill("x"); await page.waitForTimeout(150);
  r.bannerAfterEdit = await page.locator('[data-testid="boring-decision-banner"]').count();
  r.errs = errs; await ctx.close();
}
await browser.close(); server.close();
writeFileSync(path.join(SHOTS, "logs", "reg2.json"), JSON.stringify(out, null, 1)); console.log("ok");
