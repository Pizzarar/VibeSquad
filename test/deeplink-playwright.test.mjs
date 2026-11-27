// R6-1 gate (docs/UX_REVIEW_R6.md): a ?agent= deep link lands on its agent in a real browser on the LIVE runner path
// (not ?demo). The fake runner behaves like the real one on a big squad: the SSE stream opens first, and ~1s later one
// roster snapshot of 520 agents arrives with the linked lead sorting LAST. Fresh browser context (no saved panes / pin).
// After 5s the breadcrumb must end in that agent and the URL must still name it. Skips when no Playwright / browser.
// Debug: R6_DEBUG=<png path> saves a screenshot and prints the page text.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, PLAYWRIGHT_MISSING } from "../scripts/ui-overlap/env.mjs";

const LINKED = "rn-zzzz-desk-lead";
const ROSTER_SIZE = 520;
const TEAMS = {
  revision: "r6-1-deeplink",
  teams: [
    { id: "efi", name: "Escape From Idle", color: "#f5a524", lanes: [{ id: "main-game", name: "Main Game", paths: ["EFI"] }], paths: ["EFI"] },
    { id: "vibesquad", name: "VibeSquad", color: "#b07cf5", lanes: [{ id: "riffbot", name: "RiffBot", hub: true, paths: ["VibeSquad"] }, { id: "desk", name: "Desk UX", paths: ["VibeSquad"] }], paths: ["VibeSquad"] },
  ],
};
const now = new Date().toISOString();
const agent = (id, labels, title, cwd) => ({ id, provider: "claude", model: "claude-opus-5-5", status: "idle", title, labels, cwd, createdAt: now, updatedAt: now, pendingPermissions: [], requiresAttention: false });
const ROSTER = [
  ...Array.from({ length: ROSTER_SIZE - 1 }, (_, i) => agent(`rn-${String(i).padStart(4, "0")}`, { team: "efi", lane: "main-game", role: "worker" }, `Worker ${i}`, "C:/p/EFI")),
  agent(LINKED, { team: "vibesquad", lane: "desk", role: "lead", ord: "7" }, "★ DESK ord7", "C:/p/VibeSquad"),
];

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
let pw, executablePath, browser, server, baseUrl, unavailable;
const streams = new Set();

before(async () => {
  pw = resolvePlaywright({ npx: false });
  executablePath = findBrowser();
  if (!pw || !executablePath) {
    unavailable = !pw ? PLAYWRIGHT_MISSING : "no Edge/Chrome executable";
    return;
  }
  await ensureDist();
  const distDir = path.join(REPO_ROOT, "dist");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const json = (o) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
    if (p === "/__vibesquad/runner/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": open\n\n");
      streams.add(res);
      const hb = setInterval(() => res.write(`data: ${JSON.stringify({ kind: "hb" })}\n\n`), 2000);
      // Like the real squad: the stream is open (conn = connected) well before the one big snapshot lands.
      const snap = setTimeout(() => res.write(`data: ${JSON.stringify({ kind: "roster", agents: ROSTER })}\n\n`), 1000);
      req.on("close", () => (clearInterval(hb), clearTimeout(snap), streams.delete(res)));
      return;
    }
    if (p === "/__vibesquad/runner/status") return json({ enabled: true, lanes: [] });
    if (p === "/api/teams") return json(TEAMS);
    if (p === "/__vibesquad/log") return json([]);
    if (p === "/__vibesquad/first-run/status") return (res.statusCode = 404), res.end();
    if (p.startsWith("/__vibesquad/") || p.startsWith("/api/")) return json({ ok: true });
    let file = path.join(distDir, p === "/" ? "index.html" : decodeURIComponent(p));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, "index.html");
    res.setHeader("content-type", MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ executablePath, headless: true });
});

after(async () => {
  for (const s of streams) s.destroy();
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

test("R6-1: ?agent= for a lead that sorts last in a 520-agent live snapshot opens that agent (fresh context, 5s)", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // Normal mode, nothing else saved: a fresh profile following a shared link.
  await context.addInitScript(() => {
    if (!localStorage.getItem("vs.prefs.v1")) localStorage.setItem("vs.prefs.v1", JSON.stringify({ "app.vibe": "boring" }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${baseUrl}/?agent=${LINKED}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const crumbs = await page.locator('[data-testid="boring-breadcrumb"] .boring-crumb-seg').allInnerTexts();
  const search = await page.evaluate(() => location.search);
  if (process.env.R6_DEBUG) (await page.screenshot({ path: process.env.R6_DEBUG }), console.log((await page.locator("body").innerText()).slice(0, 600)));
  await context.close();
  const segs = crumbs.map((c) => c.replace(/^›\s*/, "").trim());
  assert.deepEqual(errors, [], "no page errors");
  assert.notEqual(segs.at(-1), "Overview", `did not fall back to Overview: ${JSON.stringify(segs)} ${search}`);
  assert.deepEqual(segs, ["VibeSquad", "Desk UX", "Lead"], "breadcrumb ends in the linked lead, in its own project and lane");
  assert.equal(new URLSearchParams(search).get("agent"), LINKED, `URL still names the agent: ${search}`);
});
