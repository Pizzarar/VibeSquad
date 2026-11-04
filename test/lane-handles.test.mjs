import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findLaneInRegistry, formatLaneHandle } from "../server/identity.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");
const C = await import("../src/contextSources.ts");

// A small registry with `@hub`, `@bug` and `@ade` handles (stored codes).
const teams = [
  {
    id: "vibesquad",
    name: "VibeSquad",
    paths: [],
    lanes: [
      { id: "vibesquad", name: "VibeSquad", code: "Hub" },
      { id: "bug-chaser", name: "Bug Chaser", code: "Bug" },
      { id: "basic-ade", name: "Basic ADE", code: "ADE" },
    ],
  },
];

test("findLaneInRegistry resolves @bug / bug by lane code and formatLaneHandle returns the @handle", () => {
  const at = findLaneInRegistry("@bug", teams);
  assert.ok(at, "@bug resolves");
  assert.equal(at.team.id, "vibesquad");
  assert.equal(at.lane.id, "bug-chaser");

  const bare = findLaneInRegistry("bug", teams);
  assert.ok(bare, "bare code resolves");
  assert.equal(bare.lane.id, "bug-chaser");

  assert.equal(formatLaneHandle("bug-chaser", teams), "@bug");
  assert.equal(formatLaneHandle("@bug", teams), "@bug");
  assert.equal(formatLaneHandle("basic-ade", teams), "@ade");
  assert.equal(formatLaneHandle("vibesquad", teams), "@hub");
});

test("findLaneInRegistry still resolves by id, alias and name", () => {
  assert.equal(findLaneInRegistry("bug-chaser", teams).lane.id, "bug-chaser");
  assert.equal(findLaneInRegistry("Bug Chaser", teams).lane.id, "bug-chaser");
  assert.equal(findLaneInRegistry("basic-ade", teams).lane.id, "basic-ade");
});

test("laneMenuItems computes handles and filters by handle, code or name", () => {
  const lanes = [
    { id: "bug-chaser", name: "Bug Chaser", code: "Bug" },
    { id: "basic-ade", name: "Basic ADE", code: "ADE" },
    { id: "no-code", name: "Token Checker" },
  ];
  const all = C.laneMenuItems(lanes);
  assert.equal(all.length, 3);
  assert.deepEqual(all[0], { handle: "@bug", laneId: "bug-chaser", name: "Bug Chaser", hint: "Bug Chaser (bug-chaser)" });
  assert.equal(all[1].handle, "@ade");
  // No stored code: falls back to the id's first 3 letters.
  assert.equal(all[2].handle, "@no-");

  assert.deepEqual(C.laneMenuItems(lanes, "@bu").map((i) => i.laneId), ["bug-chaser"]);
  assert.deepEqual(C.laneMenuItems(lanes, "bug").map((i) => i.laneId), ["bug-chaser"]);
  assert.deepEqual(C.laneMenuItems(lanes, "chaser").map((i) => i.laneId), ["bug-chaser"]);
  assert.deepEqual(C.laneMenuItems(lanes, "ade").map((i) => i.laneId), ["basic-ade"]);
  assert.deepEqual(C.laneMenuItems(lanes, "nope").map((i) => i.laneId), []);
});

// ---------------------------------------------------------------------------
// CLI: vs spec / vs task resolve `@bug` -> bug-chaser
// ---------------------------------------------------------------------------

function makeCliEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-lane-handles-"));
  const vsHome = join(dir, ".vibesquad");
  const specRoot = join(dir, "spec-root");
  const paseoHome = join(dir, ".paseo");
  mkdirSync(vsHome, { recursive: true });
  mkdirSync(specRoot, { recursive: true });
  mkdirSync(join(paseoHome, "agents", "srv_test"), { recursive: true });
  const teamsFile = join(dir, "teams.json");
  writeFileSync(
    teamsFile,
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: [],
          lanes: [
            { id: "vibesquad", name: "VibeSquad", code: "Hub" },
            { id: "bug-chaser", name: "Bug Chaser", code: "Bug" },
          ],
        },
      ],
    }) + "\n",
    "utf8",
  );
  const baseEnv = () =>
    Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k)));
  return {
    dir,
    vsHome,
    specRoot,
    paseoHome,
    teamsFile,
    run(args) {
      return spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...baseEnv(),
          VIBESQUAD_HOME: vsHome,
          VIBESQUAD_ROOT: specRoot,
          VIBESQUAD_TEAMS_FILE: teamsFile,
          PASEO_HOME: paseoHome,
        },
      });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("vs spec show --lane @bug and vs task list --lane @bug resolve the bug-chaser lane", () => {
  const env = makeCliEnv();
  try {
    // spec write via the handle lands in the bug-chaser lane's artifact dir
    const w = env.run(["spec", "write", "handle spec", "--lane", "@bug"]);
    assert.equal(w.status, 0, w.stderr);
    assert.equal(w.stdout.trim(), join(env.specRoot, "docs", "lanes", "bug-chaser", "SPEC.md"));
    assert.equal(readFileSync(join(env.specRoot, "docs", "lanes", "bug-chaser", "SPEC.md"), "utf8"), "handle spec");

    // spec show via the handle reads the same lane
    const s = env.run(["spec", "show", "--lane", "@bug"]);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, "handle spec\n");

    // task list via the handle (and via the bare code) reads bug-chaser's board
    const set = env.run(["task", "set", "u1", "--goal", "build", "--lane", "@bug"]);
    assert.equal(set.status, 0, set.stderr);

    const list = env.run(["task", "list", "--lane", "@bug", "--json"]);
    assert.equal(list.status, 0, list.stderr);
    const board = JSON.parse(list.stdout);
    assert.equal(board.path, "docs/lanes/bug-chaser/TASKS.json");
    assert.equal(board.units.length, 1);
    assert.equal(board.units[0].id, "u1");

    const bare = env.run(["task", "list", "--lane", "bug", "--json"]);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(JSON.parse(bare.stdout).path, "docs/lanes/bug-chaser/TASKS.json");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Source checks: the @handle badge is rendered in the sidebar, grid, and focus bar
// ---------------------------------------------------------------------------

test("PinGrid and PinRail render pin-lane-handle / pin-focus-handle badges", () => {
  const grid = readFileSync(new URL("../src/PinGrid.tsx", import.meta.url), "utf8");
  assert.match(grid, /laneCodeFor/, "PinGrid imports laneCodeFor");
  assert.match(grid, /pin-lane-handle/, "PinGrid renders the handle badge");
  assert.match(grid, /data-testid=\{`pin-handle-\$\{pin\.lane\.id\}`\}/, "sidebar row handle testid");

  const rail = readFileSync(new URL("../src/PinRail.tsx", import.meta.url), "utf8");
  assert.match(rail, /laneCodeFor/, "PinRail imports laneCodeFor");
  assert.match(rail, /pin-lane-handle/, "PinRail renders the handle badge");
  assert.match(rail, /data-testid="pin-focus-handle"/, "focus bar handle testid");
});
