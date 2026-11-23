// E1 (docs/PLAN_ANDROID_END_STATE.md Phase 2): the strict phone cockpit's pure rules + structural guarantees of the shell.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PHONE_MAX_WIDTH,
  defaultSurface,
  effectiveSurface,
  getBuddyRequest,
  hostHealthLine,
  isBugsLane,
  isPhoneShell,
  openBuddy,
  phoneBugsSurface,
  phoneLaneRows,
  resetBuddyRequest,
  subscribeBuddyRequest,
} from "../src/phoneCockpitLogic.ts";
import { searchSettings } from "../src/prefs.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("phone shell: Android UA or phone-width viewport, never a desktop browser", () => {
  assert.equal(isPhoneShell(true, 1920), true);
  assert.equal(isPhoneShell(false, 412), true);
  assert.equal(isPhoneShell(false, PHONE_MAX_WIDTH), true);
  assert.equal(isPhoneShell(false, PHONE_MAX_WIDTH + 1), false);
  assert.equal(isPhoneShell(false, 0), false);
});

test("default surface is Overlord only with needs-you items", () => {
  assert.equal(defaultSurface(2), "overlord");
  assert.equal(defaultSurface(0), "riffbot");
  assert.equal(effectiveSurface("buddy", null), "overlord");
  assert.equal(effectiveSurface("buddy", "ui"), "buddy");
  assert.equal(effectiveSurface("riffbot", null), "riffbot");
});

test("host health line", () => {
  assert.deepEqual(hostHealthLine("up"), { text: "Home PC · Online", tone: "ok" });
  assert.equal(hostHealthLine("down").tone, "bad");
  assert.equal(hostHealthLine("unknown").tone, "warn");
});

test("openBuddy(laneId) contract for E2: normalises @, notifies, re-fires on repeat", () => {
  resetBuddyRequest();
  let calls = 0;
  const off = subscribeBuddyRequest(() => calls++);
  openBuddy("@bug");
  assert.equal(getBuddyRequest().laneId, "bug");
  const first = getBuddyRequest().n;
  openBuddy("bug");
  assert.equal(getBuddyRequest().n, first + 1);
  openBuddy("  ");
  assert.equal(getBuddyRequest().n, first + 1);
  assert.equal(calls, 2);
  off();
  resetBuddyRequest();
});

test("App mounts only PhoneCockpit on a phone, before the desktop tree", () => {
  const app = src("App.tsx");
  const gate = app.indexOf("if (phoneShell)");
  assert.ok(gate > 0, "phone gate present");
  assert.ok(app.indexOf("<PhoneCockpit", gate) > gate);
  assert.ok(gate < app.indexOf("<MobileBar />"), "gate precedes the desktop shell");
  assert.ok(gate < app.indexOf('className={`app '), "gate precedes the desktop root");
});

test("cockpit: three surfaces, no escape hatch, slots and restart wiring", () => {
  const c = src("PhoneCockpit.tsx");
  for (const id of ["phone-tab-", "phone-back-overlord", "phone-squad-pill", "phone-bug-slot", "phone-pair-slot", "phone-health-line"]) assert.ok(c.includes(id), id);
  assert.match(c, /← Back to Overlord/);
  assert.match(c, /\{bugSlot\}/);
  assert.match(c, /\{pairSlot\}/);
  assert.match(c, /\/__vibesquad\/restart-runner/);
  assert.match(c, /TODO\(PLAN_V03_STABILIZE R1\)/);
  assert.doesNotMatch(c, /Desktop view|setFullView|MobileBar|SidebarTree/);
  assert.doesNotMatch(c, /BugButton/);
});

test("css defines the cockpit shell", () => {
  const css = src("styles.css");
  for (const cls of [".phone-cockpit", ".phone-tabs", ".phone-drawer", ".phone-back-pill"]) assert.ok(css.includes(cls), cls);
});

test("drawer lane list: a no-agent pinned lane from `vs pin new` appears (state none); removed/done and live Buddies handled", () => {
  const mk = (lane, brainstorm = null) => ({ lane, members: [], brainstorm, lead: null, topicBrainstorms: [], duplicateBrainstorms: [] });
  const buddy = (status) => ({ agent: { id: "a1", status }, kind: "brainstorm" });
  const lanes = [
    { id: "boring-mode", name: "Boring Mode", state: "pinned", code: "Bor" },
    { id: "live-one", name: "Live One", state: "pinned" },
    { id: "idle-one", name: "Idle One", state: "pinned" },
    { id: "gone", name: "Gone", state: "removed" },
  ];
  const view = {
    team: { id: "s", name: "S", color: "#fff", paths: [], lanes },
    lanes: [mk(lanes[0]), mk(lanes[1], buddy("running")), mk(lanes[2], buddy("idle")), mk(lanes[3])],
  };
  const rows = phoneLaneRows(view);
  assert.deepEqual(rows.map((r) => [r.laneId, r.state]), [["boring-mode", "none"], ["live-one", "live"], ["idle-one", "idle"]]);
  assert.deepEqual(phoneLaneRows(undefined), []);
});

test("PhoneCockpit drawer renders the lane list and wires tap to openBuddy / onSpinUp", () => {
  const s = src("PhoneCockpit.tsx");
  assert.ok(s.includes("phoneLaneRows(view)") && s.includes("phone-lane-"));
  assert.ok(/state === "none"\) onSpinUp\(r\.pin(?:,\s*[^)]+)?\);\s*openBuddy\(r\.laneId\)/.test(s));
});

test("E1c: Phone Cockpit Settings, Psycho/Corpo toggle, Claude/Gemini switcher & corpo settings search", () => {
  const app = src("App.tsx");
  const gate = app.indexOf("if (phoneShell)");
  const endGate = app.indexOf('if (vibe === "boring")', gate);
  const phoneBlock = app.slice(gate, endGate);
  assert.ok(phoneBlock.includes("onSettings={openSettings}"), "App passes onSettings={openSettings} to PhoneCockpit");
  assert.ok(phoneBlock.includes("{overlays}"), "App mounts {overlays} inside phoneShell");

  const c = src("PhoneCockpit.tsx");
  for (const id of [
    "phone-provider-toggle",
    "phone-provider-claude",
    "phone-provider-gemini",
    "phone-settings-btn",
    "phone-provider-bar",
    "phone-active-provider",
    "phone-switch-provider-btn",
  ]) {
    assert.ok(c.includes(id), `PhoneCockpit includes ${id}`);
  }
  assert.doesNotMatch(c, /phone-vibe|Corpo/); // B9: vibe toggle moved to Settings > About (Legacy: Psycho mode)
  assert.match(c, /⚙ Settings/);
  assert.match(c, /oppositeProviderTarget/);
  assert.match(c, /triggerBrainstormRestart/);

  const hits = searchSettings("corpo");
  assert.ok(hits.some((h) => h.id === "legacy-psycho"), "searchSettings('corpo') finds Legacy: Psycho mode");
});

test("E1b: top safe-area inset applied once on the cockpit (App's .app padding is not mounted in the phone shell)", () => {
  const tsx = src("PhoneCockpit.tsx");
  assert.ok(tsx.includes('data-android={isAndroidUserAgent() ? "true" : undefined}'));
  const css = src("styles.css");
  assert.ok(css.includes("--phone-safe-top: env(safe-area-inset-top, 0px);"));
  assert.ok(css.includes('.phone-cockpit[data-android="true"] { --phone-safe-top: max(env(safe-area-inset-top, 0px), 28px); }'));
  assert.ok(css.includes("padding: calc(8px + var(--phone-safe-top, 0px)) 10px 8px;"));
  const menu = css.slice(css.indexOf(".phone-squad-menu, .phone-drawer {"));
  assert.ok(menu.slice(0, 120).includes("top: calc(58px + var(--phone-safe-top, 0px));"));
  const sheet = css.slice(css.indexOf(".phone-bug-sheet {"), css.indexOf(".phone-bug-sheet .btn"));
  assert.ok(sheet.includes("calc(12px + env(safe-area-inset-bottom, 0px))"));
  // phone shell returns before the .app wrapper, so .app's own inset cannot double up
  const app = src("App.tsx");
  assert.ok(app.indexOf("if (phoneShell) {") < app.indexOf('className={`app '));
});

// idea-463 (Trinity audit HIGH #3): Bugs is a permanent Trinity tab, separate from feature lanes.
const trinityView = ({ bugsBrainstorm = null, bugsLead = null, bugsLane = true, members = [] } = {}) => {
  const lanes = [
    { id: "vibesquad", name: "RiffBot", hub: true, state: "pinned" },
    { id: "android-app", name: "Android App", state: "pinned" },
    ...(bugsLane ? [{ id: "bug-chaser", name: "Bug Chaser", standing: true, hidden: false, state: "pinned", aliases: ["bugs-old"] }] : []),
  ];
  const team = { id: "vibesquad", name: "VibeSquad", color: "#fff", paths: [], lanes };
  const lv = (lane, brainstorm = null, lead = null, ms = []) => ({ lane, members: ms, brainstorm, lead, duplicateLeads: [], topicBrainstorms: [], duplicateBrainstorms: [] });
  return {
    team,
    members,
    lanes: [lv(lanes[0]), lv(lanes[1]), ...(bugsLane ? [lv(lanes[2], bugsBrainstorm, bugsLead, members)] : [])],
  };
};
const bugsMember = (id, kind, extra = {}) => ({
  agent: { id, title: `${kind} · Bugs`, status: "idle", provider: "claude", labels: { team: "vibesquad", lane: "bug-chaser", role: kind }, ...extra.agent },
  laneId: "bug-chaser",
  kind,
  agentType: kind,
  attention: extra.attention ?? null,
});

test("idea-463 phoneBugsSurface: live Buddy preferred over lead, dormant lane, no lane, needs-you count", () => {
  const bs = bugsMember("bs-bug", "brainstorm", { agent: { status: "running" } });
  const lead = bugsMember("lead-bug", "lead", { agent: { status: "running" } });
  const live = phoneBugsSurface(trinityView({ bugsBrainstorm: bs, bugsLead: lead, members: [bs, lead] }));
  assert.equal(live.laneId, "bug-chaser");
  assert.equal(live.member?.agent.id, "bs-bug");

  const leadOnly = phoneBugsSurface(trinityView({ bugsLead: lead, members: [lead] }));
  assert.equal(leadOnly.member?.agent.id, "lead-bug");

  const dormant = phoneBugsSurface(trinityView());
  assert.equal(dormant.laneId, "bug-chaser");
  assert.ok(dormant.pin, "dormant Bugs lane still resolves a pin so the tab can offer Start Bugs");
  assert.equal(dormant.member, null);
  assert.equal(dormant.needsYou, 0);

  const none = phoneBugsSurface(trinityView({ bugsLane: false }));
  assert.deepEqual([none.laneId, none.pin, none.member, none.needsYou], [null, null, null, 0]);
  assert.equal(phoneBugsSurface(undefined).laneId, null);

  const asking = bugsMember("bs-ask", "brainstorm", {
    agent: { labels: { team: "vibesquad", lane: "bug-chaser", role: "brainstorm", "needs-you": "triage", "needs-you-reason": "check repro" } },
    attention: { tone: "needs-you", reason: "check repro" },
  });
  assert.ok(phoneBugsSurface(trinityView({ bugsBrainstorm: asking, members: [asking] })).needsYou >= 1);
});

test("idea-463 isBugsLane: id or alias, case-insensitive, @ tolerated; never matches without a Bugs lane", () => {
  const bugs = { laneId: "bug-chaser", aliases: ["bugs-old"] };
  assert.equal(isBugsLane(bugs, "bug-chaser"), true);
  assert.equal(isBugsLane(bugs, "@Bug-Chaser"), true);
  assert.equal(isBugsLane(bugs, "BUGS-OLD"), true);
  assert.equal(isBugsLane(bugs, "android-app"), false);
  assert.equal(isBugsLane({ laneId: null, aliases: [] }, "bug-chaser"), false);
});

test("idea-463 drawer TEAMS excludes the Bugs lane (Trinity, not a feature lane); bugs is always a valid surface", () => {
  const rows = phoneLaneRows(trinityView());
  assert.ok(!rows.some((r) => r.laneId === "bug-chaser"), "Bugs lane not in feature lane rows");
  assert.ok(rows.some((r) => r.laneId === "android-app"));
  assert.equal(effectiveSurface("bugs", null), "bugs");
});

test("idea-463 PhoneCockpit: Bugs tab after RiffBot, openBuddy(bugsLane) routes to bugs, provider bar + Log Bug pill kept", () => {
  const c = src("PhoneCockpit.tsx");
  assert.ok(c.includes("phoneBugsSurface(view)"));
  const nav = c.slice(c.indexOf('<nav className="phone-tabs"'));
  const iRiff = nav.indexOf('tab("riffbot"');
  const iBugs = nav.indexOf('tab("bugs", SURFACE_LABEL.bugs, bugs.needsYou)');
  const iBuddy = nav.indexOf('tab("buddy"');
  assert.ok(iRiff > 0 && iBugs > iRiff && iBuddy > iBugs, "Overlord | RiffBot | Bugs | @lane order");
  assert.match(c, /if \(isBugsLane\(bugs, req\.laneId\)\) \{\s*setSurface\("bugs"\);/);
  assert.match(c, /shown === "bugs" \? bugs\.member/);
  assert.match(c, /Start Bugs/);
  assert.match(c, /\{bugSlot\}/);
  const css = src("styles.css");
  assert.ok(css.includes(".phone-tab-label") && /\.phone-tab \{[^}]*min-width: 0;[^}]*white-space: nowrap;/.test(css), "4 tabs fit narrow phones");
});
