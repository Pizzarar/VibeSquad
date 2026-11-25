// B17 (@bor): Normal-mode deadspace. Fluid chat measure, inline Split picker, empty-lane quick-jumps, Psycho isolation.
// Static/markup half always runs; the browser half (real dist, demo cast) skips cleanly without Playwright/Chromium.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const dir = mkdtempSync(join(tmpdir(), "vs-b17-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "Picker.mjs"), `import React from ${JSON.stringify(import.meta.resolve("react"))};\n` + transformSync("BoringPanePicker.tsx", read("src", "BoringPanePicker.tsx"), { lang: "tsx", jsx: { runtime: "classic" } }).code.replace(/from "react"/, `from ${JSON.stringify(import.meta.resolve("react"))}`));
const { BoringPanePicker, buildPickerData, buildQuickJumps, BoringEmptyJumps } = await import(pathToFileURL(join(dir, "Picker.mjs")).href);

const calls = [];
const h = {
  glyphCls: (s) => `st-${s}`,
  openAgent: (id) => calls.push(["agent", id]),
  openCore: (l, id) => calls.push(["core", l, id]),
  openBugs: () => calls.push(["bugs"]),
  openRole: (l, r) => calls.push(["role", l, r]),
};
const core = (o = {}) => ({ agentId: null, status: "none", needsYou: 0, err: false, short: "x", ...o });
const model = () => ({
  core: { overlord: core(), riffbot: core({ agentId: "rb", status: "running" }), bugs: { agentId: null, pin: null, needsYou: 0, err: false } },
  conversations: [
    { laneId: "ui", name: "UI Bois", code: "@ui", pin: { lead: null, brainstorm: null, workers: [{ agent: { id: "w1", status: "running", title: "Painter" } }] }, brainstormId: "bs1", brainstormStatus: "idle", leadId: "ld1", leadStatus: "running", needsYou: 1, err: false, running: 1 },
    { laneId: "wiki", name: "Wiki", code: "@wiki", pin: { lead: null, brainstorm: null, workers: [] }, brainstormId: null, brainstormStatus: "none", leadId: null, leadStatus: "none", needsYou: 0, err: false },
  ],
});

const strip = [
  { id: "w-perm", title: "Audit - token scout", sub: "Desk · Bash: rg --stats", needs: true },
  { id: "bs1", title: "Buddy · UI Bois", sub: "Working", needs: false },
  { id: "ld1", title: "Lead · UI Bois", sub: "Working", needs: false },
  { id: "w-run", title: "Implement - overlap guard", sub: "Working", needs: false },
];
test("picker builder: Desk + Bugs + every lane; strip comes from the sidebar's rows (Desk workers, Buddy AND Lead), needs-you first", () => {
  const d = buildPickerData(model(), h, strip);
  assert.deepEqual(d.lanes.map((l) => l.key), ["_overlord", "_riffbot", "_bugs", "ui", "wiki"]);
  assert.deepEqual(d.active.map((a) => a.key), ["w-perm", "bs1", "ld1", "w-run"]);
  assert.equal(d.active[0].needs, true);
  assert.ok(d.active.slice(1).every((a) => !a.needs), "running agents are not marked needs-you");
  assert.deepEqual(d.lanes.find((l) => l.key === "ui").pills.map((p) => p.label), ["Buddy", "Lead"]);
  // L1: a lane with a live Lead never says "No agent"; a truly empty lane does
  assert.match(d.lanes.find((l) => l.key === "ui").sub, /Needs you/);
  const m2 = model(); m2.conversations[0].needsYou = 0;
  assert.equal(buildPickerData(m2, h).lanes.find((l) => l.key === "ui").sub, "Lead working · Buddy idle");
  assert.equal(buildPickerData(m2, h).lanes.find((l) => l.key === "wiki").sub, "No agent");
});

test("picker renders testids, filter and active strip; host owns split-empty/close", () => {
  const html = renderToStaticMarkup(React.createElement(BoringPanePicker, { getData: () => buildPickerData(model(), h, strip) }, React.createElement("button", { "data-testid": "boring-split-close" }, "Close split")));
  for (const id of ["boring-pp-filter", "boring-pp-active", "boring-pp-lanes", "boring-pp-lane-ui", "boring-pp-open-ui-lead", "boring-pp-open-ui-brainstorm", "boring-pp-open-_bugs-open", "boring-pp-agent-w-perm", "boring-split-close"]) assert.ok(html.includes(`data-testid="${id}"`), id);
  assert.ok(html.includes("Pick an agent or lane") && html.includes("Filter lanes or agents…"));
  const src = read("src", "BoringAde.tsx");
  assert.match(src, /className="boring-split-empty" data-testid="boring-split-empty"/);
  assert.match(src, /data-testid="boring-split-close"/);
  assert.ok(src.includes("Shift+click any sidebar row to open it on the right."));
  // Gemini L1: data is built lazily inside the picker, never eagerly per BoringApp render; L3: keyed per project
  assert.match(src, /<BoringPanePicker key=\{view\?\.team\.id\} getData=\{\(\) => buildPickerData\(/);
  // the strip is the sidebar's own queue
  assert.match(src, /needsYouRows\(\[view\], now\)\.filter\(\(r\) => r\.item\.kind !== "finished"\)/);
});

test("picker interaction: pills/cards open the agent, filter narrows, no-match message (real hooks via a recording shim)", () => {
  const d = buildPickerData(model(), h, strip);
  d.lanes.find((l) => l.key === "ui").pills[1].onOpen();
  d.lanes.find((l) => l.key === "wiki").pills[0].onOpen();
  d.lanes.find((l) => l.key === "_overlord").pills[0].onOpen();
  d.active[0].onOpen();
  assert.deepEqual(calls.splice(0), [["role", "ui", "lead"], ["role", "wiki", "brainstorm"], ["core", "_overlord", null], ["agent", "w-perm"]]);
  // filter: drive the component's state through React's server renderer is static, so assert the filter logic via the source contract
  const s = read("src", "BoringPanePicker.tsx");
  assert.match(s, /hit\(l\.name, l\.code\)/);
  assert.match(s, /codeHits/); // Gemini L3: an @code filter narrows the strip too
  assert.match(s, /e\.key === "Enter"/); assert.match(s, /e\.key === "Escape"/); assert.match(s, /filterRef\.current\?\.focus\(\)/);
  assert.match(s, /data-testid="boring-pp-none"/);
});

test("empty-lane quick-jumps: sibling role, live worker, other active lanes (never itself)", () => {
  const j = buildQuickJumps(model(), "wiki", h);
  assert.deepEqual(j.here, []);
  assert.deepEqual(j.others.map((o) => o.key), ["ui"]);
  const ui = buildQuickJumps(model(), "ui", h);
  assert.deepEqual(ui.here.map((x) => x.key), ["lead", "brainstorm", "w:w1"]);
  assert.deepEqual(ui.here.map((x) => x.label), ["Lead", "Brainstorm", "Painter"]); // L5: one label pattern, status in the sub
  assert.ok(!ui.others.some((o) => o.key === "ui"));
  ui.here[0].onOpen();
  assert.deepEqual(calls.splice(0), [["agent", "ld1"]]);
  const html = renderToStaticMarkup(React.createElement(BoringEmptyJumps, ui));
  assert.ok(html.includes('data-testid="boring-empty-jumps"') && html.includes("Available in this lane"));
  assert.equal(renderToStaticMarkup(React.createElement(BoringEmptyJumps, { here: [], others: [] })), "");
  const src = read("src", "BoringAde.tsx");
  for (const id of ["boring-empty-card", "boring-empty-cta"]) assert.ok(src.includes(`data-testid="${id}"`), id);
});

test("CSS: fluid measure vars, B17 section scoped/single-line, Psycho + styles.css untouched", () => {
  const css = read("src", "boring.css");
  assert.ok(css.includes("--measure-col: clamp(880px, 90%, 1680px);") && css.includes("--measure-prose: min(100%, 960px);"));
  const a = css.indexOf("/* ---- B17 deadspace"), b = css.indexOf("/* --- D4 polish");
  assert.ok(a > 0 && b > a, "B17 section sits before D4 polish");
  const sec = css.slice(a, b);
  for (const line of sec.split("\n").filter((l) => l.includes("{") && !l.startsWith("/*"))) assert.match(line, /^html\[data-vibe="boring"\] /);
  assert.doesNotMatch(sec, /!important|@media|@keyframes/);
  assert.ok(sec.includes(".boring-empty-card { max-width: 720px;"));
  for (const sel of [".timeline > *", ".composer > *", ".perm-card", '[data-testid="tl-pinned-todo"]']) assert.ok(css.includes(`html[data-vibe="boring"] ${sel} {`) , sel);
  assert.doesNotMatch(read("src", "styles.css"), /boring-pp-|--measure-col/);
  assert.doesNotMatch(read("src", "BoringPanePicker.tsx"), /Hypnospace/i);
});

const { chromium } = await (async () => {
  try {
    const d = process.env.PLAYWRIGHT_DIR;
    const pw = await import(d ? pathToFileURL(join(d, "playwright-core", "index.mjs")).href : "playwright-core");
    return { chromium: pw?.chromium ?? pw?.default?.chromium ?? null };
  } catch { return { chromium: null }; }
})();
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const skip = chromium && exe ? false : "no Playwright/Chromium (set PLAYWRIGHT_DIR + PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)";
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const init = (theme, vibe = "boring") => `try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"${vibe}","app.theme":"${theme}"}));}catch{}`;
async function app(b, E, baseUrl, w, hh, dpr, theme) {
  const ctx = await b.newContext({ viewport: { width: w, height: hh }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.addInitScript(init(theme));
  await E.installRoutes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="boring-worker-demo-aud"]').click({ timeout: 15000 });
  await page.locator('[data-testid="boring-chat-column"]').waitFor();
  await page.waitForTimeout(600);
  return { ctx, page };
}
const edges = (page) => page.evaluate(() => {
  const e = (sel) => { const n = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().width > 0); if (!n) return null; const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
  return { convo: e(".boring-convo-col"), composer: e(".composer > *"), perm: e(".perm-card"), pinned: e('[data-testid="tl-pinned-todo"]') };
});

test("browser: left/right edges of composer, perm card and pinned todo line up at 1600x900 (and every size), column cap 1680", { skip, timeout: 300000 }, async () => {
  const E = await import(pathToFileURL(join(root, "scripts", "ui-overlap", "env.mjs")).href);
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    for (const [w, hh, dpr] of [[1280, 720, 1], [1600, 900, 1], [2560, 1440, 1], [3200, 1800, 1.2]]) {
      const { ctx, page } = await app(b, E, baseUrl, w, hh, dpr, "dark");
      const ed = await edges(page);
      assert.ok(ed.composer && ed.perm && ed.pinned, `all three present at ${w}: ${JSON.stringify(ed)}`);
      for (const k of ["perm", "pinned"]) for (let i = 0; i < 2; i++) assert.ok(Math.abs(ed[k][i] - ed.composer[i]) <= 1, `${k} edge ${i} at ${w}: ${JSON.stringify(ed)}`);
      assert.ok(ed.composer[0] >= ed.convo[0] && ed.composer[1] <= ed.convo[1], `inside the conversation column at ${w}`);
      if (w >= 2560) assert.ok(ed.composer[1] - ed.composer[0] <= 1681, "never wider than the 1680 cap");
      if (w === 3200) assert.ok(ed.composer[1] - ed.composer[0] >= 1500, `4K@120% uses the width: ${ed.composer[1] - ed.composer[0]}`);
      await ctx.close();
    }
  } finally { await b.close(); server.close(); }
});

test("browser: split picker in the real app: strip = sidebar Needs-you, names readable, dormant pills show the lane's empty card, keyboard, contrast, Psycho untouched", { skip, timeout: 400000 }, async () => {
  const E = await import(pathToFileURL(join(root, "scripts", "ui-overlap", "env.mjs")).href);
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    for (const [w, hh, dpr, theme] of [[1280, 720, 1, "dark"], [2560, 1440, 1, "dark"], [2560, 1440, 1, "light"], [3200, 1800, 1.2, "dark"], [3200, 1800, 1.2, "light"]]) {
      const { ctx, page } = await app(b, E, baseUrl, w, hh, dpr, theme);
      const sidebarNeeds = await page.locator(".sidebar .boring-needs-item, .boring-sidebar .boring-needs-item").count();
      await page.locator('[data-testid="boring-split-toggle"]').click();
      const empty = page.locator('[data-testid="boring-split-empty"]');
      await empty.waitFor();
      // UX L2: the filter takes focus when the picker opens
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "boring-pp-filter", "filter focused on open");
      // UX M1 / Gemini L2: every sidebar Needs-you row has a needs-you card in the strip
      const attn = await page.locator('[data-testid^="boring-pp-agent-"].attn').count();
      assert.ok(sidebarNeeds > 0 && attn >= Math.min(sidebarNeeds, 4), `strip needs-you cards ${attn} vs sidebar rows ${sidebarNeeds}`);
      const noOverflow = await page.evaluate(() => { const e = document.querySelector('[data-testid="boring-split-empty"]'); return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, pane: e.scrollWidth - e.clientWidth }; });
      assert.ok(noOverflow.doc <= 0 && noOverflow.pane <= 0, `no horizontal overflow ${w}: ${JSON.stringify(noOverflow)}`);
      // UX M2: lane names keep at least 8 visible characters of room (never "R." / "B…")
      const names = await page.evaluate(() => [...document.querySelectorAll(".boring-pp-lane .boring-pp-name")].map((n) => ({ t: n.textContent, trunc: n.scrollWidth > n.clientWidth + 1, w: n.clientWidth })));
      for (const n of names) assert.ok(n.w >= 70 && (!n.trunc || n.t.length > 12), `lane name readable at ${w}: ${JSON.stringify(n)}`);
      // UX L3 + contrast of every new text element
      const pairs = await page.evaluate(() => {
        const cv = document.createElement("canvas"); cv.width = cv.height = 1; const x = cv.getContext("2d", { willReadFrequently: true });
        const rgb = (c) => { x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const bgOf = (e) => { for (let n = e; n; n = n.parentElement) { const v = getComputedStyle(n).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(v)) return rgb(v); } return [255, 255, 255]; };
        const out = ["boring-pp-title", "boring-pp-sub", "boring-pp-h", "boring-pp-name", "boring-pp-pill", "boring-split-hint"].map((c) => { const e = document.querySelector("." + c); return { c, fg: rgb(getComputedStyle(e).color), bg: bgOf(e) }; });
        const f = document.querySelector(".boring-pp-filter"); out.push({ c: "placeholder", fg: rgb(getComputedStyle(f, "::placeholder").color), bg: bgOf(f) });
        return out;
      });
      for (const p of pairs) assert.ok(ratio(p.fg, p.bg) >= 4.5, `${p.c} contrast ${ratio(p.fg, p.bg).toFixed(2)} (${theme})`);
      // filter: lane name, @code also narrows the strip, no-match line
      const f = page.locator('[data-testid="boring-pp-filter"]');
      await f.fill("wiki");
      assert.equal(await page.locator('[data-testid^="boring-pp-lane-"]').count(), 1);
      await f.fill("zzzz");
      assert.ok(await page.locator('[data-testid="boring-pp-none"]').count());
      await f.fill("");
      // M3: a dormant pill (wiki Buddy has no agent) shows that lane's empty card in the right pane, Back returns
      await page.locator('[data-testid="boring-pp-open-wiki-brainstorm"]').click();
      await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-card"]').waitFor({ timeout: 3000 });
      assert.match(await page.locator('[data-testid="boring-pp-empty"]').innerText(), /Brainstorm/);
      await page.locator('[data-testid="boring-pp-back"]').click();
      assert.ok(await page.locator('[data-testid="boring-pp-lanes"]').count(), "Back returns to the lane grid");
      // a dormant Desk pill (Bugs has no agent) does the same
      await page.locator('[data-testid="boring-pp-open-_bugs-open"]').click();
      await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-card"]').waitFor({ timeout: 3000 });
      // Esc: backs out of the empty card first, then clears the filter, then closes the split
      await page.keyboard.press("Escape");
      assert.ok(await page.locator('[data-testid="boring-pp-lanes"]').count(), "Esc backs out of the empty card");
      await f.fill("ui");
      await page.keyboard.press("Escape");
      assert.equal(await f.inputValue(), "", "Esc clears the filter");
      assert.ok(await page.locator('[data-testid="boring-split-empty"]').count());
      // Enter opens the first match (a live target replaces the picker)
      await f.fill("ui bois");
      await f.press("Enter");
      await page.waitForTimeout(400);
      assert.equal(await page.locator('[data-testid="boring-split-empty"]').count(), 0, "Enter on a live match opens it in the pane");
      await ctx.close();
    }
    // Esc closes the split when nothing else is open
    { const { ctx, page } = await app(b, E, baseUrl, 1280, 720, 1, "dark");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      await page.locator('[data-testid="boring-split-empty"]').waitFor();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-testid="boring-split-empty"]').count(), 0, "Esc closes the split");
      await ctx.close(); }
    // Psycho: no boring app
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(init("dark", "fun"));
    await E.installRoutes(ctx);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('[data-testid="boring-app"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-vibe")), "fun");
    await ctx.close();
  } finally { await b.close(); server.close(); }
});
