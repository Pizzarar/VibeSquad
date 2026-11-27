// V1a overlap + contrast guard (docs/PLAN_OVERLAP_AUDIT_V1.md). Drives the demo app (?demo=1) in headless
// Edge/Chrome across surfaces x sizes x themes and flags: intersecting boxes, text overflow / truncation,
// edge clipping, decorative lines through text, and text contrast < 3:1.
//
//   node scripts/ui-overlap.mjs [--vibe boring|fun|both (default both)] [--sizes 4k,1080,800,mobile] [--themes dark,light] [--surfaces a,b]
//                               [--out scratch/ui-overlap] [--shots scratch/shots] [--no-fail] [--rebuild]
//
// Kinds: overlap, text-overflow, text-outside-container, truncated, edge-clip, decor-line (geometric line/border/
// pseudo box through text), compact-scroll (page/panel scrolls > 2x its height and past a viewport) and compact-menu (open menu
// covers > 40% of the viewport or is taller than it): the owner's compact-by-default rule. contrast = failing. decor-suspect (pixel background step through text) = warn-only.
// Exit 1 when any failing, non-allow-listed hit remains (use --no-fail to just write the report).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "./ui-overlap/env.mjs";
import { decodePng, sampleBox, parseColor, lum, contrast } from "./ui-overlap/png.mjs";
import { cssRefs, tsxRefs } from "./ui-overlap/source-map.mjs";
import { KNOWN, matchKnown } from "./ui-overlap/known-hits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = E.REPO_ROOT;
const AUDIT_SRC = fs.readFileSync(path.join(HERE, "ui-overlap", "page-audit.js"), "utf8");
const ALLOW = JSON.parse(fs.readFileSync(path.join(HERE, "ui-overlap", "allowlist.json"), "utf8")).allow;

export const SIZES = {
  "4k": { w: 3200, h: 1800, dpr: 1.2, label: "3840x2160@1.2 (3200x1800 css)" },
  "1080": { w: 1920, h: 1080, dpr: 1, label: "1920x1080" },
  "800": { w: 1280, h: 800, dpr: 1, label: "1280x800" },
  "720": { w: 1280, h: 720, dpr: 1, label: "1280x720" },
  mobile: { w: 390, h: 844, dpr: 1, label: "390x844", mobile: true },
};
export const WARN_KINDS = new Set(["decor-suspect"]);

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Surfaces ─────────────────────────────────────────────────────────────────
const SQUAD = "vibesquad";
const tid = (id) => `[data-testid="${id}"]`;
let BASE = "";
export const setBase = (b) => { BASE = b; };

// Selectors can match hidden duplicates (e.g. `.composer textarea` matches 2): only ever act on the first VISIBLE match.
const vis = (page, sel) => page.locator(sel).locator("visible=true").first();
async function click(page, sel, ms = 4000) {
  const loc = vis(page, sel.replace(/:visible/g, ""));
  await loc.waitFor({ state: "visible", timeout: ms });
  await loc.click({ timeout: ms });
}
async function reset(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(2, 2).catch(() => {});
  await sleep(120);
}
async function reload(page, query = "") {
  await page.goto(`${BASE}/?demo=1${query}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1800);
}
async function toSquadsHome(page) {
  await reset(page);
  await page.getByRole("button", { name: "SQUADS", exact: true }).first().click({ timeout: 4000 });
  await page.locator(tid("squads-home")).waitFor({ timeout: 6000 });
  await sleep(500);
}
// PinGrid retired as the Psycho Squad home (docs/PLAN_PSYCHO_SIDEBAR_HUB.md:13, @desk Option C; shipped fc6e7427): a squad tile click,
// Esc and reload all land on the hub page (HubPages), and the PinGrid / "Teams" header (+ pin-grid-usage, hub-bar, pin-grid-teams-toggle
// surfaces) has no real user path any more, so those surfaces are retired rather than faked. Real routes only:
//   hub page  = SQUADS -> squad tile; full plumbing view (the quick-chip header, App.tsx TeamPage full) = sidebar pin menu -> "Show plumbing".
async function toHubPage(page) {
  await toSquadsHome(page);
  await click(page, `${tid(`squad-home-tile-${SQUAD}`)} .squad-home-tile-name`);
  await page.locator(tid("hub-pages")).waitFor({ timeout: 8000 });
  await sleep(500);
}
// Below ~1300px the sidebar starts as a 56px rail without the pin rows: expand it, as a user would.
async function expandSidebar(page) {
  const t = page.locator('[data-testid="sidebar-collapse-toggle"][aria-expanded="false"]').locator("visible=true").first();
  if (await t.count()) { await t.click({ timeout: 3000 }); await sleep(500); }
}
// PinMenu closes on ANY scroll or resize while open, and Playwright's click scrolls the target into view first: scroll it in, let the
// sidebar settle, then open the menu with a DOM click so nothing scrolls after it opens (short viewports, e.g. 1280x720).
async function openSidebarPinMenu(page) {
  const btn = vis(page, tid(`pin-menu-${SQUAD}`));
  await btn.waitFor({ state: "visible", timeout: 4000 });
  await btn.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(900);
  await btn.evaluate((el) => el.click());
}
async function toFullPlumbing(page) {
  await toHubPage(page);
  await expandSidebar(page);
  await openSidebarPinMenu(page);
  await page.getByRole("menuitem", { name: /Show plumbing/ }).evaluate((el) => el.click(), null, { timeout: 4000 }); // DOM click in the open window; the list re-closes within ~300ms on a stray scroll
  await page.locator(`${tid(`squad-bugs-chip-${SQUAD}`)}, ${tid("squad-full-toggle")}`).locator("visible=true").first().waitFor({ timeout: 6000 });
  await sleep(500);
}
async function toFocus(page) {
  await toHubPage(page);
  await expandSidebar(page);
  await click(page, `${tid(`sidebar-pin-${SQUAD}`)} .pin-row-name`); // the lane name (the row centre can be its needs badge)
  await page.locator(tid("drawer-head-compact")).waitFor({ timeout: 8000 });
  await sleep(700);
}
// Mobile (390): only <PhoneCockpit /> mounts (src/PhoneCockpit.tsx): a squad pill + "..." drawer on top, the Overlord / RiffBot
// tabs at the bottom, and one chat-only AgentDrawer. No sidebar, pin grid, squads home or modals. `&riff=1` gives the demo a live
// RiffBot + Overlord; the drawer's lane rows open a lane's Buddy (the "neon-noir cast" brainstorm for `vibesquad`).
const phoneUrl = (query = "") => `&riff=1${query}`;
async function phoneHome(page, query = "") {
  // Storage is cleared so a previously opened lane/tab can't leak in; vs.vibePicked skips the first-launch vibe picker.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("vs.vibePicked", "1"); });
  await reload(page, phoneUrl(query));
  await page.locator(tid("phone-cockpit")).waitFor({ timeout: 8000 });
}
async function phoneTab(page, surface, query = "") {
  await phoneHome(page, query);
  await click(page, tid(`phone-tab-${surface}`));
  await page.locator(`${tid("phone-cockpit")}[data-surface="${surface}"]`).waitFor({ timeout: 4000 });
  await sleep(900);
}
async function phoneBuddy(page, lane, query = "") {
  await phoneHome(page, query);
  await click(page, tid("phone-more"));
  await click(page, tid(`phone-lane-${lane}`));
  await page.locator(`${tid("phone-cockpit")}[data-surface="buddy"]`).waitFor({ timeout: 4000 });
  await sleep(900);
}
async function phoneDrawer(page) {
  await phoneHome(page);
  await click(page, tid("phone-more"));
  await page.locator(tid("phone-drawer")).waitFor({ timeout: 4000 });
  await sleep(500);
}

// Hub view (HP5/HP6): the sidebar RiffBot row opens ONE view: the Riff/Overlord TVs band on top, one full-height squad floor
// below (the lift's < > page the floors). `query` reloads the demo first (e.g. "&riff=1" for a live RiffBot + Overlord).
async function toHub(page, query = "") {
  if (query) await reload(page, query);
  await toHubPage(page);
  await page.locator(tid("sq-floor-page")).waitFor({ timeout: 8000 });
  await sleep(900);
}
async function toSkyRiff(page, waitMs) {
  await toHub(page, "&riff=1");
  await click(page, `${tid("sky-face-hit-riffbot")}:visible`);
  await sleep(waitMs);
  // RS-b..d: the slam is clock-driven (rAF writes --slam-swing / --slam-body-a, the panel carries .is-slam-fx), so there is no animationend: it is over when the fx class and both vars are gone. Auditing mid-fade samples the see-through body (false contrast hits).
  await page.waitForFunction(() => !document.querySelector(".sky-chat-panel.is-slam-fx") && !/--slam-(swing|body-a)/.test(document.querySelector(".sky-zones")?.style.cssText ?? ""), null, { timeout: 8000 });
}
// Lift call button on the floor: floor n is reached with n presses of "next" (HP6: needs a squad with 3+ teams).
async function toFloor(page, n) {
  await toHub(page);
  for (let i = 0; i < n; i++) { await vis(page, tid("sq-floor-next")).evaluate((el) => el.click(), null, { timeout: 6000 }); await sleep(1300); } // the lift ride animates; give it time to settle
}

// Sidebar Needs-you rows in their HOVER state (the row menu opens on hover): the role name must not truncate and the open menu must sit
// inside every clipping ancestor (the spine scroller). The rest state is measured too. (5244b82 shipped a clipped menu + ellipsized
// "Overlord" because the probe never hovered the row.)
// ui:overlap sets this to "&shortrole=1" in run() (its probe needs the 8-char role); ui:clicks shares the surface with the plain demo (the extra agent adds a floor blip that overlaps another one).
let NEEDS_QUERY = "";
export const setNeedsQuery = (q) => { NEEDS_QUERY = q; };
async function toSidebarNeeds(page) {
  await reload(page, NEEDS_QUERY); // with shortrole the demo adds a Needs-you row titled "Overlord" (the 8-char role the live scout saw ellipsized)
  await toHubPage(page);
  await expandSidebar(page);
  await page.locator(".sidebar .boring-needs-item").locator("visible=true").first().waitFor({ timeout: 8000 });
  await sleep(300);
}
const SHORT_ROLE = 8; // a role name this short or shorter ("Overlord", "Lead 37") must never truncate, in any state (styles.css .boring-needs-who min-width: 8ch)
async function checkSidebarNeedsRows(page) {
  const rows = page.locator(".sidebar .boring-needs-item");
  const n = await rows.count();
  const hits = [];
  let sawOverlord = false, sawLead37 = false;
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    let restCw = 0;
    // NO scrollIntoView: a half-visible last row must be measured where it sits (its menu used to be clipped there).
    for (const state of ["rest", "rest-narrow", "row-hover", "menu-open", "focus"]) {
      await page.mouse.move(2, 2);
      // rest-narrow: the live spine is ~5px narrower than the demo's (148 vs 153 at 1280: "Lead 37" 50 > 49 live while it fits here), so shave 5px off it and re-measure at rest
      const narrow = state === "rest-narrow" ? await page.addStyleTag({ content: ".sidebar-needs-spine{margin-right:11px!important}" }) : null;
      await page.evaluate(() => document.activeElement?.blur?.());
      if (state === "row-hover") await row.locator(".boring-needs-why").hover({ timeout: 3000, force: true }).catch(() => {});
      if (state === "menu-open") await row.locator(".boring-needs-more").hover({ timeout: 3000, force: true }).catch(() => {}); // the menu opens on the wrap's :hover
      if (state === "focus") await row.locator(".boring-needs-menu-item").first().focus().catch(() => {});
      await sleep(120);
      const m = await row.evaluate((el) => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
        const who = el.querySelector(".boring-needs-who");
        const menu = el.querySelector(".boring-needs-menu");
        const fixed = !!menu && getComputedStyle(menu).position === "fixed"; // a fixed menu escapes the scroller: only the viewport (and the sidebar's width) clips it
        const clip = { l: 0, t: 0, r: innerWidth, b: innerHeight };
        const sb = el.closest(".sidebar")?.getBoundingClientRect();
        if (sb) { clip.r = Math.min(clip.r, sb.right); clip.l = Math.max(clip.l, sb.left); }
        if (!fixed) for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          const cs = getComputedStyle(a);
          const b = a.getBoundingClientRect();
          if (cs.overflowX !== "visible") { clip.l = Math.max(clip.l, b.left); clip.r = Math.min(clip.r, b.right); }
          if (cs.overflowY !== "visible") { clip.t = Math.max(clip.t, b.top); clip.b = Math.min(clip.b, b.bottom); }
          if (a.classList.contains("sidebar")) break;
        }
        const shown = !!menu && getComputedStyle(menu).display !== "none";
        const why = el.querySelector(".boring-needs-why");
        return { who: who ? { sw: who.scrollWidth, cw: who.clientWidth, text: (who.textContent || "").trim(), box: r(who) } : null, menu: shown ? r(menu) : null, clip, items: shown ? [...menu.children].map(r) : [], whyShown: !!why && getComputedStyle(why).visibility !== "hidden", rowH: el.getBoundingClientRect().height };
      });
      if (narrow) await narrow.evaluate((n) => n.remove());
      if (!m.who) continue;
      if (m.who.text === "Overlord") sawOverlord = true;
      if (m.who.text === "Lead 37") sawLead37 = true;
      const short = m.who.text.length <= SHORT_ROLE;
      const base = { split: "ours", classes: ["boring-needs-who"], tag: "span", other: null };
      const trunc = { ...base, kind: "needs-row-truncated", selector: `.sidebar .boring-needs-who (row "${m.who.text}")`, text: m.who.text, box: m.who.box };
      if (state === "rest" || state === "rest-narrow") {
        if (state === "rest") restCw = m.who.cw;
        if (short && m.who.sw > m.who.cw) hits.push({ ...trunc, detail: `short role name truncated at ${state}: scrollWidth ${m.who.sw} > clientWidth ${m.who.cw}` });
      } else {
        if (m.who.cw < restCw - 0.5) hits.push({ ...trunc, detail: `role name loses width in ${state} state: clientWidth ${m.who.cw} < rest ${restCw} (scrollWidth ${m.who.sw})` });
        if (short && m.who.sw > m.who.cw) hits.push({ ...trunc, detail: `short role name truncated in ${state} state: scrollWidth ${m.who.sw} > clientWidth ${m.who.cw}` });
      }
      if (state === "row-hover" && !m.whyShown) hits.push({ ...base, classes: ["boring-needs-why"], tag: "div", kind: "needs-row-reason-hidden", selector: ".sidebar .boring-needs-why", text: m.who.text, detail: "plain row hover hides the reason line (only the open menu may cover it)", box: m.who.box });
      if (m.menu) {
        const right = Math.max(m.menu.right, ...m.items.map((x) => x.right));
        const bottom = Math.max(m.menu.bottom, ...m.items.map((x) => x.bottom));
        if (right > m.clip.r + 0.5 || m.menu.x < m.clip.l - 0.5 || bottom > m.clip.b + 0.5 || m.menu.y < m.clip.t - 0.5) hits.push({ ...base, classes: ["boring-needs-menu"], tag: "div", kind: "needs-row-menu-clipped", selector: ".sidebar .boring-needs-menu", text: "", detail: `row menu leaves the clip rect in ${state} state: menu x ${m.menu.x.toFixed(1)}..${right.toFixed(1)} y ${m.menu.y.toFixed(1)}..${bottom.toFixed(1)} vs clip x ${m.clip.l.toFixed(1)}..${m.clip.r.toFixed(1)} y ${m.clip.t.toFixed(1)}..${m.clip.b.toFixed(1)}`, box: m.menu });
      }
    }
  }
  if (NEEDS_QUERY && !sawLead37) hits.push({ split: "ours", classes: ["boring-needs-who"], tag: "span", other: null, kind: "needs-row-truncated", selector: ".sidebar .boring-needs-who", text: "Lead 37", detail: "probe fixture missing: no 'Lead 37' Needs-you row (demo ?shortrole=1)", box: { x: 0, y: 0, w: 1, h: 1 } });
  if (NEEDS_QUERY && !sawOverlord) hits.push({ split: "ours", classes: ["boring-needs-who"], tag: "span", other: null, kind: "needs-row-truncated", selector: ".sidebar .boring-needs-who", text: "Overlord", detail: "probe fixture missing: no 'Overlord' Needs-you row (demo ?shortrole=1) so the short-role case went unmeasured", box: { x: 0, y: 0, w: 1, h: 1 } });
  await page.mouse.move(2, 2);
  return hits;
}

const COMPOSER_ROOTS = ['footer.composer', tid("drawer-subagents-bar"), tid("drawer-config-menu-btn")];

// `mobile`: undefined = same setup as desktop, function = alternate route, false = "no mobile route".
export const SURFACES = [
  { id: "squads-home", setup: toSquadsHome, mobile: phoneDrawer, mobileRoots: [tid("phone-drawer")] }, // closest phone analogue: the "..." drawer with the Teams list (the squad pill is disabled with one squad)
  { id: "squad-full", setup: toFullPlumbing, mobile: (p) => phoneHome(p) }, // full plumbing header: quick chips (Bugs/Workflows), FULL toggle, usage chip
  { id: "focus-brainstorm", setup: toFocus, mobile: (p) => phoneBuddy(p, "vibesquad") },
  { id: "composer", setup: toFocus, roots: COMPOSER_ROOTS, mobile: (p) => phoneBuddy(p, "vibesquad") },
  {
    id: "focus-brainstorm-hot", // token bar in warn state (115K/150K, the owner's R1 shot) via demo fixture ?bsUsed=
    setup: async (p) => { await reload(p, "&bsUsed=115000"); await toFocus(p); },
    after: async (p) => { await reload(p); },
    mobile: (p) => phoneBuddy(p, "vibesquad", "&bsUsed=115000"),
  },
  { id: "focus-lead", setup: async (p) => { await toFocus(p); await click(p, tid("pin-team-lead")); await sleep(700); }, mobile: (p) => phoneTab(p, "overlord") },
  { id: "focus-worker", setup: async (p) => { await toFocus(p); await click(p, tid("pin-team-worker-demo-art-o")); await sleep(700); }, mobile: (p) => phoneTab(p, "riffbot") },
  { id: "hub", setup: (p) => toHub(p), mobile: false },
  { id: "sky-idle", setup: (p) => toHub(p), mobile: false }, // no live RiffBot / Overlord: the "Spin Up" TVs
  { id: "sky-rest", setup: (p) => toHub(p, "&riff=1"), after: async (p) => { await reload(p); }, mobile: false },
  { id: "sky-riff-open", setup: (p) => toSkyRiff(p, 700), after: async (p) => { await reload(p); }, mobile: false },
  { id: "sky-riff-landed", setup: (p) => toSkyRiff(p, 4500), after: async (p) => { await reload(p); }, mobile: false },
  { id: "hub-floor-1", setup: (p) => toFloor(p, 0), mobile: false },
  { id: "hub-floor-2", setup: (p) => toFloor(p, 1), mobile: false },
  { id: "hub-floor-3", setup: (p) => toFloor(p, 2), mobile: false }, // squad needs 3+ teams in src/demo.tsx
  { id: "rail-squads-icon", setup: toFocus, roots: [tid("pin-focus-bar")], mobile: false },
  { id: "settings", setup: async (p) => { await reset(p); await click(p, tid("sidebar-settings-btn")); await p.locator(tid("settings-pane")).waitFor({ timeout: 6000 }); await sleep(600); }, mobile: false },
  { id: "menu-drawer-config", setup: async (p) => { await toFocus(p); await click(p, tid("drawer-config-menu-btn")); await sleep(400); }, mobile: false },
  { id: "menu-drawer-more", setup: async (p) => { await toFocus(p); await click(p, tid("drawer-more-toggle")); await sleep(400); }, mobile: false },
  { id: "menu-pin-tile", setup: async (p) => { await toHubPage(p); await expandSidebar(p); await openSidebarPinMenu(p); await sleep(400); }, mobile: false }, // the sidebar pin menu
  { id: "sidebar-needs-hover", setup: toSidebarNeeds, check: checkSidebarNeedsRows, checkOnly: true, after: async (p) => { await reload(p); }, roots: [".sidebar .boring-needs-you"], mobile: false }, // Needs-you rows at rest / hover / menu-open
  { id: "modal-command-palette", setup: async (p) => { await reset(p); await p.keyboard.press("Control+k"); await p.locator(tid("command-palette")).waitFor({ timeout: 4000 }); await sleep(300); }, mobile: false },
  { id: "modal-new-squad", setup: async (p) => { await reset(p); await click(p, tid("sidebar-new-squad-btn")); await sleep(600); }, mobile: false },
  { id: "modal-diagnostics", setup: async (p) => { await reset(p); await click(p, tid("open-diagnostics-btn")); await p.locator(tid("diagnostics-modal")).waitFor({ timeout: 4000 }); await sleep(500); }, mobile: false },
];

// Normal mode (html[data-vibe=boring], BoringAde): sidebar, topbar/breadcrumb, context panel, timeline. No mobile route (PhoneCockpit).
async function toBoringHome(page) {
  await reload(page);
  await page.locator(tid("boring-app")).waitFor({ timeout: 10000 });
  await page.locator(tid("boring-sidebar")).waitFor({ timeout: 6000 });
  await sleep(500);
}
async function toBoringLane(page) {
  await toBoringHome(page);
  await click(page, tid("boring-worker-demo-aud")); // a live worker: opens its chat + timeline + context panel
  await page.locator(tid("boring-chat-column")).waitFor({ timeout: 8000 });
  await page.locator(".timeline").locator("visible=true").first().waitFor({ timeout: 8000 }).catch(() => {});
  await sleep(500);
}
export const BORING_SURFACES = [
  { id: "normal-home", setup: toBoringHome, mobile: false },
  { id: "normal-lane", setup: toBoringLane, mobile: false },
  { id: "normal-lane-context", setup: toBoringLane, roots: [tid("boring-context-panel")], mobile: false },
  { id: "normal-lane-timeline", setup: toBoringLane, roots: [".timeline-col"], mobile: false },
];

// Surfaces whose setup deliberately leaves a non-modal popover/menu/panel open: that layer is the top layer, so
// content beneath it is covered. A pair with one element inside the layer and the other outside is NOT an
// overlap (same idea as ui-clicks OPEN_LAYER); overlaps between elements inside the layer still are.
const OPEN_LAYER = {
  "menu-drawer-config": ".drawer-config-popover", // the ⚙ config popover floats over the drawer/timeline beneath it
  "menu-pin-tile": ".pin-menu-list", // the tile ⋯ row menu floats over the sidebar/tile beneath it
  "sky-riff-open": ".sky-chat-panel", // the riff chat panel overlays the dimmed floor behind it
  "sky-riff-landed": ".sky-chat-panel", // the landed riff chat panel overlays the dimmed floor behind it
};

// ── Per-surface audit ────────────────────────────────────────────────────────
const HIDE_TEXT = `*,*::before,*::after{-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;-webkit-text-stroke:0!important;transition:none!important;animation:none!important}`;

async function auditSurface(page, size, surf) {
  if (surf.checkOnly) return { hits: await surf.check(page), texts: [] }; // state probes only: the generic overlap/contrast audit of this region already runs on the hub surface
  const res = await page.evaluate(`(${AUDIT_SRC})(${JSON.stringify({ tolerance: 2, rootSelectors: (size.mobile && surf.mobileRoots) || surf.roots || null, openLayer: OPEN_LAYER[surf.id] ?? null })})`);
  if (res.missing) return res;
  if (surf.check) res.hits.push(...(await surf.check(page)));
  // Pixel pass: text hidden → sample the real rendered background under every text box.
  const h = await page.addStyleTag({ content: HIDE_TEXT });
  await sleep(60);
  const png = await page.screenshot({ type: "png", animations: "disabled" });
  await h.evaluate((n) => n.remove());
  const img = decodePng(png);
  const geoSel = new Set(res.hits.filter((x) => x.kind === "decor-line").map((x) => x.selector));
  for (const t of res.texts) {
    // Symbol glyphs (⊞ ✓ ◀) count for the line check; colour-emoji glyphs ignore text-fill-color, so skip those.
    if (!/[A-Za-z0-9←-⋿■-◿]/.test(t.text) || /[\u{1F000}-\u{1FFFF}]/u.test(t.text)) continue;
    const s = sampleBox(img, t.box, size.dpr);
    if (!s) continue;
    const fg = parseColor(t.color);
    if (fg) {
      const a = fg.a * t.opacity;
      const r = fg.r * a + s.r * (1 - a), g = fg.g * a + s.g * (1 - a), b = fg.b * a + s.b * (1 - a);
      const cr = contrast(lum(r, g, b), lum(s.r, s.g, s.b));
      if (cr < 3) {
        res.hits.push({
          kind: "contrast", split: "art", selector: t.sel, classes: t.classes, tag: t.tag, text: t.text, other: null,
          detail: `contrast ${cr.toFixed(2)}:1 (text rgb(${[r, g, b].map(Math.round)}) on bg rgb(${[s.r, s.g, s.b].map(Math.round)}))`,
          box: t.box,
        });
      }
    }
    if (s.step >= 30 && !geoSel.has(t.sel)) {
      res.hits.push({
        kind: "decor-suspect", split: "art", selector: t.sel, classes: t.classes, tag: t.tag, text: t.text, other: null,
        detail: `WARN: background steps ${s.step.toFixed(0)} luminance across the text line (row ${s.stepRow.toFixed(1)}px into text): a bar edge / line / sprite edge may run through the text`,
        box: t.box,
      });
    }
  }
  return res;
}

function allowed(hit) {
  for (const a of ALLOW) {
    if (a.kind && a.kind !== hit.kind) continue;
    const hay = `${hit.selector} ${hit.classes.join(" ")}`;
    const hayO = hit.other ? `${hit.other.selector} ${hit.other.classes.join(" ")}` : "";
    if (a.selector && !new RegExp(a.selector).test(hay)) continue;
    if (a.other && !new RegExp(a.other).test(hayO)) continue;
    if (a.text && !new RegExp(a.text, "i").test(hit.text)) continue;
    if (a.surface && !new RegExp(a.surface).test(hit.surface ?? "")) continue;
    return a.reason;
  }
  return null;
}

async function cropShot(page, box, file, size) {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  const pad = 28;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const clip = { x, y, width: Math.min(size.w - x, Math.max(box.w, 8) + pad * 2), height: Math.min(size.h - y, Math.max(box.h, 8) + pad * 2) };
  if (clip.width < 4 || clip.height < 4) return null;
  await page.evaluate((bx) => {
    const d = document.createElement("div");
    d.id = "__ovl_mark";
    Object.assign(d.style, { position: "fixed", left: bx.x + "px", top: bx.y + "px", width: bx.w + "px", height: bx.h + "px", outline: "2px solid #ff00d4", pointerEvents: "none", zIndex: 2147483647 });
    document.body.appendChild(d);
  }, box);
  try {
    await page.screenshot({ path: file, clip });
  } finally {
    await page.evaluate(() => document.getElementById("__ovl_mark")?.remove());
  }
  return file;
}

// ── Main ─────────────────────────────────────────────────────────────────────
export async function run(opts = {}) {
  const sizeIds = (opts.sizes ?? arg("sizes", "4k,1080,800,mobile")).split(",");
  const themes = (opts.themes ?? arg("themes", "dark,light")).split(",");
  const only = (opts.surfaces ?? arg("surfaces", "")).split(",").filter(Boolean);
  const outDir = path.resolve(REPO, opts.out ?? arg("out", "scratch/ui-overlap"));
  const shotDir = path.resolve(REPO, opts.shots ?? arg("shots", "scratch/shots"));
  const vibeArg = opts.vibe ?? arg("vibe", "both");
  const vibes = vibeArg === "both" ? ["fun", "boring"] : vibeArg.split(",");
  for (const v of vibes) if (v !== "fun" && v !== "boring") throw new Error(`unknown --vibe ${v} (boring|fun|both)`);
  const maxShots = Number(arg("max-shots", "260"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  if (flag("rebuild")) process.env.UI_OVERLAP_REBUILD = "1";
  NEEDS_QUERY = "&shortrole=1";

  const pw = E.resolvePlaywright({ npx: true });
  const exe = E.findBrowser();
  if (!pw || !exe) throw new Error(!pw ? E.PLAYWRIGHT_MISSING : "No Edge/Chrome found (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)");
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  BASE = baseUrl;
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });

  const uniq = new Map(); // kind|selector|other -> unique hit with occurrences
  const skipped = [];
  const noRoute = new Set();
  const known = Object.fromEntries(KNOWN.map((k) => [k.id, { id: k.id, what: k.what, hitKeys: new Set(), sizes: new Set(), targetShots: [], crop: null }]));
  let shots = 0, surfaceRuns = 0;
  const t0 = Date.now();

  try {
    for (const sid of sizeIds) {
      const size = SIZES[sid];
      if (!size) throw new Error(`unknown size ${sid}`);
      for (const vibe of vibes) for (const theme of themes) {
        const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: size.dpr, colorScheme: theme });
        await ctx.addInitScript(`try { localStorage.setItem("vs.vibeMigratedNormal", "1"); const p = JSON.parse(localStorage.getItem("vs.prefs.v1") || "{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({ ...p, "app.vibe": "${vibe}" })); } catch {}`); // B9: Normal is the default; --vibe picks Psycho (fun) and/or Normal (boring)
        await E.installRoutes(ctx);
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
        await reload(page);
        for (const surf of vibe === "boring" ? BORING_SURFACES : SURFACES) {
          if (only.length && !only.includes(surf.id)) continue;
          let setup = surf.setup;
          if (size.mobile) {
            if (surf.mobile === false) { noRoute.add(surf.id); continue; }
            if (typeof surf.mobile === "function") setup = surf.mobile;
          }
          try {
            await setup(page);
          } catch (e) {
            skipped.push({ surface: surf.id, size: sid, theme, reason: String(e?.message ?? e).split("\n")[0].slice(0, 160) });
            if (surf.after) await surf.after(page).catch(() => {});
            continue;
          }
          surfaceRuns++;
          // Known-hit target crops at the two big sizes, so "not reproduced" is backed by a picture.
          if (sid === "4k" || sid === "1080") {
            for (const k of KNOWN) {
              for (const tgt of k.targets ?? []) {
                if (tgt.surface !== surf.id) continue;
                const loc = page.locator(tgt.selector).first();
                if (!(await loc.count())) continue;
                const bb = await loc.boundingBox().catch(() => null);
                if (!bb) continue;
                const f = path.join(shotDir, `v1a-known-${k.id}-${surf.id}-${sid}-${theme}.png`);
                const pad = 30, x = Math.max(0, bb.x - pad), y = Math.max(0, bb.y - pad);
                await page.screenshot({ path: f, clip: { x, y, width: Math.min(size.w - x, bb.width + 2 * pad), height: Math.min(size.h - y, bb.height + 2 * pad) } }).catch(() => {});
                known[k.id].targetShots.push(f);
              }
            }
          }
          let res;
          try {
            res = await auditSurface(page, size, surf);
          } catch (e) {
            skipped.push({ surface: surf.id, size: sid, theme, reason: `audit failed: ${String(e?.message ?? e).split("\n")[0]}` });
            if (surf.after) await surf.after(page).catch(() => {});
            continue;
          }
          if (res.missing) skipped.push({ surface: surf.id, size: sid, theme, reason: "surface roots not on screen" });
          for (const h of res.hits ?? []) {
            h.surface = surf.id;
            const key = `${h.kind}|${h.selector}|${h.other?.selector ?? ""}`;
            let u = uniq.get(key);
            if (!u) {
              u = {
                id: 0, kind: h.kind, split: h.split, warn: WARN_KINDS.has(h.kind), selector: h.selector, other: h.other, tag: h.tag, text: h.text, classes: h.classes,
                detail: h.detail, allowed: allowed(h), occurrences: [], shot: null, known: [], first: { surface: h.surface, size: sid, theme },
              };
              uniq.set(key, u);
              if (!u.allowed && shots < maxShots) {
                const name = `v1a-${String(uniq.size).padStart(3, "0")}-${h.kind}-${sid}-${theme}-${h.surface}.png`;
                u.shot = await cropShot(page, h.box, path.join(shotDir, name), size).catch(() => null);
                if (u.shot) shots++;
              }
            }
            if (!u.occurrences.some((o) => o.surface === h.surface && o.size === sid && o.theme === theme)) u.occurrences.push({ surface: h.surface, size: sid, theme });
            for (const kid of matchKnown(h)) {
              u.known.includes(kid) || u.known.push(kid);
              known[kid].hitKeys.add(key);
              known[kid].sizes.add(sid);
              if (!known[kid].crop) {
                known[kid].crop = await cropShot(page, h.box, path.join(shotDir, `v1a-known-${kid}-hit-${sid}-${theme}-${h.surface}.png`), size).catch(() => null);
              }
            }
          }
          process.stderr.write(`  ${surf.id} ${sid} ${theme}: ${res.hits?.length ?? 0} raw hits\n`);
          if (surf.after) await surf.after(page).catch(() => {});
        }
        if (pageErrors.length) skipped.push({ surface: "*", size: sid, theme, reason: `page errors: ${pageErrors.slice(0, 2).join(" | ")}` });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Known (owner-reported) hits always fail the guard, even when only the pixel check sees them.
  for (const u of uniq.values()) if (u.known.length && u.warn) { u.warn = false; u.promoted = true; }
  const hits = [...uniq.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.selector.localeCompare(b.selector));
  const idOf = new Map();
  hits.forEach((h, i) => {
    h.id = i + 1;
    idOf.set(`${h.kind}|${h.selector}|${h.other?.selector ?? ""}`, h.id);
    h.cssRefs = cssRefs([...h.classes, ...(h.other?.classes ?? [])]);
    h.srcRefs = tsxRefs(h.selector, h.classes);
  });
  const counts = (list) => {
    const byKind = {}, bySplit = { ours: 0, art: 0 }, byKindSplit = {};
    for (const h of list) {
      byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
      bySplit[h.split]++;
      byKindSplit[`${h.kind}/${h.split}`] = (byKindSplit[`${h.kind}/${h.split}`] ?? 0) + 1;
    }
    return { total: list.length, byKind, bySplit, byKindSplit };
  };
  const failing = hits.filter((h) => !h.allowed && !h.warn);
  const warns = hits.filter((h) => !h.allowed && h.warn);
  const report = {
    generatedAt: new Date().toISOString(), sizes: sizeIds, themes, surfaceRuns, seconds: Math.round((Date.now() - t0) / 1000),
    totals: { uniqueFailing: failing.length, uniqueWarn: warns.length, allowed: hits.filter((h) => h.allowed).length, failing: counts(failing), warn: counts(warns) },
    known: Object.values(known).map((k) => ({ id: k.id, what: k.what, status: k.hitKeys.size ? "found (fails guard)" : "not-reproduced", sizes: [...k.sizes], hitIds: [...k.hitKeys].map((x) => idOf.get(x)), crop: k.crop, shots: k.targetShots })),
    noMobileRoute: [...noRoute], skipped, hits,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMd(report));
  return report;
}

function renderMd(r) {
  const fmt = (c) => Object.entries(c.byKindSplit).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
  const L = [`# UI overlap guard report`, ``, `Generated ${r.generatedAt} in ${r.seconds}s. Sizes: ${r.sizes.join(", ")}; themes: ${r.themes.join(", ")}; ${r.surfaceRuns} surface runs. Hits are UNIQUE (same selector+kind merged across theme/size/surface).`, ``];
  L.push(`**${r.totals.uniqueFailing} failing unique hits** (ours ${r.totals.failing.bySplit.ours} / @art ${r.totals.failing.bySplit.art}); ${r.totals.uniqueWarn} warn-only decor-suspect (ours ${r.totals.warn.bySplit.ours} / @art ${r.totals.warn.bySplit.art}); ${r.totals.allowed} allow-listed.`, ``);
  L.push(`Failing by kind/split: ${fmt(r.totals.failing)}`, ``, `Warn by kind/split: ${fmt(r.totals.warn)}`, ``);
  L.push(`## Known hits`, ``, `| id | what | status | sizes | hit ids | crop |`, `|---|---|---|---|---|---|`);
  for (const k of r.known) L.push(`| ${k.id} | ${k.what} | ${k.status} | ${k.sizes.join(", ") || "-"} | ${k.hitIds.slice(0, 8).join(", ") || "-"} | ${k.crop ?? "-"} |`);
  L.push(``);
  for (const k of r.known.filter((x) => x.status === "not-reproduced")) L.push(`- ${k.id} NOT REPRODUCED; shots: ${k.shots.join(", ") || "(target not on screen)"}`);
  if (r.noMobileRoute.length) L.push(``, `## No mobile route (390x844)`, ``, ...r.noMobileRoute.map((s) => `- ${s}: no mobile route`));
  if (r.skipped.length) {
    L.push(``, `## Skipped / failed surface runs`, ``);
    for (const s of r.skipped) L.push(`- ${s.surface} ${s.size} ${s.theme}: ${s.reason}`);
  }
  L.push(``, `## Hits`, ``);
  for (const h of r.hits) {
    L.push(`### #${h.id} ${h.kind} [${h.split}]${h.warn ? " WARN" : ""}${h.allowed ? " (allow-listed: " + h.allowed + ")" : ""}${h.known?.length ? " KNOWN:" + h.known.join(",") : ""}`);
    L.push(`- occurs: ${h.occurrences.map((o) => `${o.surface}@${o.size}/${o.theme}`).join(", ")}`);
    L.push(`- selector: \`${h.selector}\`${h.text ? ` text "${h.text}"` : ""}`);
    if (h.other) L.push(`- other: \`${h.other.selector}\`${h.other.text ? ` "${h.other.text}"` : ""}`);
    L.push(`- ${h.detail}`);
    const refs = [...h.cssRefs, ...h.srcRefs];
    if (refs.length) L.push(`- source: ${refs.join("; ")}`);
    if (h.shot) L.push(`- shot (first occurrence ${h.first.surface}@${h.first.size}/${h.first.theme}): ${h.shot}`);
    L.push(``);
  }
  return L.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((r) => {
      const t = r.totals;
      console.log(`ui-overlap: ${t.uniqueFailing} failing unique hits (ours ${t.failing.bySplit.ours} / art ${t.failing.bySplit.art}), ${t.uniqueWarn} warn (decor-suspect), ${t.allowed} allow-listed, ${r.seconds}s`);
      console.log(JSON.stringify(t.failing.byKindSplit));
      for (const k of r.known) console.log(`  known ${k.id}: ${k.status} [${k.sizes.join(",")}]`);
      console.log(`no mobile route: ${r.noMobileRoute.join(", ") || "-"}; skipped runs: ${r.skipped.length}`);
      console.log(`report: scratch/ui-overlap/report.md`);
      process.exit(t.uniqueFailing > 0 && !flag("no-fail") ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(2); });
}
