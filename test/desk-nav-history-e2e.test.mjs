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

async function openChat(theme) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: theme });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?demo=&team=vibesquad`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(900);
  const take = () => page.evaluate(() => ({ h: window.__h.splice(0), hlen: history.length, url: location.search }));
  return { context, page, take };
}
const pushes = (s) => s.h.filter((k) => k === "pushState").length;

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

// (1)+(2) A pop settles over 2+ renders (stale render, BoringAde's navGen effect, boringShown catching up): 0 pushes. Then a user
// click right after Back (no timer advance) is a real navigation: exactly 1 push (the old 1s window turned it into replaceState).
test("B1 e2e: pop never pushes; an immediate user navigation after Back pushes exactly once", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  await take();
  await page.goBack(); // -> the Overview entry before the chat
  await page.waitForTimeout(900);
  const back = await take();
  assert.ok(back.h.includes("POP"));
  assert.equal(pushes(back), 0, `pop settling over several renders: 0 pushState (got ${JSON.stringify(back.h)})`);
  await page.goForward(); // -> chat again
  await page.waitForTimeout(900);
  await take();
  await page.goBack();
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click(); // immediately, no waitForTimeout
  await page.waitForTimeout(900);
  const nav = await take();
  assert.equal(pushes(nav), 1, `Back then an immediate user navigation: exactly 1 pushState (got ${JSON.stringify(nav.h)})`);
  await context.close();
});

// (3) Popping to an agent that cannot be represented (unknown id) must not leave the flag armed: the next user navigation pushes.
test("B1 e2e: pop to an unknown agent, then a user navigation, still pushes", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await page.evaluate(() => history.pushState(null, "", "?team=vibesquad&agent=no-such-agent")); // an entry the app cannot show
  await page.evaluate(() => history.pushState(null, "", "?team=vibesquad"));
  await take();
  await page.goBack(); // pop to the unknown agent
  await page.waitForTimeout(900);
  const pop = await take();
  assert.equal(pushes(pop), 0, `unknown-agent pop: 0 pushState (got ${JSON.stringify(pop.h)})`);
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  const nav = await take();
  assert.ok(pushes(nav) >= 1, `flag cleared: the next user navigation pushes (got ${JSON.stringify(nav.h)})`);
  await context.close();
});

// (a)-(d) R24/Gemini: the pop ends when BoringAde reports the settle, not when URLs match. Each case: land on a pop whose settled URL differs
// from the popped one, then a user nav must push exactly once (and `?team=gone` / non-canonical order are not special-cased).
async function mixedChat(page, take) {
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); // pushes a mixed team=efi&agent=demo-aud entry (B2) then ?team=efi
  await page.waitForTimeout(900);
  await take();
}
test("B1 e2e (a,d): Back onto a mixed team=A&agent=<B's agent> entry: 0 pushes while settling; 3 clicks then push 3 entries", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await mixedChat(page, take);
  await page.goBack();
  await page.waitForTimeout(900);
  const back = await take();
  assert.equal(pushes(back), 0, `mixed pop: 0 pushState (got ${JSON.stringify(back.h)})`);
  assert.match(back.url, /agent=demo-aud/);
  const len0 = back.hlen;
  const urls = [];
  const names = (await page.locator(".boring-sidebar .boring-needs-open").allTextContents()).map((x) => x.trim()).filter((x) => x && !/Audit - token scout/.test(x) && /· VibeSquad/.test(x)); // same-project rows: one push each (cross-project picks push a mixed entry first, B2)
  assert.ok(names.length >= 3, `demo has >=3 other Needs-you rows (${JSON.stringify(names)})`);
  await page.evaluate(() => { window.__u = []; const o = history.pushState.bind(history); history.pushState = (...a) => { window.__u.push(String(a[2])); return o(...a); }; });
  let pushed = 0;
  for (let i = 0; i < 3; i++) {
    await page.locator(".boring-sidebar .boring-needs-open", { hasText: names[i].slice(0, 20) }).first().click();
    await page.waitForTimeout(700);
    const s = await take();
    pushed += pushes(s);
    urls.push(s.url);
  }
  const trail = await page.evaluate(() => window.__u.map((u) => u.replace(/^.*\?/, "?")));
  const end = await page.evaluate(() => history.length);
  assert.equal(pushed, 3, `3 clicks after a mixed pop each push (>=1 entry; same-project) - got ${pushed}: ${JSON.stringify(urls)}`);
  assert.equal(end - len0, pushed - 1, "history.length = before + pushes - 1: the one Forward entry (?team=efi) was dropped by the first push");
  for (let i = trail.length - 2; i >= 0; i--) { await page.goBack(); await page.waitForTimeout(500); assert.equal(await page.evaluate(() => location.search), trail[i], `Back walks the pushed trail in order (${i})`); }
  await context.close();
});

test("B1 e2e (b,c): Back to ?team=gone and to a non-canonical ?agent=..&team=.. entry: the next user nav pushes", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const popped of ["?demo=&team=gone", "?demo=&agent=demo-aud&team=vibesquad"]) {
    const { context, page, take } = await openChat("dark");
    await page.evaluate((u) => { history.pushState(null, "", u); history.pushState(null, "", "?demo=&team=vibesquad"); }, popped);
    await take();
    await page.goBack();
    await page.waitForTimeout(900);
    const pop = await take();
    assert.equal(pushes(pop), 0, `${popped}: 0 pushState while popping (got ${JSON.stringify(pop.h)})`);
    await page.locator(".boring-sidebar .boring-needs-open", { hasNotText: "Audit - token scout" }).first().click();
    await page.waitForTimeout(900);
    const nav = await take();
    assert.ok(pushes(nav) >= 1, `${popped}: the next user navigation pushes (got ${JSON.stringify(nav.h)})`);
    await context.close();
  }
});

// (4)/(e) urlSyncDecision: takeStorybookReplace still honored, and the pop ends on the settle run only — never on URL equality.
test("B1: urlSyncDecision ends a pop on the settle run, never on URL equality; takeStorybookReplace honored", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const code = transformSync("urlSync.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8"), { lang: "ts" }).code;
  const { urlSyncDecision } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  let taken = 0;
  const sb = (v) => () => { taken++; return v; };
  const D = (o) => urlSyncDecision({ settledGen: 0, storybookReplace: sb(false), ...o });
  // no pop: normal pushes, storybook replace honored and consumed only on a write
  assert.deepEqual(D({ next: "?a", current: "?b", pop: null, storybookReplace: sb(true) }), { write: true, replace: true, pop: null });
  assert.deepEqual(D({ next: "?a", current: "?b", pop: null }), { write: true, replace: false, pop: null });
  const t0 = taken;
  assert.equal(D({ next: "?a", current: "?a", pop: null, storybookReplace: sb(true) }).write, false);
  assert.equal(taken, t0, "not consumed when nothing is written");
  const arm = { settleGen: 3 };
  // before the settle: never push, never clear — even when next === current (mixed pop render 1, Gemini M2) or next === the popped URL
  for (const [next, current] of [["?x", "?p"], ["?p", "?p"], ["?p", "?stale"]]) {
    const d = D({ next, current, pop: arm, settledGen: 2 });
    assert.equal(d.replace, true); assert.deepEqual(d.pop, arm, `armed before settle (${next} / ${current})`);
    assert.equal(d.write, next !== current);
  }
  // settle run: replace if different, then clear unconditionally (healed URL, unknown team, canonicalised order, unknown agent)
  assert.deepEqual(D({ next: "?healed", current: "?popped", pop: arm, settledGen: 3 }), { write: true, replace: true, pop: null });
  assert.deepEqual(D({ next: "?same", current: "?same", pop: arm, settledGen: 3 }), { write: false, replace: true, pop: null });
  // a pop write drains a stale Storybook one-shot so the next user nav pushes
  const before = taken;
  D({ next: "?x", current: "?p", pop: arm, settledGen: 2 });
  assert.equal(taken, before + 1, "drained during a pop write");
});
