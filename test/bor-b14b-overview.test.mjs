// @bor B14b: Project Overview Living Signature restyle (docs/PLAN_BORING_MODE_B14.md Block 2).
// Renders <BoringApp>'s Overview lane table (src/BoringAde.tsx ~1052-1099) as a DOM and asserts the B13 Living
// Signature language: Art14 canon mini-busts with theme-aware src and state classes, the correct status text for
// Desk / Bugs (idle, running, needs-you) / lane rows, the calm segmented tabs, and WCAG >= 4.5:1 text contrast.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(resolve(root, ...p), "utf8");
const css = read("src", "boring.css");

// ---- Render harness (mirrors test/boring-mode.test.mjs): stub BoringAde's siblings, transpile, import <BoringApp>.
const dir = mkdtempSync(join(tmpdir(), "vs-bor-b14b-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
const stub = (name, body) => writeFileSync(join(dir, name), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);

writeFileSync(join(dir, "teams.mjs"), `export const isHubLane = (team, lane) => lane.hub === true || (!team.lanes.some((l) => l.hub === true) && lane.id === team.id);`);
writeFileSync(join(dir, "boringLocation.mjs"), transformSync("boringLocation.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "boringLocation.ts"), "utf8"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
writeFileSync(join(dir, "condenseReason.mjs"), transformSync("condenseReason.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "condenseReason.ts"), "utf8"), { lang: "ts" }).code);

const ade = read("src", "BoringAde.tsx");
const hs = (globalThis.__hs = { slots: [], i: 0 });
globalThis.__calls = [];
globalThis.__defaultWindow = { addEventListener() {}, removeEventListener() {} }; globalThis.window = globalThis.__defaultWindow;
globalThis.__agents = new Map();
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
stub("boringBusts.mjs", `export const bustUrl = (r, theme) => "/ui/busts/" + r + (theme === "light" ? "-light" : "") + ".png";`);
stub("demo.mjs", "export const demoLog = () => [];");
stub("demoFlag.mjs", "export const DEMO = false;");
stub("attentionItemsBoring.mjs", `export const stalledCount = (members) => members.filter((m) => m.stalled).length; export const isInNeedsYou = (m) => Boolean(m.stalled) || Boolean(m.attention && m.attention.tone !== "finished"); export const glyphStatusOf = (a) => a.glyph ?? a.status;`);
stub("IdeaInbox.mjs", `export function IdeaInbox() { return null; } export const refreshInboxCards = () => { globalThis.__refreshInbox?.(); return Promise.resolve([]); }; export const useInboxCards = () => globalThis.__inboxCards ?? []; export const useFocusedInboxCard = () => globalThis.__focusedInboxCard ?? null;`);
for (const n of ["AgentDrawer", "BoringContextPanel", "UsageDashboard", "TeamFeed"]) stub(`${n}.mjs`, `export function ${n}() { return null; }` + (n === "TeamFeed" ? " export const fetchLog = () => Promise.resolve([]);" : ""));
stub("Timeline.mjs", `export function TimelineErrorBoundary(p) { return p.children; }`);
stub("CommandPalette.mjs", `export const openOverlay = ${rec("openOverlay")}; export const teamCtxItems = (v) => ["team", v.team.id]; export const laneCtxItems = (v, p, o) => Object.assign(["lane", v.team.id, p.lane.id, Boolean(o && o.onRemove), o && o.displayName], { onRemove: o && o.onRemove }); export const openContextMenu = (e, items) => { globalThis.__calls.push(["openContextMenu", items]); }; export const parseUrlState = (search) => { const p = new URLSearchParams(search); return { team: p.get("team") || null, agent: p.get("agent") || null }; };`);
stub("boringFolders.mjs", `export const folderSlug = (n) => n.toLowerCase(); export const isViewAsleep = () => false; export const filterAwakeViews = (v) => v; export const partitionViews = (views) => ({ activeViews: views, folderGroups: [] }); export const patchTeamsFolder = async () => ({ ok: true }); export const setLastFolder = () => {}; export const getLastFolder = () => undefined; export const migrateLastFolder = () => {};`);
stub("PinRemove.mjs", `export function RemoveTeamDialog() { return null; }`);
stub("StorybookView.mjs", `export const useStorybookPresent = () => false;`);
stub("ProjectTabs.mjs", `export function ProjectTabs() { return null; }`);
stub("CrunchToggle.mjs", `export function CrunchToggle() { return null; } export const useCrunchMode = () => false;`);
writeFileSync(join(dir, "ctxMenuLogic.mjs"), transformSync("ctxMenuLogic.ts", readFileSync(resolve(import.meta.dirname, "..", "src", "ctxMenuLogic.ts"), "utf8"), { lang: "ts" }).code);
stub("panes.mjs", `export const openAgent = ${rec("openAgent")}; export const openAgentInTab = ${rec("openAgentInTab")}; export const toggleSplit = (...a) => { globalThis.__calls.push(["toggleSplit", ...a]); if (globalThis.__panes) globalThis.__panes = { ...globalThis.__panes, split: !globalThis.__panes.split }; }; export const collapseSplit = (...a) => { globalThis.__calls.push(["collapseSplit", ...a]); const p = globalThis.__panes; if (p) { const r = a[0] === "active" && p.activePane === "right"; const keep = (r ? p.rightActiveId : p.leftActiveId) ?? (r ? p.leftActiveId : p.rightActiveId); globalThis.__panes = { ...p, split: false, activePane: "left", leftActiveId: keep, rightActiveId: null }; } }; export const getPanes = () => globalThis.__panes ?? { activePane: "left", leftActiveId: null, rightActiveId: null, split: false }; export const setActivePane = ${rec("setActivePane")}; export const closeTab = ${rec("closeTab")}; export const usePanes = () => globalThis.__panes ?? { activePane: "left", leftActiveId: null, rightActiveId: null, split: false };`);
stub("paseo.mjs", `export const sendMessage = ${rec("sendMessage")}; export const usePaseo = () => ({ agents: globalThis.__agents, rosterLoaded: globalThis.__rosterLoaded });`);
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
stub("usageHelpers.mjs", `export const OPEN_USAGE_EVENT = "vs:open-usage"; export const takeColdUsageFocus = () => false;`);
stub("railCheckin.mjs", `export const runCheckin = (pin, deps) => { globalThis.__calls.push(["runCheckin", pin.lane.id, typeof deps.open, typeof deps.send]); return Promise.resolve("send"); };`);
stub("skyZonesBoring.mjs", "export const skyZonesFor = (v) => v.zones;");
stub("BoringInbox.mjs", `export const BoringInbox = function BoringInbox() { return null; };`);
stub("ui.mjs", `export const StatusDot = function StatusDot() { return null; }; export const cleanTitle = (t) => { let s = String(t ?? "untitled").trim(); const l = s.toLowerCase(); if (l.startsWith("★ lead · ")) s = s.slice(9).trim(); else if (l.startsWith("brainstorm · ")) s = s.slice(13).trim(); return s; };`);
stub(
  "useBotFace.mjs",
  "export const useBotFace = () => null; export const useDpr = () => 1; export const useFacesModel = () => null; export const useImageOk = () => false; export const usePrefersReducedMotion = () => false; export const useSkyCloudsModel = () => null; export const useTheme = () => globalThis.__theme ?? 'dark';",
);
const adeCode = transformSync("BoringAde.tsx", ade, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/skyZonesLogic"/, `from "./skyZonesBoring"`)
  .replace(/from "\.\/pinFocus"/, `from "./pinFocusBoring"`)
  .replace(/from "\.\/attentionItems"/, `from "./attentionItemsBoring"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringAde.mjs"), adeCode);
const { BoringApp } = await import(pathToFileURL(join(dir, "BoringAde.mjs")).href);

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
  globalThis.__rosterLoaded = undefined;
  globalThis.__theme = "dark";
};
const walk = (n, f, out = []) => {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) return n.forEach((c) => walk(c, f, out)), out;
  if (f(n)) out.push(n);
  walk(n.props?.children, f, out);
  return out;
};
const byId = (t, id) => walk(t, (n) => n.props?.["data-testid"] === id)[0] ?? null;
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

// A row is <tr data-testid="boring-lane-row-<laneId>"> with four boring-lane-cell buttons:
// [identity, brainstorm bust, lead bust, workers]. Return one bust cell's mini-avatar span class, img src and status text.
const bustOf = (t, rowId, role) => {
  const row = byId(t, `boring-lane-row-${rowId}`);
  const cells = walk(row, (n) => n.type === "button" && n.props?.className === "boring-lane-cell");
  const cell = role === "bs" ? cells[1] : cells[2];
  const mini = walk(cell, (n) => typeof n.type === "string" && String(n.props?.className ?? "").includes("boring-lane-mini"))[0];
  const img = walk(cell, (n) => n.type === "img" && n.props?.className === "boring-bust-img")[0];
  const stat = walk(cell, (n) => n.type === "span" && n.props?.className === "boring-lane-stat")[0];
  return {
    cls: mini ? String(mini.props.className) : "",
    src: img ? String(img.props.src) : null,
    stat: stat ? String(stat.props.children) : null,
  };
};

test("B14b: Overview table renders theme-aware Art14 mini-busts with state class and status text (dark)", () => {
  reset();
  const t = render(props(squad()));
  assert.ok(byId(t, "boring-lane-table"));
  // Desk: RiffBot brainstorm (idle) + Overlord lead (running)
  assert.deepEqual(bustOf(t, "_desk", "bs"), { cls: "boring-lane-mini idle", src: "/ui/busts/riffbot.png", stat: "idle" });
  assert.deepEqual(bustOf(t, "_desk", "ld"), { cls: "boring-lane-mini run lit", src: "/ui/busts/overlord.png", stat: "running" });
  // Bugs: both cells are the Bugs mascot; needs-you 1 + leadRunning -> attn lit (bs) / running (ld)
  assert.deepEqual(bustOf(t, "_bugs", "bs"), { cls: "boring-lane-mini attn lit", src: "/ui/busts/bugs.png", stat: "needs you" });
  assert.deepEqual(bustOf(t, "_bugs", "ld"), { cls: "boring-lane-mini attn lit", src: "/ui/busts/bugs.png", stat: "running" });
  // feature lane with a running lead and needs-you: idle brainstorm carries the attn ring, lead is attn lit
  assert.deepEqual(bustOf(t, "ade", "bs"), { cls: "boring-lane-mini attn", src: "/ui/busts/buddy.png", stat: "idle" });
  assert.deepEqual(bustOf(t, "ade", "ld"), { cls: "boring-lane-mini attn lit", src: "/ui/busts/lead.png", stat: "running" });
  // idle lane with no lead: idle buddy + hollow lead slot (no bust, no img)
  assert.deepEqual(bustOf(t, "per", "bs"), { cls: "boring-lane-mini idle", src: "/ui/busts/buddy.png", stat: "idle" });
  assert.deepEqual(bustOf(t, "per", "ld"), { cls: "boring-lane-mini none", src: null, stat: "—" });
});

test("B14b: light theme swaps every bust to its -light variant; hollow slots stay imageless", () => {
  reset();
  globalThis.__theme = "light";
  const t = render(props(squad()));
  assert.equal(bustOf(t, "_desk", "bs").src, "/ui/busts/riffbot-light.png");
  assert.equal(bustOf(t, "_desk", "ld").src, "/ui/busts/overlord-light.png");
  assert.equal(bustOf(t, "_bugs", "bs").src, "/ui/busts/bugs-light.png");
  assert.equal(bustOf(t, "ade", "ld").src, "/ui/busts/lead-light.png");
  assert.equal(bustOf(t, "per", "bs").src, "/ui/busts/buddy-light.png");
  assert.equal(bustOf(t, "per", "ld").src, null);
});

test("B14b M1: Bugs status text follows live/needs-you, never a stale 'idle' next to a lit bust", () => {
  // idle: no lead running, no needs-you
  reset();
  let t = render(props(squad({ bugs: { pin: null, leadRunning: false, needsYou: 0 } })));
  assert.deepEqual(bustOf(t, "_bugs", "bs"), { cls: "boring-lane-mini idle", src: "/ui/busts/bugs.png", stat: "idle" });

  // running: leadRunning with no needs-you must read "running" (the M1 fix), with the lit running ring
  reset();
  t = render(props(squad({ bugs: { pin: lanePin("bug", { brainstorm: mem("bug-bs") }), leadRunning: true, needsYou: 0 } })));
  assert.deepEqual(bustOf(t, "_bugs", "bs"), { cls: "boring-lane-mini run lit", src: "/ui/busts/bugs.png", stat: "running" });

  // needs-you: attention due, no lead running
  reset();
  t = render(props(squad({ bugs: { pin: lanePin("bug", { brainstorm: mem("bug-bs") }), leadRunning: false, needsYou: 2 } })));
  assert.deepEqual(bustOf(t, "_bugs", "bs"), { cls: "boring-lane-mini attn", src: "/ui/busts/bugs.png", stat: "needs you" });
});

test("B14b: each row keeps the identity cell first (dot + name + code + Needs-you badge) and the table testids", () => {
  reset();
  const t = render(props(squad()));
  for (const id of ["boring-lane-table", "boring-overview-tabs", "boring-overview-new-lane-btn", "boring-lane-row-_desk", "boring-lane-row-_bugs", "boring-lane-row-ade", "boring-lane-row-per"]) assert.ok(byId(t, id), id);
  // Desk, Bugs, then needs-you lanes first (ade) then idle (per)
  const rows = walk(t, (n) => /^boring-lane-row-/.test(String(n.props?.["data-testid"] ?? ""))).map((n) => n.props["data-testid"]);
  assert.deepEqual(rows, ["boring-lane-row-_desk", "boring-lane-row-_bugs", "boring-lane-row-ade", "boring-lane-row-per"]);
  // the needs-you lane row carries the attn left rule, its identity cell keeps dot + name + @code + badge
  const adeRow = byId(t, "boring-lane-row-ade");
  assert.match(String(adeRow.props.className), /attn/);
  const identity = walk(adeRow, (n) => n.type === "button" && n.props?.className === "boring-lane-cell")[0];
  assert.ok(walk(identity, (n) => n.type === "span" && /boring-dot/.test(String(n.props?.className ?? ""))).length >= 1, "dot");
  assert.ok(walk(identity, (n) => n.type === "span" && n.props?.className === "boring-row-label boring-lane-name")[0], "lane name");
  assert.ok(walk(identity, (n) => n.type === "code" && n.props?.className === "boring-lane-code")[0], "@code");
  assert.match(JSON.stringify(identity.props.children), /Needs you/);
});

test("B14b: Overview renders the segmented tabs, + New lane button and the lane-table card", () => {
  reset();
  const t = render(props(squad()));
  for (const id of ["boring-tab-overview", "boring-tab-inbox", "boring-tab-feed"]) assert.ok(byId(t, id), id);
  assert.match(String(byId(t, "boring-tab-overview").props.className), /on/);
  assert.match(JSON.stringify(byId(t, "boring-tab-inbox").props.children), /Idea Inbox/);
  assert.match(JSON.stringify(byId(t, "boring-tab-feed").props.children), /Standup Feed/);
  const add = byId(t, "boring-overview-new-lane-btn");
  assert.ok(add, "+ New lane");
  assert.match(JSON.stringify(add.props.children), /\+ New lane/);
  assert.match(String(byId(t, "boring-lane-table").props.className), /boring-lane-table/);
});

test("B14b: CSS section is scoped, placed before D4 polish, and has no !important or top-level @keyframes", () => {
  const head = css.indexOf("/* ---- B14b Overview");
  const d4 = css.indexOf("/* --- D4 polish");
  assert.ok(head >= 0, "B14b section header present");
  assert.ok(head < d4, "B14b section sits before the D4 polish marker (never appended at EOF)");
  const section = css.slice(head, d4);
  assert.doesNotMatch(section, /!important/, "no !important in the B14b section");
  assert.doesNotMatch(section, /@keyframes/, "no top-level @keyframes in the B14b section");
  // every rule in the section is scoped under html[data-vibe="boring"] (or inside an @media wrapper whose inner rules are).
  const noComments = section.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const sel of noComments.split("}").map((b) => b.replace(/@media[^{]*\{/g, "").split("{")[0]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)) {
    assert.ok(sel.startsWith('html[data-vibe="boring"]'), `unscoped selector in B14b: ${sel}`);
  }
});

// ── WCAG 2.x contrast: relative luminance + ratio over the token pairs the Overview actually paints. ──
function lum(hex) {
  const c = hex.replace(/^#/, "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
function blockTokens(anchor) {
  const a = css.indexOf(anchor);
  assert.ok(a >= 0, `token anchor not found: ${anchor}`);
  const open = css.lastIndexOf("{", a);
  const close = css.indexOf("}", a);
  const out = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)) out[`--${m[1]}`] = m[2].trim();
  return out;
}
const dark = blockTokens("--surface-0: #121218;");
const light = blockTokens("--surface-0: #f7f6f3;");

test("B14b: WCAG >= 4.5:1 text contrast in dark and light themes (measured)", () => {
  const pairs = [
    ["text-1 on surface-1 (lane name, active tab)", "--text-1", "--surface-1"],
    ["text-2 on surface-1 (cell / status / tab / New lane)", "--text-2", "--surface-1"],
    ["text-3 on surface-1 (lane code, last event)", "--text-3", "--surface-1"],
    ["text-3 on surface-2 (table header labels)", "--text-3", "--surface-2"],
    ["on-accent on st-attn (Needs-you badge)", "--on-accent", "--st-attn"],
  ];
  const report = [];
  for (const [name, tokens] of [["dark", dark], ["light", light]]) {
    for (const [label, fgKey, bgKey] of pairs) {
      const r = ratio(tokens[fgKey], tokens[bgKey]);
      report.push(`${name} ${label}: ${r.toFixed(2)}:1`);
      assert.ok(r >= 4.5, `${name} ${label} ${tokens[fgKey]} on ${tokens[bgKey]} = ${r.toFixed(2)}:1 < 4.5:1`);
    }
  }
  // Surface the measured ratios in the test output for the report.
  process.stdout.write(`B14b contrast ratios:\n  ${report.join("\n  ")}\n`);
});
