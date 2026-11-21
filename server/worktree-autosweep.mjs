// W1 auto-sweep (docs/PLAN_DISK_LIFECYCLE_1121.md, idea-464 part 2): when a lead merges a unit into a sanctuary repo's
// default branch, remove that unit's worktree, but only when it is merged, clean (untracked build output aside) and no live
// agent's cwd points at it. The branch ref is always kept. Leads merge in their own shells (no git hook is installed, and
// core.hooksPath is per clone), so the site is a server tick: it watches each repo's default-branch refs and, when a tip
// moves, reads the first-parent merge commits in prev..tip. A worktree is a candidate when its HEAD is a merged parent or
// its branch is named in the merge subject ("Merge branch 'x'", "Merge pull request #n from owner/x"); the full sweep
// checks (sweepMergedWorktrees) still decide. The first tick only records tips: merges made while the server was down are
// left to `vs worktree sweep`. Squash merges have no parent link, so they are also left to the manual sweep.
// Dry run by default (logs would-remove): removal needs `apply: true` (server: VS_WORKTREE_AUTOSWEEP=apply). An apply holds
// the sanctuary sweep lock (shared with `vs worktree sweep --apply`). In the server the synchronous git work (discovery and
// the sweep itself) runs in a worker thread, so the event loop is never blocked; a quiet tick is async for-each-ref only.
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  acquireSweepLock,
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
 * The synchronous (execFileSync) parts of a tick, callable in-process or from the worker thread. Arguments and results
 * are plain data (structured-clone safe); `git` and `discover` are only injectable in-process (tests).
 */
export const AUTOSWEEP_HEAVY = {
  /** Sanctuary repos and their default branch: [{ repo: { name, repoRoot }, def: { name, refs } }]. */
  repos({ root, git = defaultGit, discover = discoverSanctuaryRepos }) {
    return discover(root).repos.map((r) => ({ repo: { name: r.name, repoRoot: r.repoRoot }, def: detectDefaultBranch(r.repoRoot, { git }) }));
  },
  /**
   * groups: [{ repo, def, moves: [{ ref, prev, tip }] }], one per repo (several moved refs of a repo are swept once).
   * With apply, holds the sweep lock for the whole call; busy -> { busy }. Returns { results: [{ repo, via, refs, ...r }] }.
   */
  sweep({ root, groups, liveCwds, apply, now, git = defaultGit }) {
    const release = apply ? acquireSweepLock(root) : () => {};
    if (!release) return { busy: true, results: [] };
    try {
      const results = [];
      for (const { repo, def, moves } of groups) {
        const heads = new Map();
        const names = new Map();
        for (const { prev, tip } of moves) {
          for (const m of mergesBetween(repo.repoRoot, prev, tip, { git })) {
            for (const p of m.parents) heads.set(p, m.sha);
            for (const b of m.branches) names.set(b, m.sha);
          }
        }
        if (!heads.size && !names.size) continue;
        const res = sweepMergedWorktrees(repo.repoRoot, {
          apply,
          liveCwds,
          git,
          sanctuaryRoot: root,
          targetBranch: def.name,
          targetRefs: def.refs,
          now,
          only: (wt) => heads.has(wt.head) || Boolean(wt.branch && names.has(wt.branch)),
        });
        for (const r of res.results) {
          const via = (heads.get(r.head) ?? names.get(r.branch) ?? "").slice(0, 8);
          results.push({ repo: repo.name, via, refs: moves.map((m) => m.ref).join(","), ...r });
        }
      }
      return { results };
    } finally {
      release();
    }
  },
};

/** Run one AUTOSWEEP_HEAVY step in a worker thread (the server path). Rejects on a worker error. */
export function runHeavyInWorker(name, args) {
  return new Promise((done, fail) => {
    const w = new Worker(new URL("./worktree-autosweep-worker.mjs", import.meta.url), { workerData: { name, args } });
    let settled = false;
    w.once("message", (m) => {
      settled = true;
      if (m?.ok) done(m.value);
      else fail(new Error(m?.error ?? "worker failed"));
    });
    w.once("error", (e) => {
      if (!settled) fail(e);
      settled = true;
    });
    w.once("exit", (code) => {
      if (!settled) fail(new Error(`worker exited ${code}`));
    });
  });
}

const defaultLog = (text) =>
  import("./brainstorm.mjs").then((m) => m.appendVsLogEntry({ teamId: "vibesquad", laneId: "vibesquad", agent: "vibesquad-server", type: "metric", text }));

/**
 * The tick body. `listAgents()` -> the runner roster (cwd, archivedAt, status, resumable, lost). An unreadable or empty
 * roster skips the tick (fail closed: no live-cwd guard, no removal). `runHeavy(name, args)` runs an AUTOSWEEP_HEAVY step
 * (default: in-process with the injected git/discover; the server passes runHeavyInWorker).
 * Returns { skipped } or { apply, removed, wouldRemove, kept, results }.
 */
export function createWorktreeAutoSweep({
  root = resolveManagedWorktreeRoot(),
  listAgents,
  git = defaultGit,
  log = defaultLog,
  discover = discoverSanctuaryRepos,
  gitAsync = defaultGitAsync,
  now = () => Date.now(),
  apply = false,
  runHeavy = null,
} = {}) {
  const heavy = runHeavy ?? (async (name, args) => AUTOSWEEP_HEAVY[name]({ ...args, git, discover }));
  const tips = new Map(); // `${repoRoot}|${ref}` -> last seen sha
  let repoCache = { at: -Infinity, repos: [] }; // discovery + default branch, refreshed every CACHE_TTL_MS
  const say = (text) => {
    try {
      Promise.resolve(log(text)).catch(() => {});
    } catch {}
  };

  async function tick() {
    if (now() - repoCache.at > CACHE_TTL_MS) repoCache = { at: now(), repos: await heavy("repos", { root }) };
    const byRepo = new Map(); // repoRoot -> { repo, def, moves }
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
        if (!prev || prev === tip) continue;
        if (!byRepo.has(repo.repoRoot)) byRepo.set(repo.repoRoot, { repo, def, moves: [] });
        byRepo.get(repo.repoRoot).moves.push({ ref, prev, tip });
      }
    }
    if (!byRepo.size) return { apply, removed: 0, wouldRemove: 0, kept: 0, results: [] };

    let agents;
    try {
      agents = await listAgents();
    } catch {
      agents = null;
    }
    // An empty roster reads as unreadable too: the roster fold returns [] when it cannot read the runner logs.
    if (!Array.isArray(agents) || !agents.length) {
      say("worktree-autosweep skipped: agent roster unreadable, no live-cwd guard");
      return { skipped: "agents-unreadable" };
    }
    const res = await heavy("sweep", { root, groups: [...byRepo.values()], liveCwds: liveAgentCwds(agents), apply, now: now() });
    if (res.busy) {
      say("worktree-autosweep skipped: another sweep holds the sanctuary lock");
      return { skipped: "sweep-busy" };
    }
    for (const r of res.results) {
      const unit = r.branch ?? r.head?.slice(0, 8) ?? "?";
      say(
        r.action === "removed" || r.action === "would-remove"
          ? `worktree-autosweep ${r.action} repo=${r.repo} unit=${unit} merge=${r.via} ref=${r.refs} merged-by=${r.mergedBy} branch-kept`
          : `worktree-autosweep kept repo=${r.repo} unit=${unit} merge=${r.via} ref=${r.refs} reason=${r.reason}`,
      );
    }
    const removed = res.results.filter((r) => r.action === "removed").length;
    const wouldRemove = res.results.filter((r) => r.action === "would-remove").length;
    return { apply, removed, wouldRemove, kept: res.results.length - removed - wouldRemove, results: res.results };
  }

  return { tick };
}

/** Server wiring: one tick every AUTOSWEEP_TICK_MS against the runner roster, git work in a worker. Returns { stop, tick }. */
export function startWorktreeAutoSweep({ runner, tickMs = AUTOSWEEP_TICK_MS, ...rest } = {}) {
  const sweep = createWorktreeAutoSweep({ listAgents: () => runner.listAgents(), runHeavy: runHeavyInWorker, ...rest });
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
