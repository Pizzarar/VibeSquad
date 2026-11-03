import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { escGoesHome, reconcilePinFocus } from "../src/pinFocusLogic.ts";

const shown = (agentId) => ({ agentId, gone: false, held: null });

test("focus stays while the pin's Brainstorm is the active tab", () => {
  assert.deepEqual(reconcilePinFocus(shown("a"), "a", "a"), { kind: "keep" });
});

test("restart in the drawer (openAgentInTab successor) follows the new Brainstorm", () => {
  // The successor already replaced the tab: follow without reopening.
  assert.deepEqual(reconcilePinFocus(shown("a"), "b", "b"), { kind: "follow", agentId: "b", open: false });
  // A successor that appeared elsewhere (another tab, the lead): follow and open it.
  assert.deepEqual(reconcilePinFocus(shown("a"), "b", "a"), { kind: "follow", agentId: "b", open: true });
});

test("retired / archived / auto-retired Brainstorm keeps the pin focused as gone", () => {
  assert.deepEqual(reconcilePinFocus(shown("a"), null, "a"), { kind: "gone" });
  // Already gone: no churn.
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, null, "a"), { kind: "keep" });
});

test("while gone or starting, opening another agent exits instead of hiding it", () => {
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, null, "lead-1"), { kind: "exit" });
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: false, held: null }, null, "lead-1"), { kind: "exit" });
});

test("a gone pin picks up a fresh Brainstorm when one appears", () => {
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, "c", "a"), { kind: "follow", agentId: "c", open: true });
});

test("a quick start in flight is left alone", () => {
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: false, held: "a" }, null, "a"), { kind: "keep" });
});

test("opening an unrelated agent over the focused drawer exits", () => {
  assert.deepEqual(reconcilePinFocus(shown("a"), "a", "lead-1"), { kind: "exit" });
});

test("Esc goes home only with an empty composer, outside modals, permission cards and other fields", () => {
  const base = { inModal: false, inPerm: false, target: "none", draft: "" };
  assert.equal(escGoesHome(base), true);
  assert.equal(escGoesHome({ ...base, target: "composer" }), true);
  assert.equal(escGoesHome({ ...base, draft: "half a thought" }), false);
  assert.equal(escGoesHome({ ...base, target: "composer", draft: "  hi " }), false);
  assert.equal(escGoesHome({ ...base, draft: "   " }), true);
  assert.equal(escGoesHome({ ...base, inPerm: true }), false);
  assert.equal(escGoesHome({ ...base, target: "field" }), false);
  assert.equal(escGoesHome({ ...base, inModal: true }), false);
});

test("focusPin does not call openPin when pin.brainstorm is null; spinUpPin handles explicit Spin Up", () => {
  const pf = fs.readFileSync(new URL("../src/pinFocus.ts", import.meta.url), "utf8");
  const focusPinMatch = pf.match(/export async function focusPin\b[\s\S]*?\n\}/);
  assert.ok(focusPinMatch, "focusPin exists");
  assert.doesNotMatch(focusPinMatch[0], /\bopenPin\s*\(/, "focusPin must never auto-spawn via openPin");
  assert.match(focusPinMatch[0], /gone:\s*!live/, "focusPin sets gone: !live so the Spin Up panel renders immediately");

  const spinUpMatch = pf.match(/export async function spinUpPin\b[\s\S]*?\n\}/);
  assert.ok(spinUpMatch, "spinUpPin exists");
  assert.match(spinUpMatch[0], /\bawait openPin\(pin\)/, "spinUpPin calls openPin when user clicks Spin Up");
});

test("closed agents are never woken by usePreview, hidden panes, Composer, SubagentList, or auto-150k restart", () => {
  const pg = fs.readFileSync(new URL("../src/PinGrid.tsx", import.meta.url), "utf8");
  assert.match(pg, /if \(agent\?\.status === "closed"\)/, "usePreview skips refetch/subscribe when agent is closed");
  assert.match(pg, /usePreview\(bs && bs\.agent\.status !== "closed" \? bs\.agent\.id : null\)/, "PinTile does not pass closed agentId to usePreview");

  const pr = fs.readFileSync(new URL("../src/PinRail.tsx", import.meta.url), "utf8");
  assert.match(pr, /usePreview\(bs && bs\.agent\.status !== "closed" \? bs\.agent\.id : null\)/, "RailTile does not pass closed agentId to usePreview");
  assert.doesNotMatch(pr, /const clickable = !focused;/, "RailTile is only for the other Buddies now (no inert focused tile)");
  assert.match(pr, /Spin Up RiffBot/, "PinFocusHeader shows Spin Up RiffBot button");
  assert.match(pr, /Spin Up Brainstorm/, "PinFocusHeader shows Spin Up Brainstorm button");

  const ap = fs.readFileSync(new URL("../src/AgentPanes.tsx", import.meta.url), "utf8");
  assert.match(ap, /if \(!everShown\)/, "DrawerSlot defers mounting AgentDrawer until the tab is actually shown");

  const comp = fs.readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
  assert.match(comp, /if \(DEMO \|\| agent\.status === "closed"\) return;/, "Composer skips listCommands on closed agents");

  const sub = fs.readFileSync(new URL("../src/SubagentList.tsx", import.meta.url), "utf8");
  assert.match(sub, /if \(parentStatus === "closed"\) return;/, "SubagentList skips listSubagents when parent is closed");

  const ad = fs.readFileSync(new URL("../src/AgentDrawer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ad, /auto-150k/, "AgentDrawer does not auto-restart Brainstorm at 150k tokens");

  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\{\(withPanes \|\| pinFocused\) && \(/, "App only mounts AgentPanes when withPanes or pinFocused");
  assert.match(app, /onStart=\{onSpinUpPin\}/, "PinFocusHeader onStart is wired to onSpinUpPin");
});

test("PinRail: active Buddy card on top, other Buddies below, no inert 'Open in the middle' tile", () => {
  const pr = fs.readFileSync(new URL("../src/PinRail.tsx", import.meta.url), "utf8");
  const dh = fs.readFileSync(new URL("../src/DrawerHeader.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(pr, /Open in the middle/);
  const card = pr.indexOf('className={`pin-rail-active-buddy');
  const label = pr.indexOf("Other Buddies");
  const list = pr.indexOf("others.map(");
  assert.ok(card > 0 && card < label && label < list, "active card, then 'Other Buddies' label, then the remaining pins");
  assert.match(pr, /pinned\.filter\(\(p\) => p\.lane\.id !== focus\.laneId\)/, "the focused pin is excluded from the tile list");
  assert.match(pr, /ref=\{slotRef\("card"\)\}/, "the card hosts the inspector slot");
  assert.match(pr, /ref=\{slotRef\("bar"\)\}/, "the single bar hosts the compact controls slot");
  assert.match(dh, /createPortal\(/, "DrawerHeader portals the compact bar + inspector in pin-focus");
  assert.match(dh, /const compact = !!pinFocus && shownHere && inLane/, "only the shown lane drawer (Buddy, Lead, worker, topic) goes compact");
  assert.match(dh, /shownHere = usePanes\(\)\.leftActiveId === agent\.id/, "a single owner of the slots: the left active tab");
});

test("pin-focus hides the RiffBot HubBar while a chat drawer is open", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /belowBar=\{pinFocus\.agentId \? undefined : <HubBar/);
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.pin-rail \.signal\.running,[\s\S]*?\.pane-tab \.signal\.running \{\s*animation: none;/);
});

test("opening the pin's Lead / worker / topic Buddy keeps the focus", () => {
  const lane = new Set(["a", "lead-1", "w-1", "t-1"]);
  for (const id of ["lead-1", "w-1", "t-1"]) assert.deepEqual(reconcilePinFocus(shown("a"), "a", id, lane), { kind: "keep" });
  // An agent outside the lane still exits.
  assert.deepEqual(reconcilePinFocus(shown("a"), "a", "other", lane), { kind: "exit" });
  // Without lane ids the old behaviour holds.
  assert.deepEqual(reconcilePinFocus(shown("a"), "a", "lead-1"), { kind: "exit" });
});

test("a gone / starting pin stays focused while a lane member is open", () => {
  const lane = new Set(["lead-1"]);
  assert.deepEqual(reconcilePinFocus({ agentId: null, gone: true, held: "a" }, null, "lead-1", lane), { kind: "keep" });
});

test("a restarted Brainstorm is followed without pulling the user off the Lead", () => {
  const lane = new Set(["a", "b", "lead-1"]);
  assert.deepEqual(reconcilePinFocus(shown("a"), "b", "lead-1", lane), { kind: "follow", agentId: "b", open: false });
});
