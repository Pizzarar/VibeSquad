// docs/PLAN_BUGS_BATCH1.md: Remove team (block 1) and archived agents out of badges (block 2).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attentionItems } from "../src/attentionItems.ts";
import { bestOverlap, patchLane, pinStateOf, pinsForSquad } from "../src/pins.ts";
import { removeTeamPlan, runRemoveTeam } from "../src/pinRemoveLogic.ts";
import { buildTeamViews, countsAsNeedsYou, getTeams, refreshTeams, resolve, shownLanesOf } from "../src/teams.ts";
import { removeTeamWorktrees } from "../server/team-worktrees.mjs";

// The live registry shape: the legacy `pinned` lane shares VibeSquad's paths; `gone` is already removed.
const REGISTRY = [
  {
    id: "vibesquad",
    name: "VibeSquad",
    color: "#0ff",
    paths: ["VibeSquad", "vibesquad-"],
    lanes: [
      { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad", "vibesquad-"] },
      { id: "pinned", name: "Pinned Teams", paths: ["VibeSquad", "vibesquad-"] },
      { id: "bug-chaser", name: "Bug Chaser", state: "pinned" },
      { id: "gone", name: "Gone Team", state: "removed", removedAt: "2026-11-01T00:00:00.000Z" },
    ],
  },
  { id: "site", name: "Site", color: "#f0f", paths: ["rosserlogic.tech"], lanes: [{ id: "site-polish", name: "Site Polish", paths: ["rosserlogic.tech"] }] },
];

async function useRegistry(teams = REGISTRY) {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ teams, revision: "t" }) });
  try {
    await refreshTeams();
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(getTeams().length, teams.length);
}

const agent = (id, labels, over = {}) => ({
  id,
  title: id,
  provider: "claude",
  model: "m",
  cwd: "C:\\Users\\me\\projects\\VibeSquad",
  status: "idle",
  updatedAt: "2026-11-01T00:00:00.000Z",
  labels,
  ...over,
});
const asMap = (list) => new Map(list.map((a) => [a.id, a]));

test.before(() => useRegistry());

// ── Block 1: Remove team ──────────────────────────────────────────────────────

test("removed is its own pin state and round-trips through patchLane", () => {
  assert.equal(pinStateOf({ id: "a", name: "A", state: "removed" }), "removed");
  assert.equal(pinStateOf({ id: "a", name: "A", state: "done" }), "done");
  assert.equal(pinStateOf({ id: "a", name: "A" }), "pinned");
  const next = patchLane(REGISTRY, "vibesquad", "bug-chaser", { state: "removed", removedAt: "2026-11-02T00:00:00.000Z" });
  const lane = next[0].lanes.find((l) => l.id === "bug-chaser");
  assert.equal(lane.state, "removed");
  assert.equal(lane.name, "Bug Chaser", "the lane row stays (brief + history kept)");
  assert.equal(next[0].lanes.length, REGISTRY[0].lanes.length);
});

test("removed lanes are hidden from views, pins, Done shelf, lane pickers and idea overlap", () => {
  const view = buildTeamViews(resolve(asMap([]))).find((v) => v.team.id === "vibesquad");
  assert.deepEqual(
    view.lanes.map((l) => l.lane.id),
    ["vibesquad", "pinned", "bug-chaser"],
  );
  const { pinned, done } = pinsForSquad(view);
  assert.ok(!pinned.some((p) => p.lane.id === "gone"));
  assert.ok(!done.some((p) => p.lane.id === "gone"));
  assert.deepEqual(shownLanesOf(getTeams()[0]).map((l) => l.id), ["vibesquad", "pinned", "bug-chaser"]);
  assert.equal(bestOverlap("Gone Team", REGISTRY[0].lanes), null);
});

test("an agent still labelled with a removed lane shows up as a lane of its own, not hidden", () => {
  const left = agent("left", { team: "vibesquad", lane: "gone", role: "worker" });
  const view = buildTeamViews(resolve(asMap([left]))).find((v) => v.team.id === "vibesquad");
  const lane = view.lanes.find((l) => l.lane.id === "gone");
  assert.ok(lane, "leftover agent stays findable");
  assert.equal(lane.lane.state, undefined, "as a dynamic lane, not the removed one");
});

const ws = (id, dir, kind = "worktree", branch = null) => ({ id, workspaceDirectory: dir, workspaceKind: kind, gitRuntime: { currentBranch: branch } });

test("plan lists the lane's unarchived agents and its worktrees, not the main checkout", () => {
  const wt = "C:\\Users\\me\\projects\\VibeSquad\\.worktrees\\unit-x";
  const agents = [
    agent("bs", { team: "vibesquad", lane: "bug-chaser", role: "brainstorm" }),
    agent("lead", { team: "vibesquad", lane: "bug-chaser", role: "lead", ord: "1" }),
    agent("w1", { team: "vibesquad", lane: "bug-chaser", role: "worker" }, { cwd: wt + "\\src", status: "closed" }),
    agent("old", { team: "vibesquad", lane: "bug-chaser", role: "worker" }, { archivedAt: "2026-11-01T00:00:00.000Z" }),
    agent("other", { team: "vibesquad", lane: "vibesquad", role: "lead" }),
  ];
  const plan = removeTeamPlan({
    squadId: "vibesquad",
    laneId: "bug-chaser",
    teams: getTeams(),
    members: resolve(asMap(agents)),
    workspaces: [ws("w-main", "C:\\Users\\me\\projects\\VibeSquad", "local_checkout"), ws("w-x", wt, "worktree", "unit-x"), ws("w-y", wt + "-other")],
  });
  assert.deepEqual(plan.agents.map((a) => a.id).sort(), ["bs", "lead", "w1"]);
  assert.deepEqual(plan.worktrees, [{ path: wt, branch: "unit-x", workspaceId: "w-x" }]);
  assert.equal(plan.sharedWith, null);
});

test("plan finds worktrees from archived agents too", () => {
  const wt = "D:\\wt\\bug-1";
  const plan = removeTeamPlan({
    squadId: "vibesquad",
    laneId: "bug-chaser",
    teams: getTeams(),
    members: [],
    archived: [agent("gone1", { team: "vibesquad", lane: "bug-chaser", role: "worker" }, { cwd: wt, archivedAt: "x" })],
    workspaces: [ws("w1", wt, "worktree", "bug-1")],
  });
  assert.equal(plan.agents.length, 0);
  assert.equal(plan.worktrees.length, 1);
});

test("shared-path guard: pinned shares VibeSquad's folders, so the delete box is disabled", () => {
  const plan = removeTeamPlan({ squadId: "vibesquad", laneId: "pinned", teams: getTeams(), members: [], workspaces: [] });
  assert.equal(plan.sharedWith, "VibeSquad");
});

test("shared-path guard: another live team's agent inside the worktree also disables delete", () => {
  const wt = "D:\\wt\\shared";
  const members = resolve(
    asMap([
      agent("mine", { team: "vibesquad", lane: "bug-chaser", role: "worker" }, { cwd: wt }),
      agent("theirs", { team: "vibesquad", lane: "vibesquad", role: "worker" }, { cwd: wt + "\\sub" }),
    ]),
  );
  const plan = removeTeamPlan({ squadId: "vibesquad", laneId: "bug-chaser", teams: getTeams(), members, workspaces: [ws("w", wt)] });
  assert.equal(plan.sharedWith, "VibeSquad");
  // A removed team never counts as sharing.
  const plan2 = removeTeamPlan({
    squadId: "vibesquad",
    laneId: "bug-chaser",
    teams: getTeams(),
    members: resolve(
      asMap([
        agent("mine", { team: "vibesquad", lane: "bug-chaser", role: "worker" }, { cwd: wt }),
        agent("leftover", { team: "vibesquad", lane: "gone", role: "worker" }, { cwd: wt }),
      ]),
    ),
    workspaces: [ws("w", wt)],
  });
  assert.equal(plan2.sharedWith, null);
});

const pinOf = (laneId) => ({ squad: { id: "vibesquad" }, lane: { id: laneId, name: laneId } });

function fakeFx(over = {}) {
  const calls = [];
  let teams = REGISTRY;
  return {
    calls,
    teams: () => teams,
    fx: {
      archive: async (id) => void calls.push(["archive", id]),
      saveTeams: async (fn) => void (calls.push(["save"]), (teams = fn(teams))),
      readBrief: async () => "# Brief\n",
      writeBrief: async (_l, c) => void calls.push(["brief", c.trim().split("\n").pop()]),
      removeWorktrees: async (items) => (calls.push(["git", items.map((i) => i.path)]), items.map((i) => ({ ...i, worktree: "removed", branchResult: "deleted" }))),
      archiveWorkspace: async (id) => void calls.push(["ws", id]),
      now: () => new Date(2026, 10, 2, 12),
      ...over,
    },
  };
}
const planOf = (over = {}) => ({ agents: [{ id: "a1" }, { id: "a2" }], worktrees: [{ path: "D:\\wt\\x", branch: "x", workspaceId: "wx" }], sharedWith: null, ...over });

test("remove archives every agent, then hides the lane; worktrees untouched when the box is off", async () => {
  const f = fakeFx();
  const r = await runRemoveTeam(pinOf("bug-chaser"), planOf(), { deleteWorktrees: false }, f.fx);
  assert.deepEqual(f.calls.map((c) => c[0]), ["archive", "archive", "save", "brief"]);
  assert.deepEqual(r, { archived: ["a1", "a2"], worktrees: [] });
  const lane = f.teams()[0].lanes.find((l) => l.id === "bug-chaser");
  assert.equal(lane.state, "removed");
  assert.ok(lane.removedAt);
  assert.deepEqual(f.calls.at(-1), ["brief", "Removed 2026-11-02"]);
});

test("an archive failure stops before the lane is hidden (safe to retry)", async () => {
  const f = fakeFx({ archive: async (id) => { if (id === "a2") throw new Error("daemon down"); } });
  await assert.rejects(runRemoveTeam(pinOf("bug-chaser"), planOf(), { deleteWorktrees: true }, f.fx), /daemon down/);
  assert.equal(f.teams()[0].lanes.find((l) => l.id === "bug-chaser").state, "pinned");
  assert.ok(!f.calls.some((c) => c[0] === "git"));
});

test("opt-in delete removes worktrees + branches and archives their Paseo workspace; shared never deletes", async () => {
  const f = fakeFx();
  const r = await runRemoveTeam(pinOf("bug-chaser"), planOf(), { deleteWorktrees: true }, f.fx);
  assert.deepEqual(f.calls.filter((c) => c[0] === "git" || c[0] === "ws"), [["git", ["D:\\wt\\x"]], ["ws", "wx"]]);
  assert.equal(r.worktrees[0].branchResult, "deleted");

  const g = fakeFx();
  await runRemoveTeam(pinOf("pinned"), planOf({ sharedWith: "VibeSquad" }), { deleteWorktrees: true }, g.fx);
  assert.ok(!g.calls.some((c) => c[0] === "git" || c[0] === "ws"));
  assert.equal(g.teams()[0].lanes.find((l) => l.id === "pinned").state, "removed");
});

test("a kept (dirty) worktree keeps its Paseo workspace", async () => {
  const f = fakeFx({ removeWorktrees: async (items) => items.map((i) => ({ ...i, worktree: "kept", branchResult: "kept", reason: "contains modified files" })) });
  const r = await runRemoveTeam(pinOf("bug-chaser"), planOf(), { deleteWorktrees: true }, f.fx);
  assert.ok(!f.calls.some((c) => c[0] === "ws"));
  assert.equal(r.worktrees[0].reason, "contains modified files");
});

test("server: refuses main checkouts and relative paths, protects master, reports git's reason", () => {
  const runs = [];
  const git = (args, cwd) => {
    runs.push([args.join(" "), cwd]);
    if (args[1] === "--git-dir") return cwd.includes("main") ? ".git" : "C:/repo/.git/worktrees/x";
    if (args[1] === "--git-common-dir") return cwd.includes("main") ? ".git" : "C:/repo/.git";
    if (args[0] === "rev-parse") return cwd.includes("onmaster") ? "master" : "unit-x";
    if (args[0] === "worktree" && args[2].includes("dirty"))
      throw Object.assign(new Error("x"), { stderr: "fatal: 'D:/dirty' contains modified or untracked files, use --force to delete it\n" });
    if (args[0] === "branch" && args[2] === "unmerged") throw Object.assign(new Error("x"), { stderr: "error: the branch 'unmerged' is not fully merged.\n" });
    return "";
  };
  const exists = (p) => !p.includes("missing");
  const r = removeTeamWorktrees(
    [
      { path: "rel/path" },
      { path: "D:\\main" },
      { path: "D:\\missing" },
      { path: "D:\\wt-ok" },
      { path: "D:\\onmaster" },
      { path: "D:\\wt-u", branch: "unmerged" },
      { path: "D:\\dirty" },
    ],
    { git, exists },
  );
  assert.equal(r[0].reason, "not an absolute path");
  assert.equal(r[1].reason, "main checkout, not a worktree");
  assert.equal(r[2].worktree, "missing");
  assert.deepEqual([r[3].worktree, r[3].branch, r[3].branchResult], ["removed", "unit-x", "deleted"]);
  assert.deepEqual([r[4].worktree, r[4].branchResult, r[4].reason], ["removed", "kept", "master is never deleted"]);
  assert.deepEqual([r[5].worktree, r[5].branchResult], ["removed", "kept"]);
  assert.match(r[5].reason, /not fully merged/);
  assert.equal(r[6].worktree, "kept");
  assert.match(r[6].reason, /modified or untracked/);
  assert.ok(!runs.some(([a]) => a.includes("--force") || a.includes("-D")), "nothing is forced");
});

test("server: real git round trip removes a clean worktree + merged branch and keeps a dirty one", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-rm-team-"));
  const g = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "master", repo]);
    g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repo);
    const clean = join(root, "wt-clean");
    const dirty = join(root, "wt-dirty");
    g(["worktree", "add", "-q", "-b", "unit-clean", clean], repo);
    g(["worktree", "add", "-q", "-b", "unit-dirty", dirty], repo);
    writeFileSync(join(dirty, "x.txt"), "x");
    const r = removeTeamWorktrees([{ path: clean }, { path: dirty }, { path: repo }]);
    assert.deepEqual([r[0].worktree, r[0].branchResult], ["removed", "deleted"]);
    assert.ok(!existsSync(clean));
    assert.equal(g(["branch", "--list", "unit-clean"], repo), "");
    assert.equal(r[1].worktree, "kept");
    assert.ok(existsSync(join(dirty, "x.txt")));
    assert.equal(r[2].reason, "main checkout, not a worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Block 2: archived agents never count in badges ────────────────────────────

test("an archived or closed agent with needs-you set counts 0 in the lane, squad and attention list", () => {
  const needs = { "needs-you": "approve the plan" };
  const agents = [
    agent("arch", { team: "site", lane: "site-polish", role: "brainstorm", ...needs }, { cwd: "C:\\p\\rosserlogic.tech", archivedAt: "2026-11-02T02:55:24.297Z" }),
    agent("closed", { team: "site", lane: "site-polish", role: "worker", ...needs }, { cwd: "C:\\p\\rosserlogic.tech", status: "closed" }),
  ];
  const members = resolve(asMap(agents));
  assert.ok(members.every((m) => m.attention?.tone === "needs-you"), "attention itself is still derived");
  assert.ok(!members.some(countsAsNeedsYou));
  const view = buildTeamViews(members).find((v) => v.team.id === "site");
  assert.equal(view.needsYou, 0);
  assert.equal(pinsForSquad(view).pinned[0].needsYou, 0);
  assert.equal(attentionItems(members).length, 0);

  // A live agent with the same label still counts.
  const live = resolve(asMap([...agents, agent("live", { team: "site", lane: "site-polish", role: "lead", ...needs }, { cwd: "C:\\p\\rosserlogic.tech" })]));
  const v2 = buildTeamViews(live).find((v) => v.team.id === "site");
  assert.equal(v2.needsYou, 1);
  assert.equal(pinsForSquad(v2).pinned[0].needsYou, 1);
  assert.equal(attentionItems(live).length, 1);
});
