// @desk B1 e2e (docs/UX_REVIEW_R22.md M1) + B2 one-entry-per-navigation e2e/unit (end of file): App's URL-sync effect must not pushState while a popstate is settling,
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
  const names = (await page.locator(".boring-sidebar .boring-needs-open").allTextContents()).map((x) => x.trim()).filter((x) => x && !/Audit - token scout/.test(x) && /· VibeSquad/.test(x)); // same-project rows: one push each
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
  const rows = (await page.locator(".boring-sidebar .boring-needs-open").allTextContents()).map((x) => x.trim()).filter((x) => /· VibeSquad/.test(x));
  assert.ok(rows.length >= 3, `>=3 same-project rows (${JSON.stringify(rows)})`);
  const urls = [];
  for (const r of rows.slice(0, 3)) { await page.locator(".boring-sidebar .boring-needs-open", { hasText: r.slice(0, 20) }).first().click(); await page.waitForTimeout(500); urls.push(await page.evaluate(() => location.search)); }
  await take();
  await page.evaluate(() => { history.back(); history.back(); }); // two pops in one tick: rows[2] -> rows[1] -> rows[0]
  await page.waitForTimeout(1200);
  const two = await take();
  assert.equal(pushes(two), 0, `double Back: 0 pushState (got ${JSON.stringify(two.h)})`);
  assert.equal(two.url, urls[0], "the double Back lands on the 2nd target (rows[0]'s URL)");
  await page.locator(".boring-sidebar .boring-needs-open", { hasText: rows[2].slice(0, 20) }).first().click();
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
};
const B2_FINAL = { "a Ctrl+K agent pick": "?demo=&team=efi&agent=demo-lead-ui", "b Needs-you row": "?demo=&team=efi&agent=demo-lead-efi", "c sidebar agent row": "?demo=&team=efi&agent=demo-lead-ui", "d project row": "?demo=&team=efi", "e notification click": "?demo=&team=efi&agent=demo-lead-ui" };
for (const [route, act] of Object.entries(B2_ROUTES)) {
  test(`B2 e2e (${route}): cross-project nav from a chat = exactly 1 entry, no mixed entry, one Back returns to the chat`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    const { context, page, take } = await openChat("dark");
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.evaluate(() => { window.__w = []; for (const k of ["pushState", "replaceState"]) { const o = history[k].bind(history); history[k] = (...a) => { window.__w.push([k, String(a[2]).replace(/^.*\?/, "?")]); return o(...a); }; } });
    await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click();
    await page.waitForTimeout(900);
    const s0 = await take();
    assert.equal(s0.url, "?demo=&team=vibesquad&agent=demo-aud");
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
    assert.equal(s2.url, s0.url, "one Back returns to the chat's URL");
    assert.equal(s2.chat, true, "one Back shows the chat again (not a dead Back)");
    assert.equal(pushes(s2), 0, `Back never pushes (${JSON.stringify(s2.h)})`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  });
}

// B2 unit: App's URL sync names the agent BoringApp published THIS commit (read live at effect time), so team + agent are one push.
test("B2: urlSyncAgent reads the live shown agent in Normal; one commit = one push, no mixed entry", async () => {
  const { transformSync } = await import("rolldown/utils");
  const { readFileSync } = await import("node:fs");
  const pal = readFileSync(path.join(REPO_ROOT, "src", "CommandPalette.tsx"), "utf8");
  const ser = pal.slice(pal.indexOf("export function serializeUrlState"), pal.indexOf("\n}\n", pal.indexOf("export function serializeUrlState")) + 3);
  assert.match(ser, /^export function serializeUrlState[\s\S]*\n\}\n$/, "extracted the real serializeUrlState");
  const code = transformSync("urlSync.ts", readFileSync(path.join(REPO_ROOT, "src", "urlSync.ts"), "utf8") + "\n" + ser, { lang: "ts" }).code;
  const { urlSyncAgent, urlSyncDecision, serializeUrlState } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

  // Helper contract.
  assert.equal(urlSyncAgent({ boring: true, liveShown: "new", activeAgentId: "tab", rendered: "old" }), "new", "Normal: the live published agent, not the stale render value");
  assert.equal(urlSyncAgent({ boring: true, liveShown: null, activeAgentId: "tab", rendered: "old" }), null, "Normal Overview/usage: no ?agent=");
  assert.equal(urlSyncAgent({ boring: true, liveShown: undefined, activeAgentId: "tab", rendered: "old" }), "tab", "BoringApp not mounted: the active tab stands in");
  assert.equal(urlSyncAgent({ boring: false, liveShown: "new", activeAgentId: "tab", rendered: "psycho" }), "psycho", "Psycho/phone: App's render-time value, untouched");

  // Simulate App's URL sync over the commits of a cross-project nav from a chat (A=vibesquad/demo-aud -> B=efi/<agent>).
  // Commit 1: team flips to efi and BoringApp's child effect publishes the new agent; App's render-time value is still demo-aud.
  // Commit 2: the store re-render; render value catches up. `agentOf(commit)` picks which value the sync names.
  const run = (final, agentOf) => {
    let search = "?demo=&team=vibesquad&agent=demo-aud";
    const entries = [search];
    const commits = [{ team: "efi", rendered: "demo-aud", live: final }, { team: "efi", rendered: final, live: final }];
    for (const c of commits) {
      const next = serializeUrlState({ team: c.team, agent: agentOf(c) }, search);
      const d = urlSyncDecision({ next, current: search, popActive: false, storybookReplace: () => false });
      if (!d.write) continue;
      if (d.replace) entries[entries.length - 1] = next; else entries.push(next);
      search = next;
    }
    return entries;
  };
  const live = (c) => urlSyncAgent({ boring: true, liveShown: c.live, activeAgentId: c.live, rendered: c.rendered });
  const stale = (c) => c.rendered; // pre-B2: App's render-time useBoringShownAgent()
  for (const final of ["demo-lead-ui", null]) {
    const want = final ? `?demo=&team=efi&agent=${final}` : "?demo=&team=efi";
    assert.deepEqual(run(final, live), ["?demo=&team=vibesquad&agent=demo-aud", want], `B2 (${final}): exactly one new entry, the final URL`);
    assert.deepEqual(run(final, stale), ["?demo=&team=vibesquad&agent=demo-aud", "?demo=&team=efi&agent=demo-aud", want], `pre-B2 (${final}): the mixed interim entry the fix removes`);
  }
});
