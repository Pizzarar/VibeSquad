// Shared-master push guard (idea-452, Hub14 standing rule).
//
// Every lane lead merges into the same local master. A lead who pushes master also pushes every other
// lane's unpushed merge sitting under its own (11-21: an unverified @bug merge reached origin that way).
// This guard runs as a git pre-push hook (.githooks/pre-push, installed by `vs push-guard install`, which sets
// core.hooksPath=.githooks) and as `vs push-guard check`. For a push that updates the shared branch it lists
// the first-parent merge commits in <remote tip>..<local tip>, reads each merge's lane from the `(@<lane>` tag
// in its subject, and refuses when any belongs to a lane other than the pusher's, has no lane tag, or the
// pusher's lane is unknown, unless that merge's sha is explicitly included.
//
// Pusher lane: VS_PUSH_LANE / `git -c vs.pushLane=<lane>`, else VS_LANE (set by VS on every agent).
// Include:     VS_PUSH_INCLUDE=<sha>[,<sha>] / `git -c vs.pushInclude=<sha>[,<sha>] push ...` (one-shot).
// Only refs/heads/master and refs/heads/main are guarded: unit branches and tags (release.mjs pushes
// refs/tags/beta) pass untouched. The shared remote is origin: a push there is checked against the tip origin
// reports; a push of master to any other remote (the dev mirror lags origin) is checked against the local
// origin/<branch> tip instead, so mirroring what origin already has never trips the guard.
//
// idea-883 verdict gate (same hooks dir): every unit merge (`Merge unit-…` / `Merge branch 'unit-…'`) in a guarded push, and
// every `git merge` of a unit branch into master/main (.githooks/pre-merge-commit; .githooks/pre-commit for a conflicted
// merge's final commit), needs a recorded PASS on the merged tip: the latest team-log `done` entry naming that tip's hash
// (server/verdict.mjs latestRecordedVerdict). FAIL or none refuses. Override (owner/lead only):
// `git -c vs.verdictOverride=<sha> merge|push ...` or VS_VERDICT_OVERRIDE=<sha>[,<sha>].
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateMergeVerdicts, formatVerdictRefusal, isUnitMergeSubject, latestRecordedVerdict } from "./verdict.mjs";

export const GUARDED_REFS = Object.freeze(["refs/heads/master", "refs/heads/main"]);
export const HOOKS_PATH = ".githooks";
export const SHARED_REMOTE = "origin";
const ZERO = /^0+$/;
const SEP = "\x1f";

/** The lane tag of a merge subject: the first `(@<lane>` handle, e.g. "Merge branch 'x': ... (@bug idea-1; ...)" -> "bug". */
export function parseLaneTag(subject) {
  const m = /\(@([A-Za-z][A-Za-z0-9-]*)/.exec(String(subject ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/** Split a comma/space list of sha prefixes; keeps only 7-40 hex chars, lowercased. */
export function parseIncludes(...sources) {
  const out = [];
  for (const src of sources.flat()) {
    for (const tok of String(src ?? "").split(/[\s,]+/)) {
      const t = tok.trim().toLowerCase();
      if (/^[0-9a-f]{7,40}$/.test(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function laneIdOf(query, teams, preferTeamId, findLane) {
  const q = String(query ?? "").replace(/^@+/, "").trim().toLowerCase();
  if (!q) return null;
  const found = findLane ? findLane(q, teams, preferTeamId) : null;
  return found ? String(found.lane.id).toLowerCase() : null;
}

/**
 * Decide one push. Pure: the caller supplies the merges and the lane lookup.
 * merges: [{ sha, subject }]; pusherLane: lane id/code/handle or ""; includes: sha prefixes;
 * findLane(query, teams, preferTeamId) -> { team, lane } | null (server/identity.mjs findLaneInRegistry).
 * Returns { ok, pusher, own: [], included: [], refused: [{ sha, subject, tag, lane, reason }] }.
 */
export function evaluatePush({ merges = [], pusherLane = "", pusherTeam = "", includes = [], teams = [], findLane = null } = {}) {
  const rawPusher = String(pusherLane ?? "").replace(/^@+/, "").trim().toLowerCase();
  const pusher = rawPusher ? (laneIdOf(rawPusher, teams, pusherTeam, findLane) ?? rawPusher) : "";
  const inc = parseIncludes(includes);
  const own = [];
  const included = [];
  const refused = [];
  for (const m of merges) {
    const sha = String(m.sha).toLowerCase();
    const tag = parseLaneTag(m.subject);
    const lane = tag ? (laneIdOf(tag, teams, pusherTeam, findLane) ?? tag) : null;
    const entry = { sha, subject: m.subject, tag, lane };
    if (inc.some((p) => sha.startsWith(p))) {
      included.push(entry);
    } else if (!pusher) {
      refused.push({ ...entry, reason: "unknown-pusher" });
    } else if (!tag) {
      refused.push({ ...entry, reason: "untagged" });
    } else if (lane !== pusher) {
      refused.push({ ...entry, reason: "other-lane" });
    } else {
      own.push(entry);
    }
  }
  return { ok: refused.length === 0, pusher, own, included, refused };
}

/** Human-readable refusal for stderr; "" when the push is allowed. */
export function formatRefusal(result, { ref = "refs/heads/master" } = {}) {
  if (result.ok) return "";
  const short = (s) => s.slice(0, 8);
  const lines = [
    `vs push-guard: refusing to push ${ref}: it carries merges ${result.pusher ? `lane ${result.pusher}` : "the pusher"} did not make or cannot vouch for.`,
  ];
  for (const r of result.refused) {
    const why =
      r.reason === "other-lane"
        ? `lane @${r.tag}: ask that lane's lead (vs who lead --lane ${r.lane}) to push it; never push it for them`
        : r.reason === "untagged"
          ? "no (@<lane> tag in the subject, so the guard cannot tell whose merge it is"
          : "the pushing lane is unknown (VS_LANE unset)";
    lines.push(`  ${short(r.sha)} ${String(r.subject).slice(0, 90)}`);
    lines.push(`           ${why}`);
  }
  lines.push(
    "Rule: before pushing master, fetch and read `git log origin/master..HEAD`; push only merges your own lane made and verified.",
  );
  if (result.refused.some((r) => r.reason === "unknown-pusher")) {
    lines.push("Unknown pusher: run inside a VS agent (VS_LANE is set for you), or name your lane once: git -c vs.pushLane=<lane> push ...");
  }
  const shas = result.refused.map((r) => short(r.sha)).join(",");
  lines.push(
    `Override, only for a merge that is yours or that its lead/the owner OKed: git -c vs.pushInclude=${shas} push ... (or VS_PUSH_INCLUDE=${shas}).`,
  );
  return `${lines.join("\n")}\n`;
}

// ---- git plumbing ----

function defaultGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function parsePrePushLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/** True when the push goes to the shared remote, by name or by its URL (`git push <url> master`). */
export function isSharedRemote(remote, url = "", { cwd = process.cwd(), git = defaultGit } = {}) {
  if (remote === SHARED_REMOTE) return true;
  let sharedUrl = "";
  try {
    sharedUrl = git(["remote", "get-url", SHARED_REMOTE], cwd).trim();
  } catch { /* no origin remote */ }
  return Boolean(sharedUrl) && (url === sharedUrl || remote === sharedUrl);
}

/**
 * The revisions to exclude for one push. Shared remote: its real tip (all-zero = new branch: everything not on any
 * origin ref). Other remote: the local origin/<branch> tip, so only what origin has not got yet must be yours; with
 * no such ref it falls back to the target remote's own tip.
 */
export function pushBase({ remoteSha, remote = SHARED_REMOTE, shared = remote === SHARED_REMOTE, branch = "master", cwd = process.cwd(), git = defaultGit }) {
  if (!shared) {
    try {
      const tip = git(["rev-parse", "--verify", "--quiet", `refs/remotes/${SHARED_REMOTE}/${branch}^{commit}`], cwd).trim();
      if (tip) return { exclude: [tip], label: `${SHARED_REMOTE}/${branch}` };
    } catch { /* no origin tracking ref */ }
  }
  if (remoteSha && !ZERO.test(remoteSha)) return { exclude: [remoteSha], label: `${remote} ${branch}` };
  return { exclude: [`--remotes=${remote}`], label: `${remote} (new branch)` };
}

/** First-parent merges in the push range, newest first; `exclude` comes from pushBase. */
export function listPushMerges({ localSha, exclude, cwd = process.cwd(), git = defaultGit }) {
  const range = [localSha, "--not", ...exclude];
  const fmt = `--format=%H${SEP}%P${SEP}%s`;
  const out = git(["log", "--first-parent", fmt, ...range, "--"], cwd);
  const merges = [];
  const direct = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [sha, parents, subject = ""] = line.split(SEP);
    const ps = parents.trim().split(/\s+/);
    // idea-883: `tip` = the merged branch head (second parent), whose recorded verdict gates the push.
    if (ps.length > 1) merges.push({ sha, subject, tip: ps[1] });
    else direct.push({ sha, subject });
  }
  return { merges, direct };
}

function gitConfigAll(key, cwd, git) {
  try {
    return git(["config", "--get-all", key], cwd).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Who is pushing and what they included: env first, then `git -c vs.push*` (visible to hooks via GIT_CONFIG_PARAMETERS). */
export function pusherFromEnv({ env = process.env, cwd = process.cwd(), git = defaultGit } = {}) {
  const lane = String(env.VS_PUSH_LANE ?? "").trim() || gitConfigAll("vs.pushLane", cwd, git).at(-1) || String(env.VS_LANE ?? "").trim();
  const team = String(env.VS_TEAM ?? "").trim();
  const includes = parseIncludes(env.VS_PUSH_INCLUDE ?? "", gitConfigAll("vs.pushInclude", cwd, git));
  return { lane, team, includes };
}

/** idea-883: verdict-gate overrides (owner/lead): VS_VERDICT_OVERRIDE + `git -c vs.verdictOverride=<sha>[,<sha>]`. */
export function verdictOverrides({ env = process.env, cwd = process.cwd(), git = defaultGit } = {}) {
  return parseIncludes(env.VS_VERDICT_OVERRIDE ?? "", gitConfigAll("vs.verdictOverride", cwd, git));
}

/** idea-883: the VS home whose team logs hold recorded verdicts: an explicit `home`, else env.VIBESQUAD_HOME, else ~/.vibesquad. */
export function verdictHome({ home, env = process.env } = {}) {
  return path.resolve(home || env.VIBESQUAD_HOME || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
}

/**
 * idea-883: `recorded(tip)` over every Squad's team log under the VS home (VIBESQUAD_HOME or ~/.vibesquad). Only lines that
 * mention one of `tips`' 7-char prefixes are parsed (a verdict hash is 7+ hex chars of the tip). A missing/unreadable log
 * records nothing, so the gate refuses (fail closed).
 */
export function readRecordedVerdicts({ tips = [], home = verdictHome() } = {}) {
  const want = [...new Set(tips.map((t) => String(t ?? "").toLowerCase()).filter((t) => /^[0-9a-f]{7,64}$/.test(t)))];
  const byTip = new Map(want.map((t) => [t, []]));
  const keys = [...new Set(want.map((t) => t.slice(0, 7)))];
  let teams = [];
  try {
    teams = fs.readdirSync(path.join(home, "teams"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { /* no VS home: nothing recorded */ }
  if (keys.length) {
    for (const team of teams) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(home, "teams", team, "log.jsonl"), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const low = line.toLowerCase();
        if (!keys.some((k) => low.includes(k))) continue;
        let e;
        try {
          e = JSON.parse(line.replace(/^\uFEFF/, ""));
        } catch {
          continue;
        }
        for (const t of want) if (low.includes(t.slice(0, 7))) byTip.get(t).push(e);
      }
    }
  }
  // Each Squad's log is in append order; across Squads, order by ts so "latest" is the newest entry anywhere.
  for (const list of byTip.values()) list.sort((a, b) => (Date.parse(a?.ts ?? "") || 0) - (Date.parse(b?.ts ?? "") || 0));
  return (tip) => latestRecordedVerdict(byTip.get(String(tip ?? "").toLowerCase()) ?? [], tip);
}

async function defaultTeams() {
  const { loadTeamsRegistry, findLaneInRegistry } = await import("./identity.mjs");
  return { teams: loadTeamsRegistry(), findLane: findLaneInRegistry };
}

/**
 * Check every guarded ref update of one push. Returns { ok, message, results: [{ ref, result, direct }] }.
 * A range git cannot walk (remote tip not fetched) fails closed.
 */
export async function checkPush({ updates, remote = SHARED_REMOTE, url = "", cwd = process.cwd(), env = process.env, git = defaultGit, registry, home } = {}) {
  const guarded = updates.filter((u) => GUARDED_REFS.includes(u.remoteRef) && !ZERO.test(u.localSha));
  if (!guarded.length) return { ok: true, message: "", results: [] };
  const { teams, findLane } = registry ?? (await defaultTeams());
  const who = pusherFromEnv({ env, cwd, git });
  const shared = isSharedRemote(remote, url, { cwd, git });
  const results = [];
  let message = "";
  for (const u of guarded) {
    const branch = u.remoteRef.replace("refs/heads/", "");
    let listed;
    try {
      const base = pushBase({ remoteSha: u.remoteSha, remote, shared, branch, cwd, git });
      listed = listPushMerges({ localSha: u.localSha, exclude: base.exclude, cwd, git });
    } catch (err) {
      message += `vs push-guard: cannot read ${remote} ${u.remoteRef}..${u.localSha.slice(0, 8)} (${String(err?.message ?? err).split("\n")[0]}). Run \`git fetch ${remote}\`, read \`git log ${SHARED_REMOTE}/${branch}..HEAD\`, then push again.\n`;
      results.push({ ref: u.remoteRef, result: null, direct: [] });
      continue;
    }
    const result = evaluatePush({ merges: listed.merges, pusherLane: who.lane, pusherTeam: who.team, includes: who.includes, teams, findLane });
    // idea-883: a pushed unit merge needs a recorded PASS on its merged tip. vs.pushInclude (whose lane) never waives it.
    const unit = listed.merges.filter((m) => isUnitMergeSubject(m.subject));
    const recorded = unit.length ? readRecordedVerdicts({ tips: unit.map((m) => m.tip), home: verdictHome({ home, env }) }) : () => null;
    const verdict = evaluateMergeVerdicts({ merges: unit, recorded, overrides: verdictOverrides({ env, cwd, git }) });
    results.push({ ref: u.remoteRef, result, direct: listed.direct, verdict });
    message += formatRefusal(result, { ref: u.remoteRef });
    message += formatVerdictRefusal(verdict, { action: "push" });
  }
  const ok = results.every((r) => r.result?.ok && (r.verdict?.ok ?? true));
  return { ok, message, results };
}

/**
 * idea-883: the merged heads of the merge in progress, as [{ name, tip }]. git runs pre-merge-commit BEFORE it writes
 * MERGE_HEAD / MERGE_MSG, so there the heads come from GIT_REFLOG_ACTION (`merge <name>...` as typed; `pull ...` merges
 * FETCH_HEAD's for-merge lines). On a conflicted merge's final `git commit` (pre-commit) MERGE_HEAD exists and is used.
 * `msg` is MERGE_MSG's subject when there is one. null = a merge whose heads can't be named (left to the push gate).
 */
export function mergeInProgress({ cwd = process.cwd(), env = process.env, git = defaultGit } = {}) {
  const gitPath = (name) => path.resolve(cwd, git(["rev-parse", "--git-path", name], cwd).trim());
  const read = (name) => {
    try {
      return fs.readFileSync(gitPath(name), "utf8");
    } catch {
      return null;
    }
  };
  const isSha = (t) => /^[0-9a-f]{40,64}$/i.test(t);
  const mergeHead = read("MERGE_HEAD");
  if (mergeHead != null) {
    const msg = String(read("MERGE_MSG") ?? "").split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) ?? "";
    return { heads: mergeHead.split(/\s+/).filter(isSha).map((tip) => ({ name: "", tip })), msg: msg.trim() };
  }
  const action = String(env.GIT_REFLOG_ACTION ?? "").trim();
  if (/^merge\s+\S/.test(action)) {
    const heads = [];
    for (const raw of action.split(/\s+/).slice(1)) {
      const name = raw === "-" ? "@{-1}" : raw;
      let tip = "";
      try {
        tip = git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], cwd).trim();
      } catch { /* unresolvable */ }
      if (!isSha(tip)) return null;
      let sym = name;
      if (/^@\{-\d+\}$/.test(name)) {
        try {
          sym = git(["rev-parse", "--symbolic-full-name", name], cwd).trim() || name;
        } catch { /* keep @{-N} */ }
      }
      heads.push({ name: sym, tip });
    }
    return { heads, msg: "" };
  }
  if (/^pull\b/.test(action)) {
    const heads = String(read("FETCH_HEAD") ?? "")
      .split(/\r?\n/)
      .map((l) => l.split("\t"))
      .filter(([sha, flag]) => isSha(sha ?? "") && flag === "")
      .map(([tip, , desc = ""]) => ({ name: (/^branch '([^']+)'/.exec(desc) ?? [])[1] ?? "", tip }));
    return heads.length ? { heads, msg: "" } : null;
  }
  return null;
}

/** Is `name` (as typed or a full ref) a unit branch: unit-x, refs/heads/unit-x, <remote>/unit-x, refs/remotes/<remote>/unit-x. */
export function isUnitBranchName(name, remotes = [SHARED_REMOTE]) {
  let n = String(name ?? "").trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
  for (const r of remotes) if (n.startsWith(`${r}/`)) n = n.slice(r.length + 1);
  return n.startsWith("unit-");
}

/**
 * idea-883: the pre-merge-commit (and pre-commit while MERGE_HEAD exists) gate. On master/main, a merged head is a unit merge
 * when it is named as a unit branch (`git merge unit-x` / `origin/unit-x`), MERGE_MSG says `Merge unit-…`, or (any other name,
 * e.g. a sha) a unit-* branch points at it, unless origin's copy of this branch already contains it (`git pull`, `git merge
 * origin/master`: nothing unreviewed comes in, though a fresh unit branch may point there). Each needs a recorded PASS.
 * Returns { ok, message, verdict }.
 */
export function checkMergeCommit({ cwd = process.cwd(), env = process.env, git = defaultGit, home } = {}) {
  const pass = { ok: true, message: "", verdict: null };
  let ref = "";
  try {
    ref = git(["symbolic-ref", "-q", "HEAD"], cwd).trim();
  } catch {
    return pass; // detached HEAD: not a shared-branch merge
  }
  if (!GUARDED_REFS.includes(ref)) return pass;
  const merging = mergeInProgress({ cwd, env, git });
  if (!merging) return pass; // heads unknown (not a merge, or a tool's own GIT_REFLOG_ACTION): the pre-push gate still checks
  let remotes = [SHARED_REMOTE];
  try {
    remotes = git(["remote"], cwd).split(/\r?\n/).filter(Boolean);
  } catch { /* origin only */ }
  const shared = `refs/remotes/${SHARED_REMOTE}/${ref.slice("refs/heads/".length)}`;
  const onShared = (tip) => {
    try {
      git(["merge-base", "--is-ancestor", tip, shared], cwd);
      return true;
    } catch {
      return false;
    }
  };
  const unitRefAt = (tip) => {
    try {
      return git(["for-each-ref", "--points-at", tip, "--format=%(refname)", "refs/heads/", "refs/remotes/"], cwd)
        .split(/\r?\n/)
        .find((n) => n && isUnitBranchName(n, remotes)) ?? "";
    } catch {
      return "";
    }
  };
  const short = (n) => n.replace(/^refs\/(?:heads|remotes)\//, "");
  const unit = [];
  for (const { name, tip } of merging.heads) {
    let subject = "";
    if (isUnitMergeSubject(merging.msg)) subject = merging.msg;
    else if (name && isUnitBranchName(name, remotes)) subject = `Merge ${short(name)}`;
    else if (!onShared(tip)) {
      const at = unitRefAt(tip);
      if (at) subject = `Merge ${short(at)} (merged as ${name && !/^[0-9a-f]{40,64}$/i.test(name) ? short(name) : tip.slice(0, 8)})`;
    }
    if (subject) unit.push({ sha: "", subject, tip });
  }
  if (!unit.length) return pass;
  const recorded = readRecordedVerdicts({ tips: unit.map((m) => m.tip), home: verdictHome({ home, env }) });
  const verdict = evaluateMergeVerdicts({ merges: unit, recorded, overrides: verdictOverrides({ env, cwd, git }) });
  return { ok: verdict.ok, message: formatVerdictRefusal(verdict, { action: "merge" }), verdict };
}

/** `vs push-guard check`: what the hook would decide for pushing HEAD to <remote>/<branch> now. */
export async function checkHead({ remote = SHARED_REMOTE, branch = "master", cwd = process.cwd(), env = process.env, git = defaultGit, registry, home } = {}) {
  const localSha = git(["rev-parse", "HEAD"], cwd).trim();
  let remoteSha = "0".repeat(40);
  try {
    remoteSha = git(["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`], cwd).trim();
  } catch { /* no tracking ref: every unpushed commit */ }
  return checkPush({ updates: [{ localRef: "HEAD", localSha, remoteRef: `refs/heads/${branch}`, remoteSha }], remote, cwd, env, git, registry, home });
}

/** Active (non-.sample) hooks in the repo's default hooks dir; core.hooksPath would silently disable them. */
export function activeDefaultHooks({ cwd = process.cwd(), git = defaultGit } = {}) {
  let dir = "";
  try {
    dir = path.resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd).trim(), "hooks");
  } catch {
    return [];
  }
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.endsWith(".sample")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Point the repo's hooks at the tracked .githooks dir (relative: each worktree runs its own checkout's hook). */
export function installHooks({ cwd = process.cwd(), git = defaultGit, force = false } = {}) {
  const current = gitConfigAll("core.hooksPath", cwd, git).at(-1) ?? "";
  if (current === HOOKS_PATH) return { changed: false, hooksPath: current };
  if (current && !force) throw new Error(`core.hooksPath is already ${current}; pass --force to replace it with ${HOOKS_PATH}`);
  const active = current ? [] : activeDefaultHooks({ cwd, git });
  if (active.length && !force) {
    throw new Error(`active hooks in .git/hooks would stop running once core.hooksPath=${HOOKS_PATH}: ${active.join(", ")}. Move them into ${HOOKS_PATH}/ or pass --force`);
  }
  git(["config", "core.hooksPath", HOOKS_PATH], cwd);
  return { changed: true, hooksPath: HOOKS_PATH, previous: current };
}

/** The hooks core.hooksPath=.githooks activates in this checkout (idea-883: pre-commit, pre-merge-commit, pre-push). */
export function hookNames({ cwd = process.cwd(), git = defaultGit } = {}) {
  try {
    const top = git(["rev-parse", "--show-toplevel"], cwd).trim();
    return fs.readdirSync(path.join(top, HOOKS_PATH)).filter((n) => !n.startsWith(".") && !n.endsWith(".sample")).sort();
  } catch {
    return [];
  }
}

/** The OK-path listing: own/included merges plus the direct-commit note. */
export function summarize(results) {
  const lines = [];
  for (const { ref, result, direct, verdict } of results) {
    if (!result) continue;
    for (const m of result.own) lines.push(`  own       ${m.sha.slice(0, 8)} ${String(m.subject).slice(0, 80)}`);
    for (const m of result.included) lines.push(`  included  ${m.sha.slice(0, 8)} ${String(m.subject).slice(0, 80)}`);
    for (const m of verdict?.passed ?? []) lines.push(`  verdict   ${m.sha.slice(0, 8)} tip ${m.tip.slice(0, 8)}: ${m.line.slice(0, 60)}`);
    for (const m of verdict?.overridden ?? []) lines.push(`  OVERRIDE  ${m.sha.slice(0, 8)} tip ${m.tip.slice(0, 8)}: verdict gate overridden (vs.verdictOverride)`);
    if (direct.length) lines.push(`  note: ${ref} also carries ${direct.length} direct (non-merge) commit(s); check they are yours: git log --first-parent --no-merges <remote>..HEAD`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, remoteName = SHARED_REMOTE, url = ""] = argv;
  if (mode === "pre-push") {
    const updates = parsePrePushLines(await readStdin());
    const res = await checkPush({ updates, remote: remoteName, url });
    if (!res.ok) {
      process.stderr.write(res.message);
      return 1;
    }
    process.stderr.write(summarize(res.results));
    return 0;
  }
  if (mode === "pre-merge-commit") {
    const res = checkMergeCommit();
    if (!res.ok) {
      process.stderr.write(res.message);
      return 1;
    }
    return 0;
  }
  if (mode === "check") {
    const res = await checkHead({ remote: remoteName });
    process.stdout.write(res.ok ? `vs push-guard: OK to push HEAD to ${remoteName}/master\n${summarize(res.results)}` : res.message);
    return res.ok ? 0 : 1;
  }
  process.stderr.write("usage: node server/push-guard.mjs pre-push <remote> <url> | pre-merge-commit | check [remote]\n");
  return 2;
}

const isMain = typeof import.meta.url === "string" && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`vs push-guard: ${err?.stack ?? err}\nRefusing the push (fail closed).\n`);
      process.exit(1);
    },
  );
}
