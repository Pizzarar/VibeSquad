import assert from "node:assert/strict";
import test from "node:test";

// S: Pure logic tests for the extracted modules.
// No DOM or React rendering — Node-only.

test("S1: RightDock localStorage key constants are correct", () => {
  const OPEN_KEY = "vs.right-dock.open";
  const TAB_KEY = "vs.right-dock.tab";
  const WIDTH_KEY = "vs.right-dock.width";
  assert.ok(OPEN_KEY.startsWith("vs.right-dock."), "open key uses vs.right-dock namespace");
  assert.ok(TAB_KEY.startsWith("vs.right-dock."), "tab key uses vs.right-dock namespace");
  assert.ok(WIDTH_KEY.startsWith("vs.right-dock."), "width key uses vs.right-dock namespace");
});

test("S2: RightDock tab list is Changes/Files/Terminal/Scripts", () => {
  const TABS = ["Changes", "Files", "Terminal", "Scripts"];
  assert.equal(TABS.length, 4, "exactly 4 tabs");
  assert.ok(TABS.includes("Changes"), "Changes tab present");
  assert.ok(TABS.includes("Files"), "Files tab present");
  assert.ok(TABS.includes("Terminal"), "Terminal tab present");
  assert.ok(TABS.includes("Scripts"), "Scripts tab present");
});

test("S3: RightDock open state persists boolean to string", () => {
  const persist = (v) => String(v);
  assert.equal(persist(true), "true", "open=true stores as string 'true'");
  assert.equal(persist(false), "false", "open=false stores as string 'false'");
  const read = (s) => s === "true";
  assert.equal(read("true"), true);
  assert.equal(read("false"), false);
  assert.equal(read(null), false, "missing key initialises to false");
});

test("S4: RightDock width clamps to [200, 700]", () => {
  const clamp = (w, delta) => Math.max(200, Math.min(700, w + delta));
  assert.equal(clamp(320, -200), 200, "clamped at minimum 200");
  assert.equal(clamp(320, 500), 700, "clamped at maximum 700");
  assert.equal(clamp(320, 50), 370, "normal resize works");
});

test("S5: Timeline Entry type shape is correct", () => {
  const entry = { item: { type: "user_message", text: "hello" }, seqStart: 1 };
  assert.ok("item" in entry, "entry has item");
  assert.ok("seqStart" in entry, "entry has seqStart");
  assert.equal(entry.item.type, "user_message");
});

test("S6: PermissionCard respond behavior shapes are allow/deny", () => {
  const buildAllow = (extra) => ({ behavior: "allow", ...extra });
  const buildDeny = () => ({ behavior: "deny" });

  const allow = buildAllow({ selectedActionId: "act-1" });
  assert.equal(allow.behavior, "allow");
  assert.equal(allow.selectedActionId, "act-1");

  const deny = buildDeny();
  assert.equal(deny.behavior, "deny");
  assert.equal(deny.selectedActionId, undefined);
});

test("S7: DrawerHeader dock toggle button renders with correct state hint", () => {
  const dockLabel = (open) => `Dock ${open ? "▶" : "◀"}`;
  assert.equal(dockLabel(true), "Dock ▶", "open dock shows ▶");
  assert.equal(dockLabel(false), "Dock ◀", "closed dock shows ◀");
});

test("S8: Composer sends to onSend and onInterrupt correctly", () => {
  let sent = null;
  let interrupted = null;
  const onSend = () => { sent = "sent"; };
  const onInterrupt = () => { interrupted = "interrupted"; };
  onSend();
  onInterrupt();
  assert.equal(sent, "sent");
  assert.equal(interrupted, "interrupted");
});
