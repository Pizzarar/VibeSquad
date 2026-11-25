// @desk U3 (UX R25 m1 + m3): Needs-you location line geometry, probed in a real browser (?demo) at sidebar widths 290/307, light + dark.
// Replaces the former CSS-string pins in desk-b3-needsyou-fit. Skips when no Playwright/Chromium is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const SHOTS = path.join(REPO_ROOT, "artifacts", "desk-u3");

before(async () => {
  pw = resolvePlaywright();
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
  mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

for (const theme of ["light", "dark"]) {
  for (const width of [290, 307]) {
    test(`U3: Needs-you rows at ${width}px (${theme}): title >=20ch, lane visible, no stray separator, no overlap/clip, reason on its own line`, async (t) => {
      if (unavailable) return t.skip(unavailable);
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: theme });
      await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); localStorage.setItem("vibesquad.sidebarWidth","${width}"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/?demo=&team=vibesquad`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="boring-needs-you-item"]', { timeout: 20000 });
        await page.waitForTimeout(600);
        await page.locator('[data-testid="boring-needs-you"]').screenshot({ path: path.join(SHOTS, `needs-you-${width}-${theme}.png`) });
        const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="boring-needs-you-item"]')].map((li) => {
          const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; };
          const q = (s) => li.querySelector(s);
          const who = q(".boring-needs-who"), where = q('[data-testid="boring-needs-where"]'), lane = q(".boring-needs-lane"), proj = q(".boring-needs-proj"), reason = q(".boring-needs-reason"), open = q(".boring-needs-open");
          const cs = getComputedStyle(who);
          const ch = parseFloat(cs.fontSize) * 0.5;
          const sep = getComputedStyle(proj, "::before").content;
          return { whoText: who.textContent, who: box(who), where: box(where), lane: box(lane), laneText: lane.textContent, proj: box(proj), reason: box(reason), open: box(open), chPx: ch, sep, whereScroll: where.scrollWidth, whereClient: where.clientWidth, txt: where.innerText };
        }));
        assert.ok(rows.length > 0, "demo has Needs-you rows");
        for (const r of rows) {
          const label = `${r.whoText} | ${r.txt}`;
          assert.ok(r.who.w >= Math.min(r.chPx * 20, r.open.w) - 1, `title keeps its 20ch floor (${r.who.w}px): ${label}`);
          assert.ok(r.where.t >= r.who.b - 1, `location sits under the title: ${label}`);
          assert.ok(r.reason.t >= r.where.b - 1, `reason is on its own line below the location: ${label}`);
          assert.ok(r.where.l >= r.open.l - 1 && r.where.r <= r.open.r + 1, `location inside the row: ${label}`);
          assert.ok(r.lane.r <= r.where.r + 1 && r.proj.r <= r.where.r + 1, `lane/project clipped inside the location box: ${label}`);
          if (r.laneText.trim()) {
            assert.ok(r.lane.w > 8, `the lane stays visible (${r.lane.w}px): ${label}`);
            assert.ok(r.proj.l >= r.lane.r - 1, `lane and project do not overlap: ${label}`);
            assert.ok(!/^\s*·/.test(r.txt), `no stray leading separator: ${label}`);
          } else {
            assert.ok(!/·/.test(r.sep.replace(/"/g, "")) || r.sep === "none" || r.sep === "normal", `no separator without a lane: ${label}`);
            assert.ok(!/^\s*·/.test(r.txt), `no stray leading separator: ${label}`);
          }
        }
      } finally { await context.close(); }
    });
  }
}
