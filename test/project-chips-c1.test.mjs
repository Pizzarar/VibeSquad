import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(ROOT, "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(SRC_DIR).href)) {
      if (specifier === "./paseo" || specifier === "./IdeaInbox") {
        const stub =
          specifier === "./paseo"
            ? "export const getPaseoState = () => ({ conn: 'connected', agents: new Map() }); export const archiveAgent = async () => {}; export const archiveWorkspace = async () => {}; export const detachAgent = async () => {}; export const retireAgent = async () => {}; export const sendMessage = async () => {}; export const updateAgent = async () => {}; export const upsertLocalAgent = () => {};"
            : "export const parkIdeasInInbox = async () => {};";
        return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
      }
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const tsCandidate = resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(tsCandidate)) {
        return nextResolve(pathToFileURL(tsCandidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

import { validateTeamsBody, writeTeamsRegistry } from "../server/teams-file.mjs";
const pinsMod = await import("../src/pins.ts");
const pinActionsMod = await import("../src/pinActions.ts");
const {
  chipIconSrc,
  patchQuickLanes,
  quickBugsChipState,
  quickBugsPinForSquad,
  resolveQuickBugsLane,
  snapChipSize,
} = pinsMod;
const { createPin, createQuickBugsPin } = pinActionsMod;
import { mergeTeams } from "../src/teamsMerge.ts";

const whole = (n) => Math.abs(n - Math.round(n)) < 1e-6;

test("resolveQuickBugsLane: explicit quickLanes.bugs wins, fallback matches standing bug-chaser*, unset on other squads returns null", () => {
  // Explicit quickLanes.bugs wins over bug-chaser fallback
  const explicitTeam = {
    id: "efi",
    name: "Main Game Project",
    quickLanes: { bugs: "efi-bugs" },
    lanes: [
      { id: "efi", name: "RiffBot", hub: true },
      { id: "bug-chaser", name: "Bug Chaser", standing: true },
      { id: "efi-bugs", name: "EFI Bugs", standing: true },
    ],
  };
  assert.equal(resolveQuickBugsLane(explicitTeam)?.id, "efi-bugs");

  // Alias match on explicit quickLanes.bugs
  const aliasTeam = {
    id: "vibesquad",
    name: "VibeSquad",
    quickLanes: { bugs: "bug-chaser-2" },
    lanes: [
      { id: "bug-chaser", name: "Bug Chaser", standing: true, aliases: ["bug-chaser-2"] },
    ],
  };
  assert.equal(resolveQuickBugsLane(aliasTeam)?.id, "bug-chaser");

  // Fallback when quickLanes.bugs is unset: standing lane matching bug-chaser*
  const fallbackTeam = {
    id: "vibesquad",
    name: "VibeSquad",
    lanes: [
      { id: "vibesquad", name: "RiffBot", hub: true },
      { id: "ui-bois", name: "UI Bois", standing: true },
      { id: "bug-chaser-2", name: "Bug Chaser", standing: true },
    ],
  };
  assert.equal(resolveQuickBugsLane(fallbackTeam)?.id, "bug-chaser-2");

  // Removed or non-standing bug-chaser lanes are ignored on fallback
  const ignoredTeam = {
    id: "efi",
    name: "Main Game Project",
    lanes: [
      { id: "bug-chaser-removed", name: "Old Bugs", standing: true, state: "removed" },
      { id: "bug-chaser-temp", name: "Temp Bugs", standing: false },
      { id: "sim-core", name: "Sim Core", standing: true },
    ],
  };
  assert.equal(resolveQuickBugsLane(ignoredTeam), null);
});

test("quickBugsChipState: derives pin, leadRunning (live role=lead running), and needsYou (countedItems from attentionItems)", () => {
  const team = {
    id: "vibesquad",
    name: "VibeSquad",
    color: "#b07cf5",
    paths: [],
    quickLanes: { bugs: "bug-chaser" },
    lanes: [
      { id: "vibesquad", name: "RiffBot", hub: true, state: "pinned" },
      { id: "bug-chaser", name: "Bug Chaser", standing: true, state: "pinned" },
    ],
  };
  const buddy = {
    agent: {
      id: "bs-bug",
      title: "Buddy · Bug Chaser",
      status: "idle",
      labels: { team: "vibesquad", lane: "bug-chaser", role: "brainstorm", "needs-you": "triage", "needs-you-reason": "check repro" },
    },
    team,
    laneId: "bug-chaser",
    kind: "brainstorm",
    agentType: "brainstorm",
    attention: { tone: "needs-you", reason: "check repro" },
  };
  const runningLead = {
    agent: {
      id: "lead-bug",
      title: "★ BUG1",
      status: "running",
      labels: { team: "vibesquad", lane: "bug-chaser", role: "lead" },
    },
    team,
    laneId: "bug-chaser",
    kind: "lead",
    agentType: "lead",
    attention: null,
  };
  const finishedWorker = {
    agent: {
      id: "w-bug-done",
      title: "Implement - fix",
      status: "idle",
      requiresAttention: true,
      attentionReason: "finished",
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker" },
    },
    team,
    laneId: "bug-chaser",
    kind: "worker",
    agentType: "implement",
    attention: { tone: "finished", reason: "finished" },
  };
  const permWorker = {
    agent: {
      id: "w-bug-perm",
      title: "Implement - perm",
      status: "running",
      pendingPermissions: [{ id: "p1" }],
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker" },
    },
    team,
    laneId: "bug-chaser",
    kind: "worker",
    agentType: "implement",
    attention: { tone: "permission", reason: "1 permission request(s)" },
  };

  const view = {
    team,
    members: [buddy, runningLead, finishedWorker, permWorker],
    lanes: [
      { lane: team.lanes[0], lead: null, duplicateLeads: [], brainstorm: null, duplicateBrainstorms: [], topicBrainstorms: [], members: [] },
      {
        lane: team.lanes[1],
        lead: runningLead,
        duplicateLeads: [],
        brainstorm: buddy,
        duplicateBrainstorms: [],
        topicBrainstorms: [],
        members: [buddy, runningLead, finishedWorker, permWorker],
      },
    ],
    needsYou: 2,
    running: 2,
    unsorted: [],
  };

  assert.equal(quickBugsPinForSquad(view)?.lane.id, "bug-chaser");
  const st = quickBugsChipState(view);
  assert.equal(st.pin?.lane.id, "bug-chaser");
  assert.equal(st.leadRunning, true);
  // finishedWorker does not count toward needsYou; buddy (label) + permWorker (permission) = 2
  assert.equal(st.needsYou, 2);

  // Idle lead -> leadRunning is false
  const idleLead = { ...runningLead, agent: { ...runningLead.agent, status: "idle" } };
  const idleView = {
    ...view,
    lanes: [view.lanes[0], { ...view.lanes[1], lead: idleLead, members: [buddy, idleLead] }],
  };
  const stIdle = quickBugsChipState(idleView);
  assert.equal(stIdle.leadRunning, false);
  assert.equal(stIdle.needsYou, 1);

  // Missing lane -> null pin, false leadRunning, 0 needsYou
  const emptyView = {
    team: { id: "efi", name: "Main Game Project", color: "#e8a33d", paths: [], lanes: [{ id: "efi", name: "RiffBot", hub: true }] },
    members: [],
    lanes: [{ lane: { id: "efi", name: "RiffBot", hub: true }, lead: null, duplicateLeads: [], brainstorm: null, duplicateBrainstorms: [], topicBrainstorms: [], members: [] }],
    needsYou: 0,
    running: 0,
    unsorted: [],
  };
  assert.deepEqual(quickBugsChipState(emptyView), { pin: null, leadRunning: false, needsYou: 0 });
});

test("createQuickBugsPin / createPin with standing+quickLane sets standing:true and quickLanes.bugs", async () => {
  let teams = [
    {
      id: "efi",
      name: "Main Game Project",
      color: "#e8a33d",
      paths: ["main-game"],
      lanes: [{ id: "efi", name: "RiffBot", hub: true, state: "pinned" }],
    },
    {
      id: "vibesquad",
      name: "VibeSquad",
      color: "#b07cf5",
      paths: ["VibeSquad"],
      lanes: [{ id: "bugs", name: "Bugs", state: "pinned" }],
    },
  ];
  const writes = [];
  const deps = {
    getTeams: () => teams,
    saveTeams: async (updater) => {
      teams = typeof updater === "function" ? updater(teams) : updater;
      return { disk: true };
    },
    fetch: async (url, init) => {
      if (init?.method === "POST") writes.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, revision: "r1" }) };
    },
  };

  const pin = await createQuickBugsPin("efi", deps);
  // "bugs" is already taken by vibesquad, so uniqueLaneId yields "bugs-2"
  assert.equal(pin.lane.id, "bugs-2");
  assert.equal(pin.lane.standing, true);
  assert.equal(pin.lane.state, "pinned");
  const efi = teams.find((t) => t.id === "efi");
  assert.deepEqual(efi.quickLanes, { bugs: "bugs-2" });
  assert.equal(efi.lanes.find((l) => l.id === "bugs-2")?.standing, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.laneId, "bugs-2");

  // Reopen path: if a done/removed lane with the same slug exists in the squad, createPin reopens it as standing and sets quickLanes.bugs
  let reopenTeams = [
    {
      id: "site",
      name: "Site",
      color: "#5cc9a7",
      paths: ["site"],
      lanes: [{ id: "site-bugs", name: "Bugs", state: "done", doneAt: "2026-11-01T00:00:00Z" }],
    },
  ];
  const reopened = await createPin("site", "Bugs", "Track site bugs", {
    standing: true,
    quickLane: "bugs",
    getTeams: () => reopenTeams,
    saveTeams: async (updater) => {
      reopenTeams = typeof updater === "function" ? updater(reopenTeams) : updater;
      return { disk: true };
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, content: "# Brief\n\n## Open\n- None.\n", revision: "r2" }) }),
  });
  assert.equal(reopened.lane.id, "site-bugs");
  assert.equal(reopened.lane.standing, true);
  assert.equal(reopened.lane.state, "pinned");
  assert.deepEqual(reopenTeams[0].quickLanes, { bugs: "site-bugs" });

  // patchQuickLanes helper preserves other teams and merges quickLanes
  const patched = patchQuickLanes(reopenTeams, "site", { bugs: "custom-bugs" });
  assert.deepEqual(patched[0].quickLanes, { bugs: "custom-bugs" });
});

test("snapChipSize & chipIconSrc: integer device-px snap at 4K@120%, 1080/100%, 1080/125%, 1080/150%, 1280/100%", () => {
  const cases = [
    [1.2, 1.0, 32],   // 4K @ 120% (zoom 1.0) -> 32 device px (26.67 CSS px)
    [1.2, 1.25, 32],  // 4K @ 120% (default UI 125%) -> 32 device px (21.33 CSS px)
    [1.0, 1.0, 32],   // 1080 / 1280 @ 100% -> 32 device px (32 CSS px)
    [1.0, 1.25, 32],  // 1080 @ UI 125% -> 32 device px (25.6 CSS px, never 38.4 CSS / 48 device)
    [1.25, 1.0, 32],  // 1080 @ OS 125% -> 32 device px (25.6 CSS px)
    [1.0, 1.5, 32],   // 1080 @ UI 150% -> 32 device px (21.33 CSS px)
    [1.2, 1.5, 48],   // 4K @ 120% + UI 150% -> 48 device px (26.67 CSS px, 3x of 16px native)
    [2.0, 1.0, 48],   // 2x dpr -> 48 device px (24 CSS px, 3x of 16px native)
  ];
  for (const [dpr, zoom, expectedDevice] of cases) {
    const { device, css } = snapChipSize(dpr, zoom);
    assert.equal(device, expectedDevice, `dpr=${dpr} zoom=${zoom}`);
    assert.equal(device % 16, 0);
    assert.ok(css <= 32 + 1e-3, `chip css ${css} must never exceed the 36px Squad header row`);
    assert.ok(whole(css * dpr * zoom), `css ${css} * ${dpr} * ${zoom} must land on whole device px`);
    const asset = chipIconSrc("bugs", "dark", device);
    const nativePx = asset.src.includes("@2x") ? 32 : 16;
    assert.equal(device % nativePx, 0, `${asset.src} (${nativePx}px) must divide ${device} device px by a whole integer`);
  }
  assert.equal(chipIconSrc("bugs", "dark", 32).src, "/ui/chip-bugs-dark@2x.png");
  assert.equal(chipIconSrc("bugs", "light", 32).src, "/ui/chip-bugs-light@2x.png");
  assert.equal(chipIconSrc("dot", "dark", 32).src, "/ui/chip-dot-dark@2x.png");
  assert.equal(chipIconSrc("bugs", "dark", 48).src, "/ui/chip-bugs-dark.png");
});

test("validateTeamsBody, PUT /api/teams, and mergeTeams preserve quickLanes and reject invalid shapes", async () => {
  validateTeamsBody([{ id: "vibesquad", quickLanes: { bugs: "bug-chaser" }, lanes: [] }]);
  assert.throws(() => validateTeamsBody([{ id: "vibesquad", quickLanes: ["bug-chaser"], lanes: [] }]), /quickLanes/);
  assert.throws(() => validateTeamsBody([{ id: "vibesquad", quickLanes: { bugs: "../bad" }, lanes: [] }]), /quickLanes/);

  // 3-way mergeTeams keeps quickLanes edits
  const base = [{ id: "efi", name: "EFI", lanes: [] }];
  const mine = [{ id: "efi", name: "EFI", quickLanes: { bugs: "efi-bugs" }, lanes: [] }];
  const fresh = [{ id: "efi", name: "EFI", color: "#e8a33d", lanes: [{ id: "cli", name: "CLI" }] }];
  assert.deepEqual(mergeTeams(base, mine, fresh), [
    { id: "efi", name: "EFI", color: "#e8a33d", quickLanes: { bugs: "efi-bugs" }, lanes: [{ id: "cli", name: "CLI" }] },
  ]);

  // Round-trip through writeTeamsRegistry (backing PUT /api/teams)
  const dir = mkdtempSync(join(tmpdir(), "vs-chips-c1-test-"));
  const repo = join(dir, "projects", "VibeSquad");
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(repo, { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = vsHome;
  const homeFile = join(vsHome, "teams.json");
  writeFileSync(homeFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [], paths: [] }] }, null, 2));
  try {
    const res = writeTeamsRegistry({ teams: [{ id: "vibesquad", name: "VibeSquad", quickLanes: { bugs: "bug-chaser" }, lanes: [], paths: [] }] }, repo);
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(readFileSync(homeFile, "utf8"));
    assert.deepEqual(onDisk.teams[0].quickLanes, { bugs: "bug-chaser" });
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QuickBugsChip UI wiring: A0 art assets exist, useImageOk skip-if-absent, pixelated CSS, and no per-project Workflows chip", () => {
  for (const key of ["bugs", "dot"]) {
    for (const theme of ["dark", "light"]) {
      for (const suffix of ["", "@2x"]) {
        const p = join(ROOT, "public", "ui", `chip-${key}-${theme}${suffix}.png`);
        assert.ok(fs.existsSync(p), `missing A0 chip asset ${p}`);
      }
    }
  }
  const pinGridSrc = readFileSync(join(SRC_DIR, "PinGrid.tsx"), "utf8");
  const appSrc = readFileSync(join(SRC_DIR, "App.tsx"), "utf8");
  const cssSrc = readFileSync(join(SRC_DIR, "styles.css"), "utf8");
  assert.match(pinGridSrc, /export function QuickBugsChip\b/);
  assert.match(pinGridSrc, /useImageOk\(bugsAsset\.src\)/);
  assert.match(pinGridSrc, /useImageOk\(dotAsset\.src\)/);
  assert.match(pinGridSrc, /squad-bugs-chip-\$\{view\.team\.id\}/);
  assert.match(pinGridSrc, /showPinToast\(`Could not start \$\{pin\.lane\.name\}/);
  assert.match(pinGridSrc, /showPinToast\(`Could not create Bugs team:/);
  assert.doesNotMatch(pinGridSrc, /squad-home-bugs-chip/);
  assert.doesNotMatch(pinGridSrc, /quick-chip-fallback|🐞/);
  assert.doesNotMatch(pinGridSrc, /QuickWorkflowsChip|squad-workflows-chip/);
  assert.doesNotMatch(appSrc, /<QuickBugsChip view=\{v\}/);
  assert.match(appSrc, /<QuickBugsChip view=\{view\} onOpen=\{props\.onQuickStart\} \/>/);
  assert.match(cssSrc, /\.quick-chip-img[\s\S]*?image-rendering:\s*pixelated/);
  assert.match(cssSrc, /\.quick-chip-dot\s*\{\s*position:\s*absolute;\s*inset:\s*0;\s*\}/);
  assert.doesNotMatch(cssSrc, /\.sidebar:not\(\.collapsed\)\s+\.team-head\s*>\s*\.badge/);
});
