// Boring Mode B3 (docs/PLAN_BORING_MODE.md): AngelBezel renders a compact corporate header when <html data-vibe="boring">.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const src = readFileSync(resolve(import.meta.dirname, "..", "src", "AngelBezel.tsx"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "vs-boring-b3-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
const stub = (name, body) => writeFileSync(join(dir, name), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);
globalThis.__opened = [];
globalThis.__toasts = [];
stub("PinIdeas.mjs", "export const showPinToast = (m) => globalThis.__toasts.push(m);");
stub("pinFocus.mjs", "export const openPinMember = (pin, id) => globalThis.__opened.push([pin.lane.id, id]);");
stub("SkyZones.mjs", `export const FaceStage = () => React.createElement("i", { "data-stub": "face" });\nexport const useSkyBezel = () => ({ frameStyle: null });`);
stub("skyZonesLogic.mjs", "export const angelCssScale = () => 4; export const cloudStripStyle = () => undefined; export const faceBg = () => null; export const SKY_CLOUDS_URL = () => '';");
stub("uiScale.mjs", "export const useUiScale = () => 1;");
stub(
  "useBotFace.mjs",
  "export const useBotFace = () => null; export const useDpr = () => 1; export const useFacesModel = () => null; export const useImageOk = () => false; export const usePrefersReducedMotion = () => false; export const useSkyCloudsModel = () => null; export const useTheme = () => 'dark';",
);
const code = transformSync("AngelBezel.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from ${JSON.stringify(reactUrl)}`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "AngelBezel.mjs"), code);
const { AngelBezel, BoringPerfectionBar, isBoringVibe } = await import(pathToFileURL(join(dir, "AngelBezel.mjs")).href);

const member = (id) => ({ agent: { id } });
const pin = (over = {}) => ({ lane: { id: "per", name: "Perfection" }, brainstorm: member("bs"), lead: member("ld"), ...over });
const bar = (p, onOpen) => React.createElement(BoringPerfectionBar, { pin: p, onOpen });
// Walk the element tree (function components are called with their props) to find a button by testid.
function find(node, testid) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((n) => find(n, testid)).find(Boolean) ?? null;
  if (node.props?.["data-testid"] === testid) return node;
  return find(node.props?.children, testid);
}
const tree = (p, onOpen) => BoringPerfectionBar({ pin: p, onOpen });

test("isBoringVibe: only 'boring' is boring; unset/fun/other default to fun", () => {
  assert.equal(isBoringVibe("boring"), true);
  for (const v of [null, undefined, "", "fun", "Boring"]) assert.equal(isBoringVibe(v), false);
});

test("fun mode (no document / default): AngelBezel renders the CRT strip and bezel, no boring bar", () => {
  const html = renderToStaticMarkup(React.createElement(AngelBezel, { pin: pin(), onOpen: () => {} }));
  assert.match(html, /data-testid="angel-strip"/);
  assert.match(html, /data-testid="angel-bezel"/);
  assert.match(html, /data-testid="angel-hit"/);
  assert.doesNotMatch(html, /angel-boring-bar/);
});

test("boring bar markup: title, @per badge, both buttons; no CRT bezel", () => {
  const html = renderToStaticMarkup(bar(pin(), () => {}));
  assert.match(html, /data-testid="angel-boring-bar"/);
  assert.match(html, /aria-label="Workflows &amp; Perfection"/);
  assert.match(html, /data-testid="angel-boring-title">Workflows &amp; Perfection</);
  assert.match(html, /<code class="angel-boring-code">@per<\/code>/);
  assert.match(html, /data-testid="angel-open-brainstorm"/);
  assert.match(html, /data-testid="angel-open-lead"/);
  assert.doesNotMatch(html, /angel-bezel|angel-strip/);
});

test("boring bar: no pin disables both; no lead disables Lead only", () => {
  let t = tree(null, () => {});
  assert.equal(find(t, "angel-open-brainstorm").props.disabled, true);
  assert.equal(find(t, "angel-open-lead").props.disabled, true);
  t = tree(pin(), undefined);
  assert.equal(find(t, "angel-open-brainstorm").props.disabled, true);
  t = tree(pin({ lead: null }), () => {});
  assert.equal(find(t, "angel-open-brainstorm").props.disabled, false);
  assert.equal(find(t, "angel-open-lead").props.disabled, true);
  assert.equal(find(t, "angel-open-lead").props.title, "Lead (none)");
});

test("boring bar: Brainstorm calls onOpen(pin); Lead calls openPinMember(pin, lead id); rejected onOpen toasts", async () => {
  const p = pin();
  const seen = [];
  const t = tree(p, (x) => void seen.push(x));
  find(t, "angel-open-brainstorm").props.onClick();
  assert.deepEqual(seen, [p]);
  find(t, "angel-open-lead").props.onClick();
  assert.deepEqual(globalThis.__opened, [["per", "ld"]]);
  find(tree(p, () => Promise.reject("boom")), "angel-open-brainstorm").props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(globalThis.__toasts.length, 1);
  assert.match(globalThis.__toasts[0], /Could not open Perfection: boom/);
});

// ---- B2: <BoringApp> whole-app shell (src/BoringAde.tsx) -------------------------------------------------
// BoringApp is transpiled with stubbed siblings and a tiny synchronous useState, so clicks can be driven without a DOM.
const ade = readFileSync(resolve(import.meta.dirname, "..", "src", "BoringAde.tsx"), "utf8");
const hs = (globalThis.__hs = { slots: [], i: 0 });
globalThis.__calls = [];
globalThis.__agents = new Map();
const rec = (name) => `(...a) => { globalThis.__calls.push(["${name}", ...a]); }`;
writeFileSync(
  join(dir, "react-hooks.mjs"),
  `export * from ${JSON.stringify(reactUrl)};
export const useState = (init) => { const h = globalThis.__hs; const k = h.i++; if (!(k in h.slots)) h.slots[k] = typeof init === "function" ? init() : init; return [h.slots[k], (v) => { h.slots[k] = typeof v === "function" ? v(h.slots[k]) : v; }]; };`,
);
for (const n of ["AgentDrawer", "UsageDashboard", "IdeaInbox", "TeamFeed"]) stub(`${n}.mjs`, `export function ${n}() { return null; }`);
stub("panes.mjs", `export const openAgent = ${rec("openAgent")}; export const usePanes = () => ({ activePane: "left", leftActiveId: null, rightActiveId: null });`);
stub("paseo.mjs", `export const sendMessage = ${rec("sendMessage")}; export const usePaseo = () => ({ agents: globalThis.__agents });`);
stub("pinActions.mjs", `export const createQuickBugsPin = (id) => { globalThis.__calls.push(["createQuickBugsPin", id]); return Promise.resolve({ lane: { id: "bug" } }); };`);
stub("pinFocusBoring.mjs", `export const openPinMember = ${rec("openPinMember")};`);
stub(
  "pins.mjs",
  `export const isHubPin = (p) => Boolean(p.lane.hub); export const pinsForSquad = (v) => ({ pinned: v.pins, done: [] });
export const quickBugsChipState = (v) => v.bugs ?? { pin: null, leadRunning: false, needsYou: 0 }; export const perfectionPin = () => null;`,
);
stub(
  "prefs.mjs",
  `export const setPref = ${rec("setPref")};
export const formatTimestamp = (iso, _f, now) => (iso ? Math.round((now - Date.parse(iso)) / 60000) + "m" : "");`,
);
stub("FirstRunModal.mjs", `export const VIBE_PICKED_KEY = "vs.vibePicked"; export const VibePickerCards = () => null; export const FirstLaunchVibePicker = () => null; export const shouldShowFirstLaunchVibePicker = () => false;`);
stub("railCheckin.mjs", `export const runCheckin = (pin, deps) => { globalThis.__calls.push(["runCheckin", pin.lane.id, typeof deps.open, typeof deps.send]); return Promise.resolve("send"); };`);
stub("skyZonesBoring.mjs", "export const skyZonesFor = (v) => v.zones;");
stub("ui.mjs", `export const StatusDot = function StatusDot() { return null; };`);
const adeCode = transformSync("BoringAde.tsx", ade, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/skyZonesLogic"/, `from "./skyZonesBoring"`)
  .replace(/from "\.\/pinFocus"/,`from "./pinFocusBoring"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringAde.mjs"), adeCode);
const { BoringApp, boringConversationAge, boringActiveRole, boringSidebarModel } = await import(pathToFileURL(join(dir, "BoringAde.mjs")).href);

const NOW = Date.parse("2026-11-11T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const mem = (id, status = "idle", updatedAt = ago(5), attention = null) => ({ agent: { id, status, updatedAt }, attention });
const lanePin = (id, over = {}) => ({ lane: { id, name: `Lane ${id}`, code: id === "ade" ? "ade" : undefined }, brainstorm: mem(`${id}-bs`), lead: null, workers: [], needsYou: 0, running: 0, ...over });
const zone = (member) => ({ agentId: member?.agent.id ?? null, member, agent: member?.agent });
const squad = (over = {}) => ({
  team: { id: "vs", name: "VibeSquad" },
  members: [],
  pins: [lanePin("ade", { lead: mem("ade-ld", "running", ago(1)), needsYou: 2 }), lanePin("per"), lanePin("hub", { lane: { id: "hub", name: "RiffBot", hub: true } })],
  zones: { hub: { lane: { id: "hub" } }, riffbot: zone(mem("rb")), overlord: zone(mem("ov", "running", ago(120), { tone: "ask" })) },
  bugs: { pin: lanePin("bug", { brainstorm: mem("bug-bs") }), leadRunning: true, needsYou: 1 },
  needsYou: 0,
  running: 0,
  ...over,
});

const reset = () => {
  hs.slots = [];
  globalThis.__calls = [];
  globalThis.__agents = new Map();
};
const walk = (n, f, out = []) => {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) return n.forEach((c) => walk(c, f, out)), out;
  if (f(n)) out.push(n);
  walk(n.props?.children, f, out);
  return out;
};
const byId = (t, id) => walk(t, (n) => n.props?.["data-testid"] === id)[0] ?? null;
const byType = (t, name) => walk(t, (n) => typeof n.type === "function" && n.type.name === name)[0] ?? null;
const props = (view, extra = {}) => ({
  views: [view],
  view,
  onSelectSquad() {},
  onOpenPin: (p) => void globalThis.__calls.push(["onOpenPin", p.lane.id]),
  onSpinUpPin: (p) => void globalThis.__calls.push(["onSpinUpPin", p.lane.id]),
  onSpinUpOverlord: (v) => void globalThis.__calls.push(["onSpinUpOverlord", v.team.id]),
  onAddBuddy: () => void globalThis.__calls.push(["onAddBuddy"]),
  onNewSquad() {},
  onSettings: () => void globalThis.__calls.push(["onSettings"]),
  onSuccessor() {},
  ...extra,
});
const render = (p) => ((hs.i = 0), BoringApp(p));

test("boringConversationAge: newest updatedAt across brainstorm, lead and workers; empty when none", () => {
  assert.equal(boringConversationAge({ brainstorm: mem("a", "idle", ago(30)), lead: mem("b", "idle", ago(10)), workers: [mem("w", "idle", ago(60))] }, NOW), "10m");
  assert.equal(boringConversationAge({ brainstorm: null, lead: null, workers: [mem("w", "idle", ago(3))] }, NOW), "3m");
  assert.equal(boringConversationAge({ brainstorm: null, lead: null, workers: [] }, NOW), "");
});

test("boringActiveRole: lead only when the active agent is the pin's lead", () => {
  const p = { brainstorm: mem("bs"), lead: mem("ld") };
  assert.equal(boringActiveRole(p, "ld"), "lead");
  assert.equal(boringActiveRole(p, "bs"), "brainstorm");
  assert.equal(boringActiveRole(p, null), "brainstorm");
  assert.equal(boringActiveRole({ brainstorm: null, lead: null }, "ld"), "brainstorm");
});

test("boringSidebarModel: core triad and conversations (hub excluded) with @code, age and ids", () => {
  const m = boringSidebarModel(squad(), NOW);
  assert.equal(m.core.overlord.label, "★ Overlord");
  assert.equal(m.core.overlord.status, "running");
  assert.equal(m.core.overlord.needsYou, 1);
  assert.equal(m.core.overlord.age, "120m");
  assert.equal(m.core.riffbot.label, "RiffBot");
  assert.equal(m.core.riffbot.needsYou, 0);
  assert.equal(m.core.bugs.label, "Bugs (@bug)");
  assert.equal(m.core.bugs.agentId, "bug-bs");
  assert.equal(m.core.bugs.needsYou, 1);
  assert.deepEqual(m.conversations.map((c) => c.laneId), ["ade", "per"]);
  const first = m.conversations[0];
  assert.equal(first.code, "@ade");
  assert.equal(first.age, "1m");
  assert.equal(first.brainstormId, "ade-bs");
  assert.equal(first.leadId, "ade-ld");
  assert.equal(first.leadStatus, "running");
  assert.equal(first.needsYou, 2);
  assert.equal(m.conversations[1].code, "@per");
  assert.equal(m.conversations[1].leadId, null);
  assert.equal(m.conversations[1].leadStatus, "none");
});

test("boringSidebarModel: a Squad with no pins has no conversations", () => {
  assert.deepEqual(boringSidebarModel(squad({ pins: [] }), NOW).conversations, []);
});

test("BoringApp sidebar: CTA, core rows, conversation pills and bottom dock are present", () => {
  reset();
  const t = render(props(squad()));
  for (const id of ["boring-sidebar", "boring-new-conv-btn", "boring-core-overlord", "boring-core-riffbot", "boring-core-bugs", "boring-conv-ade", "boring-conv-brainstorm-ade", "boring-conv-lead-ade", "boring-conv-per", "boring-conv-lead-per", "boring-usage-btn", "boring-settings-btn", "boring-switch-vibespace-btn", "boring-new-project-btn", "boring-project-overview-btn"]) {
    assert.ok(byId(t, id), id);
  }
  byId(t, "boring-new-conv-btn").props.onClick();
  byId(t, "boring-settings-btn").props.onClick();
  assert.deepEqual(globalThis.__calls.map((c) => c[0]), ["onAddBuddy", "onSettings"]);
});

test("Switch to Psycho sets app.vibe back to fun", () => {
  reset();
  byId(render(props(squad())), "boring-switch-vibespace-btn").props.onClick();
  assert.deepEqual(globalThis.__calls, [["setPref", "app.vibe", "fun"]]);
});

test("Lead pill: no lead running shows the empty card; running lead renders AgentDrawer and enables Check in", () => {
  reset();
  const view = squad();
  byId(render(props(view)), "boring-conv-lead-per").props.onClick();
  let t = render(props(view));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Lead is running yet/);
  assert.equal(byType(t, "AgentDrawer"), null);
  assert.equal(byId(t, "boring-checkin-btn").props.disabled, true);

  reset();
  globalThis.__agents.set("ade-ld", { id: "ade-ld" });
  byId(render(props(view)), "boring-conv-lead-ade").props.onClick();
  assert.deepEqual(globalThis.__calls.map(([n, pin, id]) => [n, pin.lane.id, id]), [["openPinMember", "ade", "ade-ld"]]);
  t = render(props(view));
  assert.equal(byType(t, "AgentDrawer").props.agent.id, "ade-ld");
  assert.equal(byId(t, "boring-empty-card"), null);
  const checkin = byId(t, "boring-checkin-btn");
  assert.equal(checkin.props.disabled, false);
  checkin.props.onClick();
  assert.deepEqual(globalThis.__calls.at(-1), ["runCheckin", "ade", "function", "function"]);
});

test("Brainstorm pill opens the agent; with no session it starts one via onOpenPin", () => {
  reset();
  byId(render(props(squad())), "boring-conv-brainstorm-ade").props.onClick();
  assert.deepEqual(globalThis.__calls, [["openAgent", "ade-bs"]]);
  reset();
  const v2 = squad({ pins: [lanePin("ade", { brainstorm: null })] });
  byId(render(props(v2)), "boring-conv-brainstorm-ade").props.onClick();
  assert.deepEqual(globalThis.__calls, [["onOpenPin", "ade"]]);
  const t = render(props(v2));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Brainstorm session/);
  byId(t, "boring-empty-cta").props.onClick();
  assert.deepEqual(globalThis.__calls.at(-1), ["onOpenPin", "ade"]);
});

test("Overlord row with no Overlord offers Start Overlord; Bugs row without a pin creates one", async () => {
  reset();
  const view = squad({ zones: { hub: { lane: { id: "hub" } }, riffbot: zone(null), overlord: zone(null) }, bugs: { pin: null, leadRunning: false, needsYou: 0 } });
  byId(render(props(view)), "boring-core-overlord").props.onClick();
  const t = render(props(view));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Overlord is running/);
  byId(t, "boring-empty-cta").props.onClick();
  assert.deepEqual(globalThis.__calls, [["onSpinUpOverlord", "vs"]]);
  byId(render(props(view)), "boring-core-bugs").props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(globalThis.__calls.slice(1), [["createQuickBugsPin", "vs"], ["onOpenPin", "bug"]]);
});

test("Usage & Workflows and Project Overview swap the main pane", () => {
  reset();
  const view = squad();
  byId(render(props(view)), "boring-usage-btn").props.onClick();
  let t = render(props(view));
  assert.ok(byId(t, "boring-usage-view"));
  assert.ok(byType(t, "UsageDashboard"));
  assert.equal(byId(t, "boring-chat-column"), null);
  byId(t, "boring-project-overview-btn").props.onClick();
  t = render(props(view));
  assert.ok(byId(t, "boring-project-view"));
  assert.ok(byId(t, "boring-card-grid"));
  assert.equal(byId(t, "boring-lane-table"), null);
  assert.equal(walk(t, (n) => n.type === "table").length, 0);
  for (const id of ["boring-card-overlord", "boring-card-riffbot", "boring-card-bugs", "boring-card-ade", "boring-card-per"]) assert.ok(byId(t, id), id);
  const labels = (id) => walk(byId(t, id), (n) => n.type === "button").map((b) => b.props.children);
  assert.deepEqual(labels("boring-card-ade"), ["Open Brainstorm", "Open Lead", "Check in"]);
  assert.ok(byType(t, "IdeaInbox"));
  assert.ok(byType(t, "TeamFeed"));
  // Lead-less lane: Open Lead and Check in are disabled.
  const per = walk(byId(t, "boring-card-per"), (n) => n.type === "button");
  assert.deepEqual(per.map((b) => !!b.props.disabled), [false, true, true]);
  // No sky / tower / floor / art in Boring Mode.
  for (const name of ["SkyZones", "SquadFloor", "AngelBezel"]) assert.equal(byType(t, name), null, name);
  assert.equal(walk(t, (n) => /angel-bezel|angel-strip/.test(String(n.props?.className ?? ""))).length, 0);
});

test("BoringApp renders App's overlays as children", () => {
  reset();
  const t = render(props(squad(), { children: React.createElement("div", { "data-testid": "overlay" }) }));
  assert.ok(byId(t, "overlay"));
});

test("B2r boring.css: system fonts, full-height chat geometry, lane-only role pills, 4K card grid, details disclosure", () => {
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  assert.match(css, /--arcade: var\(--sans\)/);
  assert.match(css, /--display: var\(--sans\)/);
  assert.match(css, /\.boring-chat-column > \.drawer,[^{]*\{[^}]*flex: 1 1 0/);
  assert.match(css, /\.drawer-shell\s*\{[^}]*flex: 1 1 0/);
  assert.match(css, /\.boring-conv-row:not\(\.on\) \.boring-role-pills \{ display: none/);
  assert.match(css, /\.boring-card-grid \{[^}]*repeat\(auto-fit, minmax\(clamp\(/);
  assert.match(css, /\.boring-chat-column:not\(\.boring-details-open\) \.successor-bar/);
  assert.ok(!/min-height: 32px/.test(css));
});

test("B2r: Details toggle lives in the topbar (not the sidebar) and the chat column carries boring-details-open", () => {
  assert.match(ade, /data-testid="boring-details-toggle"/);
  assert.match(ade, /boring-chat-column\$\{detailsOpen \? " boring-details-open" : ""\}/);
  assert.ok(!/>Project Overview<\/button>\s*\n\s*<button[^>]*>Usage & Workflows<\/button>/.test(ade.split('className="boring-topbar-actions"')[1] ?? ""));
});

test("B4: Normal/Psycho labels, first-launch picker wiring and B2r2 CSS", () => {
  const read = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");
  const fr = read("FirstRunModal.tsx"), app = read("App.tsx"), css = read("boring.css");
  assert.match(ade, /✦ Switch to Psycho/);
  assert.doesNotMatch(ade + fr + app, /Switch to Vibespace|Hypnospace/);
  assert.match(app, /data-testid="toolbar-vibe-toggle"\s+title="Switch to Normal mode"/);
  assert.match(app, /Normal mode\n/);
  assert.match(fr, /VIBE_PICKED_KEY = "vs\.vibePicked"/);
  for (const id of ["first-run-vibe-picker", "first-run-vibe-normal", "first-run-vibe-psycho"]) assert.ok(fr.includes(`data-testid="${id}"`), id);
  assert.match(fr, /export function FirstLaunchVibePicker/);
  assert.match(ade, /export \{ VIBE_PICKED_KEY, VibePickerCards, FirstLaunchVibePicker, shouldShowFirstLaunchVibePicker \}/);
  assert.equal((app.match(/<FirstLaunchVibePicker \/>/g) ?? []).length, 2);
  assert.match(css, /\.composer \.send,[\s\S]*background: var\(--accent\) !important/);
  assert.match(css, /#475569 !important/);
  assert.match(css, /clamp\(14px, 0\.45vw \+ 12px, 18px\); line-height: 1\.55/);
  assert.match(css, /\.drawer-head select,[\s\S]*min-height: 36px/);
  assert.match(css, /--accent: #0f62fe/);
  assert.doesNotMatch(css, /@media/);
});

test("shouldShowFirstLaunchVibePicker: fresh installs only, never automation", async () => {
  const src = readFileSync(resolve(import.meta.dirname, "..", "src", "FirstRunModal.tsx"), "utf8");
  const fnSrc = src.slice(src.indexOf("export function shouldShowFirstLaunchVibePicker"), src.indexOf("const cardStyle"));
  const code = transformSync("f.ts", `const VIBE_PICKED_KEY = "vs.vibePicked"; const FIRST_RUN_DONE_KEY = "vs.firstRunDone"; ${fnSrc}`, { lang: "ts" }).code;
  writeFileSync(join(dir, "shouldShow.mjs"), code);
  const { shouldShowFirstLaunchVibePicker: show } = await import(pathToFileURL(join(dir, "shouldShow.mjs")).href);
  const st = (o) => (k) => o[k] ?? null;
  assert.equal(show({ getItem: st({}), webdriver: false }), true);
  assert.equal(show({ getItem: st({}), webdriver: true }), false);
  assert.equal(show({ getItem: st({ "vs.forceVibePicker": "1" }), webdriver: true }), true);
  assert.equal(show({ getItem: st({ "vs.vibePicked": "1" }), webdriver: false }), false);
  assert.equal(show({ getItem: st({ "vs.firstRunDone": "1" }), webdriver: false }), false);
  assert.equal(show({ getItem: st({ "vs.prefs.v1": JSON.stringify({ "app.vibe": "fun" }) }), webdriver: false }), false);
  assert.equal(show({ getItem: st({ "vs.prefs.v1": JSON.stringify({ "chat.x": 1 }) }), webdriver: false }), true);
});
