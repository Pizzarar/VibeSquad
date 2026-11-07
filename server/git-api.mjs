// /__vibesquad/git/*: native git + GitHub (`gh`) routes for the Changes panel, the @git context and commit links.
// Replaces the Paseo daemon's checkout RPCs. Every command is execFile with an argument array (never a shell string);
// cwd must pass resolveCwd (a known team path or agent cwd); ref names, branch names and paths that start with '-'
// are refused; output is capped. Reads are owner-gated by the caller (isGatedRead), writes by the non-GET owner gate.
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { handleGitWatch } from "./git-watch.mjs";

export const GIT_PREFIX = "/__vibesquad/git/";
export const isGitPath = (path) => path.startsWith(GIT_PREFIX);
export const GIT_READ_ACTIONS = ["status", "diff", "commits", "commit-diff", "branches", "validate-branch", "stash-list", "pr-status", "pr-timeline", "check-details", "watch"];
export const GIT_WRITE_ACTIONS = ["commit", "push", "pull", "merge-base", "switch", "stash-save", "stash-pop", "discard", "rename-branch", "pr-create", "pr-merge", "pr-automerge"];

export const MAX_OUTPUT = 400_000; // chars per response payload: keeps the JSON under the remote proxy's 512 KB text cap
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_UNTRACKED = 40;
const MAX_UNTRACKED_BYTES = 200_000;
const MAX_COMMITS = 60;
const READ_TIMEOUT = 20_000;
const WRITE_TIMEOUT = 120_000;

export class GitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- validation -------------------------------------------------------------------------------------------------

/** Returns an error string, or null when `name` is safe to pass as a ref / branch argument. */
export function badRefName(name) {
  if (typeof name !== "string" || !name.trim()) return "a branch or ref name is required";
  if (name.length > 200) return "name too long";
  if (name.startsWith("-")) return "names cannot start with '-'";
  if (/[\u0000- \u007f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.endsWith(".lock") || name.endsWith("/") || name.endsWith(".") || name.startsWith("/")) {
    return `'${name}' is not a valid branch name`;
  }
  return null;
}

/** Repo-relative path: no '-' lead, no absolute/drive/UNC, no '..' segment, no NUL. */
export function badRepoPath(p) {
  if (typeof p !== "string" || !p || p.length > 1024) return "a path is required";
  if (p.startsWith("-")) return "paths cannot start with '-'";
  if (p.includes("\0") || isAbsolute(p) || /^[A-Za-z]:/.test(p) || /^[\\/]/.test(p)) return "path must be relative to the repository";
  if (p.split(/[\\/]/).includes("..")) return "path cannot contain '..'";
  return null;
}

const HASH_RE = /^[0-9a-fA-F]{7,64}$/;

// ---- process runner ---------------------------------------------------------------------------------------------

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_EDITOR: "true", LC_ALL: "C", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };

function exec(cmd, args, cwd, { timeout = READ_TIMEOUT, okCodes = [0], env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8", env: env ?? ENV }, (err, stdout, stderr) => {
      stdout = String(stdout ?? "");
      stderr = String(stderr ?? "");
      if (!err) return resolve({ stdout, stderr, code: 0, truncated: false });
      if (err.code === "ENOENT") {
        return reject(new GitError(cmd === "gh" ? "GitHub CLI (gh) isn't installed. Install it from https://cli.github.com and run `gh auth login`." : "git isn't installed or not on PATH.", cmd === "gh" ? 501 : 500));
      }
      if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ stdout, stderr, code: 0, truncated: true });
      if (typeof err.code === "number" && okCodes.includes(err.code)) return resolve({ stdout, stderr, code: err.code, truncated: false });
      if (err.killed) return reject(new GitError(`${cmd} ${args[0] ?? ""} timed out`, 504));
      const msg = (stderr.trim() || stdout.trim() || err.message).split(/\r?\n/).slice(0, 8).join("\n");
      reject(new GitError(msg.slice(0, 2000)));
    });
    // `input` goes on stdin, never argv: Windows caps a command line at 32,767 chars.
    if (input !== undefined) child.stdin?.on("error", () => {}).end(input);
  });
}
const git = (args, cwd, opts) => exec("git", ["-c", "core.quotepath=false", "-c", "color.ui=never", ...args], cwd, opts);
const gh = (args, cwd, opts) => exec("gh", args, cwd, { timeout: 30_000, ...opts });

// ---- parsers (pure; exported for tests) -------------------------------------------------------------------------

/** Unified diff text -> the shape the Changes panel renders (add/remove/context content has its +/-/space prefix stripped, like the daemon's parser; hunkUndo relies on that): files[{path, oldPath?, isNew, isDeleted, additions, deletions, status, hunks[{..., lines[{type, content}]}]}]. */
export function parseUnifiedDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw; // CRLF diffs: every line, or later file headers stop matching
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = m ? m[2] : line.slice(11);
      f = { path, isNew: false, isDeleted: false, additions: 0, deletions: 0, hunks: [], status: "modified" };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith("new file mode")) { f.isNew = true; f.status = "added"; }
      else if (line.startsWith("deleted file mode")) { f.isDeleted = true; f.status = "deleted"; }
      else if (line.startsWith("rename from ")) { f.oldPath = line.slice(12); f.status = "renamed"; }
      else if (line.startsWith("rename to ")) f.path = line.slice(10);
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) f.binary = true;
      else if (line.startsWith("--- ")) { if (line === "--- /dev/null") f.isNew = true; }
      else if (line.startsWith("+++ ")) {
        if (line === "+++ /dev/null") f.isDeleted = true;
        else if (line.startsWith("+++ b/")) f.path = line.slice(6);
      }
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hm) {
      h = { oldStart: +hm[1], oldCount: hm[2] === undefined ? 1 : +hm[2], newStart: +hm[3], newCount: hm[4] === undefined ? 1 : +hm[4], lines: [{ type: "header", content: line }] };
      f.hunks.push(h);
      oldLine = h.oldStart;
      newLine = h.newStart;
      continue;
    }
    if (!h) continue;
    if (line.startsWith("+")) { h.lines.push({ type: "add", content: line.slice(1) }); f.additions++; newLine++; }
    else if (line.startsWith("-")) { h.lines.push({ type: "remove", content: line.slice(1) }); f.deletions++; oldLine++; }
    else if (line.startsWith(" ")) { h.lines.push({ type: "context", content: line.slice(1) }); oldLine++; newLine++; }
    // "\ No newline at end of file" and the trailing blank are dropped
  }
  for (const x of files) { if (x.isNew && x.status === "modified") x.status = "added"; if (x.isDeleted && x.status === "modified") x.status = "deleted"; if (x.binary) x.status = "binary"; delete x.binary; }
  return files;
}

/** `git status --porcelain=v2 --branch` -> { currentBranch, aheadBehind, isDirty }. */
export function parseStatus(text) {
  let currentBranch = null;
  let aheadBehind = null;
  let isDirty = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) { const b = line.slice(14).trim(); currentBranch = b === "(detached)" ? null : b; }
    else if (line.startsWith("# branch.ab ")) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) aheadBehind = { ahead: +m[1], behind: +m[2] }; }
    else if (!line.startsWith("#")) isDirty = true;
  }
  return { currentBranch, aheadBehind, isDirty };
}

/** `git log --format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI --raw --numstat --no-renames` -> commits. */
export function parseCommits(text, { unpushed = null, notOnBase = null } = {}) {
  const out = [];
  for (const block of text.split("\x1e")) {
    if (!block.trim()) continue;
    const [head, ...rest] = block.split("\n");
    const [sha, shortSha, subject, authorName, authorDate] = head.split("\x1f");
    const status = new Map();
    const files = [];
    for (const l of rest) {
      if (l.startsWith(":")) { const m = /^:\S+ \S+ \S+ \S+ (\w)\t(.+)$/.exec(l); if (m) status.set(m[2], m[1]); continue; }
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (m) files.push({ path: m[3], additions: m[1] === "-" ? 0 : +m[1], deletions: m[2] === "-" ? 0 : +m[2], status: { A: "added", D: "deleted", M: "modified" }[status.get(m[3])] ?? "modified" });
    }
    out.push({ sha, shortSha, subject, authorName, authorDate, isOnRemote: unpushed ? !unpushed.has(sha) : false, isOnBase: notOnBase ? !notOnBase.has(sha) : undefined, files });
  }
  return out;
}

const clip = (s, n = MAX_OUTPUT) => (s.length > n ? { text: s.slice(0, n), tooLarge: true } : { text: s, tooLarge: false });

// ---- git helpers ------------------------------------------------------------------------------------------------

async function isRepo(cwd) {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], cwd)).stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function requireRepo(cwd) {
  if (!(await isRepo(cwd))) throw new GitError("not a git repository", 400);
}

async function refExists(cwd, ref) {
  try {
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** The branch changes are measured against: origin's default, else main/master (local or origin). Never user input. */
export async function detectBaseRef(cwd) {
  try {
    const r = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)).stdout.trim();
    if (r && !badRefName(r) && (await refExists(cwd, r))) return r;
  } catch {}
  for (const c of ["origin/main", "origin/master", "main", "master"]) if (await refExists(cwd, c)) return c;
  return null;
}

async function hasUpstream(cwd) {
  try {
    await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
    return true;
  } catch {
    return false;
  }
}

async function diffUncommitted(cwd) {
  const hasHead = await refExists(cwd, "HEAD");
  const base = await git(["diff", "--no-color", "--no-ext-diff", "-M", ...(hasHead ? ["HEAD"] : ["--cached"]), "--"], cwd);
  let text = base.stdout;
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).stdout.split("\0").filter(Boolean);
  for (const p of untracked.slice(0, MAX_UNTRACKED)) {
    if (badRepoPath(p)) continue;
    try {
      const st = lstatSync(join(cwd, p)); // lstat: an untracked symlink is skipped, never followed
      if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
      text += (await git(["diff", "--no-color", "--no-index", "--", "/dev/null", p], cwd, { okCodes: [0, 1] })).stdout;
    } catch {}
  }
  return { text, truncated: base.truncated };
}

async function loadDiff(cwd, mode) {
  let r;
  if (mode === "staged") r = await git(["diff", "--no-color", "--no-ext-diff", "-M", "--cached", "--"], cwd);
  else if (mode === "base") {
    const base = await detectBaseRef(cwd);
    if (!base) throw new GitError("no base branch found (looked for origin/HEAD, main, master)");
    r = await git(["diff", "--no-color", "--no-ext-diff", "-M", `${base}...HEAD`, "--"], cwd);
  } else r = await diffUncommitted(cwd);
  const c = clip(r.text ?? r.stdout);
  return { files: parseUnifiedDiff(c.text), diffTooLarge: c.tooLarge || !!r.truncated };
}

const stashEntry = (line) => {
  const [ref, subject = ""] = line.split("\x1f");
  const index = Number(/\{(\d+)\}/.exec(ref)?.[1] ?? -1);
  const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject);
  return { index, message: m ? m[2] : subject, branch: m ? m[1] : null, isPaseo: false };
};

// ---- gh helpers -------------------------------------------------------------------------------------------------

const noPr = (e) => /no pull requests? found|could not find any pull request/i.test(e?.message ?? "");

function mapChecks(rollup) {
  return (rollup ?? []).map((c) => {
    const url = c.detailsUrl ?? c.targetUrl ?? null;
    const m = url ? /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url) : null;
    const state = String(c.conclusion || c.state || c.status || "").toLowerCase();
    return {
      name: c.name ?? c.context ?? "check",
      status: ["success", "neutral", "skipped"].includes(state) ? "success" : ["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"].includes(state) ? "failure" : "pending",
      url,
      ...(m?.[2] ? { checkRunId: Number(m[2]) } : {}),
      ...(m ? { workflowRunId: Number(m[1]) } : {}),
    };
  });
}

async function prStatus(cwd) {
  try {
    const [view, repo] = await Promise.all([
      gh(["pr", "view", "--json", "number,url,title,state,isDraft,mergedAt,statusCheckRollup,autoMergeRequest,baseRefName"], cwd),
      gh(["repo", "view", "--json", "autoMergeAllowed"], cwd).catch(() => null),
    ]);
    const p = JSON.parse(view.stdout);
    const checks = mapChecks(p.statusCheckRollup);
    const checksStatus = !checks.length ? "none" : checks.some((c) => c.status === "failure") ? "failure" : checks.some((c) => c.status === "pending") ? "pending" : "success";
    const autoMergeAllowed = repo ? JSON.parse(repo.stdout).autoMergeAllowed !== false : true;
    return {
      status: {
        number: p.number, url: p.url, title: p.title, state: String(p.state ?? "").toLowerCase(), isMerged: p.state === "MERGED", isDraft: !!p.isDraft,
        baseRefName: p.baseRefName, checks, checksStatus,
        github: { autoMergeRequest: p.autoMergeRequest ? { mergeMethod: String(p.autoMergeRequest.mergeMethod ?? "").toLowerCase() } : null, viewerCanEnableAutoMerge: autoMergeAllowed, viewerCanDisableAutoMerge: true, autoMergeAllowed },
      },
      githubFeaturesEnabled: true, error: null, forge: "github",
    };
  } catch (e) {
    if (noPr(e)) return { status: null, githubFeaturesEnabled: true, error: null, forge: "github" };
    return { status: null, githubFeaturesEnabled: !(e instanceof GitError && e.status === 501), error: { message: e.message }, forge: "github" };
  }
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

// ---- handler ----------------------------------------------------------------------------------------------------

const writeChains = new Map(); // cwd -> tail promise: one write at a time per repo (index.lock)
function serialized(cwd, fn) {
  const tail = (writeChains.get(cwd) ?? Promise.resolve()).catch(() => {});
  const run = tail.then(fn);
  writeChains.set(cwd, run);
  run.catch(() => {}).finally(() => { if (writeChains.get(cwd) === run) writeChains.delete(cwd); });
  return run;
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

async function runRead(action, q, cwd) {
  if (action === "status") {
    if (!(await isRepo(cwd))) return { isGit: false, currentBranch: null, isDirty: null, aheadBehind: null, baseRef: null, error: { code: "NOT_GIT_REPO", message: "Not a git repository" } };
    const [st, baseRef] = await Promise.all([git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], cwd), detectBaseRef(cwd)]);
    return { isGit: true, ...parseStatus(st.stdout), baseRef, error: null };
  }
  await requireRepo(cwd);
  switch (action) {
    case "diff": {
      const mode = q("mode") || "uncommitted";
      if (!["uncommitted", "staged", "base"].includes(mode)) throw new GitError("mode must be uncommitted, staged or base");
      return loadDiff(cwd, mode);
    }
    case "commits": {
      const [baseRef, up] = await Promise.all([detectBaseRef(cwd), hasUpstream(cwd)]);
      const log = await git(["log", `-n${MAX_COMMITS}`, "--no-color", "--no-renames", "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI", "--raw", "--numstat"], cwd).catch((e) => {
        if (/does not have any commits|unknown revision/i.test(e.message)) return { stdout: "" };
        throw e;
      });
      const set = async (range) => new Set((await git(["rev-list", range], cwd).catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean));
      const unpushed = up ? await set("@{u}..HEAD") : null;
      const notOnBase = baseRef ? await set(`${baseRef}..HEAD`) : null;
      return { baseRef, commits: parseCommits(log.stdout, { unpushed, notOnBase }) };
    }
    case "commit-diff": {
      const hash = q("hash");
      if (!HASH_RE.test(hash)) throw new GitError("hash must be 7-64 hex characters");
      const path = q("path");
      if (path) { const bad = badRepoPath(path); if (bad) throw new GitError(bad); }
      if (!(await refExists(cwd, hash))) throw new GitError("no such commit", 404);
      const [meta, show] = await Promise.all([
        git(["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", hash], cwd),
        git(["show", "--format=", "--no-color", "--no-ext-diff", "--no-renames", "-p", hash, ...(path ? ["--", path] : ["--"])], cwd),
      ]);
      const [sha, shortSha, subject, authorName, authorDate] = meta.stdout.trim().split("\x1f");
      const c = clip(show.stdout);
      const files = parseUnifiedDiff(c.text);
      return { commit: { sha, shortSha, subject, authorName, authorDate }, files, file: path ? files[0] ?? null : undefined, diffTooLarge: c.tooLarge || show.truncated };
    }
    case "branches": {
      const r = await git(["branch", "--list", "--format=%(HEAD)%1f%(refname:short)"], cwd);
      const branches = r.stdout.split("\n").filter(Boolean).map((l) => { const [h, name] = l.split("\x1f"); return { name, current: h === "*" }; }).filter((b) => !b.name.startsWith("("));
      return { current: branches.find((b) => b.current)?.name ?? null, branches };
    }
    case "validate-branch": {
      const name = q("name");
      const bad = badRefName(name);
      if (bad) return { exists: false, error: bad };
      try { await git(["check-ref-format", "--branch", name], cwd); } catch { return { exists: false, error: `'${name}' is not a valid branch name` }; }
      return { exists: await refExists(cwd, `refs/heads/${name}`), error: null };
    }
    case "stash-list": {
      const r = await git(["stash", "list", "--format=%gd%x1f%gs"], cwd);
      return { entries: r.stdout.split("\n").filter(Boolean).map(stashEntry) };
    }
    case "pr-status": return prStatus(cwd);
    case "pr-timeline": {
      const n = Number(q("number"));
      if (!Number.isInteger(n) || n < 1) throw new GitError("number must be a positive integer");
      const r = JSON.parse((await gh(["pr", "view", String(n), "--json", "comments,reviews"], cwd)).stdout);
      const items = [
        ...(r.comments ?? []).map((c, i) => ({ id: c.id ?? `c${i}`, kind: "comment", author: c.author?.login ?? "", body: str(c.body, 4000), createdAt: Date.parse(c.createdAt) || 0, url: c.url ?? "" })),
        ...(r.reviews ?? []).map((c, i) => ({ id: c.id ?? `r${i}`, kind: "review", author: c.author?.login ?? "", body: str(c.body, 4000), createdAt: Date.parse(c.submittedAt) || 0, url: "", reviewState: String(c.state ?? "").toLowerCase() })),
      ].sort((a, b) => a.createdAt - b.createdAt);
      return { items: items.slice(-100), truncated: items.length > 100 };
    }
    case "check-details": {
      const id = Number(q("checkRunId"));
      const owner = q("owner");
      const name = q("name");
      if (!Number.isInteger(id) || id < 1 || !NAME_RE.test(owner) || !NAME_RE.test(name)) throw new GitError("owner, name and checkRunId are required");
      const r = JSON.parse((await gh(["api", `repos/${owner}/${name}/check-runs/${id}`], cwd)).stdout);
      return { details: { name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url, output: { title: r.output?.title ?? null, summary: str(r.output?.summary, 4000) || null, text: str(r.output?.text, 8000) || null } } };
    }
  }
  throw new GitError("not found", 404);
}

async function runWrite(action, body, cwd) {
  await requireRepo(cwd);
  switch (action) {
    case "commit": {
      const message = str(body.message, 10_000).trim();
      if (!message) throw new GitError("enter a commit message");
      if (body.addAll !== false) await git(["add", "-A"], cwd, { timeout: WRITE_TIMEOUT });
      await git(["commit", "-F", "-"], cwd, { timeout: WRITE_TIMEOUT, input: message });
      return { ok: true };
    }
    case "push":
      await git(["push", ...((await hasUpstream(cwd)) ? [] : ["--set-upstream", "origin", "HEAD"])], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    case "pull":
      await git(["pull", "--ff-only"], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    case "merge-base": {
      const base = await detectBaseRef(cwd);
      if (!base) throw new GitError("no base branch found");
      await git(["merge", "--no-edit", base], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    }
    case "switch": {
      const branch = body.branch;
      const bad = badRefName(branch);
      if (bad) throw new GitError(bad);
      await git(["switch", branch], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    }
    case "stash-save":
      await git(["stash", "push", "--include-untracked", "-m", "VibeSquad stash"], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    case "stash-pop": {
      const i = body.index === undefined ? 0 : Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i > 1000) throw new GitError("bad stash index");
      await git(["stash", "pop", `stash@{${i}}`], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    }
    case "discard": {
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length || paths.length > 500) throw new GitError("paths: 1-500 repo-relative paths");
      for (const p of paths) { const bad = badRepoPath(p); if (bad) throw new GitError(bad); }
      // "Tracked" = in the index or in HEAD: a staged rename's old name is only in HEAD, and must be restored, not `clean`ed.
      const listed = [(await git(["ls-files", "-z", "--", ...paths], cwd)).stdout];
      if (await refExists(cwd, "HEAD")) listed.push((await git(["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...paths], cwd)).stdout);
      const tracked = new Set(listed.flatMap((o) => o.split("\0").filter(Boolean)));
      const norm = (p) => p.replace(/\\/g, "/");
      const isTracked = (p) => tracked.has(norm(p));
      const t = paths.filter(isTracked);
      const u = paths.filter((p) => !isTracked(p));
      if (t.length) await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...t], cwd, { timeout: WRITE_TIMEOUT });
      if (u.length) await git(["clean", "-fd", "--", ...u], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    }
    case "rename-branch": {
      const branch = body.branch;
      const bad = badRefName(branch);
      if (bad) throw new GitError(bad);
      await git(["branch", "-m", branch], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true, currentBranch: branch };
    }
    case "pr-create": {
      const title = str(body.title, 300).trim();
      if (!title) throw new GitError("enter a PR title");
      const args = ["pr", "create", "--title", title, "--body", str(body.body, 20_000)];
      if (body.baseRef) { const bad = badRefName(body.baseRef); if (bad) throw new GitError(bad); args.push("--base", body.baseRef); }
      await git(["push", "--set-upstream", "origin", "HEAD"], cwd, { timeout: WRITE_TIMEOUT });
      const r = await gh(args, cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true, url: r.stdout.trim().split("\n").pop() };
    }
    case "pr-merge": {
      const method = body.method ?? "merge";
      if (!["merge", "squash", "rebase"].includes(method)) throw new GitError("method must be merge, squash or rebase");
      await gh(["pr", "merge", `--${method}`], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    }
    case "pr-automerge": {
      const method = body.method ?? "merge";
      if (!["merge", "squash", "rebase"].includes(method)) throw new GitError("method must be merge, squash or rebase");
      await gh(body.enabled === false ? ["pr", "merge", "--disable-auto"] : ["pr", "merge", "--auto", `--${method}`], cwd, { timeout: WRITE_TIMEOUT });
      return { ok: true };
    }
  }
  throw new GitError("not found", 404);
}

/**
 * @param {{ readBody: Function, sendJson: Function, resolveCwd: (cwd: string) => string | null | Promise<string | null> }} deps
 * resolveCwd returns the real path of a cwd inside a known team / agent path, or null (refused).
 */
export async function handleGitApi(req, res, { readBody, sendJson, resolveCwd }) {
  try {
    const url = new URL(req.url, "http://x");
    const action = url.pathname.slice(GIT_PREFIX.length);
    const isRead = GIT_READ_ACTIONS.includes(action);
    const isWrite = GIT_WRITE_ACTIONS.includes(action);
    if (!isRead && !isWrite) return sendJson(res, 404, { error: "not found" });
    if (req.method !== (isRead ? "GET" : "POST")) return sendJson(res, 405, { error: "method not allowed" });
    const body = isWrite ? ((await readBody(req)) ?? {}) : {};
    const rawCwd = isRead ? url.searchParams.get("cwd") : body.cwd;
    const cwd = typeof rawCwd === "string" && rawCwd ? await resolveCwd(rawCwd) : null;
    if (!cwd) return sendJson(res, 403, { error: "cwd is not inside a known team or agent path" });
    if (action === "watch") return await handleGitWatch(req, res, cwd, url.searchParams.get("since"), sendJson);
    if (isRead) return sendJson(res, 200, await runRead(action, (k) => url.searchParams.get(k) ?? "", cwd));
    return sendJson(res, 200, await serialized(cwd, () => runWrite(action, body, cwd)));
  } catch (err) {
    if (res.headersSent) return res.end();
    return sendJson(res, err?.status >= 400 ? err.status : err instanceof SyntaxError ? 502 : 500, { error: String(err?.message ?? err) });
  }
}
