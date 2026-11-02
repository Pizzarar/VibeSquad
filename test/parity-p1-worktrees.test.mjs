import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { archiveGuard, baseRefError, isInside, linkedAgents, linkedWorkspace, sortWorktrees, worktreeSlugError } from "../src/paseoWorktreeLogic.ts";

test("isInside: same folder or below, either slash, case-insensitive; no prefix false positives", () => {
  assert.ok(isInside("C:\\Repo\\.paseo\\wt\\a", "c:/repo/.paseo/wt/a"));
  assert.ok(isInside("c:/repo/.paseo/wt/a/src/x", "C:\\repo\\.paseo\\wt\\a\\"));
  assert.ok(!isInside("c:/repo/.paseo/wt/ab", "c:/repo/.paseo/wt/a"));
  assert.ok(!isInside("", "c:/x"));
  assert.ok(!isInside("c:/x", ""));
});

test("sortWorktrees: newest first, undated last, ties by path; input untouched", () => {
  const rows = [
    { worktreePath: "/b", createdAt: "2026-01-01T00:00:00Z" },
    { worktreePath: "/z", createdAt: "garbage" },
    { worktreePath: "/a", createdAt: "2026-03-01T00:00:00Z" },
    { worktreePath: "/c", createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(sortWorktrees(rows).map((r) => r.worktreePath), ["/a", "/b", "/c", "/z"]);
  assert.equal(rows[0].worktreePath, "/b");
});

test("worktreeSlugError: one branch-safe segment", () => {
  assert.equal(worktreeSlugError("feat-thing"), null);
  assert.equal(worktreeSlugError(" fix_1.2 "), null);
  for (const bad of ["", "  ", "a/b", "a\\b", "a b", "a..b", "-x", "x.lock", ".hidden", "a:b", "x".repeat(65)]) assert.ok(worktreeSlugError(bad), JSON.stringify(bad));
});

test("baseRefError: optional, else ref-shaped (slashes allowed)", () => {
  assert.equal(baseRefError(""), null);
  assert.equal(baseRefError("origin/main"), null);
  assert.ok(baseRefError("bad ref"));
});

test("archiveGuard: refuses while a running agent's cwd is inside", () => {
  const wt = "C:/repo/.paseo/worktrees/feat";
  const agents = [
    { id: "a1", title: "Idle one", cwd: wt, status: "idle" },
    { id: "a2", title: "Archived runner", cwd: wt, status: "running", archivedAt: "2026-01-01" },
    { id: "a3", title: "Elsewhere", cwd: "C:/repo", status: "running" },
    { id: "a4", title: "Prefix twin", cwd: wt + "-2", status: "running" },
  ];
  assert.equal(archiveGuard(wt, agents), null);
  const msg = archiveGuard(wt, [...agents, { id: "abcdefghij", cwd: wt.replace(/\//g, "\\") + "\\src", status: "running" }]);
  assert.match(msg, /^1 running agent inside \(abcdefgh\)\. Stop it first\.$/);
  const many = [1, 2, 3, 4].map((i) => ({ id: `r${i}`, title: `R${i}`, cwd: wt, status: "running" }));
  assert.match(archiveGuard(wt, many), /^4 running agents inside \(R1, R2, R3 \+1\)\. Stop them first\.$/);
});

test("linkedAgents / linkedWorkspace", () => {
  const wt = "C:/repo/.paseo/worktrees/feat";
  const agents = [
    { id: "a", cwd: wt + "/sub", status: "idle" },
    { id: "b", cwd: wt, status: "closed" },
    { id: "c", cwd: wt, status: "running", archivedAt: "x" },
    { id: "d", cwd: "C:/other", status: "running" },
  ];
  assert.deepEqual(linkedAgents(wt, agents).map((a) => a.id), ["a"]);
  const ws = [{ id: "w1", workspaceDirectory: "C:\\repo" }, { id: "w2", workspaceDirectory: "c:\\repo\\.paseo\\worktrees\\feat\\" }, { id: "w3" }];
  assert.equal(linkedWorkspace(wt, ws)?.id, "w2");
  assert.equal(linkedWorkspace("C:/nope", ws), null);
});

test("wiring: wrappers stay out of paseo.ts, panel is rendered from WorkspacesView, archive is guarded", () => {
  const paseo = readFileSync(new URL("../src/paseo.ts", import.meta.url), "utf8");
  assert.ok(!/PaseoWorktree\(/.test(paseo), "worktree wrappers belong in paseoWorktrees.ts");
  const wrap = readFileSync(new URL("../src/paseoWorktrees.ts", import.meta.url), "utf8");
  for (const fn of ["getPaseoWorktreeList", "createPaseoWorktree", "archivePaseoWorktree"]) assert.match(wrap, new RegExp(`daemonClient\\.${fn}\\(`));
  assert.match(wrap, /withTimeout\(daemonClient\.getPaseoWorktreeList/);
  const view = readFileSync(new URL("../src/WorkspacesView.tsx", import.meta.url), "utf8");
  assert.match(view, /<WorktreesPanel /);
  const panel = readFileSync(new URL("../src/WorktreesPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /const late = archiveGuard\(/);
  assert.match(panel, /<ConfirmButton/);
});
