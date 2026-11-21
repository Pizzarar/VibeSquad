// W1 auto-sweep (docs/PLAN_DISK_LIFECYCLE_1121.md, idea-464 part 2): when a lead merges a unit into a sanctuary repo's
// default branch, remove that unit's worktree, but only when it is merged, clean (untracked build output aside) and no live
// agent's cwd points at it. The branch ref is always kept. Leads merge in their own shells (no git hook is installed, and
// core.hooksPath is per clone), so the site is a server tick: it watches each repo's default-branch refs and, when a tip
// moves, reads the first-parent merge commits in prev..tip. A worktree is a candidate when its HEAD is a merged parent or
// its branch is named in the merge subject ("Merge branch 'x'", "Merge pull request #n from owner/x"); the full sweep
// checks (sweepMergedWorktrees) still decide. The first tick only records tips: merges made while the server was down are
// left to `vs worktree sweep`. Squash merges have no parent link, so they are also left to the manual sweep.
// Dry run by default (logs would-remove): removal needs `apply: true` (server: VS_WORKTREE_AUTOSWEEP=apply).
import { execFile } from "node:child_process";
import { appendVsLogEntry } from "./brainstorm.mjs";
import {
  defaultGit,
  detectDefaultBranch,
  discoverSanctuaryRepos,
  liveAgentCwds,
  resolveManagedWorktreeRoot,
  sweepMergedWorktrees,
} from "./team-worktrees.mjs";

export const AUTOSWEEP_TICK_MS = 2 * 60_000;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_MERGES_PER_TICK = 200;

/** Async git: resolves stdout, or null on any failure. */
function defaultGitAsync(args, cwd) {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => done(err ? null : String(stdout)));
  });
}

const tryGit = (git, args, cwd) => {
  try {
    return String(git(args, cwd) ?? "");
  } catch {
    return null;
  }
};

/** Branch names a merge subject names: "Merge branch 'x' [into y]", "Merge remote-tracking branch 'origin/x'", "Merge pull request #n from owner/x". */
export function mergeSubjectBranches(subject) {
  const s = String(subject ?? "");
  const out = [];
  const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(s);
  if (m) out.push(m[1].replace(/^origin\//, ""));
  const pr = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(s);
  if (pr) out.push(pr[1]);
  return out;
}

/** First-parent merge commits in prev..tip: [{ sha, parents (merged side only), branches }]. */
export function mergesBetween(repoRoot, prev, tip, { git = defaultGit } = {}) {
  const out = tryGit(git, ["log", "--first-parent", "--merges", `--max-count=${MAX_MERGES_PER_TICK}`, "--format=%H%x09%P%x09%s", `${prev}..${tip}`], repoRoot);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, parents = "", subject = ""] = line.split("\t");
      return { sha, parents: parents.split(" ").filter(Boolean).slice(1), branches: mergeSubjectBranches(subject) };
    });
}

/**
 * The tick body. `listAgents()` -> the runner roster (cwd, archivedAt, status, resumable). An unreadable roster skips the
 * tick (fail closed: no live-cwd guard, no removal). Returns { skipped } or { removed, kept, results }.
 */
export function createWorktreeAutoSweep({
  root = resolveManagedWorktreeRoot(),
  listAgents,
  git = defaultGit,
  log = (text) => appendVsLogEntry({ teamId: "vibesquad", laneId: "vibesquad", agent: "vibesquad-server", type: "metric", text }),
  discover = discoverSanctuaryRepos,
  gitAsync = defaultGitAsync,
  now = () => Date.now(),
  apply = false,
} = {}) {
  const tips = new Map(); // `${repoRoot}|${ref}` -> last seen sha
  let repoCache = { at: -Infinity, repos: [] }; // discovery + default branch, refreshed every CACHE_TTL_MS

  async function tick() {
    // A quiet tick is one async for-each-ref per repo: the server's event loop is never blocked unless a tip moved.
    if (now() - repoCache.at > CACHE_TTL_MS) {
      repoCache = { at: now(), repos: discover(root).repos.map((repo) => ({ repo, def: detectDefaultBranch(repo.repoRoot, { git }) })) };
    }
    const moved = [];
    for (const { repo, def } of repoCache.repos) {
      if (!def.refs.length) continue;
      const out = await gitAsync(["for-each-ref", "--format=%(refname)%09%(objectname)", ...def.refs], repo.repoRoot);
      if (out === null) continue;
      for (const line of out.split(/\r?\n/).filter(Boolean)) {
        const [ref, tip] = line.trim().split("\t");
        if (!ref || !tip) continue;
        const key = `${repo.repoRoot.toLowerCase()}|${ref}`;
        const prev = tips.get(key);
        tips.set(key, tip);
        if (prev && prev !== tip) moved.push({ repo, def, ref, prev, tip });
      }
    }
    if (!moved.length) return { removed: 0, kept: 0, results: [] };

    let agents;
    try {
      agents = await listAgents();
    } catch {
      agents = null;
    }
    // An empty roster reads as unreadable too: the roster fold returns [] when it cannot read the runner logs.
    if (!Array.isArray(agents) || !agents.length) {
      log("worktree-autosweep skipped: agent roster unreadable, no live-cwd guard");
      return { skipped: "agents-unreadable" };
    }
    const liveCwds = liveAgentCwds(agents);
    const results = [];
    for (const { repo, def, ref, prev, tip } of moved) {
      const merges = mergesBetween(repo.repoRoot, prev, tip, { git });
      const heads = new Map();
      const names = new Map();
      for (const m of merges) {
        for (const p of m.parents) heads.set(p, m.sha);
        for (const b of m.branches) names.set(b, m.sha);
      }
      if (!heads.size && !names.size) continue;
      const res = sweepMergedWorktrees(repo.repoRoot, {
        apply,
        liveCwds,
        git,
        sanctuaryRoot: root,
        targetBranch: def.name,
        targetRefs: def.refs,
        now: now(),
        only: (wt) => heads.has(wt.head) || (wt.branch && names.has(wt.branch)),
      });
      for (const r of res.results) {
        const via = (heads.get(r.head) ?? names.get(r.branch) ?? "").slice(0, 8);
        const unit = r.branch ?? r.head?.slice(0, 8) ?? "?";
        const text =
          r.action === "removed" || r.action === "would-remove"
            ? `worktree-autosweep ${r.action} repo=${repo.name} unit=${unit} merge=${via} ref=${ref} merged-by=${r.mergedBy} branch-kept`
            : `worktree-autosweep kept repo=${repo.name} unit=${unit} merge=${via} ref=${ref} reason=${r.reason}`;
        try {
          log(text);
        } catch {}
        results.push({ repo: repo.name, ...r });
      }
    }
    const removed = results.filter((r) => r.action === "removed").length;
    const wouldRemove = results.filter((r) => r.action === "would-remove").length;
    return { apply, removed, wouldRemove, kept: results.length - removed - wouldRemove, results };
  }

  return { tick };
}

/** Server wiring: one tick every AUTOSWEEP_TICK_MS against the runner roster. Returns { stop, tick }. */
export function startWorktreeAutoSweep({ runner, tickMs = AUTOSWEEP_TICK_MS, ...rest } = {}) {
  const sweep = createWorktreeAutoSweep({ listAgents: () => runner.listAgents(), ...rest });
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    sweep
      .tick()
      .catch((e) => console.warn(`[vibesquad] worktree-autosweep: ${e?.message ?? e}`))
      .finally(() => {
        running = false;
      });
  };
  run(); // baseline the tips at start
  const t = setInterval(run, tickMs);
  t.unref?.();
  return { stop: () => clearInterval(t), tick: sweep.tick };
}
