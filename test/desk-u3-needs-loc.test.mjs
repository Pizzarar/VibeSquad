// @desk U3 (UX R25 m1 + m3, R32 m1–m3): Needs-you location line geometry, probed in a real browser (?demo) at sidebar widths 290/307, light + dark.
// Replaces the former CSS-string pins in desk-b3-needsyou-fit. Skips when no Playwright/Chromium is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
// Screenshots are only written when DESK_U3_SHOTS=1 (to the tracked artifacts/desk-u3/); otherwise nothing is written.
const WRITE_SHOTS = process.env.DESK_U3_SHOTS === "1";
const SHOTS = WRITE_SHOTS ? path.join(REPO_ROOT, "artifacts", "desk-u3") : path.join(os.tmpdir(), "desk-u3-unused");

// Normal sidebar width is clamp(290px, 16vw, 380px) (src/boring.css:150), so drive it via viewport width:
// 1280px -> 16vw = 204.8px -> clamped to 290px; 1920px -> 16vw = 307.2px -> ~307px.
const WIDTH_CASES = [
  { label: 290, viewport: { width: 1280, height: 900 }, expectedSidebarW: 290 },
  { label: 307, viewport: { width: 1920, height: 1080 }, expectedSidebarW: 307.2 },
];

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
  if (WRITE_SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

const measuredSidebarWidths = new Map();

for (const theme of ["light", "dark"]) {
  for (const { label: width, viewport, expectedSidebarW } of WIDTH_CASES) {
    test(`U3: Needs-you rows at ${width}px (${theme}): real sidebar width, stock geometry, long-name elision + project floor, empty-lane separator`, async (t) => {
      if (unavailable) return t.skip(unavailable);
      const context = await browser.newContext({ viewport, colorScheme: theme });
      await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/?demo=&team=vibesquad`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="boring-needs-you-item"]', { timeout: 20000 });
        await page.waitForTimeout(600);

        // 1. Assert the Normal sidebar actually rendered at the expected clamp(290px, 16vw, 380px) width.
        const sidebarW = await page.evaluate(() => document.querySelector(".boring-sidebar")?.getBoundingClientRect().width ?? 0);
        assert.ok(Math.abs(sidebarW - expectedSidebarW) <= 1.5, `sidebar width at ${viewport.width}px viewport should be ~${expectedSidebarW}px, got ${sidebarW}px`);
        measuredSidebarWidths.set(`${theme}:${width}`, sidebarW);

        // Capture stock-demo screenshot at the real sidebar width.
        if (WRITE_SHOTS) await page.locator('[data-testid="boring-needs-you"]').screenshot({ path: path.join(SHOTS, `needs-you-${width}-${theme}.png`) });

        // 2. Assert stock row geometry.
        const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="boring-needs-you-item"]')].map((li) => {
          const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; };
          const q = (s) => li.querySelector(s);
          const who = q(".boring-needs-who"), where = q('[data-testid="boring-needs-where"]'), lane = q(".boring-needs-lane"), proj = q(".boring-needs-proj"), reason = q(".boring-needs-reason"), open = q(".boring-needs-open");
          const cs = getComputedStyle(who);
          const ch = parseFloat(cs.fontSize) * 0.5;
          const sep = getComputedStyle(proj, "::before").content;
          return { whoText: who.textContent, who: box(who), where: box(where), lane: box(lane), laneText: lane.textContent, laneScroll: lane.scrollWidth, laneClient: lane.clientWidth, proj: box(proj), reason: box(reason), open: box(open), chPx: ch, sep, whereScroll: where.scrollWidth, whereClient: where.clientWidth, txt: where.innerText };
        }));
        assert.ok(rows.length >= 4, `demo has >= 4 Needs-you rows (got ${rows.length})`);
        for (const r of rows) {
          const label = `${r.whoText} | ${r.txt}`;
          assert.ok(r.who.w >= Math.min(r.chPx * 20, r.open.w) - 1 && r.who.w >= 20 * r.chPx - 1, `title keeps its 20ch floor (${r.who.w}px): ${label}`);
          assert.ok(r.where.t >= r.who.b - 1, `location sits under the title: ${label}`);
          assert.ok(r.reason.t >= r.where.b - 1, `reason is on its own line below the location: ${label}`);
          assert.ok(r.where.l >= r.open.l - 1 && r.where.r <= r.open.r + 1, `location inside the row: ${label}`);
          assert.ok(r.whereScroll <= r.whereClient + 1, `location box not overflowing (scroll=${r.whereScroll} client=${r.whereClient}): ${label}`);
          assert.ok(r.lane.r <= r.where.r + 1 && r.proj.r <= r.where.r + 1, `lane/project clipped inside the location box: ${label}`);
          if (r.laneText.trim()) {
            assert.ok(r.laneScroll <= r.laneClient, `lane unclipped (scroll=${r.laneScroll} <= client=${r.laneClient}): ${label}`);
            assert.ok(r.lane.w > 8, `the lane stays visible (${r.lane.w}px): ${label}`);
            assert.ok(r.proj.l >= r.lane.r - 1, `lane and project do not overlap: ${label}`);
            assert.ok(/·/.test(r.sep), `non-empty lane renders ::before separator (${r.sep}): ${label}`);
          } else {
            assert.ok(r.sep === "none" || r.sep === "normal", `empty lane has no ::before separator (${r.sep}): ${label}`);
          }
        }

        // 3. Inject stress cases into the live DOM rows and measure real browser layout:
        //    [0] medium lane + long project -> lane stays whole (unclipped), project elides first
        //    [1] short lane ("UI") + long project -> lane stays whole (no "U…" sub-pixel shrink), project elides first
        //    [2] 27+ char lane + project -> lane caps with ellipsis, project keeps a visible floor (> 0px)
        //    [3] empty lane + project -> ::before separator disappears (content: none/normal), project starts at where.left
        const stress = await page.evaluate(() => {
          const items = [...document.querySelectorAll('[data-testid="boring-needs-you-item"]')];
          const cases = [
            { name: "medium-lane-long-proj", lane: "Standing Teams", proj: "Windows · VibeSquad App Overworld Remaster" },
            { name: "short-lane-long-proj", lane: "UI", proj: "Escape From Idle Definitive Edition Collection" },
            { name: "long-lane-27plus", lane: "Main Game Overworld Quests And Dialogue", proj: "Main Game Project" },
            { name: "empty-lane", lane: "", proj: "VibeSquad" },
          ];
          return cases.map((c, i) => {
            const li = items[i];
            const where = li.querySelector('[data-testid="boring-needs-where"]');
            const lane = li.querySelector(".boring-needs-lane");
            const proj = li.querySelector(".boring-needs-proj");
            lane.textContent = c.lane;
            proj.textContent = c.proj;
            // Force layout and measure both integer scroll/client and sub-pixel text Range width.
            const whereR = where.getBoundingClientRect();
            const laneR = lane.getBoundingClientRect();
            const projR = proj.getBoundingClientRect();
            let laneTextW = 0;
            if (lane.firstChild) {
              const range = document.createRange();
              range.selectNodeContents(lane.firstChild);
              laneTextW = range.getBoundingClientRect().width;
            }
            return {
              name: c.name,
              whereW: whereR.width, whereL: whereR.left, whereR: whereR.right,
              laneW: laneR.width, laneR: laneR.right, laneTextW,
              laneScroll: lane.scrollWidth, laneClient: lane.clientWidth,
              projW: projR.width, projL: projR.left, projR: projR.right,
              projScroll: proj.scrollWidth, projClient: proj.clientWidth,
              sep: getComputedStyle(proj, "::before").content,
            };
          });
        });

        const [med, short, longLane, emptyLane] = stress;

        // Medium lane + long project: lane unclipped (both integer scrollWidth and sub-pixel Range), project clipped first, project > 0.
        assert.ok(med.laneScroll <= med.laneClient, `${med.name}: lane unclipped (scroll=${med.laneScroll} <= client=${med.laneClient})`);
        assert.ok(med.laneW >= med.laneTextW - 0.25, `${med.name}: lane not sub-pixel shrunk (box=${med.laneW.toFixed(2)}px vs text=${med.laneTextW.toFixed(2)}px)`);
        assert.ok(med.projScroll > med.projClient, `${med.name}: project elides first (scroll=${med.projScroll} > client=${med.projClient})`);
        assert.ok(med.projW > 0, `${med.name}: project stays visible (${med.projW}px)`);
        assert.ok(/·/.test(med.sep), `${med.name}: ::before separator present (${med.sep})`);

        // Short lane ("UI") + long project: lane unclipped (catches "U…" flex-shrink bug), project clipped first.
        assert.ok(short.laneScroll <= short.laneClient, `${short.name}: lane unclipped (scroll=${short.laneScroll} <= client=${short.laneClient})`);
        assert.ok(short.laneW >= short.laneTextW - 0.25, `${short.name}: lane not sub-pixel shrunk (box=${short.laneW.toFixed(2)}px vs text=${short.laneTextW.toFixed(2)}px)`);
        assert.ok(short.projScroll > short.projClient, `${short.name}: project elides first (scroll=${short.projScroll} > client=${short.projClient})`);
        assert.ok(short.projW > 0, `${short.name}: project stays visible (${short.projW}px)`);
        assert.ok(/·/.test(short.sep), `${short.name}: ::before separator present (${short.sep})`);

        // 27+ char lane: lane elides at cap, project keeps a visible floor (> 0px) and stays inside where.
        assert.ok(longLane.laneScroll > longLane.laneClient, `${longLane.name}: 27+ char lane elides at cap (scroll=${longLane.laneScroll} > client=${longLane.laneClient})`);
        assert.ok(longLane.projW > 0, `${longLane.name}: project keeps a floor > 0px even with 27+ char lane (got ${longLane.projW}px)`);
        assert.ok(longLane.projR <= longLane.whereR + 1, `${longLane.name}: project stays inside location box`);
        assert.ok(/·/.test(longLane.sep), `${longLane.name}: ::before separator present (${longLane.sep})`);

        // Empty lane: no ::before separator (checked via getComputedStyle, not innerText) and project flush left.
        assert.ok(emptyLane.sep === "none" || emptyLane.sep === "normal", `${emptyLane.name}: no ::before separator when lane is empty (got ${emptyLane.sep})`);
        assert.ok(emptyLane.laneW <= 0.5, `${emptyLane.name}: empty lane has 0px width (got ${emptyLane.laneW}px)`);
        assert.ok(Math.abs(emptyLane.projL - emptyLane.whereL) <= 1, `${emptyLane.name}: project starts flush at location left (${emptyLane.projL} vs ${emptyLane.whereL})`);
      } finally { await context.close(); }
    });
  }
}

test("U3: 290px and 307px runs actually exercised distinct sidebar widths", (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const theme of ["light", "dark"]) {
    const w290 = measuredSidebarWidths.get(`${theme}:290`);
    const w307 = measuredSidebarWidths.get(`${theme}:307`);
    assert.ok(w307 - w290 >= 15, `${theme}: 307px sidebar (${w307}) must be wider than 290px sidebar (${w290})`);
  }
});
