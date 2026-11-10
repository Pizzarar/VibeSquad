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
  isPhoneShell,
  openBuddy,
  resetBuddyRequest,
  subscribeBuddyRequest,
} from "../src/phoneCockpitLogic.ts";

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
