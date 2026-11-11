// U1 UI click matrix (docs/PLAN_V03_STABILIZE.md wave 4). Reuses the overlap guard's harness (env.mjs, SURFACES) and,
// for every surface, enumerates controls from the DOM (button, a, input, select, textarea, role=button/tab/menuitem...,
// [aria-haspopup], [aria-expanded]) and checks:
//   hit-mismatch    the centre of a visible control does not hit-test (elementFromPoint) to the control or a descendant/ancestor
//   popover-clipped an opened popover/menu (new fixed/absolute layer after clicking a popup trigger) is not fully inside the viewport
//                   or is cut by an overflow ancestor; its own controls are hit-tested too.
// Measures the built dist/ (vite build + static server), never the dev server.
//
//   node scripts/ui-clicks.mjs [--sizes 1080,4k,mobile] [--themes dark,light] [--surfaces a,b] [--out scratch/ui-clicks]
//                              [--no-popovers] [--no-fail] [--rebuild]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "./ui-overlap/env.mjs";
import * as O from "./ui-overlap.mjs";
import { cssRefs, tsxRefs } from "./ui-overlap/source-map.mjs";

const REPO = E.REPO_ROOT;
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = {
  "1080": { w: 1920, h: 1080, dpr: 1, label: "1920x1080" },
  "4k": { w: 3200, h: 1800, dpr: 1.2, label: "3840x2160@1.2" },
  mobile: { w: 390, h: 844, dpr: 1, label: "390x844", mobile: true },
};

// ── Phone cockpit surfaces (390px mounts only <PhoneCockpit />; the desktop routes in SURFACES do not exist there) ──────
const tidq = (id) => `[data-testid="${id}"]`;
const phoneLoad = async (p, q = "") => { await p.goto(`${baseUrlRef.v}/?demo=1${q}`, { waitUntil: "domcontentloaded", timeout: 30000 }); await p.locator(tidq("phone-cockpit")).waitFor({ timeout: 8000 }); await sleep(900); };
const phoneClick = async (p, id) => { await p.locator(tidq(id)).first().click({ timeout: 4000 }); await sleep(500); };
const baseUrlRef = { v: "" };
const PHONE_SURFACES = [
  { id: "phone-home", setup: (p) => phoneLoad(p) },
  { id: "phone-menu", setup: async (p) => { await phoneLoad(p); await phoneClick(p, "phone-more"); } },
  { id: "phone-overlord-chat", setup: (p) => phoneLoad(p, "&riff=1") },
  { id: "phone-riffbot-chat", setup: async (p) => { await phoneLoad(p, "&riff=1"); await phoneClick(p, "phone-tab-riffbot"); } },
  { id: "phone-riffbot-empty", setup: async (p) => { await phoneLoad(p); await phoneClick(p, "phone-tab-riffbot"); } },
  { id: "phone-menu-restart", setup: async (p) => { await phoneLoad(p); await phoneClick(p, "phone-more"); await phoneClick(p, "phone-restart-btn"); } },
  { id: "phone-buddy", setup: async (p) => { await phoneLoad(p, "&riff=1"); await phoneClick(p, "phone-more"); await p.locator('[data-testid^="phone-lane-"]').first().click({ timeout: 4000 }); await sleep(700); } },
];

// Both states of each rail (idea-47: collapsed vs expanded). Built on the overlap guard's own routes.
const surfById = (id) => O.SURFACES.find((x) => x.id === id).setup;
const railClick = async (p, id) => { const l = p.locator(tidq(id)).locator("visible=true").first(); await l.waitFor({ state: "visible", timeout: 4000 }); await l.click({ timeout: 4000 }); await sleep(500); };
const RAIL_SURFACES = [
  { id: "rail-sidebar-toggled-grid", setup: async (p) => { await surfById("pin-grid-usage")(p); await railClick(p, "sidebar-collapse-toggle"); } },
  { id: "rail-sidebar-toggled-focus", setup: async (p) => { await surfById("focus-brainstorm")(p); await railClick(p, "sidebar-collapse-toggle"); } },
  { id: "rail-pin-toggled-focus", setup: async (p) => { await surfById("focus-brainstorm")(p); await railClick(p, "pin-rail-collapse-toggle"); } },
  { id: "rail-both-toggled-focus", setup: async (p) => { await surfById("focus-brainstorm")(p); await railClick(p, "sidebar-collapse-toggle"); await railClick(p, "pin-rail-collapse-toggle"); } },
  { id: "rail-sidebar-toggled-hub", setup: async (p) => { await surfById("hub")(p); await railClick(p, "sidebar-collapse-toggle"); } },
];

// ── In-page probes (function expressions, evaluated with JSON args) ──────────────────────────
const PROBES = String.raw`(() => {
  const vw = innerWidth, vh = innerHeight;
  const CONTROLS = 'button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=switch],[role=checkbox],[role=radio],[aria-haspopup],[tabindex]:not([tabindex="-1"])';
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity) === 0) return false;
    }
    // Content of a closed <details> is not rendered (only its first summary is).
    for (let d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) {
      const sum = d.querySelector(':scope > summary');
      if (!(sum && (sum === el || sum.contains(el)))) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const path = (el) => {
    const parts = [];
    for (let n = el, d = 0; n && n.nodeType === 1 && n !== document.body && d < 4; n = n.parentElement, d++) {
      let s = n.tagName.toLowerCase();
      const tid = n.getAttribute('data-testid');
      if (tid) { parts.unshift(s + '[data-testid="' + tid + '"]'); break; }
      const cls = [...n.classList].slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  // Region of the page the element can actually show in: viewport intersected with every overflow-clipping ancestor
  // (fixed elements skip ancestors that are not their containing block).
  const clipRect = (el) => {
    let l = 0, t = 0, r = vw, b = vh;
    let fixed = cs(el).position === 'fixed';
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = cs(n);
      if (fixed) { if (s.transform !== 'none' || s.filter !== 'none' || s.contain.includes('paint')) fixed = false; else continue; }
      if (s.position === 'fixed') fixed = true;
      const clips = (v) => v !== 'visible';
      if (clips(s.overflowX) || clips(s.overflowY) || s.contain.includes('paint') || s.clipPath !== 'none') {
        const nr = n.getBoundingClientRect();
        if (clips(s.overflowX) || s.contain.includes('paint')) { l = Math.max(l, nr.left); r = Math.min(r, nr.right); }
        if (clips(s.overflowY) || s.contain.includes('paint')) { t = Math.max(t, nr.top); b = Math.min(b, nr.bottom); }
      }
    }
    return { l, t, r, b };
  };
  const OVERLAY = '.modal-back,.modal,[role=dialog],[aria-modal=true],[class*=popover],[class*=-menu],[class*=menu-],.phone-drawer,[data-testid=settings-pane],[data-testid=command-palette],[data-testid=diagnostics-modal]';
  const dup = (el) => [el.tagName.toLowerCase(), el.id, el.getAttribute('data-testid')].join('|');
  // Hit-test the centre of each visible control. Controls whose centre sits outside the clip region (scrolled away) are skipped.
  const hitTest = (rootEls) => {
    const out = [];
    const seen = new Set();
    let n = 0;
    const pool = rootEls ? rootEls.flatMap((r) => [r, ...r.querySelectorAll(CONTROLS)].filter((e) => e.matches(CONTROLS))) : [...document.querySelectorAll(CONTROLS)];
    for (const el of pool) {
      if (seen.has(el)) continue; seen.add(el);
      if (!visible(el)) continue;
      if (el.closest('[inert],[aria-hidden=true]') && !el.matches('[role=button],button')) continue;
      const s = cs(el);
      if (s.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const c = clipRect(el);
      if (cx < c.l || cx > c.r || cy < c.t || cy > c.b || cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      if (el.matches('input[type=checkbox],input[type=radio],input[type=file],input[type=range]') && r.width < 4) continue; // visually hidden native inputs behind a label
      n++;
      const t = document.elementFromPoint(cx, cy);
      if (t && (el === t || el.contains(t) || t.contains(el) && false)) continue;
      // Covered by an intentionally opened overlay (modal, settings pane, palette, menu, popover) that does not contain the control: not a bug.
      if (t && OVERLAY) { const ov = t.closest(OVERLAY); if (ov && !ov.contains(el)) continue; }
      // a wrapping label legitimately receives the click for its input
      if (t && el.matches('input') && (t.closest('label') === el.closest('label') && t.closest('label'))) continue;
      if (t && t.closest('label') && t.closest('label').control === el) continue;
      out.push({
        selector: path(el), tag: el.tagName.toLowerCase(), text: label(el), classes: [...el.classList],
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        other: t ? { selector: path(t), classes: [...t.classList], text: label(t) } : null,
      });
    }
    return { hits: out, count: n };
  };
  // Popup triggers: things that declare they open a layer.
  const triggers = () => {
    const els = [...document.querySelectorAll('[aria-haspopup],[aria-expanded]:not([aria-expanded=true]),button[class*=menu],button[class*=more],button[class*=chip],[data-testid*=menu],[data-testid*=more-toggle],[data-testid*=toggle]')];
    const seen = new Set(), out = [];
    for (const el of els) {
      if (seen.has(el) || !visible(el) || !el.matches('button,[role=button],summary,[aria-haspopup],a[href]')) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const r = el.getBoundingClientRect();
      const c = clipRect(el);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < c.l || cx > c.r || cy < c.t || cy > c.b || cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      const t = document.elementFromPoint(cx, cy);
      if (!t || !(el === t || el.contains(t))) continue;
      seen.add(el);
      out.push({ idx: seen.size - 1, sel: path(el), text: label(el), cx, cy, key: dup(el) + '|' + label(el) });
    }
    return out;
  };
  const snapshot = () => { window.__u1seen = new WeakSet(); for (const el of document.body.querySelectorAll('*')) if (visible(el)) window.__u1seen.add(el); };
  // After clicking a trigger: new visible layers (fixed/absolute or role menu/dialog/listbox) = popovers.
  const popovers = () => {
    // Roots of newly inserted subtrees (parent was already on screen). A layer root is a popover; a static wrapper only
    // counts when it is small (a menu wrapper), never when it is page content (a toggled view).
    const cand = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (window.__u1seen.has(el) || !visible(el)) continue;
      if (el.parentElement && !window.__u1seen.has(el.parentElement) && el.parentElement !== document.body) continue;
      const s = cs(el);
      const role = el.getAttribute('role');
      const layer = s.position === 'fixed' || s.position === 'absolute' || /^(menu|listbox|dialog|tooltip|alertdialog)$/.test(role || '');
      if (layer) { cand.push(el); continue; }
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 0.25 * vw * vh) cand.push(...[...el.children].filter((c) => visible(c) && ['fixed', 'absolute'].includes(cs(c).position)));
    }
    const tops = cand;
    const out = [];
    for (const el of tops) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 16) continue;
      const c = clipRect(el);
      const tol = 1;
      const issues = [];
      if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) issues.push('outside-viewport');
      if (r.left < c.l - tol || r.top < c.t - tol || r.right > c.r + tol || r.bottom > c.b + tol) {
        if (!issues.length || c.l > 0 || c.t > 0 || c.r < vw || c.b < vh) issues.push('cut-by-overflow-ancestor');
      }
      const ht = hitTest([el]);
      out.push({ selector: path(el), classes: [...el.classList], text: label(el), box: { x: r.left, y: r.top, w: r.width, h: r.height }, issues, hits: ht.hits, count: ht.count, ctl: ht.count });
    }
    return out;
  };
  return { hitTest, triggers, snapshot, popovers };
})()`;

async function probe(page, expr) { return page.evaluate(`(() => { const P = window.__u1 ?? (window.__u1 = ${PROBES}); return (${expr}); })()`); }

async function closeLayers(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(120);
}

export async function run() {
  const sizeIds = arg("sizes", "1080,4k,mobile").split(",");
  const themes = arg("themes", "dark,light").split(",");
  const only = arg("surfaces", "").split(",").filter(Boolean);
  const maxTrig = Number(arg("max-triggers", "14"));
  const outDir = path.resolve(REPO, arg("out", "scratch/ui-clicks"));
  fs.mkdirSync(outDir, { recursive: true });
  if (flag("rebuild")) process.env.UI_OVERLAP_REBUILD = "1";
  const pw = E.resolvePlaywright();
  const exe = E.findBrowser();
  if (!pw || !exe) throw new Error("Playwright or Edge/Chrome not found (PLAYWRIGHT_DIR / PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)");
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  O.setBase(baseUrl);
  baseUrlRef.v = baseUrl;
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });

  const uniq = new Map();
  const combos = {};
  const skipped = [];
  let controls = 0, popoversSeen = 0;
  const t0 = Date.now();
  const record = (combo, surface, kind, h, extra = {}) => {
    const key = `${kind}|${h.selector}|${h.other?.selector ?? ""}|${extra.popover ?? ""}`;
    let u = uniq.get(key);
    if (!u) { u = { kind, selector: h.selector, classes: h.classes ?? [], text: h.text, other: h.other ?? null, detail: extra.detail ?? "", trigger: extra.trigger ?? null, popover: extra.popover ?? null, occurrences: [] }; uniq.set(key, u); }
    if (!u.occurrences.some((o) => o.combo === combo && o.surface === surface)) u.occurrences.push({ combo, surface });
    combos[combo] = (combos[combo] ?? new Set()).add(key);
  };

  try {
    for (const sid of sizeIds) {
      const size = SIZES[sid];
      if (!size) throw new Error(`unknown size ${sid}`);
      for (const theme of themes) {
        const combo = `${sid}/${theme}`;
        combos[combo] ??= new Set();
        const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: size.dpr, colorScheme: theme, ...(size.mobile ? { hasTouch: true } : {}) });
        await E.installRoutes(ctx);
        const page = await ctx.newPage();
        await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1800);
        for (const surf of size.mobile ? PHONE_SURFACES : [...O.SURFACES, ...RAIL_SURFACES]) {
          if (only.length && !only.includes(surf.id)) continue;
          const setup = surf.setup;
          // Rail/menu state persists in storage between surfaces (a probe click can collapse a rail): start each from a clean app.
          if (!size.mobile) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).then(() => page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 30000 })).then(() => page.waitForTimeout(1500)).catch(() => {});
          const redo = async () => { await setup(page); };
          try { await redo(); } catch (e) { skipped.push({ surface: surf.id, combo, reason: String(e?.message ?? e).split("\n")[0].slice(0, 140) }); if (surf.after) await surf.after(page).catch(() => {}); continue; }
          try {
            await page.evaluate("delete window.__u1");
            const base = await probe(page, "P.hitTest(null)");
            controls += base.count;
            for (const h of base.hits) record(combo, surf.id, "hit-mismatch", h, { detail: `centre hits ${h.other?.selector ?? "nothing"}` });
            if (!flag("no-popovers")) {
              const trigs = await probe(page, "P.triggers()");
              const sig = (await probe(page, "P.hitTest(null).count"));
              let n = 0;
              for (const t of trigs.slice(0, maxTrig)) {
                n++;
                // Re-find by key: layout may have shifted since enumeration.
                const cur = (await probe(page, "P.triggers()")).find((x) => x.key === t.key);
                if (!cur) { await redo().catch(() => {}); continue; }
                await probe(page, "P.snapshot()");
                await page.mouse.click(cur.cx, cur.cy).catch(() => {});
                await sleep(/sky/.test(t.sel) ? 4500 : 250); // the sky chat swings in over ~1-4s: judge it once landed
                const pops = await probe(page, "P.popovers()");
                for (const p of pops) {
                  popoversSeen++;
                  controls += p.ctl;
                  for (const i of p.issues) record(combo, surf.id, `popover-${i === "outside-viewport" ? "offscreen" : "clipped"}`, { selector: p.selector, classes: p.classes, text: p.text }, { trigger: `${t.sel} "${t.text}"`, popover: p.selector, detail: `box ${Math.round(p.box.x)},${Math.round(p.box.y)} ${Math.round(p.box.w)}x${Math.round(p.box.h)} vs ${size.w}x${size.h}: ${i}` });
                  for (const h of p.hits) record(combo, surf.id, "hit-mismatch", h, { trigger: `${t.sel} "${t.text}"`, popover: p.selector, detail: `in popover; centre hits ${h.other?.selector ?? "nothing"}` });
                }
                await closeLayers(page);
                const after = await probe(page, "P.hitTest(null).count").catch(() => -1);
                if (after !== sig) await redo().catch(() => {});
              }
            }
          } catch (e) {
            skipped.push({ surface: surf.id, combo, reason: `probe failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 140)}` });
          }
          process.stderr.write(`  ${surf.id} ${combo}: ${combos[combo].size} cumulative hits\n`);
          if (surf.after) await surf.after(page).catch(() => {});
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const hits = [...uniq.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.selector.localeCompare(b.selector));
  hits.forEach((h, i) => { h.id = i + 1; h.cssRefs = cssRefs([...h.classes, ...(h.other?.classes ?? [])]); h.srcRefs = tsxRefs(h.selector, h.classes); });
  const perCombo = Object.fromEntries(Object.entries(combos).map(([k, v]) => [k, v.size]));
  const report = { generatedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), controls, popoversSeen, perCombo, total: hits.length, skipped, hits };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMd(report));
  return report;
}

function renderMd(r) {
  const L = ["# UI click matrix", "", `Generated ${r.generatedAt} in ${r.seconds}s; ${r.controls} control hit-tests, ${r.popoversSeen} popovers opened.`, "", `**${r.total} unique hits.** Per combo: ${Object.entries(r.perCombo).map(([k, v]) => `${k}=${v}`).join(", ")}`, "", "| # | control | kind | combos / surfaces | source |", "|---|---|---|---|---|"];
  for (const h of r.hits) {
    const refs = [...h.cssRefs, ...h.srcRefs].slice(0, 3).join("; ");
    L.push(`| ${h.id} | \`${h.selector}\`${h.text ? ` "${h.text}"` : ""} | ${h.kind}${h.popover ? " (in popover)" : ""} | ${[...new Set(h.occurrences.map((o) => o.combo))].join(", ")} @ ${[...new Set(h.occurrences.map((o) => o.surface))].join(", ")} | ${refs} |`);
    if (h.detail || h.other || h.trigger) L.push(`|  | ${h.detail}${h.other ? ` other=\`${h.other.selector}\`` : ""}${h.trigger ? ` via ${h.trigger}` : ""} | | | |`);
  }
  if (r.skipped.length) L.push("", "## Skipped", "", ...r.skipped.map((s) => `- ${s.surface} ${s.combo}: ${s.reason}`));
  return L.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((r) => {
      console.log(`ui-clicks: ${r.total} unique hits; ${r.controls} hit-tests, ${r.popoversSeen} popovers, ${r.seconds}s`);
      console.log(`per combo: ${JSON.stringify(r.perCombo)}; skipped runs: ${r.skipped.length}`);
      console.log("report: scratch/ui-clicks/report.md");
      process.exit(r.total > 0 && !flag("no-fail") ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(2); });
}
