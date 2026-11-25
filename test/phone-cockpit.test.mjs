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
  pickLiveRestart,
  hostRestartKey,
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
  assert.doesNotMatch(c, /TODO\(PLAN_V03_STABILIZE R1\)/, "H2 replaced the runner-only stopgap");
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

test("idea-838: phone shell has a Storybook entry gated by the known-missing probe, opens via openStorybook, Back returns to cockpit", () => {
  const c = src("PhoneCockpit.tsx");
  assert.ok(c.includes('import { openStorybook, useStorybookMissing } from "./StorybookView";'), "imports openStorybook + useStorybookMissing");
  assert.ok(c.includes("phone-storybook-btn"), "entry present");
  assert.match(c, /const sbMissing = useStorybookMissing\(view\?\.team\.id \?\? null\)/, "probe read through the subscribe/notify hook so a resolved probe re-renders");
  assert.match(c, /\{view && !sbMissing && \(/, "entry hidden when the probe reports no Storybook");
  assert.match(c, /openStorybook\(view\.team\.id, view\.team\.name\)/, "entry opens the current project's Storybook");
  // Storybook takeover must precede the phone-shell gate so a phone user actually sees the view (and its ← Back closes it).
  const app = src("App.tsx");
  const sbGate = app.indexOf("storybookOpen && deviceRole");
  const phoneGate = app.indexOf("if (phoneShell)");
  assert.ok(sbGate > 0 && sbGate < phoneGate, "StorybookHost branch precedes the phone shell, so Back returns to the cockpit");
});

test("idea-838 m2: Storybook entry names the project like the desktop item, project name ellipsized when long", () => {
  const c = src("PhoneCockpit.tsx");
  assert.match(c, /<span className="phone-storybook-label">Open Storybook · <\/span>/);
  assert.match(c, /<span className="phone-storybook-name">\{view\.team\.name\}<\/span>/);
  const css = src("styles.css");
  for (const cls of [".phone-storybook-btn", ".phone-storybook-label", ".phone-storybook-name"]) assert.ok(css.includes(cls), cls);
  assert.match(css, /\.phone-storybook-name \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
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

test("H1: hostHealthLine takes a real host label and restart states", () => {
  assert.deepEqual(hostHealthLine("up", "brimble-pc"), { text: "brimble-pc · Online", tone: "ok" });
  assert.equal(hostHealthLine("up", undefined, "queued").text, "Home PC · Restart queued");
  assert.equal(hostHealthLine("up", "pc", "draining").text, "pc · Draining for restart…");
  assert.equal(hostHealthLine("down", "pc", "firing").text, "pc · Restarting host…");
  assert.equal(hostHealthLine("down", "pc", "done").text, "pc · Offline");
  assert.equal(hostHealthLine("up", "pc", null).tone, "ok");
});

test("H1: getAuthStatus carries hostLabel, headless and restartRequest (summary when open; null when absent/terminal/corrupt)", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "vs-h1-"));
  const file = join(home, "restart-request.json");
  const writeCurrent = (current) => writeFileSync(file, JSON.stringify({ version: 1, current, history: [] }), "utf8");
  const prev = { h: process.env.VIBESQUAD_HOME, l: process.env.VIBESQUAD_HOST_LABEL, hl: process.env.VIBESQUAD_HEADLESS };
  process.env.VIBESQUAD_HOME = home;
  process.env.VIBESQUAD_HOST_LABEL = "test-box";
  process.env.VIBESQUAD_HEADLESS = "1";
  try {
    const auth = await import("../server/auth.mjs");
    const st = auth.getAuthStatus();
    assert.equal(st.hostLabel, "test-box");
    assert.equal(st.headless, true);
    assert.equal(st.restartRequest, null, "no file -> null");

    writeCurrent({ id: "rr-q", state: "queued", tip: "abc1234", windowAt: "2026-11-25T13:00:00.000Z", deadline: "2026-11-25T13:30:00.000Z" });
    assert.deepEqual(auth.getAuthStatus().restartRequest, { id: "rr-q", state: "queued", windowAt: "2026-11-25T13:00:00.000Z", deadlineAt: "2026-11-25T13:30:00.000Z", summary: "queued · abc1234" });
    writeCurrent({ id: "rr-d", state: "draining", tip: "def5678", deadline: "2026-11-24T23:30:00.000Z" });
    assert.deepEqual(auth.getAuthStatus().restartRequest, { id: "rr-d", state: "draining", windowAt: null, deadlineAt: "2026-11-24T23:30:00.000Z", summary: "draining · def5678" });

    for (const state of ["done", "aborted"]) {
      writeCurrent({ id: `rr-${state}`, state, tip: "abc1234" });
      assert.equal(auth.getAuthStatus().restartRequest, null, `${state} (terminal) -> null`);
    }
    writeCurrent({ id: "rr-bad", state: 7, tip: "abc1234" });
    assert.equal(auth.getAuthStatus().restartRequest, null, "non-string state -> null");
    writeFileSync(file, "{not json", "utf8");
    assert.equal(auth.getAuthStatus().restartRequest, null, "corrupt file -> null");
  } finally {
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_HOST_LABEL", prev.l], ["VIBESQUAD_HEADLESS", prev.hl]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

test("H1: PhoneCockpit fetches host status and renders the host block in the drawer", () => {
  const t = src("PhoneCockpit.tsx");
  assert.match(t, /\/api\/auth\/status/);
  assert.match(t, /phone-host-block/);
  assert.match(t, /hostHealthLine\(runnerConn, host\?\.hostLabel, restartState\)/);
});

test("H2: Restart Host (Server & Runner) — two-step confirm, coordinated route, live status and Abort; Restart Runner kept", () => {
  const t = src("PhoneCockpit.tsx");
  assert.match(t, /Restart Runner/);
  assert.match(t, /\/__vibesquad\/restart-runner/);
  assert.match(t, /Restart Host \(Server & Runner\)/);
  assert.match(t, /Drains active leads and restarts both server & runner/);
  assert.match(t, /HOST_RESTART_URL = "\/__vibesquad\/restart-host"/);
  for (const id of ["phone-restart-host-btn", "phone-restart-host-warn", "phone-restart-host-confirm", "phone-restart-host-cancel", "phone-restart-host-status", "phone-restart-host-abort"]) assert.ok(t.includes(`data-testid="${id}"`), id);
  // the button only opens the confirm; only Confirm POSTs, only Abort DELETEs
  assert.match(t, /data-testid="phone-restart-host-btn"[^>]*onClick=\{\(\) => setH\(\{ phase: "confirm" \}\)\}/);
  assert.match(t, /data-testid="phone-restart-host-confirm" onClick=\{\(\) => void host\("POST"\)\}/);
  assert.match(t, /data-testid="phone-restart-host-abort"[^>]*onClick=\{\(\) => void host\("DELETE"\)\}/);
  assert.match(t, /const ABORTABLE = new Set\(\["queued", "requested", "draining", "ready"\]\)/, "no Abort once firing");
  assert.match(t, /<RestartHost hostRestart=\{host\?\.restartRequest \?\? null\} \/>/, "seeded from H1's host status");
});

test("idea-894 pickLiveRestart: local yields to a newer host prop", () => {
  const k = (h) => hostRestartKey(h);
  const oldDone = { id: "a", state: "done" };
  const localDone = { req: { id: "a", state: "aborted" }, hostKey: k(oldDone) };
  assert.deepEqual(pickLiveRestart(localDone, oldDone), { id: "a", state: "aborted" }, "same prop -> local");
  assert.deepEqual(pickLiveRestart(localDone, { id: "b", state: "queued" }), { id: "b", state: "queued" }, "new id -> prop");
  assert.equal(pickLiveRestart(localDone, null), null, "prop cleared -> null");
  const localActive = { req: { id: "a", state: "draining" }, hostKey: k({ id: "a", state: "queued" }) };
  assert.deepEqual(pickLiveRestart(localActive, { id: "a", state: "queued" }), { id: "a", state: "draining" }, "local active, same prop -> local");
  assert.deepEqual(pickLiveRestart(localActive, { id: "a", state: "done" }), { id: "a", state: "done" }, "prop state moved -> prop");
  assert.deepEqual(pickLiveRestart(undefined, { id: "c", state: "queued" }), { id: "c", state: "queued" }, "no local -> prop");
  assert.equal(pickLiveRestart(undefined, undefined), null);
});

// usa-57 (idea-933): phone route to the Usage dashboard.
test("usa-57: drawer button, banner route and ≤600px CSS", () => {
  const c = src("PhoneCockpit.tsx"), app = src("App.tsx"), css = src("styles.css"), v = src("PhoneUsageView.tsx"), st = src("phoneUsageStore.ts");
  assert.match(c, /data-testid="phone-usage-btn"/);
  assert.match(c, /openPhoneUsage\(\)/);
  assert.match(c, /<PhoneUsageView \/>/);
  assert.match(app, /<QuotaAlertBanner canOpenUsage \/>/);
  assert.match(v, /OPEN_USAGE_EVENT, openPhoneUsage/); // banner tap -> view
  assert.match(v, /e\.key === "Escape"/);
  assert.match(st, /history\.pushState/);
  assert.match(st, /history\.back\(\)/); // Back button undoes our pushed entry
  assert.match(st, /addEventListener\("popstate"/);
  for (const cls of [".phone-usage-view", ".phone-usage-bar", ".phone-usage-back", ".phone-usage-title", ".phone-usage-body", ".phone-usage-btn"]) assert.ok(css.includes(cls), cls);
  assert.match(css, /\.phone-usage-body \.usage-limits \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.phone-usage-body \.usage-table-wrap[^}]*overflow-x: auto/);
});

test("usa-57 R1: cold ?focus=usage opens the phone view, safe-area top, dialog a11y, banner inside the overlay", () => {
  const app = src("App.tsx"), css = src("styles.css"), v = src("PhoneUsageView.tsx");
  assert.match(app, /takeColdUsageFocus\(\)\) \{\s*if \(isPhoneShell\(isAndroidUserAgent\(\), window\.innerWidth\)\) openPhoneUsage\(\)/);
  assert.match(css, /\.phone-usage-bar \{[^}]*var\(--phone-safe-top, 0px\)/);
  assert.match(css, /\.phone-usage-body \{[^}]*safe-area-inset-bottom/);
  assert.match(v, /aria-modal="true"/);
  assert.match(v, /backRef\.current\?\.focus\(\)/);
  assert.match(v, /prev\.focus\(\)/);
  assert.match(v, /<QuotaAlertBanner canOpenUsage=\{false\} \/>/);
});
