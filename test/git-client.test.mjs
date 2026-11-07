// N1 client side: src/vsGit.ts talks to /__vibesquad/git/*, paseoGit/contextFetch/ChangesPanel no longer use the daemon for git.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const u = String(url);
  if (u.includes("/git/fail")) return new Response(JSON.stringify({ error: "boom" }), { status: 400 });
  if (u.includes("/git/commits")) return new Response(JSON.stringify({ baseRef: "origin/main", commits: [{ sha: "a" }] }));
  if (u.includes("/git/commit-diff")) return new Response(JSON.stringify({ commit: { sha: "a" }, files: [{ path: "x" }], file: { path: "x" } }));
  if (u.includes("/git/validate-branch")) return new Response(JSON.stringify({ exists: true, error: null }));
  if (u.includes("/git/rename-branch")) return new Response(JSON.stringify({ ok: true, currentBranch: "nb" }));
  if (u.includes("/git/stash-list")) return new Response(JSON.stringify({ entries: [{ index: 0, message: "m", branch: "b", isPaseo: false }] }));
  return new Response(JSON.stringify({ ok: true, files: [] }));
};
const V = await import("../src/vsGit.ts");

test("reads are GETs with an encoded cwd; empty params are dropped", async () => {
  await V.vsGitDiff("C:\\a b\\repo", "staged");
  assert.equal(calls.at(-1).url, "/__vibesquad/git/diff?cwd=C%3A%5Ca+b%5Crepo&mode=staged");
  assert.equal(calls.at(-1).init, undefined);
  await V.vsGitCommitDiff("/r", "abc1234");
  assert.equal(calls.at(-1).url, "/__vibesquad/git/commit-diff?cwd=%2Fr&hash=abc1234");
  await V.vsGitCommitDiff("/r", "abc1234", "src/a.ts");
  assert.match(calls.at(-1).url, /&path=src%2Fa\.ts$/);
});

test("writes are JSON POSTs carrying cwd", async () => {
  await V.vsGitCommit("/r", "msg");
  const c = calls.at(-1);
  assert.equal(c.url, "/__vibesquad/git/commit");
  assert.equal(c.init.method, "POST");
  assert.deepEqual(JSON.parse(c.init.body), { cwd: "/r", message: "msg", addAll: true });
  await V.vsGitDiscard("/r", ["a", "b"]);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { cwd: "/r", paths: ["a", "b"] });
  await V.vsGitPrCreate("/r", "t", "", "main");
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { cwd: "/r", title: "t", baseRef: "main" });
});

test("a failed route throws the server's error text; an unreachable server says so", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "boom" }), { status: 400 });
  await assert.rejects(V.vsGitPush("/r"), /boom/);
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(V.vsGitStatus("/r"), /Can't reach the VibeSquad server/);
  globalThis.fetch = real;
});

test("paseoGit wrappers map the new routes onto their old shapes", () => {
  const g = src("paseoGit.ts");
  assert.match(g, /vsGitCommits\(cwd\)/);
  assert.match(g, /vsGitCommitDiff\(cwd, sha, path\)/);
  assert.match(g, /r\.file \?\? null/);
  assert.match(g, /vsGitRenameBranch\(cwd, branch\)/);
  assert.match(g, /vsGitPrAutoMerge\(cwd, enabled, method\)/);
});

test("ChangesPanel / paseoGit / contextFetch do not use the daemon for git", () => {
  assert.doesNotMatch(src("paseoGit.ts"), /daemonClient|from "\.\/paseo"/);
  assert.doesNotMatch(src("contextFetch.ts"), /daemonClient|from "\.\/paseo"/);
  assert.match(src("contextFetch.ts"), /vsGitDiff\(cwd, kind === "git" \? "uncommitted" : "base"\)/);
  const c = src("ChangesPanel.tsx");
  for (const gone of ["getCheckoutDiff", "observeCheckoutDiff", "getCheckoutStatus", "checkoutPrStatus", "stashList", "checkoutCommit", "checkoutPush", "checkoutPull", "checkoutSwitchBranch", "stashSave", "stashPop", "checkoutPrCreate", "checkoutPrMerge", "checkoutDiscardChanges"]) {
    assert.ok(!c.includes(gone), gone);
  }
});

test("diffToText re-adds +/-/space to typed lines (the parser strips them)", async () => {
  const { diffToText } = await import("../src/contextSources.ts");
  const t = diffToText([{ path: "a", hunks: [{ lines: [{ type: "header", content: "@@ -1 +1 @@" }, { type: "context", content: "k" }, { type: "remove", content: "x" }, { type: "add", content: "y" }] }] }]);
  assert.equal(t, "--- a/a\n+++ b/a\n@@ -1 +1 @@\n k\n-x\n+y");
});

test("openCommit request: hash validated, one slot, taken only by the matching cwd, live listeners notified", async () => {
  const R = await import("../src/commitRequest.ts");
  assert.equal(R.requestCommit("/r", "--help"), null);
  assert.equal(R.requestCommit("/r", "abc12"), null);
  assert.equal(R.requestCommit("", "abc1234"), null);
  const got = [];
  const off = R.onCommitRequest((r) => got.push(r.sha));
  const req = R.requestCommit("/r", "ABC1234");
  assert.equal(req.sha, "ABC1234");
  assert.deepEqual(got, ["ABC1234"]);
  assert.equal(R.takeCommitRequest("/other"), null);
  assert.equal(R.takeCommitRequest("/r").sha, "ABC1234");
  assert.equal(R.takeCommitRequest("/r"), null, "consumed once");
  off();
  R.requestCommit("/r", "abc1234");
  assert.equal(got.length, 1, "unsubscribed");
  R.takeCommitRequest("/r");
});

test("changesNav.openCommit opens the Changes tab; ChangesPanel consumes the request", () => {
  assert.match(src("changesNav.ts"), /requestCommit\(cwd, sha\)[\s\S]*openRightDockTab\("Changes"\)/);
  const c = src("ChangesPanel.tsx");
  assert.match(c, /takeCommitRequest\(cwd\)/);
  assert.match(c, /vsgit\.vsGitCommitDiff\(req\.cwd, req\.sha\)/);
});
