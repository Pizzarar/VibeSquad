// Pinned polish: profile id lookup + warned fallback, lane display names, persisted focus, stale focus.
import assert from "node:assert/strict";
import test from "node:test";
import { findProfile, findProfileOrFallback } from "../server/profiles.mjs";

const profiles = [
  { id: "agent_profile_aaa", name: "Brainstorm - Claude", role: "brainstorm" },
  { id: "agent_profile_bbb", name: "Check - Haiku", role: "worker" },
];

test("findProfile matches an exact profile id", () => {
  assert.equal(findProfile("agent_profile_bbb", profiles).name, "Check - Haiku");
  assert.equal(findProfile("Check - Haiku", profiles).id, "agent_profile_bbb");
});

test("unknown profile falls back with a warning naming the fallback", () => {
  const warnings = [];
  const p = findProfileOrFallback("agent_profile_nope", "Brainstorm - Claude", profiles, (m) => warnings.push(m));
  assert.equal(p.name, "Brainstorm - Claude");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /agent_profile_nope.*Brainstorm - Claude/);
});

test("known profile (by id) does not warn", () => {
  const warnings = [];
  const p = findProfileOrFallback("agent_profile_bbb", "Brainstorm - Claude", profiles, (m) => warnings.push(m));
  assert.equal(p.name, "Check - Haiku");
  assert.equal(warnings.length, 0);
});

import { doneShelfKey, loadDoneShelfOpen, loadSavedFocus, planRestore, saveDoneShelfOpen, saveFocus } from "../src/pinFocusLogic.ts";
import { laneDisplayName } from "../src/pins.ts";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

test("laneDisplayName uses the Team name, an alias, or falls back to the id", () => {
  const teams = [{ id: "efi", name: "EFI", lanes: [{ id: "site-polish", name: "Site Polish", aliases: ["site"] }] }];
  assert.equal(laneDisplayName(teams, "site-polish"), "Site Polish");
  assert.equal(laneDisplayName(teams, "SITE"), "Site Polish");
  assert.equal(laneDisplayName(teams, "ui-lab"), "ui-lab");
});

test("focus and Done shelf persist by squad and lane", () => {
  const kv = memory();
  assert.equal(loadSavedFocus(kv), null);
  saveFocus(kv, { squadId: "efi", laneId: "ui-lab" });
  assert.deepEqual(loadSavedFocus(kv), { squadId: "efi", laneId: "ui-lab" });
  saveFocus(kv, null);
  assert.equal(loadSavedFocus(kv), null);
  assert.equal(loadDoneShelfOpen(kv, "efi"), false);
  saveDoneShelfOpen(kv, "efi", true);
  assert.equal(loadDoneShelfOpen(kv, "efi"), true);
  assert.equal(loadDoneShelfOpen(kv, "other"), false);
  saveDoneShelfOpen(kv, "efi", false);
  assert.equal(kv.getItem(doneShelfKey("efi")), null);
});

test("planRestore: stale ?agent= falls back to the pin's Brainstorm, then Start fresh, then the grid", () => {
  const saved = { squadId: "efi", laneId: "ui-lab" };
  // Stale URL agent, pin has a new Brainstorm.
  assert.deepEqual(planRestore({ saved, urlAgent: "dead", urlAgentLive: false, pinBrainstorm: "bs2" }), { kind: "pin", ...saved, agentId: "bs2", closeStale: "dead" });
  // Stale URL agent, pin has none: focus view with Start fresh.
  assert.deepEqual(planRestore({ saved, urlAgent: "dead", urlAgentLive: false, pinBrainstorm: null }), { kind: "pin", ...saved, agentId: null, closeStale: "dead" });
  // Nothing saved: the grid, never an empty rail.
  assert.deepEqual(planRestore({ saved: null, urlAgent: "dead", urlAgentLive: false, pinBrainstorm: undefined }), { kind: "home", closeStale: "dead" });
  // Saved pin was deleted: the grid too.
  assert.deepEqual(planRestore({ saved, urlAgent: "dead", urlAgentLive: false, pinBrainstorm: undefined }), { kind: "home", closeStale: "dead" });
  // Plain reload restores the pin; a live deep link to something else is left alone.
  assert.deepEqual(planRestore({ saved, urlAgent: "bs1", urlAgentLive: true, pinBrainstorm: "bs1" }), { kind: "pin", ...saved, agentId: "bs1", closeStale: null });
  assert.deepEqual(planRestore({ saved, urlAgent: "lead", urlAgentLive: true, pinBrainstorm: "bs1" }), { kind: "none" });
  assert.deepEqual(planRestore({ saved: null, urlAgent: null, urlAgentLive: false, pinBrainstorm: undefined }), { kind: "none" });
});
