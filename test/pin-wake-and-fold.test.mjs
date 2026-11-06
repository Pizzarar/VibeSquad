import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(ROOT_DIR, "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(SRC_DIR).href)) {
      if (specifier === "./paseo" || specifier === "./PinGrid" || specifier === "./ui" || specifier === "./IdeaInbox") {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const tsCandidate = resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(tsCandidate)) {
        return nextResolve(pathToFileURL(tsCandidate).href, context);
      }
      const tsxCandidate = resolve(parentDir, `${specifier}.tsx`);
      if (fs.existsSync(tsxCandidate)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function stubFor(specifier) {
  if (specifier === "./paseo") {
    return [
      "export const DEMO = false;",
      "export const getPaseoState = () => ({ conn: 'connected', agents: new Map() });",
      "export const subscribePaseo = () => () => {};",
      "export const archiveAgent = async () => {};",
      "export const archiveWorkspace = async () => {};",
      "export const detachAgent = async () => {};",
      "export const retireAgent = async () => {};",
      "export const sendMessage = async () => {};",
      "export const updateAgent = async () => {};",
      "export const upsertLocalAgent = () => {};",
    ].join("\n");
  }
  if (specifier === "./IdeaInbox") {
    return `export const parkIdeasInInbox = async () => {};`;
  }
  return `export {};`;
}

const pinActionsMod = await import("../src/pinActions.ts");

function loadDescribeIdeaAction() {
  const src = fs.readFileSync(resolve(SRC_DIR, "PinIdeas.tsx"), "utf8");
  const match = src.match(/export function describeIdeaAction\([\s\S]*?\r?\n\}(?=\r?\n)/);
  assert.ok(match, "describeIdeaAction found in src/PinIdeas.tsx");
  const bodyStart = match[0].indexOf('if (opts.mode === "new")');
  assert.ok(bodyStart > 0, "describeIdeaAction body found");
  const jsBody = `return function describeIdeaAction(opts) {\n  ${match[0].slice(bodyStart)}`;
  return new Function("DEFAULT_PIN_PROFILE", jsBody)(pinActionsMod.DEFAULT_PIN_PROFILE);
}

test("(1) sendIdeaToTeam on a sleeping pinned lane wakes Buddy via openPin and sends the message", async () => {
  const teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      color: "#b07cf5",
      paths: [],
      lanes: [
        { id: "android-app", name: "Android App", code: "And", state: "pinned", standing: true },
      ],
    },
  ];
  const woken = [];
  const sent = [];
  const parked = [];

  const toast = await pinActionsMod.sendIdeaToTeam("android-app", "Add offline caching for APK downloads", "RiffBot", {
    agents: new Map(),
    getTeams: () => teams,
    openPin: async (pin) => {
      woken.push(pin.lane.id);
      return "woken-buddy-1";
    },
    send: async (agentId, text) => {
      sent.push({ agentId, text });
    },
    park: async (payload) => {
      parked.push(payload);
    },
  });

  assert.equal(toast, "Sent to Android App");
  assert.deepEqual(woken, ["android-app"]);
  assert.equal(parked.length, 0);
  assert.deepEqual(sent, [
    {
      agentId: "woken-buddy-1",
      text: "Idea sent over from RiffBot:\n\nAdd offline caching for APK downloads",
    },
  ]);
});

test("(2) sendIdeaToTeam resolves target lane by alias (bug-chaser-2 or bugc -> bug-chaser)", async () => {
  const teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      color: "#b07cf5",
      paths: [],
      lanes: [
        {
          id: "bug-chaser",
          name: "Bug Chaser",
          code: "Bug",
          state: "pinned",
          standing: true,
          aliases: ["bug-chaser-2", "bugc"],
        },
      ],
    },
  ];

  for (const alias of ["bug-chaser-2", "bugc"]) {
    const woken = [];
    const sent = [];
    const toast = await pinActionsMod.sendIdeaToTeam(alias, `Fix from ${alias}`, undefined, {
      agents: new Map(),
      getTeams: () => teams,
      openPin: async (pin) => {
        woken.push(pin.lane.id);
        return `bs-${pin.lane.id}`;
      },
      send: async (agentId, text) => {
        sent.push({ agentId, text });
      },
      park: async () => {
        throw new Error("should not park");
      },
    });
    assert.equal(toast, "Sent to Bug Chaser");
    assert.deepEqual(woken, ["bug-chaser"]);
    assert.deepEqual(sent, [{ agentId: "bs-bug-chaser", text: `Fix from ${alias}` }]);
  }
});

test("(3) sendIdeaToTeam on unknown, done, removed, or when openPin throws parks in Inbox", async () => {
  const teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      color: "#b07cf5",
      paths: [],
      lanes: [
        { id: "ui-polish", name: "UI Polish", state: "done" },
        { id: "paseo-parity", name: "Paseo Parity", state: "removed" },
        { id: "ui-bois", name: "UI Bois", state: "pinned" },
      ],
    },
  ];

  // Unknown lane
  const parkedUnknown = [];
  const resUnknown = await pinActionsMod.sendIdeaToTeam("nonexistent", "mystery idea", undefined, {
    agents: new Map(),
    getTeams: () => teams,
    park: async (p) => parkedUnknown.push(p),
  });
  assert.equal(resUnknown, "Parked in the inbox");
  assert.equal(parkedUnknown.length, 1);
  assert.equal(parkedUnknown[0].laneId, undefined);

  // Done lane does not auto-wake
  let openCalled = false;
  const parkedDone = [];
  const resDone = await pinActionsMod.sendIdeaToTeam("ui-polish", "tweak border", undefined, {
    agents: new Map(),
    getTeams: () => teams,
    openPin: async () => {
      openCalled = true;
      return "bs-1";
    },
    park: async (p) => parkedDone.push(p),
  });
  assert.equal(openCalled, false);
  assert.equal(resDone, "Parked in UI Polish's inbox");
  assert.equal(parkedDone[0].laneId, "ui-polish");

  // Removed lane does not auto-wake
  const parkedRemoved = [];
  const resRemoved = await pinActionsMod.sendIdeaToTeam("paseo-parity", "old parity note", undefined, {
    agents: new Map(),
    getTeams: () => teams,
    openPin: async () => {
      openCalled = true;
      return "bs-2";
    },
    park: async (p) => parkedRemoved.push(p),
  });
  assert.equal(openCalled, false);
  assert.equal(resRemoved, "Parked in Paseo Parity's inbox");
  assert.equal(parkedRemoved[0].laneId, "paseo-parity");

  // Pinned lane where openPin throws falls back to parking in team inbox
  const parkedThrow = [];
  const resThrow = await pinActionsMod.sendIdeaToTeam("ui-bois", "floor layout", undefined, {
    agents: new Map(),
    getTeams: () => teams,
    openPin: async () => {
      throw new Error("daemon offline");
    },
    park: async (p) => parkedThrow.push(p),
  });
  assert.equal(resThrow, "Parked in UI Bois' inbox");
  assert.equal(parkedThrow[0].laneId, "ui-bois");
});

test("(4) describeIdeaAction returns 'Wakes <Team>'s Buddy and sends your idea.' for a sleeping pinned team", () => {
  const describeIdeaAction = loadDescribeIdeaAction();
  assert.equal(
    describeIdeaAction({
      mode: "existing",
      teamName: "",
      profile: "Brainstorm - Claude",
      targetPin: { lane: { name: "Android App" }, brainstorm: null },
    }),
    "Wakes Android App's Buddy and sends your idea.",
  );
  assert.equal(
    describeIdeaAction({
      mode: "existing",
      teamName: "",
      profile: "Brainstorm - Claude",
      targetPin: { lane: { name: "Android App" }, brainstorm: { agent: { id: "bs-1" } } },
    }),
    "Goes to Android App's Buddy.",
  );
  assert.equal(
    describeIdeaAction({
      mode: "existing",
      teamName: "",
      profile: "Brainstorm - Claude",
      targetPin: null,
    }),
    "Goes to team's inbox (no Buddy live).",
  );
});

test("(5) createPin and vs pin new reopen a same-squad done or removed lane instead of creating -2", async () => {
  let teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      color: "#b07cf5",
      paths: [],
      lanes: [
        {
          id: "bug-chaser",
          name: "Bug Chaser",
          code: "Bug",
          state: "removed",
          removedAt: "2026-11-03T19:23:24.745Z",
          aliases: ["bugc"],
        },
      ],
    },
  ];
  let savedBrief = [
    "# Brainstorm Summary · BUG CHASER (`bug-chaser`)",
    "",
    "## Decided",
    "- Keep existing decisions.",
    "",
    "## Open",
    "- None.",
    "",
    "## In flight",
    "- None.",
    "",
  ].join("\n");

  const pin = await pinActionsMod.createPin("vibesquad", "Bug Chaser", "chase spawn hang\nand shim", {
    getTeams: () => teams,
    saveTeams: async (updater) => {
      teams = updater(teams);
    },
    lastProfile: "Brainstorm - Gemini",
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        savedBrief = body.content;
        return new Response(JSON.stringify({ ok: true, revision: "r2" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, content: savedBrief, revision: "r1" }), { status: 200 });
    },
  });

  assert.equal(pin.lane.id, "bug-chaser");
  assert.equal(teams[0].lanes.length, 1);
  assert.equal(teams[0].lanes[0].id, "bug-chaser");
  assert.equal(teams[0].lanes[0].state, "pinned");
  assert.equal(teams[0].lanes[0].removedAt, undefined);
  assert.equal(teams[0].lanes[0].lastProfile, "Brainstorm - Gemini");
  assert.deepEqual(teams[0].lanes[0].aliases, ["bugc"]);
  assert.match(savedBrief, /Keep existing decisions\./);
  assert.match(savedBrief, /## Open\n- chase spawn hang\n  and shim\n/);
  assert.doesNotMatch(savedBrief, /## Open\n- None\./);
});

test("(6) vs pin merge adds fromLane.id + code to intoLane.aliases and sets fromLane.state = 'removed'", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "vs-pin-merge-fold-"));
  try {
    const home = join(dir, "home");
    const root = join(dir, "root");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
    fs.writeFileSync(
      join(home, "teams.json"),
      JSON.stringify({
        teams: [
          {
            id: "vibesquad",
            name: "VibeSquad",
            paths: [],
            lanes: [
              { id: "bug-chaser", name: "Bug Chaser", code: "Bug", state: "pinned" },
              { id: "bug-chaser-2", name: "Bug Chaser 2", code: "Bugc", state: "pinned", aliases: ["bc2"] },
            ],
          },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(
      join(root, "docs", "brainstorm", "bug-chaser.md"),
      "# Brainstorm Summary · BUG CHASER (`bug-chaser`)\n\n## Decided\n- d1\n\n## Open\n- o1\n",
      "utf8",
    );
    fs.writeFileSync(
      join(root, "docs", "brainstorm", "bug-chaser-2.md"),
      "# Brainstorm Summary · BUG CHASER 2 (`bug-chaser-2`)\n\n## Decided\n- d2\n\n## Open\n- o2\n",
      "utf8",
    );

    const env = { ...process.env, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: root, PASEO_AGENT_ID: "" };
    const res = spawnSync(
      process.execPath,
      ["cli/vs.mjs", "pin", "merge", "bug-chaser-2", "bug-chaser", "--note", "fold duplicate", "--team", "vibesquad"],
      { cwd: ROOT_DIR, env, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /marked bug-chaser-2 removed/);

    const updated = JSON.parse(fs.readFileSync(join(home, "teams.json"), "utf8"));
    const into = updated.teams[0].lanes.find((l) => l.id === "bug-chaser");
    const from = updated.teams[0].lanes.find((l) => l.id === "bug-chaser-2");
    assert.equal(from.state, "removed");
    assert.ok(from.removedAt);
    assert.equal("doneAt" in from, false);
    assert.deepEqual(into.aliases, ["bug-chaser-2", "bugc", "bc2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(7) teams.json (and ~/.vibesquad/teams.json if present) has valid JSON (no BOM), folded aliases, and standing flags", () => {
  const paths = [resolve(ROOT_DIR, "teams.json")];
  const homeTeams = join(homedir(), ".vibesquad", "teams.json");
  if (fs.existsSync(homeTeams)) paths.push(homeTeams);

  const expectedStanding = {
    vibesquad: ["art-direction", "token-checker", "android-app", "quickstart", "release-desk", "ui-bois", "bug-chaser", "squadbot"],
    efi: ["sim-core", "economy-balance", "ui-raid", "ui-shell-hideout", "ui-screens", "art-pipeline", "platform-qa-security"],
    "team-squadz-meet": ["mesh-certs", "homeserver-voice", "soundboard-bots", "game-streaming", "channels-client-ux"],
  };

  for (const p of paths) {
    const buf = fs.readFileSync(p);
    assert.notEqual(buf[0], 0xef, `${p} must not start with UTF-8 BOM`);
    const doc = JSON.parse(buf.toString("utf8"));
    const vs = doc.teams.find((t) => t.id === "vibesquad");
    assert.ok(vs, `vibesquad exists in ${p}`);
    assert.equal(vs.lanes.some((l) => l.id === "bug-chaser-2"), false, `bug-chaser-2 removed from ${p}`);
    assert.equal(vs.lanes.some((l) => l.id === "quickstart-2"), false, `quickstart-2 renamed in ${p}`);

    const bug = vs.lanes.find((l) => l.id === "bug-chaser");
    assert.ok(bug, `bug-chaser exists in ${p}`);
    assert.equal(bug.state, "pinned");
    assert.equal(bug.standing, true);
    assert.deepEqual(bug.aliases, ["bug-chaser-2", "bugc"]);
    assert.equal("removedAt" in bug, false);

    const qui = vs.lanes.find((l) => l.id === "quickstart");
    assert.ok(qui, `quickstart exists in ${p}`);
    assert.equal(qui.state, "pinned");
    assert.equal(qui.standing, true);
    assert.deepEqual(qui.aliases, ["quickstart-2"]);

    for (const [teamId, laneIds] of Object.entries(expectedStanding)) {
      const team = doc.teams.find((t) => t.id === teamId);
      assert.ok(team, `${teamId} exists in ${p}`);
      for (const laneId of laneIds) {
        const lane = team.lanes.find((l) => l.id === laneId);
        assert.ok(lane, `${teamId}.${laneId} exists in ${p}`);
        assert.equal(lane.standing, true, `${teamId}.${laneId} has standing: true in ${p}`);
      }
    }
  }
});
