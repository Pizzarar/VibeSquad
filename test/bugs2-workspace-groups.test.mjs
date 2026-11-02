// Bug2 block 8: Workspaces page groups records into one row per folder with a true "in use".
import assert from "node:assert/strict";
import test from "node:test";
import { agentsWithoutWorkspaceId, buildFolders, bulkLabels, clearLabels } from "../src/workspaceGroups.ts";

const win = (p) => p.split("/").join(String.fromCharCode(92));
const NOW = Date.parse("2026-11-02T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const ws = (id, dir, o = {}) => ({ id, name: `ws ${id}`, workspaceDirectory: dir, workspaceKind: "local_checkout", activityAt: iso(1), ...o });
const agent = (id, workspaceId, o = {}) => ({ id, workspaceId, cwd: win("C:/proj/a"), status: "idle", updatedAt: iso(0.1), archivedAt: null, ...o });

test("two records in one folder, one live agent each, count as one folder with 2 live", () => {
  const folders = buildFolders(
    [ws("w1", win("C:/proj/a")), ws("w2", "c:/proj/a/")],
    [agent("x", "w1"), agent("y", "w2")],
    [],
    NOW,
  );
  assert.equal(folders.length, 1);
  assert.equal(folders[0].live, 2);
  assert.equal(folders[0].verdict, "in-use");
});

test("a record only counts the agents that point at it, not every agent in the folder", () => {
  const f = buildFolders([ws("w1", win("C:/proj/a")), ws("w2", win("C:/proj/b"))], [agent("x", "w1", { cwd: win("C:/proj/b") })], [], NOW);
  assert.equal(f.find((r) => r.w.id === "w1").live, 1);
  assert.equal(f.find((r) => r.w.id === "w2").live, 0);
});

test("an idle agent older than STALE_DAYS is not in use; running always is; closed and archived are not", () => {
  const one = (a) => buildFolders([ws("w1", win("C:/proj/a"), { activityAt: iso(9) })], [a], [], NOW)[0];
  assert.notEqual(one(agent("x", "w1", { updatedAt: iso(5) })).verdict, "in-use");
  assert.equal(one(agent("x", "w1", { updatedAt: iso(5), status: "running" })).verdict, "in-use");
  assert.notEqual(one(agent("x", "w1", { status: "closed" })).verdict, "in-use");
  assert.notEqual(one(agent("x", "w1", { archivedAt: iso(1) })).verdict, "in-use");
});

test("agents without a workspace id fall back to cwd and are counted", () => {
  const a = agent("x", undefined, { cwd: win("C:/Proj/A/sub") });
  const [f] = buildFolders([ws("w1", win("C:/proj/a"))], [a], [], NOW);
  assert.equal(f.live, 1);
  assert.equal(agentsWithoutWorkspaceId([a, agent("y", "w1")]), 1);
});

test("old sessions are the non-primary, non-live, non-worktree records", () => {
  const [f] = buildFolders(
    [ws("new", win("C:/proj/a"), { activityAt: iso(0.5) }), ws("old1", win("C:/proj/a"), { activityAt: iso(8) }), ws("old2", win("C:/proj/a"), { activityAt: iso(9) }), ws("busy", win("C:/proj/a"), { activityAt: iso(7) })],
    [agent("x", "busy")],
    [],
    NOW,
  );
  assert.equal(f.w.id, "new");
  assert.deepEqual(f.oldSessions.map((r) => r.id).sort(), ["old1", "old2"]);
});

test("a local_checkout never offers 'Delete folder'; a Paseo-owned worktree does", () => {
  const [local] = buildFolders([ws("w1", win("C:/proj/a"), { activityAt: iso(9) })], [], [], NOW);
  assert.equal(local.deletesFolder, false);
  assert.doesNotMatch(clearLabels(local.deletesFolder).armed, /Delete/);
  const [tree] = buildFolders(
    [ws("t1", win("C:/wt/a"), { workspaceKind: "worktree", activityAt: iso(9), gitRuntime: { isPaseoOwnedWorktree: true } })],
    [],
    [],
    NOW,
  );
  assert.equal(tree.deletesFolder, true);
  assert.match(clearLabels(tree.deletesFolder).armed, /Delete folder/);
  assert.deepEqual(tree.oldSessions, []);
});

test("bulk button says Delete only for owned worktrees", () => {
  assert.match(bulkLabels([{ deletesFolder: false }, { deletesFolder: false }]).armed, /^Clear 2/);
  assert.match(bulkLabels([{ deletesFolder: true }]).armed, /^Delete 1 folders/);
  assert.match(bulkLabels([{ deletesFolder: true }, { deletesFolder: false }]).armed, /Delete 1 folders, clear 1/);
});

test("hundreds of same-folder records collapse to one row", () => {
  const records = Array.from({ length: 300 }, (_, i) => ws(`r${i}`, win("C:/proj/a"), { activityAt: iso(10 + i / 100) }));
  const folders = buildFolders(records, [], [], NOW);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].oldSessions.length, 299);
});
