import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRAINSTORM_PACK } from "../server/hooks/agent-duties.ts";
import { buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";
import { runMarkComplete, shipGoalBrief } from "../src/pinComplete.ts";
import { isStandingPin, patchLane, pinsForSquad } from "../src/pins.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makePin({ laneId = "android-app", name = "Android App", standing = false, state = "pinned" } = {}) {
  const lane = { id: laneId, name, state, ...(standing ? { standing: true } : {}) };
  const squad = { id: "vibesquad", name: "VibeSquad", color: "#00f0ff", lanes: [lane], paths: [] };
  return {
    squad,
    lane,
    state,
    order: 0,
    brainstorm: { agent: { id: "bs-1", status: "idle", labels: { profile: "Brainstorm - Claude" } } },
    lead: { agent: { id: "lead-1", status: "idle", labels: {} } },
    workers: [],
    needsYou: 0,
    running: 0,
    contextUsed: 0,
    topicBrainstorms: [],
  };
}

test("(1) disposable pin runMarkComplete sets state: 'done' and appends Done YYYY-MM-DD", async () => {
  const now = () => new Date(2026, 10, 6, 12);
  let teams = [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "one-off", name: "One Off", state: "pinned" }], paths: [] }];
  let brief = "# Brainstorm Summary · One Off (`one-off`)\n\n## Done when\n- Ship one-off modal\n\n## Decided\n- None.\n";
  const retired = [];
  const archived = [];

  const pin = makePin({ laneId: "one-off", name: "One Off", standing: false });
  assert.equal(isStandingPin(pin), false);

  const res = await runMarkComplete(pin, {
    now,
    readBrief: async () => brief,
    writeBrief: async (_l, c) => {
      brief = c;
    },
    retire: async (a) => {
      retired.push(a.id);
    },
    archive: async (id) => {
      archived.push(id);
    },
    saveTeams: async (update) => {
      teams = update(teams);
    },
  });

  assert.deepEqual(res, { ok: true });
  assert.equal(teams[0].lanes[0].state, "done");
  assert.equal(teams[0].lanes[0].doneAt, now().toISOString());
  assert.equal(teams[0].lanes[0].lastProfile, "Brainstorm - Claude");
  assert.match(brief, /\nDone 2026-11-06\n$/);
  assert.deepEqual(retired, ["bs-1", "lead-1"]);
  assert.deepEqual(archived, ["bs-1"]);
});

test("(2) standing pin runMarkComplete keeps state: 'pinned', moves ## Done when to Shipped YYYY-MM-DD: <goal>, resets ## Done when, and retires Lead + archives Buddy", async () => {
  const now = () => new Date(2026, 10, 6, 12);
  let teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      lanes: [{ id: "android-app", name: "Android App", state: "pinned", standing: true }],
      paths: [],
    },
  ];
  let brief = [
    "# Brainstorm Summary · Android App (`android-app`)",
    "",
    "## Who's here",
    "- Brainstorm: `bs-1`",
    "",
    "## Done when",
    "> 1–3 lines: what has to be true for this Team to be marked complete.",
    "- Ship APK signing pipeline",
    "- Verify background notification wake",
    "",
    "## Decided",
    "- Keep persistent foreground service.",
    "",
    "## Open",
    "- None.",
    "",
  ].join("\n");
  const retired = [];
  const archived = [];

  const pin = makePin({ laneId: "android-app", name: "Android App", standing: true });
  assert.equal(isStandingPin(pin), true);

  const res = await runMarkComplete(pin, {
    now,
    readBrief: async () => brief,
    writeBrief: async (_l, c) => {
      brief = c;
    },
    retire: async (a) => {
      retired.push(a.id);
    },
    archive: async (id) => {
      archived.push(id);
    },
    saveTeams: async (update) => {
      teams = update(teams);
    },
  });

  assert.deepEqual(res, { ok: true });
  const savedLane = teams[0].lanes[0];
  assert.equal(savedLane.state, "pinned");
  assert.equal(savedLane.doneAt, undefined);
  assert.equal(savedLane.standing, true);
  assert.equal(savedLane.lastProfile, "Brainstorm - Claude");
  assert.deepEqual(retired, ["bs-1", "lead-1"]);
  assert.deepEqual(archived, ["bs-1"]);

  assert.match(brief, /## Done when\n- \(waiting for next goal\)\n\n## Decided/);
  assert.match(brief, /\nShipped 2026-11-06: Ship APK signing pipeline; Verify background notification wake\n$/);
  assert.doesNotMatch(brief, /\nDone 2026-11-06\n/);

  // Standing pin stays in pinned list (sleeping), not Done shelf
  const { pinned, done } = pinsForSquad({ team: teams[0], lanes: [{ lane: savedLane, members: [] }], members: [] });
  assert.equal(pinned.length, 1);
  assert.equal(done.length, 0);
});

test("(3) shipGoalBrief is idempotent on same-day retry after ## Done when was already reset", () => {
  const initial = [
    "# Brainstorm Summary · UI Bois (`ui-bois`)",
    "",
    "## Done when",
    "- Polish squad floor cards",
    "",
    "## Decided",
    "- Keep compact header.",
    "",
  ].join("\n");

  const once = shipGoalBrief(initial, "2026-11-06");
  assert.match(once, /## Done when\n- \(waiting for next goal\)\n\n## Decided/);
  assert.match(once, /\nShipped 2026-11-06: Polish squad floor cards\n$/);

  const twice = shipGoalBrief(once, "2026-11-06");
  assert.equal(twice, once, "retry on the same day does not append a second Shipped line");
});

test("(4) patchLane toggles standing and PinDone / PinMenu expose standing team labels and testids", () => {
  let teams = [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "ui-bois", name: "UI Bois", state: "pinned" }], paths: [] }];
  teams = patchLane(teams, "vibesquad", "ui-bois", { standing: !teams[0].lanes[0].standing });
  assert.equal(teams[0].lanes[0].standing, true);
  teams = patchLane(teams, "vibesquad", "ui-bois", { standing: !teams[0].lanes[0].standing });
  assert.equal(teams[0].lanes[0].standing, false);

  const pinDoneSrc = fs.readFileSync(resolve(ROOT, "src/PinDone.tsx"), "utf8");
  assert.ok(pinDoneSrc.includes("✓ Goal shipped"));
  assert.ok(pinDoneSrc.includes("Tap again to ship goal"));
  assert.ok(pinDoneSrc.includes("Shipping…"));
  assert.ok(pinDoneSrc.includes("Log this goal as shipped in the brief and put the team to sleep until the next idea."));

  const pinMenuSrc = fs.readFileSync(resolve(ROOT, "src/PinMenu.tsx"), "utf8");
  assert.ok(pinMenuSrc.includes("export async function togglePinStanding"));
  assert.ok(pinMenuSrc.includes("pin-standing-toggle-"));
  assert.ok(pinMenuSrc.includes("Make standing team"));
  assert.ok(pinMenuSrc.includes("Make disposable team"));

  assert.ok(BRAINSTORM_PACK.includes("✓ Goal shipped"));
  const standingPrompt = buildBrainstormInitialPrompt({
    laneId: "android-app",
    laneUpper: "ANDROID-APP",
    summaryContent: "# Brief",
    latestPlan: "docs/PLAN_X.md",
    standing: true,
  });
  assert.ok(standingPrompt.includes("✓ Goal shipped"));
});

