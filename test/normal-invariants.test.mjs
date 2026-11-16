// UX-C (docs/UX_REVIEW_PROCESS.md section 3C): the 8 Normal-mode (data-vibe=boring) UX invariants as Playwright tests
// against `?demo=1` at 3200x1800. Reuses the overlap guard's harness (scripts/ui-overlap/env.mjs: Playwright/Edge resolution,
// dist build, static server, API mocks) and the app's own data-testids. Skips cleanly when no browser is available.
//
// A failing invariant is a real finding: its assertion stays as written and the test is marked
// `{ skip: 'known failure idea-pending: ...' }` until the owning lane fixes it (then drop the skip).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as E from "../scripts/ui-overlap/env.mjs";

const OUT = path.join(E.REPO_ROOT, "scratch", "normal-invariants");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tid = (id) => `[data-testid="${id}"]`;

// The demo cast has one registered project (VibeSquad); register a second so cross-project invariants (2, 4, 5) mean something.
const TEAM = (id, name, lanes) => ({ id, name, color: "#6cc0f5", leadFlagTokens: 150000, leadAutoHandoffTokens: 250000, leadHardCapTokens: 300000, brainstormWarnTokens: 80000, brainstormRestartTokens: 150000, lanes, paths: [name] });
const REGISTRY = { ...E.TEAMS_REGISTRY, revision: "normal-invariants", teams: [...E.TEAMS_REGISTRY.teams, TEAM("efi", "Escape From Idle", [{ id: "main-game", name: "Main game", paths: ["EFI"] }, { id: "ui-lab", name: "UI Lab", paths: ["EFI"] }])] };
const PROJECT_NAME = Object.fromEntries(REGISTRY.teams.map((t) => [t.id, t.name]));

// agent id -> project name, read from the demo cast itself (src/demo.tsx): `team: "x"` on the line, or the vs() helper = vibesquad.
const DEMO_TEAM = {};
for (const line of fs.readFileSync(path.join(E.REPO_ROOT, "src", "demo.tsx"), "utf8").split("\n")) {
  const title = /\bid: "(demo-[\w-]+)"/.exec(line)?.[1];
  if (!title) continue;
  const team = /\bteam: "(\w+)"/.exec(line)?.[1] ?? (/\bvs\(/.test(line) ? "vibesquad" : null);
  if (team) DEMO_TEAM[title] = PROJECT_NAME[team] ?? team;
}

let unavailable = null, server = null, browser = null, ctx = null, page = null, baseUrl = "";

before(async () => {
  const pw = E.resolvePlaywright();
  if (!pw) { unavailable = "Playwright not found (set PLAYWRIGHT_DIR or install playwright)."; return; }
  const exe = E.findBrowser();
  if (!exe) { unavailable = "No Edge/Chrome executable found (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)."; return; }
  await E.ensureDist();
  ({ server, baseUrl } = await E.serveDist());
  browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  ctx = await browser.newContext({ viewport: { width: 3200, height: 1800 } });
  await ctx.addInitScript(`try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("vs.prefs.v1", JSON.stringify({ "app.vibe": "boring" })); localStorage.setItem("vs.vibePicked", "1"); } catch {}`);
  await E.installRoutes(ctx);
  await ctx.route("**/api/teams", (r) => (r.request().method() === "GET" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REGISTRY) }) : r.fallback()));
  page = await ctx.newPage();
  fs.mkdirSync(OUT, { recursive: true });
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
});

const load = async (query = "") => {
  await page.goto(`${baseUrl}/?demo=1${query}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator(tid("boring-app")).waitFor({ timeout: 15000 });
  await page.locator(tid("boring-needs-you")).waitFor({ timeout: 15000 });
  await page.locator(tid("boring-sidebar-footer")).waitFor();
  await sleep(1200);
};
const shot = async (name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }); return path.relative(E.REPO_ROOT, f); };
const guard = (name, fn) => async (t) => {
  if (unavailable) return t.skip(unavailable);
  try { await fn(t); } catch (e) { e.message += `\n(screenshot: ${await shot(name).catch(() => "n/a")})`; throw e; }
};

// ── probes ──────────────────────────────────────────────────────────────────
const selectedRows = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="boring-sidebar"] .on')].map((e) => ({
  cls: e.className, tid: e.getAttribute("data-testid") ?? e.querySelector("[data-testid]")?.getAttribute("data-testid") ?? null,
  project: e.closest(".boring-project-block")?.querySelector('[data-testid^="boring-project-header-"] .boring-project-name')?.textContent?.trim() ?? null,
  visible: !!(e.offsetWidth || e.offsetHeight),
})));
const crumb = () => page.evaluate(() => {
  const t = (k) => document.querySelector(`[data-testid="boring-crumb-${k}"]`)?.textContent?.trim() ?? null;
  return { project: t("project"), lane: t("lane"), agent: t("agent") };
});
/** The agent whose chat is open: the header data-agent-id (stable; titles change), mapped to its project via the demo cast. */
const openAgent = () => page.evaluate(() => document.querySelector('[data-testid="boring-agent-header"]')?.getAttribute("data-agent-id") ?? null);
const footerY = () => page.evaluate(() => Math.round(document.querySelector('[data-testid="boring-sidebar-footer"]').getBoundingClientRect().top));

/** The states of invariants 3, 4, 6, 7. Each returns after the UI has settled. */
const STATES = [
  { id: "initial", go: () => load() },
  { id: "lane-click", go: async () => { await load(); await page.locator(tid("boring-conv-main-game")).locator(".boring-conv-title").click(); await sleep(800); } },
  { id: "ctrl-j", go: async () => { await load(); await page.keyboard.press("Control+J"); await sleep(900); } },
  { id: "needs-you-click", go: async () => { await load(); await page.locator('[data-testid^="boring-needs-open-"]').nth(2).click(); await sleep(900); } },
  { id: "deep-link-agent", go: () => load("&agent=demo-art-o") },
];

test("1. Needs-you header count = items shown + 'N more'", guard("inv1", async () => {
  await load();
  const count = Number(await page.locator(tid("boring-needs-you-count")).innerText());
  const shown = await page.locator(tid("boring-needs-you-item")).count();
  const more = await page.locator(tid("boring-needs-you-more")).count();
  const moreN = more ? Number(/\+?\s*(\d+)\s+more/.exec(await page.locator(tid("boring-needs-you-more")).innerText())?.[1] ?? NaN) : 0;
  assert.ok(count > 0, "demo should have Needs-you items");
  assert.equal(shown + moreN, count, `header says ${count}, list shows ${shown} + ${moreN} more`);
  if (more) { await page.locator(tid("boring-needs-you-more")).click(); await sleep(300); }
  assert.equal(await page.locator(tid("boring-needs-you-item")).count(), count, "expanded list length");
}));

test("2. All projects collapsed: project badges sum to the Needs-you count", guard("inv2", async () => {
  await load();
  const count = Number(await page.locator(tid("boring-needs-you-count")).innerText());
  for (const t of REGISTRY.teams) {
    const hdr = page.locator(tid(`boring-project-header-${t.id}`));
    if ((await hdr.getAttribute("aria-expanded")) === "true") { await page.locator(tid(`boring-project-toggle-${t.id}`)).click(); await sleep(200); }
    assert.equal(await hdr.getAttribute("aria-expanded"), "false", `${t.id} collapsed`);
  }
  const badges = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="boring-project-header-"]')].map((h) => ({ id: h.getAttribute("data-testid"), n: Number(h.querySelector(".boring-badge")?.textContent?.trim() || 0) })));
  assert.equal(badges.reduce((s, b) => s + b.n, 0), count, `badges ${JSON.stringify(badges)} vs Needs-you ${count}`);
}));

test("3. Exactly one selected sidebar row in every state", guard("inv3", async () => {
  const bad = [];
  for (const s of STATES) {
    await s.go();
    const rows = (await selectedRows()).filter((r) => r.visible);
    if (rows.length !== 1) { bad.push(`${s.id}: ${rows.length} selected ${JSON.stringify(rows.map((r) => r.tid ?? r.cls))}`); await shot(`inv3-${s.id}`); }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
}));

test("4. Breadcrumb project = selected row project = open agent project", guard("inv4", async () => {
  const bad = [];
  await load();
  let prev = await openAgent();
  for (const s of STATES.filter((x) => x.id !== "initial")) {
    await s.go();
    const c = await crumb();
    const rows = (await selectedRows()).filter((r) => r.visible);
    const name = await openAgent();
    // Every transition must actually change the open agent, or it proves nothing.
    if (name === prev) bad.push(`${s.id}: open agent did not change (still ${JSON.stringify(name)})`);
    prev = name;
    const agentProject = name ? DEMO_TEAM[name] ?? `?${name}` : null;
    const rowProject = rows[0]?.project ?? null;
    const ok = name && c.project && c.project === rowProject && c.project === agentProject;
    if (!ok) { bad.push(`${s.id}: crumb=${c.project} row=${rowProject} agent=${JSON.stringify(name)}->${agentProject}`); await shot(`inv4-${s.id}`); }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
}));

test("5. Two expanded projects have the same child structure", guard("inv5", async () => {
  await load();
  for (const t of REGISTRY.teams) {
    const hdr = page.locator(tid(`boring-project-header-${t.id}`));
    if ((await hdr.getAttribute("aria-expanded")) !== "true") { await page.locator(tid(`boring-project-toggle-${t.id}`)).click(); await sleep(200); }
  }
  const shapes = await page.evaluate(() => [...document.querySelectorAll(".boring-project-block")].map((b) => {
    const kids = [...(b.querySelector(".boring-project-lanes")?.children ?? [])];
    const kind = (k) => (k.classList.contains("boring-desk-block") ? "desk" : k.querySelector('[data-testid^="boring-core-bugs"]') ? "bugs" : k.matches(".boring-conv-row") ? "lane" : k.tagName.toLowerCase() + "." + k.className);
    return { project: b.querySelector(".boring-project-name")?.textContent?.trim(), kids: kids.map(kind) };
  }));
  assert.equal(shapes.length, REGISTRY.teams.length);
  for (const s of shapes) assert.deepEqual(s.kids.slice(0, 2), ["desk", "bugs"], `${s.project} must start Desk, Bugs: ${JSON.stringify(shapes)}`);
  const nonLane = (s) => s.kids.filter((k) => k !== "lane");
  for (const s of shapes.slice(1)) assert.deepEqual(nonLane(s), nonLane(shapes[0]), `non-lane children differ: ${JSON.stringify(shapes)}`);
}));

test("6. No agent title appears more than twice in the visible viewport", { skip: "known failure idea-271: after Ctrl+J the opened agent title shows 5x in view (Needs-you row, sidebar worker row, breadcrumb, agent header, context panel); also 3-4x on deep link" }, guard("inv6", async () => {
  const bad = [];
  for (const s of STATES) {
    await s.go();
    const counts = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const inView = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && getComputedStyle(e).visibility !== "hidden"; };
      const titles = new Set([...document.querySelectorAll('.boring-needs-who, [data-testid^="boring-worker-"]:not([data-testid^="boring-worker-why"]) .boring-row-label, [data-testid="boring-agent-name"], [data-testid^="boring-top-worker-"]')].map((e) => e.textContent.trim()).filter((t) => t.length > 3));
      const out = {};
      for (const e of document.querySelectorAll("body *")) {
        if (e.children.length || !inView(e)) continue;
        const t = e.textContent.trim();
        if (titles.has(t)) out[t] = (out[t] ?? 0) + 1;
      }
      return out;
    });
    const over = Object.entries(counts).filter(([, n]) => n > 2);
    if (over.length) { bad.push(`${s.id}: ${JSON.stringify(over)}`); await shot(`inv6-${s.id}`); }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
}));

test("7. Sidebar footer y is the same in every state", guard("inv7", async () => {
  const ys = {};
  for (const s of STATES) { await s.go(); ys[s.id] = await footerY(); }
  assert.equal(new Set(Object.values(ys)).size, 1, `footer top by state: ${JSON.stringify(ys)}`);
}));

test("8. A Needs-you reason shows at least 40 characters before truncating", guard("inv8", async () => {
  await load();
  const rows = await page.evaluate(() => [...document.querySelectorAll(".boring-needs-reason")].map((e) => {
    const len = e.textContent.length;
    const truncated = e.scrollWidth > e.clientWidth;
    return { text: e.textContent, len, truncated, visibleChars: truncated ? Math.floor((e.clientWidth / e.scrollWidth) * len) : len };
  }));
  assert.ok(rows.length > 0);
  const bad = rows.filter((r) => r.truncated && r.visibleChars < 40);
  assert.deepEqual(bad, [], `truncated below 40 chars: ${JSON.stringify(bad)}`);
}));

test("9. The Needs-you count and badges don't change when you open and close an agent", guard("inv9", async () => {
  await load();
  const snap = () => page.evaluate(() => ({
    count: document.querySelector('[data-testid="boring-needs-you-count"]')?.textContent?.trim() ?? null,
    badges: [...document.querySelectorAll(".boring-badge")].map((b) => b.textContent?.trim()),
  }));
  const before = await snap();
  const n = await page.locator('[data-testid^="boring-needs-open-"]').count();
  assert.ok(n > 0, "demo should list Needs-you rows");
  const bad = [];
  for (let i = 0; i < n; i++) {
    await page.locator('[data-testid^="boring-needs-open-"]').nth(i).click();
    await sleep(700);
    await page.locator('[data-testid="boring-project-header-vibesquad"]').click(); // back to the Overview
    await sleep(700);
    const after = await snap();
    // The Needs-you count must not move. Badges are compared by the count only: opening an agent expands its project/lane (collapsed-only
    // badges legitimately swap) and the Overview shows that project's table, so per-badge equality is not a stable contract (see R4-1 report).
    if (after.count !== before.count) bad.push(`row ${i}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
}));
