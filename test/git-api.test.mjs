// N1: native git routes (server/git-api.mjs) against a temp repo, their cwd/arg validation, and the owner gate over the remote proxy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  handleGitApi, isGitPath, parseUnifiedDiff, parseStatus, parseCommits, badRefName, badRepoPath,
  parseGithubRepoSpec, badFolderName, cloneDestination, scrubSecrets, githubRemoteSlug, GitError, GIT_READ_ACTIONS, GIT_WRITE_ACTIONS,
} from "../server/git-api.mjs";

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
    assert.deepEqual(f.map((x) => [x.path, x.status, x.additions, x.deletions]), [["a.txt", "modified", 2, 1], ["new.txt", "added", 1, 0], ["old.txt", "deleted", 0, 1], ["bin.png", "binary", 0, 0]]);
    assert.equal(f[0].hunks[0].newStart, 1);
    assert.deepEqual(f[0].hunks[0].lines.map((l) => l.type), ["header", "context", "remove", "add", "add"]);
    assert.equal(f[0].hunks[0].lines[3].content, "TWO");
    assert.equal(f[0].hunks[0].lines[1].content, "one");
    assert.ok(f[1].isNew && f[2].isDeleted);
  });
  test("CRLF diff: every line is stripped, so later file headers still parse", () => {
    const crlf = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-x", "+y", "diff --git a/del.txt b/del.txt", "deleted file mode 100644", "Binary files a/del.txt and /dev/null differ", ""].join("\r\n");
    const f = parseUnifiedDiff(crlf);
    assert.deepEqual(f.map((x) => [x.path, x.status]), [["a.txt", "modified"], ["del.txt", "binary"]]);
    assert.equal(f[0].hunks[0].lines[2].content, "y");
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

  test("discarding a staged rename (path + oldPath) restores the old file and removes the new one", async () => {
    const { existsSync } = await import("node:fs");
    sh(repo, "mv", "a.txt", "r.txt");
    const f = (await call("GET", "diff", { cwd: repo })).body.files.find((x) => x.path === "r.txt");
    assert.equal(f.oldPath, "a.txt");
    assert.equal((await call("POST", "discard", { cwd: repo, paths: [f.path, f.oldPath] })).body.ok, true);
    assert.equal((await call("GET", "status", { cwd: repo })).body.isDirty, false);
    assert.ok(existsSync(join(repo, "a.txt")) && !existsSync(join(repo, "r.txt")));
  });

  test("an untracked symlink is not followed into the diff", async (t) => {
    const { symlinkSync } = await import("node:fs");
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    try { symlinkSync(join(outside, "secret.txt"), join(repo, "lnk.txt")); } catch { return t.skip("no symlink privilege"); }
    const w = (await call("GET", "diff", { cwd: repo })).body;
    assert.ok(!JSON.stringify(w).includes("TOPSECRET"));
    rmSync(join(repo, "lnk.txt"));
  });

  test("a commit message that looks like a flag is just a message", async () => {
    writeFileSync(join(repo, "c.txt"), "c");
    assert.equal((await call("POST", "commit", { cwd: repo, message: "--amend -a" })).body.ok, true);
    assert.equal((await call("GET", "commits", { cwd: repo })).body.commits[0].subject, "--amend -a");
  });

  test("a 40k-char commit message goes over stdin, not argv (E3)", async () => {
    writeFileSync(join(repo, "d.txt"), "d");
    const message = ['big "quoted" subject', "", ...Array(2500).fill("line of body text")].join("\n"); // ~45k chars, above the Windows 32,767 command-line limit
    assert.ok(message.length > 40_000);
    assert.equal((await call("POST", "commit", { cwd: repo, message })).body.ok, true);
    const subject = (await call("GET", "commits", { cwd: repo })).body.commits[0].subject;
    assert.equal(subject, 'big "quoted" subject');
    const body = sh(repo, "log", "-1", "--format=%B").trim();
    assert.equal(body.length, message.slice(0, 10_000).trim().length); // the API's own 10k cap still applies
  });
});

// ---- idea-343: From GitHub (gh-repos / gh-clone). gh is stubbed: these tests never reach the network. ----

describe("idea-343 validators", () => {
  test("parseGithubRepoSpec accepts owner/repo and github.com URLs, normalized to owner/repo", () => {
    const ok = [
      ["Pizzarar/VibeSquad", "Pizzarar/VibeSquad"],
      ["IdleMinds-Dev/SportsBallBattles", "IdleMinds-Dev/SportsBallBattles"],
      ["a/b.git", "a/b"],
      ["a/b.GIT", "a/b"],
      ["o_1/r-2.x", "o_1/r-2.x"],
      ["https://github.com/IdleMinds-Dev/SportsBallBattles", "IdleMinds-Dev/SportsBallBattles"],
      ["https://github.com/o/r.git", "o/r"],
      ["https://github.com/o/r/", "o/r"],
      ["https://www.github.com/o/r", "o/r"],
      ["HTTPS://GitHub.com/o/r", "o/r"],
    ];
    for (const [raw, want] of ok) assert.equal(parseGithubRepoSpec(raw), want, raw);
  });

  test("parseGithubRepoSpec rejects flags, traversal, foreign hosts, creds, backslashes, junk", () => {
    const bad = [
      "", "o", "-x/r", "o/-x", "--upload-pack=x/r", "o/--help", ".o/r", "o/.r", "../r", "o/..", "./r", "o/.", "o/.git", "o/r/x", "/o/r", "o/r//", "o//r",
      "o\\r", "o/r\\", "..\\..\\x/y", " o/r", "o/r ", "o /r", "o/r\n", "o/r\t", "o/\u0000r", "o/r\u007f", "o/r\u0085",
      "https://gitlab.com/o/r", "http://github.com/o/r", "https://github.com.evil.com/o/r", "https://evil.com/github.com/o/r", "https://github.com:443/o/r",
      "https://user@github.com/o/r", "https://u:p@github.com/o/r", "https://github.com/o/r?x=1", "https://github.com/o/r#frag", "https://github.com/o/r/tree/main",
      "https://github.com/o", "https://github.com/", "https://github.com/o/r%2F..", "https://github.com/-o/r", "https://github.com/o/../x",
      "git@github.com:o/r.git", "ssh://git@github.com/o/r", "file:///c/x/r", "C:/o/r", "o/r@main", "ext::sh -c x/r",
      `o/${"r".repeat(101)}`, `${"o".repeat(101)}/r`, null, undefined, 42, ["o/r"],
    ];
    for (const raw of bad) assert.equal(parseGithubRepoSpec(raw), null, JSON.stringify(raw));
  });

  test("badFolderName / cloneDestination: one safe segment directly inside projectsDir", () => {
    for (const n of ["SportsBallBattles", "my-app", "a_b.c", "x1", "con1", "COM10", "nulls", "auxiliary"]) assert.equal(badFolderName(n), null, n);
    const bad = [
      "", "-x", "--help", ".", "..", ".hidden", "a/b", "a\\b", "..\\x", "../x", "a b", "a.", "a ", "C:", "C:x", "a:b", "x\u0000",
      "CON", "con", "PRN", "AUX", "NUL", "nul.txt", "Con.tar.gz", "COM1", "com9", "LPT1", "lpt9.log", "a".repeat(101), null, undefined, 5,
    ];
    for (const n of bad) assert.ok(badFolderName(n), JSON.stringify(n));
    const base = join(tmpdir(), "vs-proj-base");
    assert.equal(cloneDestination(base, "Game"), join(base, "Game"));
    for (const n of ["..", "a/b", "CON", "-x"]) assert.throws(() => cloneDestination(base, n), (e) => e instanceof GitError && e.status === 400, n);
  });

  test("scrubSecrets masks GitHub tokens and URL credentials; githubRemoteSlug reads ssh + https remotes", () => {
    const s = scrubSecrets("fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git denied ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 github_pat_11AAAAAAAAAAAAAAAAAAAA_bbbb");
    assert.doesNotMatch(s, /ghs_|ghp_|github_pat_|x-access-token/);
    assert.match(s, /https:\/\/\*\*\*@github\.com\/o\/r\.git/);
    assert.equal(githubRemoteSlug("git@github.com:Owner/Repo.git"), "owner/repo");
    assert.equal(githubRemoteSlug("https://tok@github.com/o/r"), "o/r");
    assert.equal(githubRemoteSlug("https://gitlab.com/o/r"), null);
    assert.equal(githubRemoteSlug(null), null);
  });

  test("gh-repos / gh-clone stay owner-gated: /__vibesquad/git/* GETs are gated reads, POSTs hit the non-GET owner gate", async () => {
    const { isGatedRead } = await import("../server/vibesquad-api.mjs");
    for (const p of [`${G}/gh-repos`, `${G}/gh-clone`]) assert.equal(isGatedRead(p, p), true, p);
    assert.ok(GIT_READ_ACTIONS.includes("gh-repos") && GIT_WRITE_ACTIONS.includes("gh-clone"));
  });
});

describe("idea-343 routes with a stubbed gh", () => {
  let server, port, projects, ghImpl, projectsDirFn;
  const calls = [];
  const call = async (method, action, args = {}) => {
    const url = `http://127.0.0.1:${port}${G}/${action}${method === "GET" ? `?${new URLSearchParams(args)}` : ""}`;
    const r = await fetch(url, { method, ...(method === "POST" ? { body: JSON.stringify(args) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const fakeClone = (dest, origin) => {
    mkdirSync(dest);
    sh(dest, "init", "-q", "-b", "main");
    sh(dest, "remote", "add", "origin", origin);
  };
  before(async () => {
    projects = realpathSync(mkdtempSync(join(tmpdir(), "vs-projects-")));
    projectsDirFn = () => projects;
    const runGh = async (args, cwd, opts) => {
      calls.push({ args, cwd, opts });
      return ghImpl(args, cwd, opts);
    };
    const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b ? JSON.parse(b) : {})); });
    const sendJson = (res, status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    server = createServer((req, res) => handleGitApi(req, res, { readBody, sendJson, resolveCwd: async () => null, projectsDir: () => projectsDirFn(), runGh }));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    try { rmSync(projects, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  });

  test("gh-repos: fixed argv in the projects folder, mapped rows, junk names dropped; no cwd needed", async () => {
    calls.length = 0;
    ghImpl = async () => ({ stdout: JSON.stringify([
      { full_name: "IdleMinds-Dev/SportsBallBattles", name: "SportsBallBattles", description: "ball", private: true, updated_at: "2026-11-18T00:00:00Z", owner: { login: "x" } },
      { full_name: "o/r", name: "r", description: null, private: false, updated_at: "2026-11-01T00:00:00Z" },
      { full_name: "-evil/--x", name: "--x" },
      { full_name: "o/r/x" },
    ]) });
    const r = await call("GET", "gh-repos");
    assert.equal(r.status, 200);
    assert.equal(r.body.projectsDir, projects);
    assert.deepEqual(r.body.repos, [
      { nameWithOwner: "IdleMinds-Dev/SportsBallBattles", name: "SportsBallBattles", description: "ball", isPrivate: true, updatedAt: "2026-11-18T00:00:00Z" },
      { nameWithOwner: "o/r", name: "r", description: "", isPrivate: false, updatedAt: "2026-11-01T00:00:00Z" },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, projects);
    assert.deepEqual(calls[0].args, ["api", "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"]);
    assert.equal((await call("POST", "gh-repos")).status, 405);
  });

  test("gh-clone: clones with an argv array into projectsDir/<repo>, then reuses that checkout", async () => {
    calls.length = 0;
    ghImpl = async (args) => { fakeClone(args[3], `https://github.com/${args[2]}.git`); return { stdout: "", stderr: "" }; };
    const dest = join(projects, "SportsBallBattles");
    const r = await call("POST", "gh-clone", { repo: "https://github.com/IdleMinds-Dev/SportsBallBattles.git" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, path: dest, reused: false, repo: "IdleMinds-Dev/SportsBallBattles" });
    assert.deepEqual(calls[0].args, ["repo", "clone", "IdleMinds-Dev/SportsBallBattles", dest, "--", "--quiet"]);
    assert.equal(calls[0].cwd, projects);
    assert.equal(calls[0].opts.timeout, 120_000);
    const again = await call("POST", "gh-clone", { repo: "IdleMinds-Dev/SportsBallBattles" });
    assert.deepEqual(again.body, { ok: true, path: dest, reused: true, repo: "IdleMinds-Dev/SportsBallBattles" });
    assert.equal(calls.length, 1); // reuse never runs gh
  });

  test("gh-clone: folderName is honored; collisions are 409 (non-git folder, nested folder, a file, a different repo)", async () => {
    calls.length = 0;
    ghImpl = async (args) => { fakeClone(args[3], `git@github.com:${args[2]}.git`); return { stdout: "" }; };
    const r = await call("POST", "gh-clone", { repo: "o/r", folderName: "r-local" });
    assert.equal(r.body.path, join(projects, "r-local"));
    mkdirSync(join(projects, "plain"));
    writeFileSync(join(projects, "plain", "x.txt"), "x");
    const plain = await call("POST", "gh-clone", { repo: "o/plain" });
    assert.equal(plain.status, 409);
    assert.equal(plain.body.error, "folder already exists and is not a git repository");
    mkdirSync(join(projects, "nested")); // inside a parent repo, but not a checkout of its own
    sh(projects, "init", "-q");
    assert.equal((await call("POST", "gh-clone", { repo: "o/nested" })).status, 409);
    rmSync(join(projects, ".git"), { recursive: true, force: true });
    writeFileSync(join(projects, "afile"), "x");
    assert.equal((await call("POST", "gh-clone", { repo: "o/afile" })).status, 409);
    const other = await call("POST", "gh-clone", { repo: "someone-else/r", folderName: "r-local" });
    assert.equal(other.status, 409);
    assert.match(other.body.error, /different repository/);
    assert.equal(calls.length, 1);
  });

  test("gh-clone: bad repo specs and folder names are 400 before gh runs; gh errors are scrubbed", async () => {
    calls.length = 0;
    ghImpl = async () => { throw new Error("unreachable"); };
    for (const repo of ["-x/r", "../r", "o/r/x", "https://gitlab.com/o/r", "https://u:p@github.com/o/r", "o\\r", " o/r", "", 7]) {
      assert.equal((await call("POST", "gh-clone", { repo })).status, 400, JSON.stringify(repo));
    }
    for (const folderName of ["..", ".", "-x", "a/b", "a\\b", "CON", "nul.txt", "a.", "C:", "../../escape"]) {
      assert.equal((await call("POST", "gh-clone", { repo: "o/r", folderName })).status, 400, folderName);
    }
    assert.equal((await call("POST", "gh-clone", { repo: "o/con" })).status, 400); // default folder = repo name, still validated
    assert.equal((await call("GET", "gh-clone")).status, 405);
    assert.equal(calls.length, 0);
    ghImpl = async () => { throw new GitError(scrubSecrets("fatal: https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/o/zz denied")); };
    const e = await call("POST", "gh-clone", { repo: "o/zz" });
    assert.equal(e.status, 502);
    assert.match(e.body.error, /^GitHub CLI: fatal: /);
    assert.doesNotMatch(e.body.error, /ghp_/);
  });

  test("gh failures map to readable messages (stubbed gh, no network)", async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    const cases = [
      ["not installed (exec 501)", () => new GitError("GitHub CLI (gh) isn't installed. whatever", 501), "clone", 424, /^GitHub CLI \(gh\) isn't installed/],
      ["not installed (raw ENOENT)", () => enoent, "repos", 424, /^GitHub CLI \(gh\) isn't installed/],
      ["not signed in (gh auth login)", () => new GitError("To get started with GitHub CLI, please run:  gh auth login"), "repos", 424, /^Not signed in to GitHub CLI — run gh auth login$/],
      ["not signed in (HTTP 401)", () => new GitError("gh: Bad credentials (HTTP 401)"), "clone", 424, /^Not signed in to GitHub CLI/],
      ["repo missing (resolve)", () => new GitError("GraphQL: Could not resolve to a Repository with the name 'o/zz'."), "clone", 424, /^Repository o\/zz not found or you don't have access$/],
      ["repo missing (HTTP 404)", () => new GitError("gh: Not Found (HTTP 404)"), "clone", 424, /^Repository o\/zz not found or you don't have access$/],
      ["timeout", () => new GitError("gh repo timed out", 504), "clone", 504, /^Timed out talking to GitHub$/],
      ["other: first line, prefixed + scrubbed", () => new GitError("boom ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 happened\nsecond line"), "repos", 502, /^GitHub CLI: boom \*\*\* happened$/],
    ];
    for (const [name, mk, kind, status, re] of cases) {
      ghImpl = async () => { throw mk(); };
      const r = kind === "repos" ? await call("GET", "gh-repos") : await call("POST", "gh-clone", { repo: "o/zz" });
      assert.equal(r.status, status, name);
      assert.match(r.body.error, re, name);
      assert.doesNotMatch(r.body.error, /ghp_/, name);
    }
    // 409 collisions keep their own message; they never reach gh.
    ghImpl = async () => { throw new Error("unreachable"); };
    mkdirSync(join(projects, "coll"));
    const c = await call("POST", "gh-clone", { repo: "o/coll" });
    assert.equal(c.status, 409);
    assert.equal(c.body.error, "folder already exists and is not a git repository");
    // gh-repos without a repo name: a 404 is not turned into "Repository … not found".
    ghImpl = async () => { throw new GitError("gh: Not Found (HTTP 404)"); };
    assert.match((await call("GET", "gh-repos")).body.error, /^GitHub CLI: /);
  });

  test("no usable projects folder: 500, gh never runs", async () => {
    calls.length = 0;
    for (const fn of [() => null, () => join(projects, "missing"), () => "relative/dir"]) {
      projectsDirFn = fn;
      assert.equal((await call("GET", "gh-repos")).status, 500);
      assert.equal((await call("POST", "gh-clone", { repo: "o/q" })).status, 500);
    }
    projectsDirFn = () => projects;
    assert.equal(calls.length, 0);
  });
});
