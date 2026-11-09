// C1/C2 (docs/PLAN_SIDEBAR_CLICKS_1108.md): the team ⋯ menu must survive unrelated scrolls and offer Interrupt All;
// a rail member click on the Squad hub must put that agent in the middle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scrollClosesCtxMenu, hubOpenAgent, focusDrawerOpen } from "../src/ctxMenuLogic.ts";
import { bulkStopTargets } from "../src/paseoAgentOpsLogic.ts";

const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const node = (children = []) => ({ contains: (n) => n === undefined ? false : children.includes(n) });

test("C1: a scroll in an unrelated pane does not close the menu; one that moves its anchor does", () => {
  const anchor = {};
  assert.equal(scrollClosesCtxMenu(node([]), anchor), false, "streaming chat auto-scroll elsewhere");
  assert.equal(scrollClosesCtxMenu(node([anchor]), anchor), true, "the sidebar scrolled under the menu");
  assert.equal(scrollClosesCtxMenu({}, anchor), true, "document / window scroll");
  assert.equal(scrollClosesCtxMenu(node([]), null), true, "no anchor: old behaviour");
});

test("C1: the menu host only closes on scrolls that touch its anchor, and keeps the anchor", () => {
  const cp = src("CommandPalette.tsx");
  assert.match(cp, /scrollClosesCtxMenu\(e\.target, s\.anchor\)/);
  assert.match(cp, /anchor: \(e\.currentTarget as Element \| null\) \?\? null/);
});

test("C1: team ⋯ menu lists Stop All and Interrupt All over the same running targets, via the existing cancel op", () => {
  const cp = src("CommandPalette.tsx");
  const fn = cp.slice(cp.indexOf("export function teamCtxItems"), cp.indexOf("// ---- shortcut cheat sheet"));
  assert.match(fn, /Stop All Running/);
  assert.match(fn, /Interrupt All Running \(\$\{targets\.length\}\)…/);
  assert.match(fn, /Interrupt All Running \(none running\)/);
  assert.match(fn, /verb: "Interrupt"/);
  assert.doesNotMatch(src("paseoAgentOps.ts"), /interrupt-all|runnerInterrupt/);
  const agents = [
    { agent: { id: "a", status: "running" }, teamId: "t" },
    { agent: { id: "b", status: "idle" }, teamId: "t" },
    { agent: { id: "c", status: "running" }, teamId: "u" },
  ];
  assert.deepEqual(bulkStopTargets(agents, { teamId: "t" }).map((a) => a.id), ["a"]);
});

test("C1: the confirm dialog uses the request verb", () => {
  const cp = src("CommandPalette.tsx");
  assert.match(cp, /req\.verb \?\? "Stop"/);
  assert.match(src("paseoAgentOps.ts"), /verb\?: "Stop" \| "Interrupt"/);
});

test("C2: on the hub, a worker/Lead tab opened from the rail takes the middle; Sky bots keep the sky", () => {
  const members = new Set(["riff", "overlord", "squ1"]);
  const zones = ["riff", "overlord"];
  assert.equal(hubOpenAgent("riff", "squ1", members, zones), true, "REPRO: focus stays on RiffBot, active tab is the worker");
  assert.equal(hubOpenAgent("riff", "riff", members, zones), false, "RiffBot row: sky");
  assert.equal(hubOpenAgent("riff", "overlord", members, zones), false, "Overlord is a Sky zone");
  assert.equal(hubOpenAgent("riff", "stranger", members, zones), false, "a tab outside the lane does not take the hub");
  assert.equal(hubOpenAgent(null, null, members, zones), false);
  assert.equal(hubOpenAgent("squ1", null, members, zones), true, "focus itself on a non-zone agent");
});

test("C2: App wires hubAgentOpen through hubOpenAgent with the active tab, and the rail row still uses openPinMember", () => {
  const app = src("App.tsx");
  assert.match(app, /const hubAgentOpen = hubFocused && !!pinFocusView && hubOpenAgent\(pinFocus\?\.agentId, activeAgentId, laneMemberIdsOf\(hubPinNow\), skyZoneIds\(skyZonesFor\(pinFocusView\)\)\);/);
  assert.match(src("PinGrid.tsx"), /onClick=\{\(\) => openPinMember\(pin, m\.agent\.id\)\}/);
});

test("C2 (R2 H): a hub with no RiffBot session (focus.agentId null) still opens the clicked Lead/worker in the middle", () => {
  const members = new Set(["overlord", "squ1"]);
  const zones = ["overlord"];
  assert.equal(hubOpenAgent(null, "squ1", members, zones), true);
  assert.equal(focusDrawerOpen(null, "squ1", members, zones), true, "REPRO: pin-no-drawer / Spin Up panel / compact header all keyed off focus.agentId");
  assert.equal(focusDrawerOpen(null, null, members, zones), false, "nothing open: Spin Up panel stays");
  assert.equal(focusDrawerOpen(null, "overlord", members, zones), false, "Sky bots keep the sky");
  assert.equal(focusDrawerOpen(null, "stranger", members, zones), false, "a tab outside the lane is not the lane's drawer");
  assert.equal(focusDrawerOpen("riff", null, members, zones), true);
  const app = src("App.tsx"), rail = src("PinRail.tsx");
  assert.match(app, /\$\{drawerOpen \? "" : "pin-no-drawer"\}/);
  assert.match(app, /startFresh: pinFocused && !drawerOpen/);
  assert.match(app, /belowBar=\{drawerOpen \? undefined/);
  assert.doesNotMatch(rail, /\{!focus\.agentId (&&|\()/, "PinRail no longer keys the empty panel / name / Starting text off focus.agentId");
  assert.doesNotMatch(rail, /\{active && focus\.agentId &&/);
  assert.match(rail, /\{!drawerOpen && panel\}/);
  assert.match(src("DrawerHeader.tsx"), /const compact = !!pinFocus && shownHere/);
});

test("C2 (R2 M): a rail click on RiffBot / Overlord opens that bot's chat on the hub TVs (HP5 single view)", () => {
  const pf = src("pinFocus.ts"), app = src("App.tsx"), hub = src("HubPages.tsx");
  assert.match(pf, /isHubPin\(pin\) && \(agentId === pin\.brainstorm\?\.agent\.id \|\| agentId === pin\.lead\?\.agent\.id\)/);
  assert.match(app, /const skyReq = useSkyRequest\(\)/);
  assert.match(app, /<SkyZones view=\{pinFocusView\} key=\{skyReq\.n\} initialOpen=\{skyReq\.bot\}/);
  assert.doesNotMatch(hub, /hub-tab|useSkyRequest/, "HP5 HubPages stays the plain single view");
});

test("C1 (R2 L): the confirm dialog says Interrupt in its label, body and error", () => {
  const cp = src("CommandPalette.tsx");
  assert.match(cp, /aria-label=\{isDelete \? "Delete agent" : `\$\{req\.verb \?\? "Stop"\} agents`\}/);
  assert.match(cp, /req\.verb === "Interrupt" \? "Interrupts" : "Stops"/);
  assert.match(cp, /Could not \$\{req\.verb === "Interrupt" \? "interrupt" : "stop"\}/);
});
