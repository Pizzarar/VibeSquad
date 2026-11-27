// @desk D4 e2e (docs/PLAN_DESK_DECISION_DESK.md Done-check 5):
// Drives the built app in Playwright across dark/light at 1920x1080 and 3200x1800@1.2 on a 12-item
// 3-Squad demo: verifies live status strip, flipping 2 leans + answering 1 + 5s Undo + Send 3 answers,
// asker prompt delivery, strip + feed + sidebar badge updates, and ?view=decisions Back/Forward/reload.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason, shotsDir, cleanupShotsDir } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const SHOTS_DIR = shotsDir("desk-d4");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

const HISTORY_WRAP = `(() => {
  window.__h = [];
  for (const k of ["pushState", "replaceState", "back", "forward", "go"]) {
    const o = history[k].bind(history);
    history[k] = (...a) => { window.__h.push(k); return o(...a); };
  }
  addEventListener("popstate", () => window.__h.push("POP"));
  window.__urls = [];
  for (const k of ["pushState", "replaceState"]) {
    const o = history[k];
    history[k] = (...a) => { const r = o(...a); window.__urls.push(location.search); return r; };
  }
})()`;

// Mutable per-run backend state for the 12-item 3-Squad demo (zero personal identifiers).
let state;
function resetBackend() {
  const now = Date.now();
  const m = (mins) => now - mins * 60_000;
  const iso = (mins) => new Date(m(mins)).toISOString();
  state = {
    deliveredPrompts: [],
    items: [
      { id: "ny-00000000000000000001", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "ui-bois", askerId: "demo-ub-ld", asker: { id: "demo-ub-ld", title: "UI Bois · Lead 2", live: true }, ask: "Make Decision Desk the default Normal landing page?", decides: "Sets whether opening the app lands on Decision Desk or Project Overview", lean: "Yes, default landing + sidebar entry", alts: ["Sidebar entry only"], kind: "yesno", structured: true, ts: m(95) },
      { id: "ny-00000000000000000002", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "plugins", askerId: "demo-pl-ld", asker: { id: "demo-pl-ld", title: "Plugins · Lead 1", live: true }, ask: "Merge URL history cleanup into master now?", decides: "Ships U1+U2 Back/Forward fixes ahead of the next beta cut", lean: "Merge after green suite", alts: ["Hold for D4 bundle"], kind: "yesno", structured: true, ts: m(82) },
      { id: "ny-00000000000000000003", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "runner-pilot", askerId: "demo-rp-ld", asker: { id: "demo-rp-ld", title: "Runner Pilot · Lead 1", live: true }, ask: "Which default timeout (ms) should idle worker health checks use?", decides: "Controls when quiet workers flip to stalled in the sidebar", lean: "", alts: [], kind: "answer", structured: true, ts: m(74) },
      { id: "ny-00000000000000000004", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "art-direction", askerId: "demo-ad-ld", asker: { id: "demo-ad-ld", title: "Art Direction · Lead 1", live: true }, ask: "Sign and publish v1.14.2 beta to the desktop updater", decides: "Pushes the signed installer to beta testers", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(66) },
      { id: "ny-00000000000000000005", source: "log", squad: "efi", squadName: "Main Game Project", lane: "main-game", askerId: "demo-mg-ld", asker: { id: "demo-mg-ld", title: "Main Game · Lead 3", live: true }, ask: "Keep daily bounty resets at 00:00 UTC or align to server midnight?", decides: "Changes quest rollover timing for all players", lean: "Keep 00:00 UTC", alts: ["Align to server local midnight", "Rolling 24h per player"], kind: "yesno", structured: true, ts: m(58) },
      { id: "ny-00000000000000000006", source: "log", squad: "efi", squadName: "Main Game Project", lane: "ui-lab", askerId: "demo-ul-ld", asker: { id: "demo-ul-ld", title: "UI Lab · Lead 1", live: true }, ask: "Drop legacy parry buffer window from 180ms to 120ms?", decides: "Tightens parry timing across melee weapons", lean: "Drop to 120ms", alts: ["Try 150ms first"], kind: "yesno", structured: true, inferred: true, ts: m(49) },
      { id: "ny-00000000000000000007", source: "log", squad: "efi", squadName: "Main Game Project", lane: "main-game", askerId: "demo-w-ld", asker: { id: "demo-w-ld", title: "Main Game · Lead 2", live: true }, ask: "What max player cap should the harbor zone use for stress tests?", decides: "Sets the bot spawn count in the harbor benchmark", lean: "", alts: [], kind: "answer", structured: true, ts: m(41) },
      { id: "ny-00000000000000000008", source: "log", squad: "efi", squadName: "Main Game Project", lane: "ui-lab", askerId: "demo-a-ld", asker: { id: "demo-a-ld", title: "UI Lab · Lead 1", live: true }, ask: "Playtest the rain reverb mix on studio headphones", decides: "Unblocks final mastering of ambient weather stems", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(34) },
      { id: "ny-00000000000000000009", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-sp-ld", asker: { id: "demo-sp-ld", title: "Site Polish · Lead 1", live: true }, ask: "Switch sprite atlas packing from shelf to maxrects?", decides: "Cuts atlas VRAM by ~18% and regenerates sprite manifests", lean: "Switch to maxrects", alts: ["Keep shelf packer"], kind: "yesno", structured: true, sourceIds: ["ny-00000000000000000009", "ny-00000000000000000019"], groupSize: 2, ts: m(27) },
      { id: "ny-00000000000000000010", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-sp-ld2", asker: { id: "demo-sp-ld2", title: "Site Polish · Lead 2", live: true }, ask: "Allow non-power-of-two textures in dev builds?", decides: "Relaxes asset import validation outside release builds", lean: "Warn in dev, error in release", alts: ["Error everywhere"], kind: "yesno", structured: true, ts: m(19) },
      { id: "ny-00000000000000000011", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-ci-ld", asker: { id: "demo-ci-ld", title: "Site Polish · Lead 1", live: true }, ask: "Which artifact retention window (days) do we want for nightly builds?", decides: "Sets storage cleanup policy on the build bucket", lean: "", alts: [], kind: "answer", structured: true, ts: m(12) },
      { id: "ny-00000000000000000012", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-bi-ld", asker: { id: "demo-bi-ld", title: "Site Polish · Lead 1", live: true }, ask: "Approve the $20/mo build-cache storage upgrade", decides: "Increases remote cache quota for CI runners", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(6) },
    ],
    logs: {
      vibesquad: [
        { ts: iso(25), lane: "vibesquad", agent: "Overlord", type: "decision", text: "Decision Desk approved for Normal default landing", refs: [] },
        { ts: iso(18), lane: "plugins", agent: "Plugins · Lead 1", type: "done", text: "Merged U1+U2 URL history cleanup", refs: [] },
        { ts: iso(11), lane: "ui-bois", agent: "UI Bois · Lead 2", type: "done", text: "Shipped D2 owner-only decisions API", refs: [] },
      ],
      efi: [
        { ts: iso(30), lane: "efi", agent: "Overlord", type: "done", text: "Nightly build green on all zones", refs: [] },
        { ts: iso(14), lane: "main-game", agent: "Main Game · Lead 3", type: "done", text: "Bounty tracker refactor landed", refs: [] },
      ],
      site: [
        { ts: iso(22), lane: "site-polish", agent: "Site Polish · Lead 1", type: "decision", text: "Standardized PNG compression at level 6", refs: [] },
      ],
    },
  };
}

before(async () => {
  pw = resolvePlaywright({ npx: false });
  exe = findBrowser();
  const why = browserSkipReason({ pw, exe });
  if (why) { unavailable = why; return; }
  await ensureDist();
  mkdirSync(SHOTS_DIR, { recursive: true });
  resetBackend();
  const dist = path.join(REPO_ROOT, "dist");
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(u.pathname);
    if (pathname === "/__vibesquad/decisions" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, items: state.items, count: state.items.length, agentsOk: true, generatedAt: new Date().toISOString() }));
      return;
    }
    if (pathname === "/__vibesquad/decisions/answer" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const answers = Array.isArray(body.answers) ? body.answers : [];
        const results = [];
        for (const a of answers) {
          const item = state.items.find((i) => i.id === a.id);
          if (!item) { results.push({ id: a.id, choice: a.choice, status: "rejected", error: "unknown" }); continue; }
          state.deliveredPrompts.push({ id: a.id, askerId: item.askerId, squad: item.squad, lane: item.lane, choice: a.choice, text: a.text ?? "" });
          state.items = state.items.filter((i) => i.id !== a.id);
          (state.logs[item.squad] ??= []).push({
            ts: new Date().toISOString(),
            lane: item.lane,
            agent: item.asker?.title || "Lead",
            type: "done",
            text: `Answered: ${a.choice}${a.text ? ` (${a.text})` : ""}`,
            refs: [`decision:${a.id}`],
          });
          results.push({ id: a.id, choice: a.choice, status: a.choice === "dismiss" ? "dismissed" : "delivered", target: item.askerId, via: "asker", logged: true });
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, results }));
      });
      return;
    }
    if (pathname === "/__vibesquad/log" && req.method === "GET") {
      const team = u.searchParams.get("team") || "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.logs[team] ?? []));
      return;
    }
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
  cleanupShotsDir(SHOTS_DIR);
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

async function openDesk({ theme, width, height, dpr = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${baseUrl}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 20000 });
  await page.waitForTimeout(600);
  return { context, page, errs };
}

for (const cfg of [
  { name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1, fullDrive: true },
  { name: "light-1920", theme: "light", width: 1920, height: 1080, dpr: 1, fullDrive: false },
  { name: "dark-3200", theme: "dark", width: 3200, height: 1800, dpr: 1.2, fullDrive: false },
  { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2, fullDrive: false },
]) {
  test(`D4 Done-check 5 (${cfg.name}): Decision Desk renders cleanly and passes drive`, async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    resetBackend();
    const { context, page, errs } = await openDesk(cfg);
    try {
      // 1. Default landing + sidebar badge + URL agreement
      assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), "decisions", "default landing sets ?view=decisions");
      assert.deepEqual(await page.evaluate(() => window.__urls.filter((u) => new URLSearchParams(u).get("team"))), [], "m3: landing never writes ?team= before the Desk");
      assert.equal(await page.locator('[data-testid="boring-decisions-nav-count"]').textContent(), "· 12");
      assert.equal(await page.locator('[data-testid="boring-decision-summary"]').textContent(), "12 open · 9 here · 3 off-screen");

      // 2. Live status strip: every lane line visible without leaving the page
      const stripLines = await page.locator('[data-testid="boring-decision-strip"] .boring-decision-strip-line').count();
      assert.ok(stripLines >= 3, `status strip shows all lanes (found ${stripLines})`);
      assert.equal(await page.locator('[data-testid="boring-decision-inferred-ny-00000000000000000006"]').textContent(), "inferred");
      assert.equal(await page.locator('[data-testid="boring-decision-grouped-ny-00000000000000000009"]').textContent(), "×2 grouped");
      assert.equal(await page.locator('[data-testid="boring-decision-offscreen"] .boring-decision-offscreen-row').count(), 3);

      // Capture viewport screenshot for UX review
      await page.screenshot({ path: path.join(SHOTS_DIR, `${cfg.name}.png`), fullPage: false });

      if (cfg.fullDrive) {
        // 3a. M1 explicit opt-in: untouched leans are dashed suggestions, not pressed, and the bar says what is not included.
        const lean1 = page.locator('[data-testid="boring-decision-lean-ny-00000000000000000001"]');
        assert.equal(await lean1.getAttribute("aria-pressed"), "false", "unstaged lean is not pressed");
        assert.ok(!(await lean1.getAttribute("class")).includes("selected"), "unstaged lean is not selected");
        assert.equal(await lean1.evaluate((el) => getComputedStyle(el).borderTopStyle), "dashed", "unstaged lean has a dashed border");
        assert.match(await lean1.textContent(), /Lean/, "LEAN tag stays");
        assert.equal(await page.locator('[data-testid="boring-decision-send-btn"]').isDisabled(), true, "Send 0 answers while nothing is staged");
        assert.match(await page.locator(".boring-decision-bar-status").textContent(), /6 leans not included/);
        assert.equal(await page.locator('[data-testid="boring-decision-stage-leans"]').textContent(), "Use all leans (6)");
        await lean1.click();
        assert.equal(await lean1.getAttribute("aria-pressed"), "true", "tapped lean is pressed");
        await lean1.click();
        assert.equal(await lean1.getAttribute("aria-pressed"), "false", "tapping again unstages it");

        // 3. Flip 2 leans + answer 1 -> Send 3 answers
        await page.locator('[data-testid="boring-decision-not-ny-00000000000000000001"]').click();
        await page.locator('[data-testid="boring-decision-alt-ny-00000000000000000002-0"]').click();
        await page.locator('[data-testid="boring-decision-input-ny-00000000000000000003"]').fill("45000");

        const sendBtn = page.locator('[data-testid="boring-decision-send-btn"]');
        assert.equal(await sendBtn.textContent(), "Send 3 answers");
        assert.match(await page.locator(".boring-decision-bar-status").textContent(), /3 ready to send · 4 leans not included/);

        // Verify 5s Undo cancels before dispatch
        await sendBtn.click();
        await page.waitForSelector('[data-testid="boring-decision-undo-btn"]', { timeout: 2000 });
        assert.match(await page.locator('[data-testid="boring-decision-undo-msg"]').textContent(), /Sending 3 answers in \ds/);
        await page.locator('[data-testid="boring-decision-undo-btn"]').click();
        assert.equal(state.deliveredPrompts.length, 0, "Undo prevented any dispatch");

        // Now send and let the 5s Undo window complete naturally
        await sendBtn.click();
        await page.waitForSelector('[data-testid="boring-decision-undo-msg"]', { timeout: 2000 });
        await page.waitForTimeout(5600);

        // Verify 3 asker prompts landed + feed and sidebar badge updated
        assert.equal(state.deliveredPrompts.length, 3, "3 asker prompts landed");
        assert.deepEqual(
          state.deliveredPrompts.map((p) => [p.id, p.choice, p.text]),
          [
            ["ny-00000000000000000001", "not", ""],
            ["ny-00000000000000000002", "alt:0", ""],
            ["ny-00000000000000000003", "reply", "45000"],
          ],
        );
        assert.equal(await page.locator('[data-testid="boring-decisions-nav-count"]').textContent(), "· 9");
        assert.equal(await page.locator('[data-testid="boring-decision-summary"]').textContent(), "9 open · 6 here · 3 off-screen");
        const stripText = await page.locator('[data-testid="boring-decision-strip"]').textContent();
        assert.match(stripText, /Answered: alt:0/, "status strip updated with latest lane event");

        // 4. Back/Forward/reload with ?view=decisions
        await page.evaluate(() => window.__h.splice(0));
        await page.locator('.boring-sidebar .boring-project-row', { hasText: "VibeSquad" }).first().click();
        await page.waitForSelector('[data-testid="boring-project-view"]', { timeout: 5000 });
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("team")), "vibesquad");
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), null);

        await page.evaluate(() => window.__h.splice(0));
        await page.goBack();
        await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 5000 });
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), "decisions");
        assert.equal(await page.evaluate(() => window.__h.filter((k) => k === "pushState").length), 0, "Back pushed nothing");

        await page.evaluate(() => window.__h.splice(0));
        await page.goForward();
        await page.waitForSelector('[data-testid="boring-project-view"]', { timeout: 5000 });
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("team")), "vibesquad");
        assert.equal(await page.evaluate(() => window.__h.filter((k) => k === "pushState").length), 0, "Forward pushed nothing");

        await page.locator('[data-testid="boring-decisions-nav"]').click();
        await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 5000 });
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), "decisions");

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 20000 });
        await page.waitForTimeout(500);
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), "decisions");
        assert.equal(await page.locator('[data-testid="boring-decisions-nav-count"]').textContent(), "· 9");
      }

      assert.deepEqual(errs, [], `zero pageerrors: ${errs.join("; ")}`);
    } finally {
      await context.close();
    }
  });
}

test("D4 UX R37 M2: with 20+ lanes the strip folds quiet lanes and a decision card stays above the fold at 1920x1080", async (t) => {
  if (unavailable) { t.skip(unavailable); return; }
  resetBackend();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "dark" });
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"dark"})); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  try {
    await page.goto(`${baseUrl}/?demo=&lanes=24`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 20000 });
    await page.waitForTimeout(800);
    const quietBtn = page.locator('[data-testid^="boring-decision-strip-quiet-"]').first();
    assert.ok(await quietBtn.count(), "a +N quiet fold exists");
    const m = /^\+(\d+) quiet$/.exec((await quietBtn.textContent()).trim());
    assert.ok(m && Number(m[1]) >= 20, `at least 20 idle lanes are folded (got ${m?.[0]})`);
    const geo = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="boring-decision-strip"]').getBoundingClientRect();
      const bar = document.querySelector('[data-testid="boring-decision-bar"]').getBoundingClientRect();
      const cards = [...document.querySelectorAll(".boring-decision-card")].map((c) => c.getBoundingClientRect());
      return { stripBottom: strip.bottom, barTop: bar.top, innerHeight, above: cards.filter((r) => r.top >= 0 && r.bottom <= bar.top).length };
    });
    assert.ok(geo.stripBottom < geo.innerHeight, `strip bottom ${geo.stripBottom} is above innerHeight ${geo.innerHeight}`);
    assert.ok(geo.above >= 1, `at least 1 decision card above the fold (got ${geo.above})`);
    await page.screenshot({ path: path.join(SHOTS_DIR, "lanes-24-1920.png"), fullPage: false });
    const before = await page.locator('[data-testid="boring-decision-strip"] .boring-decision-strip-line').count();
    await quietBtn.click();
    const after = await page.locator('[data-testid="boring-decision-strip"] .boring-decision-strip-line').count();
    assert.ok(after >= before + 20, `expanding shows the folded lanes (${before} -> ${after})`);
    assert.equal(await quietBtn.getAttribute("aria-expanded"), "true");
    assert.deepEqual(errs, [], `zero pageerrors: ${errs.join("; ")}`);
  } finally {
    await context.close();
  }
});

test("D4 UX R37 M2: at 3200 wide the strip sits in a right rail beside the feed", async (t) => {
  if (unavailable) { t.skip(unavailable); return; }
  resetBackend();
  const { context, page } = await openDesk({ theme: "dark", width: 3200, height: 1800, dpr: 1 });
  try {
    const g = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="boring-decision-strip"]').getBoundingClientRect();
      const feed = document.querySelector('[data-testid="boring-decision-feed"]').getBoundingClientRect();
      const w = document.querySelector(".boring-decision-wrap"), d = document.querySelector(".boring-decision-desk");
      return { stripLeft: strip.left, feedRight: feed.right, stripTop: strip.top, feedTop: feed.top, wrapW: w.clientWidth, cont: getComputedStyle(w).containerType, disp: getComputedStyle(d).display, deskW: d.clientWidth };
    });
    assert.ok(g.stripLeft >= g.feedRight, `strip is right of the feed ${JSON.stringify(g)}`);
    assert.ok(Math.abs(g.stripTop - g.feedTop) < 40, "strip and feed start at the same height");
  } finally {
    await context.close();
  }
});

test("D4 r3 (R38 m1): a fresh ?view=decisions load never writes ?team= (no flash) and replaces, never pushes", async (t) => {
  if (unavailable) { t.skip(unavailable); return; }
  resetBackend();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "dark" });
  await context.addInitScript(HISTORY_WRAP);
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  try {
    await page.goto(`${baseUrl}/?demo=&view=decisions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 20000 });
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => ({ url: location.search, urls: window.__urls, h: window.__h }));
    assert.equal(new URLSearchParams(s.url).get("view"), "decisions");
    assert.deepEqual(s.urls.filter((u) => new URLSearchParams(u).get("team")), [], `m1: no ?team= write on load :: ${s.urls.join(" | ")}`);
    assert.equal(s.h.filter((k) => k === "pushState").length, 0, "load pushed nothing");
    assert.deepEqual(errs, []);
  } finally {
    await context.close();
  }
});

test("D4 r3 (Review-Gemini MEDIUM): bare load, then Back to a non-canonical ?team= entry before any input is still canonicalized (replace)", async (t) => {
  if (unavailable) { t.skip(unavailable); return; }
  resetBackend();
  const { context, page, errs } = await openDesk({ theme: "dark", width: 1920, height: 1080 });
  try {
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), "decisions", "bare load landed on the Desk");
    // No pointerdown/keydown anywhere: the load's landing (popActive) is still on. Build [?team=…&tab=bogus, ?view=decisions] and Back.
    await page.evaluate(() => {
      history.pushState(null, "", "?demo=&team=vibesquad&tab=bogus");
      history.pushState(null, "", "?demo=&view=decisions");
      window.__h.splice(0);
      window.__urls.splice(0);
    });
    await page.evaluate(() => history.back());
    await page.waitForSelector('[data-testid="boring-project-view"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => ({ url: location.search, h: window.__h, len: history.length }));
    assert.equal(s.url, "?demo=&team=vibesquad", `popped ?team= entry canonicalized :: ${s.h.join(" | ")}`);
    assert.ok(s.h.includes("replaceState"), `healed with replaceState :: ${s.h.join(" | ")}`);
    assert.equal(s.h.filter((k) => k === "pushState").length, 0, `the pop pushed nothing :: ${s.h.join(" | ")}`);
    // Forward still reaches the Desk entry (not wiped by a push).
    await page.evaluate(() => history.forward());
    await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 5000 });
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("view")), "decisions");
    assert.deepEqual(errs, []);
  } finally {
    await context.close();
  }
});

test("D4 r3 (R38 m3): the status strip lists Squads in the same order as the feed", async (t) => {
  if (unavailable) { t.skip(unavailable); return; }
  resetBackend();
  // Make Site's ask the oldest so the feed order differs from the views order.
  state.items = state.items.map((i) => (i.squad === "site" ? { ...i, ts: i.ts - 3 * 3600_000 } : i));
  const { context, page, errs } = await openDesk({ theme: "dark", width: 1920, height: 1080 });
  try {
    const o = await page.evaluate(() => ({
      strip: [...document.querySelectorAll('[data-testid^="boring-decision-strip-squad-"]')].map((e) => e.getAttribute("data-testid").replace("boring-decision-strip-squad-", "").toLowerCase()),
      feed: [...document.querySelectorAll(".boring-decision-squad-group")].map((e) => e.getAttribute("data-testid").replace("boring-decision-squad-", "").toLowerCase()),
    }));
    assert.equal(o.feed[0], "site", `feed starts with the oldest ask's Squad :: ${o.feed.join(",")}`);
    assert.deepEqual(o.strip.filter((s) => o.feed.includes(s)), o.feed, `strip order ${o.strip.join(",")} follows feed ${o.feed.join(",")}`);
    assert.deepEqual(o.strip.slice(0, o.feed.length), o.feed, "feed Squads come first in the strip");
    assert.deepEqual(errs, []);
  } finally {
    await context.close();
  }
});

for (const cfg of [
  { name: "p2-dark-1600-lanes24", theme: "dark", width: 1600, height: 900, dpr: 1, wide: false },
  { name: "p2-light-1600-lanes24", theme: "light", width: 1600, height: 900, dpr: 1, wide: false },
  { name: "p2-dark-1920-lanes24", theme: "dark", width: 1920, height: 1080, dpr: 1, wide: true, check1920Events: true },
  { name: "p2-light-1920-lanes24", theme: "light", width: 1920, height: 1080, dpr: 1, wide: true, check1920Events: true },
  { name: "p2-dark-3200-lanes24", theme: "dark", width: 3200, height: 1800, dpr: 1.2, wide: true, checkWideRail: true },
  { name: "p2-light-3200-lanes24", theme: "light", width: 3200, height: 1800, dpr: 1.2, wide: true, checkWideRail: true },
]) {
  test(`D4 P2 (${cfg.name}): rail grows at 3200@1.2 and stacked <1900 puts feed above scroll-capped strip (?lanes=24)`, async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    resetBackend();
    const context = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, deviceScaleFactor: cfg.dpr, colorScheme: cfg.theme });
    await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${cfg.theme}"})); }catch{}`);
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    try {
      await page.goto(`${baseUrl}/?demo=&lanes=24`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="boring-decision-desk"]', { timeout: 20000 });
      await page.waitForTimeout(700);

      const g = await page.evaluate(() => {
        const desk = document.querySelector('[data-testid="boring-decision-desk"]');
        const feedEl = document.querySelector('[data-testid="boring-decision-feed"]');
        const offEl = document.querySelector('[data-testid="boring-decision-offscreen"]');
        const stripEl = document.querySelector('[data-testid="boring-decision-strip"]');
        const fadeEl = document.querySelector('[data-testid="boring-decision-strip-fade"]');
        const squadBtn = stripEl.querySelector(".boring-decision-strip-squad-btn");
        const feed = feedEl.getBoundingClientRect();
        const off = offEl.getBoundingClientRect();
        const strip = stripEl.getBoundingClientRect();
        const fade = fadeEl ? fadeEl.getBoundingClientRect() : { height: 0 };
        const bar = document.querySelector('[data-testid="boring-decision-bar"]').getBoundingClientRect();
        const cards = [...document.querySelectorAll(".boring-decision-card")].map((c) => c.getBoundingClientRect());
        const eventSpans = [...document.querySelectorAll(".boring-decision-strip-event > span:last-child")].map((el) => ({
          text: el.textContent || "",
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        }));
        const focusables = [...desk.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')];
        const sectionOrder = focusables.map((el) =>
          feedEl.contains(el) ? "feed" : offEl.contains(el) ? "offscreen" : stripEl.contains(el) ? "strip" : null,
        ).filter(Boolean);
        return {
          isWide: desk.classList.contains("is-wide"),
          domOrderOk: Boolean(feedEl.compareDocumentPosition(offEl) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(offEl.compareDocumentPosition(stripEl) & Node.DOCUMENT_POSITION_FOLLOWING),
          tabOrder: {
            lastFeed: sectionOrder.lastIndexOf("feed"),
            firstOff: sectionOrder.indexOf("offscreen"),
            lastOff: sectionOrder.lastIndexOf("offscreen"),
            firstStrip: sectionOrder.indexOf("strip"),
          },
          feed: { top: feed.top, bottom: feed.bottom, left: feed.left, right: feed.right, width: feed.width },
          off: { top: off.top, bottom: off.bottom, left: off.left, right: off.right, width: off.width },
          strip: {
            top: strip.top,
            bottom: strip.bottom,
            left: strip.left,
            right: strip.right,
            width: strip.width,
            height: strip.height,
            scrollHeight: stripEl.scrollHeight,
            clientHeight: stripEl.clientHeight,
            overflowY: getComputedStyle(stripEl).overflowY,
            hasScrollMore: stripEl.classList.contains("has-scroll-more"),
            scrollMoreAttr: stripEl.getAttribute("data-scroll-more"),
          },
          fade: { present: Boolean(fadeEl), display: fadeEl ? getComputedStyle(fadeEl).display : "none", height: fade.height },
          cols: [...document.querySelectorAll(".boring-decision-strip-line")].map((l) => {
            const st = l.querySelector(".boring-decision-strip-state").getBoundingClientRect().left;
            const ev = l.querySelector(".boring-decision-strip-event").getBoundingClientRect().left;
            return { st, ev };
          }),
          widths: [...document.querySelector(".boring-decision-strip-line").children].map((c) => Math.round(c.getBoundingClientRect().width)),
          dots: [...document.querySelectorAll(".boring-decision-strip-line")].map((l) => ({
            gap: l.querySelector(".boring-decision-strip-lane-name").getBoundingClientRect().left - l.querySelector(".boring-decision-dot").getBoundingClientRect().right,
            h: l.getBoundingClientRect().height,
            dbg: [l.getBoundingClientRect().height, ...[...l.children].map((c) => Math.round(c.getBoundingClientRect().height))].join("/"),
            codeWrap: (() => { const c = l.querySelector(".boring-decision-code"); return c ? c.getBoundingClientRect().height > 22 : false; })(),
          })),
          eventTrunc: [...document.querySelectorAll(".boring-decision-strip-event > span:last-child")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
          squadHeadPosition: getComputedStyle(squadBtn).position,
          barTop: bar.top,
          innerHeight,
          cardsAbove: cards.filter((r) => r.top >= 0 && r.bottom <= bar.top).length,
          eventSpans,
        };
      });

      assert.equal(g.isWide, cfg.wide, `is-wide class matches viewport (${cfg.width})`);
      assert.equal(g.domOrderOk, true, "P2b m1: DOM order is feed -> off-screen -> strip");
      assert.ok(
        g.tabOrder.lastFeed >= 0 && g.tabOrder.lastFeed < g.tabOrder.firstOff && g.tabOrder.lastOff < g.tabOrder.firstStrip,
        `P2b m1: Tab focus order is feed -> off-screen -> strip (${JSON.stringify(g.tabOrder)})`,
      );
      assert.ok(g.cardsAbove >= 1, `at least 1 decision card sits above the send bar (got ${g.cardsAbove})`);

      if (cfg.wide) {
        assert.ok(g.strip.left >= g.feed.right, `wide rail sits right of feed (${JSON.stringify(g)})`);
        assert.ok(Math.abs(g.strip.top - g.feed.top) < 40, "wide rail aligns with top of feed");
        assert.equal(g.fade.present, false, "P2b r2 L1: no strip fade element in wide mode");
        {
          const gaps = g.dots.map((d) => d.gap), hs = g.dots.map((d) => d.h);
          assert.ok(Math.min(...gaps) >= 0, `P2b r3: status dot never overlaps lane name (min gap ${Math.min(...gaps)})`);
          assert.ok(Math.max(...hs) - Math.min(...hs) <= 1, `P2b r3: rail lines uniform height (${Math.min(...hs)}..${Math.max(...hs)}) ${JSON.stringify(g.dots.map((d) => d.dbg))}`);
          assert.ok(g.dots.every((d) => !d.codeWrap), "P2b r3: code chips do not wrap");
          console.log(`P2b r3 ${cfg.name}: minDotNameGap=${Math.min(...gaps)} lineH=${Math.min(...hs)}..${Math.max(...hs)}`);
        }
        {
          const stL = g.cols.map((c) => c.st), evL = g.cols.map((c) => c.ev);
          assert.ok(g.cols.length >= 10, `rail has many lines (${g.cols.length})`);
          assert.ok(Math.max(...stL) - Math.min(...stL) <= 1, `P2b r2 m1: state column left edges equal (spread ${Math.max(...stL) - Math.min(...stL)})`);
          assert.ok(Math.max(...evL) - Math.min(...evL) <= 1, `P2b r2 m1: event column left edges equal (spread ${Math.max(...evL) - Math.min(...evL)})`);
          console.log(`P2b r2 ${cfg.name}: lines=${g.cols.length} stateSpread=${Math.max(...stL) - Math.min(...stL)} eventSpread=${Math.max(...evL) - Math.min(...evL)} state@${stL[0]} event@${evL[0]} truncated=${g.eventTrunc.length} widths=${g.widths}`);
        }
        if (cfg.checkWideRail) {
          const q = page.locator('[data-testid^="boring-decision-strip-quiet-"]').first();
          if (await q.count()) {
            await q.click();
            await page.waitForTimeout(150);
            const t2 = await page.evaluate(() => {
              const ls = [...document.querySelectorAll(".boring-decision-strip-line")];
              const st = ls.map((l) => l.querySelector(".boring-decision-strip-state").getBoundingClientRect().left);
              const ev = ls.map((l) => l.querySelector(".boring-decision-strip-event").getBoundingClientRect().left);
              const tr = [...document.querySelectorAll(".boring-decision-strip-event > span:last-child")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent);
              return { n: ls.length, st: Math.max(...st) - Math.min(...st), ev: Math.max(...ev) - Math.min(...ev), tr };
            });
            console.log(`P2b r2 ${cfg.name} quiet open: ${JSON.stringify({ n: t2.n, st: t2.st, ev: t2.ev, trunc: t2.tr.length })}`);
            assert.ok(t2.st <= 1 && t2.ev <= 1, `columns aligned with quiet fold open (${JSON.stringify(t2)})`);
            assert.deepEqual(t2.tr, [], "0 event texts truncated at 3200 with quiet fold open");
          }
        }
        if (cfg.check1920Events) {
          const r39Named = [
            "Decision Desk approved",
            "Merged U1+U2",
            "Shipped D2 owner-only",
            "Standardized PNG compression",
          ];
          for (const needle of r39Named) {
            const ev = g.eventSpans.find((e) => e.text.includes(needle));
            assert.ok(ev, `P2b m3: expected R39 event line containing "${needle}"`);
            assert.ok(ev.scrollW <= ev.clientW + 1, `P2b m3: event text "${ev.text}" should not truncate at 1920 (scrollW=${ev.scrollW}, clientW=${ev.clientW})`);
          }
        }
        if (cfg.checkWideRail) {
          assert.ok(g.strip.width > 580, `m2: rail width at 3200@1.2 must exceed 580px (got ${g.strip.width})`);
          assert.ok(g.feed.width >= 600 && g.feed.width <= 1200, `m2: feed keeps a readable measure (got ${g.feed.width})`);
          const tracked = g.eventSpans.filter((e) => e.text.includes("Nightly build green") || e.text.includes("Standardized PNG compression"));
          assert.ok(tracked.length >= 2, "expected demo event lines present");
          for (const ev of tracked) {
            assert.ok(ev.scrollW <= ev.clientW + 1, `m2: event text "${ev.text}" should not truncate at 3200 (scrollW=${ev.scrollW}, clientW=${ev.clientW})`);
          }
        }
      } else {
        const cap = Math.min(320, Math.round(g.innerHeight * 0.35)) + 2;
        assert.ok(g.feed.bottom <= g.off.top + 1, `P2b m1: feed precedes off-screen in stacked layout (feed.bottom=${g.feed.bottom}, off.top=${g.off.top})`);
        assert.ok(g.off.bottom <= g.strip.top + 1, `P2b m1: off-screen precedes strip in stacked layout (off.bottom=${g.off.bottom}, strip.top=${g.strip.top})`);
        assert.ok(g.strip.height <= cap, `m4: stacked strip height ${g.strip.height} <= cap ${cap}`);
        assert.equal(g.strip.overflowY, "auto", "m4: stacked strip scrolls vertically");
        assert.equal(g.squadHeadPosition, "sticky", "P2b m2: stacked strip Squad heads are sticky");
        if (g.strip.scrollHeight > g.strip.clientHeight + 2) {
          assert.equal(g.strip.hasScrollMore, true, "P2b m2: overflowing stacked strip marks has-scroll-more");
          assert.equal(g.strip.scrollMoreAttr, "true", "P2b m2: overflowing stacked strip sets data-scroll-more");
          assert.notEqual(g.fade.display, "none", "P2b m2: bottom fade cue is visible when strip overflows");
          assert.ok(g.fade.height >= 20, `P2b m2: bottom fade cue has visible height (got ${g.fade.height})`);
        }
        // Expanding the +N quiet fold keeps the strip within its cap and scrollable with the scroll cue active.
        // P2b r2 M1: content growth without a group-count change refreshes the cue with no scroll/resize event.
        const cueGrow = await page.evaluate(async () => {
          const stripEl = document.querySelector('[data-testid="boring-decision-strip"]');
          stripEl.scrollTop = stripEl.scrollHeight;
          stripEl.dispatchEvent(new Event("scroll"));
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const before = stripEl.classList.contains("has-scroll-more");
          const filler = document.createElement("div");
          filler.style.height = "400px";
          stripEl.querySelector(".boring-decision-strip-groups").appendChild(filler);
          await new Promise((r) => setTimeout(r, 200));
          const after = stripEl.classList.contains("has-scroll-more");
          filler.remove();
          return { before, after };
        });
        assert.equal(cueGrow.before, false, "cue clear at bottom before content grows");
        assert.equal(cueGrow.after, true, "P2b r2 M1: cue refreshes when inner content grows (no scroll/resize)");
        await page.evaluate(() => { const s = document.querySelector('[data-testid="boring-decision-strip"]'); s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); });
        const quietBtn = page.locator('[data-testid^="boring-decision-strip-quiet-"]').first();
        assert.ok(await quietBtn.count(), "quiet fold button present with ?lanes=24");
        await quietBtn.click();
        await page.waitForTimeout(150);
        const expanded = await page.evaluate(() => {
          const stripEl = document.querySelector('[data-testid="boring-decision-strip"]');
          const fadeEl = document.querySelector('[data-testid="boring-decision-strip-fade"]');
          const r = stripEl.getBoundingClientRect();
          return {
            height: r.height,
            scrollHeight: stripEl.scrollHeight,
            clientHeight: stripEl.clientHeight,
            hasScrollMore: stripEl.classList.contains("has-scroll-more"),
            fadeDisplay: getComputedStyle(fadeEl).display,
          };
        });
        assert.ok(expanded.height <= cap, `m4: expanded stacked strip height ${expanded.height} stays <= cap ${cap}`);
        assert.ok(expanded.scrollHeight > expanded.clientHeight, `m4: expanded stacked strip overflows inside its scroll box (${expanded.scrollHeight} > ${expanded.clientHeight})`);
        assert.equal(expanded.hasScrollMore, true, "P2b m2: expanded overflowing strip shows scroll cue");
        assert.notEqual(expanded.fadeDisplay, "none", "P2b m2: fade cue visible when expanded strip overflows");
        // Scrolling to the bottom clears the scroll cue so the final line is unobstructed.
        const atBottom = await page.evaluate(async () => {
          const stripEl = document.querySelector('[data-testid="boring-decision-strip"]');
          stripEl.scrollTop = stripEl.scrollHeight;
          stripEl.dispatchEvent(new Event("scroll"));
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const fadeEl = document.querySelector('[data-testid="boring-decision-strip-fade"]');
          return { hasScrollMore: stripEl.classList.contains("has-scroll-more"), fadeDisplay: getComputedStyle(fadeEl).display };
        });
        assert.equal(atBottom.hasScrollMore, false, "P2b m2: scroll cue clears at bottom of strip");
        assert.equal(atBottom.fadeDisplay, "none", "P2b m2: fade hides at bottom of strip");
      }

      await page.screenshot({ path: path.join(SHOTS_DIR, `${cfg.name}.png`), fullPage: false });
      assert.deepEqual(errs, [], `zero pageerrors: ${errs.join("; ")}`);
    } finally {
      await context.close();
    }
  });
}
