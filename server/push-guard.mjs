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
// merge's final commit), needs a recorded PASS on the merged tip: the latest server-attested reviewer `done` entry in this
// repo's own Squad log(s) (teams.json paths, repoSquads) whose hash resolves here to that tip (server/verdict.mjs
// latestRecordedVerdict), or, when no attested digest names it (server not yet restarted onto the writer; a re-tasked reviewer's
// undigested later turn), the reviewer's own last message read offline from the runner store (readRunnerVerdicts); the newest
// decides. FAIL, none, or no owning Squad refuses. Override (owner/lead only; each use is logged as a `decision`
// entry and printed): `git -c vs.verdictOverride=<sha> merge|push ...` or VS_VERDICT_OVERRIDE=<sha>[,<sha>].
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { entryVerdict, evaluateMergeVerdicts, formatVerdictOverrides, formatVerdictRefusal, isUnitMergeSubject, latestRecordedVerdict, newestVerdict, runnerRecordVerdict } from "./verdict.mjs";

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

/** A Squad id as its log directory name (the same mapping as appendVsLogEntry's safeSegment in server/brainstorm.mjs). */
const squadDir = (id) => String(id ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "vibesquad";

/** idea-883: the repo's main checkout dir (a linked worktree resolves to its main repo through the common git dir). */
export function repoRoot({ cwd = process.cwd(), git = defaultGit } = {}) {
  const common = path.resolve(cwd, git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim());
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/**
 * idea-883: the Squads that own this repo: every teams.json Squad whose `paths` (or one of its lanes' `paths`) match the main
 * checkout's path by whole segments (identity.mjs pathHasSegments, as matchPathInRegistry). matchPathInRegistry itself returns
 * null for a Squad-level path on a multi-lane Squad (it must name a lane), which is every real Squad; the gate needs only the
 * Squad. [] = no owner, and the gate fails closed.
 */
export async function repoSquads({ cwd = process.cwd(), git = defaultGit, teams } = {}) {
  let root = "";
  try {
    root = repoRoot({ cwd, git });
  } catch {
    return [];
  }
  const { pathHasSegments } = await import("./identity.mjs");
  const norm = root.replace(/\\/g, "/").toLowerCase();
  const pats = (list) => (Array.isArray(list) ? list : []).map((p) => String(p ?? "").replace(/\\/g, "/").toLowerCase()).filter(Boolean);
  return (teams ?? [])
    .filter((t) => t?.id && [...pats(t.paths), ...(t.lanes ?? []).flatMap((l) => pats(l?.paths))].some((p) => pathHasSegments(norm, p)))
    .map((t) => String(t.id));
}

/** idea-883: `git rev-parse <hash>^{commit}` in the repo: the one commit a short hash names here, "" when none or ambiguous. */
export function resolveInRepo({ cwd = process.cwd(), git = defaultGit } = {}) {
  return (hash) => {
    try {
      return git(["rev-parse", "--verify", "--quiet", `${hash}^{commit}`], cwd).trim();
    } catch {
      return "";
    }
  };
}

/**
 * idea-883: the team-log entries of `squads` (the repo's own Squads, repoSquads) under the VS home that mention one of `tips`'
 * 7-char prefixes, per tip (Map tip -> entries, ordered by ts). Other Squads' logs are never read; a missing/unreadable log
 * gives nothing.
 */
export function squadLogEntries({ tips = [], home = verdictHome(), squads = [] } = {}) {
  const want = normTips(tips);
  const byTip = new Map(want.map((t) => [t, []]));
  const keys = [...new Set(want.map((t) => t.slice(0, 7)))];
  if (keys.length) {
    for (const dir of [...new Set((squads ?? []).map(squadDir))]) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(home, "teams", dir, "log.jsonl"), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const low = line.toLowerCase();
        if (!keys.some((k) => low.includes(k))) continue;
        let e;
        try {
          e = JSON.parse(line.replace(/^﻿/, ""));
        } catch {
          continue;
        }
        for (const t of want) if (low.includes(t.slice(0, 7))) byTip.get(t).push(e);
      }
    }
  }
  // Each Squad's log is in append order; across a repo's Squads, order by ts so "latest" is the newest of them.
  for (const list of byTip.values()) list.sort((a, b) => (Date.parse(a?.ts ?? "") || 0) - (Date.parse(b?.ts ?? "") || 0));
  return byTip;
}

const normTips = (tips) => [...new Set((tips ?? []).map((t) => String(t ?? "").toLowerCase()).filter((t) => /^[0-9a-f]{7,64}$/.test(t)))];

/**
 * idea-883: `recorded(tip)` over the team logs of `squads` (squadLogEntries). Only server-attested reviewer entries count
 * (verdict.mjs entryVerdict), and `resolve` (resolveInRepo) must map the entry's hash to exactly the tip. `runner` (Map tip ->
 * runnerRecordVerdict, from readRunnerVerdicts) adds the reviewers' own runner records; the newest of the two decides. No Squad,
 * or a missing/unreadable log, records nothing (fail closed).
 */
export function readRecordedVerdicts({ tips = [], home = verdictHome(), squads = [], resolve, runner = null, byTip = null } = {}) {
  const logs = byTip ?? squadLogEntries({ tips, home, squads });
  return (tip) => {
    const t = String(tip ?? "").toLowerCase();
    return newestVerdict(latestRecordedVerdict(logs.get(t) ?? [], tip, { resolve }), runner?.get(t) ?? null);
  };
}

/** idea-883: the runner store dirs under <home>/runner the gate reads offline (live logs first; agents-archive: imported logs). */
export const RUNNER_LOG_DIRS = Object.freeze(["agents", "agents-archive"]);
/** A runner log older than its tip's commit time (minus this clock slack) cannot hold a review of that tip. */
export const TIP_TIME_SLACK_MS = 5 * 60 * 1000;
const HEAD_BYTES = 16 * 1024;
const RUNNER_FILE_RE = /^rn-[A-Za-z0-9_-]{1,61}\.jsonl$/;

/** idea-883: `git show -s --format=%ct <sha>` in the repo as epoch ms (the tip's committer time), null when unreadable. */
export function commitTimeInRepo({ cwd = process.cwd(), git = defaultGit } = {}) {
  return (sha) => {
    try {
      const s = Number(git(["show", "-s", "--format=%ct", `${sha}^{commit}`], cwd).trim());
      return Number.isFinite(s) && s > 0 ? s * 1000 : null;
    } catch {
      return null;
    }
  };
}

/** The `created` meta of a runner log (its head, before the long systemPrompt) names a review profile/title/job: a cheap
 * prefilter only; isReviewerAgent on the folded record decides. */
function headLooksLikeReview(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = buf.toString("utf8", 0, n);
    const cut = head.indexOf('"systemPrompt"');
    return /review/i.test(cut >= 0 ? head.slice(0, cut) : head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * idea-883 fallback: the verdicts reviewers' own runner records give `tips`, read offline from the on-disk runner store
 * (<home>/runner/agents, agents-archive; the server need not run). Covers a digest `done` written without the attested field
 * (server not yet restarted onto the writer) and a re-tasked reviewer's later turn that was never digested. Candidates: `ids`
 * (the digested reviewers of unattested `done` entries naming a tip, always read), plus every runner log modified since the
 * oldest tip's commit time whose created meta mentions a review. A candidate counts only when its folded record is a reviewer
 * (isReviewerAgent) of one of `squads`, and its last assistant message (the text `vs verdict` reads) has a verdict line whose
 * hash `resolve` maps to exactly the tip (verdict.mjs runnerRecordVerdict). Returns Map tip -> the newest such verdict.
 */
export async function readRunnerVerdicts({ tips = [], home = verdictHome(), squads = [], resolve, tipTime, ids = [], env = process.env } = {}) {
  const want = normTips(tips);
  const out = new Map();
  const teams = new Set((squads ?? []).map(squadDir));
  if (!want.length || !teams.size) return out;
  const times = new Map(want.map((t) => [t, typeof tipTime === "function" ? tipTime(t) : null]));
  const known = [...times.values()].filter((v) => Number.isFinite(v));
  const since = known.length ? Math.min(...known) - TIP_TIME_SLACK_MS : null; // no tip time: only the named `ids` are read
  const forced = new Set((ids ?? []).map((id) => String(id ?? "").trim()).filter((id) => RUNNER_FILE_RE.test(`${id}.jsonl`)));
  if (since === null && !forced.size) return out;
  let rb;
  let tools;
  try {
    rb = await import("./backend/runner-backend.mjs");
    tools = await import("./mcp/tools.mjs");
  } catch (err) {
    process.stderr.write(`vs verdict gate: runner store reader unavailable (${String(err?.message ?? err).split("\n")[0]}); attested digests only\n`);
    return out;
  }
  const runnerDir = path.join(home, "runner");
  const seen = new Set();
  for (const sub of RUNNER_LOG_DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(runnerDir, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!RUNNER_FILE_RE.test(name)) continue;
      const id = name.slice(0, -".jsonl".length);
      if (seen.has(id)) continue; // a live log wins over its archived copy
      seen.add(id);
      const file = path.join(runnerDir, sub, name);
      if (!forced.has(id)) {
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (since === null || mtime < since || !headLooksLikeReview(file)) continue;
      }
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      // No raw-text prefilter on the tip: a streamed reply can split the hash across two `output` events.
      const fold = rb.newFoldState();
      const events = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        events.push(e);
        rb.feedFoldLine(fold, line);
      }
      const agent = rb.finishFold(id, fold, runnerDir, env, null);
      if (!agent || !teams.has(squadDir(agent.labels?.team))) continue;
      const lastMessage = tools.lastAssistantText(rb.toTimeline(events), Infinity);
      const low = lastMessage.toLowerCase();
      const hit = want.filter((t) => low.includes(t.slice(0, 7)));
      if (!hit.length) continue;
      let ts = null;
      for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === "output") { ts = events[i].ts ?? null; break; }
      for (const t of hit) {
        const v = runnerRecordVerdict({ agent, lastMessage, tip: t, resolve, ts });
        if (v) out.set(t, newestVerdict(out.get(t) ?? null, v));
      }
    }
  }
  return out;
}

/**
 * idea-883: `recorded(tip)` for the hooks: the attested Squad-log digests plus the reviewers' own runner records
 * (readRunnerVerdicts; the reviewers of unattested `done` digests naming a tip are always read). Never an entry's own text.
 */
export async function recordedVerdicts({ tips = [], home = verdictHome(), squads = [], resolve, tipTime, env = process.env } = {}) {
  const byTip = squadLogEntries({ tips, home, squads });
  const ids = new Set();
  for (const list of byTip.values()) {
    for (const e of list) if (e?.type === "done" && !entryVerdict(e) && Array.isArray(e.refs) && e.refs[0]) ids.add(String(e.refs[0]));
  }
  const runner = await readRunnerVerdicts({ tips, home, squads, resolve, tipTime, ids: [...ids], env });
  return readRecordedVerdicts({ tips, home, squads, resolve, runner, byTip });
}

/**
 * idea-883: the durable audit of a verdict-gate override: one `decision` entry per overridden unit merge in each of the repo's
 * Squad logs (team + lane log, appendVsLogEntry), naming the action, tip, merge and who ran it. Returns the Squads logged to.
 * Only the hooks call this (not `vs push-guard check`, a dry run). A failed write is reported, never thrown.
 */
export async function logVerdictOverrides({ verdict, action, squads = [], env = process.env, cwd = process.cwd(), git = defaultGit } = {}) {
  const ov = verdict?.overridden ?? [];
  if (!ov.length || !squads.length) return [];
  let who = String(env.VS_AGENT_ID ?? "").trim();
  if (!who) who = gitConfigAll("user.name", cwd, git).at(-1) || "owner shell";
  const lane = String(env.VS_LANE ?? "").trim();
  const { appendVsLogEntry } = await import("./brainstorm.mjs");
  const logged = [];
  for (const squad of squads) {
    try {
      for (const m of ov) {
        const text = `verdict override (${action}) by ${who}: tip ${m.tip.slice(0, 8)}${m.sha ? ` merge ${m.sha.slice(0, 8)}` : ""} ${String(m.subject ?? "").slice(0, 120)} [idea-883 vs.verdictOverride]`;
        appendVsLogEntry({ teamId: squad, laneId: lane || squad, agent: who, type: "decision", text, refs: [m.tip, ...(m.sha ? [m.sha] : [])] });
      }
      logged.push(squad);
    } catch (err) {
      process.stderr.write(`vs verdict gate: could not log the override to Squad ${squad}: ${String(err?.message ?? err).split("\n")[0]}\n`);
    }
  }
  return logged;
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
  let squads = null; // idea-883: this repo's Squads, resolved once on the first unit merge
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
    // idea-883: a pushed unit merge needs a recorded PASS on its merged tip, from this repo's own Squad log(s) only.
    // vs.pushInclude (whose lane) never waives it.
    const unit = listed.merges.filter((m) => isUnitMergeSubject(m.subject));
    if (unit.length && !squads) squads = await repoSquads({ cwd, git, teams });
    const recorded = unit.length
      ? await recordedVerdicts({ tips: unit.map((m) => m.tip), home: verdictHome({ home, env }), squads, resolve: resolveInRepo({ cwd, git }), tipTime: commitTimeInRepo({ cwd, git }), env })
      : () => null;
    const verdict = evaluateMergeVerdicts({ merges: unit, recorded, overrides: verdictOverrides({ env, cwd, git }) });
    results.push({ ref: u.remoteRef, result, direct: listed.direct, verdict });
    message += formatRefusal(result, { ref: u.remoteRef });
    message += formatVerdictRefusal(verdict, { action: "push", squads: squads ?? [] });
  }
  const ok = results.every((r) => r.result?.ok && (r.verdict?.ok ?? true));
  return { ok, message, results, squads: squads ?? [] };
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
export async function checkMergeCommit({ cwd = process.cwd(), env = process.env, git = defaultGit, home, registry } = {}) {
  const pass = { ok: true, message: "", verdict: null, squads: [] };
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
  const { teams } = registry ?? (await defaultTeams());
  const squads = await repoSquads({ cwd, git, teams });
  const recorded = await recordedVerdicts({ tips: unit.map((m) => m.tip), home: verdictHome({ home, env }), squads, resolve: resolveInRepo({ cwd, git }), tipTime: commitTimeInRepo({ cwd, git }), env });
  const verdict = evaluateMergeVerdicts({ merges: unit, recorded, overrides: verdictOverrides({ env, cwd, git }) });
  return { ok: verdict.ok, message: formatVerdictRefusal(verdict, { action: "merge", squads }), verdict, squads };
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
    for (const m of verdict?.passed ?? []) lines.push(`  verdict   ${m.sha.slice(0, 8)} tip ${m.tip.slice(0, 8)}: ${m.line.slice(0, 60)}${m.source === "runner" ? ` (reviewer ${m.reviewer}'s runner record)` : ""}`);
    for (const m of verdict?.overridden ?? []) lines.push(`  OVERRIDE  ${m.sha.slice(0, 8)} tip ${m.tip.slice(0, 8)}: verdict gate overridden (vs.verdictOverride; the hook logs it)`);
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
    // idea-883: an override is allowed only with a durable audit entry plus a stderr notice.
    for (const r of res.results) {
      if (!r.verdict?.overridden?.length) continue;
      const logged = await logVerdictOverrides({ verdict: r.verdict, action: "push", squads: res.squads });
      process.stderr.write(formatVerdictOverrides(r.verdict, { action: "push", logged }));
    }
    return 0;
  }
  if (mode === "pre-merge-commit") {
    const res = await checkMergeCommit();
    if (!res.ok) {
      process.stderr.write(res.message);
      return 1;
    }
    if (res.verdict?.overridden?.length) {
      const logged = await logVerdictOverrides({ verdict: res.verdict, action: "merge", squads: res.squads });
      process.stderr.write(formatVerdictOverrides(res.verdict, { action: "merge", logged }));
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
