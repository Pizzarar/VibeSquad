// B18a + B18c (@bor): Normal-mode visual polish. Contrast of every text stop on the new warm gradients, CSS hygiene, and the
// "Other projects (N)" picker disclosure (collapsed by default, auto-open on filter match).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";
import { resolvePlaywright, findBrowser, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const css = read("src", "boring.css");
const dir = mkdtempSync(join(tmpdir(), "vs-b18v-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "Picker.mjs"), `import React from ${JSON.stringify(import.meta.resolve("react"))};\n` + transformSync("BoringPanePicker.tsx", read("src", "BoringPanePicker.tsx"), { lang: "tsx", jsx: { runtime: "classic" } }).code.replace(/from "react"/, `from ${JSON.stringify(import.meta.resolve("react"))}`));
const { BoringPanePicker } = await import(pathToFileURL(join(dir, "Picker.mjs")).href);

const section = css.slice(css.indexOf("/* B18a/c visual (@bor) */"), css.indexOf("/* --- D4 polish"));
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, pct, b) => hex(a).map((v, i) => v * pct + hex(b)[i] * (1 - pct));
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (fg, bg) => { const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
const themeVars = (t) => { const re = new RegExp(`html\\[data-vibe="boring"\\]\\[data-theme="${t}"\\] \\{([^}]*)\\}`, "g"); const o = {}; for (const m of css.matchAll(re)) for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) o[k] ??= v; return o; };

test("B18a: every text stop is >= 4.5:1 on every new gradient stop, dark + light", () => {
  const report = [];
  for (const theme of ["dark", "light"]) {
    const v = themeVars(theme);
    const bgs = {
      "main-pin top": mix(v["living-warm"], 0.12, v["surface-2"]), "main-pin bottom": mix(v.accent, 0.10, v["surface-2"]),
      "main-line": mix(v["living-warm"], 0.12, v["surface-2"]),
      "open top": mix(v["living-warm"], 0.08, v["surface-1"]), "open bottom": mix(v.accent, 0.06, v["surface-1"]),
    };
    // ctx-body / split-empty wash is translucent over a surface: worst case = full-strength warm over each surface.
    for (const s of ["surface-0", "surface-1", "surface-2"]) bgs[`wash over ${s}`] = mix(v["living-warm"], 0.10, v[s]);
    for (const [name, bg] of Object.entries(bgs)) for (const t of ["text-1", "text-2", "text-3"]) {
      const r = ratio(hex(v[t]), bg); report.push(`${theme} ${t} on ${name}: ${r.toFixed(2)}`);
      assert.ok(r >= 4.5, `${theme} ${t} on ${name} = ${r.toFixed(2)} < 4.5`);
    }
  }
  console.log(report.join("\n"));
});

test("idea-1062: collapsed rail badge contrast >= 4.5:1 on st-err and st-attn, dark + light", () => {
  assert.match(css, /\.boring-ctx-rail-badge \{[^}]*color: var\(--on-accent\)/);
  for (const theme of ["dark", "light"]) {
    const v = themeVars(theme);
    for (const bg of ["st-err", "st-attn"]) {
      const r = ratio(hex(v["on-accent"]), hex(v[bg]));
      assert.ok(r >= 4.5, `${theme} on-accent on ${bg} = ${r.toFixed(2)} < 4.5`);
    }
  }
});

test("B18a: new section sits between B17 and D4 polish, hygiene, O2 floors untouched", () => {
  assert.ok(css.indexOf("/* B18a/c visual (@bor) */") > css.indexOf("B17 deadspace"));
  assert.ok(section.length > 200);
  assert.doesNotMatch(section, /!important|@keyframes|@media/);
  for (const line of section.split("\n").filter((l) => l.trim() && !l.startsWith("/*"))) assert.match(line, /^html\[data-vibe="boring"\]/, line.slice(0, 60));
  assert.match(css, /\.boring-main-pin \{ flex: 0 1 auto; min-height: 60px;/);
  assert.match(css, /\.boring-main-pin:has\(\.boring-project-block\.open\) \{ min-height: 220px; \}/);
  assert.match(css, /\.boring-main-pin ~ \.boring-project-tree \{ flex-basis: 0; min-height: 120px; \}/);
  assert.doesNotMatch(section, /min-height:\s*(60|220|120)px/);
  assert.match(section, /boring-project-tree \{[^}]*mask-image: linear-gradient\(to bottom, #000 0%, #000 calc\(100% - 24px\), transparent 100%\)/);
  assert.match(section, /boring-sidebar-footer \{[^}]*border-top: 1px solid var\(--border\)/);
  assert.match(section, /boring-ctx-body \{ background: radial-gradient\(110% 42% at 50% 104%/);
  assert.match(section, /boring-split-empty \{ background: radial-gradient\(110% 42% at 50% 104%/);
});

const lane = (key, name, code, needs = false) => ({ key, name, code, dot: "d", needs, working: false, sub: needs ? "Needs you" : "Idle", pills: [{ key: "lead", label: "Lead", live: true, onOpen() {} }] });
const others = [{ id: "p2", name: "Alpha Proj", needsYou: 2, lanes: [lane("l1", "Billing", "@bil", true), lane("l2", "Search", "@sea")] }, { id: "p3", name: "Beta", needsYou: 0, lanes: [lane("l3", "Docs", "@doc")] }];
const render = (props) => renderToStaticMarkup(React.createElement(BoringPanePicker, { getData: () => ({ active: [], lanes: [lane("a", "Mine", "@min")] }), ...props }));

test("B18c: Other projects disclosure is collapsed, counts projects, shows needs-you badge", () => {
  const html = render({ otherProjects: others });
  assert.match(html, /<details class="boring-pp-others" data-testid="boring-pp-others">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /Other projects \((<!-- -->)?2(<!-- -->)?\)/);
  assert.match(html, /2 needs you/);
  assert.match(html, /boring-pp-other-open-p2-l1-lead/);
});

test("B18c: omitted/empty otherProjects renders no disclosure", () => {
  assert.doesNotMatch(render({}), /boring-pp-others/);
  assert.doesNotMatch(render({ otherProjects: [] }), /boring-pp-others/);
});

test("B18c: filter q auto-opening is wired to the same needle, filters other lanes + badge, Enter handles others, otherProjects memo is gated", () => {
  const src = read("src", "BoringPanePicker.tsx");
  assert.match(src, /open=\{needle \? true : undefined\}/);
  assert.match(src, /!needle \|\| hit\(p\.name\) \? p\.lanes : p\.lanes\.filter\(\(l\) => hit\(l\.name, l\.code\)\)/);
  assert.match(src, /const ol = others\[0\]\?\.lanes\[0\];/);
  assert.doesNotMatch(src, /Hypnospace/i);
  const ade = read("src", "BoringAde.tsx");
  assert.match(ade, /const pickerOpen = mode === "chat" && panes\.split && !\(panes\.rightActiveId && agents\.has\(panes\.rightActiveId\)\) && !dormantSlot;/);
  assert.match(ade, /if \(!pickerOpen\) return \[\];/);
});

// ---- B18c browser half: the real app (?demo=1, several projects). Skips cleanly without Playwright/Chromium. ----
const chromium = resolvePlaywright({ npx: false })?.chromium ?? null;
const exe = findBrowser();
const skip = browserSkipReason({ pw: chromium, exe });
const initScript = (theme) => `try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"boring","app.theme":"${theme}"}))}catch(e){}`;
async function openPicker(b, E, baseUrl, w, h, dpr, theme) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.addInitScript(initScript(theme));
  await E.installRoutes(ctx);
  // ui-overlap's registry has ONE project; add the demo cast's other teams (efi, plugins, site) so the disclosure has something to list.
  const mk = (id, name, lanes) => ({ ...E.TEAMS_REGISTRY.teams[0], id, name, lanes: lanes.map((l) => ({ id: l, name: l })), paths: [name] });
  const registry = { ...E.TEAMS_REGISTRY, teams: [...E.TEAMS_REGISTRY.teams, mk("efi", "Main Game", ["main-game", "ui-lab"]), mk("plugins", "Plugins", ["plugins", "empty-p"]), mk("site", "Site", ["site-polish", "docs"])] };
  await ctx.route("**/api/teams", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(registry) }) : route.fallback()));
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
  const aud = page.locator('[data-testid="boring-worker-demo-aud"]');
  if (!(await aud.count())) await page.locator('[data-testid="boring-project-header-vibesquad"]').click({ timeout: 15000 });
  await aud.click({ timeout: 15000 });
  await page.locator('[data-testid="boring-chat-column"]').waitFor();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="boring-split-toggle"]').click();
  await page.locator('[data-testid="boring-split-empty"]').waitFor();
  return { ctx, page };
}

test("browser: Other projects disclosure is live in the real app (collapsed, filter auto-opens, filtered badge, Enter-on-others, dormant Buddy/Lead + live pills keep split)", { skip, timeout: 300000 }, async () => {
  const E = await import(pathToFileURL(join(root, "scripts", "ui-overlap", "env.mjs")).href);
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const { ctx, page } = await openPicker(b, E, baseUrl, 1600, 900, 1, "dark");
    const others = page.locator('[data-testid="boring-pp-others"]');
    assert.equal(await others.count(), 1, "disclosure renders with more than one demo project");
    assert.equal(await others.evaluate((e) => e.open), false, "collapsed by default");
    assert.match(await page.locator('[data-testid="boring-pp-others-sum"]').innerText(), /^Other projects \(3\)/i);
    assert.match(await page.locator('[data-testid="boring-pp-others-badge"]').innerText(), /1 needs you/i);

    // Filtered badge: matching a calm lane in Main Game (ui-lab) hides the needs-you badge; matching main-game keeps it
    const filter = page.locator('[data-testid="boring-pp-filter"]');
    await filter.fill("ui-lab");
    assert.equal(await others.evaluate((e) => e.open), true, "auto-opens on a filter match");
    assert.equal(await page.locator('[data-testid="boring-pp-others-badge"]').count(), 0, "calm filtered lane shows no needs-you badge");
    await filter.fill("main-game");
    assert.match(await page.locator('[data-testid="boring-pp-others-badge"]').innerText(), /1 needs you/i, "needs-you filtered lane keeps badge");
    await filter.fill("");

    // UX R41 L2: dormant Trinity rows are hidden in Other projects, while live Plugins Overlord stays
    await others.evaluate((e) => { e.open = true; });
    assert.equal(await page.locator('[data-testid="boring-pp-other-lane-efi-_overlord"]').count(), 0, "dormant Main Game Overlord hidden");
    assert.equal(await page.locator('[data-testid="boring-pp-other-lane-efi-_bugs"]').count(), 0, "dormant Main Game Bugs hidden");
    assert.equal(await page.locator('[data-testid="boring-pp-other-lane-plugins-_overlord"]').count(), 1, "live Plugins Overlord kept");

    // Dormant other-project Buddy click (Main Game · ui-lab · Buddy): keeps split, switches project, shows Buddy empty card on right, left unchanged
    await page.locator('[data-testid="boring-pp-other-open-efi-ui-lab-brainstorm"]').click();
    await page.locator('[data-testid="boring-empty-card"]').waitFor();
    assert.equal(await page.locator('[data-testid="boring-pane-left"]').count(), 1, "split left pane stays after dormant Buddy click");
    assert.equal(await page.locator('[data-testid="boring-pane-right"]').count(), 1, "split right pane stays after dormant Buddy click");
    assert.match(await page.locator('[data-testid="boring-pane-left"]').innerText(), /Audit - token scout/, "left pane unchanged after dormant Buddy click");
    assert.match(await page.locator('[data-testid="boring-empty-lane"]').innerText(), /^ui-lab$/i, "right card names ui-lab");
    assert.match(await page.locator('[data-testid="boring-empty-cta"]').innerText(), /Start Brainstorm/, "right card is for Brainstorm role");
    assert.match(await page.locator('[data-testid="boring-breadcrumb"]').innerText(), /Main Game/, "breadcrumb reflects switched project Main Game");
    assert.match(page.url(), /agent=demo-aud/, "URL keeps left pane agent");

    // Back to picker -> now on Main Game, so Site is under Other projects
    await page.locator('[data-testid="boring-pp-back"]').click();
    await others.waitFor();
    await others.evaluate((e) => { e.open = true; });

    // Dormant other-project Lead click on a fully dormant feature lane (Site · docs · Lead): keeps split, switches to Site, shows Lead empty card on right
    await page.locator('[data-testid="boring-pp-other-open-site-docs-lead"]').click();
    await page.locator('[data-testid="boring-empty-card"]').waitFor();
    assert.equal(await page.locator('[data-testid="boring-pane-left"]').count(), 1, "split stays after dormant Lead click");
    assert.match(await page.locator('[data-testid="boring-pane-left"]').innerText(), /Audit - token scout/, "left pane unchanged after dormant Lead click");
    assert.match(await page.locator('[data-testid="boring-empty-lane"]').innerText(), /^docs$/i, "right card names docs");
    assert.match(await page.locator('[data-testid="boring-empty-cta"]').innerText(), /Switch to Brainstorm/, "right card is for Lead role");
    assert.match(await page.locator('[data-testid="boring-breadcrumb"]').innerText(), /Site/, "breadcrumb reflects switched project Site");

    // Back to picker -> Enter on a query that only matches Other projects (empty-p in Plugins)
    await page.locator('[data-testid="boring-pp-back"]').click();
    await filter.waitFor();
    await filter.fill("empty-p");
    await filter.press("Enter");
    await page.locator('[data-testid="boring-empty-card"]').waitFor();
    assert.match(await page.locator('[data-testid="boring-empty-lane"]').innerText(), /^empty-p$/i, "Enter-on-others opens matching other-project lane");
    assert.match(await page.locator('[data-testid="boring-breadcrumb"]').innerText(), /Plugins/, "Enter-on-others switched to Plugins");
    assert.equal(await page.locator('[data-testid="boring-pane-right"]').count(), 1, "split stays after Enter-on-others");

    // Back to picker -> LIVE other-project pill opens the agent in the right pane and the split stays
    await page.locator('[data-testid="boring-pp-back"]').click();
    await others.waitFor();
    await others.evaluate((e) => { e.open = true; });
    const pill = page.locator('[data-testid^="boring-pp-other-open-"].live').first();
    if (await pill.count()) {
      await pill.click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('[data-testid="boring-pane-right"]').count(), 1, "split stays open");
      assert.equal(await page.locator('[data-testid="boring-split-empty"]').count(), 0, "right pane now shows the agent, not the picker");
    } else assert.fail("no live other-project pill in the demo cast");

    // idea-1062: Overlord, RiffBot and Bugs tile labels fit without ellipsis at 1920x1080 and 1280x720
    for (const [w, h] of [[1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(100);
      for (const id of ["boring-core-overlord", "boring-core-riffbot", "boring-core-bugs"]) {
        const m = await page.locator(`[data-testid="${id}"] .boring-mate-name`).first().evaluate((el) => ({ text: el.textContent, sw: el.scrollWidth, cw: el.clientWidth }));
        assert.ok(m.sw <= m.cw, `${id} ("${m.text}") truncated at ${w}x${h}: scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      }
    }
    await ctx.close();
  } finally { await b.close(); server.close(); }
});
