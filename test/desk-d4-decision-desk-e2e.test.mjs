// @desk D4 e2e (docs/PLAN_DESK_DECISION_DESK.md Done-check 5):
// Drives the built app in Playwright across dark/light at 1920x1080 and 3200x1800@1.2 on a 12-item
// 3-Squad demo: verifies live status strip, flipping 2 leans + answering 1 + 5s Undo + Send 3 answers,
// asker prompt delivery, strip + feed + sidebar badge updates, and ?view=decisions Back/Forward/reload.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const SHOTS_DIR = path.join(REPO_ROOT, "docs", "shots", "desk-d4");
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
  pw = resolvePlaywright();
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
