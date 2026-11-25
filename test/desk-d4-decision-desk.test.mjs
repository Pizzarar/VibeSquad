// @desk D4 (docs/PLAN_DESK_DECISION_DESK.md): unit tests for BoringDecisionDesk helpers,
// URL state (?view=decisions), BoringAde default landing + sidebar entry + popstate wiring,
// and WCAG contrast of Decision Desk tokens.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { transformSync } from "rolldown/utils";

const ROOT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "vs-desk-d4-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
const stub = (name, body) => writeFileSync(join(dir, name), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);

const hs = (globalThis.__hs = { slots: [], i: 0 });
globalThis.__calls = [];
globalThis.window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };
globalThis.location = { search: "" };
globalThis.__agents = new Map();
globalThis.__rosterLoaded = true;

writeFileSync(
  join(dir, "react-hooks.mjs"),
  `export * from ${JSON.stringify(reactUrl)};
export const useRef = (init) => { const h = globalThis.__hs; const k = h.i++; if (!h.slots[k]) h.slots[k] = { current: init }; return h.slots[k]; };
export const useMemo = (fn) => fn();
export const useSyncExternalStore = (_sub, get) => get();
export const useEffect = (fn, deps) => { const h = globalThis.__hs; const k = h.i++; const prev = h.slots[k]; const same = prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j])); if (same) return; if (prev && typeof prev.cleanup === "function") prev.cleanup(); const cleanup = fn(); h.slots[k] = { deps, cleanup }; };
export const useState = (init) => { const h = globalThis.__hs; const k = h.i++; if (!(k in h.slots)) h.slots[k] = typeof init === "function" ? init() : init; return [h.slots[k], (v) => { h.slots[k] = typeof v === "function" ? v(h.slots[k]) : v; }]; };`,
);

// Extract real parseUrlState + serializeUrlState from CommandPalette.tsx
const palSrc = readFileSync(join(ROOT, "src", "CommandPalette.tsx"), "utf8");
const parseStart = palSrc.indexOf("export type UrlSlot");
const serEnd = palSrc.indexOf("export type PaletteItem");
writeFileSync(join(dir, "urlState.mjs"), transformSync("urlState.ts", palSrc.slice(parseStart, serEnd), { lang: "ts" }).code);
const { parseUrlState, serializeUrlState } = await import(pathToFileURL(join(dir, "urlState.mjs")).href);

// Compile real urlSync.ts
writeFileSync(join(dir, "urlSync.mjs"), transformSync("urlSync.ts", readFileSync(join(ROOT, "src", "urlSync.ts"), "utf8"), { lang: "ts" }).code);
const { urlSyncScreen, urlSyncDecision, deskLandingAtLoad, deskLandingGate } = await import(pathToFileURL(join(dir, "urlSync.mjs")).href);

// Stubs for BoringDecisionDesk.tsx
stub("demoFlag.mjs", "export const DEMO = false;");
stub("demo.mjs", "export const demoLog = () => [];");
stub("attentionItems.mjs", `export const formatAge = (ts, now = Date.now()) => Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 60000)) + "m" : ""; export const stalledCount = () => 0; export const isInNeedsYou = () => false; export const glyphStatusOf = (a) => a.status;`);
writeFileSync(join(dir, "teams.mjs"), `export const isHubLane = (team, lane) => lane.hub === true || (!team.lanes.some((l) => l.hub === true) && lane.id === team.id);`);
writeFileSync(join(dir, "boringLocation.mjs"), transformSync("boringLocation.ts", readFileSync(join(ROOT, "src", "boringLocation.ts"), "utf8"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
stub("pins.mjs", `export const isHubPin = (p) => Boolean(p.lane.hub); export const pinsForSquad = (v) => ({ pinned: v.pins ?? [], done: [] }); export const isLive = (m) => Boolean(m) && !m.agent.archivedAt && m.agent.status !== "closed"; export const liveBuddyId = (p) => (isLive(p.brainstorm) ? p.brainstorm.agent.id : null); export const quickBugsChipState = (v) => v.bugs ?? { pin: null, leadRunning: false, needsYou: 0 }; export const perfectionPin = () => null;`);
stub("skyZonesLogic.mjs", "export const skyZonesFor = (v) => v.zones;");
stub("ui.mjs", `export const StatusDot = () => null; export const cleanTitle = (t) => String(t ?? "").replace(/^★\\s*lead\\s*·\\s*/i, "").trim();`);

const ddSrc = readFileSync(join(ROOT, "src", "BoringDecisionDesk.tsx"), "utf8");
const ddCode = transformSync("BoringDecisionDesk.tsx", ddSrc, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringDecisionDesk.mjs"), ddCode);

const {
  DECISION_DESK_DEFAULT_LANDING,
  DECISION_UNDO_MS,
  classifyDecisionRow,
  groupFeedBySquad,
  buildAnswerBatch,
  lastLaneLogEvent,
  buildStatusStrip,
  demoDecisionItems,
  DECISION_LEANS_OPT_IN,
  QUIET_LANE_MS,
  splitQuietLanes,
  isQuietLane,
  decisionSummary,
  decisionMatchesLane,
  orderStripLikeFeed,
} = await import(pathToFileURL(join(dir, "BoringDecisionDesk.mjs")).href);

// Also compile BoringAde.tsx with REAL BoringDecisionDesk.mjs (DECISION_DESK_DEFAULT_LANDING = true)
const rec = (name) => `(...a) => { globalThis.__calls.push(["${name}", ...a]); }`;
stub("useNowTick.mjs", "export const useNowTick = () => Date.now();");
stub("boringBusts.mjs", `export const bustUrl = (r) => "/ui/busts/" + r + ".png";`);
stub("IdeaInbox.mjs", `export function IdeaInbox() { return null; } export const refreshInboxCards = () => Promise.resolve([]); export const useInboxCards = () => []; export const useFocusedInboxCard = () => null;`);
for (const n of ["AgentDrawer", "BoringContextPanel", "UsageDashboard", "TeamFeed", "BoringInbox"]) stub(`${n}.mjs`, `export function ${n}() { return null; }`);
stub("Timeline.mjs", `export function TimelineErrorBoundary(p) { return p.children; }`);
stub("CommandPalette.mjs", `export { parseUrlState, serializeUrlState } from "./urlState.mjs"; export const openOverlay = ${rec("openOverlay")}; export const teamCtxItems = () => []; export const laneCtxItems = () => []; export const openContextMenu = () => {};`);
stub("boringFolders.mjs", `export const folderSlug = (n) => n.toLowerCase(); export const isViewAsleep = () => false; export const filterAwakeViews = (v) => v; export const partitionViews = (views) => ({ activeViews: views, folderGroups: [] }); export const patchTeamsFolder = async () => ({ ok: true }); export const setLastFolder = () => {}; export const getLastFolder = () => undefined; export const migrateLastFolder = () => {};`);
stub("PinRemove.mjs", `export function RemoveTeamDialog() { return null; }`);
stub("ProjectTabs.mjs", `export function ProjectTabs() { return null; }`);
stub("StorybookView.mjs", `export const useStorybookPresent = () => false;`);
stub("CrunchToggle.mjs", `export function CrunchToggle() { return null; }`);
stub("projectOrderActions.mjs", `export const projectOrder = { drop: async () => true, move: async () => true, setMain: async () => true }; export const knownFolderNames = () => new Set();`);
stub("ctxMenuLogic.mjs", `export const captureFocusReturn = () => null;`);
stub("projectOrder.mjs", `export const mainView = () => null;`);
stub("panes.mjs", `export const openAgent = ${rec("openAgent")}; export const openAgentInTab = ${rec("openAgentInTab")}; export const toggleSplit = () => {}; export const collapseSplit = () => {}; export const getPanes = () => ({ activePane: "left", leftActiveId: null, rightActiveId: null, split: false }); export const setActivePane = () => {}; export const closeTab = () => {}; export const usePanes = () => ({ activePane: "left", leftActiveId: null, rightActiveId: null, split: false });`);
stub("paseo.mjs", `export const sendMessage = () => {}; export const usePaseo = () => ({ agents: globalThis.__agents, rosterLoaded: globalThis.__rosterLoaded });`);
stub("pinActions.mjs", `export const createQuickBugsPin = async () => ({ lane: { id: "bug" } });`);
stub("pinFocus.mjs", `export const openPinMember = () => {}; export const spinUpPin = async () => null; export const setBoringShownAgent = () => {}; export const setBoringScreenKeys = () => {}; export const setBoringScreenView = ${rec("setBoringScreenView")}; export const setBoringLandedGen = () => {};`);
stub("pinFocusLogic.mjs", `export const boringDeepLinkPending = () => false; export const boringUrlAgent = (a) => a.shownAgentId;`);
stub("prefs.mjs", `export const setPref = () => {}; export const formatTimestamp = () => "";`);
stub("FirstRunModal.mjs", `export const VIBE_PICKED_KEY = "vs.vibePicked"; export const VibePickerCards = () => null; export const FirstLaunchVibePicker = () => null; export const shouldShowFirstLaunchVibePicker = () => false;`);
stub("usageHelpers.mjs", `export const OPEN_USAGE_EVENT = "vs:open-usage"; export const takeColdUsageFocus = () => false;`);
stub("useBotFace.mjs", `export const useTheme = () => "dark";`);
stub("railCheckin.mjs", `export const runCheckin = async () => "send";`);

const adeSrc = readFileSync(join(ROOT, "src", "BoringAde.tsx"), "utf8");
const adeCode = transformSync("BoringAde.tsx", adeSrc, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringAde.mjs"), adeCode);
const { BoringApp, boringLandingFromUrl, boringBreadcrumb, boringActiveSelection } = await import(pathToFileURL(join(dir, "BoringAde.mjs")).href);

const walk = (n, f, out = []) => {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) return n.forEach((c) => walk(c, f, out)), out;
  if (f(n)) out.push(n);
  walk(n.props?.children, f, out);
  return out;
};
const byId = (t, id) => walk(t, (n) => n.props?.["data-testid"] === id)[0] ?? null;

const squad = (id = "vs", name = "VibeSquad") => ({
  team: { id, name, lanes: [{ id: "desk", name: "Desk", code: "desk" }] },
  members: [],
  pins: [{ lane: { id: "desk", name: "Desk", code: "desk" }, brainstorm: { agent: { id: `${id}-bs`, status: "idle", updatedAt: "2026-11-25T10:00:00Z" } }, lead: { agent: { id: `${id}-ld`, status: "running", updatedAt: "2026-11-25T11:55:00Z" } }, workers: [], needsYou: 0, running: 1 }],
  zones: { hub: { lane: { id: "hub" } }, riffbot: { agentId: `${id}-rb`, member: { agent: { id: `${id}-rb`, status: "idle" } } }, overlord: { agentId: `${id}-ov`, member: { agent: { id: `${id}-ov`, status: "running" } } } },
  bugs: { pin: null, leadRunning: false, needsYou: 0 },
  needsYou: 0,
  running: 1,
});

test("D4 constants: placement lean defaults true and undo window is 5s", () => {
  assert.equal(DECISION_DESK_DEFAULT_LANDING, true);
  assert.equal(DECISION_UNDO_MS, 5000);
});

test("D4 classifyDecisionRow: yesno, answer, offscreen, plus lean fallback when kind is empty", () => {
  assert.equal(classifyDecisionRow({ kind: "yesno", lean: "Go" }), "yesno");
  assert.equal(classifyDecisionRow({ kind: "answer", lean: "" }), "answer");
  assert.equal(classifyDecisionRow({ kind: "offscreen", lean: "" }), "offscreen");
  assert.equal(classifyDecisionRow({ kind: "", lean: "Use A" }), "yesno");
  assert.equal(classifyDecisionRow({ kind: "", lean: "" }), "answer");
});

test("D4 groupFeedBySquad: groups by Squad and sorts oldest first", () => {
  const items = [
    { id: "ny-2", squad: "efi", squadName: "Main Game Project", lane: "q", ask: "newer efi", ts: 300 },
    { id: "ny-1", squad: "vs", squadName: "VibeSquad", lane: "desk", ask: "oldest vs", ts: 100 },
    { id: "ny-3", squad: "vs", squadName: "VibeSquad", lane: "ade", ask: "second vs", ts: 200 },
  ];
  const groups = groupFeedBySquad(items);
  assert.deepEqual(groups.map((g) => g.squad), ["vs", "efi"]);
  assert.deepEqual(groups[0].items.map((i) => i.id), ["ny-1", "ny-3"]);
  assert.deepEqual(groups[1].items.map((i) => i.id), ["ny-2"]);
});

test("D4 buildAnswerBatch: builds lean, alt:n, not, reply (trimmed, non-empty) and dismiss payloads in feed order", () => {
  const items = [
    { id: "a", ts: 1 },
    { id: "b", ts: 2 },
    { id: "c", ts: 3 },
    { id: "d", ts: 4 },
  ];
  const batch = buildAnswerBatch(items, {
    a: { choice: "not" },
    b: { choice: "alt:1" },
    c: { choice: "reply", text: "  45000ms  " },
    d: { choice: "reply", text: "   " },
  });
  assert.deepEqual(batch, [
    { id: "a", choice: "not" },
    { id: "b", choice: "alt:1" },
    { id: "c", choice: "reply", text: "45000ms" },
  ]);
});

test("D4 lastLaneLogEvent & buildStatusStrip: matches newest done/decision per lane across Squads", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const logs = {
    vs: [
      { ts: "2026-11-25T11:00:00Z", lane: "@desk", type: "done", text: "old done" },
      { ts: "2026-11-25T11:50:00Z", lane: "desk", type: "decision", text: "shipped D4" },
      { ts: "2026-11-25T11:55:00Z", lane: "desk", type: "blocker", text: "ignored non-done" },
    ],
  };
  assert.equal(lastLaneLogEvent(logs.vs, "desk", "@desk")?.text, "shipped D4");
  const groups = buildStatusStrip([squad("vs", "VibeSquad")], logs, now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lanes.length, 2); // Desk + @desk
  const deskLane = groups[0].lanes.find((l) => l.laneId === "desk");
  assert.equal(deskLane?.leadState, "running");
  assert.equal(deskLane?.lastEvent, "shipped D4");
  assert.equal(deskLane?.lastEventType, "decision");
});

test("D4 demoDecisionItems: 12 items across 3 Squads with all 3 row types and optional D3 inferred/grouped fields", () => {
  const items = demoDecisionItems(Date.parse("2026-11-25T12:00:00Z"));
  assert.equal(items.length, 12);
  assert.equal(new Set(items.map((i) => i.squad)).size, 3);
  assert.ok(items.some((i) => classifyDecisionRow(i) === "yesno"));
  assert.ok(items.some((i) => classifyDecisionRow(i) === "answer"));
  assert.ok(items.some((i) => classifyDecisionRow(i) === "offscreen"));
  assert.ok(items.some((i) => i.inferred === true));
  assert.ok(items.some((i) => Array.isArray(i.sourceIds) && i.sourceIds.length > 1));
});

test("D4 URL state: ?view=decisions parses and serializes cleanly", () => {
  assert.deepEqual(parseUrlState("?view=decisions"), { team: null, agent: null, slot: null, tab: null, view: "decisions" });
  assert.equal(serializeUrlState({ team: "vs", agent: null, view: "decisions" }, "?demo="), "?demo=&view=decisions");
  assert.equal(serializeUrlState({ team: "vs", agent: null }, "?demo=&view=decisions"), "?demo=&team=vs");
  assert.deepEqual(parseUrlState("?team=vs&agent=a&view=decisions"), { team: "vs", agent: "a", slot: null, tab: null });
});

test("D4 BoringAde wiring: default landing is Decision Desk, sidebar entry switches to it, and ?view=decisions routes cleanly", () => {
  hs.slots = [];
  globalThis.__calls = [];
  globalThis.location = { search: "" };
  const v = squad();
  const baseProps = { views: [v], view: v, onSelectSquad: () => {}, onOpenPin: () => {}, onSpinUpPin: () => {}, onSpinUpOverlord: () => {}, onAddBuddy: () => {}, onNewSquad: () => {}, onSettings: () => {}, onSuccessor: () => {} };
  BoringApp(baseProps); // mount effect switches default landing to Decision Desk
  hs.i = 0;
  const t = BoringApp(baseProps);
  assert.ok(byId(t, "boring-decisions-view"), "bare URL lands on Decision Desk by default");
  assert.ok(byId(t, "boring-decisions-nav"), "sidebar Decisions · N entry is present");
  assert.equal(byId(t, "boring-project-view"), null);
  assert.deepEqual(boringLandingFromUrl([v], "?view=decisions"), { mode: "decisions", teamId: null });
  assert.deepEqual(boringBreadcrumb({ project: "VibeSquad", mode: "decisions", laneLabel: null, agentLabel: null }), [{ key: "project", label: "Decision Desk" }]);
  assert.equal(boringActiveSelection({ mode: "decisions", views: [v], teamId: "vs", agentId: null, laneId: null, role: "brainstorm", workerId: null }).rowKey, null);
});

test("D4 r2 (UX R37): lean opt-in constant, quiet-lane fold + sort, decision-aware lane match, and counts that add up", () => {
  assert.equal(DECISION_LEANS_OPT_IN, true, "option (b): leans are explicit opt-in");
  const now = Date.parse("2026-11-25T12:00:00Z");
  const L = (laneId, over = {}) => ({ key: laneId, squadId: "vs", laneId, label: laneId, code: "", leadState: "idle", lastEvent: "", lastEventType: "", age: "", openAgentId: null, lastTs: now - QUIET_LANE_MS - 1, openDecisions: 0, ...over });
  const lanes = [L("_desk", { lastTs: 0 }), L("old"), L("waiting", { openDecisions: 2 }), L("fresh", { lastTs: now - 60_000 }), L("err", { leadState: "error" }), L("blank", { lastTs: 0, leadState: "none" })];
  assert.equal(isQuietLane(lanes[2], now), false, "open decisions are never quiet");
  const { shown, quiet } = splitQuietLanes(lanes, now);
  assert.deepEqual(quiet.map((l) => l.laneId), ["old", "blank"]);
  assert.deepEqual(shown.map((l) => l.laneId), ["_desk", "waiting", "err", "fresh"], "Desk first, then lanes needing the owner, then the rest");
  assert.equal(decisionMatchesLane({ squad: "VS", lane: "@waiting" }, "vs", "waiting", "@waiting"), true);
  assert.equal(decisionMatchesLane({ squad: "efi", lane: "waiting" }, "vs", "waiting", ""), false);
  assert.equal(decisionMatchesLane({ squad: "vs", lane: "" }, "vs", "_desk", ""), true);
  assert.equal(decisionSummary([{ kind: "yesno" }, { kind: "answer" }, { kind: "offscreen" }]), "3 open · 2 here · 1 off-screen");
  assert.equal(decisionSummary([]), "All clear across Squads");
});

test("D4 r3 (Review-Gemini MEDIUM): the Desk landing hold clears once the Desk lands, so a Back before any input is still canonicalized", () => {
  // Load hold: bare and ?view=decisions both hold (R38 m1: no ?team= flash on a fresh ?view=decisions load); ?team= / ?agent= never do.
  assert.equal(deskLandingAtLoad(parseUrlState("?demo="), true), true);
  assert.equal(deskLandingAtLoad(parseUrlState("?demo=&view=decisions"), true), true, "R38 m1: a fresh ?view=decisions load holds too");
  assert.equal(deskLandingAtLoad(parseUrlState("?team=vs"), true), false);
  assert.equal(deskLandingAtLoad(parseUrlState("?agent=a"), true), false);
  assert.equal(deskLandingAtLoad(parseUrlState(""), false), false);
  // Script App's two URL-sync effects + onPop over: bare load -> Desk mounts -> Back to a non-canonical ?team= entry before any input.
  const app = { pending: deskLandingAtLoad(parseUrlState("?demo="), true), popActive: true, search: "?demo=", writes: [] };
  const run = (decisionView, next) => {
    const g = deskLandingGate({ pending: app.pending, decisionView, popActive: app.popActive, boring: true });
    app.pending = g.pending;
    if (g.hold) return "held";
    const d = urlSyncDecision({ next, current: app.search, popActive: app.popActive, storybookReplace: () => false });
    if (d.write) { app.writes.push([d.replace ? "replace" : "push", next]); app.search = next; }
    return d;
  };
  assert.equal(run(false, "?demo=&team=vs"), "held", "first frame: the first project's ?team= is not written before the Desk");
  run(true, "?demo=&view=decisions"); // Effect 2: the Desk mounted
  assert.equal(app.pending, false, "the landing is done: the hold is cleared");
  assert.deepEqual(app.writes, [["replace", "?demo=&view=decisions"]], "the load's own entry is replaced, never pushed");
  // Back to a pasted ?team=vs&tab=bogus entry before any pointerdown/keydown: onPop clears (already clear) and the heal still replaces.
  app.search = "?demo=&team=vs&tab=bogus";
  app.pending = false; // onPop
  run(false, "?demo=&team=vs");
  assert.deepEqual(app.writes.at(-1), ["replace", "?demo=&team=vs"], "popped ?team= entry canonicalized with replaceState");
  // Even if a pop lands while the hold is still pending (Desk not mounted yet), onPop's clear lets the pop's write through.
  assert.deepEqual(deskLandingGate({ pending: false, decisionView: false, popActive: true, boring: true }), { hold: false, pending: false });
  assert.deepEqual(deskLandingGate({ pending: true, decisionView: false, popActive: true, boring: true }), { hold: true, pending: true });
  assert.deepEqual(deskLandingGate({ pending: true, decisionView: false, popActive: false, boring: true }), { hold: false, pending: false }, "first input ends it");
  assert.deepEqual(deskLandingGate({ pending: true, decisionView: false, popActive: true, boring: false }), { hold: false, pending: true }, "Psycho never holds");
  // App wiring: both effects and onPop go through the gate; no u.view exclusion left.
  const appSrc = readFileSync(join(ROOT, "src", "App.tsx"), "utf8");
  assert.match(appSrc, /const deskLandingPending = useRef\(deskLandingAtLoad\(parseUrlState\(location\.search\), DECISION_DESK_DEFAULT_LANDING\)\);/);
  assert.doesNotMatch(appSrc, /u\.view !== "decisions"/);
  assert.match(appSrc, /armPop\(\); \/\/ a second pop retargets[^\n]*\n\s*deskLandingPending\.current = false;/, "onPop clears the hold");
  assert.equal(appSrc.match(/deskLandingPending\.current = hold[12]\.pending;/g)?.length, 2, "both URL-sync effects store the gate's verdict");
  assert.ok(appSrc.indexOf("const deskLandingPending") < appSrc.indexOf("const onPop = "), "declared before onPop uses it");
});

test("D4 r3: Bugs lane open decisions count @bug asks once (lane id \"bug-chaser\" and \"bug\")", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  for (const laneId of ["bug-chaser", "bug"]) {
    const v = squad();
    v.bugs = { pin: { lane: { id: laneId, name: "Bugs" }, lead: null, brainstorm: null, workers: [] }, leadRunning: false, needsYou: 0 };
    const items = [
      { id: "a", squad: "vs", lane: "@bug", kind: "yesno", lean: "x", ts: 1 },
      { id: "b", squad: "vs", lane: "bug", kind: "answer", lean: "", ts: 2 },
      { id: "c", squad: "vs", lane: laneId, kind: "answer", lean: "", ts: 3 },
    ];
    const [g] = buildStatusStrip([v], {}, now, items);
    const bugsLine = g.lanes.find((l) => l.label === "Bugs");
    assert.equal(bugsLine.openDecisions, 3, `${laneId}: 3 asks, each counted once`);
  }
});

test("D4 r3 (UX R38 m3): the status strip lists Squads in the feed's order; Squads without feed items keep their order after", () => {
  const groups = [{ squadId: "vs" }, { squadId: "site" }, { squadId: "efi" }, { squadId: "quiet" }];
  const feed = groupFeedBySquad([
    { id: "1", squad: "EFI", squadName: "E", ts: 10 },
    { id: "2", squad: "site", squadName: "S", ts: 20 },
    { id: "3", squad: "vs", squadName: "V", ts: 30 },
  ]);
  assert.deepEqual(orderStripLikeFeed(groups, feed).map((g) => g.squadId), ["efi", "site", "vs", "quiet"]);
  assert.deepEqual(orderStripLikeFeed(groups, []).map((g) => g.squadId), ["vs", "site", "efi", "quiet"], "empty feed keeps the views order");
  const dd = readFileSync(join(ROOT, "src", "BoringDecisionDesk.tsx"), "utf8");
  assert.match(dd, /\{stripGroups\.map\(\(g\) =>/, "the strip renders the feed-ordered groups");
});

test("D4 r3: no dead .boring-decision-dot.st-waiting rule (waiting lanes render st-needs-you)", () => {
  const css = readFileSync(join(ROOT, "src", "boring.css"), "utf8");
  assert.doesNotMatch(css, /\.boring-decision-dot\.st-waiting/);
  assert.match(css, /\.boring-decision-dot\.st-needs-you \{ background: var\(--st-attn\); \}/);
});

test("D4 P2 (UX R38 m2 + m4, idea-1070): wide rail grows past 580px; stacked layout puts feed before scroll-capped strip", () => {
  const dd = readFileSync(join(ROOT, "src", "BoringDecisionDesk.tsx"), "utf8");
  const feedIdx = dd.indexOf('data-testid="boring-decision-feed"');
  const stripIdx = dd.indexOf('data-testid="boring-decision-strip"');
  assert.ok(feedIdx > 0 && stripIdx > 0 && feedIdx < stripIdx, "m4: decision feed precedes status strip in DOM order for stacked layout");
  assert.equal(DECISION_LEANS_OPT_IN, true, "leans stay opt-in");

  const css = readFileSync(join(ROOT, "src", "boring.css"), "utf8");
  const d4Start = css.indexOf("/* @desk D4 r2");
  const tail = css.slice(d4Start);
  assert.doesNotMatch(tail, /@(media|container)\b/, "no @media/@container at-rules in boring.css D4/P2 block");
  assert.match(css, /\.boring-decision-desk\s*\{[^}]*width:\s*100%/, "desk stretches inside column flex wrap");
  assert.doesNotMatch(tail, /minmax\(500px,\s*580px\)/, "m2: 580px rail cap removed");
  assert.match(tail, /\.boring-decision-desk\.is-wide\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*clamp\(/, "m2: wide rail uses responsive clamp()");
  assert.match(tail, /\.boring-decision-desk:not\(\.is-wide\)\s+\.boring-decision-strip\s*\{[^}]*max-height:\s*min\(320px,\s*35vh\);[^}]*overflow-y:\s*auto;/, "m4: stacked strip has capped scroll height");
});
