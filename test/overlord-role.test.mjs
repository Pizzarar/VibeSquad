// PLAN_OVERLORD_ROLE block O1: hub Lead is the Overlord (title, prompt pack, RiffBot exception).
import assert from "node:assert/strict";
import test from "node:test";
import { formatDisplayTitle as tsTitle } from "../src/identity.ts";
import { formatDisplayTitle as mjsTitle } from "../server/identity.mjs";
import { retiredLeadTitle, titleFor } from "../src/teams.ts";
import { HUB_BUDDY_RULES, HUB_LEAD_RULES, injectedPrefix, rolePack } from "../server/hooks/agent-duties.ts";

for (const [name, fmt] of [["identity.ts", tsTitle], ["identity.mjs", mjsTitle]]) {
  test(`formatDisplayTitle (${name}): hub lead is Overlord, non-hub lead unchanged`, () => {
    const base = { laneId: "alpha", laneName: "Alpha", code: "Alp", ord: "2" };
    assert.equal(fmt({ ...base, role: "lead", hub: true }), "Overlord");
    assert.equal(fmt({ ...base, role: "lead", hub: true, job: "ops" }), "Overlord · ops");
    assert.equal(fmt({ ...base, role: "former-lead", hub: true }), "(old) Overlord");
    assert.equal(fmt({ ...base, role: "former-lead", hub: true, job: "ops" }), "(old) Overlord · ops");
    assert.equal(fmt({ ...base, role: "lead", job: "ops" }), "★ Alp2 · ops");
    assert.equal(fmt({ ...base, role: "former-lead", job: "ops" }), "(old) Alp2 · ops");
  });
}

test("titleFor / retiredLeadTitle honour hub for leads", () => {
  const i = { laneId: "alpha", code: "Alp", ord: "2" };
  assert.equal(titleFor("lead", "Alpha", { ...i, hub: true }), "Overlord");
  assert.equal(titleFor("lead", "Alpha", { ...i, hub: true, job: "ops" }), "Overlord · ops");
  assert.equal(titleFor("lead", "Alpha", { ...i, hub: false, job: "ops" }), "★ Alp2 · ops");
  assert.equal(titleFor("worker", "Alpha", { ...i, hub: true, job: "fix" }), "Alp2 · fix");
  assert.match(retiredLeadTitle("Alpha", "alpha", 2, "ops"), /^\(old\) (Overlord · ops|Alp2 · ops)$/);
});

test("rolePack lead gets HUB_LEAD_RULES only for the hub", () => {
  const hub = rolePack("lead", "", false, true);
  assert.equal(hub, `${rolePack("lead", "")}\n${HUB_LEAD_RULES}`);
  assert.match(hub, /vs log --since-me/);
  assert.match(hub, /vs who all --team <squad>/);
  assert.match(hub, /vs wait <lead> --timeout 90/);
  assert.match(hub, /vs cancel <lead>/);
  assert.match(hub, /vs lead handoff --lane <x>/);
  assert.match(hub, /Never raw-archive a lead/);
  assert.doesNotMatch(rolePack("lead", ""), /Overlord rules/);
  assert.match(injectedPrefix("lead", "", false, true), /Overlord rules/);
  assert.doesNotMatch(injectedPrefix("lead", "", false, false), /Overlord rules/);
});

test("HUB_BUDDY_RULES lets RiffBot wake or spawn the Overlord", () => {
  assert.match(HUB_BUDDY_RULES, /message or spawn the Overlord/);
  assert.match(HUB_BUDDY_RULES, /never spawn a feature-lane Lead/);
});
