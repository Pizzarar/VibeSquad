// N1: native git routes (server/git-api.mjs) against a temp repo, their cwd/arg validation, and the owner gate over the remote proxy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { handleGitApi, isGitPath, parseUnifiedDiff, parseStatus, parseCommits, badRefName, badRepoPath } from "../server/git-api.mjs";
import { makeVsHttpHandler } from "../plugin/server/remote-proxy.ts";
import { decideProxyRequest, checkRemoteBody } from "../plugin/server/remote-proxy-rules.ts";

const TOKEN = "a".repeat(64);
const G = "/__vibesquad/git";
const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" });

describe("parsers", () => {
  const DIFF = [
    "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt", "@@ -1,2 +1,3 @@", " one", "-two", "+TWO", "+three", "\\ No newline at end of file",
    "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hi",
    "diff --git a/old.txt b/old.txt", "deleted file mode 100644", "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/bin.png b/bin.png", "new file mode 100644", "Binary files /dev/null and b/bin.png differ", "",
  ].join("\n");
  test("unified diff -> panel shape", () => {
    const f = parseUnifiedDiff(DIFF);
    assert.deepEqual(f.map((x) => [x.path, x.status, x.additions, x.deletions]), [["a.txt", "modified", 2, 1], ["new.txt", "added", 1, 0], ["old.txt", "deleted", 0, 1], ["bin.png", "added", 0, 0]]);
    assert.equal(f[0].hunks[0].newStart, 1);
    assert.deepEqual(f[0].hunks[0].lines.map((l) => l.type), ["header", "context", "remove", "add", "add"]);
    assert.equal(f[0].hunks[0].lines[3].content, "+TWO");
    assert.ok(f[1].isNew && f[2].isDeleted);
  });
  test("status + commits parsers", () => {
    assert.deepEqual(parseStatus("# branch.oid x\n# branch.head main\n# branch.ab +2 -1\n1 .M N... a\n"), { currentBranch: "main", aheadBehind: { ahead: 2, behind: 1 }, isDirty: true });
    assert.equal(parseStatus("# branch.head (detached)\n").currentBranch, null);
    const c = parseCommits("\x1eH1\x1fh1\x1fsubj\x1fme\x1f2026-01-01T00:00:00Z\n\n:100644 100644 a b M\ta.txt\n3\t1\ta.txt\n", { unpushed: new Set(["H1"]), notOnBase: new Set() });
    assert.deepEqual(c[0].files, [{ path: "a.txt", additions: 3, deletions: 1, status: "modified" }]);
    assert.equal(c[0].isOnRemote, false);
    assert.equal(c[0].isOnBase, true);
  });
  test("validators reject leading '-', traversal and junk", () => {
    for (const b of ["-x", "--help", "", "a b", "a..b", "x\n", "a~1", "a.lock", "a:b"]) assert.ok(badRefName(b), JSON.stringify(b));
    assert.equal(badRefName("feature/ok-1"), null);
    for (const p of ["-f", "../x", "a/../b", "/etc/passwd", "C:\\x", "\\\\h\\s", ""]) assert.ok(badRepoPath(p), JSON.stringify(p));
    assert.equal(badRepoPath("src/a.ts"), null);
    assert.ok(isGitPath("/__vibesquad/git/diff") && !isGitPath("/__vibesquad/gitx"));
  });
});

describe("routes on a temp repo", () => {
  let server, port, repo, outside;
  const call = async (method, action, args = {}) => {
    const url = `http://127.0.0.1:${port}${G}/${action}${method === "GET" ? `?${new URLSearchParams(args)}` : ""}`;
    const r = await fetch(url, { method, ...(method === "POST" ? { body: JSON.stringify(args) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  before(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "vs-git-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "vs-git-out-")));
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "first");
    const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b ? JSON.parse(b) : {})); });
    const sendJson = (res, status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    server = createServer((req, res) => handleGitApi(req, res, { readBody, sendJson, resolveCwd: async (c) => (c === repo ? repo : null) }));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    for (const d of [repo, outside]) try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  });

  test("status on a clean repo, then dirty", async () => {
    let r = await call("GET", "status", { cwd: repo });
    assert.equal(r.body.isGit, true);
    assert.equal(r.body.currentBranch, "main");
    assert.equal(r.body.isDirty, false);
    writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
    r = await call("GET", "status", { cwd: repo });
    assert.equal(r.body.isDirty, true);
  });

  test("diff: working tree + untracked + staged", async () => {
    writeFileSync(join(repo, "b.txt"), "brand new\n");
    const w = (await call("GET", "diff", { cwd: repo })).body;
    assert.deepEqual(w.files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
    const b = w.files.find((f) => f.path === "b.txt");
    assert.ok(b.isNew && b.additions === 1);
    assert.equal((await call("GET", "diff", { cwd: repo, mode: "staged" })).body.files.length, 0);
    sh(repo, "add", "a.txt");
    assert.equal((await call("GET", "diff", { cwd: repo, mode: "staged" })).body.files[0].path, "a.txt");
    assert.equal((await call("GET", "diff", { cwd: repo, mode: "bogus" })).status, 400);
  });

  test("commit, commits list, and a single commit's diff by hash", async () => {
    assert.equal((await call("POST", "commit", { cwd: repo, message: "" })).status, 400);
    assert.equal((await call("POST", "commit", { cwd: repo, message: "second: TWO + b" })).body.ok, true);
    assert.equal((await call("GET", "status", { cwd: repo })).body.isDirty, false);
    const { commits } = (await call("GET", "commits", { cwd: repo })).body;
    assert.deepEqual(commits.map((c) => c.subject), ["second: TWO + b", "first"]);
    assert.deepEqual(commits[0].files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
    const sha = commits[0].sha;
    for (const hash of [sha, commits[0].shortSha]) {
      const d = (await call("GET", "commit-diff", { cwd: repo, hash })).body;
      assert.equal(d.commit.sha, sha);
      assert.equal(d.commit.subject, "second: TWO + b");
      assert.deepEqual(d.files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
    }
    const one = (await call("GET", "commit-diff", { cwd: repo, hash: sha, path: "a.txt" })).body;
    assert.equal(one.file.path, "a.txt");
    assert.equal(one.file.additions, 1);
    assert.equal((await call("GET", "commit-diff", { cwd: repo, hash: "deadbeefdeadbeef" })).status, 404);
  });

  test("branches: validate, switch, rename", async () => {
    sh(repo, "branch", "feature/x");
    const b = (await call("GET", "branches", { cwd: repo })).body;
    assert.equal(b.current, "main");
    assert.deepEqual(b.branches.map((x) => x.name).sort(), ["feature/x", "main"]);
    assert.deepEqual((await call("GET", "validate-branch", { cwd: repo, name: "feature/x" })).body, { exists: true, error: null });
    assert.equal((await call("GET", "validate-branch", { cwd: repo, name: "fresh" })).body.exists, false);
    assert.ok((await call("GET", "validate-branch", { cwd: repo, name: "a..b" })).body.error);
    assert.equal((await call("POST", "switch", { cwd: repo, branch: "feature/x" })).body.ok, true);
    assert.equal((await call("GET", "status", { cwd: repo })).body.currentBranch, "feature/x");
    assert.equal((await call("POST", "rename-branch", { cwd: repo, branch: "feature/y" })).body.currentBranch, "feature/y");
    assert.equal((await call("POST", "switch", { cwd: repo, branch: "main" })).body.ok, true);
    assert.equal((await call("POST", "switch", { cwd: repo, branch: "nope-branch" })).status, 400);
  });

  test("stash save / list / pop, and discard (tracked + untracked)", async () => {
    writeFileSync(join(repo, "a.txt"), "stashed\n");
    assert.equal((await call("POST", "stash-save", { cwd: repo })).body.ok, true);
    assert.equal((await call("GET", "status", { cwd: repo })).body.isDirty, false);
    const list = (await call("GET", "stash-list", { cwd: repo })).body.entries;
    assert.equal(list.length, 1);
    assert.equal(list[0].index, 0);
    assert.equal(list[0].message, "VibeSquad stash");
    assert.equal((await call("POST", "stash-pop", { cwd: repo, index: 0 })).body.ok, true);
    assert.equal((await call("GET", "stash-list", { cwd: repo })).body.entries.length, 0);
    writeFileSync(join(repo, "junk.txt"), "x");
    assert.equal((await call("POST", "discard", { cwd: repo, paths: ["a.txt", "junk.txt"] })).body.ok, true);
    assert.equal((await call("GET", "status", { cwd: repo })).body.isDirty, false);
  });

  test("pull fails with a readable error; pr-status never throws (no remote, maybe no gh)", async () => {
    const pull = await call("POST", "pull", { cwd: repo });
    assert.equal(pull.status, 400);
    assert.ok(pull.body.error.length > 0);
    const pr = await call("GET", "pr-status", { cwd: repo });
    assert.equal(pr.status, 200);
    assert.equal(pr.body.status, null);
  });

  test("rejected: bad cwd, '-' args, traversal, wrong method, unknown action", async () => {
    assert.equal((await call("GET", "status", { cwd: outside })).status, 403);
    assert.equal((await call("GET", "status", {})).status, 403);
    assert.equal((await call("POST", "commit", { cwd: outside, message: "x" })).status, 403);
    assert.equal((await call("POST", "switch", { cwd: repo, branch: "-c" })).status, 400);
    assert.equal((await call("POST", "switch", { cwd: repo, branch: "--detach" })).status, 400);
    assert.equal((await call("POST", "rename-branch", { cwd: repo, branch: "--x" })).status, 400);
    assert.equal((await call("POST", "discard", { cwd: repo, paths: ["-f"] })).status, 400);
    assert.equal((await call("POST", "discard", { cwd: repo, paths: ["../x"] })).status, 400);
    assert.equal((await call("POST", "discard", { cwd: repo, paths: [] })).status, 400);
    assert.equal((await call("GET", "commit-diff", { cwd: repo, hash: "--help" })).status, 400);
    assert.equal((await call("GET", "commit-diff", { cwd: repo, hash: "abcdef0", path: "-x" })).status, 400);
    assert.equal((await call("POST", "pr-create", { cwd: repo, title: "t", baseRef: "-x" })).status, 400);
    assert.equal((await call("POST", "pr-merge", { cwd: repo, method: "--admin" })).status, 400);
    assert.equal((await call("GET", "commit", { cwd: repo })).status, 405);
    assert.equal((await call("POST", "diff", { cwd: repo })).status, 405);
    assert.equal((await call("GET", "nope", { cwd: repo })).status, 404);
  });

  test("a commit message that looks like a flag is just a message", async () => {
    writeFileSync(join(repo, "c.txt"), "c");
    assert.equal((await call("POST", "commit", { cwd: repo, message: "--amend -a" })).body.ok, true);
    assert.equal((await call("GET", "commits", { cwd: repo })).body.commits[0].subject, "--amend -a");
  });
});

describe("remote proxy: git is owner-only", () => {
  let server, port;
  const seen = [];
  const OWNER = mkdtempSync(join(tmpdir(), "vs-git-own-"));
  const NONE = mkdtempSync(join(tmpdir(), "vs-git-none-"));
  before(async () => {
    writeFileSync(join(OWNER, "local-token"), TOKEN);
    for (const h of [OWNER, NONE]) writeFileSync(join(h, "settings.json"), JSON.stringify({ remote: { enabled: true } }));
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, token: req.headers["x-vibesquad-token"] });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => { server.close(); for (const d of [OWNER, NONE]) rmSync(d, { recursive: true, force: true }); });
  const READS = ["status", "diff", "commits", "commit-diff", "branches", "validate-branch", "stash-list", "pr-status", "pr-timeline", "check-details"];
  const WRITES = ["commit", "push", "pull", "merge-base", "switch", "stash-save", "stash-pop", "discard", "rename-branch", "pr-create", "pr-merge", "pr-automerge"];
  const BODY = { commit: { message: "m" }, switch: { branch: "b" }, "rename-branch": { branch: "b" }, discard: { paths: ["a"] }, "pr-create": { title: "t" } };

  test("every action is allowed with the right method only", () => {
    for (const a of READS) {
      assert.equal(decideProxyRequest("GET", `${G}/${a}`).ok, true, a);
      assert.equal(decideProxyRequest("POST", `${G}/${a}`).ok, false, a);
    }
    for (const a of WRITES) {
      assert.equal(decideProxyRequest("POST", `${G}/${a}`).ok, true, a);
      assert.equal(decideProxyRequest("GET", `${G}/${a}`).ok, false, a);
      assert.equal(decideProxyRequest("DELETE", `${G}/${a}`).ok, false, a);
    }
    assert.equal(decideProxyRequest("GET", `${G}/unknown`).ok, false);
    assert.equal(decideProxyRequest("GET", `${G}/status/x`).ok, false);
  });

  test("without the owner token every git route is refused locally; nothing reaches the server", async () => {
    const n = seen.length;
    const h = makeVsHttpHandler({ port, home: NONE });
    for (const a of READS) await assert.rejects(h({ method: "GET", path: `${G}/${a}?cwd=x` }), /owner-only/, a);
    for (const a of WRITES) await assert.rejects(h({ method: "POST", path: `${G}/${a}`, body: JSON.stringify({ cwd: "x", ...BODY[a] }) }), /owner-only/, a);
    assert.equal(seen.length, n);
  });

  test("with the owner token, reads and writes carry it", async () => {
    const h = makeVsHttpHandler({ port, home: OWNER });
    assert.equal((await h({ method: "GET", path: `${G}/diff?cwd=x&mode=staged` })).status, 200);
    assert.equal(seen.at(-1).token, TOKEN);
    assert.equal((await h({ method: "POST", path: `${G}/commit`, body: JSON.stringify({ cwd: "x", message: "m" }) })).status, 200);
    assert.equal(seen.at(-1).token, TOKEN);
  });

  test("write bodies are typed: unknown keys, bad method, wrong types and missing fields are refused", () => {
    const chk = (a, b) => checkRemoteBody("POST", `${G}/${a}`, JSON.stringify(b));
    assert.equal(chk("commit", { cwd: "x", message: "m" }).ok, true);
    assert.equal(chk("commit", { cwd: "x", message: "m", sneaky: 1 }).ok, false);
    assert.equal(chk("commit", { cwd: "x" }).ok, false);
    assert.equal(chk("pr-merge", { cwd: "x", method: "--admin" }).ok, false);
    assert.equal(chk("pr-merge", { cwd: "x", method: "squash" }).ok, true);
    assert.equal(chk("discard", { cwd: "x", paths: "a" }).ok, false);
    assert.equal(chk("pr-create", { cwd: "x", title: "t", labels: "y" }).ok, false);
    assert.equal(chk("push", { message: "no cwd" }).ok, false);
  });
});
