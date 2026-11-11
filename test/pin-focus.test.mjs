import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Allow Node to import src/pinFocus.ts and src/pinActions.ts directly by resolving extensionless .ts imports
// and providing lightweight stubs for browser-only .tsx modules.
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(SRC_DIR).href)) {
      if (specifier === "./paseo" || specifier === "./demoFlag" || specifier === "./PinGrid" || specifier === "./ui" || specifier === "./IdeaInbox") {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const tsCandidate = resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(tsCandidate)) {
        return nextResolve(pathToFileURL(tsCandidate).href, context);
      }
      const tsxCandidate = resolve(parentDir, `${specifier}.tsx`);
      if (fs.existsSync(tsxCandidate)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function stubFor(specifier) {
  if (specifier === "./paseo") {
    return [
      "export const DEMO = false;",
      "export const getPaseoState = () => ({ conn: 'connected', agents: new Map() });",
      "export const subscribePaseo = () => () => {};",
      "export const archiveAgent = async () => {};",
      "export const archiveWorkspace = async () => {};",
      "export const detachAgent = async () => {};",
      "export const retireAgent = async () => {};",
      "export const sendMessage = async () => {};",
      "export const updateAgent = async () => {};",
      "export const upsertLocalAgent = () => {};",
    ].join("\n");
  }
  if (specifier === "./demoFlag") return "export const DEMO = false;";
  if (specifier === "./PinGrid") {
    return `export async function openPin(pin, profile) { return globalThis.__testOpenPin(pin, profile); }`;
  }
  if (specifier === "./ui") {
    return `export const derived = () => ({ views: globalThis.__testViews ?? [] }); export const subscribeTree = () => () => {};`;
  }
  if (specifier === "./IdeaInbox") {
    return `export const parkIdeasInInbox = async () => {};`;
  }
  return `export {};`;
}

const pinFocusMod = await import("../src/pinFocus.ts");
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const panesMod = await import("../src/panes.ts");
const pinActionsMod = await import("../src/pinActions.ts");

function makePin(laneId = "bug-chaser", lastProfile = undefined) {
  return {
    squad: { id: "vibesquad", name: "VibeSquad", color: "#00f0ff", lanes: [{ id: laneId, name: "Bug Chaser", ...(lastProfile ? { lastProfile } : {}) }], paths: [] },
    lane: { id: laneId, name: "Bug Chaser", state: "pinned", ...(lastProfile ? { lastProfile } : {}) },
    state: "pinned",
    order: 0,
    brainstorm: null,
    lead: null,
    workers: [],
    needsYou: 0,
    running: 0,
    contextUsed: 0,
    topicBrainstorms: [],
  };
}

const livePin = (laneId, status) => ({
  ...makePin(laneId),
  brainstorm: { agent: { id: `bs-${laneId}`, status, labels: { team: "vibesquad", lane: laneId, role: "brainstorm" } }, kind: "brainstorm", agentType: "brainstorm" },
});

test("focusPin on a dormant pin (no Buddy) does not spawn; it shows the Spin Up picker (gone:true)", async () => {
  const calls = [];
  globalThis.__testOpenPin = async (p) => (calls.push(p.lane.id), "bs-never");
  assert.equal(await pinFocusMod.focusPin(makePin("lane-first-click")), null);
  assert.deepEqual(calls, [], "no spawn on click");
  const f = pinFocusMod.getPinFocus();
  assert.equal(f?.agentId, null);
  assert.equal(f?.gone, true);
  assert.equal(f?.laneId, "lane-first-click");
});

const viewOf = (pin) => ({ team: pin.squad, lanes: [{ lane: pin.lane, brainstorm: pin.brainstorm, lead: null, members: pin.brainstorm ? [pin.brainstorm] : [], topicBrainstorms: [], duplicateBrainstorms: [] }], members: pin.brainstorm ? [pin.brainstorm] : [], needsYou: 0 });

test("focusPin on a closed Buddy opens its history without spawning or resuming, and reconcile keeps gone:true (picker stays); a live Buddy still opens", async () => {
  const calls = [];
  globalThis.__testOpenPin = async (p) => (calls.push(p.lane.id), "bs-reopened");
  const closed = livePin("lane-closed", "closed");
  globalThis.__testViews = [viewOf(closed)];
  assert.equal(await pinFocusMod.focusPin(closed), "bs-lane-closed", "the closed Buddy's history opens");
  assert.deepEqual(calls, []);
  // A panes change runs reconcile() against the views that still carry the closed Buddy.
  panesMod.toggleFocus();
  panesMod.toggleFocus();
  const f = pinFocusMod.getPinFocus();
  assert.equal(f?.laneId, "lane-closed", "pin stays focused");
  assert.equal(f?.agentId, "bs-lane-closed", "reconcile keeps the closed Buddy's history up");
  assert.equal(f?.gone, true, "Spin Up picker stays above the history");
  globalThis.__testViews = [];
  assert.equal(await pinFocusMod.focusPin(livePin("lane-live", "idle")), "bs-lane-live");
  assert.deepEqual(calls, [], "a live Buddy is focused without a start");
});

test("openPin posts brainstorm-restart for a closed Buddy instead of returning its id", async () => {
  let posted = 0;
  const pin = livePin("lane-closed-open", "closed");
  const id = await pinActionsMod.openPin(pin, {
    agents: new Map(),
    fetch: async () => (posted++, { ok: true, json: async () => ({ ok: true, newAgentId: "bs-fresh", agent: { id: "bs-fresh", status: "idle" } }) }),
    onSpawned: () => {},
    saveTeams: async () => {},
  });
  assert.equal(id, "bs-fresh");
  assert.equal(posted, 1);
});

test("spinUpPin(pin, profile) forwards profile to openPin and clears spinUpError on success", async () => {
  const calls = [];
  const pin = makePin("lane-a");
  globalThis.__testOpenPin = async (p, profile) => {
    calls.push({ laneId: p.lane.id, profile });
    const spawnedMember = {
      agent: { id: "bs-spawned-1", status: "idle", labels: { team: p.squad.id, lane: p.lane.id, role: "brainstorm" } },
      kind: "brainstorm",
      agentType: "brainstorm",
      team: p.squad,
      laneId: p.lane.id,
    };
    globalThis.__testViews = [
      {
        team: p.squad,
        lanes: [{ lane: p.lane, brainstorm: spawnedMember, lead: null, members: [spawnedMember], topicBrainstorms: [], duplicateBrainstorms: [] }],
        members: [spawnedMember],
        needsYou: 0,
      },
    ];
    return "bs-spawned-1";
  };
  const id = await pinFocusMod.spinUpPin(pin, "Brainstorm - Gemini");
  assert.equal(id, "bs-spawned-1");
  assert.deepEqual(calls, [{ laneId: "lane-a", profile: "Brainstorm - Gemini" }]);
  assert.equal(pinFocusMod.getPinFocus()?.agentId, "bs-spawned-1");
  assert.equal(pinFocusMod.getPinFocus()?.spinUpError, null);
  assert.equal(pinFocusMod.getSpinUpError(), null);
});

test("spinUpPin sets spinUpError on failure and clears it when changing pins or retrying Spin Up", async () => {
  globalThis.__testOpenPin = async () => {
    throw new Error("Timed out refreshing Claude after 120000ms; pending: version");
  };
  const pinA = makePin("lane-timeout");
  await assert.rejects(
    () => pinFocusMod.spinUpPin(pinA, "Brainstorm - Claude"),
    /Timed out refreshing Claude after 120000ms; pending: version/,
  );

  const focusAfterErr = pinFocusMod.getPinFocus();
  assert.equal(focusAfterErr?.gone, true);
  assert.equal(focusAfterErr?.agentId, null);
  assert.equal(focusAfterErr?.spinUpError, "Timed out refreshing Claude after 120000ms; pending: version");
  assert.equal(pinFocusMod.getSpinUpError(), "Timed out refreshing Claude after 120000ms; pending: version");

  // Switching to another pin clears spinUpError (a pin with a live Buddy just focuses it).
  await pinFocusMod.focusPin(livePin("lane-other", "idle"));
  assert.equal(pinFocusMod.getPinFocus()?.spinUpError, null);
  assert.equal(pinFocusMod.getSpinUpError(), null);
});

test("openPin in pinActions forwards explicit profile as profileName (accepted by remote relay policy)", async () => {
  const posted = [];
  const pin = makePin("lane-remote", "Brainstorm - Claude");
  const id = await pinActionsMod.openPin(pin, {
    profile: "Brainstorm - Gemini",
    agents: new Map(),
    onSpawned: () => {},
    saveTeams: async () => {},
    fetch: async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, newAgentId: "bs-gemini-1", profile: "Brainstorm - Gemini" };
        },
      };
    },
  });

  assert.equal(id, "bs-gemini-1");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "/__vibesquad/brainstorm-restart");
  assert.equal(posted[0].body.profileName, "Brainstorm - Gemini");
  assert.equal("profile" in posted[0].body, false, "profile key must not be sent so remote relay never rejects with 403");

});

test("PinFocusHeader renders profile picker chips and inline spinUpError alert inside .pin-focus-empty", () => {
  const pr = fs.readFileSync(new URL("../src/PinRail.tsx", import.meta.url), "utf8");
  assert.match(pr, /data-testid="pin-spin-up-error"/, "renders inline spinUpError alert");
  assert.match(pr, /className="pin-focus-spinup-error"/, "uses pin-focus-spinup-error class");
  assert.match(pr, /data-testid="pin-spin-up-profile-chips"/, "renders profile picker chips container");
  assert.match(pr, /data-testid=\{`pin-spin-up-profile-chip-\$\{name\}`\}/, "renders each profile chip with testid");
  assert.match(pr, /onStart\(pin,\s*selectedProfile\)/, "Spin Up button passes selectedProfile to onStart");
});

test("sky Spin Up pending: openPin shares one in-flight spawn, isPinStarting is true until it rejects, subscribers are pinged", async () => {
  const pin = makePin("lane-pending");
  let release;
  let fetches = 0;
  const fetch = () => (fetches++, new Promise((res) => (release = () => res({ ok: false, status: 500, json: async () => ({ error: "boom" }) }))));
  let pings = 0;
  const off = pinActionsMod.subscribePinStarts(() => pings++);
  assert.equal(pinActionsMod.isPinStarting(pin), false);
  const a = pinActionsMod.openPin(pin, { fetch, agents: [] });
  const b = pinActionsMod.openPin(pin, { fetch, agents: [] });
  assert.equal(a, b, "double-click shares the promise");
  assert.equal(pinActionsMod.isPinStarting(pin), true);
  await new Promise((r) => setTimeout(r, 0));
  release();
  await assert.rejects(a, /boom/);
  assert.equal(pinActionsMod.isPinStarting(pin), false, "cleared after rejection");
  assert.equal(fetches, 1);
  assert.ok(pings >= 2);
  off();
});
