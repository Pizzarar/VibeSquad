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
// refs/tags/beta) pass untouched.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GUARDED_REFS = Object.freeze(["refs/heads/master", "refs/heads/main"]);
export const HOOKS_PATH = ".githooks";
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

/** First-parent merges in the push range, newest first. remoteSha all-zero (new remote branch): everything not on the remote. */
export function listPushMerges({ localSha, remoteSha, remote = "origin", cwd = process.cwd(), git = defaultGit }) {
  const range = remoteSha && !ZERO.test(remoteSha) ? [`${remoteSha}..${localSha}`] : [localSha, "--not", `--remotes=${remote}`];
  const fmt = `--format=%H${SEP}%P${SEP}%s`;
  const out = git(["log", "--first-parent", fmt, ...range, "--"], cwd);
  const merges = [];
  const direct = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [sha, parents, subject = ""] = line.split(SEP);
    (parents.trim().split(/\s+/).length > 1 ? merges : direct).push({ sha, subject });
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

async function defaultTeams() {
  const { loadTeamsRegistry, findLaneInRegistry } = await import("./identity.mjs");
  return { teams: loadTeamsRegistry(), findLane: findLaneInRegistry };
}

/**
 * Check every guarded ref update of one push. Returns { ok, message, results: [{ ref, result, direct }] }.
 * A range git cannot walk (remote tip not fetched) fails closed.
 */
export async function checkPush({ updates, remote = "origin", cwd = process.cwd(), env = process.env, git = defaultGit, registry } = {}) {
  const guarded = updates.filter((u) => GUARDED_REFS.includes(u.remoteRef) && !ZERO.test(u.localSha));
  if (!guarded.length) return { ok: true, message: "", results: [] };
  const { teams, findLane } = registry ?? (await defaultTeams());
  const who = pusherFromEnv({ env, cwd, git });
  const results = [];
  let message = "";
  for (const u of guarded) {
    let listed;
    try {
      listed = listPushMerges({ localSha: u.localSha, remoteSha: u.remoteSha, remote, cwd, git });
    } catch (err) {
      message += `vs push-guard: cannot read ${remote} ${u.remoteRef}..${u.localSha.slice(0, 8)} (${String(err?.message ?? err).split("\n")[0]}). Run \`git fetch ${remote}\`, read \`git log ${remote}/${u.remoteRef.replace("refs/heads/", "")}..HEAD\`, then push again.\n`;
      results.push({ ref: u.remoteRef, result: null, direct: [] });
      continue;
    }
    const result = evaluatePush({ merges: listed.merges, pusherLane: who.lane, pusherTeam: who.team, includes: who.includes, teams, findLane });
    results.push({ ref: u.remoteRef, result, direct: listed.direct });
    message += formatRefusal(result, { ref: u.remoteRef });
  }
  const ok = results.every((r) => r.result?.ok);
  return { ok, message, results };
}

/** `vs push-guard check`: what the hook would decide for pushing HEAD to <remote>/<branch> now. */
export async function checkHead({ remote = "origin", branch = "master", cwd = process.cwd(), env = process.env, git = defaultGit, registry } = {}) {
  const localSha = git(["rev-parse", "HEAD"], cwd).trim();
  let remoteSha = "0".repeat(40);
  try {
    remoteSha = git(["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`], cwd).trim();
  } catch { /* no tracking ref: every unpushed commit */ }
  return checkPush({ updates: [{ localRef: "HEAD", localSha, remoteRef: `refs/heads/${branch}`, remoteSha }], remote, cwd, env, git, registry });
}

/** Point the repo's hooks at the tracked .githooks dir (relative: each worktree runs its own checkout's hook). */
export function installHooks({ cwd = process.cwd(), git = defaultGit, force = false } = {}) {
  const current = gitConfigAll("core.hooksPath", cwd, git).at(-1) ?? "";
  if (current === HOOKS_PATH) return { changed: false, hooksPath: current };
  if (current && !force) throw new Error(`core.hooksPath is already ${current}; pass --force to replace it with ${HOOKS_PATH}`);
  git(["config", "core.hooksPath", HOOKS_PATH], cwd);
  return { changed: true, hooksPath: HOOKS_PATH, previous: current };
}

function summarize(results) {
  const lines = [];
  for (const { ref, result, direct } of results) {
    if (!result) continue;
    for (const m of result.own) lines.push(`  own       ${m.sha.slice(0, 8)} ${String(m.subject).slice(0, 80)}`);
    for (const m of result.included) lines.push(`  included  ${m.sha.slice(0, 8)} ${String(m.subject).slice(0, 80)}`);
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
  const [mode, remoteName = "origin"] = argv;
  if (mode === "pre-push") {
    const updates = parsePrePushLines(await readStdin());
    const res = await checkPush({ updates, remote: remoteName });
    if (!res.ok) {
      process.stderr.write(res.message);
      return 1;
    }
    process.stderr.write(summarize(res.results));
    return 0;
  }
  if (mode === "check") {
    const res = await checkHead({ remote: remoteName });
    process.stdout.write(res.ok ? `vs push-guard: OK to push HEAD to ${remoteName}/master\n${summarize(res.results)}` : res.message);
    return res.ok ? 0 : 1;
  }
  process.stderr.write("usage: node server/push-guard.mjs pre-push <remote> <url> | check [remote]\n");
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
