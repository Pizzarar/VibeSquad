// PLAN_HUB_BUDDY block 2: hub rules live in HUB_BUDDY_RULES and reach only the hub Buddy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAINSTORM_PACK, HUB_BUDDY_RULES, VIBE_MODE_BUDDY_RULES, createPlugin, injectedPrefix, isHubCwd, rolePack } from "../plugin/index.server.ts";
import { buildBrainstormInitialPrompt } from "../server/brainstorm.mjs";
import { BRAINSTORM_NOTE_BODY } from "../server/profiles.mjs";

test("topic Buddy pack has no hub rules; hub Buddy pack appends them", () => {
  assert.doesNotMatch(BRAINSTORM_PACK, /hub chat|vs:spin-off|Open threads/);
  assert.equal(rolePack("brainstorm", ""), BRAINSTORM_PACK);
  assert.equal(rolePack("brainstorm", "", false, false), BRAINSTORM_PACK);
  const hub = rolePack("brainstorm", "", false, true);
  assert.equal(hub, `${BRAINSTORM_PACK}\n${HUB_BUDDY_RULES}`);
  assert.match(hub, /Open threads:/);
  assert.match(hub, /```vs:spin-off/);
  assert.match(injectedPrefix("brainstorm", "", false, true), /Open threads:/);
  assert.doesNotMatch(injectedPrefix("brainstorm", "", false, false), /Open threads:/);
  console.log(`hub pack char delta: +${hub.length - BRAINSTORM_PACK.length}`);
});

test("hub rules come after vibe rules; other roles ignore isHub", () => {
  assert.equal(rolePack("brainstorm", "", true, true), `${BRAINSTORM_PACK}\n${VIBE_MODE_BUDDY_RULES}\n${HUB_BUDDY_RULES}`);
  assert.equal(rolePack("worker", "", false, true), rolePack("worker", ""));
  assert.equal(rolePack("lead", "", false, true), rolePack("lead", ""));
});

test("isHubCwd matches isHubLane: explicit flag, id fallback, no fallback when another lane is flagged", () => {
  const plain = { id: "sq", lanes: [{ id: "sq" }, { id: "a" }] };
  assert.equal(isHubCwd(plain, "sq"), true);
  assert.equal(isHubCwd(plain, "a"), false);
  const flagged = { id: "sq", lanes: [{ id: "sq" }, { id: "a", hub: true }] };
  assert.equal(isHubCwd(flagged, "a"), true);
  assert.equal(isHubCwd(flagged, "sq"), false);
  assert.equal(isHubCwd(undefined, "sq"), false);
  assert.equal(isHubCwd(plain, "nope"), false);
});

test("boot prompt omits vs:looks-done for the hub only", () => {
  const args = { laneId: "sq", laneUpper: "SQ", buddyName: "SQ Buddy", summaryContent: "brief", latestPlan: "none" };
  assert.match(buildBrainstormInitialPrompt(args), /vs:looks-done/);
  const hub = buildBrainstormInitialPrompt({ ...args, hubTeams: "Teams in this Squad:\n- (none)" });
  assert.doesNotMatch(hub, /vs:looks-done|looks done/);
  assert.match(hub, /Never mark the hub done/);
});

test("lane Buddy started in repo root does not get HUB_BUDDY_RULES; hub Buddy does", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-hub-pack-"));
  const prev = { h: process.env.VIBESQUAD_HOME, t: process.env.VIBESQUAD_TEAMS_FILE };
  const home = join(dir, "h");
  mkdirSync(home, { recursive: true });
  const teamsFile = join(home, "teams.json");
  writeFileSync(
    teamsFile,
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          lanes: [
            { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad", "vibesquad-"] },
            { id: "pinned", name: "Pinned Teams" },
          ],
          paths: ["VibeSquad", "vibesquad-"],
        },
      ],
    }),
    "utf8",
  );
  process.env.VIBESQUAD_HOME = home;
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;

  const before = new Map();
  const stop = createPlugin({ startWatcher: false, briefRoot: home })({
    before: (n, f) => (before.set(n, f), () => {}),
    on: () => () => {},
  });
  const ROOT = "/work/VibeSquad";
  const create = (config, env, labels) => {
    const req = { config: { cwd: ROOT, ...config }, ...(env ? { env } : {}), ...(labels ? { labels } : {}) };
    return before.get("agent.create")({ request: req }) ?? req;
  };

  try {
    // Case A: pin spawn in repo root; lane comes from env.VS_LANE, not cwd.
    const a = create(
      { provider: "claude", model: "claude-opus-5-5", title: "Rel Buddy" },
      { VS_ROLE: "brainstorm", VS_LANE: "release-0-2-0", VS_TEAM: "vibesquad", VS_BRIEF_INLINE: "1" },
    );
    const sysA = String(a.config.systemPrompt ?? "");
    assert.ok(sysA.includes(BRAINSTORM_PACK), "lane Buddy keeps BRAINSTORM_PACK");
    assert.ok(!sysA.includes(HUB_BUDDY_RULES), "lane Buddy must not get HUB_BUDDY_RULES");
    assert.doesNotMatch(sysA, /Never spawn a Lead/);
    assert.doesNotMatch(sysA, /Open threads:/);

    // Case B: label-only spawn; no lane anywhere, cwd fallback must not mark it hub.
    const b = create(
      { provider: "claude", model: "claude-opus-5-5", title: "Rel Buddy" },
      { VS_ROLE: "brainstorm" },
    );
    const sysB = String(b.config.systemPrompt ?? "");
    assert.ok(!sysB.includes(HUB_BUDDY_RULES));
    assert.doesNotMatch(sysB, /Never spawn a Lead/);

    // Case C: explicit labels for an unregistered lane in repo root.
    const c = create(
      { provider: "claude", model: "claude-opus-5-5", title: "Rel Buddy" },
      undefined,
      { role: "brainstorm", lane: "release-0-2-0", team: "vibesquad" },
    );
    const sysC = String(c.config.systemPrompt ?? "");
    assert.ok(!sysC.includes(HUB_BUDDY_RULES));
    assert.doesNotMatch(sysC, /Never spawn a Lead/);

    // Case D: hub Buddy pin spawn in repo root (env.VS_LANE is the hub lane).
    const d = create(
      { provider: "claude", model: "claude-opus-5-5", title: "RiffBot" },
      { VS_ROLE: "brainstorm", VS_LANE: "vibesquad", VS_TEAM: "vibesquad", VS_BRIEF_INLINE: "1" },
    );
    const sysD = String(d.config.systemPrompt ?? "");
    assert.ok(sysD.includes(HUB_BUDDY_RULES), "hub Buddy must get HUB_BUDDY_RULES");
    assert.match(sysD, /Never spawn a Lead/);
  } finally {
    stop?.();
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_TEAMS_FILE", prev.t]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lane Buddies may spawn leads (including in parallel) when a lane has none; only HUB_BUDDY_RULES forbids spawning a Lead", () => {
  assert.match(BRAINSTORM_PACK, /spawn one.*parallel|spawn leads.*parallel/i);
  assert.doesNotMatch(BRAINSTORM_PACK, /Never spawn a Lead/);
  assert.match(HUB_BUDDY_RULES, /Never spawn a Lead/);
  assert.ok(
    BRAINSTORM_NOTE_BODY.includes(
      "Starting agents: you may spawn leads (including several in parallel) when a lane has none; other agents (tooling, research, prototypes) only when the owner asks.",
    ),
    "BRAINSTORM_NOTE_BODY allows spawning leads",
  );
  assert.doesNotMatch(BRAINSTORM_NOTE_BODY, /Starting agents: only when the owner asks/);
});
