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
import { resolvePlaywright, findBrowser, browserSkipReason } from "../scripts/ui-overlap/env.mjs";

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
  // Gemini M1: a WORKING-only lane (needsYou 0, running 1) must qualify via structured state, not display text.
  const mw = model(); mw.conversations[0].needsYou = 0;
  const j = buildQuickJumps(mw, "wiki", h);
  assert.deepEqual(j.here, []);
  assert.deepEqual(j.others.map((o) => o.key), ["ui"]);
  assert.match(j.others[0].sub, /Lead working/);
  mw.conversations[0].running = 0;
  assert.deepEqual(buildQuickJumps(mw, "wiki", h).others, [], "an idle, non-needs-you lane is not an 'active lane'");
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

test("r3/r4: Start Brainstorm from the right pane keeps the split; right card is pane-local; Esc returns focus to Split; labels", () => {
  const ade = read("src", "BoringAde.tsx"), pf = read("src", "pinFocus.ts"), pp = read("src", "BoringPanePicker.tsx");
  // UX M4 + B18d N9: spinUpPin(..., "right") carries `into` on PinFocus; if split closed mid-start, show(id, "right") no-ops
  assert.match(pf, /const show = \(id: string, into\?: "right"\) => \{\n  if \(into === "right"\) \{\n    if \(getPanes\(\)\.split\) openAgentInTab\(id, "right"\);\n    return;/);
  assert.match(pf, /into\?: "right"/);
  assert.match(pf, /if \(d\.open \|\| f\.into === "right"\) show\(d\.agentId, f\.into\);/);
  assert.match(pf, /show\(id, f\.into \?\? into\)/);
  assert.match(ade, /rightSpin = \(p: Pin\) => spinUpPin\(p, undefined, undefined, "right"\)/);
  assert.match(ade, /boringStartBrainstorm\(pin, c\.right \? rightSpin : undefined\)/);
  assert.match(ade, /boringStartBugs\(view\.team\.id, c\.right \? \{ spinUp: rightSpin \} : \{\}\)/);
  // Gemini M1: Start Overlord guards with getPanes().split and catches rejections
  assert.match(ade, /c\.right \? void Promise\.resolve\(onSpinUpOverlord\(view\)\)\.then\(\(id\) => id && getPanes\(\)\.split && openAgentInTab\(id, "right"\)\)\.catch\(\(\) => \{\}\)/);
  assert.match(ade, /c\.right \? onSpinUpPin\(hubPin, undefined, "right"\) : onSpinUpPin\(hubPin\)/); // Start RiffBot
  assert.match(read("src", "App.tsx"), /\(pin: Pin, profile\?: string, into\?: "right"\) => void spinUpPin\(pin, profile, undefined, into\)/);
  assert.match(read("src", "App.tsx"), /return spinUpOverlord\(view, \{/);
  // Gemini M2: rightCard resets on project switch (view?.team.id)
  assert.match(ade, /useEffect\(\(\) => \{ setRightCard\(null\); \}, \[view\?\.team\.id\]\);/);
  // Gemini L1: rightHandlers wraps openAgent, openCore, openBugs, openRole (never folds split or clobbers selectedLaneId)
  const rh = ade.slice(ade.indexOf("const rightHandlers:"), ade.indexOf("const rightCtx"));
  for (const k of ["openAgent:", "openCore:", "openBugs:", "openRole:"]) assert.ok(rh.includes(k), `rightHandlers wraps ${k}`);
  assert.doesNotMatch(rh, /pickCore|pickBugs|pickRoleIn/);
  assert.match(ade, /buildQuickJumps\(model, c\.laneId, c\.right \? rightHandlers : pickerHandlers\)/);
  // Gemini M2: the picker's card target is pane-local state, a dormant pill never selects the lane in the host
  assert.match(ade, /const \[rightCard, setRightCard\] = useState<CardTarget \| null>/);
  assert.match(ade, /renderEmpty=\{\(t\) => emptyCard\(t\)\}/);
  assert.match(pp, /if \(live \|\| !renderEmpty\) onOpen\(\); else setEmptyFor\(\{ key: laneKey, pill \}\)/);
  assert.match(ade, /openAgentInTab\(id, "right"\);\n    else setRightCard/); // "Switch to Brainstorm" opens the live Buddy on the right
  // N5 focus return, N2 lane name on the card + breadcrumb
  assert.match(ade, /closeSplitToButton/); assert.match(ade, /boring-split-toggle"\]'\)\?\.focus\(\)/);
  assert.match(ade, /data-testid="boring-empty-lane"/); assert.match(ade, /rightCard && panes\.activePane === "right" \? rightCardName\(rightCard\)/);
  // Gemini L2 / N3 / N7: hub members are Overlord / RiffBot, Bugs is Bugs; lane-less lead never says "Lead · Lane"
  assert.match(ade, /return m\.kind === "lead" \? "Overlord" : "RiffBot"/); assert.match(ade, /err: r\.item\.kind === "error"/);
  assert.match(pp, /i\.err \? "error"/);
  assert.doesNotMatch(ade, /\?\? "Desk"\}`/);
  assert.doesNotMatch(ade, /\?\? "Lane"\}`/);
  // Gemini L1 / N6 + D2 / N8 (58px avatar gutter accounted for)
  const css = read("src", "boring.css");
  assert.doesNotMatch(css, /\.boring-pp-agent \{[^}]*max-width: min\(100%, 640px\)[^}]*max-width: 100%/);
  assert.ok(css.includes("margin-right: calc(max(0px, (100% - var(--measure-col)) / 2) + max(0px, var(--measure-col) - var(--measure-prose) - 58px))"));
});

test("r4 M4 behavioral: spinUpPin(..., 'right') keeps split when agent lands in store BEFORE promise resolves", async () => {
  const pfDir = mkdtempSync(join(tmpdir(), "vs-b17-pf-"));
  try {
    const w = (name, code) => writeFileSync(join(pfDir, name), code);
    const panes = { split: true, leftActiveId: "left-agent", rightActiveId: null, activePane: "right" };
    const callsLog = [];
    const paseoSubs = new Set();
    const panesSubs = new Set();
    let currentPin = { squad: { id: "sq1" }, lane: { id: "wiki" }, brainstorm: null, lead: { agent: { id: "wiki-lead", status: "idle" } }, workers: [], topicBrainstorms: [] };
    globalThis.__b17pf = {
      panes,
      callsLog,
      paseoSubs,
      panesSubs,
      getPin: () => currentPin,
      setPin: (p) => { currentPin = p; },
      firePaseo: () => { for (const f of paseoSubs) f(); },
    };
    w("panes.mjs", `
      const g = globalThis.__b17pf;
      export const getPanes = () => g.panes;
      export const subscribePanes = (l) => (g.panesSubs.add(l), () => g.panesSubs.delete(l));
      export const toggleSplit = () => { g.callsLog.push(["toggleSplit"]); g.panes.split = !g.panes.split; for (const f of g.panesSubs) f(); };
      export const openAgent = (id) => { g.callsLog.push(["openAgent", id]); g.panes.leftActiveId = id; for (const f of g.panesSubs) f(); };
      export const openAgentInTab = (id, side) => { g.callsLog.push(["openAgentInTab", id, side]); if (side === "right") { g.panes.split = true; g.panes.rightActiveId = id; g.panes.activePane = "right"; } else g.panes.leftActiveId = id; for (const f of g.panesSubs) f(); };
      export const closeTab = () => {};
    `);
    w("paseo.mjs", `
      const g = globalThis.__b17pf;
      export const getPaseoState = () => ({ rosterLoaded: true, agents: new Map() });
      export const subscribePaseo = (l) => (g.paseoSubs.add(l), () => g.paseoSubs.delete(l));
    `);
    w("pins.mjs", `
      const g = globalThis.__b17pf;
      export const liveBuddyId = (p) => p?.brainstorm?.agent?.status && p.brainstorm.agent.status !== "closed" ? p.brainstorm.agent.id : null;
      export const dormantBuddyId = () => null;
      export const hubPinForSquad = () => null;
      export const isHubPin = () => false;
      export const pinsForSquad = () => ({ pinned: [g.getPin()], done: [] });
    `);
    w("ui.mjs", `export const derived = () => ({ views: [{ team: { id: "sq1" } }] }); export const subscribeTree = () => () => {};`);
    w("teams.mjs", `export const subscribeTeams = () => () => {};`);
    w("PinGrid.mjs", `export const openPin = async () => null;`);
    w("identity.mjs", `export const isRetiredAgent = () => false;`);
    w("ctxMenuLogic.mjs", `export const focusDrawerOpen = () => false; export const hubOpenAgent = () => false;`);
    w("prefs.mjs", `export const getPref = () => "boring"; export const getRestoreLastView = () => false;`);
    w("pinFocusLogic.mjs", transformSync("pinFocusLogic.ts", read("src", "pinFocusLogic.ts"), { lang: "ts" }).code);
    const pfCode = transformSync("pinFocus.ts", read("src", "pinFocus.ts"), { lang: "ts" }).code
      .replace(/from "react"/, `from ${JSON.stringify(import.meta.resolve("react"))}`)
      .replace(/from "\.\/([^"]+)"/g, (_, m) => `from "./${m}.mjs"`);
    w("pinFocus.mjs", pfCode);
    const { spinUpPin } = await import(pathToFileURL(join(pfDir, "pinFocus.mjs")).href);

    // Case 1: unrelated agent on left; new Buddy enters store BEFORE openPinFn resolves
    let resolveSpawn;
    const p1 = spinUpPin(currentPin, undefined, () => new Promise((r) => { resolveSpawn = r; }), "right");
    // Simulate quickStart upserting the new Buddy into the store before promise resolves
    currentPin = { ...currentPin, brainstorm: { agent: { id: "new-bs-1", status: "running" } } };
    globalThis.__b17pf.firePaseo();
    assert.equal(panes.split, true, "split stays on during mid-flight reconcile");
    assert.equal(panes.leftActiveId, "left-agent", "left pane untouched during mid-flight reconcile");
    assert.equal(panes.rightActiveId, "new-bs-1", "new Buddy lands in right pane during mid-flight reconcile");
    assert.ok(!callsLog.some((c) => c[0] === "toggleSplit"), "toggleSplit was never called");
    resolveSpawn("new-bs-1");
    await p1;
    assert.equal(panes.split, true, "split stays on after resolve");
    assert.equal(panes.rightActiveId, "new-bs-1");
    assert.equal(panes.leftActiveId, "left-agent");

    // Case 2: same-lane Lead on left; new Buddy enters store BEFORE promise resolves
    callsLog.length = 0;
    panes.split = true; panes.leftActiveId = "wiki-lead"; panes.rightActiveId = null;
    currentPin = { ...currentPin, brainstorm: null };
    let resolveSpawn2;
    const p2 = spinUpPin(currentPin, undefined, () => new Promise((r) => { resolveSpawn2 = r; }), "right");
    currentPin = { ...currentPin, brainstorm: { agent: { id: "new-bs-2", status: "running" } } };
    globalThis.__b17pf.firePaseo();
    assert.equal(panes.split, true, "split stays on when left pane holds same-lane Lead");
    assert.equal(panes.leftActiveId, "wiki-lead", "same-lane Lead on left untouched");
    assert.equal(panes.rightActiveId, "new-bs-2", "new Buddy still opens in right pane");
    resolveSpawn2("new-bs-2");
    await p2;

    // Case 3 (B18d / UX N9): user closes split mid-spawn -> does NOT re-open split AND does NOT steal single-pane focus (reconcile path)
    callsLog.length = 0;
    panes.split = true; panes.leftActiveId = "left-agent"; panes.rightActiveId = null;
    currentPin = { ...currentPin, brainstorm: null };
    let resolveSpawn3;
    const p3 = spinUpPin(currentPin, undefined, () => new Promise((r) => { resolveSpawn3 = r; }), "right");
    panes.split = false;
    currentPin = { ...currentPin, brainstorm: { agent: { id: "new-bs-3", status: "running" } } };
    globalThis.__b17pf.firePaseo();
    resolveSpawn3("new-bs-3");
    await p3;
    assert.equal(panes.split, false, "closing split mid-spawn does not re-open it");
    assert.equal(panes.leftActiveId, "left-agent", "B18d N9: closing split mid-spawn leaves single-pane agent untouched");
    assert.ok(!callsLog.some((c) => c[0] === "openAgent" || c[0] === "openAgentInTab"), "B18d N9: show(id, 'right') no-ops when split closed");

    // Case 4 (B18d / UX N9): user closes split mid-spawn, agent arrives only on promise resolve (no mid-flight reconcile) -> still no-op
    callsLog.length = 0;
    panes.split = true; panes.leftActiveId = "left-agent"; panes.rightActiveId = null;
    currentPin = { ...currentPin, brainstorm: null };
    let resolveSpawn4;
    const p4 = spinUpPin(currentPin, undefined, () => new Promise((r) => { resolveSpawn4 = r; }), "right");
    panes.split = false;
    resolveSpawn4("new-bs-4");
    await p4;
    assert.equal(panes.split, false, "B18d N9 post-resolve: closing split mid-spawn does not re-open it");
    assert.equal(panes.leftActiveId, "left-agent", "B18d N9 post-resolve: single-pane agent untouched");
    assert.ok(!callsLog.some((c) => c[0] === "openAgent" || c[0] === "openAgentInTab"), "B18d N9 post-resolve: show(id, 'right') no-ops");
  } finally {
    delete globalThis.__b17pf;
    rmSync(pfDir, { recursive: true, force: true });
  }
});

test("CSS: fluid measure vars, B17 section scoped/single-line, Psycho + styles.css untouched", () => {
  const css = read("src", "boring.css");
  assert.ok(css.includes("--measure-col: clamp(880px, 90%, 1680px);") && css.includes("--measure-prose: min(100%, 960px);"));
  const a = css.indexOf("/* ---- B17 deadspace"), b = css.indexOf("/* --- D4 polish");
  assert.ok(a > 0 && b > a, "B17 section sits before D4 polish");
  const sec = css.slice(a, b);
  for (const line of sec.split("\n").filter((l) => l.includes("{") && !l.startsWith("/*") && !l.startsWith("@container"))) assert.match(line.trim(), /^html\[data-vibe="boring"\] /);
  assert.doesNotMatch(sec, /!important|@media|@keyframes/);
  assert.ok(sec.includes(".boring-empty-card { max-width: 720px;"));
  for (const sel of [".timeline > *", ".composer > *", ".perm-card", '[data-testid="tl-pinned-todo"]']) assert.ok(css.includes(`html[data-vibe="boring"] ${sel} {`) , sel);
  assert.doesNotMatch(read("src", "styles.css"), /boring-pp-|--measure-col/);
  assert.doesNotMatch(read("src", "BoringPanePicker.tsx"), /Hypnospace/i);
});

const chromium = resolvePlaywright({ npx: false })?.chromium ?? null;
const exe = findBrowser();
const skip = browserSkipReason({ pw: chromium, exe });
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const init = (theme, vibe = "boring") => `try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"${vibe}","app.theme":"${theme}"}));}catch{}`;
async function app(b, E, baseUrl, w, hh, dpr, theme, qs = "?demo=1") {
  const ctx = await b.newContext({ viewport: { width: w, height: hh }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.addInitScript(init(theme));
  await E.installRoutes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/${qs}`, { waitUntil: "domcontentloaded" });
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
      // UX N8: user bubble right edge aligns with assistant prose right edge (within 1px) at wide widths
      if (w >= 2560) {
        const align = await page.evaluate(() => {
          const u = [...document.querySelectorAll(".boring-drawer .tl-user")].find((x) => x.getBoundingClientRect().width > 0);
          const p = [...document.querySelectorAll(".boring-drawer .tl-assistant .tl-body, .boring-drawer .tl-assistant p")].find((x) => x.getBoundingClientRect().width > 0);
          return u && p ? { u: Math.round(u.getBoundingClientRect().right), p: Math.round(p.getBoundingClientRect().right) } : null;
        });
        assert.ok(align && Math.abs(align.u - align.p) <= 1, `N8 user/prose right edge at ${w}: ${JSON.stringify(align)}`);
      }
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
    // r3/r4: pane-local right card, UX N2, N7, Gemini L2 (non-vacuous Switch to Brainstorm), UX M4 (live Start Brainstorm + Start Bugs keep split)
    { const { ctx, page } = await app(b, E, baseUrl, 1600, 900, 1, "dark", "?demo=1&riff=1");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      await page.locator('[data-testid="boring-split-empty"]').waitFor();
      // UX N7: no strip chip ever renders the placeholder "Lead · Lane" or "Buddy · Lane"
      const stripTexts = await page.locator('[data-testid^="boring-pp-agent-"]').allInnerTexts();
      assert.ok(stripTexts.length > 0, "strip has items");
      for (const t of stripTexts) assert.doesNotMatch(t, /\b(Lead|Buddy) · Lane\b/, `N7 placeholder label in strip: ${t}`);
      await page.locator('[data-testid="boring-pp-open-wiki-brainstorm"]').click();
      const card = page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-card"]');
      await card.waitFor({ timeout: 3000 });
      const before = await card.innerText();
      assert.match(await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-lane"]').innerText(), /wiki/i);
      assert.match(await page.locator('[data-testid="boring-breadcrumb"], .boring-breadcrumb').first().innerText(), /wiki/i, "breadcrumb names the right card's lane");
      await page.locator('[data-testid="boring-pane-left"]').click({ position: { x: 20, y: 20 } });
      await page.waitForTimeout(300);
      assert.equal(await card.innerText(), before, "left-pane click does not rewrite the right card");
      assert.doesNotMatch(await card.innerText(), /RiffBot is sleeping/);
      // Gemini L2: non-vacuous "Switch to Brainstorm" on bug-chaser (live Brainstorm, dormant Lead in ?demo=1&riff=1)
      await page.locator('[data-testid="boring-pp-back"]').click();
      const bugLeadPill = page.locator('[data-testid="boring-pp-open-bug-chaser-lead"]:not(.live)');
      assert.equal(await bugLeadPill.count(), 1, "bug-chaser has a dormant Lead pill in ?demo=1&riff=1");
      await bugLeadPill.click();
      const cta = page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-cta"]');
      assert.match(await cta.innerText(), /Switch to Brainstorm/);
      await cta.click();
      await page.locator('[data-testid="boring-pane-right"] .drawer').waitFor({ timeout: 3000 });
      assert.equal(await page.locator('[data-testid="boring-chat-split"]').count(), 1, "split stays on after Switch to Brainstorm");
      assert.equal(await page.locator('[data-testid="boring-pp-empty"]').count(), 0, "empty card replaced by Brainstorm drawer");
      assert.equal(await page.locator('[data-testid="boring-pane-right"] .drawer').count(), 1, "Brainstorm drawer opened in right pane");
      assert.equal(await page.locator('[data-testid="boring-pane-left"] .drawer').count(), 1, "left pane drawer kept");
      assert.match(await page.locator('[data-testid="boring-breadcrumb"], .boring-breadcrumb').first().innerText(), /Bug Chaser/i);
      await ctx.close(); }
    // r4 UX M4 live: Start Brainstorm on wiki card AND Start Brainstorm on Bugs card keep split and land in right pane
    for (const [label, pillId] of [["wiki", "boring-pp-open-wiki-brainstorm"], ["bugs", "boring-pp-open-_bugs-open"]]) {
      const { ctx, page } = await app(b, E, baseUrl, 1600, 900, 1, "dark", "?demo=1&riff=1");
      const leftBefore = await page.locator('[data-testid="boring-agent-header"]').first().getAttribute("data-agent-id");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      await page.locator('[data-testid="boring-split-empty"]').waitFor();
      await page.locator(`[data-testid="${pillId}"]`).click();
      await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-card"]').waitFor({ timeout: 3000 });
      await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-cta"]').click();
      await page.locator('[data-testid="boring-pane-right"] [data-testid="boring-agent-header"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-testid="boring-chat-split"]').count(), 1, `M4 (${label}): split stays on after Start Brainstorm`);
      assert.equal(await page.locator('[data-testid="boring-pane-left"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id"), leftBefore, `M4 (${label}): left pane agent untouched`);
      const rightId = await page.locator('[data-testid="boring-pane-right"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id");
      assert.ok(rightId && rightId !== leftBefore, `M4 (${label}): new Brainstorm opened in right pane (${rightId})`);
      await ctx.close();
    }
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
