import assert from "node:assert/strict";
import test from "node:test";
import {
  BRAINSTORM_PACK,
  EVERYONE_LAYER,
  LEAD_FALLBACK_PACK,
  sameLaneRole,
} from "../server/hooks/agent-duties.ts";
import {
  DEFAULT_PACK_PROFILES,
  DEFAULT_PROFILES,
  detectNoteWarnings,
} from "../server/profiles.mjs";
import {
  AGENT_TYPE_NAME,
  buildTeamViews,
  checkBuddyOverlap,
  resolve,
  slugifyFeatureLane,
} from "../src/teams.ts";

test("1. Prompt layers and default profiles include Buddy mascot and spin-up-a-buddy overlap check with zero project leaks", () => {
  // EVERYONE_LAYER mentions multiple feature lanes, Buddy mascot, and shared vs log --since-me
  assert.match(EVERYONE_LAYER, /Buddy/);
  assert.match(EVERYONE_LAYER, /multiple feature lanes/i);
  assert.match(EVERYONE_LAYER, /\bvs log --since-me/);

  // BRAINSTORM_PACK and LEAD_FALLBACK_PACK include "Spin up a buddy (for X)" + overlap check
  for (const [label, pack] of [
    ["BRAINSTORM_PACK", BRAINSTORM_PACK],
    ["LEAD_FALLBACK_PACK", LEAD_FALLBACK_PACK],
  ]) {
    if (label === "BRAINSTORM_PACK") {
      // Pinned teams: "I just thought of X" / "spin up a Brainstorm for X" is a new-pin request.
      assert.match(pack, /spin up a Brainstorm for X/, `${label} must include the new-pin trigger`);
      assert.match(pack, /I just thought of X/, `${label} must include the new-pin trigger`);
    } else {
      assert.match(pack, /Buddy/, `${label} must mention Buddy`);
      assert.match(pack, /spin up a buddy/i, `${label} must include spin up a buddy trigger`);
      assert.match(pack, /spin up another buddy/i, `${label} must include spin up another buddy trigger`);
      assert.match(pack, /get me a buddy for X/i, `${label} must include get me a buddy for X trigger`);
    }
    assert.match(pack, /\bvs who brainstorm/, `${label} must instruct checking existing lanes/Buddies`);
    assert.match(pack, /\bvs log --since-me/, `${label} must instruct checking squad log for overlap`);
    assert.match(pack, /overlap/i, `${label} must instruct checking for overlap`);
  }

  // DEFAULT_PROFILES in server/profiles.mjs
  assert.equal(Array.isArray(DEFAULT_PROFILES), true);
  assert.equal(DEFAULT_PROFILES.length, 19);
  assert.equal(DEFAULT_PROFILES, DEFAULT_PACK_PROFILES);

  const forbidden = /[A-Za-z]:\\/i;
  for (const profile of DEFAULT_PROFILES) {
    assert.equal(
      forbidden.test(profile.notes),
      false,
      `Profile "${profile.name}" leaked forbidden project/path token`,
    );
    assert.deepEqual(detectNoteWarnings(profile.notes), []);
  }

  for (const name of ["Brainstorm - Claude", "Brainstorm - Gemini", "Lead - Claude", "Lead - Gemini"]) {
    const p = DEFAULT_PROFILES.find((x) => x.name === name);
    assert.ok(p, `Expected profile ${name}`);
    assert.match(p.notes, /Buddy/);
    assert.match(p.notes, /spin up a buddy/i);
    assert.match(p.notes, /overlap/i);
  }
});

test("2. slugifyFeatureLane derives clean lowercase kebab-case lane slugs without duplicating squadId", () => {
  assert.deepEqual(slugifyFeatureLane("vibesquad", "Mobile Nav"), {
    id: "vibesquad-mobile-nav",
    name: "Mobile Nav",
  });
  assert.deepEqual(slugifyFeatureLane("vibesquad", "vibesquad-mobile-nav"), {
    id: "vibesquad-mobile-nav",
    name: "Mobile Nav",
  });
  assert.deepEqual(slugifyFeatureLane("efi", "combat_loop"), {
    id: "efi-combat-loop",
    name: "Combat Loop",
  });
  assert.deepEqual(slugifyFeatureLane("site", "Site · Blog Search"), {
    id: "site-blog-search",
    name: "Blog Search",
  });
});

test("3. Multi-Buddy Squad grouping: dynamic feature lanes nest under their Squad card and never drop into _other or create extra Squad rows", () => {
  assert.equal(AGENT_TYPE_NAME.brainstorm, "Brainstorm (Buddy)");

  const agents = new Map([
    [
      "bs-main",
      {
        id: "bs-main",
        title: "BRAINSTORM · VIBESQUAD",
        provider: "claude",
        model: "claude-opus-5-5",
        cwd: "/projects/VibeSquad",
        status: "idle",
        updatedAt: "2026-11-01T01:00:00Z",
        labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" },
      },
    ],
    [
      "lead-main",
      {
        id: "lead-main",
        title: "★ VIBESQUAD ord1",
        provider: "claude",
        model: "claude-opus-5-5",
        cwd: "/projects/VibeSquad",
        status: "running",
        updatedAt: "2026-11-01T01:01:00Z",
        labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
      },
    ],
    [
      "bs-mobile-nav",
      {
        id: "bs-mobile-nav",
        title: "BRAINSTORM · MOBILE NAV · Mobile Nav",
        provider: "claude",
        model: "claude-opus-5-5",
        cwd: "/projects/VibeSquad",
        status: "idle",
        updatedAt: "2026-11-01T01:05:00Z",
        labels: {
          team: "vibesquad",
          lane: "vibesquad-mobile-nav",
          role: "brainstorm",
          topic: "Mobile Nav",
        },
      },
    ],
    [
      "lead-mobile-nav",
      {
        id: "lead-mobile-nav",
        title: "★ MOBILE NAV ord1",
        provider: "antigravity-cli",
        model: "gemini-4-argon",
        cwd: "/projects/VibeSquad",
        status: "idle",
        updatedAt: "2026-11-01T01:06:00Z",
        labels: {
          team: "vibesquad",
          lane: "vibesquad-mobile-nav",
          role: "lead",
          ord: "1",
        },
      },
    ],
  ]);

  const members = resolve(agents);
  const views = buildTeamViews(members);
  const vsView = views.find((v) => v.team.id === "vibesquad");
  assert.ok(vsView, "Expected vibesquad Squad view");

  // Both feature lanes (declared 'vibesquad' and dynamic 'vibesquad-mobile-nav') appear under the single VibeSquad Squad
  const laneIds = vsView.lanes.map((l) => l.lane.id);
  assert.equal(laneIds.includes("vibesquad"), true);
  assert.equal(laneIds.includes("vibesquad-mobile-nav"), true);
  assert.equal(laneIds.includes("_other"), false);

  const mobileNavLane = vsView.lanes.find((l) => l.lane.id === "vibesquad-mobile-nav");
  assert.ok(mobileNavLane);
  assert.equal(mobileNavLane.lane.name, "Mobile Nav");
  assert.equal(mobileNavLane.brainstorm?.agent.id, "bs-mobile-nav");
  assert.equal(mobileNavLane.lead?.agent.id, "lead-mobile-nav");
  assert.equal(mobileNavLane.duplicateBrainstorms.length, 0);
  assert.equal(mobileNavLane.duplicateLeads.length, 0);

  // Plugin sameLaneRole keeps Buddies in different feature lanes independent (no cross-lane retirement)
  assert.equal(
    sameLaneRole(
      { labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" }, title: "BRAINSTORM · VIBESQUAD" },
      { role: "brainstorm", team: "vibesquad", lane: "vibesquad-mobile-nav", topic: "Mobile Nav" },
    ),
    false,
  );
});

test("4. checkBuddyOverlap flags keyword, topic, and file/log overlaps within the Squad and returns null when clean", () => {
  const agents = new Map([
    [
      "bs-nav",
      {
        id: "bs-nav",
        title: "BRAINSTORM · MOBILE NAV · Mobile Navigation Drawer",
        provider: "claude",
        model: "claude-opus-5-5",
        cwd: "/projects/VibeSquad",
        status: "idle",
        updatedAt: "2026-11-01T01:05:00Z",
        labels: {
          team: "vibesquad",
          lane: "vibesquad-mobile-nav",
          role: "brainstorm",
          topic: "Mobile Navigation Drawer",
        },
      },
    ],
    [
      "bs-auth",
      {
        id: "bs-auth",
        title: "BRAINSTORM · AUTH · Device Pairing Auth",
        provider: "claude",
        model: "claude-opus-5-5",
        cwd: "/projects/VibeSquad",
        status: "idle",
        updatedAt: "2026-11-01T01:07:00Z",
        labels: {
          team: "vibesquad",
          lane: "vibesquad-auth",
          role: "brainstorm",
          topic: "Device Pairing Auth",
        },
      },
    ],
  ]);

  const vsView = buildTeamViews(resolve(agents)).find((v) => v.team.id === "vibesquad");
  assert.ok(vsView);

  const logs = [
    {
      lane: "vibesquad-auth",
      type: "decision",
      text: "Settled QR token flow in server/auth.mjs and src/PairDeviceModal.tsx",
      refs: ["server/auth.mjs", "src/PairDeviceModal.tsx"],
    },
  ];

  // 4a. Keyword overlap with Mobile Navigation Drawer Buddy
  const navOverlap = checkBuddyOverlap("Mobile drawer gestures", vsView, logs);
  assert.ok(navOverlap, "Expected overlap on mobile/drawer keywords");
  assert.equal(navOverlap.laneId, "vibesquad-mobile-nav");
  assert.equal(navOverlap.buddy?.agent.id, "bs-nav");
  assert.match(navOverlap.reason, /Mobile Navigation Drawer|vibesquad-mobile-nav/);

  // 4b. File/log overlap with Auth lane via log refs
  const fileOverlap = checkBuddyOverlap("Refactor PairDeviceModal.tsx layout", vsView, logs);
  assert.ok(fileOverlap, "Expected overlap on PairDeviceModal.tsx from vs log");
  assert.equal(fileOverlap.laneId, "vibesquad-auth");
  assert.equal(fileOverlap.buddy?.agent.id, "bs-auth");
  assert.match(fileOverlap.reason, /pairdevicemodal\.tsx/i);

  // 4c. Clean non-overlapping feature returns null
  const clean = checkBuddyOverlap("Audio Synth Effects", vsView, logs);
  assert.equal(clean, null);
});
