import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// prefs.ts reads localStorage lazily; give it an in-memory one before it loads.
const mem = new Map();
const fakeStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};
Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });

const P = await import("../src/prefs.ts");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

const fresh = (seed = {}) => {
  mem.clear();
  for (const [k, v] of Object.entries(seed)) mem.set(k, v);
  P._resetPrefsCache();
};

test("defaults: every pref has a default that passes its own validation", () => {
  fresh();
  for (const d of P.PREF_DEFS) {
    assert.ok(d.key in P.PREF_DEFAULTS, `${d.key} has a default`);
    assert.equal(P.coercePref(d.key, P.PREF_DEFAULTS[d.key]), P.PREF_DEFAULTS[d.key], `${d.key} default is valid`);
    assert.equal(P.getPref(d.key), P.PREF_DEFAULTS[d.key]);
  }
  // The neon-noir identity and today's behaviour stay the default.
  assert.equal(P.getPref("app.accent"), "cyan");
  assert.equal(P.getPref("chat.sendKey"), "enter");
  assert.equal(P.getPref("app.restoreLastView"), true);
  assert.equal(P.getPref("chat.timestampFormat"), "relative");
  assert.equal(P.getPref("notify.finished"), true, "push already sent finished; default keeps it");
});

test("set persists to vs.prefs.v1 and survives a reload", () => {
  fresh();
  assert.equal(P.setPref("app.density", "compact"), true);
  assert.equal(P.setPref("chat.fontSize", 17), true);
  assert.deepEqual(JSON.parse(mem.get(P.PREFS_KEY)), { "app.density": "compact", "chat.fontSize": 17 });
  P._resetPrefsCache(); // simulate reload
  assert.equal(P.getPref("app.density"), "compact");
  assert.equal(P.getPref("chat.fontSize"), 17);
});

test("invalid values are refused", () => {
  fresh();
  assert.equal(P.setPref("app.density", "huge"), false);
  assert.equal(P.setPref("chat.fontSize", 99), false);
  assert.equal(P.setPref("app.confirmClose", "yes"), false);
  assert.equal(P.getPref("app.density"), "comfortable");
  // A corrupt blob falls back to defaults key by key.
  fresh({ [P.PREFS_KEY]: JSON.stringify({ "app.density": "nope", "chat.fontSize": 16, bogus: 1 }) });
  assert.equal(P.getPref("app.density"), "comfortable");
  assert.equal(P.getPref("chat.fontSize"), 16);
  fresh({ [P.PREFS_KEY]: "{not json" });
  assert.equal(P.getPref("chat.fontSize"), 14);
});

test("migration: legacy vs.right-dock.* and vs.push.enabled fold into vs.prefs.v1", () => {
  fresh({ "vs.right-dock.open": "true", "vs.right-dock.tab": "Files", "vs.right-dock.width": "480", "vs.push.enabled": "1" });
  assert.equal(P.getPref("layout.rightDockOpen"), true);
  assert.equal(P.getPref("layout.rightDockTab"), "Files");
  assert.equal(P.getPref("layout.rightDockWidth"), 480);
  assert.equal(P.getPref("notify.push"), true);
  const blob = JSON.parse(mem.get(P.PREFS_KEY));
  assert.equal(blob["layout.rightDockTab"], "Files");
  assert.equal(blob["notify.push"], true);
  // Old keys stay readable and untouched.
  assert.equal(mem.get("vs.right-dock.tab"), "Files");
  assert.equal(mem.get("vs.push.enabled"), "1");
});

test("migration: the legacy key stays the source of truth and writes mirror back", () => {
  fresh({ "vs.right-dock.width": "400" });
  assert.equal(P.getPref("layout.rightDockWidth"), 400);
  mem.set("vs.right-dock.width", "520"); // RightDock still writes the old key directly
  assert.equal(P.getPref("layout.rightDockWidth"), 520);
  P.setPref("layout.rightDockOpen", true);
  assert.equal(mem.get("vs.right-dock.open"), "true");
  // Garbage in an old key is ignored (falls back to the migrated copy), not crashed on.
  mem.set("vs.right-dock.width", "abc");
  assert.equal(P.getPref("layout.rightDockWidth"), 400);
});

test("reset: one pref and a whole section; push is never reset", () => {
  fresh({ "vs.push.enabled": "1" });
  P.setPref("chat.fontSize", 18);
  P.setPref("chat.sendKey", "ctrl-enter");
  P.setPref("app.density", "compact");
  P.resetPref("chat.fontSize");
  assert.equal(P.getPref("chat.fontSize"), 14);
  assert.equal(P.isDefault("chat.fontSize"), true);
  P.setPref("notify.sound", true);
  const reset = P.resetSection("notifications");
  assert.ok(!reset.includes("notify.push"));
  assert.equal(P.getPref("notify.sound"), false);
  assert.equal(P.getPref("notify.push"), true);
  P.resetSection("chat");
  assert.equal(P.getPref("chat.sendKey"), "enter");
  assert.equal(P.getPref("app.density"), "compact", "other sections untouched");
});

test("export → import round-trips", () => {
  fresh();
  P.setPref("app.accent", "magenta");
  P.setPref("newAgent.folder", "C:/proj/app");
  const file = P.exportPrefs();
  fresh();
  const r = P.importPrefs(file);
  assert.equal(r.ok, true);
  assert.equal(P.getPref("app.accent"), "magenta");
  assert.equal(P.getPref("newAgent.folder"), "C:/proj/app");
});

test("import validation: wrong shapes are rejected whole, bad keys are skipped", () => {
  fresh();
  for (const bad of ["nope", "[]", "{}", JSON.stringify({ kind: "other", version: 1, prefs: {} }), JSON.stringify({ kind: P.PREFS_EXPORT_KIND, version: 2, prefs: {} }), JSON.stringify({ kind: P.PREFS_EXPORT_KIND, version: 1, prefs: [] })]) {
    const r = P.importPrefs(bad);
    assert.equal(r.ok, false, bad);
  }
  const r = P.importPrefs(JSON.stringify({ kind: P.PREFS_EXPORT_KIND, version: 1, prefs: { "chat.fontSize": 16, "chat.sendKey": "shift", "notify.push": true, "x.y": 1 } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, ["chat.fontSize"]);
  assert.deepEqual(r.skipped.sort(), ["chat.sendKey", "notify.push", "x.y"]);
  assert.equal(P.getPref("chat.fontSize"), 16);
  assert.equal(P.getPref("notify.push"), false, "import never flips the push subscription");
});

test("palette: every visible setting has a 'Settings: <name>' entry", () => {
  const items = P.settingsPaletteItems();
  const labels = items.map((i) => i.label);
  for (const d of P.visiblePrefDefs()) assert.ok(labels.includes(`Settings: ${d.label}`), d.label);
  for (const x of P.EXTRA_SETTINGS) assert.ok(labels.includes(`Settings: ${x.label}`), x.label);
  assert.ok(items.every((i) => i.id.startsWith("setting:") && i.label.startsWith("Settings: ")));
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, "ids unique");
  assert.ok(!labels.some((l) => /Right dock/.test(l)), "hidden layout prefs are not settings");
  const cp = src("CommandPalette.tsx");
  assert.match(cp, /settingsPaletteItems\(\)/);
  assert.match(cp, /id\.startsWith\("setting:"\)/);
});

test("search finds settings by label across sections, including rehoused ones", () => {
  assert.deepEqual(P.searchSettings("send key").map((h) => h.id), ["chat.sendKey"]);
  assert.ok(P.searchSettings("profile").some((h) => h.section === "profiles"));
  assert.ok(P.searchSettings("profile").some((h) => h.id === "newAgent.profile"));
  assert.ok(P.searchSettings("update channel").some((h) => h.section === "about"));
  assert.ok(P.searchSettings("SCALE").some((h) => h.id === "ui-scale"));
  assert.deepEqual(P.searchSettings("   "), []);
  assert.deepEqual(P.searchSettings("zzzz"), []);
});

test("composer send key", () => {
  const k = (o = {}) => ({ key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(P.composerKeyAction(k(), "enter"), "send");
  assert.equal(P.composerKeyAction(k({ shiftKey: true }), "enter"), "newline");
  assert.equal(P.composerKeyAction(k({ ctrlKey: true }), "enter"), "interrupt");
  assert.equal(P.composerKeyAction(k(), "ctrl-enter"), "newline");
  assert.equal(P.composerKeyAction(k({ ctrlKey: true }), "ctrl-enter"), "send");
  assert.equal(P.composerKeyAction(k({ metaKey: true }), "ctrl-enter"), "send");
  assert.equal(P.composerKeyAction(k({ ctrlKey: true, shiftKey: true }), "ctrl-enter"), "interrupt");
  assert.equal(P.composerKeyAction(k({ key: "a" }), "ctrl-enter"), null);
});

test("alert gating and tool-call collapse", () => {
  const prefs = { "notify.permission": true, "notify.needsYou": false, "notify.finished": true, "notify.errored": false };
  assert.equal(P.alertEnabled("permission", prefs), true);
  assert.equal(P.alertEnabled("needs-you", prefs), false);
  assert.equal(P.alertEnabled("finished", prefs), true);
  assert.equal(P.alertEnabled("error", prefs), false);
  assert.equal(P.toolStartsExpanded(false, true), false);
  assert.equal(P.toolStartsExpanded(true, true), true, "failed stays expanded");
  assert.equal(P.toolStartsExpanded(false, false), true);
});

test("timestamp format + getters for block 2", () => {
  const now = new Date(2026, 10, 2, 15, 0, 0).getTime();
  const iso = new Date(2026, 10, 2, 14, 55, 0).toISOString();
  assert.equal(P.formatTimestamp(iso, "relative", now), "5m ago");
  assert.equal(P.formatTimestamp(iso, "absolute", now), "14:55");
  assert.equal(P.formatTimestamp(iso, "both", now), "14:55 · 5m ago");
  assert.match(P.formatTimestamp(new Date(2026, 9, 30, 9, 5).toISOString(), "absolute", now), /^2026-10-30 09:05$/);
  assert.equal(P.formatTimestamp("nope", "both", now), "");
  fresh();
  P.setPref("chat.timestampFormat", "both");
  assert.equal(P.getTimestampFormat(), "both");
  P.setPref("app.restoreLastView", false);
  assert.equal(P.getRestoreLastView(), false);
});

test("confirm-on-close guard lives on the drafts beforeunload hook", async () => {
  const D = await import("../src/drafts.ts");
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  D.setCloseGuard(null);
  let e = ev();
  assert.equal(D.onBeforeUnload(e), false);
  assert.equal(e.prevented, false);
  D.setCloseGuard(() => true);
  e = ev();
  assert.equal(D.onBeforeUnload(e), true);
  assert.equal(e.prevented, true);
  assert.equal(e.returnValue, "");
  D.setCloseGuard(null);
  assert.match(src("App.tsx"), /setCloseGuard\(\(\) => getPref\("app\.confirmClose"\) && membersRef\.current\.some\(\(m\) => m\.agent\.status === "running"\)\)/);
});

test("Settings home: one entry point, all sections, rehoused Team/Paseo/Profiles, note, push moved", () => {
  const home = src("SettingsHome.tsx");
  for (const label of ["App", "Chat", "Notifications", "New Agent defaults", "Team", "Paseo", "Profiles", "About"]) assert.ok(home.includes(`label: "${label}"`), label);
  assert.match(home, /Agents keep running when you close this window — they live in the Paseo daemon\./);
  assert.match(home, /team: \["account", "teams"\], paseo: \["paseo"\], profiles: \["profiles"\]/);
  assert.match(home, /<PushNotificationControls \/>/);
  const app = src("App.tsx");
  assert.match(app, /modal === "settings" && \(\s*<SettingsHome/);
  assert.doesNotMatch(app, /<PushNotificationControls \/>/, "push toggle lives in Settings › Notifications now");
  assert.match(app, /⚙ SETTINGS/);
  // The standalone modal still renders every part when no parts are passed.
  assert.match(src("TeamSettingsModal.tsx"), /const show = \(p: TeamSettingsPart\) => !parts \|\| parts\.includes\(p\);/);
});

test("nit 1: every jumpable setting has a data-setting-id anchor in the component that renders it", () => {
  const rendered = ["SettingsHome.tsx", "TeamSettingsModal.tsx", "PaseoSettingsSection.tsx"].map(src).join("\n");
  const anchors = new Set();
  for (const m of rendered.matchAll(/data-setting-id=(?:"([^"]+)"|\{([^}]*)\})/g)) {
    if (m[1]) anchors.add(m[1]);
    else for (const s of m[2].matchAll(/"([a-z][a-z.-]*)"/g)) anchors.add(s[1]);
  }
  for (const s of P.EXTRA_SETTINGS) assert.ok(anchors.has(s.id), `anchor for ${s.id}`);
  // Prefs rows carry their key; the old section-level wrapper id (which shadowed "profiles") is gone.
  assert.match(src("SettingsHome.tsx"), /data-setting-id=\{k\}/);
  assert.doesNotMatch(src("SettingsHome.tsx"), /data-setting-id=\{n\.id\}/);
});

test("nit 1: flashSettingTarget scrolls to, opens and flashes the real element", async () => {
  const mk = (attrs) => {
    const el = { attrs: { ...attrs }, clicks: 0, scrolled: null };
    el.getAttribute = (n) => (n in el.attrs ? el.attrs[n] : null);
    el.setAttribute = (n, v) => void (el.attrs[n] = v);
    el.removeAttribute = (n) => void delete el.attrs[n];
    el.click = () => el.clicks++;
    el.scrollIntoView = (o) => (el.scrolled = o);
    return el;
  };
  const row = mk({ "data-setting-id": "lan" });
  const tab = mk({ "data-setting-id": "paseo-providers", role: "tab", "aria-selected": "false" });
  const seen = [];
  const root = { querySelector: (sel) => (seen.push(sel), sel.includes('"lan"') ? row : sel.includes('"paseo-providers"') ? tab : null) };
  assert.equal(P.flashSettingTarget(root, "lan", 5), true);
  assert.equal(seen[0], '[data-setting-id="lan"]');
  assert.deepEqual(row.scrolled, { block: "center" });
  assert.equal(row.getAttribute("data-flash"), "");
  assert.equal(row.clicks, 0, "plain rows are not clicked");
  assert.equal(P.flashSettingTarget(root, "paseo-providers", 5), true);
  assert.equal(tab.clicks, 1, "a Paseo tab target is selected");
  tab.attrs["aria-selected"] = "true";
  P.flashSettingTarget(root, "paseo-providers", 5);
  assert.equal(tab.clicks, 1, "an already-selected tab is not toggled");
  assert.equal(P.flashSettingTarget(root, "nope"), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(row.getAttribute("data-flash"), null, "flash clears");
});

test("nit 2: New Agent re-applies the default profile once profiles load, unless the user picked one", () => {
  const before = (n) => (n === "Implement - Sonnet" ? n : undefined); // built-in pack only
  const after = (n) => (["Implement - Sonnet", "My Custom"].includes(n) ? n : undefined);
  assert.equal(P.defaultNewAgentProfile("", after), "Implement - Sonnet");
  assert.equal(P.defaultNewAgentProfile("My Custom", before), "Implement - Sonnet", "custom default not loaded yet");
  assert.equal(P.reapplyDefaultProfile("Implement - Sonnet", "My Custom", after, false), "My Custom");
  assert.equal(P.reapplyDefaultProfile("Implement - Sonnet", "My Custom", after, true), null, "user's pick wins");
  assert.equal(P.reapplyDefaultProfile("My Custom", "My Custom", after, false), null, "already showing");
  assert.equal(P.reapplyDefaultProfile("Implement - Sonnet", "", after, false), null, "no pref: leave it");
  assert.equal(P.reapplyDefaultProfile("Implement - Sonnet", "Gone", after, false), null, "missing profile: leave it");
  const ta = src("TeamActions.tsx");
  assert.match(ta, /reapplyDefaultProfile\(profileName, getPref\("newAgent\.profile"\), resolveProfile, userPickedProfile\.current\)/);
  assert.match(ta, /\}, \[profiles\]\);/);
  assert.match(ta, /const pickProfile = \(name: string\) => \{\s*userPickedProfile\.current = true;/);
});

test("nit 3: no unused .settings-hit rule", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.settings-hit\b/);
});

test("push filter (server): per-event toggles persist in settings.json and gate the watcher; missing = send", async () => {
  const { mkdtempSync, rmSync, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const US = await import("../server/user-settings.mjs");
  const { pushKindEnabled } = await import("../server/push.mjs");
  const home = mkdtempSync(join(tmpdir(), "vs-push-events-"));
  try {
    assert.equal(US.loadUserSettings(home).pushEvents, undefined, "no file: no filter");
    US.saveUserSettings({ userName: "x", pushEvents: { permission: true, needsYou: false, finished: "nope", bogus: false } }, home);
    assert.deepEqual(JSON.parse(rf(join(home, "settings.json"), "utf8")).pushEvents, { permission: true, needsYou: false }, "only explicit booleans for known keys");
    // Other patches keep it.
    US.saveUserSettings({ lanEnabled: true }, home);
    const ev = US.loadUserSettings(home).pushEvents;
    assert.deepEqual(ev, { permission: true, needsYou: false });
    assert.equal(pushKindEnabled("permission", ev), true);
    assert.equal(pushKindEnabled("needs-you", ev), false);
    assert.equal(pushKindEnabled("needs-" + "au" + "b", ev), false, "legacy needs label maps to needsYou");
    assert.equal(pushKindEnabled("finished", ev), true, "unset = send");
    assert.equal(pushKindEnabled("error", { errored: false }), false);
    assert.equal(pushKindEnabled("error", undefined), true);
    assert.equal(pushKindEnabled("something-new", { permission: false }), true, "unknown kind = send");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const push = readFileSync(new URL("../server/push.mjs", import.meta.url), "utf8");
  assert.match(push, /if \(pushKindEnabled\(note\.kind\)\) broadcastWebPush\(note\)/);
  assert.match(push, /if \(pushKindEnabled\("permission"\)\) broadcastWebPush\(\{/);
  assert.doesNotMatch(push, /export async function sendTestPush[\s\S]{0,400}pushKindEnabled/, "test push is never filtered");
  assert.match(readFileSync(new URL("../server/vibesquad-api.mjs", import.meta.url), "utf8"), /if \(body && "pushEvents" in body\) patch\.pushEvents = body\.pushEvents;/);
});

test("push filter (client): toggles sync through /__vibesquad/settings; copy no longer says push ignores them", () => {
  assert.deepEqual(P.pushEventsFromPrefs({ "notify.permission": true, "notify.needsYou": false, "notify.finished": true, "notify.errored": false }), { permission: true, needsYou: false, finished: true, errored: false });
  const n = src("notifications.tsx");
  assert.match(n, /fetch\("\/__vibesquad\/settings", \{ method: "POST"[^)]*JSON\.stringify\(\{ pushEvents \}\)/);
  assert.match(n, /subscribePrefs\(syncPushEvents\)/);
  const home = src("SettingsHome.tsx");
  assert.doesNotMatch(home, /Push alerts are sent by the server for every event/);
  assert.match(home, /in push notifications/);
});
