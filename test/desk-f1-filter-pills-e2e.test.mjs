// @desk F1 e2e (docs/PLAN_DESK_DD_FILTER.md Done-check):
// Drives the built app in Playwright at 1920x1080 and 3200x1800@1.2, dark and light,
// on a 5-project demo (3 awake, 2 in an asleep Backlog folder).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const SHOTS_DIR = path.join(REPO_ROOT, "docs", "shots", "desk-f1");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

const FOLDERS = [{ name: "Backlog", asleep: true }];
const TEAMS = [
  { id: "vibesquad", name: "VibeSquad", color: "#58a6ff", paths: [], lanes: [{ id: "vibesquad", name: "Hub", hub: true }, { id: "desk", name: "Desk", code: "desk" }] },
  { id: "efi", name: "Main Game Project", color: "#a371f7", paths: [], lanes: [{ id: "efi", name: "Hub", hub: true }, { id: "quests", name: "Quests", code: "qst" }] },
  { id: "site", name: "Site", color: "#3fb950", paths: [], lanes: [{ id: "site", name: "Hub", hub: true }, { id: "polish", name: "Polish", code: "pol" }] },
  { id: "forework", name: "Forework", color: "#d29922", folder: "Backlog", paths: [], lanes: [{ id: "forework", name: "Hub", hub: true }, { id: "core", name: "Core", code: "cor" }] },
  { id: "sbb", name: "SBB", color: "#f85149", folder: "Backlog", paths: [], lanes: [{ id: "sbb", name: "Hub", hub: true }, { id: "net", name: "Net", code: "net" }] },
];

let state;
function resetBackend() {
  const now = Date.now();
  const m = (mins) => now - mins * 60_000;
  const iso = (mins) => new Date(m(mins)).toISOString();
  state = {
    items: [
      { id: "ny-f1-01", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "a-vs-1", asker: { id: "a-vs-1", title: "Desk · Lead 2", live: true }, ask: "Ship project filter pills on Decision Desk?", decides: "Adds Awake/All presets and per-project toggles", lean: "Yes, ship F1", alts: ["Hold"], kind: "yesno", structured: true, ts: m(90) },
      { id: "ny-f1-02", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "a-vs-2", asker: { id: "a-vs-2", title: "Desk · Lead 2", live: true }, ask: "Publish v1.15.0 beta build", decides: "Pushes installer to testers", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(80) },
      { id: "ny-f1-03", source: "log", squad: "efi", squadName: "Main Game Project", lane: "quests", askerId: "a-efi-1", asker: { id: "a-efi-1", title: "Quests · Lead 1", live: true }, ask: "Keep daily bounty resets at 00:00 UTC?", decides: "Quest rollover time", lean: "Keep 00:00 UTC", alts: ["Local midnight"], kind: "yesno", structured: true, ts: m(70) },
      { id: "ny-f1-04", source: "log", squad: "site", squadName: "Site", lane: "polish", askerId: "a-site-1", asker: { id: "a-site-1", title: "Polish · Lead 1", live: true }, ask: "Which CDN cache TTL (seconds) for hero images?", decides: "Asset freshness on landing page", lean: "", alts: [], kind: "answer", structured: true, ts: m(60) },
      { id: "ny-f1-05", source: "log", squad: "forework", squadName: "Forework", lane: "core", askerId: "a-fw-1", asker: { id: "a-fw-1", title: "Core · Lead 1", live: true }, ask: "Archive Forework prototype branches?", decides: "Cleans up dormant branches", lean: "Archive", alts: ["Keep"], kind: "yesno", structured: true, ts: m(50) },
      { id: "ny-f1-06", source: "log", squad: "forework", squadName: "Forework", lane: "core", askerId: "a-fw-2", asker: { id: "a-fw-2", title: "Core · Lead 1", live: true }, ask: "Renew Forework staging domain", decides: "Keeps staging URL active", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(40) },
      { id: "ny-f1-07", source: "log", squad: "sbb", squadName: "SBB", lane: "net", askerId: "a-sbb-1", asker: { id: "a-sbb-1", title: "Net · Lead 1", live: true }, ask: "Switch SBB relay to QUIC transport?", decides: "Relay protocol for dormant prototype", lean: "Defer", alts: ["Try QUIC"], kind: "yesno", structured: true, ts: m(30) },
    ],
    logs: {
      vibesquad: [{ ts: iso(15), lane: "desk", agent: "Desk · Lead 2", type: "done", text: "Decision Desk F1 ready", refs: [] }],
      efi: [{ ts: iso(20), lane: "quests", agent: "Quests · Lead 1", type: "done", text: "Bounty tracker updated", refs: [] }],
      site: [{ ts: iso(25), lane: "polish", agent: "Polish · Lead 1", type: "decision", text: "Compressed hero assets", refs: [] }],
      forework: [{ ts: iso(35), lane: "core", agent: "Core · Lead 1", type: "done", text: "Prototype frozen for Backlog", refs: [] }],
      sbb: [{ ts: iso(45), lane: "net", agent: "Net · Lead 1", type: "done", text: "Paused relay benchmark", refs: [] }],
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
    if (pathname === "/api/teams" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ teams: TEAMS, folders: FOLDERS, revision: "f1-demo" }));
      return;
    }
    if (pathname === "/__vibesquad/decisions" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, items: state.items, count: state.items.length, agentsOk: true, generatedAt: new Date().toISOString() }));
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
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${baseUrl}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="boring-decision-pills-on-hold"]', { timeout: 20000 });
  await page.waitForTimeout(400);
  return { context, page, errs };
}

for (const cfg of [
  { name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1, fullDrive: true },
  { name: "light-1920", theme: "light", width: 1920, height: 1080, dpr: 1, fullDrive: false },
  { name: "dark-3200", theme: "dark", width: 3200, height: 1800, dpr: 1.2, fullDrive: false },
  { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2, fullDrive: false },
]) {
  test(`F1 Done-check (${cfg.name}): 5-project demo (2 asleep) filter pills`, async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    resetBackend();
    const { context, page, errs } = await openDesk(cfg);
    try {
      // 1. Asleep pills are dimmed and OFF; their items are absent from all 3 sections
      for (const id of ["forework", "sbb"]) {
        const pill = page.locator(`[data-testid="boring-decision-pills-on-hold"] [data-testid="boring-decision-pill-${id}"]`);
        assert.equal(await pill.count(), 1, `${id} sits in On hold group`);
        assert.equal(await pill.getAttribute("aria-pressed"), "false", `${id} defaults OFF`);
        assert.equal(await pill.evaluate((el) => getComputedStyle(el).borderTopStyle), "dashed", `${id} is dimmed/dashed when OFF`);
      }
      for (const id of ["vibesquad", "efi", "site"]) {
        assert.equal(await page.locator(`[data-testid="boring-decision-pill-${id}"]`).getAttribute("aria-pressed"), "true", `${id} defaults ON`);
      }
      assert.equal(await page.locator('[data-testid="boring-decision-squad-forework"]').count(), 0, "forework absent from feed");
      assert.equal(await page.locator('[data-testid="boring-decision-squad-sbb"]').count(), 0, "sbb absent from feed");
      assert.equal(await page.locator('[data-testid="boring-decision-offscreen-ny-f1-06"]').count(), 0, "forework absent from off-screen strip");
      assert.equal(await page.locator('[data-testid="boring-decision-strip-squad-forework"]').count(), 0, "forework absent from status rail");
      assert.equal(await page.locator('[data-testid="boring-decision-strip-squad-sbb"]').count(), 0, "sbb absent from status rail");
      assert.equal(await page.locator('[data-testid="boring-decision-summary"]').textContent(), "4 open · 3 here · 1 off-screen");

      // Capture viewport screenshot at the needed size only
      await page.screenshot({ path: path.join(SHOTS_DIR, `${cfg.name}.png`), fullPage: false });

      if (cfg.fullDrive) {
        // 2. Toggle 3 projects (site OFF, forework ON, sbb ON -> visible = vibesquad, efi, forework, sbb) and reload
        await page.locator('[data-testid="boring-decision-pill-site"]').click();
        await page.locator('[data-testid="boring-decision-pill-forework"]').click();
        await page.locator('[data-testid="boring-decision-pill-sbb"]').click();
        assert.equal(await page.locator('[data-testid="boring-decision-squad-site"]').count(), 0);
        assert.equal(await page.locator('[data-testid="boring-decision-squad-forework"]').count(), 1);
        assert.equal(await page.locator('[data-testid="boring-decision-offscreen-ny-f1-06"]').count(), 1);
        assert.equal(await page.locator('[data-testid="boring-decision-strip-squad-sbb"]').count(), 1);
        assert.equal(await page.evaluate(() => location.search), "?demo=&view=decisions", "filter is not in the URL");

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="boring-decision-pills-on-hold"]', { timeout: 20000 });
        await page.waitForTimeout(300);
        assert.equal(await page.locator('[data-testid="boring-decision-pill-site"]').getAttribute("aria-pressed"), "false");
        assert.equal(await page.locator('[data-testid="boring-decision-pill-forework"]').getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator('[data-testid="boring-decision-pill-sbb"]').getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator('[data-testid="boring-decision-squad-site"]').count(), 0);
        assert.equal(await page.locator('[data-testid="boring-decision-squad-forework"]').count(), 1);
        assert.equal(await page.locator('[data-testid="boring-decision-offscreen-ny-f1-06"]').count(), 1);
        assert.equal(await page.locator('[data-testid="boring-decision-strip-squad-sbb"]').count(), 1);

        // 3. All & Active presets
        await page.locator('[data-testid="boring-decision-preset-all"]').click();
        assert.equal(await page.locator('[data-testid="boring-decision-pill-site"]').getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator('[data-testid="boring-decision-summary"]').textContent(), "7 open · 5 here · 2 off-screen");
        await page.locator('[data-testid="boring-decision-preset-active"]').click();
        assert.equal(await page.locator('[data-testid="boring-decision-pill-forework"]').getAttribute("aria-pressed"), "false");
        assert.equal(await page.locator('[data-testid="boring-decision-pill-sbb"]').getAttribute("aria-pressed"), "false");
        assert.equal(await page.locator('[data-testid="boring-decision-summary"]').textContent(), "4 open · 3 here · 1 off-screen");

        // 4. Stage an answer, hide its project -> "+1 hidden"; unhide -> answer intact
        await page.locator('[data-testid="boring-decision-lean-ny-f1-01"]').click();
        assert.equal(await page.locator('[data-testid="boring-decision-send-btn"]').textContent(), "Send 1 answer");
        await page.locator('[data-testid="boring-decision-pill-vibesquad"]').click();
        const sendBtn = page.locator('[data-testid="boring-decision-send-btn"]');
        assert.equal(await sendBtn.textContent(), "Send 0 answers (+1 hidden)");
        assert.equal(await sendBtn.isDisabled(), true, "0 visible answers keeps Send disabled");

        // Stage a visible answer too -> "Send 1 answer (+1 hidden)"
        await page.locator('[data-testid="boring-decision-lean-ny-f1-03"]').click();
        assert.equal(await sendBtn.textContent(), "Send 1 answer (+1 hidden)");
        assert.equal(await sendBtn.isDisabled(), false);

        // Unhide vibesquad -> staged lean is intact and hidden count disappears
        await page.locator('[data-testid="boring-decision-pill-vibesquad"]').click();
        assert.equal(await page.locator('[data-testid="boring-decision-lean-ny-f1-01"]').getAttribute("aria-pressed"), "true", "staged answer survived toggle");
        assert.equal(await sendBtn.textContent(), "Send 2 answers");
      }

      assert.deepEqual(errs, [], `no pageerrors: ${errs.join("; ")}`);
    } finally {
      await context.close();
    }
  });
}
