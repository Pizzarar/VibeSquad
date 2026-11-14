// Every Squad gets its hidden Bug Runner lane (G1) and agents can file into their own Squad's bug lane (G2).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildNewSquadTeamDef, withBugLane } from "../src/newSquadDef.ts";
import { TEMPLATE_DEFAULTS, backfillBugLanes, diffAgainstTemplate, persistTemplateReconcile } from "../server/bug-lane-backfill.mjs";
import { findBugLane, findLaneInRegistry } from "../server/identity.mjs";
import { writeTeamsRegistry } from "../server/teams-file.mjs";

const NL = String.fromCharCode(10);
const CLI = fileURLToPath(new URL("../cli/vs.mjs", import.meta.url));
const squad = (id, extra = []) => ({ id, name: id, lanes: [{ id, name: id, hub: true, state: "pinned" }, ...extra] });
const fixture = () => [
  squad("vibesquad", [{ id: "bug-chaser", name: "Bug Chaser", state: "pinned" }]),
  squad("efi"),
  squad("squadz-meet", [{ id: "bug-runner", name: "Not a bug lane", kind: "audit" }]),
  squad("rosser"),
];

test("backfill adds exactly one hidden bug lane and one Perfection lane per Squad lacking them; VibeSquad's bug-chaser is kept", () => {
  const before = fixture();
  const after = backfillBugLanes(before);
  assert.equal(after[0].lanes.filter((l) => l.kind === "bug" || l.id === "bug-chaser").length, 1, "no second bug lane next to bug-chaser");
  assert.deepEqual(after[0].lanes.map((l) => l.id), ["vibesquad", "bug-chaser", "perfection"]);
  for (const t of after) {
    assert.equal(t.lanes.filter((l) => l.kind === "bug" || l.id === "bug-chaser").length, 1, `${t.id} bug`);
    assert.equal(t.lanes.filter((l) => l.kind === "audit").length, 1, `${t.id} audit`);
  }
  const all = after.flatMap((t) => t.lanes.map((l) => l.id));
  assert.equal(new Set(all).size, all.length, "lane ids unique across Squads");
  assert.deepEqual(after.flatMap((t) => t.lanes.filter((l) => l.kind === "bug").map((l) => l.id)), ["bug-runner-2", "bug-runner-3", "bug-runner-4"]);
  const lane = findBugLane(after[1]);
  assert.deepEqual({ kind: lane.kind, hidden: lane.hidden, standing: lane.standing, name: lane.name }, { kind: "bug", hidden: true, standing: true, name: "Bug Runner" });
  assert.ok(lane.code, "code frozen");
  assert.notEqual(findBugLane(after[2]).id, "bug-runner", "a non-bug lane squatting the id is not mistaken for a bug lane");
  assert.strictEqual(backfillBugLanes(after), after, "second pass changes nothing");
});

test("G3 auto path: fills only missing template fields, never overwrites user values", () => {
  const user = { ...squad("mine"), color: "#ff0000", leadFlagTokens: 1234, brainstormWarnTokens: 0, paths: ["mine"] };
  const { next, auto } = diffAgainstTemplate(user, [user]);
  assert.equal(next.color, "#ff0000");
  assert.equal(next.leadFlagTokens, 1234);
  assert.equal(next.brainstormWarnTokens, 0, "falsy user value kept");
  assert.equal(next.leadHardCapTokens, TEMPLATE_DEFAULTS.leadHardCapTokens, "missing field filled");
  assert.deepEqual(auto.map((a) => a.rule).sort(), ["add-audit-lane", "add-brainstormRestartTokens", "add-bug-lane", "add-leadAutoHandoffTokens", "add-leadHardCapTokens"]);
  assert.ok(next.lanes.every((l) => l.code));
});

test("G3 matches the TS template: a fresh buildNewSquadTeamDef has no auto drift", () => {
  const fresh = buildNewSquadTeamDef({ id: "fresh", name: "Fresh", folderPath: "C:/x/fresh", existingTeams: [] });
  const d = diffAgainstTemplate(fresh, [fresh]);
  assert.deepEqual(d.auto, []);
  assert.deepEqual(d.logOnly, []);
  assert.strictEqual(d.next, fresh);
  for (const k of Object.keys(TEMPLATE_DEFAULTS)) assert.equal(fresh[k], TEMPLATE_DEFAULTS[k], k);
  const before = fixture();
  const viaTs = withBugLane(before[1], before);
  const viaMjs = diffAgainstTemplate(before[1], before).next;
  assert.deepEqual(viaMjs.lanes, viaTs.lanes, "TS withBugLane and the server reconcile seed identical lanes");
});

test("persist: first load writes once and logs leftover drift once; second load adds and logs nothing", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-bug-backfill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "teams.json");
  const teams = [...fixture(), { id: "bare", name: "bare", lanes: [{ id: "x", name: "X" }] }];
  writeFileSync(file, JSON.stringify({ teams, leadFlagTokens: 111 }));
  const prev = { f: process.env.VIBESQUAD_TEAMS_FILE, h: process.env.VIBESQUAD_HOME };
  process.env.VIBESQUAD_TEAMS_FILE = file;
  process.env.VIBESQUAD_HOME = dir;
  t.after(() => { for (const [k, v] of [["VIBESQUAD_TEAMS_FILE", prev.f], ["VIBESQUAD_HOME", prev.h]]) v === undefined ? delete process.env[k] : (process.env[k] = v); });
  const first = await persistTemplateReconcile(dir);
  assert.equal(first.changed, true);
  assert.deepEqual([...new Set(first.auto.filter((a) => a.rule === "add-bug-lane").map((a) => a.team))], ["efi", "squadz-meet", "rosser", "bare"]);
  const once = readFileSync(file, "utf8");
  assert.equal(JSON.parse(once).leadFlagTokens, 111, "other top-level keys kept");
  const log = readFileSync(path.join(dir, "teams", "bare", "log.jsonl"), "utf8").trim().split(NL).map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].type, "metric");
  assert.match(log[0].text, /^template-drift: bare .*no-hub-lane,no-paths/);
  const second = await persistTemplateReconcile(dir);
  assert.equal(second.changed, false);
  assert.deepEqual(second.auto, []);
  assert.equal(readFileSync(file, "utf8"), once);
  assert.equal(readFileSync(path.join(dir, "teams", "bare", "log.jsonl"), "utf8").trim().split(NL).length, 1, "drift metric not repeated");
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

test("H1: runner agent labelled team=site files `--lane bug` into site's lane; --team/VS_TEAM spoofing and efi-first order are ignored; cwd resolves the Squad", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-bug-h1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "teams.json");
  const teams = backfillBugLanes([{ ...squad("efi"), paths: ["efi"] }, { ...squad("site"), paths: ["site"] }]);
  writeFileSync(file, JSON.stringify({ teams }));
  const siteBug = findBugLane(teams[1]).id;
  const efiBug = findBugLane(teams[0]).id;
  assert.notEqual(siteBug, efiBug);
  mkdirSync(path.join(dir, "runner", "agents"), { recursive: true });
  writeFileSync(
    path.join(dir, "runner", "agents", "rn-h1.jsonl"),
    JSON.stringify({ type: "created", ts: new Date().toISOString(), cwd: dir, meta: { cwd: dir, labels: { team: "site", lane: "site", role: "lead" } } }) + NL,
  );
  const base = { ...process.env, VIBESQUAD_HOME: dir, VIBESQUAD_TEAMS_FILE: file, VS_TEAM: "", VS_LANE: "", PASEO_AGENT_ID: "" };
  const run = (env, cwd, ...args) => spawnSync(process.execPath, [CLI, "inbox", ...args], { encoding: "utf8", env: { ...base, ...env }, cwd });
  const cardsOf = () => JSON.parse(run({ VS_AGENT_ID: "", VS_TEAM: "efi" }, dir, "list", "--json", "--status", "all").stdout);
  const laneOf = (env, text, ...extra) => {
    assert.equal(run(env, dir, "add", text, "--lane", "bug", ...extra).status, 0);
    const c = cardsOf().find((x) => x.text === text);
    return c.teamId === "site" ? c.laneId : `wrong team ${c.teamId}:${c.laneId}`;
  };
  assert.equal(laneOf({ VS_AGENT_ID: "rn-h1" }, "plain"), siteBug, "labels.team wins, not teams[0]");
  assert.equal(laneOf({ VS_AGENT_ID: "rn-h1", VS_TEAM: "efi" }, "env spoof"), siteBug, "VS_TEAM ignored");
  assert.equal(laneOf({ VS_AGENT_ID: "rn-h1" }, "flag spoof", "--team", "efi"), siteBug, "--team ignored");
  // L1: the card's team is the lane's Squad, not --team.
  assert.equal(run({ VS_AGENT_ID: "", VS_TEAM: "" }, dir, "add", "cross", "--lane", siteBug, "--team", "efi").status, 0);
  assert.deepEqual((({ teamId, laneId }) => ({ teamId, laneId }))(cardsOf().find((c) => c.text === "cross")), { teamId: "site", laneId: siteBug });
  const siteCwd = path.join(dir, "site");
  mkdirSync(siteCwd, { recursive: true });
  const r = run({ VS_AGENT_ID: "" }, siteCwd, "add", "by cwd", "--lane", "bug");
  assert.equal(r.status, 0, r.stderr);
  const byCwd = cardsOf().find((c) => c.text === "by cwd");
  assert.deepEqual({ teamId: byCwd.teamId, laneId: byCwd.laneId }, { teamId: "site", laneId: siteBug }, "cwd inside site resolves to site");
});

test("M1: unscoped @bug keeps resolving to vibesquad's bug-chaser with efi first; the caller's own Squad wins when known", () => {
  const teams = backfillBugLanes([squad("efi"), squad("vibesquad", [{ id: "bug-chaser", name: "Bug Chaser", state: "pinned", standing: true, code: "Bug" }])]);
  assert.equal(findLaneInRegistry("@bug", teams).lane.id, "bug-chaser");
  assert.equal(findLaneInRegistry("@bug", teams, "efi").lane.id, findBugLane(teams[0]).id);
  assert.equal(findLaneInRegistry("@bug", teams, "vibesquad").lane.id, "bug-chaser");
});

test("M2: persist writes with the revision of its read, so a concurrent edit is a 409 retry, not an overwrite", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-bug-m2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "teams.json");
  writeFileSync(file, JSON.stringify({ teams: fixture() }));
  const prev = { f: process.env.VIBESQUAD_TEAMS_FILE, h: process.env.VIBESQUAD_HOME };
  process.env.VIBESQUAD_TEAMS_FILE = file;
  process.env.VIBESQUAD_HOME = dir;
  t.after(() => { for (const [k, v] of [["VIBESQUAD_TEAMS_FILE", prev.f], ["VIBESQUAD_HOME", prev.h]]) v === undefined ? delete process.env[k] : (process.env[k] = v); });
  const stale = writeTeamsRegistry({ teams: fixture(), revision: "stale" }, dir);
  assert.equal(stale.status, 409, "writer rejects a stale revision");
  assert.equal((await persistTemplateReconcile(dir)).changed, true);
  assert.equal(readFileSync(file, "utf8").includes("bug-runner-2"), true);
});
