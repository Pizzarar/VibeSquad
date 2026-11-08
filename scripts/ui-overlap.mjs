// V1a overlap + contrast guard (docs/PLAN_OVERLAP_AUDIT_V1.md). Drives the demo app (?demo=1) in headless
// Edge/Chrome across surfaces x sizes x themes and flags: intersecting boxes, text overflow / truncation,
// edge clipping, decorative lines through text, and text contrast < 3:1.
//
//   node scripts/ui-overlap.mjs [--sizes 4k,1080,800,mobile] [--themes dark,light] [--surfaces a,b]
//                               [--out scratch/ui-overlap] [--shots scratch/shots] [--no-fail] [--rebuild]
//
// Exit 1 when any non-allow-listed hit remains (use --no-fail to just write the report).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "./ui-overlap/env.mjs";
import { decodePng, sampleBox, parseColor, lum, contrast } from "./ui-overlap/png.mjs";
import { cssRefs, tsxRefs } from "./ui-overlap/source-map.mjs";
import { KNOWN, matchKnown } from "./ui-overlap/known-hits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_SRC = fs.readFileSync(path.join(HERE, "ui-overlap", "page-audit.js"), "utf8");
const ALLOW = JSON.parse(fs.readFileSync(path.join(HERE, "ui-overlap", "allowlist.json"), "utf8")).allow;

export const SIZES = {
  "4k": { w: 3200, h: 1800, dpr: 1.2, label: "3840x2160@1.2 (3200x1800 css)" },
  "1080": { w: 1920, h: 1080, dpr: 1, label: "1920x1080" },
  "800": { w: 1280, h: 800, dpr: 1, label: "1280x800" },
  mobile: { w: 390, h: 844, dpr: 1, label: "390x844" },
};

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Surfaces ─────────────────────────────────────────────────────────────────
const SQUAD = "vibesquad";
const tid = (id) => `[data-testid="${id}"]`;
async function click(page, sel, ms = 4000) {
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: "visible", timeout: ms });
  await loc.click({ timeout: ms });
}
async function reset(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(2, 2).catch(() => {});
  await sleep(120);
}
async function toSquadsHome(page) {
  await reset(page);
  await page.getByRole("button", { name: "SQUADS", exact: true }).first().click({ timeout: 4000 });
  await page.locator(tid("squads-home")).waitFor({ timeout: 6000 });
  await sleep(500);
}
async function toPinGrid(page) {
  await toSquadsHome(page);
  await click(page, tid(`squad-home-tile-${SQUAD}`));
  await page.locator(tid("pin-grid")).waitFor({ timeout: 6000 });
  await sleep(500);
}
async function toFocus(page) {
  await toPinGrid(page);
  await click(page, tid(`pin-tile-${SQUAD}`));
  await page.locator(tid("drawer-head-compact")).waitFor({ timeout: 8000 });
  await sleep(700);
}

export const SURFACES = [
  { id: "squads-home", setup: toSquadsHome },
  { id: "pin-grid-usage", setup: toPinGrid },
  { id: "focus-brainstorm", setup: toFocus },
  { id: "focus-lead", setup: async (p) => { await toFocus(p); await click(p, tid("pin-team-lead")); await sleep(700); } },
  { id: "focus-worker", setup: async (p) => { await toFocus(p); await click(p, tid("pin-team-worker-demo-art-o")); await sleep(700); } },
  {
    id: "hub",
    setup: async (p) => {
      await toFocus(p);
      await click(p, tid("pin-rail-riffbot"));
      await sleep(1500);
    },
  },
  { id: "settings", setup: async (p) => { await reset(p); await click(p, tid("sidebar-settings-btn")); await p.locator(tid("settings-pane")).waitFor({ timeout: 6000 }); await sleep(600); } },
  { id: "menu-drawer-config", setup: async (p) => { await toFocus(p); await click(p, tid("drawer-config-menu-btn")); await sleep(400); } },
  { id: "menu-drawer-more", setup: async (p) => { await toFocus(p); await click(p, tid("drawer-more-toggle")); await sleep(400); } },
  { id: "menu-pin-tile", setup: async (p) => { await toPinGrid(p); await click(p, `${tid(`pin-tile-${SQUAD}`)} ${tid(`pin-menu-${SQUAD}`)}, ${tid(`pin-menu-${SQUAD}`)}`); await sleep(400); } },
  { id: "modal-command-palette", setup: async (p) => { await reset(p); await p.keyboard.press("Control+k"); await p.locator(tid("command-palette")).waitFor({ timeout: 4000 }); await sleep(300); } },
  { id: "modal-new-squad", setup: async (p) => { await reset(p); await click(p, tid("sidebar-new-squad-btn")); await sleep(600); } },
  { id: "modal-diagnostics", setup: async (p) => { await reset(p); await click(p, tid("open-diagnostics-btn")); await p.locator(tid("diagnostics-modal")).waitFor({ timeout: 4000 }); await sleep(500); } },
];

// ── Per-surface audit ────────────────────────────────────────────────────────
const HIDE_TEXT = `*,*::before,*::after{-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;-webkit-text-stroke:0!important;transition:none!important;animation:none!important}`;

async function auditSurface(page, size) {
  const res = await page.evaluate(`(${AUDIT_SRC})(${JSON.stringify({ tolerance: 2 })})`);
  // Pixel pass: text hidden → sample the real rendered background under every text box.
  await page.addStyleTag({ content: HIDE_TEXT }).then(async (h) => {
    await sleep(60);
    const png = await page.screenshot({ type: "png", animations: "disabled" });
    await h.evaluate((n) => n.remove());
    const img = decodePng(png);
    const byEl = new Map(res.hits.filter((h2) => h2.kind === "decor-line").map((h2) => [h2.selector, true]));
    for (const t of res.texts) {
      // Symbol glyphs (⊞ ✓ ◀) count for the line-through check; colour-emoji glyphs ignore text-fill-color, so skip those.
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
      if (s.step >= 30 && !byEl.has(t.sel)) {
        res.hits.push({
          kind: "decor-line", split: "art", selector: t.sel, classes: t.classes, tag: t.tag, text: t.text, other: null,
          detail: `background steps ${s.step.toFixed(0)} luminance across the text line (row ${s.stepRow.toFixed(1)}px into text): a bar edge / line / sprite edge runs through the text`,
          box: t.box,
        });
      }
    }
  });
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

async function cropShot(page, hit, file, size) {
  const b = hit.box;
  if (!b || b.w <= 0 || b.h <= 0) return null;
  const pad = 28;
  const clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(size.w, Math.max(b.w, 8) + pad * 2), height: Math.min(size.h, Math.max(b.h, 8) + pad * 2) };
  clip.width = Math.min(clip.width, size.w - clip.x);
  clip.height = Math.min(clip.height, size.h - clip.y);
  if (clip.width < 4 || clip.height < 4) return null;
  await page.evaluate((bx) => {
    const d = document.createElement("div");
    d.id = "__ovl_mark";
    Object.assign(d.style, { position: "fixed", left: bx.x + "px", top: bx.y + "px", width: bx.w + "px", height: bx.h + "px", outline: "2px solid #ff00d4", pointerEvents: "none", zIndex: 2147483647 });
    document.body.appendChild(d);
  }, b);
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
  const maxShots = Number(arg("max-shots", "260"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  if (flag("rebuild")) process.env.UI_OVERLAP_REBUILD = "1";

  const pw = E.resolvePlaywright();
  const exe = E.findBrowser();
  if (!pw || !exe) throw new Error(!pw ? "Playwright not found (set PLAYWRIGHT_DIR)" : "No Edge/Chrome found (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)");
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });

  const hitMap = new Map(); // key -> aggregated hit
  const skipped = [];
  const known = Object.fromEntries(KNOWN.map((k) => [k.id, { ...k, found: [], matchers: undefined }]));
  let shots = 0, surfacesRun = 0;
  const t0 = Date.now();

  try {
    for (const sid of sizeIds) {
      const size = SIZES[sid];
      if (!size) throw new Error(`unknown size ${sid}`);
      for (const theme of themes) {
        const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: size.dpr, colorScheme: theme });
        await E.installRoutes(ctx);
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
        await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2200);
        for (const surf of SURFACES) {
          if (only.length && !only.includes(surf.id)) continue;
          const tag = `${surf.id} ${sid} ${theme}`;
          try {
            await surf.setup(page);
          } catch (e) {
            skipped.push({ surface: surf.id, size: sid, theme, reason: String(e?.message ?? e).split("\n")[0].slice(0, 160) });
            continue;
          }
          surfacesRun++;
          // Known-hit target shots (primary size only) so "not reproduced" is backed by a picture.
          if (sid === "4k" || sid === "1080") {
            for (const k of KNOWN) {
              for (const tgt of k.targets ?? []) {
                if (tgt.surface !== surf.id) continue;
                const loc = page.locator(tgt.selector).first();
                if (!(await loc.count())) continue;
                const f = path.join(shotDir, `v1a-known-${k.id}-${sid}-${theme}.png`);
                const bb = await loc.boundingBox().catch(() => null);
                if (!bb) continue;
                const pad = 30;
                await page.screenshot({ path: f, clip: { x: Math.max(0, bb.x - pad), y: Math.max(0, bb.y - pad), width: Math.min(size.w - Math.max(0, bb.x - pad), bb.width + 2 * pad), height: Math.min(size.h - Math.max(0, bb.y - pad), bb.height + 2 * pad) } }).catch(() => {});
                (known[k.id].targetShots ??= []).push(f);
              }
            }
          }
          let res;
          try {
            res = await auditSurface(page, size);
          } catch (e) {
            skipped.push({ surface: surf.id, size: sid, theme, reason: `audit failed: ${String(e?.message ?? e).split("\n")[0]}` });
            continue;
          }
          for (const h of res.hits) {
            h.surface = surf.id;
            const reason = allowed(h);
            const key = `${h.kind}|${h.selector}|${h.other?.selector ?? ""}|${sid}|${theme}`;
            const gkey = `${h.kind}|${h.selector}|${h.other?.selector ?? ""}`;
            let agg = hitMap.get(key);
            if (!agg) {
              agg = {
                id: 0, kind: h.kind, split: h.split, selector: h.selector, other: h.other, tag: h.tag, text: h.text, classes: h.classes,
                detail: h.detail, size: sid, sizeLabel: size.label, theme, surface: h.surface, alsoSeenOn: [], allowed: reason, box: h.box, shot: null, gkey,
              };
              hitMap.set(key, agg);
              const matched = matchKnown(agg);
              agg.known = matched;
              // Crop shot: first sighting per (kind, selector) per size+theme, bounded.
              const wantShot = !reason && shots < maxShots && (matched.length || ![...hitMap.values()].some((o) => o !== agg && o.gkey === gkey && o.shot && o.size === sid) );
              if (wantShot) {
                const name = `v1a-${String(hitMap.size).padStart(3, "0")}-${h.kind}-${sid}-${theme}-${h.surface}.png`;
                agg.shot = await cropShot(page, h, path.join(shotDir, name), size).catch(() => null);
                if (agg.shot) shots++;
              }
            } else if (!agg.alsoSeenOn.includes(h.surface) && agg.surface !== h.surface) agg.alsoSeenOn.push(h.surface);
          }
          process.stderr.write(`  ${tag}: ${res.hits.length} raw hits (${res.counts.els} els)\n`);
        }
        if (pageErrors.length) skipped.push({ surface: "*", size: sid, theme, reason: `page errors: ${pageErrors.slice(0, 2).join(" | ")}` });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const hits = [...hitMap.values()];
  hits.sort((a, b) => a.kind.localeCompare(b.kind) || a.selector.localeCompare(b.selector));
  hits.forEach((h, i) => {
    h.id = i + 1;
    h.cssRefs = cssRefs([...h.classes, ...(h.other?.classes ?? [])]);
    h.srcRefs = tsxRefs(h.selector, h.classes);
    delete h.gkey;
    for (const k of h.known ?? []) known[k].found.push(h.id);
  });
  const live = hits.filter((h) => !h.allowed);
  const byKind = {}, bySplit = { ours: 0, art: 0 };
  for (const h of live) { byKind[h.kind] = (byKind[h.kind] ?? 0) + 1; bySplit[h.split]++; }
  const report = {
    generatedAt: new Date().toISOString(), sizes: sizeIds, themes, surfacesRun, seconds: Math.round((Date.now() - t0) / 1000),
    totals: { hits: live.length, allowed: hits.length - live.length, byKind, bySplit },
    known: Object.values(known).map((k) => ({ id: k.id, what: k.what, status: k.found.length ? "found" : "not-reproduced", hitIds: k.found, shots: k.targetShots ?? [] })),
    skipped, hits,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMd(report));
  return report;
}

function renderMd(r) {
  const L = [];
  L.push(`# UI overlap guard report`, ``, `Generated ${r.generatedAt} in ${r.seconds}s. Sizes: ${r.sizes.join(", ")}; themes: ${r.themes.join(", ")}; ${r.surfacesRun} surface runs.`, ``);
  L.push(`**${r.totals.hits} hits** (${r.totals.allowed} allow-listed). ours (layout/position/size/overflow/z-order): ${r.totals.bySplit.ours}; @art (colour/line art/skin): ${r.totals.bySplit.art}.`, ``);
  L.push(`| kind | count |`, `|---|---|`, ...Object.entries(r.totals.byKind).map(([k, v]) => `| ${k} | ${v} |`), ``);
  L.push(`## Known hits`, ``, `| id | what | status | hits |`, `|---|---|---|---|`);
  for (const k of r.known) L.push(`| ${k.id} | ${k.what} | ${k.status} | ${k.hitIds.join(", ") || "-"} |`);
  L.push(``);
  for (const k of r.known.filter((x) => x.status !== "found")) L.push(`- ${k.id} not reproduced; shots: ${k.shots.join(", ") || "(target not on screen)"}`);
  if (r.skipped.length) {
    L.push(``, `## Skipped / failed surfaces`, ``);
    for (const s of r.skipped) L.push(`- ${s.surface} ${s.size} ${s.theme}: ${s.reason}`);
  }
  L.push(``, `## Hits`, ``);
  for (const h of r.hits) {
    L.push(`### #${h.id} ${h.kind} [${h.split}]${h.allowed ? " (allow-listed: " + h.allowed + ")" : ""}${h.known?.length ? " KNOWN:" + h.known.join(",") : ""}`);
    L.push(`- surface: ${h.surface}${h.alsoSeenOn.length ? " (also " + h.alsoSeenOn.join(", ") + ")" : ""}; size: ${h.sizeLabel}; theme: ${h.theme}`);
    L.push(`- selector: \`${h.selector}\`${h.text ? ` text "${h.text}"` : ""}`);
    if (h.other) L.push(`- other: \`${h.other.selector}\`${h.other.text ? ` "${h.other.text}"` : ""}`);
    L.push(`- ${h.detail}`);
    const refs = [...h.cssRefs, ...h.srcRefs];
    if (refs.length) L.push(`- source: ${refs.join("; ")}`);
    if (h.shot) L.push(`- shot: ${h.shot}`);
    L.push(``);
  }
  return L.join("\n");
}

const REPO = E.REPO_ROOT;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((r) => {
      console.log(`ui-overlap: ${r.totals.hits} hits (${r.totals.allowed} allow-listed) ours=${r.totals.bySplit.ours} art=${r.totals.bySplit.art} in ${r.seconds}s`);
      console.log(JSON.stringify(r.totals.byKind));
      for (const k of r.known) console.log(`  known ${k.id}: ${k.status}`);
      console.log(`report: scratch/ui-overlap/report.md`);
      process.exit(r.totals.hits > 0 && !flag("no-fail") ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(2); });
}
