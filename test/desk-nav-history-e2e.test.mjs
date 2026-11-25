// @desk B1 e2e (docs/UX_REVIEW_R22.md M1): App's URL-sync effect must not pushState while a popstate is settling,
// so Forward keeps its entry and Back never traps. Drives the real app (?demo, bundled teams) in a headless browser.
// Skips (like deeplink-playwright) when no Playwright/Chromium is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

before(async () => {
  pw = resolvePlaywright();
  exe = findBrowser();
  const why = browserSkipReason({ pw, exe });
  if (why) { unavailable = why; return; }
  await ensureDist();
  const dist = path.join(REPO_ROOT, "dist");
  // Static harness: /api/* and /__vibesquad/* 404 → the app falls back to the bundled teams.example.json and the ?demo cast.
  server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    let fp = path.join(dist, pathname === "/" ? "index.html" : pathname);
    if (!existsSync(fp) || statSync(fp).isDirectory()) { res.statusCode = 404; res.end("nf"); return; }
    res.setHeader("content-type", MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream");
    createReadStream(fp).on("error", () => { res.statusCode = 404; res.end(); }).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

// Wrap history so the page records every pushState/replaceState/popstate (the review's R22 harness).
const HISTORY_WRAP = `(() => {
  window.__h = [];
  for (const k of ["pushState", "replaceState", "back", "forward", "go"]) {
    const o = history[k].bind(history);
    history[k] = (...a) => { window.__h.push(k); return o(...a); };
  }
  addEventListener("popstate", () => window.__h.push("POP"));
})()`;

async function drive(t, theme) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: theme });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${baseUrl}/?demo=&team=vibesquad`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(900);

  const take = () => page.evaluate(() => ({ h: window.__h.splice(0), hlen: history.length, url: location.search, chat: !!document.querySelector(".boring-timeline, .timeline") }));
  const noPush = (s, label) => assert.equal(s.h.filter((k) => k === "pushState").length, 0, `${label}: no pushState while popping (got ${JSON.stringify(s.h)})`);

  // Open the chat through the realistic path: the "Audit - token scout" Needs-you row (pushes an entry).
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  const chatState = await take();
  assert.match(chatState.url, /agent=demo-aud/, `chat URL names the agent: ${chatState.url}`);
  assert.equal(chatState.chat, true, "chat shown");

  // Cross-project navigation: click "Main Game Project" (pushes 2 entries — the B2 coalesce is a later block).
  await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click();
  await page.waitForTimeout(900);
  const projState = await take();
  assert.equal(projState.chat, false, "project row shows the Overview");

  // Back -> the chat. No pushState may fire while the pop settles; history.length must not grow.
  await page.goBack();
  await page.waitForTimeout(900);
  const back = await take();
  assert.match(back.url, /agent=demo-aud/, `Back lands on the chat URL: ${back.url}`);
  assert.equal(back.chat, true, "Back shows the chat (screen follows the URL)");
  assert.ok(back.h.includes("POP"), "a pop happened");
  noPush(back, "Back");
  assert.equal(back.hlen, projState.hlen, `history.length unchanged across Back (${projState.hlen} -> ${back.hlen})`);

  // Forward -> the project Overview. The entry survived Back; still no pushState.
  await page.goForward();
  await page.waitForTimeout(900);
  const fwd = await take();
  assert.equal(fwd.chat, false, "Forward shows the Overview (entry survived Back)");
  noPush(fwd, "Forward");
  assert.equal(fwd.hlen, projState.hlen, `history.length unchanged across Forward (${projState.hlen} -> ${fwd.hlen})`);

  assert.deepEqual(errs, [], "no page errors");
  await context.close();
}

test("B1 e2e: cross-project Back/Forward never pushState while a pop settles (dark)", async (t) => {
  if (unavailable) return t.skip(unavailable);
  await drive(t, "dark");
});
test("B1 e2e: cross-project Back/Forward never pushState while a pop settles (light)", async (t) => {
  if (unavailable) return t.skip(unavailable);
  await drive(t, "light");
});
