// V1a overlap + contrast guard (docs/PLAN_OVERLAP_AUDIT_V1.md): runs scripts/ui-overlap.mjs against the demo app.
//
// SKIPPED unless UI_OVERLAP=1: it fails until V1b (layout fixes) and @art U4b (colour/line art) land, so it must
// not block the normal `npm test`. Run it with `UI_OVERLAP=1 node --test test/ui-overlap.test.mjs`
// (or `npm run ui:overlap` for the report only). Matrix = all four sizes (4k@1.2, 1080, 1280x800, 390x844), dark + light
// (~6 min); UI_OVERLAP_SIZES=4k,1080 narrows it for quick local runs. Report: scratch/ui-overlap/report.{json,md}, shots: scratch/shots/v1a-*.
//
// decor-suspect (pixel background step through text) is warn-only, EXCEPT when it matches one of the owner-reported
// known hits: those always fail. The known-hit assertions below fail on ANY hit of any kind, allow-listed or not, so
// V1b has to fix them rather than allow-list them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolvePlaywright, findBrowser, ensureDist, serveDist, installRoutes } from "../scripts/ui-overlap/env.mjs";

const on = process.env.UI_OVERLAP === "1";
const skip = on ? false : "set UI_OVERLAP=1 (fails until V1b + @art U4b land)";
const opts = { timeout: 1200000, skip };

let reportPromise = null;
async function getReport() {
  reportPromise ??= import("../scripts/ui-overlap.mjs").then(({ run }) => run({ sizes: process.env.UI_OVERLAP_SIZES || "4k,1080,800,mobile" }));
  return reportPromise;
}
const describeHits = (hits) => hits.slice(0, 12).map((h) => `#${h.id} ${h.kind} [${h.split}] ${h.selector} (${h.occurrences.map((o) => `${o.surface}@${o.size}/${o.theme}`).slice(0, 3).join(", ")}): ${h.detail}`).join("\n");

test("ui overlap guard: no failing overlap / overflow / clipping / line-through-text / low-contrast hits", opts, async () => {
  const r = await getReport();
  const failing = r.hits.filter((h) => !h.allowed && !h.warn);
  assert.equal(failing.length, 0, `${failing.length} unique failing hits (see scratch/ui-overlap/report.md). First:\n${describeHits(failing)}`);
});

test("no owner-reported known hit reproduces (any kind, allow-list ignored)", opts, async () => {
  const r = await getReport();
  const bad = r.known.filter((k) => k.hitIds.length > 0);
  assert.equal(bad.length, 0, `known hits still reproducing: ${bad.map((k) => `${k.id} [${k.sizes.join(",")}]`).join("; ")}`);
});

test("composer MEDIUM chip (drawer-config-menu-btn) is clean on the composer surface, allow-list free", opts, async () => {
  const r = await getReport();
  const bad = r.hits.filter((h) => h.known.includes("r3-medium-auto-chip-line"));
  assert.equal(bad.length, 0, `composer chip hits (allow-list and warn status ignored):\n${describeHits(bad)}`);
  assert.ok(r.known.find((k) => k.id === "r3-medium-auto-chip-line"), "known-hit registry must keep the composer chip case");
});

test("settings header is clean, allow-list free", opts, async () => {
  const r = await getReport();
  const bad = r.hits.filter((h) => h.known.includes("r3-settings-header"));
  assert.equal(bad.length, 0, `settings header hits (allow-list and warn status ignored):\n${describeHits(bad)}`);
});

// Cheap and always meaningful when enabled: the allow-list may not mention these surfaces at all.
test("allow-list has no entries for the composer chip, chip row or settings header", { skip }, () => {
  const allow = JSON.parse(fs.readFileSync(new URL("../scripts/ui-overlap/allowlist.json", import.meta.url), "utf8")).allow;
  const forbidden = /drawer-config|config-summary|composer|subagent|settings|modal-head/i;
  const bad = allow.filter((a) => forbidden.test(`${a.selector ?? ""} ${a.other ?? ""} ${a.text ?? ""} ${a.surface ?? ""}`));
  assert.deepEqual(bad, [], "these hits must be fixed, not allow-listed");
});

test("no compact-by-default hit: no massive scroll, no overbearing menu (owner rule; reasoned allow-list entries are exempt)", opts, async () => {
  const r = await getReport();
  const bad = r.hits.filter((h) => !h.allowed && (h.kind === "compact-scroll" || h.kind === "compact-menu"));
  assert.equal(bad.length, 0, `${bad.length} compact-by-default hits:
${describeHits(bad)}`);
});

// Always-on (needs only a local Edge/Chrome + Playwright, skips without): the two compact geometry checks fire on a
// synthetic page and stay quiet on a compact one, at the thresholds documented in page-audit.js (scroll 2x + 1 viewport, menu 40%).
const AUDIT_SRC = fs.readFileSync(new URL("../scripts/ui-overlap/page-audit.js", import.meta.url), "utf8");
const pw = resolvePlaywright(), exe = findBrowser();
const fixtureHtml = (body) => `<!doctype html><body style="margin:0;height:100vh;overflow:hidden">${body}</body>`;
const BIG_LIST = `<div id="p" style="position:absolute;left:0;top:0;width:300px;height:300px;overflow-y:auto"><div style="height:2000px">rows</div></div>`;
const SMALL_LIST = `<div id="p" style="position:absolute;left:0;top:0;width:300px;height:300px;overflow-y:auto"><div style="height:500px">rows</div></div>`;
const BIG_MENU = `<div role="menu" id="m" style="position:absolute;left:0;top:0;width:90vw;height:80vh;background:#ccc">menu</div>`;
const SMALL_MENU = `<div role="menu" id="m" style="position:absolute;left:0;top:0;width:200px;height:240px;background:#ccc">menu</div>`;

test("compact guard: geometry checks fire on massive scrolls / overbearing menus and not on compact ones", { skip: pw && exe ? false : "no Playwright / Edge / Chrome" }, async () => {
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const kinds = async (body) => {
      await page.setContent(fixtureHtml(body));
      const res = await page.evaluate(`(${AUDIT_SRC})(${JSON.stringify({ tolerance: 2, rootSelectors: null })})`);
      return res.hits.filter((h) => h.kind.startsWith("compact-"));
    };
    const scroll = await kinds(BIG_LIST);
    assert.deepEqual(scroll.map((h) => h.kind), ["compact-scroll"], "2000px list in a 300px panel (6.7x, > viewport) is a massive scroll");
    assert.equal(scroll[0].split, "ours");
    assert.deepEqual(await kinds(SMALL_LIST), [], "500px in a 300px panel (1.7x, under one viewport) is compact");
    const menu = await kinds(BIG_MENU);
    assert.deepEqual(menu.map((h) => h.kind), ["compact-menu"], "a 90vw x 80vh menu covers 72% of the viewport");
    assert.deepEqual(await kinds(SMALL_MENU), [], "a 200x240 menu is compact");
  } finally {
    await browser.close();
  }
});

// Click audit 1109 (docs/PLAN_CLICK_AUDIT_1109.md, block A3): one test per FAIL row from A1 (17 rows).
// Clicks the control in takeover / hub / compact and asserts the view is unchanged and the menu/popover is open and unclipped.
const clickSkip = pw && exe ? false : "no Playwright / Edge / Chrome";
let clickEnvPromise = null;
async function getClickEnv() {
  if (!clickEnvPromise) {
    clickEnvPromise = (async () => {
      await ensureDist();
      const { server, baseUrl } = await serveDist();
      const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      await installRoutes(context);
      const page = await context.newPage();
      return { server, baseUrl, browser, context, page };
    })();
  }
  return clickEnvPromise;
}

after(async () => {
  if (!clickEnvPromise) return;
  const env = await clickEnvPromise.catch(() => null);
  if (!env) return;
  await env.browser.close().catch(() => {});
  await new Promise((r) => env.server.close(r));
});

let bootDone = false;
async function ensureBooted(page, baseUrl) {
  if (bootDone) return;
  await page.goto(`${baseUrl}/?demo=1&riff=1`, { waitUntil: "domcontentloaded" });
  const homeTile = page.locator('[data-testid="squad-home-tile-vibesquad"] .squad-home-tile-name');
  if (await homeTile.isVisible().catch(() => false)) {
    await homeTile.click();
    await page.locator('[data-testid="pin-grid"]').waitFor({ state: "visible", timeout: 6000 });
  }
  bootDone = true;
}

async function openHubSky(page, baseUrl, takeover = null) {
  await ensureBooted(page, baseUrl);
  const onHub = await page.locator('[data-testid="sky-zones"]').count();
  if (!onHub) {
    await page.locator('[data-testid="sidebar-riffbot-vibesquad"]').locator("visible=true").first().click();
    await page.locator('[data-testid="sky-zones"]').waitFor({ state: "visible", timeout: 8000 });
  }
  await page.evaluate(() => {
    const m = document.querySelector('[data-testid="drawer-config-menu"]');
    if (m) m.removeAttribute("open");
  });
  await page.mouse.click(2, 2);
  const curOpen = await page.locator('[data-testid="sky-zones"]').getAttribute("data-open");
  if (curOpen !== "none") {
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="sky-zones"][data-open="none"]').waitFor({ state: "visible", timeout: 5000 });
  }
  if (takeover) {
    await page.locator(`[data-testid="sky-face-hit-${takeover}"]`).click();
    await page.locator(`[data-testid="sky-zones"][data-open="${takeover}"]`).waitFor({ state: "visible", timeout: 5000 });
  }
}

async function openCompactLane(page, baseUrl) {
  await ensureBooted(page, baseUrl);
  const onHub = await page.locator('[data-testid="sky-zones"]').count();
  const inFocus = await page.locator('[data-testid="pin-focus-bar"]').count();
  if (onHub) {
    await page.locator('[data-testid="pin-rail-vibesquad"]').click();
    await page.locator('[data-testid="sky-zones"]').waitFor({ state: "detached", timeout: 5000 });
  } else if (!inFocus) {
    await page.locator('[data-testid="pin-tile-vibesquad"]').locator("visible=true").first().click();
    await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').waitFor({ state: "visible", timeout: 8000 });
  }
  await page.evaluate(() => {
    const m = document.querySelector('[data-testid="drawer-config-menu"]');
    if (m) m.removeAttribute("open");
  });
  await page.mouse.click(2, 2);
}

async function ensureMoreExpanded(page) {
  const sandboxBtn = page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]');
  if (!(await sandboxBtn.isVisible().catch(() => false))) {
    await page.locator('.pin-rail-active-inspector [data-testid="drawer-more-toggle"]').click();
  }
}

async function assertElementUnclipped(page, selector) {
  const hit = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: "missing" };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + Math.min(r.height / 2, 24);
    const topEl = document.elementFromPoint(cx, cy);
    const inside = !!topEl && (el === topEl || el.contains(topEl));
    return {
      ok: inside && r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth,
      inside,
      rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
      vw: window.innerWidth,
      topHit: topEl ? `${topEl.tagName}.${topEl.className}` : null,
    };
  }, selector);
  assert.ok(hit.ok, `expected ${selector} open & unclipped inside viewport, got ${JSON.stringify(hit)}`);
}

async function assertPageClickable(page, { hub = true } = {}) {
  await assertElementUnclipped(page, '[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]');
  if (hub) {
    await assertElementUnclipped(page, '[data-testid="sky-face-hit-riffbot"]');
  }
}

async function assertHubMultiPointClickable(page) {
  await page.locator('[data-testid="sky-takeover"]').waitFor({ state: "detached", timeout: 2000 });
  await assertElementUnclipped(page, '[data-testid="sky-face-hit-riffbot"]');
  await assertElementUnclipped(page, '[data-testid="sky-face-hit-overlord"]');
  await assertElementUnclipped(page, '[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]');
  await assertElementUnclipped(page, '[data-testid="pin-rail"] [data-testid="pin-rail-vibesquad"]');
  await assertElementUnclipped(page, '[data-testid="hub-pages"] .sq-floor-stage');
  const leftover = await page.evaluate(() => {
    const detailsOpen = !!document.querySelector('[data-testid="drawer-config-menu"][open]');
    const takeoverOverlay = !!document.querySelector('[data-testid="sky-takeover"]');
    const sky = document.querySelector('[data-testid="sky-zones"]');
    const openCls = sky ? sky.classList.contains("is-open") || sky.classList.contains("is-open-riffbot") || sky.classList.contains("is-open-overlord") : false;
    return { detailsOpen, takeoverOverlay, openCls, dataOpen: sky?.getAttribute("data-open") };
  });
  assert.deepEqual(leftover, { detailsOpen: false, takeoverOverlay: false, openCls: false, dataOpen: "none" });
}

test("click-audit A0: data-sky-owner portal targets + SKY_POPOVER_SELECTOR + page stays clickable at all hub points after thinking change & every sky exit path", { skip: clickSkip }, async () => {
  const { SKY_POPOVER_SELECTOR, SKY_OWNER_SELECTOR } = await import("../src/skyZonesLogic.ts");
  for (const sel of ["[data-sky-owner]", ".drawer-head-compact", ".drawer-config-popover"]) {
    assert.ok(SKY_POPOVER_SELECTOR.includes(sel), `SKY_POPOVER_SELECTOR must include ${sel}`);
  }
  assert.equal(SKY_OWNER_SELECTOR.includes(".pin-rail-active-buddy"), false, "SKY_OWNER_SELECTOR must not match whole .pin-rail-active-buddy card");

  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  assert.ok(await page.locator(".pin-focus-slot[data-sky-owner]").count(), "barSlot (.pin-focus-slot) must carry data-sky-owner");
  assert.ok(await page.locator(".pin-rail-active-inspector[data-sky-owner]").count(), "cardSlot (.pin-rail-active-inspector) must carry data-sky-owner");

  // Exit path 1 (Escape): take over RiffBot, open ⚙, change thinking level, exit with Escape, probe all hub points.
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await assertElementUnclipped(page, ".drawer-config-popover");
  await assertElementUnclipped(page, '[data-testid="drawer-thinking-select"]');
  await page.locator('[data-testid="drawer-thinking-select"]').selectOption("high");
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.keyboard.press("Escape"); // closes <details open> first
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), false);
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.keyboard.press("Escape"); // closes takeover to 50/50
  await assertHubMultiPointClickable(page);

  // Exit path 2 (outside click while <details open> after thinking change): closes both <details> and takeover.
  await page.locator('[data-testid="sky-face-hit-riffbot"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await page.locator('[data-testid="drawer-thinking-select"]').selectOption("low");
  await page.mouse.click(2, 2);
  await assertHubMultiPointClickable(page);

  // Exit path 3 (left TV face click while <details open> after thinking change): closes both <details> and takeover.
  await page.locator('[data-testid="sky-face-hit-riffbot"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await page.locator('[data-testid="drawer-thinking-select"]').selectOption("medium");
  await page.locator('[data-testid="sky-face-hit-riffbot"]').click();
  await assertHubMultiPointClickable(page);

  // Exit path 4 (takeover-off ✕ button after thinking change): closes takeover and leaves 50/50 clickable.
  await page.locator('[data-testid="sky-face-hit-riffbot"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await page.locator('[data-testid="drawer-thinking-select"]').selectOption("high");
  await page.keyboard.press("Escape"); // close <details> popover
  await page.locator('[data-testid="sky-chat-close-riffbot"]').click();
  await assertHubMultiPointClickable(page);
});

test("click-audit M1 & M2: real outside clicks close takeover, and Overlord takeover does not leak into shared panes state", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "overlord");
  assert.equal(await page.locator(".pin-focus-slot").getAttribute("data-sky-owner"), "demo-hub-overlord");

  // M2: Overlord takeover must not add demo-hub-overlord to shared panes leftTabs or leftActiveId
  const panesDuring = await page.evaluate(() => JSON.parse(localStorage.getItem("vs.panes.v1") || "{}"));
  assert.notEqual(panesDuring.leftActiveId, "demo-hub-overlord", "Overlord sky takeover must not overwrite shared panes.leftActiveId");
  assert.equal((panesDuring.leftTabs || []).includes("demo-hub-overlord"), false, "Overlord sky takeover must not add Overlord tab to shared panes.leftTabs");

  // M1: clicking outside .pin-rail-active-inspector on .pin-rail-active-head closes Overlord takeover
  await page.locator(".pin-rail-active-head").click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  assert.equal(await page.locator(".pin-focus-slot").getAttribute("data-sky-owner"), "demo-hub-riff");
  await assertHubMultiPointClickable(page);
});

test("click-audit A3 #1: drawer-config-menu-btn in takeover opens unclipped, keeps takeover, and closes on outside/Escape", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), true);
  await assertElementUnclipped(page, ".drawer-config-popover");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), false);
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await assertPageClickable(page);
});

test("click-audit A3 #2: drawer-config-menu-btn in hub (50/50 sky-rest) opens unclipped above TVs and closes on outside/Escape", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, null);
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  await assertElementUnclipped(page, ".drawer-config-popover");
  await page.mouse.click(2, 2);
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), false);
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  await assertPageClickable(page);
});

test("click-audit A3 #3: drawer-config-menu-btn in compact closes on outside click and Escape without exiting pin-focus", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openCompactLane(page, baseUrl);
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await assertElementUnclipped(page, ".drawer-config-popover");
  await page.mouse.click(2, 2);
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), false);
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), false);
  assert.equal(await page.locator('[data-testid="pin-focus-bar"]').count(), 1, "must stay in compact pin-focus view on Escape");
  await assertPageClickable(page, { hub: false });
});

test("click-audit A3 #4: drawer-thinking-select in takeover is reachable and keeps takeover & menu open", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await assertElementUnclipped(page, '[data-testid="drawer-thinking-select"]');
  await page.locator('[data-testid="drawer-thinking-select"]').click();
  await page.locator('[data-testid="drawer-thinking-select"]').selectOption("high");
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), true);
  await page.keyboard.press("Escape");
  await assertPageClickable(page);
});

test("click-audit A3 #5: drawer-thinking-select in hub (50/50 sky-rest) is reachable and keeps hub & menu open", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, null);
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await assertElementUnclipped(page, '[data-testid="drawer-thinking-select"]');
  await page.locator('[data-testid="drawer-thinking-select"]').click();
  await page.locator('[data-testid="drawer-thinking-select"]').selectOption("low");
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), true);
  await page.keyboard.press("Escape");
  await assertPageClickable(page);
});

test("click-audit A3 #8: drawer-mode-select in takeover is reachable and keeps takeover & menu open", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await assertElementUnclipped(page, '[data-testid="drawer-mode-select"]');
  await page.locator('[data-testid="drawer-mode-select"]').click();
  await page.locator('[data-testid="drawer-mode-select"]').selectOption("plan");
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), true);
  await page.keyboard.press("Escape");
  await assertPageClickable(page);
});

test("click-audit A3 #9: drawer-mode-select in hub (50/50 sky-rest) is reachable and keeps hub & menu open", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, null);
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-config-menu-btn"]').click();
  await assertElementUnclipped(page, '[data-testid="drawer-mode-select"]');
  await page.locator('[data-testid="drawer-mode-select"]').click();
  await page.locator('[data-testid="drawer-mode-select"]').selectOption("auto");
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  assert.equal(await page.locator('[data-testid="drawer-config-menu"]').evaluate((el) => el.hasAttribute("open")), true);
  await page.keyboard.press("Escape");
  await assertPageClickable(page);
});

test("click-audit A3 #12: drawer-provider-select in takeover keeps takeover and binds to Overlord on Overlord TV takeover", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "overlord");
  assert.equal(await page.locator('[data-testid="pin-focus-bar"] .drawer-head-compact-title').count(), 1, "compact header must bind to Overlord on Overlord TV takeover");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-provider-select"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "overlord");
  await assertPageClickable(page);
});

test("click-audit A3 #16: drawer-model-select and custom input in takeover keep takeover open", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-model-select"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-model-select"]').selectOption("__custom__");
  await page.locator('[data-testid="pin-focus-bar"] [data-testid="drawer-model-input"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await assertPageClickable(page);
});

test("click-audit A3 #20: brainstorm-park-inbox-btn in takeover opens inbox popover and keeps takeover", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator('.pin-rail-active-inspector [data-testid="brainstorm-park-inbox-btn"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator('[data-testid="brainstorm-inbox-popover"]').isVisible(), true);
  await page.keyboard.press("Escape");
  await assertPageClickable(page);
});

test("click-audit A3 #22: btn-brainstorm-summary in takeover opens summary preview and keeps takeover", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator(".pin-rail-active-inspector .btn-brainstorm-summary").click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator(".pin-rail-active-inspector .brainstorm-summary-preview").isVisible(), true);
  await assertPageClickable(page);
});

test("click-audit A3 #24: drawer-more-toggle in takeover expands secondary tools and keeps takeover", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await ensureMoreExpanded(page);
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').isVisible(), true);
  await assertPageClickable(page);
});

test("click-audit A3 #26: drawer-sandbox-btn in takeover opens unclipped sandbox panel inside viewport and keeps takeover", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await ensureMoreExpanded(page);
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await assertElementUnclipped(page, '[data-testid="drawer-sandbox-panel"]');
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').click();
  await assertPageClickable(page);
});

test("click-audit A3 #27: drawer-sandbox-btn in hub (50/50 sky-rest) opens unclipped sandbox panel inside viewport", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, null);
  await ensureMoreExpanded(page);
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  await assertElementUnclipped(page, '[data-testid="drawer-sandbox-panel"]');
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').click();
  await assertPageClickable(page);
});

test("click-audit A3 #28: drawer-sandbox-btn in compact opens unclipped sandbox panel inside viewport", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openCompactLane(page, baseUrl);
  await ensureMoreExpanded(page);
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').click();
  assert.equal(await page.locator('[data-testid="pin-focus-bar"]').count(), 1);
  await assertElementUnclipped(page, '[data-testid="drawer-sandbox-panel"]');
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-sandbox-btn"]').click();
  await assertPageClickable(page, { hub: false });
});

test("click-audit A3 #30: drawer-export-btn in takeover opens export options and keeps takeover open", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "riffbot");
  await ensureMoreExpanded(page);
  await page.locator('.pin-rail-active-inspector [data-testid="drawer-export-btn"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  assert.equal(await page.locator('.pin-rail-active-inspector [data-testid="drawer-export-md"]').isVisible(), true);
  await assertPageClickable(page);
});

test("click-audit A3 #32: AgentTitleEdit in Overlord takeover opens inline rename input and keeps takeover", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();
  await openHubSky(page, baseUrl, "overlord");
  const titleSpan = page.locator('[data-testid="pin-focus-bar"] .drawer-head-compact-title span[title="Double-click to rename"]');
  assert.equal(await titleSpan.count(), 1, "Overlord title span must be rendered in compact header");
  await titleSpan.dblclick();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "overlord");
  assert.equal(await page.locator('[data-testid="pin-focus-bar"] [data-testid="inline-rename-input"]').isVisible(), true);
  await page.keyboard.press("Escape");
  await assertPageClickable(page);
});

test("click-audit A3 #35-39: sky/hub controls (both panels open/closed, composer-more-tab, sky-idle Spin Up, Escape & outside clicks) keep page clickable", { skip: clickSkip }, async () => {
  const { page, baseUrl } = await getClickEnv();

  // #35 & #37: RiffBot takeover + composer-more-tab ◂ menu + close
  await openHubSky(page, baseUrl, "riffbot");
  await page.locator('[data-testid="sky-chat-riffbot"] [data-testid="composer-more-tab"]').click();
  await assertElementUnclipped(page, '[data-testid="composer-more-menu"]');
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-testid="composer-more-menu"]').count(), 0);
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "riffbot");
  await page.locator('[data-testid="sky-chat-close-riffbot"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  await assertHubMultiPointClickable(page);

  // #36 & #37 & #39: Overlord takeover + composer-more-tab ◂ menu + Escape/outside exit
  await page.locator('[data-testid="sky-face-hit-overlord"]').click();
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "overlord");
  await page.locator('[data-testid="sky-chat-overlord"] [data-testid="composer-more-tab"]').click();
  await assertElementUnclipped(page, '[data-testid="composer-more-menu"]');
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-testid="composer-more-menu"]').count(), 0);
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "overlord");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-testid="sky-zones"]').getAttribute("data-open"), "none");
  await assertHubMultiPointClickable(page);

  // #38: sky-idle Spin Up buttons unclipped via elementFromPoint
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
  bootDone = false;
  const homeTile = page.locator('[data-testid="squad-home-tile-vibesquad"] .squad-home-tile-name');
  if (await homeTile.isVisible().catch(() => false)) {
    await homeTile.click();
  }
  if (!(await page.locator('[data-testid="sky-zones"]').count())) {
    await page.locator('[data-testid="sidebar-riffbot-vibesquad"]').locator("visible=true").first().click();
  }
  await page.locator('[data-testid="sky-start-riffbot"]').waitFor({ state: "visible", timeout: 8000 });
  await assertElementUnclipped(page, '[data-testid="sky-start-riffbot"]');
  await assertElementUnclipped(page, '[data-testid="sky-start-overlord"]');
});
