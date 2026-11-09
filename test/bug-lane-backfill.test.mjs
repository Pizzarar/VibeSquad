// Every Squad gets its hidden Bug Runner lane (G1) and agents can file into their own Squad's bug lane (G2).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backfillBugLanes, persistBugLaneBackfill } from "../server/bug-lane-backfill.mjs";
import { findBugLane } from "../server/identity.mjs";

const CLI = fileURLToPath(new URL("../cli/vs.mjs", import.meta.url));
const squad = (id, extra = []) => ({ id, name: id, lanes: [{ id, name: id, hub: true, state: "pinned" }, ...extra] });
const fixture = () => [
  squad("vibesquad", [{ id: "bug-chaser", name: "Bug Chaser", state: "pinned" }]),
  squad("efi"),
  squad("squadz-meet", [{ id: "bug-runner", name: "Not a bug lane", kind: "audit" }]),
  squad("rosser"),
];

test("backfill adds exactly one hidden bug lane to Squads without one, none to VibeSquad, never an audit lane", () => {
  const before = fixture();
  const after = backfillBugLanes(before);
  assert.strictEqual(after[0], before[0], "VibeSquad (bug-chaser fallback) is untouched");
  for (const t of after) assert.equal(t.lanes.filter((l) => l.kind === "bug" || l.id === "bug-chaser").length, 1, t.id);
  const ids = after.flatMap((t) => t.lanes.filter((l) => l.kind === "bug").map((l) => l.id));
  assert.equal(new Set(ids).size, ids.length, "ids unique across Squads");
  assert.deepEqual(ids, ["bug-runner-2", "bug-runner-3", "bug-runner-4"]);
  const lane = findBugLane(after[1]);
  assert.deepEqual({ kind: lane.kind, hidden: lane.hidden, standing: lane.standing, name: lane.name }, { kind: "bug", hidden: true, standing: true, name: "Bug Runner" });
  assert.ok(lane.code, "code frozen");
  for (const [i, t] of after.entries()) assert.equal(t.lanes.filter((l) => l.kind === "audit").length, before[i].lanes.filter((l) => l.kind === "audit").length, `no audit lane added to ${t.id}`);
  assert.equal(after[2].lanes.length, 3, "a non-bug lane squatting the id is not mistaken for a bug lane");
  assert.notEqual(findBugLane(after[2]).id, "bug-runner");
  assert.strictEqual(backfillBugLanes(after), after, "second pass changes nothing");
});

test("persist: first load writes once, second load adds nothing", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-bug-backfill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "teams.json");
  writeFileSync(file, JSON.stringify({ teams: fixture(), leadFlagTokens: 111 }));
  const prev = process.env.VIBESQUAD_TEAMS_FILE;
  process.env.VIBESQUAD_TEAMS_FILE = file;
  t.after(() => (prev === undefined ? delete process.env.VIBESQUAD_TEAMS_FILE : (process.env.VIBESQUAD_TEAMS_FILE = prev)));
  const first = persistBugLaneBackfill(dir);
  assert.equal(first.changed, true);
  assert.deepEqual(first.added.map((a) => a.team), ["efi", "squadz-meet", "rosser"]);
  const once = readFileSync(file, "utf8");
  assert.equal(JSON.parse(once).leadFlagTokens, 111, "other top-level keys kept");
  assert.equal(persistBugLaneBackfill(dir).changed, false);
  assert.equal(readFileSync(file, "utf8"), once);
});

test("vs inbox add --lane bug files into the caller's Squad bug lane; the explicit id works too", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-bug-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "teams.json");
  const teams = backfillBugLanes(fixture());
  writeFileSync(file, JSON.stringify({ teams }));
  const efiBug = findBugLane(teams[1]).id;
  const env = { ...process.env, VIBESQUAD_HOME: dir, VIBESQUAD_TEAMS_FILE: file, VS_TEAM: "efi", VS_LANE: "", VS_AGENT_ID: "", PASEO_AGENT_ID: "" };
  const run = (...args) => spawnSync(process.execPath, [CLI, "inbox", ...args], { encoding: "utf8", env });
  assert.equal(run("add", "alias thing", "--lane", "bug").status, 0);
  assert.equal(run("add", "explicit thing", "--lane", efiBug).status, 0);
  const list = JSON.parse(run("list", "--json", "--lane", "bug").stdout);
  assert.deepEqual(list.map((c) => [c.text, c.laneId]), [["alias thing", efiBug], ["explicit thing", efiBug]]);
  assert.equal(JSON.parse(run("list", "--json", "--lane", "bug-chaser").stdout).length, 0, "VibeSquad's lane not bumped");
  const noBug = spawnSync(process.execPath, [CLI, "inbox", "add", "x", "--lane", "bug"], { encoding: "utf8", env: { ...env, VS_TEAM: "nope-squad" } });
  assert.notEqual(noBug.status, 0, "unknown Squad does not silently file into a wrong lane");
});
