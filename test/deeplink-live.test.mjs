import "./helpers/clean-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// R5-1 (docs/UX_REVIEW_R5.md): a ?agent= deep link must land on its agent on the live runner, where the stream opens
// before the first roster snapshot. Real src/paseo.ts + src/runnerBridge.ts + src/panes.ts (not ?demo); EventSource,
// fetch, location and localStorage are faked. The snapshot (with the linked agent) arrives ~1s after the stream opens.
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(SRC_DIR).href)) {
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const bare = specifier.replace(/\.tsx?$/, "");
      if (fs.existsSync(resolve(parentDir, `${bare}.tsx`))) return { url: `data:text/javascript,${encodeURIComponent(stubFor(bare))}`, shortCircuit: true };
      const ts = resolve(parentDir, `${bare}.ts`);
      if (fs.existsSync(ts)) return nextResolve(pathToFileURL(ts).href, context);
    }
    return nextResolve(specifier, context);
  },
});
function stubFor(specifier) {
  if (specifier === "./demo") return "export const demoAgents = () => new Map(); export const demoArchived = () => new Map(); export const demoProviderUsage = () => ({}); export const demoWorkspaces = () => new Map();";
  return "export {};";
}

const store = new Map([
  ["vs.prefs.v1", JSON.stringify({ "app.restoreLastView": true, "app.vibe": "boring" })],
  // Last session: a tab whose agent is gone since.
  ["vs.panes.v1", JSON.stringify({ leftTabs: ["rn-gone"], rightTabs: [], leftActiveId: "rn-gone", rightActiveId: null, split: false, activePane: "left" })],
]);
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
globalThis.location = { search: "?agent=rn-deep", pathname: "/", hash: "" };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
globalThis.document = { hidden: false, addEventListener() {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
const streams = [];
globalThis.EventSource = class {
  constructor(url) { this.url = url; this.readyState = 0; streams.push(this); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
};
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes("/status") ? { enabled: true, lanes: [] } : {}) });
// paseo.ts batches store notifications to the next frame.
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
const frame = () => new Promise((r) => setTimeout(r, 20));

// paseo.ts / teams.ts poll on intervals that never stop; unref them so the test process can exit.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => {
  const t = realSetInterval(...a);
  t.unref?.();
  return t;
};

const paseo = await import("../src/paseo.ts");
const panes = await import("../src/panes.ts");

/** useRestorePrune (src/QuickWinsUi.tsx) without React: once rosterLoaded, prune restored tabs against the roster. */
function watchRestorePrune() {
  const log = [];
  let done = false;
  const run = () => {
    const st = paseo.getPaseoState();
    if (done || !st.rosterLoaded) return;
    done = true;
    log.push([...st.agents.keys()]);
    panes.pruneRestoredTabs((id) => {
      const a = st.agents.get(id);
      return !!a && !a.archivedAt;
    });
  };
  paseo.subscribePaseo(run);
  run();
  return log;
}

const agent = (id, extra = {}) => ({ id, provider: "claude", status: "idle", title: id, labels: {}, cwd: "/x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra });

test("R5-1: a deep link to an agent that arrives 1s after connect lands on that agent", async () => {
  // App's startup deep-link effect (src/App.tsx) opens ?agent= before the runner stream is up.
  panes.openAgent(new URLSearchParams(location.search).get("agent"));
  const pruned = watchRestorePrune();
  assert.equal(panes.getPanes().leftActiveId, "rn-deep", "the ?agent= tab is active from the first frame");
  for (let i = 0; i < 50 && !streams.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(streams.length, 1, "the runner bridge opened its stream");

  streams[0].open();
  await frame();
  const up = paseo.getPaseoState();
  assert.equal(up.conn, "connected");
  assert.equal(up.rosterLoaded, false, "connected is not loaded: no agent snapshot yet");
  assert.equal(pruned.length, 0, "no prune against an empty map");
  assert.equal(panes.getPanes().leftActiveId, "rn-deep");

  await new Promise((r) => setTimeout(r, 1000));
  streams[0].msg({ kind: "roster", agents: [agent("rn-deep"), agent("rn-other")] });
  await frame();
  const st = paseo.getPaseoState();
  assert.equal(st.rosterLoaded, true, "loaded once the first snapshot is applied");
  assert.ok(st.agents.has("rn-deep"));
  assert.equal(pruned.length, 1, "prune ran once, after the snapshot");
  assert.ok(pruned[0].includes("rn-deep"), "and saw the linked agent");
  const p = panes.getPanes();
  assert.equal(p.leftActiveId, "rn-deep", "landed on the deep-linked agent");
  assert.deepEqual(p.leftTabs, ["rn-deep"], "the gone restored tab was pruned, the linked one kept");
});

test("R5-1: the prune never drops the URL tab, even when its agent is not in the roster yet", () => {
  // The prune predicate says everything is gone; only storage-restored tabs may go.
  panes.openAgent("rn-other", "background");
  panes.pruneRestoredTabs(() => false);
  const p = panes.getPanes();
  assert.ok(p.leftTabs.includes("rn-deep"), "the ?agent= tab survives");
  assert.ok(p.leftTabs.includes("rn-other"), "a tab opened this session survives");
  assert.equal(p.leftActiveId, "rn-deep");
});

test("R5-4: in Normal an explicit ?team= with no ?agent= beats the saved pane, and the prune never promotes a leftover tab", async () => {
  store.set("vs.panes.v1", JSON.stringify({ leftTabs: ["rn-art", "rn-gone"], rightTabs: [], leftActiveId: "rn-art", rightActiveId: null, split: false, activePane: "left" }));
  globalThis.location = { search: "?team=efi", pathname: "/", hash: "" };
  const fresh = await import("../src/panes.ts?r54-team");
  let p = fresh.getPanes();
  assert.equal(p.leftActiveId, null, "the saved agent is not shown");
  assert.deepEqual(p.leftTabs, ["rn-art", "rn-gone"], "the saved tabs stay");
  fresh.pruneRestoredTabs((id) => id !== "rn-gone");
  p = fresh.getPanes();
  assert.deepEqual(p.leftTabs, ["rn-art"]);
  assert.equal(p.leftActiveId, null, "still the project's Overview");

  // Psycho keeps its saved pane (its URL always carries team=).
  const prefs = await import("../src/prefs.ts");
  prefs.setPref("app.vibe", "fun");
  store.set("vs.panes.v1", JSON.stringify({ leftTabs: ["rn-art"], rightTabs: [], leftActiveId: "rn-art", rightActiveId: null, split: false, activePane: "left" }));
  assert.equal((await import("../src/panes.ts?r54-fun")).getPanes().leftActiveId, "rn-art");

  // A deep link still wins over both.
  prefs.setPref("app.vibe", "boring");
  globalThis.location = { search: "?team=efi&agent=rn-deep", pathname: "/", hash: "" };
  assert.ok((await import("../src/panes.ts?r54-link")).getPanes().leftTabs.includes("rn-deep"));
});

// R5-4 review (M1/M2/L1): Normal's ?agent= is the agent on screen, and an explicit ?team= lands on that project's Overview.
const logic = await import("../src/pinFocusLogic.ts");

test("R5-4 M1: every way back to Overview / usage drops ?agent= (mode leaves chat; the pane tab stays)", () => {
  // Agent on screen, then the active project's row / project crumb / drawer close / usage: mode !== "chat".
  const on = { rosterLoaded: true, landingPending: false, activeAgentId: "rn-lead" };
  assert.equal(logic.boringUrlAgent({ ...on, shownAgentId: "rn-lead" }), "rn-lead");
  assert.equal(logic.boringUrlAgent({ ...on, shownAgentId: null }), null, "Overview keeps team= only, though the tab is still active");
  // Re-opening the same agent from its row names it again.
  assert.equal(logic.boringUrlAgent({ ...on, shownAgentId: "rn-lead" }), "rn-lead");
});

test("R5-4 L1: the URL names the agent shown, not the pane's active tab", () => {
  const shown = (activeAgentId, shownAgentId) => logic.boringUrlAgent({ rosterLoaded: true, landingPending: false, activeAgentId, shownAgentId });
  assert.equal(shown("rn-old-tab", "rn-lane-buddy"), "rn-lane-buddy", "resolvePinChatAgentId picked the lane's Buddy");
  assert.equal(shown(null, "rn-riffbot"), "rn-riffbot", "hub fallback with no tab");
  assert.equal(shown("rn-old-tab", null), null, "an empty lane card shows no agent");
});

test("R5-4: a deep link keeps ?agent= before the roster and while its landing is pending (no strip-then-restore)", () => {
  assert.equal(logic.boringUrlAgent({ rosterLoaded: false, landingPending: false, activeAgentId: "rn-deep", shownAgentId: null }), "rn-deep");
  assert.equal(logic.boringUrlAgent({ rosterLoaded: true, landingPending: true, activeAgentId: "rn-deep", shownAgentId: null }), "rn-deep");
  assert.equal(logic.boringUrlAgent({ rosterLoaded: false, landingPending: false, activeAgentId: null, shownAgentId: null }), null, "?team= alone stays agent-less");
});

test("R5-4 M2: an explicit ?team= with no ?agent= drops the saved pin in Normal, even for the same squad", () => {
  const saved = { squadId: "efi", laneId: "art" };
  const pick = (url) => logic.savedFocusForUrl(saved, url);
  assert.equal(pick({ team: "efi", agent: null, normal: true }), null, "Normal: same squad → that project's Overview");
  assert.equal(pick({ team: "other", agent: null, normal: true }), null);
  assert.equal(pick({ team: "efi", agent: "rn-deep", normal: true }), saved, "?agent= still plans the restore");
  assert.equal(pick({ team: null, agent: null, normal: true }), saved, "a bare reload restores the pin");
  // Psycho unchanged: its URL always carries team=, so only another squad's pin yields.
  assert.equal(pick({ team: "efi", agent: null, normal: false }), saved);
  assert.equal(pick({ team: "other", agent: null, normal: false }), null);
  assert.equal(logic.savedFocusForUrl(null, { team: "efi", agent: null, normal: true }), null);
});

test("R5-4 wiring: App's Normal URL reads BoringApp's shown agent; pinFocus restore goes through savedFocusForUrl", () => {
  const read = (f) => fs.readFileSync(resolve(SRC_DIR, f), "utf8");
  const app = read("App.tsx");
  assert.match(app, /vibe === "boring" \? \(boringShown === undefined \? activeAgentId : boringShown\)/);
  const ade = read("BoringAde.tsx");
  assert.match(ade, /shownAgentId: mode === "chat" && agent \? agent\.id : null/);
  assert.match(ade, /setBoringShownAgent\(urlAgent\)/);
  assert.doesNotMatch(ade, /leaveHome/, "no one-way home flag: the URL follows the screen");
  assert.match(read("pinFocus.ts"), /savedFocusForUrl\(savedFocus, \{ team: initialUrlTeam, agent: initialUrlAgent, normal: getPref\("app\.vibe"\) === "boring" \}\)/);
});
