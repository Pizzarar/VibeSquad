// @desk B1 e2e (docs/UX_REVIEW_R22.md M1) + B2 one-entry-per-navigation e2e/unit (end of file): App's URL-sync effect must not pushState while a popstate is settling,
// so Forward keeps its entry and Back never traps. Drives the real app (?demo, bundled teams) in a headless browser.
// Skips (like deeplink-playwright) when no Playwright/Chromium is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";
// Needs-you rows as {title, text}: title = the where-span title= ("Lane · Project", full text; the separator is CSS-drawn since U3), text = row textContent.
const needsRows = (page) => page.locator(".boring-sidebar .boring-needs-open").evaluateAll((els) => els.map((e) => ({ title: (e.querySelector('[data-testid="boring-needs-where"]')?.getAttribute("title") || "").trim(), text: (e.textContent || "").trim() })));
// Same-project (VibeSquad) Needs-you rows' text, optionally excluding some, in DOM order.
const sameProjectRows = async (page, excl = null) => (await needsRows(page)).filter((r) => r.text && /· VibeSquad$/.test(r.title) && !(excl && excl.test(r.text))).map((r) => r.text);
// The Needs-you row with this exact textContent (rows are unique by reason text).
const needsRowByText = async (page, text) => { const i = (await needsRows(page)).findIndex((r) => r.text === text); return page.locator(".boring-sidebar .boring-needs-open").nth(i); };

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

async function openChat(theme, setup) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: theme });
  if (setup) await setup(context); // routes must exist before the first request (e.g. the Storybook HEAD probe)
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?demo=&team=vibesquad`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(900);
  const take = () => page.evaluate(() => ({ h: window.__h.splice(0), hlen: history.length, url: location.search, chat: !!document.querySelector(".boring-timeline, .timeline") }));
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

  // Cross-project navigation: click "Main Game Project" (one entry since B2).
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
  // B2 stopped the app writing mixed entries; seed the pre-B2 one (a legacy entry still in a tab's history), then ?team=efi on top of it.
  await page.evaluate(() => history.pushState(null, "", "?demo=&team=efi&agent=demo-aud"));
  await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click();
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
  const names = (await sameProjectRows(page, /Audit - token scout/)); // same-project rows: one push each
  assert.ok(names.length >= 3, `demo has >=3 other Needs-you rows (${JSON.stringify(names)})`);
  await page.evaluate(() => { window.__u = []; const o = history.pushState.bind(history); history.pushState = (...a) => { window.__u.push(String(a[2])); return o(...a); }; });
  let pushed = 0;
  for (let i = 0; i < 3; i++) {
    await (await needsRowByText(page, names[i])).click();
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

// (a) M1: the pop must not stick when BoringApp is not mounted (Storybook takeover etc.): the first user input ends it, so the next nav pushes.
test("B1 e2e (a): a pop followed by a non-Boring route and then a user nav pushes", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await page.evaluate(() => { history.pushState(null, "", "?demo=&team=vibesquad&sb=1"); history.pushState(null, "", "?demo=&team=vibesquad"); });
  await take();
  await page.goBack(); // pop into a ?sb= entry
  await page.waitForTimeout(900);
  await take();
  await page.keyboard.press("Escape"); // first user input ends the pop
  await page.locator(".boring-sidebar .boring-needs-open", { hasNotText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  const nav = await take();
  assert.ok(pushes(nav) >= 1, `a user nav after the pop pushes (got ${JSON.stringify(nav.h)})`);
  await context.close();
});

// (b) L1: a double Back retargets: the screen lands on the 2nd target (rows[0]'s URL), and a click on a DIFFERENT agent pushes.
test("B1 e2e (b): double Back lands on the 2nd target; a click on a different agent pushes", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  const rows = (await sameProjectRows(page));
  assert.ok(rows.length >= 3, `>=3 same-project rows (${JSON.stringify(rows)})`);
  const urls = [];
  for (const r of rows.slice(0, 3)) { await (await needsRowByText(page, r)).click(); await page.waitForTimeout(500); urls.push(await page.evaluate(() => location.search)); }
  await take();
  await page.evaluate(() => { history.back(); history.back(); }); // two pops in one tick: rows[2] -> rows[1] -> rows[0]
  await page.waitForTimeout(1200);
  const two = await take();
  assert.equal(pushes(two), 0, `double Back: 0 pushState (got ${JSON.stringify(two.h)})`);
  assert.equal(two.url, urls[0], "the double Back lands on the 2nd target (rows[0]'s URL)");
  await (await needsRowByText(page, rows[2])).click();
  await page.waitForTimeout(900);
  const nav = await take();
  assert.ok(pushes(nav) >= 1, `a click on a different agent pushes (got ${JSON.stringify(nav.h)})`);
  assert.equal(nav.url, urls[2]);
  await context.close();
});

// R28 M1: go(-2) over a mixed entry, Forward x2, Back x3: every pop lands on the right screen, history.length never changes, 0 pushes.
test("B1 e2e: go(-2) over a mixed entry, Forward x2, Back x3 never pushes and never traps", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  await page.evaluate(() => history.pushState(null, "", "?demo=&team=efi&agent=demo-aud")); // seed the pre-B2 mixed entry (the app no longer writes one)
  await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); // then ?team=efi
  await page.waitForTimeout(900);
  await take();
  const len0 = await page.evaluate(() => history.length);
  const chatUrl = /team=vibesquad&agent=demo-aud/;
  const stepTo = async (label, fn, re) => {
    await page.evaluate(fn);
    await page.waitForTimeout(900);
    const s = await take();
    assert.equal(pushes(s), 0, `${label}: 0 pushState (got ${JSON.stringify(s.h)})`);
    assert.equal(s.hlen, len0, `${label}: history.length unchanged`);
    assert.match(s.url, re, `${label}: lands on ${re} (got ${s.url})`);
    return s;
  };
  const s1 = await stepTo("go(-2)", () => history.go(-2), chatUrl);
  assert.equal(s1.chat, true);
  const f1 = await stepTo("Forward 1 (mixed entry, healed in place)", () => history.forward(), chatUrl);
  assert.equal(f1.chat, true);
  const f2 = await stepTo("Forward 2", () => history.forward(), /team=efi(&|$)(?!.*agent)/);
  assert.equal(f2.chat, false, "Forward 2 reaches the Main Game Overview (the Forward entry survived)");
  const b1 = await stepTo("Back 1", () => history.back(), chatUrl);
  assert.equal(b1.chat, true);
  await stepTo("Back 2", () => history.back(), chatUrl);
  const b3 = await stepTo("Back 3", () => history.back(), /team=vibesquad(&|$)(?!.*agent)/);
  assert.equal(b3.chat, false, "Back 3 walks out to the VibeSquad Overview (no trap)");
  await context.close();
});

// urlSyncDecision: takeStorybookReplace honored; while a pop is active every write is replace-if-differs (the pop ends only on the
// first capture-phase pointerdown/keydown or a newer pop, never on reaching the popped URL).
test("B1: urlSyncDecision never pushes while a pop is active; takeStorybookReplace honored", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const code = transformSync("urlSync.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8"), { lang: "ts" }).code;
  const { urlSyncDecision } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  let taken = 0;
  const sb = (v) => () => { taken++; return v; };
  const D = (o) => urlSyncDecision({ popActive: false, storybookReplace: sb(false), ...o });
  assert.deepEqual(D({ next: "?a", current: "?b", storybookReplace: sb(true) }), { write: true, replace: true });
  assert.deepEqual(D({ next: "?a", current: "?b" }), { write: true, replace: false });
  const t0 = taken;
  assert.equal(D({ next: "?a", current: "?a", storybookReplace: sb(true) }).write, false);
  assert.equal(taken, t0, "not consumed when nothing is written");
  // During a pop every write is a replace, whatever next/current are — including next === the popped URL (a stale render that
  // hasn't healed yet must not end the pop: R28 M1).
  for (const [next, current] of [["?p", "?p"], ["?p", "?transient"], ["?healed", "?p"], ["?x", "?y"]]) {
    const d = D({ next, current, popActive: true });
    assert.equal(d.write, next !== current, `${next}/${current}`);
    assert.equal(d.replace, true, `pop write is never a push (${next}/${current})`);
  }
  assert.deepEqual(Object.keys(D({ next: "?a", current: "?b", popActive: true })).sort(), ["replace", "write"], "no endPop in the contract");
  const before = taken;
  D({ next: "?x", current: "?p", popActive: true });
  assert.equal(taken, before + 1, "drained during a pop write");
});

// ── B2: one history entry per navigation (docs/PLAN_DESK_NAV_HISTORY.md B2; R21 BASE sequences, artifacts/desk-b2/) ──────────────
// From a chat in project A (VibeSquad · Audit - token scout), open project B (Main Game Project) by each route. Each must grow
// history.length by exactly 1, write no interim URL (no mixed team=<x>&agent=<y> entry), and one Back must return to the chat.
const B2_ROUTES = {
  "a Ctrl+K agent pick": async (page) => { await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI Lab"); await page.waitForTimeout(400); await page.keyboard.press("Enter"); },
  "b Needs-you row": (page) => page.locator(".boring-sidebar .boring-needs-open", { hasText: "Main Game Project" }).first().click(),
  "c sidebar agent row": async (page) => {
    await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).locator("xpath=..").locator(".boring-chevron-btn").first().click();
    await page.waitForTimeout(400);
    await page.locator(".boring-sidebar .boring-conv-title", { hasText: "UI Lab" }).locator("xpath=..").locator(".boring-chevron-btn").first().click();
    await page.waitForTimeout(400);
    await page.locator(".boring-sidebar .boring-worker-row", { hasText: /^Lead/ }).first().click();
  },
  "d project row": (page) => page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(),
  "e notification click": (page) => page.evaluate(() => window.postMessage({ type: "vs:select-agent", agentId: "demo-lead-ui" }, "*")),
  // Round 2 (Review-Gemini M1): the notification lands the agent a commit before its team; a pinsHome flip (from the Overview) or a
  // pinLayout flip (focus=needs-you) in that commit used to push ?team=<old>&agent=<new> first.
  "f notification click from the Overview": (page) => page.evaluate(() => window.postMessage({ type: "vs:select-agent", agentId: "demo-lead-ui" }, "*")),
  "g notification click with focus=needs-you": (page) => page.evaluate(() => window.postMessage({ type: "vs:select-agent", agentId: "demo-lead-ui", url: "/?focus=needs-you" }, "*")),
};
const B2_FROM_OVERVIEW = new Set(["f notification click from the Overview"]);
const B2_FINAL = { "a Ctrl+K agent pick": "?demo=&team=efi&agent=demo-lead-ui", "b Needs-you row": "?demo=&team=efi&agent=demo-lead-efi", "c sidebar agent row": "?demo=&team=efi&agent=demo-lead-ui", "d project row": "?demo=&team=efi", "e notification click": "?demo=&team=efi&agent=demo-lead-ui", "f notification click from the Overview": "?demo=&team=efi&agent=demo-lead-ui", "g notification click with focus=needs-you": "?demo=&team=efi&agent=demo-lead-ui" };
for (const [route, act] of Object.entries(B2_ROUTES)) {
  const fromOv = B2_FROM_OVERVIEW.has(route);
  test(`B2 e2e (${route}): cross-project nav from ${fromOv ? "the Overview" : "a chat"} = exactly 1 entry, no mixed entry, one Back returns`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    const { context, page, take } = await openChat("dark");
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.evaluate(() => { window.__w = []; for (const k of ["pushState", "replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__w.push([k, String(a[2]).replace(/^.*\?/, "?")]); return o(...a); }; } });
    if (!fromOv) {
      await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
      await page.waitForTimeout(900);
    }
    const s0 = await take();
    assert.equal(s0.url, fromOv ? "?demo=&team=vibesquad" : "?demo=&team=vibesquad&agent=demo-aud");
    assert.equal(s0.chat, !fromOv);
    await page.evaluate(() => { window.__w = []; });
    await act(page);
    await page.waitForTimeout(900);
    const s1 = await take();
    const writes = await page.evaluate(() => window.__w.splice(0));
    assert.equal(s1.url, B2_FINAL[route], `lands on project B (${s1.url})`);
    assert.equal(s1.hlen - s0.hlen, 1, `history.length grows by exactly 1 (${s0.hlen} -> ${s1.hlen}; writes ${JSON.stringify(writes)})`);
    assert.deepEqual(writes.map(([, u]) => u).filter((u) => u !== s1.url), [], `no interim/mixed URL written (${JSON.stringify(writes)})`);
    assert.equal(pushes(s1), 1, `one pushState (${JSON.stringify(writes)})`);
    await page.goBack();
    await page.waitForTimeout(900);
    const s2 = await take();
    assert.equal(s2.url, s0.url, "one Back returns to the start URL");
    assert.equal(s2.chat, s0.chat, "one Back shows the start screen again (not a dead Back)");
    assert.equal(pushes(s2), 0, `Back never pushes (${JSON.stringify(s2.h)})`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  });
}

// B2 unit: App's URL sync names the agent BoringApp published THIS commit (read live at effect time), so team + agent are one push.
test("B2: urlSyncAgent reads the live shown agent in Normal only while it belongs to the team being written; one entry, no mixed entry", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const pal = readFileSync(path.join(REPO_ROOT, "src", "CommandPalette.tsx"), "utf8");
  const ser = pal.slice(pal.indexOf("export function serializeUrlState"), pal.indexOf("\n}\n", pal.indexOf("export function serializeUrlState")) + 3);
  assert.match(ser, /^export function serializeUrlState[\s\S]*\n\}\n$/, "extracted the real serializeUrlState");
  const code = transformSync("urlSync.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8") + "\n" + ser, { lang: "ts" }).code;
  const { urlSyncAgent, urlSyncDecision, serializeUrlState } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

  // Helper contract.
  const owners = { "demo-aud": "vibesquad", "demo-lead-ui": "efi", new: "efi", old: "vibesquad" };
  const teamOf = (id) => owners[id] ?? null;
  const A = (o) => urlSyncAgent({ boring: true, activeAgentId: "tab", rendered: "old", team: "efi", teamOf, ...o });
  // Helper contract.
  assert.equal(A({ liveShown: "new" }), "new", "Normal: the live published agent (owned by the team being written), not the stale render value");
  assert.equal(A({ liveShown: "unpinned" }), "unpinned", "Normal: a live agent with no known owner is trusted (no team switch can follow)");
  assert.equal(A({ liveShown: null }), null, "Normal Overview/usage: no ?agent=");
  assert.equal(A({ liveShown: undefined }), "tab", "BoringApp not mounted: the active tab stands in");
  assert.equal(A({ liveShown: "new", team: "vibesquad" }), "old", "Gemini M1: live agent owned by ANOTHER project (its team lands next commit): the render-time value stands in");
  assert.equal(A({ boring: false, liveShown: "new", rendered: "psycho" }), "psycho", "Psycho/phone: App's render-time value, untouched");

  // Simulate App's URL sync over the commits of a nav; each commit = { team, rendered (App's render-time agent), live (store at effect time) }.
  const run = (start, commits, agentOf) => {
    let search = start;
    const entries = [search];
    for (const c of commits) {
      const next = serializeUrlState({ team: c.team, agent: agentOf(c) }, search);
      const d = urlSyncDecision({ next, current: search, popActive: false, storybookReplace: () => false });
      if (!d.write) continue;
      if (d.replace) entries[entries.length - 1] = next; else entries.push(next);
      search = next;
    }
    return entries;
  };
  const live = (c) => urlSyncAgent({ boring: true, liveShown: c.live, activeAgentId: c.live, rendered: c.rendered, team: c.team, teamOf });
  const stale = (c) => c.rendered; // pre-B2: App's render-time useBoringShownAgent()
  const r1 = (c) => urlSyncAgent({ boring: true, liveShown: c.live, activeAgentId: c.live, rendered: c.rendered, team: c.team, teamOf: () => null }); // 86775348: live, unconditionally
  // (a)-(d): from a chat in A, team + selection in one batch. Commit 1: team=efi, BoringApp published the new agent, render value still demo-aud.
  const chat = "?demo=&team=vibesquad&agent=demo-aud";
  for (const final of ["demo-lead-ui", null]) {
    const commits = [{ team: "efi", rendered: "demo-aud", live: final }, { team: "efi", rendered: final, live: final }];
    const want = final ? `?demo=&team=efi&agent=${final}` : "?demo=&team=efi";
    assert.deepEqual(run(chat, commits, live), [chat, want], `B2 (${final}): exactly one new entry, the final URL`);
    assert.deepEqual(run(chat, commits, stale), [chat, "?demo=&team=efi&agent=demo-aud", want], `pre-B2 (${final}): the mixed interim entry the fix removes`);
  }
  // (f)/(g) notification: Commit 1 = agent published, team still vibesquad (and a pinsHome/pinLayout flip fires the sync); Commit 2 = team
  // switched by BoringApp's landing effect; Commit 3 = the store re-render.
  for (const [start, prev] of [["?demo=&team=vibesquad", null], [chat, "demo-aud"]]) {
    const commits = [{ team: "vibesquad", rendered: prev, live: "demo-lead-ui" }, { team: "efi", rendered: "demo-lead-ui", live: "demo-lead-ui" }, { team: "efi", rendered: "demo-lead-ui", live: "demo-lead-ui" }];
    const want = "?demo=&team=efi&agent=demo-lead-ui";
    assert.deepEqual(run(start, commits, live), [start, want], `round 2 (from ${start}): one entry, no ?team=<old>&agent=<new>`);
    assert.deepEqual(run(start, commits, r1), [start, "?demo=&team=vibesquad&agent=demo-lead-ui", want], `86775348 (from ${start}): the mixed entry Gemini M1 found`);
  }
});

// ── U1 (docs/PLAN_DESK_URL_COMPLETE.md; idea-997 + idea-895): every Normal screen has one URL ─────────────────────────────────────
// An empty Desk slot card (?slot=overlord) and the Overview sub-tab (?tab=inbox|standup) live in the URL: opening one pushes exactly
// once, and Back, Forward and reload all show the screen the URL names.
const screenOf = (page) => page.evaluate(() => {
  const card = document.querySelector('[data-testid="boring-empty-card"]');
  const ov = document.querySelector('[data-testid="boring-project-view"]');
  const tab = ov ? ["overview", "inbox", "feed"].find((t) => document.querySelector(`[data-testid="boring-tab-${t}"]`)?.classList.contains("on")) ?? null : null;
  return { url: location.search, card: card ? (card.querySelector('[data-testid="boring-empty-cta"]')?.textContent ?? "").trim() : null, tab, chat: !!document.querySelector(".boring-timeline, .timeline") };
});
async function u1Step(page, take, label, fn, want) {
  const before = await take();
  await fn();
  await page.waitForTimeout(900);
  const s = await take();
  const sc = await screenOf(page);
  assert.deepEqual({ url: sc.url, card: sc.card, tab: sc.tab, chat: sc.chat }, want, `${label}: screen`);
  return { before, s, sc };
}
async function u1Reload(page, label, want) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const sc = await screenOf(page);
  const h = await page.evaluate(() => window.__h.splice(0));
  assert.deepEqual({ url: sc.url, card: sc.card, tab: sc.tab, chat: sc.chat }, want, `${label}: reload shows the same screen`);
  assert.equal(h.filter((k) => k === "pushState").length, 0, `${label}: reload writes no entry (${JSON.stringify(h)})`);
}
// Navigate (one push, +1 history.length), then Back, Forward and reload must each show the screen of their URL.
async function u1Drive(page, take, { label, from, act, to }) {
  const nav = await u1Step(page, take, `${label} nav`, act, to);
  assert.equal(pushes(nav.s), 1, `${label}: exactly one pushState (${JSON.stringify(nav.s.h)})`);
  assert.equal(nav.s.hlen - nav.before.hlen, 1, `${label}: history.length +1`);
  const back = await u1Step(page, take, `${label} Back`, () => page.goBack(), from);
  assert.equal(pushes(back.s), 0, `${label} Back: no pushState (${JSON.stringify(back.s.h)})`);
  assert.equal(back.s.hlen, nav.s.hlen, `${label} Back: history.length unchanged`);
  const fwd = await u1Step(page, take, `${label} Forward`, () => page.goForward(), to);
  assert.equal(pushes(fwd.s), 0, `${label} Forward: no pushState (${JSON.stringify(fwd.s.h)})`);
  assert.equal(fwd.s.hlen, nav.s.hlen, `${label} Forward: history.length unchanged`);
  await u1Reload(page, label, to);
}
const OV = (team, tab = "overview") => ({ url: `?demo=&team=${team}${tab === "inbox" ? "&tab=inbox" : tab === "feed" ? "&tab=standup" : ""}`, card: null, tab, chat: false });
const overlordTile = async (page, team) => {
  const sel = `.boring-sidebar [data-testid="boring-core-overlord-${team}"], .boring-sidebar [data-testid="boring-core-overlord"]`;
  return page.locator(sel).first().click();
};

test("U1 e2e (idea-997): the empty Start Overlord card has its own URL (?slot=overlord): one push; Back, Forward, reload restore it", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const theme of ["dark", "light"]) {
    const { context, page, take } = await openChat(theme);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    // Open a chat first so the persisted pane has an active agent: reload must still land on the card, not that chat.
    await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
    await page.waitForTimeout(900);
    await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click();
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("efi"), "start: the Main Game Project Overview");
    await take();
    await u1Drive(page, take, {
      label: `Start Overlord card (${theme})`,
      from: OV("efi"),
      act: () => overlordTile(page, "efi"),
      to: { url: "?demo=&team=efi&slot=overlord", card: "Start Overlord", tab: null, chat: false },
    });
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});

test("U1 e2e (idea-997): opening another project's empty Overlord card from a chat is one entry (team + slot land together)", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await page.evaluate(() => { window.__w = []; for (const k of ["pushState", "replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__w.push([k, String(a[2]).replace(/^.*\?/, "?")]); return o(...a); }; } });
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  const chat = await screenOf(page);
  assert.equal(chat.url, "?demo=&team=vibesquad&agent=demo-aud");
  await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).locator("xpath=..").locator(".boring-chevron-btn").first().click().catch(() => {});
  await page.waitForTimeout(400);
  await take();
  await page.evaluate(() => { window.__w = []; });
  const nav = await u1Step(page, take, "cross-project slot", () => overlordTile(page, "efi"), { url: "?demo=&team=efi&slot=overlord", card: "Start Overlord", tab: null, chat: false });
  const writes = await page.evaluate(() => window.__w.splice(0));
  assert.equal(pushes(nav.s), 1, `one pushState (${JSON.stringify(writes)})`);
  assert.equal(nav.s.hlen - nav.before.hlen, 1, "history.length +1");
  assert.deepEqual(writes.map(([, u]) => u).filter((u) => u !== nav.sc.url), [], `no interim URL (${JSON.stringify(writes)})`);
  const back = await u1Step(page, take, "Back", () => page.goBack(), { url: chat.url, card: null, tab: null, chat: true });
  assert.equal(pushes(back.s), 0);
  await context.close();
});

for (const [tab, label] of [["inbox", "Idea Inbox"], ["feed", "Standup"]]) {
  test(`U1 e2e (idea-895): the ${label} tab has its own URL: one push; Back, Forward, reload restore it`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    for (const theme of ["dark", "light"]) {
      const { context, page, take } = await openChat(theme);
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      assert.deepEqual(await screenOf(page), OV("vibesquad"), "start: the VibeSquad Overview");
      await take();
      await u1Drive(page, take, { label: `${label} tab (${theme})`, from: OV("vibesquad"), act: () => page.locator(`[data-testid="boring-tab-${tab}"]`).click(), to: OV("vibesquad", tab) });
      assert.deepEqual(errs, [], "no page errors");
      await context.close();
    }
  });
}

test("U1 e2e (idea-895): the sub-tab resets on project change; Back restores the old project's tab, Forward and reload the new Overview", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const tab of ["inbox", "feed"]) {
    const { context, page, take } = await openChat("dark");
    await page.locator(`[data-testid="boring-tab-${tab}"]`).click();
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("vibesquad", tab));
    await take();
    await u1Drive(page, take, { label: `project switch from ${tab}`, from: OV("vibesquad", tab), act: () => page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(), to: OV("efi") });
    // Without a reload in between: tab -> other project -> back by the first project's row shows its Overview tab (the reset sticks).
    const row = (name) => page.locator(".boring-sidebar .boring-project-row", { hasText: name }).first().click();
    await row("VibeSquad");
    await page.waitForTimeout(900);
    await page.locator(`[data-testid="boring-tab-${tab}"]`).click();
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("vibesquad", tab));
    await row("Main Game Project");
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("efi"));
    await row("VibeSquad");
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("vibesquad"), "returning to the first project by its row shows its Overview tab");
    // ...while Back still walks the real entries: efi Overview, then VibeSquad on the tab (a cross-project pop lands on the URL's tab).
    await page.goBack();
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("efi"));
    await page.goBack();
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("vibesquad", tab), "cross-project Back restores the tab its entry names");
    await context.close();
  }
});

test("U1 e2e: unknown ?slot= / ?tab= values fall back to the Overview and are dropped from the URL", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  for (const q of ["slot=nope", "tab=bogus", "slot=nope&tab=bogus", "tab=overview"]) {
    await page.goto(`${baseUrl}/?demo=&team=vibesquad&${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(900);
    const sc = await screenOf(page);
    assert.deepEqual({ card: sc.card, tab: sc.tab, chat: sc.chat }, { card: null, tab: "overview", chat: false }, `${q}: the Overview`);
    assert.equal(sc.url, "?demo=&team=vibesquad", `${q}: the canonical Overview URL`);
  }
  assert.deepEqual(errs, [], "no page errors");
  await context.close();
});

// U1 unit: the real serializeUrlState / parseUrlState (extracted from CommandPalette.tsx) + urlSyncScreen.
test("U1: serializeUrlState/parseUrlState round-trip slot and tab with agent, view, sb and demo; one screen = one canonical URL", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const pal = readFileSync(path.join(REPO_ROOT, "src", "CommandPalette.tsx"), "utf8");
  const fn = (name) => { const i = pal.indexOf(`export function ${name}`); const s = pal.slice(i, pal.indexOf("\n}\n", i) + 3); assert.match(s, new RegExp(`^export function ${name}[\\s\\S]*\\n\\}\\n$`)); return s; };
  const code = transformSync("u1.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8") + "\n" + fn("parseUrlState") + fn("serializeUrlState"), { lang: "ts" }).code;
  const { parseUrlState: parse, serializeUrlState: ser, urlSyncScreen } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

  // Round trips: serialize(parse(x)) is stable and keeps unrelated params (demo, sb, dock) in place.
  const cases = [
    [{ team: "efi", agent: null, slot: "overlord", tab: null }, "?demo=", "?demo=&team=efi&slot=overlord"],
    [{ team: "efi", agent: null, slot: "riffbot", tab: null }, "", "?team=efi&slot=riffbot"],
    [{ team: "efi", agent: null, slot: "bugs", tab: null }, "", "?team=efi&slot=bugs"],
    [{ team: "vibesquad", agent: null, slot: null, tab: "inbox" }, "?demo=", "?demo=&team=vibesquad&tab=inbox"],
    [{ team: "vibesquad", agent: null, slot: null, tab: "standup" }, "?demo=&sb=vibesquad", "?demo=&sb=vibesquad&team=vibesquad&tab=standup"],
    [{ team: "vibesquad", agent: "a1", slot: null, tab: null }, "?dock=1", "?dock=1&team=vibesquad&agent=a1"],
    [{ team: "vibesquad", agent: null, slot: null, tab: null }, "", "?team=vibesquad"],
  ];
  for (const [st, base, want] of cases) {
    const url = ser(st, base);
    assert.equal(url, want, JSON.stringify(st));
    assert.deepEqual(parse(url), st, `parse(${url})`);
    assert.equal(ser(parse(url), url), url, `stable: ${url}`);
  }
  // Precedence: an agent wins over a slot, a slot over a tab (in both directions), so a screen has exactly one URL.
  assert.equal(ser({ team: "t", agent: "a", slot: "overlord", tab: "inbox" }), "?team=t&agent=a");
  assert.equal(ser({ team: "t", agent: null, slot: "overlord", tab: "inbox" }), "?team=t&slot=overlord");
  assert.deepEqual(parse("?team=t&agent=a&slot=overlord&tab=inbox"), { team: "t", agent: "a", slot: null, tab: null });
  assert.deepEqual(parse("?team=t&slot=overlord&tab=inbox"), { team: "t", agent: null, slot: "overlord", tab: null });
  // view=squads (Squads Home) coexists; stale slot/tab are replaced, not duplicated.
  assert.equal(ser({ team: "t", agent: null, tab: "inbox", squadsHome: true }, "?view=squads&tab=standup&slot=bugs"), "?view=squads&team=t&tab=inbox");
  assert.equal(ser({ team: "t", agent: null }, "?team=t&slot=overlord&tab=inbox"), "?team=t", "callers that pass no keys (Psycho) strip them");
  // Unknown values fall back safely (null = the Overview); the internal "feed" key is never a URL value.
  for (const q of ["?team=t&slot=nope", "?team=t&tab=bogus", "?team=t&tab=feed", "?team=t&tab=overview", "?team=t&slot=&tab="]) assert.deepEqual(parse(q), { team: "t", agent: null, slot: null, tab: null }, q);

  // urlSyncScreen: trusted only for the team being written; BoringApp unmounted keeps the URL's own keys; Psycho writes none.
  const K = (team, slot = null, tab = null) => ({ team, slot, tab });
  const S = (o) => urlSyncScreen({ boring: true, live: undefined, rendered: undefined, team: "efi", kept: {}, ...o });
  assert.deepEqual(S({ live: K("efi", "overlord") }), { slot: "overlord", tab: null }, "live keys of the team being written");
  assert.deepEqual(S({ live: K("vibesquad", null, "inbox"), rendered: K("efi", null, "standup") }), { slot: null, tab: "standup" }, "live belongs to another project: the render value stands in");
  assert.deepEqual(S({ live: K("vibesquad", null, "inbox"), rendered: K("vibesquad", null, "inbox") }), { slot: null, tab: null }, "neither belongs: the default Overview (no stray ?team=<new>&tab=<old>)");
  assert.deepEqual(S({ live: undefined, kept: { slot: null, tab: "inbox" } }), { slot: null, tab: "inbox" }, "BoringApp not mounted (Storybook): keep the URL's keys");
  assert.deepEqual(S({ boring: false, live: K("efi", "overlord"), kept: { tab: "inbox" } }), { slot: null, tab: null }, "Psycho / phone: none");
});

// U1 + Storybook (?sb=) coexistence: the takeover unmounts BoringApp; the entry keeps its ?tab= / ?slot=, and leaving Storybook
// (Esc on a cold ?sb= link strips ?sb= in place) lands on the screen the URL names.
test("U1 e2e: ?sb= coexists with ?tab= / ?slot=: Storybook keeps the keys, closing it lands on that tab / card", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const [q, want] of [["team=vibesquad&tab=inbox", OV("vibesquad", "inbox")], ["team=efi&slot=overlord", { url: "?demo=&team=efi&slot=overlord", card: "Start Overlord", tab: null, chat: false }]]) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    await context.addInitScript(HISTORY_WRAP);
    await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${baseUrl}/?demo=&${q}&sb=vibesquad`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".boring-sidebar").count(), 0, `${q}: Storybook takeover (BoringApp unmounted)`);
    const sorted = (u) => [...new URLSearchParams(u)].map((kv) => kv.join("=")).sort().join("&");
    assert.equal(sorted(await page.evaluate(() => location.search)), sorted(`?demo=&${q}&sb=vibesquad`), `${q}: the Storybook entry keeps its screen keys`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(900);
    const sc = await screenOf(page);
    assert.deepEqual({ url: sc.url, card: sc.card, tab: sc.tab, chat: sc.chat }, want, `${q}: closing Storybook lands on the URL's screen`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});

// ── U1 r2 (docs/UX_REVIEW_R33_desk-u1.md M1 + Review-Gemini Major 1/2 + UX m1) ──────────────────────────────────────────────────────
// Storybook's HEAD probe answers 200 so its topbar button shows; GET stays 404 (the takeover shows its empty state).
const withStorybook = (context) => context.route("**/api/storybook/**", (r) => (r.request().method() === "HEAD" ? r.fulfill({ status: 200, body: "" }) : r.fulfill({ status: 404, body: "nf" })));
const crumbOf = (page) => page.evaluate(() => [...document.querySelectorAll(".boring-crumb-seg")].map((e) => (e.querySelector(".boring-crumb-cur, .boring-crumb-btn")?.textContent ?? "").trim()));
const sortedQ = (u) => [...new URLSearchParams(u)].map((kv) => kv.join("=")).sort().join("&");

// M1: the BoringApp unmount (screen keys cleared) must never write history; a key-order-only difference is the same URL.
test("U1 r2 e2e (R33 M1): opening Storybook is +1 entry; Esc goes back to the screen before it; Back then leaves Storybook behind", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const tab of ["overview", "inbox"]) {
    const { context, page, take } = await openChat("dark", withStorybook);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    // A screen to go Back to first (Standup), then the screen Storybook opens over (Overview or Idea Inbox): each is one push.
    await page.locator('[data-testid="boring-tab-feed"]').click();
    await page.waitForTimeout(700);
    await page.locator(`[data-testid="boring-tab-${tab}"]`).click();
    await page.waitForTimeout(900);
    const pre = await screenOf(page);
    assert.deepEqual(pre, OV("vibesquad", tab), `${tab}: start`);
    const s0 = await take();
    await page.getByRole("button", { name: "Storybook" }).first().click();
    await page.waitForTimeout(1200);
    const s1 = await take();
    assert.equal(await page.locator(".boring-sidebar").count(), 0, `${tab}: Storybook takeover shown`);
    assert.equal(pushes(s1), 1, `${tab}: opening Storybook is one pushState (${JSON.stringify(s1.h)})`);
    assert.equal(s1.hlen - s0.hlen, 1, `${tab}: opening Storybook is history.length +1`);
    assert.equal(sortedQ(s1.url), sortedQ(`${pre.url}&sb=vibesquad`), `${tab}: the Storybook URL`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(900);
    const s2 = await take();
    assert.ok(s2.h.includes("back"), `${tab}: Esc is history.back() (${JSON.stringify(s2.h)})`);
    assert.equal(pushes(s2), 0, `${tab}: Esc writes no entry (${JSON.stringify(s2.h)})`);
    assert.equal(s2.hlen, s1.hlen, `${tab}: Esc keeps history.length`);
    assert.deepEqual(await screenOf(page), pre, `${tab}: Esc lands on the screen before Storybook`);
    await page.goBack();
    await page.waitForTimeout(900);
    const s3 = await take();
    assert.equal(pushes(s3), 0, `${tab}: Back writes no entry (${JSON.stringify(s3.h)})`);
    assert.equal(await page.locator(".boring-sidebar").count(), 1, `${tab}: Back does not reopen Storybook`);
    assert.deepEqual(await screenOf(page), OV("vibesquad", "feed"), `${tab}: Back lands on the entry before (Standup)`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});

// Gemini Major 1: ?slot= / ?tab= of the URL BoringApp mounts on belong to that URL's team only.
test("U1 r2 e2e (Gemini Major 1): a fallback view on cold load never adopts the unknown team's ?tab= / ?slot=", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
  const page = await context.newPage();
  for (const q of ["team=gone&tab=inbox", "team=gone&tab=standup", "team=gone&slot=overlord"]) {
    await page.goto(`${baseUrl}/?demo=&${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(900);
    const sc = await screenOf(page);
    assert.deepEqual({ card: sc.card, tab: sc.tab, chat: sc.chat }, { card: null, tab: "overview", chat: false }, `${q}: the fallback project's Overview tab`);
    assert.doesNotMatch(sc.url, /[?&](tab|slot)=/, `${q}: no stale key in the URL (${sc.url})`);
  }
  await context.close();
});

test("U1 r2 e2e (Gemini Major 1): Storybook over a tab, then a Ctrl+K project switch lands on the new project's Overview tab", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const tab of ["inbox", "feed"]) {
    const { context, page, take } = await openChat("dark", withStorybook);
    await page.locator(`[data-testid="boring-tab-${tab}"]`).click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Storybook" }).first().click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator(".boring-sidebar").count(), 0, "Storybook takeover shown");
    await take();
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(400);
    await page.keyboard.type("Main Game squad team"); // the team item (hint "squad team"), not "Open Storybook: Main Game Project"
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(900);
    assert.deepEqual(await screenOf(page), OV("efi"), `${tab}: Ctrl+K to Main Game Project shows its Overview tab (no stale tab)`);
    await context.close();
  }
});

// Gemini Major 2: on a real server the URL's team can resolve after BoringApp mounted (registry / roster arrive late); its ?tab= must
// survive that. /api/teams answers late with an extra project, so the first render shows a fallback view.
test("U1 r2 e2e (Gemini Major 2): cold load of ?team=<late>&tab=inbox keeps the tab when the team's view resolves after mount", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { readFileSync } = await import("node:fs");
  const reg = JSON.parse(readFileSync(path.join(REPO_ROOT, "teams.example.json"), "utf8"));
  const late = { ...reg, teams: [...reg.teams, { id: "late", name: "Late Project", color: "#4a9", paths: ["late"], lanes: [{ id: "late", name: "Late", paths: ["late"] }] }] };
  for (const [q, want] of [["tab=inbox", "inbox"], ["tab=standup", "feed"]]) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    await context.addInitScript(HISTORY_WRAP);
    await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
    let served = 0;
    await context.route("**/api/teams", async (r) => { if (r.request().method() !== "GET") return r.fulfill({ status: 404, body: "nf" }); served++; await new Promise((res) => setTimeout(res, 1500)); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(late) }); });
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${baseUrl}/?demo=&team=late&${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(300);
    const early = await screenOf(page);
    assert.equal(early.tab, "overview", `${q}: the fallback view (before /api/teams answers) shows its own Overview tab`);
    await page.locator(".boring-sidebar .boring-project-row", { hasText: "Late Project" }).first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
    assert.ok(served > 0, "the late registry was served");
    const sc = await screenOf(page);
    assert.deepEqual({ url: sc.url, card: sc.card, tab: sc.tab, chat: sc.chat }, OV("late", want), `${q}: the late project shows the URL's tab`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});

// Same root, pre-existing since SB5/R5-4: over an Overview reached from a chat (the pane still holds that agent), BoringApp's unmount
// cleared its shown agent, urlAgentId flipped to the pane's agent, and sbNav closed Storybook the moment it opened (landing in the chat).
test("U1 r2 e2e (R33 M1): Storybook over an Overview reached from a chat stays open; Esc goes back to that Overview", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark", withStorybook);
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  await page.locator(".boring-sidebar .boring-project-row", { hasText: "VibeSquad" }).first().click();
  await page.waitForTimeout(900);
  assert.deepEqual(await screenOf(page), OV("vibesquad"), "start: the VibeSquad Overview after the Audit chat");
  const s0 = await take();
  await page.getByRole("button", { name: "Storybook" }).first().click();
  await page.waitForTimeout(1200);
  const s1 = await take();
  assert.equal(await page.locator(".boring-sidebar").count(), 0, `Storybook stays open (${JSON.stringify(s1.h)} ${s1.url})`);
  assert.equal(pushes(s1), 1, `one pushState (${JSON.stringify(s1.h)})`);
  assert.equal(s1.hlen - s0.hlen, 1, "history.length +1");
  assert.equal(sortedQ(s1.url), sortedQ("?demo=&team=vibesquad&sb=vibesquad"), "the Storybook URL names no agent");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(900);
  const s2 = await take();
  assert.ok(s2.h.includes("back"), `Esc is history.back() (${JSON.stringify(s2.h)})`);
  assert.equal(pushes(s2), 0, `Esc writes no entry (${JSON.stringify(s2.h)})`);
  assert.deepEqual(await screenOf(page), OV("vibesquad"), "Esc lands on the Overview, not the pane's chat");
  await page.goBack();
  await page.waitForTimeout(900);
  const s3 = await take();
  assert.equal(pushes(s3), 0, `Back writes no entry (${JSON.stringify(s3.h)})`);
  const back = await screenOf(page);
  assert.equal(back.url, "?demo=&team=vibesquad&agent=demo-aud", "Back lands on the Audit chat entry");
  assert.equal(back.chat, true);
  assert.deepEqual(errs, [], "no page errors");
  await context.close();
});

// UX m1: the breadcrumb names the sub-tab on screen (SPEC R2 #4: breadcrumb derived from what's on screen).
test("U1 r2 e2e (R33 m1): the breadcrumb names the Idea Inbox / Standup Feed tab, Overview otherwise", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page } = await openChat("dark");
  assert.deepEqual(await crumbOf(page), ["VibeSquad", "Overview"]);
  await page.locator('[data-testid="boring-tab-inbox"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await crumbOf(page), ["VibeSquad", "Idea Inbox"]);
  await page.locator('[data-testid="boring-tab-feed"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await crumbOf(page), ["VibeSquad", "Standup Feed"]);
  await page.locator('[data-testid="boring-crumb-project"]').click(); // the project crumb is the Overview
  await page.waitForTimeout(500);
  assert.deepEqual(await crumbOf(page), ["VibeSquad", "Overview"]);
  assert.deepEqual(await screenOf(page), OV("vibesquad"));
  await context.close();
});

// U1 r2 unit (R33 M1): the real urlSyncDecision: a key-order-only difference is the same URL (no write), any value change still writes.
test("U1 r2: urlSyncDecision treats a reordered query as the same URL (Storybook ?sb= before team) and still writes real changes", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const code = transformSync("u.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8"), { lang: "ts" }).code;
  const { urlSyncDecision } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const D = (next, current, popActive = false) => urlSyncDecision({ next, current, popActive, storybookReplace: () => false });
  assert.deepEqual(D("?demo=&sb=vibesquad&team=vibesquad", "?demo=&team=vibesquad&sb=vibesquad"), { write: false, replace: false }, "Storybook open: the sync's reorder is not a navigation");
  assert.deepEqual(D("?demo=&sb=vibesquad&team=vibesquad&tab=inbox", "?demo=&team=vibesquad&tab=inbox&sb=vibesquad"), { write: false, replace: false });
  assert.deepEqual(D("?team=a&agent=b", "?agent=b&team=a", true), { write: false, replace: true }, "pop: same URL, still no write");
  assert.deepEqual(D("?demo=&team=efi&sb=vibesquad", "?demo=&team=vibesquad&sb=vibesquad"), { write: true, replace: false }, "a value change pushes");
  assert.deepEqual(D("?team=a&tab=inbox", "?team=a"), { write: true, replace: false }, "an added key pushes");
  assert.deepEqual(D("?team=a", "?team=a&tab=inbox"), { write: true, replace: false }, "a dropped key pushes");
  assert.deepEqual(D("?team=a&x=1&x=2", "?team=a&x=2&x=1"), { write: false, replace: false }, "repeated keys compare as a multiset");
  assert.deepEqual(D("", ""), { write: false, replace: false });
});

// ── P3 (docs/PLAN_DESK_DD_POLISH.md P3; idea-1000): a feature lane's empty card has its own URL ─────────────────────────────────────
// ?lane=<laneId> names the lane's empty card (Brainstorm role); &role=lead its Lead card ("Brainstorm ready · no Lead"), also for
// ?slot=bugs. The split's right-pane card (rightCard, B17) is transient pane state and never writes a key (Bor3).
test("P3: serializeUrlState/parseUrlState/sameQuery/urlSyncScreen carry ?lane= and ?role=lead; one screen = one canonical URL", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const pal = readFileSync(path.join(REPO_ROOT, "src", "CommandPalette.tsx"), "utf8");
  const fn = (name) => { const i = pal.indexOf(`export function ${name}`); return pal.slice(i, pal.indexOf("\n}\n", i) + 3); };
  const code = transformSync("p3.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8") + "\n" + fn("parseUrlState") + fn("serializeUrlState"), { lang: "ts" }).code;
  const { parseUrlState: parse, serializeUrlState: ser, urlSyncScreen, sameQuery, urlSyncDecision } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const cases = [
    [{ team: "vibesquad", agent: null, slot: null, lane: "runner-pilot", tab: null }, "?demo=", "?demo=&team=vibesquad&lane=runner-pilot"],
    [{ team: "vibesquad", agent: null, slot: null, lane: "bug-chaser", role: "lead", tab: null }, "?demo=&riff=1", "?demo=&riff=1&team=vibesquad&lane=bug-chaser&role=lead"],
    [{ team: "vibesquad", agent: null, slot: "bugs", role: "lead", tab: null }, "", "?team=vibesquad&slot=bugs&role=lead"],
  ];
  for (const [st, base, want] of cases) {
    const url = ser(st, base);
    assert.equal(url, want, JSON.stringify(st));
    assert.deepEqual(parse(url), st, `parse(${url})`);
    assert.equal(ser(parse(url), url), url, `stable: ${url}`);
  }
  // Precedence agent > slot > lane > tab; role only qualifies ?slot=bugs / ?lane=; stale keys are replaced, never duplicated.
  assert.equal(ser({ team: "t", agent: "a", lane: "x", role: "lead" }), "?team=t&agent=a");
  assert.equal(ser({ team: "t", agent: null, slot: "overlord", lane: "x", role: "lead" }), "?team=t&slot=overlord");
  assert.equal(ser({ team: "t", agent: null, lane: "x", tab: "inbox" }), "?team=t&lane=x");
  assert.equal(ser({ team: "t", agent: null, tab: "inbox", role: "lead" }), "?team=t&tab=inbox", "no stray role on a tab");
  assert.equal(ser({ team: "t", agent: null }, "?team=t&lane=x&role=lead"), "?team=t", "callers that pass no keys strip them");
  assert.equal(ser({ team: "t", agent: null, lane: "y" }, "?lane=x&role=lead&team=t"), "?team=t&lane=y");
  assert.deepEqual(parse("?team=t&agent=a&lane=x&role=lead"), { team: "t", agent: "a", slot: null, tab: null });
  assert.deepEqual(parse("?team=t&slot=overlord&lane=x&role=lead"), { team: "t", agent: null, slot: "overlord", tab: null });
  assert.deepEqual(parse("?team=t&lane=x&tab=inbox&role=nope"), { team: "t", agent: null, slot: null, lane: "x", tab: null });
  assert.deepEqual(parse("?team=t&role=lead"), { team: "t", agent: null, slot: null, tab: null }, "role alone is nothing");
  assert.deepEqual(parse("?team=t&lane=&role=lead"), { team: "t", agent: null, slot: null, tab: null });
  // sameQuery: order-insensitive, so the sync never pushes a reorder of the same lane card; a role or lane change is a new screen.
  assert.equal(sameQuery("?demo=&team=vibesquad&riff=1&lane=bug-chaser&role=lead", "?demo=&riff=1&team=vibesquad&lane=bug-chaser&role=lead"), true);
  assert.equal(sameQuery("?team=t&lane=x&role=lead", "?role=lead&lane=x&team=t"), true);
  assert.equal(sameQuery("?team=t&lane=x", "?team=t&lane=x&role=lead"), false);
  assert.equal(sameQuery("?team=t&lane=x", "?team=t&lane=y"), false);
  assert.deepEqual(urlSyncDecision({ next: "?team=t&lane=x&role=lead", current: "?role=lead&team=t&lane=x", popActive: false, storybookReplace: () => false }), { write: false, replace: false });
  assert.deepEqual(urlSyncDecision({ next: "?team=t&lane=x", current: "?team=t", popActive: true, storybookReplace: () => false }), { write: true, replace: true }, "while a pop is active: replace, never push");
  // urlSyncScreen: same team gate as U1; BoringApp unmounted keeps the URL's lane/role; Psycho writes none.
  const K = (team, lane = null, role = null) => ({ team, slot: null, lane, role, tab: null });
  const S = (o) => urlSyncScreen({ boring: true, live: undefined, rendered: undefined, team: "efi", kept: {}, ...o });
  assert.deepEqual(S({ live: K("efi", "ui-lab", "lead") }), { slot: null, lane: "ui-lab", role: "lead", tab: null });
  assert.deepEqual(S({ live: K("efi", "ui-lab") }), { slot: null, lane: "ui-lab", tab: null });
  assert.deepEqual(S({ live: K("vibesquad", "wiki"), rendered: K("vibesquad", "wiki") }), { slot: null, tab: null }, "another project's lane is never written for this team");
  assert.deepEqual(S({ live: undefined, kept: parse("?team=efi&lane=ui-lab&role=lead") }), { slot: null, lane: "ui-lab", role: "lead", tab: null }, "Storybook: keep the URL's keys");
  assert.deepEqual(S({ boring: false, live: K("efi", "ui-lab", "lead") }), { slot: null, tab: null });
});

const laneHead = (page) => page.evaluate(() => (document.querySelector('[data-testid="boring-lane-no-agent-head"]')?.textContent ?? "").trim() || null);
const LANE_CARD = { url: "?demo=&team=vibesquad&lane=runner-pilot", card: "Start Brainstorm", tab: null, chat: false };

test("P3 e2e (idea-1000): a lane's empty card has its own URL (?lane=): one push; go elsewhere, Back shows the card, Forward returns, reload keeps it", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  // A chat first, so the persisted pane has an active agent: reload must still land on the card, not that chat.
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  await page.locator('[data-testid="boring-project-header-vibesquad"]').click();
  await page.waitForTimeout(900);
  assert.deepEqual(await screenOf(page), OV("vibesquad"));
  await take();
  // Runner Pilot has an idle Lead and no Brainstorm: its Brainstorm cell opens the lane's empty card.
  const nav = await u1Step(page, take, "open lane card", () => page.locator('[data-testid="boring-lane-row-runner-pilot"] td:nth-child(2) button').click(), LANE_CARD);
  assert.equal(pushes(nav.s), 1, `one pushState (${JSON.stringify(nav.s.h)})`);
  assert.equal(nav.s.hlen - nav.before.hlen, 1, "history.length +1");
  assert.equal(await laneHead(page), "Runner Pilot · Lead idle · no Brainstorm");
  // Elsewhere (another project), then Back / Forward / Back / reload.
  const away = await u1Step(page, take, "go elsewhere", () => page.locator('[data-testid="boring-project-header-efi"]').click(), OV("efi"));
  assert.equal(pushes(away.s), 1);
  assert.equal(away.s.hlen - away.before.hlen, 1, "history.length +1");
  const back = await u1Step(page, take, "Back", () => page.goBack(), LANE_CARD);
  assert.equal(pushes(back.s), 0, `Back: no pushState (${JSON.stringify(back.s.h)})`);
  assert.equal(back.s.hlen, away.s.hlen, "Back: history.length unchanged");
  assert.equal(await laneHead(page), "Runner Pilot · Lead idle · no Brainstorm", "Back shows the lane's card");
  const fwd = await u1Step(page, take, "Forward", () => page.goForward(), OV("efi"));
  assert.equal(pushes(fwd.s), 0);
  assert.equal(fwd.s.hlen, away.s.hlen, "Forward: history.length unchanged");
  const back2 = await u1Step(page, take, "Back again", () => page.goBack(), LANE_CARD);
  assert.equal(pushes(back2.s), 0);
  await u1Reload(page, "lane card", LANE_CARD);
  assert.equal(await laneHead(page), "Runner Pilot · Lead idle · no Brainstorm", "reload shows the lane's card");
  assert.deepEqual(errs, [], "no page errors");
  await context.close();
});

test("P3 e2e (idea-1000): the 'Brainstorm ready · no Lead' card (?lane=&role=lead): load, go elsewhere, Back, Forward, reload", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  // ?riff=1: the demo's Bug Chaser lane has a Brainstorm and no Lead.
  const url = "?demo=&riff=1&team=vibesquad&lane=bug-chaser&role=lead";
  await page.goto(`${baseUrl}/${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const take = () => page.evaluate(() => ({ h: window.__h.splice(0), hlen: history.length, url: location.search }));
  const s0 = await take();
  assert.equal(s0.url, url, "the load keeps the card's URL");
  assert.equal(pushes(s0), 0, "load canonicalization never pushes");
  const head = "Bug Chaser · Brainstorm ready · no Lead";
  assert.equal(await laneHead(page), head);
  await page.locator('[data-testid="boring-project-header-efi"]').click();
  await page.waitForTimeout(900);
  const s1 = await take();
  assert.equal(s1.url, "?demo=&riff=1&team=efi");
  assert.equal(pushes(s1), 1);
  assert.equal(s1.hlen - s0.hlen, 1, "history.length +1");
  await page.goBack();
  await page.waitForTimeout(900);
  const s2 = await take();
  assert.equal(s2.url, url);
  assert.equal(pushes(s2), 0);
  assert.equal(await laneHead(page), head, "Back shows the Lead card, not the lane's Brainstorm chat");
  await page.goForward();
  await page.waitForTimeout(900);
  const s3 = await take();
  assert.equal(s3.url, "?demo=&riff=1&team=efi");
  assert.equal(await laneHead(page), null);
  await page.goBack();
  await page.waitForTimeout(900);
  await take();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const s4 = await take();
  assert.equal(s4.url, url, "reload keeps the URL");
  assert.equal(pushes(s4), 0, "reload writes no entry");
  assert.equal(await laneHead(page), head, "reload shows the Lead card");
  assert.deepEqual(errs, [], "no page errors");
  await context.close();
});

test("P3 e2e (Bor3): the split's right-pane lane card (rightCard) writes no URL key and no history entry", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { context, page, take } = await openChat("dark");
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
  await page.waitForTimeout(900);
  const s0 = await take();
  assert.equal(s0.url, "?demo=&team=vibesquad&agent=demo-aud");
  await page.locator('[data-testid="boring-split-toggle"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="boring-pp-open-runner-pilot-brainstorm"]').click(); // dormant pill: the lane's empty card in the right pane
  await page.waitForTimeout(900);
  assert.equal(await page.locator('[data-testid="boring-empty-lane"]').first().textContent(), "Runner Pilot", "the right pane shows the lane's card");
  const s1 = await take();
  assert.equal(s1.url, s0.url, "URL unchanged: no ?lane= / ?slot= / ?role= for the pane-local card");
  assert.doesNotMatch(s1.url, /[?&](lane|slot|role)=/);
  assert.deepEqual(s1.h, [], `no history write (${JSON.stringify(s1.h)})`);
  assert.equal(s1.hlen, s0.hlen);
  await context.close();
});
