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

test("picker builder: Desk + Bugs + every lane, Needs-you first in the active strip", () => {
  const d = buildPickerData(model(), h);
  assert.deepEqual(d.lanes.map((l) => l.key), ["_overlord", "_riffbot", "_bugs", "ui", "wiki"]);
  assert.equal(d.active[0].key, "ui:lead"); // needs-you sorts before plain working
  assert.ok(d.active.some((a) => a.key === "_riffbot") && d.active.some((a) => a.key === "w:w1"));
  assert.ok(!d.active.some((a) => a.key.startsWith("wiki")));
  assert.deepEqual(d.lanes.find((l) => l.key === "ui").pills.map((p) => p.label), ["Buddy", "Lead"]);
});

test("picker renders testids, filter and active strip; host owns split-empty/close", () => {
  const html = renderToStaticMarkup(React.createElement(BoringPanePicker, { data: buildPickerData(model(), h) }, React.createElement("button", { "data-testid": "boring-split-close" }, "Close split")));
  for (const id of ["boring-pp-filter", "boring-pp-active", "boring-pp-lanes", "boring-pp-lane-ui", "boring-pp-open-ui-lead", "boring-pp-open-ui-brainstorm", "boring-pp-open-_bugs-open", "boring-pp-agent-ui:lead", "boring-split-close"]) assert.ok(html.includes(`data-testid="${id}"`), id);
  assert.ok(html.includes("Pick an agent or lane") && html.includes("Filter lanes or agents…"));
  const src = read("src", "BoringAde.tsx");
  assert.match(src, /className="boring-split-empty" data-testid="boring-split-empty"/);
  assert.match(src, /data-testid="boring-split-close"/);
  assert.ok(src.includes("Shift+click any sidebar row to open it on the right."));
});

test("picker interaction: pills/cards open the agent, filter narrows, no-match message (real hooks via a recording shim)", () => {
  const d = buildPickerData(model(), h);
  d.lanes.find((l) => l.key === "ui").pills[1].onOpen();
  d.lanes.find((l) => l.key === "wiki").pills[0].onOpen();
  d.lanes.find((l) => l.key === "_overlord").pills[0].onOpen();
  d.active[0].onOpen();
  assert.deepEqual(calls.splice(0), [["role", "ui", "lead"], ["role", "wiki", "brainstorm"], ["core", "_overlord", null], ["agent", "ld1"]]);
  // filter: drive the component's state through React's server renderer is static, so assert the filter logic via the source contract
  const s = read("src", "BoringPanePicker.tsx");
  assert.match(s, /hit\(l\.name, l\.code\)/);
  assert.match(s, /data-testid="boring-pp-none"/);
});

test("empty-lane quick-jumps: sibling role, live worker, other active lanes (never itself)", () => {
  const j = buildQuickJumps(model(), "wiki", h);
  assert.deepEqual(j.here, []);
  assert.deepEqual(j.others.map((o) => o.key), ["ui"]);
  const ui = buildQuickJumps(model(), "ui", h);
  assert.deepEqual(ui.here.map((x) => x.key), ["lead", "brainstorm", "w:w1"]);
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
  assert.ok(css.includes("--measure-col: clamp(880px, 86%, 1360px);") && css.includes("--measure-prose: min(100%, 960px);"));
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

test("browser: picker + empty card + fluid column in the real app at 1280x720 and 3840x2160, Psycho untouched", { skip, timeout: 300000 }, async () => {
  const E = await import(pathToFileURL(join(root, "scripts", "ui-overlap", "env.mjs")).href);
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    for (const [w, hh, dpr, theme] of [[1280, 720, 1, "dark"], [3200, 1800, 1.2, "dark"], [3200, 1800, 1.2, "light"]]) {
      const ctx = await b.newContext({ viewport: { width: w, height: hh }, deviceScaleFactor: dpr, colorScheme: theme });
      await ctx.addInitScript(`try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"boring","app.theme":"${theme}"}));}catch{}`);
      await E.installRoutes(ctx);
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="boring-worker-demo-aud"]').click({ timeout: 15000 });
      await page.locator('[data-testid="boring-chat-column"]').waitFor();
      const colW = await page.evaluate(() => { const c = document.querySelector('[data-testid="boring-chat-column"]'); const t = [...c.querySelectorAll(".timeline > *")].map((e) => e.getBoundingClientRect().width); return { col: c.getBoundingClientRect().width, max: Math.max(...t) }; });
      if (w > 2000) assert.ok(colW.max >= 1300 && colW.max <= 1361, `wide column fills to the 1360 cap, got ${colW.max}`);
      else assert.ok(colW.max <= colW.col, "column never exceeds its pane at 1280");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      const empty = page.locator('[data-testid="boring-split-empty"]');
      await empty.waitFor();
      assert.ok(await page.locator('[data-testid="boring-pp-lane-ui-bois"]').count());
      const noOverflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, pane: (() => { const e = document.querySelector('[data-testid="boring-split-empty"]'); return e.scrollWidth - e.clientWidth; })() }));
      let o = await noOverflow();
      assert.ok(o.doc <= 0 && o.pane <= 0, `no horizontal overflow ${w}: ${JSON.stringify(o)}`);
      // filter narrows to one lane and a nonsense term shows the no-match line
      await page.locator('[data-testid="boring-pp-filter"]').fill("wiki");
      assert.equal(await page.locator('[data-testid^="boring-pp-lane-"]').count(), 1);
      await page.locator('[data-testid="boring-pp-filter"]').fill("zzzz");
      assert.ok(await page.locator('[data-testid="boring-pp-none"]').count());
      await page.locator('[data-testid="boring-pp-filter"]').fill("");
      // contrast of the new text elements against their own surface
      const pairs = await page.evaluate(() => {
        const cv = document.createElement("canvas"); cv.width = cv.height = 1; const x = cv.getContext("2d", { willReadFrequently: true });
        const rgb = (c) => { x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        return ["boring-pp-title", "boring-pp-sub", "boring-pp-h", "boring-pp-name", "boring-pp-pill", "boring-split-hint"].map((c) => { const e = document.querySelector("." + c); let bg = [255, 255, 255]; for (let n = e; n; n = n.parentElement) { const v = getComputedStyle(n).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(v)) { bg = rgb(v); break; } } return { c, fg: rgb(getComputedStyle(e).color), bg }; });
      });
      for (const p of pairs) assert.ok(ratio(p.fg, p.bg) >= 4.5, `${p.c} contrast ${ratio(p.fg, p.bg).toFixed(2)} (${theme})`);
      // open an agent from a lane pill, then Close split
      await page.locator('[data-testid="boring-pp-open-ui-bois-lead"]').click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('[data-testid="boring-split-empty"]').count(), 0, "picker gone once an agent is opened in the pane");
      await ctx.close();
    }
    // Psycho: no picker/empty-card CSS leak, no boring app
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(`try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");localStorage.setItem("vs.prefs.v1",JSON.stringify({"app.vibe":"fun"}));}catch{}`);
    await E.installRoutes(ctx);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('[data-testid="boring-app"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-vibe")), "fun");
    await ctx.close();
  } finally { await b.close(); server.close(); }
});
