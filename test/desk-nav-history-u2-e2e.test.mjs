// @desk U2 (docs/PLAN_DESK_URL_COMPLETE.md): history edge races in Normal mode, driven in a real headless browser (?demo, bundled teams).
// - idea-983 (UX R29 m1): two Back (or Forward) presses that land before one render coalesce to the LATEST pop target, and no write
//   overwrites the in-between entry.
// - idea-971 (UX R28 m2): Back into a stale ?sb= entry reopens Storybook (screen and URL agree), and Esc / Back out of it are live presses.
// - UX R33 m2 + r2 m3: a pasted non-canonical / invalid URL is canonicalized with replaceState on first load (never a push), so there is
//   no dead or stale entry behind it, and a pop never applies a gone team's ?slot= / ?tab= to the fallback project.
// Skips (like the other e2e files) when no Playwright/Chromium is available. U2_LOOP=<n> sets the race loop count (default 3).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const LOOP = Math.max(1, Number(process.env.U2_LOOP) || 3);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

before(async () => {
  pw = resolvePlaywright({ npx: false });
  exe = findBrowser();
  const why = browserSkipReason({ pw, exe });
  if (why) { unavailable = why; return; }
  await ensureDist();
  const dist = path.join(REPO_ROOT, "dist");
  server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const fp = path.join(dist, pathname === "/" ? "index.html" : pathname);
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

const HISTORY_WRAP = `(() => {
  window.__h = [];
  for (const k of ["pushState", "replaceState", "back", "forward", "go"]) {
    const o = history[k].bind(history);
    history[k] = (...a) => { window.__h.push(k + " " + (typeof a[2] === "string" ? a[2].replace(/^[^?]*/, "") : "")); return o(...a); };
  }
  addEventListener("popstate", () => window.__h.push("POP " + location.search));
})()`;
// Storybook's HEAD probe answers 200 (its topbar button shows); GET stays 404 (the takeover shows its empty state).
const withStorybook = (context) => context.route("**/api/storybook/**", (r) => (r.request().method() === "HEAD" ? r.fulfill({ status: 200, body: "" }) : r.fulfill({ status: 404, body: "nf" })));

async function open(q = "team=vibesquad", { storybook = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  if (storybook) await withStorybook(context);
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${baseUrl}/?demo=${q ? `&${q}` : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".boring-sidebar, .sb-root, [data-testid='storybook-view']", { timeout: 20000 });
  await page.waitForTimeout(900);
  return { context, page, errs };
}
/** What is on screen + the history log since the last call. */
const snap = (page) => page.evaluate(() => {
  const card = document.querySelector('[data-testid="boring-empty-card"]');
  const ov = document.querySelector('[data-testid="boring-project-view"]');
  const tab = ov ? ["overview", "inbox", "feed"].find((t) => document.querySelector(`[data-testid="boring-tab-${t}"]`)?.classList.contains("on")) ?? null : null;
  const crumb = [...document.querySelectorAll(".boring-crumb-seg")].map((e) => (e.querySelector(".boring-crumb-cur, .boring-crumb-btn")?.textContent ?? "").trim()).join(" › ");
  const sidebar = !!document.querySelector(".boring-sidebar");
  return {
    url: location.search, hlen: history.length, h: window.__h.splice(0),
    screen: !sidebar ? "storybook" : card ? `card:${(card.querySelector('[data-testid="boring-empty-cta"]')?.textContent ?? "").trim()}` : ov ? `overview:${tab}` : document.querySelector(".boring-timeline, .timeline") ? "chat" : "?",
    crumb,
  };
});
const sortedQ = (u) => [...new URLSearchParams(u)].map((kv) => kv.join("=")).sort().join("&");
const writes = (s) => s.h.filter((k) => /^(pushState|replaceState)/.test(k));
const pushes = (s) => s.h.filter((k) => k.startsWith("pushState")).length;
const projectRow = (page, name) => page.locator(".boring-sidebar .boring-project-row", { hasText: name }).first().click();
const needsRow = (page, name) => page.locator(".boring-sidebar .boring-needs-open", { hasText: name }).first().click();

// A trail of every entry kind, one push each: [0] VibeSquad Overview (load), [1] Audit chat, [2] Main Game Overview, [3] its Standup tab,
// [4] its empty Overlord card (?slot=), [5] VibeSquad Overview (row), [6] its Idea Inbox tab, [7] the Audit chat again.
const TRAIL = [
  (p) => needsRow(p, "Audit - token scout"),
  (p) => projectRow(p, "Main Game Project"),
  (p) => p.locator('[data-testid="boring-tab-feed"]').click(),
  (p) => p.locator('.boring-sidebar [data-testid="boring-core-overlord-efi"], .boring-sidebar [data-testid="boring-core-overlord"]').first().click(),
  (p) => projectRow(p, "VibeSquad"),
  (p) => p.locator('[data-testid="boring-tab-inbox"]').click(),
  (p) => needsRow(p, "Audit - token scout"),
];
const WANT_TRAIL = ["?demo=&team=vibesquad", "?demo=&team=vibesquad&agent=demo-aud", "?demo=&team=efi", "?demo=&team=efi&tab=standup", "?demo=&team=efi&slot=overlord", "?demo=&team=vibesquad", "?demo=&team=vibesquad&tab=inbox", "?demo=&team=vibesquad&agent=demo-aud"];
async function buildTrail(page) {
  const trail = [await snap(page)];
  for (const act of TRAIL) { await act(page); await page.waitForTimeout(650); trail.push(await snap(page)); }
  assert.deepEqual(trail.map((e) => e.url), WANT_TRAIL, "setup trail");
  assert.deepEqual(trail.slice(1).map(pushes), TRAIL.map(() => 1), "setup: one push per navigation");
  return trail;
}

// idea-983: Back ×2 / Forward ×2 with no gap (Playwright goBack()/goForward() twice: each waits for its own commit, neither for a React
// render). The screen must land on the 2nd target, and no write during the pops may name another screen: a transient pre-landing write
// into the popped entry is what a second press, landing between it and its heal, turned into a permanently overwritten entry.
test(`U2 e2e (idea-983): goBack() ×2 / goForward() ×2 with no gap land on the 2nd target and never write another screen into an entry (×${LOOP})`, async (t) => {
  if (unavailable) return t.skip(unavailable);
  let pass = 0;
  const fails = [];
  for (let i = 0; i < LOOP; i++) {
    const { context, page, errs } = await open();
    try {
      const trail = await buildTrail(page);
      const hlen = trail.at(-1).hlen;
      let idx = trail.length - 1;
      const check = async (label) => {
        await page.waitForTimeout(700);
        const s = await snap(page), w = trail[idx], log = s.h.join(" | ");
        assert.deepEqual({ url: s.url, screen: s.screen, crumb: s.crumb }, { url: w.url, screen: w.screen, crumb: w.crumb }, `#${i} ${label} → [${idx}]: URL, screen and crumb :: ${log}`);
        assert.equal(s.hlen, hlen, `#${i} ${label} → [${idx}]: history.length unchanged :: ${log}`);
        assert.deepEqual(writes(s).filter((x) => sortedQ(x.replace(/^\S+ /, "")) !== sortedQ(w.url)), [], `#${i} ${label} → [${idx}]: no write names another screen :: ${log}`);
      };
      while (idx >= 2) { await page.goBack(); await page.goBack(); idx -= 2; await check("Back ×2"); }
      while (idx + 2 < trail.length) { await page.goForward(); await page.goForward(); idx += 2; await check("Forward ×2"); }
      // Single steps: every entry the double presses skipped over is exactly as it was written.
      while (idx > 0) { await page.goBack(); idx--; await check("Back"); }
      while (idx < trail.length - 1) { await page.goForward(); idx++; await check("Forward"); }
      assert.deepEqual(errs, [], "no page errors");
      pass++;
    } catch (e) {
      fails.push(String(e.message).split("\n")[0]);
    } finally {
      await context.close();
    }
  }
  t.diagnostic(`idea-983 goBack()/goForward() ×2 race: ${pass}/${LOOP} passed`);
  assert.equal(pass, LOOP, `${pass}/${LOOP} passed; failures:\n${fails.join("\n")}`);
});

// idea-971 (UX R28 m2): Back into a ?sb= entry left behind the current screen reopens Storybook: screen and URL agree, nothing is written,
// and every press after it is live. Two kinds, planted like R28's sbkbd step 18: an entry openStorybook pushed ({sb} state) and one a cold
// link left (null state). Either way Esc goes Back, as right after opening (stripping in place left two identical entries: a dead Back).
for (const kind of ["pushed", "cold"]) {
  test(`U2 e2e (idea-971): Back into a stale ?sb= entry (${kind}) reopens Storybook; URL = screen; Esc and Back stay live`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    const { context, page, errs } = await open("team=vibesquad", { storybook: true });
    await needsRow(page, "Audit - token scout"); await page.waitForTimeout(800);
    const chat = await snap(page);
    assert.equal(chat.url, "?demo=&team=vibesquad&agent=demo-aud");
    const sbUrl = `${chat.url}&sb=vibesquad`;
    // [.., chat, chat&sb (stale), efi Overview]: the entry Back lands on names another team/agent than the screen it leaves (R28's case).
    await page.evaluate(([u, st]) => { history.pushState(st, "", u); history.pushState(null, "", "?demo=&team=efi"); }, [sbUrl, kind === "pushed" ? { sb: "vibesquad" } : null]);
    await projectRow(page, "Main Game Project"); await page.waitForTimeout(800); // the screen catches up with the URL (no write)
    const efi = await snap(page);
    assert.deepEqual({ url: efi.url, screen: efi.screen, pushes: pushes(efi) }, { url: "?demo=&team=efi", screen: "overview:overview", pushes: 2 }, `setup :: ${efi.h.join(" | ")}`);
    await page.goBack(); await page.waitForTimeout(1000); // the stale ?sb= entry
    const sb = await snap(page);
    assert.equal(sb.screen, "storybook", `Back into ?sb= shows Storybook :: ${sb.h.join(" | ")}`);
    assert.equal(sortedQ(sb.url), sortedQ(sbUrl), `the entry keeps ?sb= (URL = screen) :: ${sb.h.join(" | ")}`);
    assert.deepEqual(writes(sb), [], `no history write :: ${sb.h.join(" | ")}`);
    assert.equal(sb.hlen, efi.hlen, "history.length unchanged");
    // Back out of it is live (the chat entry before it), and Forward into it reopens Storybook again.
    await page.goBack(); await page.waitForTimeout(900);
    const pre = await snap(page);
    assert.deepEqual({ url: pre.url, screen: pre.screen }, { url: chat.url, screen: "chat" }, `Back out of Storybook :: ${pre.h.join(" | ")}`);
    await page.goForward(); await page.waitForTimeout(1000);
    const sb2 = await snap(page);
    assert.deepEqual({ q: sortedQ(sb2.url), screen: sb2.screen }, { q: sortedQ(sbUrl), screen: "storybook" }, `Forward into it reopens Storybook :: ${sb2.h.join(" | ")}`);
    // Esc closes it onto a screen that is not Storybook, URL and screen agree, and the next Back is live (the screen changes).
    await page.keyboard.press("Escape");
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 });
    await page.waitForTimeout(900);
    const esc = await snap(page);
    assert.equal(pushes(esc), 0, `Esc never pushes :: ${esc.h.join(" | ")}`);
    assert.doesNotMatch(esc.url, /sb=/, `Esc: URL without ?sb= (${esc.url})`);
    assert.deepEqual({ url: esc.url, screen: esc.screen, back: esc.h.includes("back ") }, { url: chat.url, screen: "chat", back: true }, `Esc goes Back to the entry before :: ${esc.h.join(" | ")}`);
    assert.equal(esc.hlen, efi.hlen, "Esc keeps history.length");
    await page.goBack(); await page.waitForTimeout(900);
    const after = await snap(page);
    assert.notDeepEqual({ url: after.url, screen: after.screen }, { url: esc.url, screen: esc.screen }, `Back after Esc is live :: ${after.h.join(" | ")}`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  });
}

// UX R33 m2 + r2 m3: a pasted / bookmarked URL that the app canonicalizes on first load is rewritten with replaceState (history.length
// stays 2: about:blank + the load), so there is no stale raw entry behind it and the first Back leaves the app. And m3: Back into a
// ?team=<gone> entry with a slot/tab never applies them to the fallback project, and heals the URL to the screen.
test("U2 e2e (R33 m2): a non-canonical or invalid URL is canonicalized on first load with replaceState, never a push", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const cases = [
    ["team=vibesquad&tab=bogus", "?demo=&team=vibesquad", "overview:overview"],
    ["team=vibesquad&slot=bogus", "?demo=&team=vibesquad", "overview:overview"],
    ["tab=inbox&team=vibesquad", null, "overview:inbox"], // key order only: no write at all
    ["team=gone", "?demo=&team=efi", "overview:overview"],
    ["team=gone&slot=overlord", "?demo=&team=efi", "overview:overview"],
    ["team=gone&tab=inbox", "?demo=&team=efi", "overview:overview"],
    ["team=efi&slot=overlord&agent=demo-aud", "?demo=&team=vibesquad&agent=demo-aud", "chat"],
  ];
  for (const [q, want, screen] of cases) {
    const { context, page, errs } = await open(q);
    await page.waitForTimeout(600);
    const s = await snap(page);
    assert.equal(pushes(s), 0, `${q}: no push on load :: ${s.h.join(" | ")}`);
    assert.equal(s.hlen, 2, `${q}: history.length 2 (blank + the load) :: ${s.h.join(" | ")}`);
    if (want) assert.equal(s.url, want, `${q}: canonical URL`); else assert.equal(sortedQ(s.url), sortedQ(`?demo=&${q}`), `${q}: kept`);
    assert.equal(s.screen, screen, `${q}: screen`);
    // The first user navigation after load still pushes exactly one entry, and Back returns to the canonical load entry.
    await projectRow(page, s.url.includes("team=efi") ? "VibeSquad" : "Main Game Project"); await page.waitForTimeout(800);
    const nav = await snap(page);
    assert.equal(pushes(nav), 1, `${q}: the first click pushes :: ${nav.h.join(" | ")}`);
    await page.goBack(); await page.waitForTimeout(900);
    const back = await snap(page);
    assert.deepEqual({ url: back.url, screen: back.screen }, { url: s.url, screen: s.screen }, `${q}: Back = the canonical load entry :: ${back.h.join(" | ")}`);
    assert.deepEqual(writes(back), [], `${q}: Back writes nothing :: ${back.h.join(" | ")}`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});

test("U2 e2e (R33 r2 m3): Back into a ?team=<gone> entry never applies its slot/tab to the fallback project; the URL heals to the screen", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const q of ["team=gone&slot=overlord", "team=gone&tab=inbox"]) {
    const { context, page, errs } = await open();
    // A stale gone-team entry behind the current screen (as an old m2 push, or a project removed since), then VibeSquad Inbox on top.
    await page.evaluate((u) => { history.pushState(null, "", u); }, `?demo=&${q}`);
    await page.locator('[data-testid="boring-tab-inbox"]').click(); await page.waitForTimeout(800);
    const top = await snap(page);
    assert.equal(top.url, "?demo=&team=vibesquad&tab=inbox");
    await page.goBack(); await page.waitForTimeout(1000);
    const b = await snap(page);
    assert.equal(b.screen, "overview:overview", `${q}: the fallback project's plain Overview :: ${b.h.join(" | ")}`);
    assert.match(b.crumb, /^Main Game Project › Overview$/, `${q}: crumb ${b.crumb}`);
    assert.equal(b.url, "?demo=&team=efi", `${q}: URL healed to the screen in place :: ${b.h.join(" | ")}`);
    assert.equal(pushes(b), 0, `${q}: no push`);
    assert.equal(b.hlen, top.hlen, `${q}: history.length unchanged`);
    await page.goForward(); await page.waitForTimeout(900);
    const f = await snap(page);
    assert.deepEqual({ url: f.url, screen: f.screen }, { url: top.url, screen: "overview:inbox" }, `${q}: Forward intact`);
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});

// U2 safety (B1 lesson: a "wait for the pop to settle" gate that never opens is the R28 Back trap): the landedGen gate must never leave the
// URL sync stuck. After each kind of pop the next click pushes exactly ONE entry naming the clicked screen, and Back returns to the popped
// entry. Kinds: (a) a pop BoringApp routes nowhere (?demo= alone: boringLandingFromUrl null, the screen does not change), (b) a pop into a
// ?sb= entry (BoringApp unmounted under Storybook: gate off) and back out (BoringApp remounts mid-pop), (c) Back ×2 then an immediate click.
test("U2 e2e (landedGen safety): after a no-route pop, a Storybook pop (BoringApp unmounted / remounted) or Back ×2, the next click pushes once", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const clickPushesOnce = async (page, label, row, want) => {
    const before = await snap(page);
    await projectRow(page, row); await page.waitForTimeout(800);
    const s = await snap(page);
    assert.deepEqual({ url: s.url, pushes: pushes(s) }, { url: want, pushes: 1 }, `${label}: click → one push of ${want} :: ${s.h.join(" | ")}`);
    await page.goBack(); await page.waitForTimeout(900);
    const b = await snap(page);
    assert.equal(b.url, before.url, `${label}: Back returns to the popped entry :: ${b.h.join(" | ")}`);
    assert.deepEqual(writes(b), [], `${label}: Back writes nothing :: ${b.h.join(" | ")}`);
    return s;
  };
  // (a) no-route pop: ?demo= alone. BoringApp's landing returns early; it must still mark the pop landed (the URL heals in place).
  {
    const { context, page, errs } = await open();
    await page.evaluate(() => { history.pushState(null, "", "?demo="); history.pushState(null, "", "?demo=&team=vibesquad&tab=inbox"); });
    await page.locator('[data-testid="boring-tab-inbox"]').click(); await page.waitForTimeout(800);
    const top = await snap(page);
    assert.deepEqual({ url: top.url, screen: top.screen, writes: top.h.length }, { url: "?demo=&team=vibesquad&tab=inbox", screen: "overview:inbox", writes: 2 }, `(a) setup (the screen catches up, no write) :: ${top.h.join(" | ")}`);
    await page.goBack(); await page.waitForTimeout(1000);
    const b = await snap(page);
    assert.equal(pushes(b), 0, `(a) the pop pushes nothing :: ${b.h.join(" | ")}`);
    assert.deepEqual({ url: b.url, screen: b.screen, hlen: b.hlen }, { url: top.url, screen: "overview:inbox", hlen: top.hlen }, `(a) the no-route entry heals to the screen in place :: ${b.h.join(" | ")}`);
    await clickPushesOnce(page, "(a)", "Main Game Project", "?demo=&team=efi");
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
  // (b) Storybook: Back into a ?sb= entry unmounts BoringApp (gate off, landed undefined); leaving it (Esc's history.back(), or Back)
  // remounts BoringApp while the pop is still active.
  for (const leave of ["Esc", "Back"]) {
    const { context, page, errs } = await open("team=vibesquad", { storybook: true });
    await page.evaluate(() => { history.pushState({ sb: "vibesquad" }, "", "?demo=&team=vibesquad&sb=vibesquad"); history.pushState(null, "", "?demo=&team=efi"); });
    await projectRow(page, "Main Game Project"); await page.waitForTimeout(800);
    await page.goBack(); await page.waitForTimeout(1000);
    const sb = await snap(page);
    assert.equal(sb.screen, "storybook", `(b) Back into ?sb= shows Storybook :: ${sb.h.join(" | ")}`);
    if (leave === "Esc") await page.keyboard.press("Escape"); else await page.goBack();
    await page.waitForSelector(".boring-sidebar", { timeout: 20000 }); await page.waitForTimeout(1000);
    const out = await snap(page);
    assert.deepEqual({ url: out.url, screen: out.screen }, { url: "?demo=&team=vibesquad", screen: "overview:overview" }, `(b) ${leave} out of Storybook :: ${out.h.join(" | ")}`);
    await clickPushesOnce(page, `(b) after ${leave}`, "Main Game Project", "?demo=&team=efi");
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
  // (c) Back ×2 with no gap, then a click right away (no settle wait): the click still pushes exactly one entry.
  {
    const { context, page, errs } = await open();
    const trail = await buildTrail(page);
    await page.goBack(); await page.goBack();
    await page.waitForTimeout(50);
    const mid = await snap(page);
    assert.equal(mid.url, trail.at(-3).url, `(c) Back ×2 landed :: ${mid.h.join(" | ")}`);
    await clickPushesOnce(page, "(c)", "Main Game Project", "?demo=&team=efi");
    assert.deepEqual(errs, [], "no page errors");
    await context.close();
  }
});
