// @desk B1 (docs/PLAN_DESK_NAV_HISTORY.md): Normal-mode Back/Forward must make the screen follow the URL.
// BoringAde re-derives mode + selection from the URL on popstate (App bumps `navGen` in its onPop handler).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { transformSync } from "rolldown/utils";

const src = readFileSync(resolve(import.meta.dirname, "..", "src", "BoringAde.tsx"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "vs-desk-nav-history-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
const stub = (name, body) => writeFileSync(join(dir, name), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);

const hs = (globalThis.__hs = { slots: [], i: 0 });
globalThis.__calls = [];
globalThis.__defaultWindow = { addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis.__defaultWindow;
globalThis.location = { search: "" }; // BoringApp's B1 effect reads location.search on navGen
globalThis.__agents = new Map();
// U1: the real parseUrlState (slot/tab keys), extracted from CommandPalette.tsx so the stub cannot drift from it.
const palSrc = readFileSync(resolve(import.meta.dirname, "..", "src", "CommandPalette.tsx"), "utf8");
const parseStart = palSrc.indexOf("export function parseUrlState");
const realParseUrlState = transformSync("parseUrlState.ts", palSrc.slice(parseStart, palSrc.indexOf("\n}\n", parseStart) + 3), { lang: "ts" }).code;
const rec = (name) => `(...a) => { globalThis.__calls.push(["${name}", ...a]); }`;
writeFileSync(
  join(dir, "react-hooks.mjs"),
  `export * from ${JSON.stringify(reactUrl)};
export const useRef = (init) => { const h = globalThis.__hs; const k = h.i++; if (!h.slots[k]) h.slots[k] = { current: init }; return h.slots[k]; };
export const useEffect = (fn, deps) => { const h = globalThis.__hs; const k = h.i++; const prev = h.slots[k]; const same = prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j])); if (same) return; if (prev && typeof prev.cleanup === "function") prev.cleanup(); const cleanup = fn(); h.slots[k] = { deps, cleanup }; }; export const useState = (init) => { const h = globalThis.__hs; const k = h.i++; if (!(k in h.slots)) h.slots[k] = typeof init === "function" ? init() : init; return [h.slots[k], (v) => { h.slots[k] = typeof v === "function" ? v(h.slots[k]) : v; }]; };`,
);
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const t = realSetInterval(...a); t?.unref?.(); return t; };
stub("useNowTick.mjs", "export const useNowTick = () => Date.now();");
stub("boringBusts.mjs", `export const bustUrl = (r) => "/ui/busts/" + r + ".png";`);
stub("demo.mjs", "export const demoLog = () => [];");
stub("demoFlag.mjs", "export const DEMO = false;");
stub("attentionItemsBoring.mjs", `export const stalledCount = (members) => members.filter((m) => m.stalled).length; export const isInNeedsYou = (m) => Boolean(m.stalled) || Boolean(m.attention && m.attention.tone !== "finished"); export const glyphStatusOf = (a) => a.glyph ?? a.status;`);
stub("IdeaInbox.mjs", `export function IdeaInbox() { return null; } export const refreshInboxCards = () => { globalThis.__refreshInbox?.(); return Promise.resolve([]); }; export const useInboxCards = () => globalThis.__inboxCards ?? []; export const useFocusedInboxCard = () => globalThis.__focusedInboxCard ?? null;`);
for (const n of ["AgentDrawer", "BoringContextPanel", "UsageDashboard", "TeamFeed"]) stub(`${n}.mjs`, `export function ${n}() { return null; }` + (n === "TeamFeed" ? " export const fetchLog = () => Promise.resolve([]);" : ""));
stub("BoringDecisionDesk.mjs", `export function BoringDecisionDesk() { return null; } export const DECISION_DESK_DEFAULT_LANDING = false; export const useDecisionCount = () => 0;`);
stub("Timeline.mjs", `export function TimelineErrorBoundary(p) { return p.children; }`);
stub("CommandPalette.mjs", `export const openOverlay = ${rec("openOverlay")}; export const teamCtxItems = (v) => ["team", v.team.id]; export const laneCtxItems = (v, p, o) => Object.assign(["lane", v.team.id, p.lane.id, Boolean(o && o.onRemove), o && o.displayName], { onRemove: o && o.onRemove }); export const openContextMenu = (e, items) => { globalThis.__calls.push(["openContextMenu", items]); }; ` + realParseUrlState);
stub("boringFolders.mjs", `export const folderSlug = (n) => n.toLowerCase(); export const isViewAsleep = () => false; export const filterAwakeViews = (v) => v; export const partitionViews = (views) => ({ activeViews: views, folderGroups: [] }); export const patchTeamsFolder = async () => ({ ok: true }); export const setLastFolder = () => {}; export const getLastFolder = () => undefined; export const migrateLastFolder = () => {};`);
stub("PinRemove.mjs", `export function RemoveTeamDialog() { return null; }`);
stub("ProjectTabs.mjs", `export function ProjectTabs() { return null; }`);
stub("StorybookView.mjs", `export const useStorybookPresent = () => false; export const closeStorybook = () => {}; export const openStorybook = () => {};`);
stub("CrunchToggle.mjs", `export function CrunchToggle() { return null; } export const setCrunchMode = async () => true;`);
stub("projectOrderActions.mjs", `export const projectOrder = { drop: async () => true, move: async () => true, setMain: async () => true }; export const knownFolderNames = (f) => new Set(f.map((x) => x.name));`);
writeFileSync(join(dir, "ctxMenuLogic.mjs"), transformSync("ctxMenuLogic.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "ctxMenuLogic.ts"), "utf8"), { lang: "ts" }).code);
writeFileSync(join(dir, "projectOrder.mjs"), transformSync("projectOrder.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "projectOrder.ts"), "utf8"), { lang: "ts" }).code);
writeFileSync(join(dir, "teams.mjs"), `export const isHubLane = (team, lane) => lane.hub === true || (!team.lanes.some((l) => l.hub === true) && lane.id === team.id);`);
writeFileSync(join(dir, "boringLocation.mjs"), transformSync("boringLocation.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "boringLocation.ts"), "utf8"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
writeFileSync(join(dir, "condenseReason.mjs"), transformSync("condenseReason.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "condenseReason.ts"), "utf8"), { lang: "ts" }).code);
stub("panes.mjs", `export const openAgent = ${rec("openAgent")}; export const openAgentInTab = ${rec("openAgentInTab")}; export const toggleSplit = (...a) => { globalThis.__calls.push(["toggleSplit", ...a]); if (globalThis.__panes) globalThis.__panes = { ...globalThis.__panes, split: !globalThis.__panes.split }; }; export const collapseSplit = (...a) => { globalThis.__calls.push(["collapseSplit", ...a]); const p = globalThis.__panes; if (p) { const r = a[0] === "active" && p.activePane === "right"; const keep = (r ? p.rightActiveId : p.leftActiveId) ?? (r ? p.leftActiveId : p.rightActiveId); globalThis.__panes = { ...p, split: false, activePane: "left", leftActiveId: keep, rightActiveId: null }; } }; export const getPanes = () => globalThis.__panes ?? { activePane: "left", leftActiveId: null, rightActiveId: null, split: false }; export const setActivePane = ${rec("setActivePane")}; export const closeTab = ${rec("closeTab")}; export const usePanes = () => globalThis.__panes ?? { activePane: "left", leftActiveId: null, rightActiveId: null, split: false };`);
stub("paseo.mjs", `export const sendMessage = ${rec("sendMessage")}; export const usePaseo = () => ({ agents: globalThis.__agents, rosterLoaded: globalThis.__rosterLoaded });`);
stub("pinActions.mjs", `export const createQuickBugsPin = (id) => { globalThis.__calls.push(["createQuickBugsPin", id]); return Promise.resolve({ lane: { id: "bug" } }); };`);
stub("pinFocusBoring.mjs", `export const openPinMember = ${rec("openPinMember")}; export const spinUpPin = (...a) => globalThis.__spinUpPin(...a); export const setBoringShownAgent = () => {}; export const setBoringScreenKeys = (k) => { globalThis.__screenKeys = k; }; export const setBoringLandedGen = () => {};`);
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
stub("usageHelpers.mjs", `export const OPEN_USAGE_EVENT = "vs:open-usage"; export const takeColdUsageFocus = () => false;`);
stub("useBotFace.mjs", `export const useTheme = () => "dark";`);
stub("railCheckin.mjs", `export const runCheckin = (pin, deps) => { globalThis.__calls.push(["runCheckin", pin.lane.id, typeof deps.open, typeof deps.send]); return Promise.resolve("send"); };`);
stub("skyZonesBoring.mjs", "export const skyZonesFor = (v) => v.zones;");
stub("BoringInbox.mjs", `export const BoringInbox = function BoringInbox() { return null; }; export const needsYouRows = () => globalThis.__needsYouRows ?? []; export const needsYouReason = (i) => i.reason ?? "";`);
// B17: the real picker (pure builders + presentational component), transformed like BoringAde itself.
writeFileSync(join(dir, "BoringPanePicker.mjs"), `import React from ${JSON.stringify(reactUrl)};\n` + transformSync("BoringPanePicker.tsx", readFileSync(resolve(import.meta.dirname, "..", "src", "BoringPanePicker.tsx"), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } }).code.replace(/from "react"/, `from ${JSON.stringify(reactUrl)}`));
stub("ui.mjs", `export const StatusDot = function StatusDot() { return null; }; export const cleanTitle = (t) => { let s = String(t ?? "untitled").trim(); const l = s.toLowerCase(); if (l.startsWith("★ lead · ")) s = s.slice(9).trim(); else if (l.startsWith("brainstorm · ")) s = s.slice(13).trim(); return s; };`);
const adeCode = transformSync("BoringAde.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/skyZonesLogic"/, `from "./skyZonesBoring"`)
  .replace(/from "\.\/pinFocus"/, `from "./pinFocusBoring"`)
  .replace(/from "\.\/attentionItems"/, `from "./attentionItemsBoring"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringAde.mjs"), adeCode);
const { BoringApp, boringLandingFromUrl, boringAgentLanding, boringSelectionForAgent, boringLaneKnown } = await import(pathToFileURL(join(dir, "BoringAde.mjs")).href);

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
const efiSquad = () => squad({ team: { id: "efi", name: "Main Game Project" }, pins: [] });

const reset = () => {
  hs.slots = [];
  globalThis.__calls = [];
  globalThis.__agents = new Map();
  globalThis.__rosterLoaded = true;
  globalThis.location = { search: "" };
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
  onSelectSquad: (id) => void globalThis.__calls.push(["onSelectSquad", id]),
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

// ── boringLandingFromUrl: the pure URL → mode/selection derivation ─────────────
test("boringLandingFromUrl: agent in a pinned lane -> chat with that view + selection", () => {
  const view = squad();
  const land = boringLandingFromUrl([view], "?team=vs&agent=ade-bs", () => true);
  assert.ok(land);
  assert.equal(land.mode, "chat");
  assert.equal(land.teamId, "vs");
  assert.equal(land.agentId, "ade-bs");
  assert.equal(land.view?.team.id, "vs");
  assert.deepEqual(land.sel, { laneId: "ade", role: "brainstorm" });
});

test("boringLandingFromUrl: agent with no team -> chat, team taken from the owning project", () => {
  const view = squad();
  const land = boringLandingFromUrl([view], "?agent=ade-bs", () => true);
  assert.ok(land);
  assert.equal(land.mode, "chat");
  assert.equal(land.teamId, "vs");
  assert.equal(land.agentId, "ade-bs");
});

test("boringLandingFromUrl: a known-but-unpinned agent still lands in chat with no selection", () => {
  const view = squad();
  const land = boringLandingFromUrl([view], "?team=vs&agent=floating", () => true);
  assert.ok(land);
  assert.equal(land.mode, "chat");
  assert.equal(land.agentId, "floating");
  assert.equal(land.view, null);
  assert.equal(land.sel, null);
});

test("boringLandingFromUrl: an unknown agent -> null (no re-derivation)", () => {
  const view = squad();
  assert.equal(boringLandingFromUrl([view], "?team=vs&agent=gone", () => false), null);
});

test("boringLandingFromUrl: team with no agent -> that project's Overview", () => {
  const view = squad();
  const land = boringLandingFromUrl([view], "?team=vs", () => true);
  assert.ok(land);
  assert.equal(land.mode, "project");
  assert.equal(land.teamId, "vs");
});

test("boringLandingFromUrl: no team and no agent -> null (squads-home / usage are not URL-routed in Normal)", () => {
  assert.equal(boringLandingFromUrl([squad()], "", () => true), null);
  assert.equal(boringLandingFromUrl([squad()], "?view=squads", () => true), null);
});

// ── BoringApp: navGen (App's onPop counter) re-derives mode + selection ────────
test("B1: navGen bump with ?agent= lands in chat even though the active agent is unchanged", () => {
  reset();
  const view = squad();
  // Start on the Overview (mode = "project", the default when nothing is focused).
  let t = render(props(view));
  assert.ok(byId(t, "boring-project-view"));
  assert.equal(byType(t, "AgentDrawer"), null);

  // popstate to a chat URL: the active pane's agent is unchanged (openAgent no-ops), but mode must follow the URL.
  globalThis.location = { search: "?team=vs&agent=ade-bs" };
  globalThis.__agents.set("ade-bs", { id: "ade-bs" });
  render(props(view, { navGen: 1 })); // effect fires on the generation bump
  t = render(props(view, { navGen: 1 })); // re-render reflects the new mode
  const drawer = byType(t, "AgentDrawer");
  assert.ok(drawer, "chat mode shows the AgentDrawer");
  assert.equal(drawer.props.agent.id, "ade-bs");
});

test("B1: navGen bump with a team (no agent) for another project calls onSelectSquad and shows its Overview", () => {
  reset();
  const view = squad();
  const views = [view, efiSquad()]; // U2 m3: "another project" is a known view (an unknown ?team= is a gone team)
  render(props(view, { views }));
  globalThis.location = { search: "?team=efi" };
  render(props(view, { views, navGen: 1 }));
  const t = render(props(view, { views, navGen: 1 }));
  assert.ok(globalThis.__calls.some((c) => c[0] === "onSelectSquad" && c[1] === "efi"), "switches to the URL team");
  assert.ok(byId(t, "boring-project-view"));
  assert.equal(byType(t, "AgentDrawer"), null);
});

test("B1: a navGen bump with the same team (no agent) re-derives Overview without switching squad", () => {
  reset();
  const view = squad();
  render(props(view));
  globalThis.location = { search: "?team=vs" };
  render(props(view, { navGen: 1 }));
  render(props(view, { navGen: 1 }));
  assert.equal(globalThis.__calls.filter((c) => c[0] === "onSelectSquad").length, 0, "same team = no switch");
});

test("B1: navGen is inert on the initial mount (0) — no location read, no re-derivation", () => {
  reset();
  const view = squad();
  globalThis.location = { search: "?team=vs&agent=ade-bs" }; // deep link at load is handled by the activeAgentId landing, not navGen
  globalThis.__agents.set("ade-bs", { id: "ade-bs" });
  const t = render(props(view)); // navGen defaults to 0
  assert.ok(byId(t, "boring-project-view"), "navGen=0 leaves the initial Overview in place");
});

test("B1: a pop to a known-but-unpinned agent clears the stale lane/worker selection (minor #3)", () => {
  reset();
  const view = squad();
  globalThis.__agents.set("ade-bs", { id: "ade-bs" });
  globalThis.__agents.set("rb", { id: "rb" });
  // Land on a pinned lane's chat first (sets selectedLaneId to "ade").
  render(props(view)); // mount at navGen 0
  globalThis.location = { search: "?team=vs&agent=ade-bs" };
  render(props(view, { navGen: 1 }));
  let t = render(props(view, { navGen: 1 }));
  assert.equal(byType(t, "AgentDrawer").props.agent.id, "ade-bs");
  // Now pop to a known-but-unpinned agent: the stale "ade" selection must be cleared (chat falls back to the hub, not the stale lane).
  globalThis.__agents.set("floating", { id: "floating" });
  globalThis.location = { search: "?team=vs&agent=floating" };
  render(props(view, { navGen: 2 }));
  t = render(props(view, { navGen: 2 }));
  const drawer = byType(t, "AgentDrawer");
  assert.ok(drawer, "chat still shows a drawer");
  assert.notEqual(drawer.props.agent.id, "ade-bs", "the stale lane's agent is not shown");
  assert.equal(drawer.props.agent.id, "rb", "falls back to the hub with no lane selected");
});

// ── B1 M1/M2 wiring (source assertions on the App + RefPopover hunks) ──────────
// (c) L2: a remounted BoringApp starts with App's CURRENT navGen (>0); it must not replay that stale pop.
test("B1: a remount with navGen>0 does not re-land (the effect ignores its initial-mount value)", () => {
  reset();
  const view = squad();
  const views = [view, efiSquad()]; // U2 m3: efi is a known view
  globalThis.location = { search: "?team=efi" };
  const t = render(props(view, { views, navGen: 3 })); // mounts with navGen 3
  assert.equal(globalThis.__calls.filter((c) => c[0] === "onSelectSquad").length, 0, "no stale re-landing on mount");
  assert.ok(byId(t, "boring-project-view"));
  render(props(view, { views, navGen: 4 })); // a real pop after mount still lands
  assert.ok(globalThis.__calls.some((c) => c[0] === "onSelectSquad" && c[1] === "efi"), "a later pop re-lands");
});

test("B1 M1: App owns the pop alone: popActive armed in onPop, ended only by input or a newer pop (never URL equality); no BoringApp plumbing", () => {
  const app = readFileSync(resolve(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.doesNotMatch(app, /endPop|popTarget/, "no URL-equality end of a pop");
  assert.doesNotMatch(app, /popReplaceUntil|Date\.now\(\) \+ 1000|popArm|settleGen|onPopSettled|popSettledGen/, "no time window, no settle plumbing");
  assert.doesNotMatch(src, /onPopSettled|popPending|settleGen/, "BoringAde has no pop plumbing");
  assert.match(app, /popActive\.current = true/, "onPop arms the pop");
  assert.match(app, /addEventListener\("pointerdown", end, \{ capture: true, once: true \}\)/);
  assert.match(app, /addEventListener\("keydown", end, \{ capture: true, once: true \}\)/);
  assert.match(app, /popActive: popActive\.current, storybookReplace: takeStorybookReplace/, "takeStorybookReplace stays consumed through the decision");
  assert.doesNotMatch(app, /app\.vibe"\) === "boring"\) popActive/, "armed in every vibe/screen: nothing depends on BoringApp");
});

test("B1 R29: a vs:select-agent notification click ends any active pop before openAgent (pushes, never overwrites the popped entry)", () => {
  const app = readFileSync(resolve(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /const stopPop = useCallback\(\(\) => \{ popActive\.current = false; popDisarm\.current\?\.\(\); popDisarm\.current = null; \}, \[\]\);/, "one shared disarm path");
  assert.match(app, /const end = stopPop;/, "the input handler uses the same disarm path");
  const sw = app.slice(app.indexOf('data.type === "vs:select-agent"'));
  assert.ok(sw.length > 0, "SW handler present");
  const stop = sw.indexOf("stopPop()"), open = sw.indexOf("openAgent(data.agentId)");
  assert.ok(stop >= 0 && open > stop, "stopPop() runs before openAgent in the vs:select-agent branch");
});

test("B1 M2: RefPopover no longer replaceStates the chat entry for Open in Inbox", () => {
  const rp = readFileSync(resolve(import.meta.dirname, "..", "src", "RefPopover.tsx"), "utf8");
  const openInbox = rp.slice(rp.indexOf("const openInbox"), rp.indexOf("const onKeyDown"));
  assert.doesNotMatch(openInbox, /history\.replaceState/, "the R14 replaceState workaround is deleted");
  assert.match(openInbox, /focusInboxCard\(cardId\)/, "Normal branch just focuses the card; App's URL sync pushes ?team=");
});

// ── U1 (docs/PLAN_DESK_URL_COMPLETE.md; idea-997 + idea-895): the empty Desk slot and the Overview sub-tab follow the URL ──────────
test("U1: boringLandingFromUrl maps ?slot= to the empty Desk slot and ?tab= to the Overview sub-tab; unknown values -> plain Overview", () => {
  const v = [squad()];
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=overlord"), { mode: "slot", teamId: "vs", slot: "overlord" });
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=bugs"), { mode: "slot", teamId: "vs", slot: "bugs" });
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&tab=inbox"), { mode: "project", teamId: "vs", tab: "inbox" });
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&tab=standup"), { mode: "project", teamId: "vs", tab: "standup" });
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=nope&tab=bogus"), { mode: "project", teamId: "vs", tab: null });
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&tab=feed"), { mode: "project", teamId: "vs", tab: null }, "the URL says standup, not the internal feed key");
  assert.equal(boringLandingFromUrl(v, "?team=vs&agent=ade-bs&slot=overlord&tab=inbox").mode, "chat", "an agent wins over slot and tab");
  assert.equal(boringLandingFromUrl(v, "?slot=overlord"), null, "no team: nothing to route (as before)");
});

// U2 (UX R33 r2 m3): a ?team= that is not a known view never lends its slot/tab to the project App falls back to.
test("U2: boringLandingFromUrl ignores ?slot= / ?tab= when ?team= is not a known view (fallback project's plain Overview)", () => {
  const v = [squad()];
  for (const q of ["?team=gone", "?team=gone&slot=overlord", "?team=gone&tab=inbox", "?team=gone&slot=bugs&tab=standup"]) {
    assert.deepEqual(boringLandingFromUrl(v, q), { mode: "project", teamId: null, tab: null }, q);
  }
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=overlord"), { mode: "slot", teamId: "vs", slot: "overlord" }, "a known team keeps its slot");
  assert.equal(boringLandingFromUrl(v, "?team=gone&agent=ade-bs").mode, "chat", "an agent still lands in its own project");
});

// U2 (idea-983 / R33 m2 / idea-971): source contracts for the history edge races.
test("U2: load arms the pop; the URL sync waits for BoringApp to land the latest pop; a popped ?sb= entry is not closed by its own landing", () => {
  const app = readFileSync(resolve(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /const popActive = useRef\(true\);/, "the load is a landing: canonicalization replaces");
  assert.match(app, /if \(popActive\.current && !popDisarm\.current\) armPop\(\);/, "the load's landing is ended by the first input, like a pop");
  assert.match(app, /if \(vibe === "boring" && landed !== undefined && landed < popGen\.current\) return;/, "no write before BoringApp landed the latest pop");
  assert.match(app, /boringScreen, boringLanded\]\);/, "the landing re-runs the sync");
  assert.match(app, /if \(popActive\.current && new URLSearchParams\(location\.search\)\.get\("sb"\)\) return;\n    closeStorybook\("replace"\);/, "sbNav keeps a popped ?sb= entry");
  assert.match(src, /setLandedGen\(navGen\);\n    pendingUrl0\.current = null;/, "BoringApp marks the pop landed with that landing's state (also when nothing routes)");
  assert.ok(src.indexOf("setBoringLandedGen(landedGen)") > src.indexOf("setBoringScreenKeys({ team: screenTeam"), "landed is published after the shown agent / screen keys");
  // Safety (B1's settle-gate lesson): the gate opens on its own. Off outside Normal and while BoringApp is unmounted (undefined), and a
  // mounted BoringApp marks every pop landed before any early return, so `landed < popGen` lasts at most one render.
  assert.match(src, /useEffect\(\(\) => \(\) => setBoringLandedGen\(undefined\), \[\]\);/, "unmount (Storybook, Psycho, phone) turns the gate off");
  assert.ok(src.indexOf("setLandedGen(navGen);") < src.indexOf("if (!land) return;"), "a no-route pop is still marked landed");
  assert.match(src, /const \[landedGen, setLandedGen\] = useState\(navGen\);/, "a (re)mount starts landed at the current pop");
});

const tabOn = (t) => ["overview", "inbox", "feed"].find((k) => /\bon\b/.test(byId(t, `boring-tab-${k}`)?.props.className ?? ""));
const noOverlord = (over = {}) => squad({ zones: { ...squad().zones, overlord: zone(null) }, ...over });

test("U1: a reload at ?slot=overlord mounts on the Start Overlord card; at ?tab=inbox|standup on that sub-tab; unknown values on Overview", () => {
  reset();
  globalThis.location = { search: "?team=vs&slot=overlord" };
  let t = render(props(noOverlord()));
  assert.equal(byId(t, "boring-project-view"), null, "not the Overview");
  assert.ok(byId(t, "boring-empty-card"), "the empty Desk slot card");
  assert.equal(byId(t, "boring-empty-cta").props.children, "Start Overlord");
  for (const [q, want] of [["?team=vs&tab=inbox", "inbox"], ["?team=vs&tab=standup", "feed"], ["?team=vs&tab=bogus", "overview"], ["?team=vs&slot=nope", "overview"]]) {
    reset();
    globalThis.location = { search: q };
    t = render(props(squad()));
    assert.ok(byId(t, "boring-project-view"), `${q}: Overview`);
    assert.equal(tabOn(t), want, `${q}: sub-tab`);
  }
});

test("U1: a pop (navGen) re-lands the empty slot card and the sub-tab the URL names; ?team= alone is the Overview tab", () => {
  reset();
  const view = noOverlord();
  render(props(view));
  const pop = (search, gen) => { globalThis.location = { search }; render(props(view, { navGen: gen })); return render(props(view, { navGen: gen })); };
  let t = pop("?team=vs&slot=overlord", 1);
  assert.equal(byId(t, "boring-empty-cta")?.props.children, "Start Overlord", "Back/Forward to ?slot=overlord shows the card");
  t = pop("?team=vs&tab=inbox", 2);
  assert.ok(byId(t, "boring-project-view"));
  assert.equal(tabOn(t), "inbox");
  t = pop("?team=vs&tab=standup", 3);
  assert.equal(tabOn(t), "feed");
  t = pop("?team=vs", 4);
  assert.equal(tabOn(t), "overview", "the plain ?team= entry is the Overview tab, whatever tab was showing");
  assert.equal(globalThis.__calls.filter((c) => c[0] === "onSelectSquad").length, 0, "same project: no squad switch");
});

test("U1: the sub-tab resets on project change (and stays reset); Open-in-Inbox lands on the Idea Inbox tab", () => {
  reset();
  const vs = squad();
  const efi = squad({ team: { id: "efi", name: "Main Game Project" } });
  globalThis.location = { search: "?team=vs&tab=inbox" };
  let t = render({ ...props(vs), views: [vs, efi] });
  assert.equal(tabOn(t), "inbox");
  t = render({ ...props(efi), views: [vs, efi] }); // App switched the project (sidebar row, Ctrl+K, pop): its Overview tab
  assert.equal(tabOn(t), "overview", "a project switch resets the sub-tab");
  t = render({ ...props(vs), views: [vs, efi] });
  assert.equal(tabOn(t), "overview", "the reset sticks: coming back to the first project (its row, Ctrl+K) shows its Overview tab");
  // Open in Inbox (ref popover, R13-1): focusInboxCard flips to the Overview's Idea Inbox tab of the shown project.
  reset();
  globalThis.__focusedInboxCard = "card-7";
  try {
    render(props(efi));
    t = render(props(efi));
    assert.ok(byId(t, "boring-project-view"));
    assert.equal(tabOn(t), "inbox", "Open in Inbox lands on tab=inbox");
  } finally { globalThis.__focusedInboxCard = null; }
});

test("U1 wiring: BoringApp publishes the slot/tab keys (team-tagged); App's sync reads them live and lists the render value as a dep", () => {
  assert.match(src, /setBoringScreenKeys\(\{ team: screenTeam, slot: urlSlot, lane: urlLane, role: urlRole, tab: urlTab \}\), \[screenTeam, urlSlot, urlLane, urlRole, urlTab\]\)/, "P3: lane/role are published (and deps) too");
  assert.match(src, /useEffect\(\(\) => \(\) => setBoringScreenKeys\(undefined\), \[\]\)/, "unmount clears the keys (App keeps the URL's own)");
  assert.match(src, /const urlSlot = mode === "chat" && !agent && selectedLaneId \? LANE_SLOT\[selectedLaneId\] \?\? null : null;/);
  const app = readFileSync(resolve(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /urlSyncScreen\(\{ boring: vibe === "boring", live: getBoringScreenKeys\(\), rendered: boringScreen, team: activeTeamId \|\| null, kept: parseUrlState\(location\.search\) \}\)/);
  assert.match(app, /\}, \[activeTeamId, urlAgentId, pinLayout, pinsHome, squadsHome, boringScreen, boringLanded\]\);/);
});

// ── P3 (docs/PLAN_DESK_DD_POLISH.md P3; idea-1000): a feature lane's empty card has its own URL (?lane=<id>, + &role=lead) ──────────
// Fixture: "per" has a Brainstorm and no Lead (its Lead card = "Brainstorm ready · no Lead"); "solo" has nobody ("no Lead or Brainstorm").
const p3Squad = () => squad({ pins: [...squad().pins, lanePin("solo", { brainstorm: null })] });
const headOf = (t) => {
  const h = byId(t, "boring-lane-no-agent-head");
  const txt = (n) => (n == null || typeof n === "boolean" ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(txt).join("") : txt(n.props?.children));
  return h ? txt(h) : null;
};

test("P3: boringLandingFromUrl maps ?lane= (+ role=lead) to that lane's empty card; unknown / hub / Desk / Bugs lane ids -> plain Overview", () => {
  const v = [p3Squad()];
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&lane=solo"), { mode: "lane", teamId: "vs", laneId: "solo", role: "brainstorm" });
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&lane=per&role=lead"), { mode: "lane", teamId: "vs", laneId: "per", role: "lead" });
  assert.deepEqual(boringLandingFromUrl(v, "?role=lead&lane=per&team=vs"), { mode: "lane", teamId: "vs", laneId: "per", role: "lead" }, "key order is irrelevant");
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&lane=per&role=bogus"), { mode: "lane", teamId: "vs", laneId: "per", role: "brainstorm" }, "only role=lead is a value");
  for (const q of ["?team=vs&lane=nope", "?team=vs&lane=hub", "?team=vs&lane=vs", "?team=vs&lane=bug", "?team=vs&lane="]) assert.deepEqual(boringLandingFromUrl(v, q), { mode: "project", teamId: "vs", tab: null }, q);
  assert.deepEqual(boringLandingFromUrl(v, "?team=gone&lane=per"), { mode: "project", teamId: null, tab: null }, "an unknown team never lends its lane to the fallback");
  assert.equal(boringLandingFromUrl(v, "?team=vs&agent=ade-bs&lane=per").mode, "chat", "an agent wins over a lane");
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=overlord&lane=per"), { mode: "slot", teamId: "vs", slot: "overlord" }, "a slot wins over a lane");
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&lane=per&tab=inbox").mode, "lane", "a lane card wins over a tab");
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=bugs&role=lead"), { mode: "slot", teamId: "vs", slot: "bugs", role: "lead" }, "the Bugs slot's Lead card");
  assert.deepEqual(boringLandingFromUrl(v, "?team=vs&slot=overlord&role=lead"), { mode: "slot", teamId: "vs", slot: "overlord" }, "role only qualifies bugs / lane");
  assert.equal(boringLaneKnown(p3Squad(), "solo"), true);
  assert.equal(boringLaneKnown(p3Squad(), "hub"), false);
  assert.equal(boringLaneKnown(p3Squad(), "bug"), false);
});

test("P3: a reload at ?lane= mounts on that lane's empty card (its role) and publishes the same keys; a gone lane mounts on the Overview", () => {
  for (const [q, head, keys] of [
    ["?team=vs&lane=solo", "Lane solo · no Lead or Brainstorm running", { lane: "solo", role: null }],
    ["?team=vs&lane=per&role=lead", "Lane per · Brainstorm ready · no Lead", { lane: "per", role: "lead" }],
  ]) {
    reset();
    globalThis.location = { search: q };
    render(props(p3Squad()));
    const t = render(props(p3Squad()));
    assert.equal(byId(t, "boring-project-view"), null, `${q}: not the Overview`);
    assert.ok(byId(t, "boring-lane-no-agent"), `${q}: the lane's empty card`);
    assert.equal(headOf(t), head, `${q}: header`);
    assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: null, tab: null, ...keys }, `${q}: published keys name the same card`);
  }
  reset();
  globalThis.location = { search: "?team=vs&lane=gone" };
  const t = render(props(p3Squad()));
  assert.ok(byId(t, "boring-project-view"), "a lane the project no longer has: its Overview");
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: null, lane: null, role: null, tab: null });
});

test("P3: a pop (navGen) re-lands the lane empty card and its role; ?team= alone is the Overview; ?slot=bugs&role=lead the Bugs Lead card", () => {
  reset();
  const view = p3Squad();
  render(props(view));
  const pop = (search, gen) => { globalThis.location = { search }; render(props(view, { navGen: gen })); return render(props(view, { navGen: gen })); };
  let t = pop("?team=vs&lane=per&role=lead", 1);
  assert.equal(headOf(t), "Lane per · Brainstorm ready · no Lead", "Back/Forward to the lane's Lead card");
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: null, lane: "per", role: "lead", tab: null });
  t = pop("?team=vs", 2);
  assert.ok(byId(t, "boring-project-view"), "the plain ?team= entry is the Overview");
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: null, lane: null, role: null, tab: null });
  t = pop("?team=vs&lane=solo", 3);
  assert.equal(headOf(t), "Lane solo · no Lead or Brainstorm running");
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: null, lane: "solo", role: null, tab: null }, "brainstorm is the default role (omitted)");
  t = pop("?team=vs&slot=bugs&role=lead", 4);
  assert.equal(headOf(t), "Bugs · Brainstorm ready · no Lead", "the Bugs slot keeps its role too");
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: "bugs", lane: null, role: "lead", tab: null });
  t = pop("?team=vs&slot=bugs", 5);
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: "bugs", lane: null, role: null, tab: null }, "?slot=bugs alone is its Brainstorm (its live Buddy shows)");
  assert.equal(globalThis.__calls.filter((c) => c[0] === "onSelectSquad").length, 0, "same project: no squad switch");
});

test("P3: a cold load whose team resolves after mount adopts its ?lane= card once (pendingUrl0), never on another view", () => {
  reset();
  const vs = p3Squad();
  const efi = efiSquad();
  globalThis.location = { search: "?team=vs&lane=per&role=lead" };
  let t = render({ ...props(efi), views: [efi] }); // the URL's team is not loaded yet: the fallback view adopts nothing
  assert.ok(byId(t, "boring-project-view"), "fallback view: its Overview");
  assert.deepEqual(globalThis.__screenKeys, { team: "efi", slot: null, lane: null, role: null, tab: null });
  render({ ...props(vs), views: [efi, vs] }); // its view resolves: the effect adopts the URL's lane card
  t = render({ ...props(vs), views: [efi, vs] });
  assert.equal(headOf(t), "Lane per · Brainstorm ready · no Lead");
  assert.deepEqual(globalThis.__screenKeys, { team: "vs", slot: null, lane: "per", role: "lead", tab: null });
});

test("P3 wiring: lane/role derive from the main selection only (never the split's pane-local rightCard); App's sync is unchanged", () => {
  assert.match(src, /const urlLane = mode === "chat" && !agent && currentConv \? currentConv\.laneId : null;/);
  assert.match(src, /const urlRole = \(urlLane \|\| urlSlot === "bugs"\) && currentPin && selectedRole === "lead" \? "lead" : null;/);
  const keysAt = src.indexOf("const urlLane =");
  assert.doesNotMatch(src.slice(keysAt, src.indexOf("\n", src.indexOf("const urlRole ="))), /rightCard/, "rightCard never feeds a URL key (Bor3)");
  const pf = readFileSync(resolve(import.meta.dirname, "..", "src", "pinFocus.ts"), "utf8");
  assert.match(pf, /k\.lane === boringScreen\.lane && k\.role === boringScreen\.role/, "a lane/role change notifies App (its sync dep)");
});
