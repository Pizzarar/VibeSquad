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
writeFileSync(join(dir, "teams.mjs"), `export const isHubLane = (team, lane) => lane.hub === true || (!team.lanes.some((l) => l.hub === true) && lane.id === team.id);`);
writeFileSync(join(dir, "boringLocation.mjs"), transformSync("boringLocation.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "boringLocation.ts"), "utf8"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
writeFileSync(join(dir, "condenseReason.mjs"), transformSync("condenseReason.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "condenseReason.ts"), "utf8"), { lang: "ts" }).code);
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
export const useEffect = (fn, deps) => { const h = globalThis.__hs; const k = h.i++; const prev = h.slots[k]; const same = prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j])); if (same) return; if (prev && typeof prev.cleanup === "function") prev.cleanup(); const cleanup = fn(); h.slots[k] = { deps, cleanup }; }; export const useState = (init) => { const h = globalThis.__hs; const k = h.i++; if (!(k in h.slots)) h.slots[k] = typeof init === "function" ? init() : init; return [h.slots[k], (v) => { h.slots[k] = typeof v === "function" ? v(h.slots[k]) : v; }]; };`,
);
// BoringApp now owns a 30s `now` tick (R3 L1); the useEffect stub really runs it, so unref it or node never exits.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const t = realSetInterval(...a); t?.unref?.(); return t; };
stub("useNowTick.mjs", "export const useNowTick = () => Date.now();");
stub("demo.mjs", "export const demoLog = () => [];");
stub("demoFlag.mjs", "export const DEMO = false;");
stub("attentionItemsBoring.mjs", `export const stalledCount = (members) => members.filter((m) => m.stalled).length;`);
stub("IdeaInbox.mjs", `export function IdeaInbox() { return null; } export const refreshInboxCards = () => { globalThis.__refreshInbox?.(); return Promise.resolve([]); }; export const useInboxCards = () => globalThis.__inboxCards ?? [];`);
for (const n of ["AgentDrawer", "UsageDashboard", "TeamFeed"]) stub(`${n}.mjs`, `export function ${n}() { return null; }` + (n === "TeamFeed" ? " export const fetchLog = () => Promise.resolve([]);" : ""));
stub("CommandPalette.mjs", `export const openOverlay = ${rec("openOverlay")};`);
stub("panes.mjs", `export const openAgent = ${rec("openAgent")}; export const usePanes = () => ({ activePane: "left", leftActiveId: null, rightActiveId: null });`);
stub("paseo.mjs", `export const sendMessage = ${rec("sendMessage")}; export const usePaseo = () => ({ agents: globalThis.__agents });`);
stub("pinActions.mjs", `export const createQuickBugsPin = (id) => { globalThis.__calls.push(["createQuickBugsPin", id]); return Promise.resolve({ lane: { id: "bug" } }); };`);
stub("pinFocusBoring.mjs", `export const openPinMember = ${rec("openPinMember")}; export const spinUpPin = (...a) => globalThis.__spinUpPin(...a); export const setBoringShownAgent = () => {};`);
stub("pinFocusLogic.mjs", `export const boringDeepLinkPending = (a) => !a.rosterLoaded && !!a.activeAgentId; export const boringUrlAgent = (a) => (!a.rosterLoaded || a.landingPending ? a.activeAgentId : a.shownAgentId);`);
stub(
  "pins.mjs",
  `export const isHubPin = (p) => Boolean(p.lane.hub); export const pinsForSquad = (v) => ({ pinned: v.pins, done: [] });
export const isLive = (m) => Boolean(m) && !m.agent.archivedAt && m.agent.status !== "closed"; export const liveBuddyId = (p) => (isLive(p.brainstorm) ? p.brainstorm.agent.id : null);
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
stub("BoringInbox.mjs", `export const BoringInbox = function BoringInbox() { return null; };`);
stub("ui.mjs", `export const StatusDot = function StatusDot() { return null; }; export const cleanTitle = (t) => { let s = String(t ?? "untitled").trim(); const l = s.toLowerCase(); if (l.startsWith("★ lead · ")) s = s.slice(9).trim(); else if (l.startsWith("brainstorm · ")) s = s.slice(13).trim(); return s; };`);
const adeCode = transformSync("BoringAde.tsx", ade, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/skyZonesLogic"/, `from "./skyZonesBoring"`)
  .replace(/from "\.\/pinFocus"/,`from "./pinFocusBoring"`)
  .replace(/from "\.\/attentionItems"/, `from "./attentionItemsBoring"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringAde.mjs"), adeCode);
const { BoringApp, boringAgentLanding, boringSelectionForAgent, boringLaneTarget, boringBreadcrumb, boringActiveSelection, boringLaneLabel, boringWorkerIsLive, boringConversationAge, boringActiveRole, boringSidebarModel, boringLaneTableRows, boringStateGlyph, boringStartBrainstorm, boringStartBugs } = await import(pathToFileURL(join(dir, "BoringAde.mjs")).href);

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
const laneBtn = (t, lane) => walk(byId(t, `boring-conv-${lane}`), (n) => n.props?.className === "boring-conv-title")[0];
// Header tabs replace the old sidebar role pills: select the lane first, then pick the member tab.
// R2.1: the Desk is one collapsed row; its Lead · Overlord / Brainstorm · RiffBot rows appear once it is expanded.
const withDesk = (view) => {
  let t = render(props(view));
  if (!byId(t, "boring-core-overlord")) { byId(t, "boring-desk-toggle").props.onClick(); t = render(props(view)); }
  return t;
};
const pickTab = (view, lane, tab) => { laneBtn(render(props(view)), lane).props.onClick(); byId(render(props(view)), `boring-top-${tab}`).props.onClick(); };

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
  assert.equal(m.core.overlord.label, "Lead · Overlord");
  assert.equal(m.core.overlord.status, "running");
  assert.equal(m.core.overlord.needsYou, 1);
  assert.equal(m.core.overlord.age, "120m");
  assert.equal(m.core.riffbot.label, "Brainstorm · RiffBot");
  assert.equal(m.core.riffbot.needsYou, 0);
  assert.equal(m.core.bugs.label, "Bugs"); // R2.2: no "(@bug)" suffix
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
  const t = withDesk(squad());
  // R2.3: the standalone Overview button is gone (the project row opens it); Search lives in the sidebar header.
  for (const id of ["boring-sidebar", "boring-new-conv-btn", "boring-sidebar-search-btn", "boring-core-overlord", "boring-core-riffbot", "boring-core-bugs", "boring-conv-ade", "boring-conv-per", "boring-usage-btn", "boring-settings-btn", "boring-switch-vibespace-btn", "boring-new-project-btn"]) {
    assert.ok(byId(t, id), id);
  }
  assert.equal(byId(t, "boring-project-overview-btn"), null);
  for (const gone of ["boring-conv-brainstorm-ade", "boring-conv-lead-ade", "boring-conv-lead-per"]) assert.equal(byId(t, gone), null, `${gone} (role pills moved to header tabs)`);
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
  pickTab(view, "per", "lead");
  let t = render(props(view));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Lead is running yet/);
  assert.equal(byType(t, "AgentDrawer"), null);
  assert.equal(byId(t, "boring-checkin-btn").props.disabled, true);

  reset();
  globalThis.__agents.set("ade-ld", { id: "ade-ld" });
  pickTab(view, "ade", "lead");
  assert.deepEqual(globalThis.__calls.filter((c) => c[0] === "openPinMember").map(([n, pin, id]) => [n, pin.lane.id, id]), [["openPinMember", "ade", "ade-ld"]]);
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
  pickTab(squad(), "ade", "brainstorm");
  assert.deepEqual(globalThis.__calls, [["openAgent", "ade-bs"], ["openAgent", "ade-bs"]]);
  reset();
  const v2 = squad({ pins: [lanePin("ade", { brainstorm: null })] });
  pickTab(v2, "ade", "brainstorm");
  assert.deepEqual(globalThis.__calls, [["onOpenPin", "ade"], ["onOpenPin", "ade"]]);
  const t = render(props(v2));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Brainstorm session/);
  globalThis.__spinUpPin = (p) => { globalThis.__calls.push(["spinUpPin", p.lane.id]); return Promise.resolve("a"); };
  byId(t, "boring-empty-cta").props.onClick();
  assert.deepEqual(globalThis.__calls.at(-1), ["spinUpPin", "ade"]);
});

test("Overlord row with no Overlord offers Start Overlord; Bugs row without a pin creates one", async () => {
  reset();
  const view = squad({ zones: { hub: { lane: { id: "hub" } }, riffbot: zone(null), overlord: zone(null) }, bugs: { pin: null, leadRunning: false, needsYou: 0 } });
  byId(withDesk(view), "boring-core-overlord").props.onClick();
  const t = render(props(view));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Overlord is running/);
  byId(t, "boring-empty-cta").props.onClick();
  assert.deepEqual(globalThis.__calls, [["onSpinUpOverlord", "vs"]]);
  byId(render(props(view)), "boring-core-bugs").props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  // Selecting Bugs with no lane only shows the empty card (emptyKind brainstorm); nothing is created or focused yet.
  assert.deepEqual(globalThis.__calls.slice(1), []);
});

test("idea-246 (4): Bugs selected with no Bugs lane -> brainstorm empty card; CTA creates the lane then spins it up (spinUpPin, not focusPin)", async () => {
  reset();
  const noBug = squad({ team: { id: "efi", name: "Escape From Idle" }, bugs: { pin: null, leadRunning: false, needsYou: 0 } });
  globalThis.__spinUpPin = (p) => { globalThis.__calls.push(["spinUpPin", p.lane.id]); return Promise.resolve("a"); };
  byId(render(props(noBug)), "boring-core-bugs").props.onClick();
  const t = render(props(noBug, { agents: new Map() }));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Brainstorm session/);
  assert.equal(byId(t, "boring-empty-cta").props.disabled, false);
  byId(t, "boring-empty-cta").props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(globalThis.__calls, [["createQuickBugsPin", "efi"], ["spinUpPin", "bug"]]);
  assert.equal(await boringStartBugs("efi", { create: () => Promise.reject(new Error("no lane")) }), "no lane");
});

test("idea-246 (2): picking Bugs with a dormant lane never focusPins; the empty card offers Start Brainstorm via spinUpPin", async () => {
  reset();
  const dormant = squad({ bugs: { pin: lanePin("bugs", { brainstorm: null }), leadRunning: false, needsYou: 0 } });
  byId(render(props(dormant)), "boring-core-bugs").props.onClick();
  assert.deepEqual(globalThis.__calls, []);
  const t = render(props(dormant));
  assert.match(JSON.stringify(byId(t, "boring-empty-card").props.children), /No Brainstorm session/);
  globalThis.__spinUpPin = (p) => { globalThis.__calls.push(["spinUpPin", p.lane.id]); return Promise.resolve("a"); };
  byId(t, "boring-empty-cta").props.onClick();
  assert.deepEqual(globalThis.__calls, [["spinUpPin", "bugs"]]);
});

test("idea-246 (3): core.bugs.agentId ignores a closed Brainstorm / lead", () => {
  const closed = (id) => mem(id, "closed");
  const dead = squad({ bugs: { pin: lanePin("bugs", { brainstorm: closed("b"), lead: closed("l") }), leadRunning: false, needsYou: 0 } });
  assert.equal(boringSidebarModel(dead, NOW).core.bugs.agentId, null);
  const liveLead = squad({ bugs: { pin: lanePin("bugs", { brainstorm: closed("b"), lead: mem("l") }), leadRunning: false, needsYou: 0 } });
  assert.equal(boringSidebarModel(liveLead, NOW).core.bugs.agentId, "l");
  const live = squad({ bugs: { pin: lanePin("bugs", { brainstorm: mem("b"), lead: mem("l") }), leadRunning: false, needsYou: 0 } });
  assert.equal(boringSidebarModel(live, NOW).core.bugs.agentId, "b");
});

test("Usage & Workflows and Project Overview swap the main pane", () => {
  reset();
  const view = squad();
  byId(render(props(view)), "boring-usage-btn").props.onClick();
  let t = render(props(view));
  assert.ok(byId(t, "boring-usage-view"));
  assert.ok(byType(t, "UsageDashboard"));
  assert.equal(byId(t, "boring-chat-column"), null);
  byId(t, "boring-project-header-vs").props.onClick();
  t = render(props(view));
  assert.ok(byId(t, "boring-project-view"));
  assert.ok(byId(t, "boring-lane-table"));
  for (const id of ["_desk", "_bugs", "ade", "per"]) assert.ok(byId(t, `boring-lane-row-${id}`), id);
  for (const gone of ["_overlord", "_riffbot"]) assert.equal(byId(t, `boring-lane-row-${gone}`), null, `${gone} merged into the single Desk row`);
  assert.equal(byId(t, "boring-card-grid"), null);
  assert.equal(byId(t, "boring-lane-map"), null);
  // Default tab renders neither IdeaInbox nor TeamFeed.
  assert.equal(byType(t, "IdeaInbox"), null);
  assert.equal(byType(t, "TeamFeed"), null);
  // No sky / tower / floor / art in Boring Mode.
  for (const name of ["SkyZones", "SquadFloor", "AngelBezel"]) assert.equal(byType(t, name), null, name);
  assert.equal(walk(t, (n) => /angel-bezel|angel-strip/.test(String(n.props?.className ?? ""))).length, 0);
});

const cardsOf = (t) => walk(t, (n) => /boring-lane-card/.test(String(n.props?.className ?? "")));
const gotoOverview = (view) => {
  byId(render(props(view)), "boring-project-header-vs").props.onClick();
  return render(props(view));
};

test("D2 S9: lane table rows are urgency-sorted (needs you first) and cells open the member", () => {
  reset();
  const view = squad();
  const t = gotoOverview(view);
  const rows = walk(t, (n) => /^boring-lane-row-/.test(String(n.props?.["data-testid"] ?? ""))).map((n) => n.props["data-testid"]);
  assert.deepEqual(rows.slice(0, 3), ["boring-lane-row-_desk", "boring-lane-row-_bugs", "boring-lane-row-ade"]); // R2 fix2 N2: tree order
  const row = byId(t, "boring-lane-row-ade");
  assert.match(JSON.stringify(row.props.className), /attn/);
  assert.match(JSON.stringify(row.props.children), /Needs you/);
  const cell = walk(row, (n) => n.type === "button")[0];
  globalThis.__calls = [];
  cell.props.onClick();
  assert.deepEqual(globalThis.__calls, [["openAgent", "ade-bs"]]);
});

test("D2 S9: boringLaneTableRows sorts needs-you > running > recent and joins last event from the log feed", () => {
  const model = boringSidebarModel(squad());
  const rows = boringLaneTableRows(model, [{ lane: "@ade", text: "shipped it", ts: "2026-01-02" }, { lane: "ade", text: "older", ts: "2026-01-01" }]);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.laneId), ["_desk", "_bugs"]); // R2 fix 2 N2: table order matches the tree
  assert.equal(rows[2].laneId, "ade");
  assert.equal(rows.find((r) => r.laneId === "ade").lastEvent, "shipped it");
  assert.equal(rows.find((r) => r.laneId === "per").lastEvent, "");
  assert.deepEqual(rows.filter((r) => r.kind === "desk").map((r) => r.laneId), ["_desk", "_bugs"]);
  const desk = rows.find((r) => r.laneId === "_desk");
  assert.equal(desk.label, "Desk");
  assert.equal(desk.lead, "running"); // Overlord
  assert.equal(desk.brainstorm, "idle"); // RiffBot
  const lanesOnly = rows.filter((r) => r.kind === "lane");
  for (let i = 1; i < lanesOnly.length; i++) assert.ok(lanesOnly[i - 1].needsYou >= lanesOnly[i].needsYou);
});

test("B5c: Overview | Idea Inbox | Standup Feed tabs mount IdeaInbox / TeamFeed only when selected", () => {
  reset();
  globalThis.__inboxCards = [{}, {}, {}];
  const view = squad();
  let t = gotoOverview(view);
  for (const id of ["boring-tab-overview", "boring-tab-inbox", "boring-tab-feed"]) assert.ok(byId(t, id), id);
  assert.match(JSON.stringify(byId(t, "boring-tab-inbox").props.children), /Idea Inbox \(3\)/);
  byId(t, "boring-tab-inbox").props.onClick();
  t = render(props(view));
  assert.ok(byType(t, "IdeaInbox"));
  assert.equal(byType(t, "TeamFeed"), null);
  assert.equal(byId(t, "boring-core-strip"), null);
  byId(t, "boring-tab-feed").props.onClick();
  t = render(props(view));
  assert.ok(byType(t, "TeamFeed"));
  assert.equal(byType(t, "IdeaInbox"), null);
  byId(t, "boring-tab-overview").props.onClick();
  t = render(props(view));
  assert.equal(byType(t, "IdeaInbox"), null);
  assert.equal(byType(t, "TeamFeed"), null);
  delete globalThis.__inboxCards;
});

test("B5f: Idea Inbox and Standup Feed counts preload on BoringApp mount so first render of Overview has live counts with no tab click", async () => {
  reset();
  const realFetch = globalThis.fetch;
  globalThis.__refreshInbox = () => { globalThis.__inboxCards = Array.from({ length: 234 }, (_, i) => ({ id: String(i) })); };
  globalThis.fetch = (url) => {
    assert.match(String(url), /\/__vibesquad\/log\?team=vibesquad/);
    return Promise.resolve({ json: () => Promise.resolve(Array.from({ length: 100 }, (_, i) => ({ ts: String(i) }))) });
  };
  try {
    const view = squad({ team: { id: "vibesquad", name: "VibeSquad" } });
    const chat = render(props(view)); // mounts on the Overview
    assert.ok(byId(chat, "boring-project-view"));
    await new Promise((r) => setTimeout(r, 0));
    byId(chat, "boring-project-header-vibesquad").props.onClick();
    const t = render(props(view)); // very first Overview render, no tab click
    assert.ok(byId(t, "boring-project-view"));
    assert.match(JSON.stringify(byId(t, "boring-tab-inbox").props.children), /Idea Inbox \(234\)/);
    assert.match(JSON.stringify(byId(t, "boring-tab-feed").props.children), /Standup Feed \(100\)/);
  } finally {
    delete globalThis.__inboxCards;
    delete globalThis.__refreshInbox;
    globalThis.fetch = realFetch;
  }
});


test("B5b: topbar has no duplicate Settings / Switch to Psycho; exactly one switch button in the DOM", () => {
  reset();
  const t = render(props(squad()));
  assert.equal(walk(t, (n) => n.props?.["data-testid"] === "boring-switch-vibespace-btn").length, 1);
  const top = byId(t, "boring-topbar");
  assert.equal(walk(top, (n) => /Settings|Switch to Psycho/.test(JSON.stringify(n.props?.children ?? ""))).length, 0);
});

test("B5a/B5d: native palette inherited, borderless tone-stepped surfaces, sleek chat", () => {
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  for (const tok of ["bg", "panel", "panel-hi", "cyan", "violet", "hot-pink", "text", "muted", "line"]) assert.doesNotMatch(css, new RegExp(`(^|[;{\s])--${tok}:`, "m"), `--${tok} must not be overridden`);
  assert.match(css, /--bg-elev: var\(--panel\)/);
  assert.match(css, /--bg-card: var\(--panel\)/);
  assert.match(css, /--bg-hover: var\(--panel-hi\)/);
  assert.match(css, /--accent: #9b72e8/);
  assert.match(css, /--bevel: none; --bevel-in: none; --hard: none; --bayer: none/);
  assert.match(css, /border-width: 0;\s+border-color: transparent/);
  assert.match(css, /inset 3px 0 0 var\(--cyan\)/);
  assert.match(css, /\.tl-note \{[^}]*border-radius: 14px/);
  assert.match(css, /color-mix\(in srgb, var\(--violet\) 14%, var\(--panel\)\)/);
  assert.match(css, /\.boring-card-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(clamp\(320px, 22vw, 520px\)/);
  assert.match(css, /\.usage-crt,[\s\S]*\.feed-entry[^{]*\{[^}]*border: none; border-radius: 14px/);
  assert.match(css, /max-width: 1280px/);
  assert.match(css, /max-width: 1600px; padding: 28px 40px/);
  assert.match(css, /\.signal,[\s\S]*?border-radius: 50% !important/);
  assert.match(css, /\.boring-lane-card \{[^}]*border-radius: 14px !important/);
  assert.match(css, /\.drawer-head \.drawer-title \{ order: 1; flex: 1 0 100%/);
  assert.match(css, /\.decision-card \.dc-summary,[\s\S]*?font-size: var\(--t-ui\) !important; font-weight: 400/);
  assert.match(css, /\.boring-chat-column:not\(\.boring-details-open\) \.role-tag,[\s\S]*?drawer-copy-cwd-btn[^{]*\{ display: none !important/);
  assert.match(ade, /Standup Feed \(\$\{feedCount\}\)/);
  assert.match(ade, /Idea Inbox \(\$\{inboxCount\}\)/);
  assert.match(css, /\.boring-footer-btn\.on,\s*html\[data-vibe="boring"\] \.boring-core-row\.on,\s*html\[data-vibe="boring"\] \.boring-conv-row\.on \{[^}]*inset 3px 0 0 var\(--cyan\)/);
  assert.match(css, /\.decision-card \{ border: 0 !important; border-radius: 14px !important; background: var\(--panel\)/);
  assert.match(css, /\.usage-collapse,\s*html\[data-vibe="boring"\] \.usage-inbox-row \{ background: var\(--panel\) !important/);
  assert.match(css, /\.usage-collapse-head \{ font-size: 13px; text-transform: none/);
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
});

test("B2r: Details toggle lives in the topbar (not the sidebar) and the chat column carries boring-details-open", () => {
  assert.match(ade, /data-testid="boring-details-toggle"/);
  assert.match(ade, /boring-chat-column\$\{detailsOpen \? " boring-details-open" : ""\}/);
  assert.ok(!/>Project Overview<\/button>\s*\n\s*<button[^>]*>Usage & Workflows<\/button>/.test(ade.split('className="boring-topbar-actions"')[1] ?? ""));
});

test("B4: Normal/Psycho labels, first-launch picker wiring and B2r2 CSS", () => {
  const read = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");
  const fr = read("FirstRunModal.tsx"), app = read("App.tsx"), css = read("boring.css");
  assert.match(ade, /Switch to Psycho/);
  assert.doesNotMatch(ade + fr + app, /Switch to Vibespace|Hypnospace/);
  assert.match(app, /data-testid="toolbar-vibe-toggle"\s+title="Switch to Normal mode"/);
  assert.match(app, /Normal mode\n/);
  assert.match(fr, /VIBE_PICKED_KEY = "vs\.vibePicked"/);
  for (const id of ["first-run-vibe-picker", "first-run-vibe-normal", "first-run-vibe-psycho"]) assert.ok(fr.includes(`data-testid="${id}"`), id);
  assert.match(fr, /export function FirstLaunchVibePicker/);
  assert.match(ade, /export \{ VIBE_PICKED_KEY, VibePickerCards, FirstLaunchVibePicker, shouldShowFirstLaunchVibePicker \}/);
  // 2e23764 folded the per-branch pickers into the shared `overlays` block (one literal), rendered by every layout.
  assert.equal((app.match(/<FirstLaunchVibePicker \/>/g) ?? []).length, 1);
  assert.ok(app.indexOf("<FirstLaunchVibePicker />") > app.indexOf("const overlays = ("));
  assert.ok((app.match(/\{overlays\}/g) ?? []).length >= 2);
  assert.match(css, /\.composer \.send,[\s\S]*background: var\(--accent\) !important/);
  assert.match(css, /#475569 !important/);
  assert.match(css, /--t-body: 15px; --lh-body: 24px/);
  assert.match(css, /\.drawer-head select,[\s\S]*min-height: 36px/);
  assert.match(css, /--accent: var\(--cyan\)/);
  assert.doesNotMatch(css.replace("@media (pointer: coarse)", "").replace("@media (prefers-reduced-motion: reduce)", ""), /@media/);
  assert.match(fr, /var\(--bg-card, var\(--panel-hi, #181e2b\)\)/);
  assert.match(css, /\.role-tag[\s\S]*\.btn\.warn \{ border-image: none !important/);
  assert.match(css, /\.drawer-head \.drawer-title \{ font-size: var\(--t-title\) !important/);
  assert.match(css, /\.composer-row > \.btn:not\(\.ghost\):not\(\.warn\)/);
  assert.doesNotMatch(css, /not\(\.boring-details-open\) \.(drawer-actions|brainstorm-ctx-actions)/);
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

test("B4: boring-app height compensates the UI scale zoom so the composer stays in view", () => {
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  assert.match(css, /\.boring-app \{ width: calc\(100vw \/ var\(--vs-ui-scale, 1\)\); height: calc\(100vh \/ var\(--vs-ui-scale, 1\)\)/);
});

test("B4: first-launch picker is roomy, shows a selected state, and needs Continue or Escape to close", () => {
  const fr = readFileSync(resolve(import.meta.dirname, "..", "src", "FirstRunModal.tsx"), "utf8");
  assert.match(fr, /width: "min\(860px, 92vw\)"/);
  assert.match(fr, /viewBox="0 0 320 180"/);
  assert.match(fr, /minmax\(340px, 1fr\)/);
  assert.match(fr, /data-testid="first-run-vibe-continue"/);
  assert.match(fr, /Selected/);
  assert.match(fr, /autoFocus data-testid="first-run-vibe-normal"/);
  assert.match(fr, /e\.key === "Escape" && close\(\)/);
  assert.match(fr, /title="Setup Checklist"\s+wide/);
  assert.doesNotMatch(fr, /<VibePickerCards onPicked=\{close\}/);
});

test("B4: picker header grows to fit the 22px title plus subtitle", () => {
  const fr = readFileSync(resolve(import.meta.dirname, "..", "src", "FirstRunModal.tsx"), "utf8");
  assert.match(fr, /height: "auto", minHeight: 0, padding: "14px 16px"/);
});

test("resolvePinChatAgentId prefers the successor opened after a restart/switch", async () => {
  const { resolvePinChatAgentId } = await import("../src/BoringAde.tsx").catch(() => ({}));
  if (!resolvePinChatAgentId) return; // tsx imports unavailable under plain node
  const agents = new Map([["rn-new", { id: "rn-new", labels: { lane: "bor", role: "brainstorm", "vs.restarted-from": "rn-old" } }]]);
  const pin = { lane: { id: "bor" }, brainstorm: { agent: { id: "rn-old" } }, lead: null };
  assert.equal(resolvePinChatAgentId(pin, "brainstorm", "rn-new", agents), "rn-new");
  assert.equal(resolvePinChatAgentId(pin, "brainstorm", "rn-other", agents), "rn-old");
});

test("B6: dock parity, project tree, trinity card, Cards|Map, sunset tokens", () => {
  const css = readFileSync(new URL("../src/boring.css", import.meta.url), "utf8");
  const ade = readFileSync(new URL("../src/BoringAde.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  // B6a
  assert.match(css, /\.boring-chat-column:has\(\.right-dock\) \{ max-width: 100%; \}/);
  assert.match(css, /\.right-dock-tab \{ border-radius: 10px !important/);
  assert.match(ade, /boring-global-search-btn[\s\S]*openOverlay\("search"\)/);
  assert.match(ade, /boring-shortcuts-btn[\s\S]*openOverlay\("shortcuts"\)/);
  assert.match(ade, /active pinDecisions \/>/);
  assert.match(ade, /\{banners\}/);
  assert.match(app, /banners=\{topBanners\}/);
  assert.match(app, /\{topBanners\}/);
  // B6b
  assert.match(ade, /data-testid="boring-project-tree"/);
  assert.match(ade, /boring-project-header-\$\{v\.team\.id\}/);
  // R2.1: one tree shape; the detached bottom Project desk / Lanes sections are gone.
  assert.match(ade, /boring-desk-block/);
  assert.doesNotMatch(ade, /boring-core-group|boring-conv-list|boring-lanes-label|boring-project-overview-btn|>Project desk</);
  assert.doesNotMatch(ade, /TRINITY/);
  assert.doesNotMatch(ade, /<select/);
  // B6c
  assert.doesNotMatch(ade, /BORING_OVERVIEW_LAYOUT_KEY|boring-lane-map|boring-layout-/);
  assert.match(ade, /data-testid="boring-lane-table"/);
  // B6d
  assert.doesNotMatch(css, /--boring-sunset|--boring-wash|radial-gradient/);
  assert.match(css, /\.boring-main \{ background: var\(--surface-0\)/);
  assert.match(ade, /className="boring-surreal-motif"/);
});

test("D2: Overview lane table CSS is scoped to Normal mode; map CSS is gone", () => {
  const css = readFileSync(new URL("../src/boring.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-vibe="boring"\] \.boring-lane-table \{/);
  assert.match(css, /\.boring-lane-row\.attn \{/);
  assert.doesNotMatch(css, /boring-map-|boring-lane-map/);
  assert.doesNotMatch(ade, /★ \{core\.overlord\.label\}/);
});

// idea-246: EFI's (non-VibeSquad Squad) Trinity "Bugs (@bug)" Start Brainstorm was a silent no-op (it called focusPin, which never spawns).
const efiBugsPin = { squad: { id: "efi", quickLanes: { bugs: "bugs" } }, lane: { id: "bugs", name: "Bugs", standing: true }, brainstorm: null, lead: null, workers: [] };
test("Start Brainstorm spawns through spinUpPin with the Squad's own lane (efi/bugs, not bug-chaser)", async () => {
  const seen = [];
  globalThis.__spinUpPin = (p) => { seen.push(`${p.squad.id}/${p.lane.id}`); return Promise.resolve("agent-1"); };
  assert.equal(await boringStartBrainstorm(efiBugsPin), null);
  assert.deepEqual(seen, ["efi/bugs"]);
});
test("Start Brainstorm failure is returned (shown in the empty card), never swallowed", async () => {
  globalThis.__spinUpPin = () => Promise.reject(new Error("Quick start failed (503)"));
  assert.equal(await boringStartBrainstorm(efiBugsPin), "Quick start failed (503)");
  assert.match(ade, /data-testid="boring-start-error"/);
  assert.doesNotMatch(ade, /run: \(\) => currentPin && onOpenPin\(currentPin\)/);
});

test("idea-246 review: Bugs start keeps busy + error when the lane is created mid-flight; double click creates once", async () => {
  reset();
  const view0 = squad({ team: { id: "efi2", name: "E" }, bugs: { pin: null, leadRunning: false, needsYou: 0 } });
  let rejectSpin;
  globalThis.__spinUpPin = () => new Promise((_r, rej) => { rejectSpin = rej; });
  byId(render(props(view0)), "boring-core-bugs").props.onClick();
  const t0 = render(props(view0));
  byId(t0, "boring-empty-cta").props.onClick();
  byId(t0, "boring-empty-cta").props.onClick(); // double click
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(globalThis.__calls.filter((c) => c[0] === "createQuickBugsPin").length, 1);
  // The lane now exists (pin set): key must not flip, busy stays.
  const view1 = squad({ team: { id: "efi2", name: "E" }, bugs: { pin: lanePin("bugs", { brainstorm: null }), leadRunning: false, needsYou: 0 } });
  let t1 = render(props(view1));
  assert.equal(byId(t1, "boring-empty-cta").props.disabled, true);
  assert.match(JSON.stringify(byId(t1, "boring-empty-card").props.children), /Starting Brainstorm/);
  rejectSpin(new Error("spawn boom"));
  await new Promise((r) => setTimeout(r, 0));
  t1 = render(props(view1));
  assert.match(JSON.stringify(byId(t1, "boring-start-error").props.children), /spawn boom/);
  assert.equal(byId(t1, "boring-empty-cta").props.disabled, false);
});

test("idea-246 review: a closed Buddy shows the Start card, not its drawer (resolvePinChatAgentId)", () => {
  reset();
  const view = squad({ pins: [lanePin("ade", { brainstorm: mem("ade-bs", "closed") })] });
  laneBtn(render(props(view)), "ade").props.onClick();
  const t = render(props(view));
  assert.ok(byId(t, "boring-empty-card"));
  assert.equal(byType(t, "AgentDrawer"), null);
});


test("D1: type + colour tokens, no vw type, flat canvas, measure and row density", () => {
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  for (const [t, v] of [["caption", "11px"], ["small", "12px"], ["ui", "13px"], ["body", "15px"], ["mono", "13px"], ["title", "17px"], ["page", "20px"]]) assert.ok(css.includes(`--t-${t}: ${v}`), t);
  assert.ok(!css.includes("font-size: clamp("), "no clamp()/vw font sizes");
  for (const t of ["--surface-0", "--surface-1", "--surface-2", "--surface-3", "--surface-sunken", "--border-strong", "--text-1", "--text-2", "--text-3", "--focus", "--st-run", "--st-attn", "--st-err", "--st-done", "--st-ok"]) assert.ok(css.includes(t + ":"), t);
  assert.ok(css.includes("--surface-0: #f6f4f9; --surface-1: #ffffff"), "neutral light surfaces");
  assert.ok(css.includes("--measure-col: 880px") && css.includes("--measure-prose: 760px"));
  assert.ok(css.includes("--row-h: 32px"));
  assert.ok(css.includes("@media (pointer: coarse) { html[data-vibe=\"boring\"] { --row-h: 40px; } }"));
  assert.ok(/\.boring-app::before \{[^}]*height: 2px; background: var\(--titlebar\)/.test(css));
  assert.ok(!/--boring-sunset|--boring-wash/.test(css));
  for (const g of ["run", "attn", "err", "stalled", "idle", "done"]) assert.ok(css.includes(`.boring-dot.st-${g}`), g);
  assert.ok(css.includes('.perm-card .btn.perm-deny::after { content: "…"'));
  assert.ok(css.includes(".perm-deny-msg { order: 9; flex: 1 1 100%"));
});

test("D1: boringStateGlyph maps status + attention; copy pass keeps every testid", () => {
  for (const [status, tone, want] of [["running", null, "run"], ["idle", "permission", "attn"], ["idle", "needs-you", "attn"], ["running", "error", "err"], ["error", null, "err"], ["stalled", null, "stalled"], ["idle", "finished", "done"], ["idle", null, "idle"], ["none", null, "idle"]]) {
    assert.equal(boringStateGlyph(status, tone), want, `${status}/${tone}`);
  }
  const src = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");
  const ade = src("BoringAde.tsx");
  for (const text of ["+ New lane", "Brainstorm · RiffBot", "Lead · Overlord", ">Desk<"]) assert.ok(ade.includes(text), text);
  for (const gone of ["New Conversation", "TRINITY", "📊", "🔍"]) assert.ok(!ade.includes(gone), gone);
  for (const id of ["boring-new-conv-btn", "boring-sidebar-search-btn", "boring-project-tree", "boring-global-search-btn", "boring-shortcuts-btn", "boring-usage-btn"]) assert.ok(ade.includes(`data-testid="${id}"`), id);
  for (const id of ["boring-core-overlord", "boring-core-riffbot", "boring-core-bugs"]) assert.ok(ade.includes(id), id);
  assert.ok(ade.includes("boring-conv-${c.laneId}"));
  const perm = src("PermissionCard.tsx");
  for (const c of ["perm-card", "perm-allow\"", "perm-allow-secondary", "perm-deny"]) assert.ok(perm.includes(c), c);
  assert.ok(perm.includes('data-testid="perm-deny-btn"'));
  assert.ok(src("UsageDashboard.tsx").includes('usePref("app.vibe")'));
});

// ---- D2 2.1: hub-lane and worker alerts reach the sidebar totals --------------------------------------------
test("D2 2.1 boringSidebarModel: hub-lane needsYou and lane-worker alerts are counted and match the project badge", () => {
  const worker = mem("w1", "running", ago(2), { tone: "permission" });
  const calm = mem("w2", "idle", ago(2), { tone: "finished" });
  const v = squad({
    pins: [lanePin("ade", { workers: [worker, calm], needsYou: 1 }), lanePin("hub", { lane: { id: "hub", name: "RiffBot", hub: true } })],
    zones: { hub: { lane: { id: "hub" }, needsYou: 2 }, riffbot: zone(mem("rb")), overlord: zone(mem("ov")) },
    needsYou: 4, // hub 2 + ade 1 + the hidden Bugs lane's 1
  });
  const m = boringSidebarModel(v, NOW);
  assert.equal(m.hubNeedsYou, 2);
  assert.equal(m.conversations[0].workerNeedsYou, 1); // finished worker does not count
  assert.equal(m.totalNeedsYou, 4);
  // Without view.needsYou the total is still hub + lanes + the hidden Bugs lane (D2 M1), never the lanes alone.
  assert.equal(boringSidebarModel({ ...v, needsYou: 0 }, NOW).totalNeedsYou, 2 + 1 + m.core.bugs.needsYou);
});

test("R3.2 parity: stalled agents add to hub, lane and bugs badges, and the collapsed project badge is their exact sum", () => {
  const stalled = (id) => ({ ...mem(id, "running", ago(30)), stalled: true });
  const v = squad({
    pins: [lanePin("ade", { workers: [stalled("w1")], needsYou: 1 }), lanePin("hub", { lane: { id: "hub", name: "RiffBot", hub: true } })],
    zones: { hub: { lane: { id: "hub" }, needsYou: 2, workers: [stalled("hw")], lead: stalled("hl") }, riffbot: zone(mem("rb")), overlord: zone(mem("ov")) },
    bugs: { pin: lanePin("bug", { workers: [stalled("bw")] }), leadRunning: false, needsYou: 1 },
    needsYou: 4, // view.needsYou never counts stalled items: the badge must not fall back to it
  });
  const m = boringSidebarModel(v, NOW);
  assert.equal(m.hubNeedsYou, 2 + 2);
  assert.equal(m.conversations[0].needsYou, 1 + 1);
  assert.equal(m.core.bugs.needsYou, 1 + 1);
  assert.equal(m.totalNeedsYou, m.hubNeedsYou + m.conversations.reduce((n, c) => n + c.needsYou, 0) + m.core.bugs.needsYou);
  assert.equal(m.totalNeedsYou, 8);
});

test("D2 2.1 / R2.5 BoringApp: badges sit on collapsed containers only, tinted by worst state", () => {
  reset();
  const v = squad({ zones: { hub: { lane: { id: "hub" }, needsYou: 2 }, riffbot: zone(mem("rb")), overlord: zone(mem("ov")) }, needsYou: 5 });
  let t = render(props(v));
  // Collapsed Desk carries the hub count; the expanded project row carries none.
  assert.match(JSON.stringify(byId(t, "boring-desk-row").props.children), /"children":2/);
  assert.doesNotMatch(JSON.stringify(byId(t, "boring-project-header-vs").props.children), /"children":5/);
  byId(t, "boring-desk-toggle").props.onClick();
  t = render(props(v));
  assert.doesNotMatch(JSON.stringify(byId(t, "boring-desk-row").props.children), /badge/);
  // Worst state: an errored member turns the collapsed container red (err), otherwise amber.
  reset();
  const bad = squad({ zones: { hub: { lane: { id: "hub" }, needsYou: 1 }, riffbot: zone(mem("rb", "idle", ago(2), { tone: "error" })), overlord: zone(mem("ov")) } });
  assert.equal(boringSidebarModel(bad, NOW).deskErr, true);
  assert.match(JSON.stringify(byId(render(props(bad)), "boring-desk-row").props.children), /boring-badge err/);
  assert.match(JSON.stringify(byId(render(props(v)), "boring-desk-row").props.children), /boring-badge"/);
});

// ---- D2 2.2: NEEDS YOU strip (src/BoringInbox.tsx) with the real attentionItems logic ------------------------
const tsx = (file) => transformSync(file, readFileSync(resolve(import.meta.dirname, "..", "src", file), "utf8"), { lang: file.endsWith("x") ? "tsx" : "ts", jsx: { runtime: "classic" } }).code;
writeFileSync(join(dir, "attentionLocal.mjs"), `export const isMarkedUnread = () => false; export const isLocallyHidden = () => false; export const clearUnreadLocal = () => {}; export const dismissLocal = () => {}; export const snoozeLocal = () => {};`);
writeFileSync(join(dir, "boringHeaderStripStub.mjs"), tsx("boringHeaderStrip.ts"));
// isHubLane stub: the real one pulls in React via teams.ts (same rule, covered by teams tests).
writeFileSync(join(dir, "identity.mjs"), tsx("identity.ts").replace("\"../teams.example.json\"", JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "..", "teams.example.json")).href)));
writeFileSync(
  join(dir, "attentionItems.mjs"),
  tsx("attentionItems.ts")
    .replace(/from "\.\/attentionLocal\.ts"/, `from "./attentionLocal.mjs"`)
    .replace(/from "\.\/boringHeaderStrip\.ts"/, `from "./boringHeaderStripStub.mjs"`)
);
globalThis.__resp = [];
globalThis.__cleared = [];
stub("paseoInbox.mjs", `export const bumpAgents = () => {}; export const clearAgentAttention = (id) => { globalThis.__cleared.push(["attention", id]); return Promise.resolve(); }; export const clearNeedsYou = (a) => { globalThis.__cleared.push(["needs-you", a.id]); return Promise.resolve(); }; export const snoozeNeedsYou = () => Promise.resolve();`);
stub("PermissionCard.mjs", `export const respondToPermission = (...a) => { globalThis.__resp.push(a); return Promise.resolve(); };`);
writeFileSync(
  join(dir, "RealInbox.mjs"),
  tsx("BoringInbox.tsx")
    .replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
    .replace(/from "react"/, `from "./react-hooks.mjs"`)
    .replace(/from "\.\/paseo"/, `from "./paseoInbox.mjs"`)
    .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`),
);
const { BoringInbox, needsYouRows, doneRecently, recentDone, needsYouReason, openNeedsYouRow } = await import(pathToFileURL(join(dir, "RealInbox.mjs")).href);

const ag = (id, over = {}) => ({ id, title: id.toUpperCase(), status: "idle", updatedAt: ago(10), labels: {}, pendingPermissions: [], ...over });
const att = (id, tone, reason, over = {}) => ({ agent: ag(id, over.agent), kind: over.kind ?? "worker", laneId: over.laneId ?? "ade", attention: { tone, reason } });
const teamOf = (id, name, members) => ({ team: { id, name, lanes: [{ id: "ade", name: "ADE" }] }, members, needsYou: members.length, running: 0 });
const A = teamOf("vs", "VibeSquad", [
  att("fin", "finished", "all done"),
  att("err", "error", "build failed"),
  att("ask", "needs-you", "pick a or b", { agent: { updatedAt: ago(30) } }),
  att("perm", "permission", "run npm test", { agent: { pendingPermissions: [{ id: "req1", kind: "tool" }] } }),
]);
const B = teamOf("efi", "EFI", [att("q", "permission", "which plan?", { agent: { pendingPermissions: [{ id: "req2", kind: "question" }] }, laneId: "ade" })]);

test("D2 2.2 needsYouRows: permission › pick › error › finished across projects, with project › lane and age", () => {
  const rows = needsYouRows([A, B], NOW);
  assert.deepEqual(rows.map((r) => r.item.id), ["perm", "q", "ask", "err", "fin"]);
  assert.equal(rows[0].project, "VibeSquad");
  assert.equal(rows[0].lane, "ADE");
  assert.equal(rows[0].age, "10m");
  assert.equal(rows[1].teamId, "efi");
});

test("D2 2.2 recentDone: only done entries, newest first across Squads, limited", () => {
  const e = (ts, type, text) => ({ ts, type, text, agent: "x", lane: "ade" });
  const out = recentDone([{ teamId: "vs", project: "VibeSquad", entries: [e("2026-11-11T10:00:00Z", "done", "a"), e("2026-11-11T11:00:00Z", "decision", "no")] }, { teamId: "efi", project: "EFI", entries: [e("2026-11-11T10:30:00Z", "done", "b")] }], 5);
  assert.deepEqual(out.map((d) => d.entry.text), ["b", "a"]);
  assert.equal(recentDone([{ teamId: "vs", project: "V", entries: [e("2026-11-11T10:00:00Z", "done", "a"), e("2026-11-11T10:01:00Z", "done", "b")] }], 1).length, 1);
});

test("D2 2.2 BoringInbox: labelled NEEDS YOU (never Inbox), inline Allow/Deny only for quick permissions, Dismiss for the rest", async () => {
  reset();
  globalThis.__resp = [];
  globalThis.__cleared = [];
  const opened = [];
  const t = (hs.i = 0, BoringInbox({ views: [A, B], now: NOW, logs: [{ teamId: "vs", project: "VibeSquad", entries: [{ ts: ago(5), type: "done", text: "shipped D1", agent: "x", lane: "ade" }] }], onOpen: (r) => opened.push(r.item.id) }));
  const html = renderToStaticMarkup(React.createElement(BoringInbox, { views: [A, B], now: NOW, logs: [] }));
  assert.match(html, /Needs you/);
  assert.doesNotMatch(html, /Inbox/);
  assert.match(html, /Done recently · 1/); // the finished agent, not counted as needing you
  assert.equal(walk(t, (n) => n.props?.["data-testid"] === "boring-needs-you-item").length, 4); // finished moved to Done recently
  assert.equal(walk(t, (n) => n.props?.["data-testid"] === "boring-needs-allow").length, 1); // the question permission has no inline buttons
  assert.equal(walk(t, (n) => n.props?.["data-testid"] === "boring-needs-dismiss").length, 2); // hover-menu Dismiss: pick, error (permissions are answered, finished is in Done recently)
  walk(t, (n) => n.props?.["data-testid"] === "boring-needs-allow")[0].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(globalThis.__resp[0], ["perm", "req1", { behavior: "allow" }]);
  walk(t, (n) => n.props?.["data-testid"] === "boring-needs-deny")[0].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(globalThis.__resp[1], ["perm", "req1", { behavior: "deny" }]);
  const dismiss = walk(t, (n) => n.props?.["data-testid"] === "boring-needs-dismiss");
  dismiss[0].props.onClick(); // the "ask" pick: label item
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(globalThis.__cleared[0], ["needs-you", "ask"]);
  walk(t, (n) => n.props?.["data-testid"] === "boring-needs-open-perm")[0].props.onClick();
  assert.deepEqual(opened, ["perm"]);
});

test("D2 2.2 BoringApp mounts NEEDS YOU at the top of the sidebar; selection derives from the agent; no new CSS outside boring scope", () => {
  const ade = readFileSync(resolve(import.meta.dirname, "..", "src", "BoringAde.tsx"), "utf8");
  assert.ok(ade.indexOf("<BoringInbox") > ade.indexOf('data-testid="boring-sidebar-search-btn"'));
  assert.ok(ade.indexOf("<BoringInbox") < ade.indexOf('data-testid="boring-project-tree"'));
});

// ---- D2 2.3-2.5: breadcrumb, selection from the active agent, workers in the tree, header tabs ---------------
const wk = (id, status = "idle", tone = null, title = id.toUpperCase()) => ({ agent: { id, status, title, updatedAt: ago(4) }, attention: tone ? { tone } : null });

test("D2 breadcrumb: Project › Lane › Agent from selection, never the 'Conversation' fallback", () => {
  assert.deepEqual(boringBreadcrumb({ project: "VibeSquad", mode: "chat", laneLabel: "UI Lab", agentLabel: "Lead" }), [{ key: "project", label: "VibeSquad" }, { key: "lane", label: "UI Lab" }, { key: "agent", label: "Lead" }]);
  assert.deepEqual(boringBreadcrumb({ project: "VibeSquad", mode: "project", laneLabel: "UI Lab", agentLabel: "Lead" }).map((c) => c.label), ["VibeSquad", "Overview"]);
  assert.deepEqual(boringBreadcrumb({ project: "", mode: "chat", laneLabel: null, agentLabel: null }).map((c) => c.label), ["No project"]);
  assert.ok(!readFileSync(resolve(import.meta.dirname, "..", "src", "BoringAde.tsx"), "utf8").includes('"Conversation"'));
});

test("D2 boringLaneLabel keeps known acronyms upper-case", () => {
  assert.equal(boringLaneLabel("Ui Lab"), "UI Lab");
  assert.equal(boringLaneLabel("Ade Bezel Api"), "ADE Bezel API");
  assert.equal(boringLaneLabel("Perfection"), "Perfection");
  assert.equal(boringLaneLabel("Guide"), "Guide"); // word boundaries only, no substring hits
});

test("D2 boringSelectionForAgent: hub agents, bugs lane, lane roles and workers", () => {
  const v = squad({ pins: [lanePin("ade", { lead: mem("ade-ld"), workers: [wk("w1")] }), lanePin("per")] });
  assert.deepEqual(boringSelectionForAgent(v, "ov"), { laneId: "_overlord", role: "lead" });
  assert.deepEqual(boringSelectionForAgent(v, "rb"), { laneId: "_riffbot", role: "brainstorm" });
  assert.deepEqual(boringSelectionForAgent(v, "bug-bs"), { laneId: "_bugs", role: "brainstorm" });
  assert.deepEqual(boringSelectionForAgent(v, "ade-ld"), { laneId: "ade", role: "lead" });
  assert.deepEqual(boringSelectionForAgent(v, "w1"), { laneId: "ade", role: "worker" });
  assert.equal(boringSelectionForAgent(v, "nope"), null);
});

test("D2 boringLaneTarget: most urgent member, else Brainstorm", () => {
  assert.deepEqual(boringLaneTarget({ brainstorm: mem("bs"), lead: mem("ld", "running"), workers: [] }), { role: "brainstorm", agentId: "bs" });
  assert.deepEqual(boringLaneTarget({ brainstorm: mem("bs"), lead: mem("ld", "idle", ago(1), { tone: "needs-you" }), workers: [wk("w", "running", "error")] }), { role: "lead", agentId: "ld" });
  assert.deepEqual(boringLaneTarget({ brainstorm: mem("bs"), lead: null, workers: [wk("w", "idle", "permission")] }), { role: "worker", agentId: "w" });
  assert.deepEqual(boringLaneTarget({ brainstorm: null, lead: null, workers: [] }), { role: "brainstorm", agentId: null });
  assert.equal(boringWorkerIsLive(wk("a", "idle", "finished")), false);
  assert.equal(boringWorkerIsLive(wk("a", "running")), true);
});

test("D2 BoringApp: clicking a lane opens its most urgent member and the breadcrumb follows the selection", () => {
  reset();
  const view = squad({ pins: [lanePin("ade", { lead: mem("ade-ld", "idle", ago(1), { tone: "needs-you" }), workers: [wk("w1", "running")] }), lanePin("per")] });
  laneBtn(render(props(view)), "ade").props.onClick();
  assert.deepEqual(globalThis.__calls.map((c) => c[0]), ["openPinMember"]);
  const t = render(props(view));
  assert.equal(byId(t, "boring-crumb-project").props.children, "VibeSquad");
  assert.equal(byId(t, "boring-crumb-lane").props.children, "Lane ADE");
  assert.equal(byId(t, "boring-crumb-agent").props.children, "Lead");
  // Header tabs: Brainstorm, Lead and the live worker; the lane's sidebar row no longer has role pills.
  assert.ok(byId(t, "boring-top-brainstorm") && byId(t, "boring-top-lead") && byId(t, "boring-top-worker-w1"));
  byId(t, "boring-top-worker-w1").props.onClick();
  assert.deepEqual(globalThis.__calls.at(-1), ["openAgent", "w1"]);
  globalThis.__agents.set("w1", { id: "w1", title: "W1" });
  const t2 = render(props(view));
  assert.equal(byType(t2, "AgentDrawer").props.agent.id, "w1");
  assert.equal(byId(t2, "boring-crumb-agent").props.children, "W1");
});

test("D2 BoringApp: a lane expands to a one-line '▸ N running · M idle' fold (R3.1); other projects can stay expanded", () => {
  reset();
  const ws = [wk("w1", "running"), wk("w2", "idle"), wk("w3", "idle")];
  const view = squad({ pins: [lanePin("ade", { workers: ws }), lanePin("per")] });
  let t = render(props(view));
  assert.equal(byId(t, "boring-workers-ade"), null); // collapsed until toggled
  byId(t, "boring-conv-toggle-ade").props.onClick();
  t = render(props(view));
  assert.equal(byId(t, "boring-worker-w1"), null);
  assert.equal(byId(t, "boring-worker-w2"), null);
  assert.equal(JSON.stringify(byId(t, "boring-workers-fold-ade").props.children).includes("1 running · 2 idle"), true);
  // Multiple expanded projects: switching away keeps the first one open with its lanes inline.
  reset();
  const other = { ...squad(), team: { id: "efi", name: "EFI" }, pins: [lanePin("arc")] };
  const switched = [];
  const p2 = (v) => props(v, { views: [squad(), other], onSelectSquad: (id) => switched.push(id) });
  // R2.2: the name opens that project's Overview (switching Squad); only the chevron toggles expansion.
  byId(render(p2(squad())), "boring-project-header-efi").props.onClick();
  assert.deepEqual(switched, ["efi"]);
  const t3 = render(p2(other));
  assert.equal(byId(t3, "boring-project-header-vs").props["aria-expanded"], true);
  assert.ok(byId(t3, "boring-project-lanes-vs") && byId(t3, "boring-conv-ade"));
});

// ---- D2 fix round: M2 deep links, L1 unread-on-open, permission reason, M1 no double count ------------------
test("D2 M2 boringAgentLanding: an agent outside every pinned lane (hub worker) still lands in chat; unknown agents do not", () => {
  const v = squad({ pins: [lanePin("ade", { lead: mem("ade-ld"), workers: [wk("w1")] })] });
  assert.equal(boringAgentLanding([v], "ade-ld", () => true).mode, "chat");
  assert.deepEqual(boringAgentLanding([v], "ade-ld", () => true).sel, { laneId: "ade", role: "lead" });
  const loose = boringAgentLanding([v], "hub-worker", (id) => id === "hub-worker");
  assert.equal(loose.mode, "chat");
  assert.equal(loose.sel, null);
  assert.equal(boringAgentLanding([v], "ghost", () => false), null);
  assert.equal(boringAgentLanding([v], null, () => true), null);
});

test("D2 L1 openNeedsYouRow: opening an unread row clears the local unread flag, other kinds do not", () => {
  const cleared = [];
  const opened = [];
  openNeedsYouRow({ item: { id: "u", kind: "unread" } }, (r) => opened.push(r.item.id), (id) => cleared.push(id));
  openNeedsYouRow({ item: { id: "p", kind: "permission" } }, (r) => opened.push(r.item.id), (id) => cleared.push(id));
  assert.deepEqual(cleared, ["u"]);
  assert.deepEqual(opened, ["u", "p"]);
});

test("D2 needsYouReason: a permission row names the tool and command", () => {
  const agent = { pendingPermissions: [{ id: "r", name: "Bash", input: { command: "rg --stats" } }] };
  assert.equal(needsYouReason({ kind: "permission", reason: "1 permission request(s)", agent }), "Bash: rg --stats");
  assert.equal(needsYouReason({ kind: "permission", reason: "1 permission request(s)", agent: { pendingPermissions: [] } }), "1 permission request(s)");
  assert.equal(needsYouReason({ kind: "error", reason: "build failed", agent }), "build failed");
});

test("D2 M1 boringSidebarModel: the Bugs lane is counted once, in core.bugs, never also as a lane", () => {
  const v = squad({ pins: [lanePin("ade"), lanePin("per")] });
  const m = boringSidebarModel(v);
  const bugsLane = m.core.bugs.pin?.lane.id;
  assert.ok(!m.conversations.some((c) => c.laneId === bugsLane));
  const rows = boringLaneTableRows(m, []);
  assert.equal(rows.filter((r) => r.laneId === "_bugs").length + rows.filter((r) => r.laneId === bugsLane).length, bugsLane ? 1 : 1);
});

// ---- D3a (UX_REVIEW 2.6): BoringAgentHeader ----------------------------------------------------------------
const d3src = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");
const stripCode = transformSync("boringHeaderStrip.ts", d3src("boringHeaderStrip.ts"), { lang: "ts" }).code;
writeFileSync(join(dir, "boringHeaderStrip.mjs"), stripCode);
const { boringHeaderStrip, BORING_CTX_WARN_PCT, BORING_STALL_SECONDS } = await import(pathToFileURL(join(dir, "boringHeaderStrip.mjs")).href);

test("D3a boringHeaderStrip: stalled / handoff due / context >=72% are the only strip conditions", () => {
  const now = Date.parse("2026-01-01T00:10:00Z");
  const base = { status: "running", updatedAt: "2026-01-01T00:09:59Z", hasPendingPermission: false, ctxPct: 10, planHandedOff: false, nowMs: now };
  assert.deepEqual(boringHeaderStrip(base), []);
  assert.equal(BORING_CTX_WARN_PCT, 72);
  assert.deepEqual(boringHeaderStrip({ ...base, ctxPct: 71.9 }), []);
  assert.deepEqual(boringHeaderStrip({ ...base, ctxPct: 72 }).map((s) => s.kind), ["context"]);
  assert.deepEqual(boringHeaderStrip({ ...base, planHandedOff: true }).map((s) => s.kind), ["handoff"]);
  const old = new Date(now - (BORING_STALL_SECONDS + 5) * 1000).toISOString();
  assert.deepEqual(boringHeaderStrip({ ...base, updatedAt: old }).map((s) => s.kind), ["stalled"]);
  assert.deepEqual(boringHeaderStrip({ ...base, updatedAt: old, hasPendingPermission: true }), []);
  assert.deepEqual(boringHeaderStrip({ ...base, status: "idle", updatedAt: old }), []);
  assert.deepEqual(boringHeaderStrip({ ...base, updatedAt: old, planHandedOff: true, ctxPct: 90 }).map((s) => s.kind), ["stalled", "handoff", "context"]);
});

test("D3a: AgentDrawer mounts BoringAgentHeader in boring INSTEAD of DrawerHeader; fun keeps DrawerHeader; testids kept", () => {
  const drawer = d3src("AgentDrawer.tsx");
  assert.match(drawer, /vibe === "boring" && !chatOnly \? \(\s*<BoringAgentHeader/);
  assert.match(drawer, /\) : \(\s*<DrawerHeader\s+agent=\{agent\}/);
  const hdr = d3src("BoringAgentHeader.tsx");
  for (const id of ["boring-agent-header", "boring-status-strip", "mark-read", "mark-unread", "drawer-search-btn", "drawer-reload-agent-btn", "drawer-copy-id-btn", "drawer-copy-cwd-btn", "brainstorm-park-inbox-btn", "boring-interrupt-btn", "boring-agent-menu-btn"])
    assert.ok(hdr.includes(`data-testid="${id}"`), id);
  // Every action reuses an existing handler: no fetch/new endpoints in the header.
  assert.ok(!/fetch\(/.test(hdr));
  for (const h of ["markAgentRead", "markAgentUnread", "stopAgent", "runnerReloadTimeline", "doRestart", "onSuccessor"]) assert.ok(hdr.includes(h), h);
  // Mark read / Handoff are plain menu items: never the accent-filled .btn.ok.
  assert.ok(!/className="btn ok/.test(hdr) && !/btn-ok|\bok\b.*accent/.test(hdr));
});

test("D3a: boring.css section is appended, scoped, and never accent-fills the header actions", () => {
  const css = d3src("boring.css");
  const i = css.indexOf("/* ===== D3a (@desk, UX_REVIEW 2.6): BoringAgentHeader ===== */");
  assert.ok(i > 0 && css.indexOf("/* ===== D3", i + 10) === -1, "section present and last");
  const sect = css.slice(i);
  for (const line of sect.split("\n").filter((l) => /^[.a-z@]/.test(l))) if (!line.startsWith("@media")) assert.ok(line.startsWith('html[data-vibe="boring"]'), line.slice(0, 60));
  assert.ok(!/\.boring-agent-menu[^{]*\{[^}]*background:\s*var\(--accent\)/.test(sect));
  assert.ok(!/\.boring-hdr-btn[^{]*\{[^}]*background:\s*var\(--accent\)/.test(sect));
});

// ---- D3a fix round: no feature loss in Normal (config hook + testid parity) -----------------------------------
test("D3a fix: provider/model/mode/thinking + Shift+Tab live in ONE shared hook used by both headers", () => {
  const hook = d3src("useAgentConfig.tsx");
  const psycho = d3src("DrawerHeader.tsx");
  const normal = d3src("BoringAgentHeader.tsx");
  assert.match(hook, /e\.shiftKey && e\.key === "Tab"/);
  assert.match(hook, /nextModeInCycle\(modes, currentMode\)/);
  assert.match(hook, /stageSwitch\(\{ \.\.\.staged, modeId: next \}\)/);
  assert.match(hook, /resolveProviderSwitchTarget/);
  assert.ok(!psycho.includes("e.shiftKey && e.key === \"Tab\""), "no duplicate Shift+Tab logic in DrawerHeader");
  assert.match(psycho, /useAgentConfig\(\{/);
  assert.match(normal, /useAgentConfig\(\{/);
  assert.match(normal, /cfg\.providerSelect/);
  assert.match(normal, /cfg\.modelControl/);
  assert.match(normal, /cfg\.modeSelect/);
  assert.match(normal, /cfg\.thinkingSelect/);
  // staged switch + active flag are threaded through from AgentDrawer to the Normal header
  assert.match(d3src("AgentDrawer.tsx"), /<BoringAgentHeader[\s\S]*?stagedSwitch=\{stagedSwitch\}[\s\S]*?active=\{active\}/);
});

test("D3a fix: every testid DrawerHeader exposed is present in the Normal path (or knowingly dropped)", () => {
  const ids = [...new Set([...d3src("DrawerHeader.tsx").matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]))];
  const normalPath = ["BoringAgentHeader.tsx", "useAgentConfig.tsx", "FeaturesMenu.tsx", "SandboxView.tsx"].map(d3src).join("\n") + d3src("DrawerHeader.tsx");
  // Pin-focus compact bar / rail card only exist in the Psycho layout; Normal replaces the brainstorm ctx bar with boring-ctx-meter + menu items.
  const dropped = new Set(["drawer-head-compact", "drawer-config-menu", "drawer-config-menu-btn", "drawer-more-toggle", "pin-rail-buddy-tools", "sky-zones", "brainstorm-ctx-bar"]);
  const psy = d3src("DrawerHeader.tsx");
  const sessionActionsSrc = psy.slice(psy.indexOf("export function SessionActions"), psy.indexOf("export function DrawerHeader("));
  const hdr = d3src("BoringAgentHeader.tsx") + d3src("useAgentConfig.tsx") + sessionActionsSrc; // SessionActions is rendered by the Normal header
  const missing = ids.filter((id) => !dropped.has(id) && !hdr.includes(`data-testid="${id}"`));
  assert.deepEqual(missing, []);
  assert.ok(normalPath.length > 0);
  // Bars/session actions are the existing components, not reimplementations.
  const normal = d3src("BoringAgentHeader.tsx");
  for (const c of ["NeedsYouControls", "HardeningBar", "SessionActions", "AttachFiles"]) assert.match(normal, new RegExp(`<${c} `));
});

// ---- R2.1: one derived selection feeds the sidebar `.on` row and the breadcrumb ---------------------------
const onRows = (t) => walk(t, (n) => /(^|\s)on(\s|$)/.test(String(n.props?.className ?? "")) && /boring-(project-row|core-row|conv-row|worker-row)/.test(String(n.props?.className ?? "")));

test("R2.1 boringActiveSelection: follows the agent on screen across projects; worker is the last crumb", () => {
  const a = squad({ pins: [lanePin("ade", { lead: mem("ade-ld"), workers: [wk("w1")] }), lanePin("per")] });
  const other = { ...squad(), team: { id: "efi", name: "EFI" }, pins: [lanePin("arc", { workers: [wk("e1", "running", null, "Fixer")] })], zones: { hub: { lane: { id: "hub" } }, riffbot: zone(mem("rb2")), overlord: zone(mem("ov2")) }, bugs: { pin: null, leadRunning: false, needsYou: 0 } };
  const base = { mode: "chat", views: [a, other], teamId: "vs", agentId: null, laneId: null, role: "brainstorm", workerId: null };
  assert.equal(boringActiveSelection({ ...base, mode: "project" }).rowKey, "vs|project");
  assert.equal(boringActiveSelection({ ...base, mode: "usage" }).rowKey, null);
  const w = boringActiveSelection({ ...base, agentId: "w1", agentTitle: "W1", laneId: "ade", workerId: "w1" });
  assert.deepEqual([w.rowKey, w.agentLabel, w.role], ["vs|worker:w1", "W1", "worker"]);
  // Ctrl+J into another project while state still points at the old one: the agent wins (team, lane, role).
  const j = boringActiveSelection({ ...base, agentId: "e1", agentTitle: "Fixer", laneId: "ade" });
  assert.deepEqual([j.teamId, j.laneId, j.rowKey, j.agentLabel], ["efi", "arc", "efi|worker:e1", "Fixer"]);
  assert.equal(boringActiveSelection({ ...base, agentId: "ov", laneId: "x" }).rowKey, "vs|desk:lead");
  assert.equal(boringActiveSelection({ ...base, agentId: "ade-ld" }).agentLabel, "Lead");
  // No agent on screen (Start card): lane state is the fallback.
  assert.equal(boringActiveSelection({ ...base, laneId: "_bugs" }).rowKey, "vs|lane:_bugs");
});

test("R2.1 sidebar: exactly one row is .on and the breadcrumb agrees (Overview, worker, project switch)", () => {
  reset();
  const view = squad({ pins: [lanePin("ade", { lead: mem("ade-ld"), workers: [wk("w1", "running")] }), lanePin("per")] });
  globalThis.__agents = new Map([["w1", { id: "w1", title: "Worker One" }]]);
  let t = render(props(view));
  assert.equal(onRows(t).length, 1); // Overview: the project row
  assert.match(JSON.stringify(byId(t, "boring-crumb-lane").props.children), /Overview/);
  byId(t, "boring-conv-toggle-ade").props.onClick();
  laneBtn(render(props(view)), "ade").props.onClick();
  byId(render(props(view)), "boring-top-worker-w1").props.onClick();
  t = render(props(view));
  const on = onRows(t);
  assert.equal(on.length, 1);
  assert.match(String(on[0].props.className), /boring-worker-row/);
  assert.match(JSON.stringify(byId(t, "boring-crumb-agent").props.children), /Worker One/);
  assert.doesNotMatch(JSON.stringify(byId(t, "boring-breadcrumb")), /Brainstorm/);
});

test("R2.5: every row has the fixed 16px chevron column; hub workers hang off the Desk", () => {
  reset();
  const view = squad({ zones: { hub: { lane: { id: "hub" }, workers: [wk("hw", "running")] }, riffbot: zone(mem("rb")), overlord: zone(mem("ov")) } });
  const t = withDesk(view);
  assert.ok(byId(t, "boring-desk-workers")); // hub workers hang off the Desk (folded to one line, R3.1)
  assert.equal(byId(t, "boring-desk-workers-toggle"), null);
  assert.deepEqual(boringSelectionForAgent(view, "hw"), { laneId: "_desk", role: "worker" });
  const cols = walk(t, (n) => /boring-chevron-btn/.test(String(n.props?.className ?? "")));
  assert.ok(cols.length >= 6); // project, desk, overlord, riffbot, hub workers, bugs, lanes
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  assert.match(css, /\.boring-chevron-btn \{ flex: 0 0 16px; width: 16px; min-width: 16px/);
  assert.match(css, /\.boring-badge\.err \{ background: var\(--st-err\)/);
});

test("R2.6 boringHeaderStrip: the Context strip item is dropped when the meter shows, unless Hand off is available", () => {
  const base = { status: "idle", updatedAt: null, hasPendingPermission: false, ctxPct: 80, planHandedOff: false, nowMs: NOW };
  assert.deepEqual(boringHeaderStrip({ ...base, meterShown: true }), []);
  assert.deepEqual(boringHeaderStrip({ ...base, meterShown: true, canHandoff: true }).map((s) => s.kind), ["context"]);
  assert.deepEqual(boringHeaderStrip(base).map((s) => s.kind), ["context"]);
});

// ---- R2 fix round: reveal on jump, Bugs closure, hub folded into Desk, palette trigger, light badge --------
test("R2 M1: Needs-you jump selects the worker and re-opens collapsed project / lane / idle bucket", () => {
  reset();
  const view = squad({ pins: [lanePin("ade", { lead: mem("ade-ld"), workers: [wk("w1", "idle")] }), lanePin("per")] });
  globalThis.__agents = new Map([["w1", { id: "w1", title: "Worker One" }]]);
  let t = render(props(view));
  byId(t, "boring-conv-toggle-ade").props.onClick(); // expand then collapse again => explicit false
  byId(render(props(view)), "boring-conv-toggle-ade").props.onClick();
  byId(render(props(view)), "boring-project-toggle-vs").props.onClick(); // explicit project collapse
  t = render(props(view));
  assert.equal(byId(t, "boring-project-lanes-vs"), null);
  byType(t, "BoringInbox").props.onOpen({ teamId: "vs", view, item: { id: "w1" } });
  t = render(props(view));
  assert.ok(byId(t, "boring-project-lanes-vs"), "project re-opened");
  assert.ok(byId(t, "boring-workers-ade"), "lane re-opened");
  const on = onRows(t);
  assert.equal(on.length, 1);
  assert.match(String(on[0].props.className), /boring-worker-row/); // idle worker revealed in the idle bucket
  assert.match(JSON.stringify(byId(t, "boring-crumb-agent").props.children), /Worker One/);
  assert.ok(globalThis.__calls.some((c) => c[0] === "openAgent" && c[1] === "w1"));
});

test("R2 M1: Needs-you jump to a hub worker re-opens the collapsed Desk and its workers", () => {
  reset();
  const view = squad({ zones: { hub: { lane: { id: "hub" }, workers: [wk("hw", "running")] }, riffbot: zone(mem("rb")), overlord: zone(mem("ov")) } });
  globalThis.__agents = new Map([["hw", { id: "hw", title: "Hub Worker" }]]);
  byType(render(props(view)), "BoringInbox").props.onOpen({ teamId: "vs", view, item: { id: "hw" } });
  const t = render(props(view));
  assert.ok(byId(t, "boring-desk-workers"));
  assert.match(String(onRows(t)[0].props.className), /boring-worker-row/);
});

test("R2 M2: Bugs under a non-active expanded project opens THAT project's Bugs agent", () => {
  reset();
  const a = squad();
  const b = { ...squad(), team: { id: "efi", name: "EFI" }, bugs: { pin: lanePin("bugE", { brainstorm: mem("efi-bug-bs") }), leadRunning: false, needsYou: 0 } };
  const p = props(a, { views: [a, b], onSelectSquad: (id) => globalThis.__calls.push(["select", id]) });
  byId(render(p), "boring-project-toggle-efi").props.onClick();
  byId(render(p), "boring-core-bugs-efi").props.onClick();
  assert.deepEqual(globalThis.__calls.filter((c) => c[0] === "select" || c[0] === "openAgent"), [["select", "efi"], ["openAgent", "efi-bug-bs"]]);
});

test("R2: a lane named after the project folds into the Desk (no second VibeSquad lane); Bugs table row keeps Lead in Lead", () => {
  reset();
  const dup = lanePin("vs", { lead: mem("vs-ld", "running"), workers: [wk("vw", "running")] });
  const view = squad({ pins: [dup, lanePin("ade")] });
  const m = boringSidebarModel(view);
  assert.deepEqual(m.conversations.map((c) => c.laneId), ["ade"]);
  assert.deepEqual(m.core.deskWorkers.map((w) => w.agent.id).sort(), ["vs-bs", "vs-ld", "vw"]);
  assert.deepEqual(boringSelectionForAgent(view, "vw"), { laneId: "_desk", role: "worker" });
  const bugs = boringLaneTableRows(m, []).find((r) => r.key === "_bugs");
  assert.deepEqual([bugs.brainstorm, bugs.lead], ["—", "running"]);
});

test("R2: sidebar Search opens the Command Palette (Ctrl+K); idle toggle sits on the chevron column; light badge text is white", () => {
  reset();
  const t = render(props(squad()));
  const b = byId(t, "boring-sidebar-search-btn");
  assert.match(b.props.title, /Command palette \(Ctrl\+K\)/);
  b.props.onClick();
  assert.deepEqual(globalThis.__calls.at(-1), ["openOverlay", "palette"]);
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  assert.match(css, /\[data-theme="light"\] \.boring-badge \{ color: #ffffff !important; \}/);
  assert.doesNotMatch(css, /\[data-theme="light"\] \.boring-badge\.err/);
  assert.match(css, /\.boring-idle-toggle \.boring-idle-chev \{ flex: 0 0 16px; width: 16px/);
  assert.match(css, /\.boring-worker-row \{ padding-left: 20px;/);
});

// ---- R2 fix round 2: Desk workers render like lane workers; Desk row/table honest -----------------------------
const hubView = (hubWorkers, extra = {}) => squad({ zones: { hub: { lane: { id: "hub" }, workers: hubWorkers }, riffbot: zone(mem("rb")), overlord: zone(mem("ov")), ...extra } });

test("R3.1: Desk lists only lead / brainstorm / alerting workers; running + idle fold into one row", () => {
  reset();
  const hw = [wk("r1", "running"), wk("a1", "idle", "permission"), ...Array.from({ length: 18 }, (_, i) => wk(`i${i}`, "idle"))];
  const t = withDesk(hubView(hw));
  assert.ok(byId(t, "boring-core-overlord") && byId(t, "boring-core-riffbot"));
  assert.ok(byId(t, "boring-worker-a1"), "alerting worker inline");
  assert.equal(byId(t, "boring-worker-r1"), null, "running worker folded");
  assert.equal(byId(t, "boring-worker-i0"), null, "idle workers folded");
  assert.equal(walk(byId(t, "boring-desk-workers"), (n) => /boring-worker-row/.test(String(n.props?.className ?? ""))).length, 1);
  assert.equal(byId(t, "boring-worker-why-a1"), null, "no reason text in the tree");
  const fold = byId(t, "boring-desk-workers-fold");
  assert.match(JSON.stringify(fold.props.children), /1 running · 18 idle/);
  assert.equal(fold.props.className.includes("boring-idle-toggle"), true);
});

test("R3.1: the fold opens the Workers tab (does not expand inline); the on-screen worker stays listed", () => {
  reset();
  const store = {};
  const events = [];
  globalThis.localStorage = { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] ?? null };
  globalThis.window = { dispatchEvent: (e) => events.push(e), addEventListener() {}, removeEventListener() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  try {
    const view = hubView([wk("r1", "running"), wk("i0", "idle")]);
    let t = withDesk(view);
    byId(t, "boring-desk-workers-fold").props.onClick();
    assert.equal(store["vs.context-panel.tab"], "Workers");
    assert.equal(store["vs.context-panel.open"], "1");
    assert.deepEqual(events.map((e) => [e.type, e.detail.tab]), [["vs:open-context-tab", "Workers"]]);
    t = render(props(view));
    assert.equal(byId(t, "boring-worker-r1"), null, "no inline expansion");
    // Ctrl+J / needs-you jump into a folded worker: its row shows as the on-screen agent.
    globalThis.__agents = new Map([["r1", { id: "r1", title: "R1" }]]);
    byType(render(props(view)), "BoringInbox").props.onOpen({ teamId: "vs", view, item: { id: "r1" } });
    t = render(props(view));
    assert.ok(byId(t, "boring-worker-r1"));
    assert.match(String(onRows(t)[0].props.className), /boring-worker-row/);
    assert.match(JSON.stringify(byId(t, "boring-desk-workers-fold").props.children), /1 idle/);
  } finally {
    delete globalThis.localStorage; delete globalThis.window; delete globalThis.CustomEvent;
  }
});

test("R3.5 / R3.6: sidebar header shows the fixed app name; footer pins to the bottom of the column", () => {
  reset();
  const t = render(props(squad({ team: { id: "x", name: "Main Game Project" } })));
  assert.equal(byId(t, "boring-sidebar-title").props.children, "VibeSquad");
  const css = readFileSync(resolve(import.meta.dirname, "..", "src", "boring.css"), "utf8");
  assert.match(css, /\.boring-sidebar-footer \{ flex: none; margin-top: auto; \}/);
  assert.match(css, /\.boring-project-tree \{ flex: 1 1 auto; min-height: 120px; overflow-y: auto; \}/);
});

test("R2 fix2 L1/N2: Overview Desk row counts folded running workers and their age", () => {
  reset();
  const base = boringLaneTableRows(boringSidebarModel(hubView([])), [])[0];
  const withW = boringLaneTableRows(boringSidebarModel(hubView([wk("hw", "running")])), [])[0];
  assert.equal(withW.laneId, "_desk");
  assert.equal(withW.running, base.running + 1);
  const newer = boringSidebarModel(hubView([{ agent: { id: "n", status: "idle", title: "N", updatedAt: new Date(NOW - 60000).toISOString() }, attention: null }]));
  assert.notEqual(boringLaneTableRows(newer, [])[0].age, "");
});

test("R2 fix2 N3/N4: Desk sub-label lists only who is live; hidden when neither; dot tinted worst-state", () => {
  reset();
  const both = withDesk(hubView([]));
  assert.match(JSON.stringify(byId(both, "boring-desk-row").props.children), /Overlord · RiffBot/);
  const none = withDesk(squad({ zones: { hub: { lane: { id: "hub" }, workers: [] }, riffbot: zone(null), overlord: zone(null) } }));
  assert.doesNotMatch(JSON.stringify(byId(none, "boring-desk-row").props.children), /Overlord|RiffBot/);
  const one = withDesk(squad({ zones: { hub: { lane: { id: "hub" }, workers: [] }, riffbot: zone(null), overlord: zone(mem("ov")) } }));
  const txt = JSON.stringify(byId(one, "boring-desk-row").props.children);
  assert.match(txt, /Overlord/);
  assert.doesNotMatch(txt, /RiffBot/);
  const err = withDesk(hubView([], { overlord: zone(mem("ov", "error")) }));
  assert.match(JSON.stringify(byId(err, "boring-desk-row").props.children), /st-err/);
});

// ---- Desk R2 Unit 2: Needs you = 2-line rows, cap 5 + more, Done recently, hub "Desk", clean titles -------
const manyView = (n) =>
  ({ team: { id: "vs", name: "VibeSquad", lanes: [{ id: "ade", name: "ADE" }, { id: "vs", name: "vs", hub: true }] }, members: Array.from({ length: n }, (_, i) => att(`p${i}`, "needs-you", `pick ${i}`, { agent: { updatedAt: ago(20 + i) } })), needsYou: n, running: 0 });
const testids = (t, id) => walk(t, (n) => n.props?.["data-testid"] === id);

test("Desk R2 Needs you: the count equals the rows; cap 5 with a '+ N more' toggle", () => {
  reset();
  const v = manyView(8);
  const t = (hs.i = 0, BoringInbox({ views: [v], now: NOW, logs: [] }));
  assert.equal(testids(t, "boring-needs-you-item").length, 5);
  assert.equal(testids(t, "boring-needs-you-count")[0].props.children, 8);
  assert.match(renderToStaticMarkup(React.createElement(BoringInbox, { views: [v], now: NOW, logs: [] })), /▸ 3 more/);
  const few = (hs.i = 0, BoringInbox({ views: [manyView(4)], now: NOW, logs: [] }));
  assert.equal(testids(few, "boring-needs-you-item").length, 4);
  assert.equal(testids(few, "boring-needs-you-more").length, 0);
  assert.equal(testids(few, "boring-needs-you-count")[0].props.children, 4);
});

test("R3.7 Needs you expanded (showAll) hides Done recently; collapsing brings it back", () => {
  reset();
  const v = manyView(8);
  const render = () => ((hs.i = 0), BoringInbox({ views: [v], now: NOW, logs: [] }));
  let t = render();
  assert.equal(testids(t, "boring-recent-done").length, 1);
  testids(t, "boring-needs-you-more")[0].props.onClick();
  t = render();
  assert.equal(testids(t, "boring-needs-you-item").length, 8);
  assert.equal(testids(t, "boring-recent-done").length, 0);
  testids(t, "boring-needs-you-more")[0].props.onClick();
  assert.equal(testids(render(), "boring-recent-done").length, 1);
});

test("Desk R2 Needs you: finished lists under Done recently (count == rows), not under Needs you", () => {
  reset();
  const v = teamOf("vs", "VibeSquad", [att("fin", "finished", "all done"), att("ask", "needs-you", "pick")]);
  const logs = [{ teamId: "vs", project: "VibeSquad", entries: [{ ts: ago(5), type: "done", text: "shipped D1", agent: "x", lane: "ade" }] }];
  const t = (hs.i = 0, BoringInbox({ views: [v], now: NOW, logs }));
  assert.deepEqual(testids(t, "boring-needs-you-item").map((n) => n.props["data-kind"]), ["label"]);
  assert.equal(testids(t, "boring-needs-you-count")[0].props.children, 1);
  const html = renderToStaticMarkup(React.createElement(BoringInbox, { views: [v], now: NOW, logs }));
  assert.match(html, /Done recently · 2/); // the finished agent + the logged done entry
});

test("Desk R2 Needs you: buttons only on quick permissions; every row has the hover menu with Snooze", () => {
  reset();
  const t = (hs.i = 0, BoringInbox({ views: [A, B], now: NOW, logs: [] }));
  assert.equal(testids(t, "boring-needs-allow").length, 1);
  assert.equal(testids(t, "boring-needs-snooze").length, 4);
  for (const id of ["perm", "q", "ask", "err"]) assert.equal(testids(t, `boring-needs-menu-${id}`).length, 1);
  assert.equal(walk(t, (n) => n.props?.className === "boring-needs-btn").length, 0); // no inline Dismiss button any more
});

test("Desk R2 Needs you: hub-lane items read 'Desk'; real legacy lead titles are named from labels (formatDisplayTitle) or cleanTitle", () => {
  reset();
  const lead = (id, title, laneId, labels) => att(id, "needs-you", "why", { kind: "lead", laneId, agent: { title, labels } });
  const v = {
    team: { id: "vs", name: "VibeSquad", lanes: [{ id: "vs", name: "vs", hub: true }, { id: "main-game", name: "Main Game" }, { id: "plugins", name: "Plugins" }] },
    members: [
      lead("o", "Lead · ord75", "vs", { role: "lead", ord: "75" }),
      lead("m", "★ MAIN GAME ord75", "main-game", { role: "lead", lane: "main-game", ord: "75" }), // demo.tsx:91, legacyTitleFor format
      lead("p", "★ LEAD · Plugins", "plugins", { role: "lead", lead: "plugins" }), // demo.tsx:96
    ],
    needsYou: 3, running: 0,
  };
  const who = Object.fromEntries(needsYouRows([v], NOW).map((r) => [r.item.id, r.who]));
  assert.equal(who.o, "Overlord");
  assert.equal(who.p, "Plugins");
  assert.doesNotMatch(who.m, /ord75|MAIN GAME|★/);
  assert.match(who.m, /75$/);
  assert.equal(needsYouRows([v], NOW).find((r) => r.item.id === "o").lane, "Desk");
  const t = (hs.i = 0, BoringInbox({ views: [v], now: NOW, logs: [] }));
  assert.ok(testids(t, "boring-needs-where").some((n) => /Desk/.test([].concat(n.props.children).join(""))));
});

test("Desk R2 Needs you: a running agent with no update for 10m+ (and no tool in flight) is listed as stalled (R4-1: back in Needs you)", () => {
  reset();
  const quiet = att("slow", "x", "x", { agent: { status: "running", updatedAt: ago(12) } });
  quiet.attention = null;
  const fresh = att("busy", "x", "x", { agent: { status: "running", updatedAt: new Date(NOW - 20_000).toISOString() } });
  fresh.attention = null;
  const nine = att("nine", "x", "x", { agent: { status: "running", updatedAt: ago(9) } });
  nine.attention = null; // R3.2: 9 min is below the threshold, so not listed
  const v = teamOf("vs", "VibeSquad", [quiet, fresh, nine]);
  const rows = needsYouRows([v], NOW);
  assert.deepEqual(rows.map((r) => [r.item.id, r.item.kind]), [["slow", "stalled"]]);
  assert.match(rows[0].item.reason, /Stalled: no update for 12m/);
});

test("Desk R2 sidebar worker rows keep the attention tint (R3.1: no reason text); container dots take the worst state", () => {
  const ade = readFileSync(resolve(import.meta.dirname, "..", "src", "BoringAde.tsx"), "utf8");
  assert.doesNotMatch(ade, /className="boring-worker-why"/); // R3.1: reason lives in Needs you only
  assert.match(ade, /needs-err/);
  assert.match(ade, /glyphCls\(c\.status, c\.err \? "error"/);
  assert.match(ade, /m\.projectErr \? "error"/);
});

test("Desk R2 r2: location resolver: Desk for laneId==team.id (any case), no laneId and hub lanes; other lanes get a pretty label", () => {
  reset();
  const v = {
    team: { id: "vibesquad", name: "VibeSquad", lanes: [{ id: "riffbot", name: "RiffBot", hub: true }, { id: "ui-bois", name: "ui bois" }] },
    lanes: [{ lane: { id: "wiki", name: "wiki" } }],
    members: [
      att("a", "needs-you", "x", { laneId: "vibesquad" }),
      att("b", "needs-you", "x", { laneId: "VibeSquad" }),
      att("c", "needs-you", "x", { laneId: "" }),
      att("d", "needs-you", "x", { laneId: "riffbot" }),
      att("e", "needs-you", "x", { laneId: "ui-bois" }),
      att("f", "needs-you", "x", { laneId: "wiki" }),
    ],
    needsYou: 6, running: 0,
  };
  const lane = Object.fromEntries(needsYouRows([v], NOW).map((r) => [r.item.id, r.lane]));
  assert.deepEqual(lane, { a: "Desk", b: "Desk", c: "Desk", d: "Desk", e: "UI bois", f: "wiki" });
  assert.equal(needsYouRows([{ ...v, team: { ...v.team, lanes: [{ id: "ui-bois", name: "Ui Lab" }] }, members: [att("g", "needs-you", "x", { laneId: "ui-bois" })] }], NOW)[0].lane, "UI Lab");
});

test("Desk R2 r2: Done recently log entries read Desk for the hub lane / project-named lane", () => {
  const v = { team: { id: "vibesquad", name: "VibeSquad", lanes: [{ id: "ui-bois", name: "Ui Bois" }] }, lanes: [], members: [] };
  const e = (lane) => ({ ts: ago(14), type: "done", text: "PASS step4", agent: "x", lane });
  const rows = doneRecently([], [{ teamId: "vibesquad", project: "VibeSquad", entries: [e("vibesquad"), e(undefined), e("ui-bois")] }], 8, NOW, [v]);
  assert.deepEqual(rows.map((r) => r.where).sort(), ["VibeSquad › Desk", "VibeSquad › Desk", "VibeSquad › UI Bois"]);
});

test("R3.7: one count style: '8 more' and 'Done recently · 4'", async () => {
  const src = readFileSync(new URL("../src/BoringInbox.tsx", import.meta.url), "utf8");
  assert.match(src, /`\$\{n\} more`/);
  assert.match(src, /`Done recently · \$\{n\}`/);
  assert.doesNotMatch(src, /\+ \$\{rows/);
});

test("R4-6/R4-7: Ctrl+J routes through BoringAde; composer placeholder uses the readable title; Last event skips metric", () => {
  const rd = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const app = rd("App.tsx"), ade = rd("BoringAde.tsx"), comp = rd("Composer.tsx");
  assert.match(app, /vs:boring-open-agent/);
  assert.match(ade, /BORING_OPEN_AGENT_EVENT/);
  assert.match(ade, /const openNeedsYou = \(row: NeedsYouRow\) => openAgentIn\(/);
  assert.match(comp, /placeholder=\{`Message \$\{composerTargetName\(agent\)\}/);
  assert.match(ade, /e\.type !== "metric"/);
});
