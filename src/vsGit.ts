// Client for /__vibesquad/git/* (server/git-api.mjs): git + GitHub (`gh`) for the Changes panel, @git context and
// commit links, via the VS server and never the Paseo daemon. Writes are owner-only (the server and the remote proxy enforce it).
const G = "/__vibesquad/git";

export type VsDiffLine = { type: string; content: string };
export type VsDiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: VsDiffLine[] };
export type VsDiffFile = { path: string; oldPath?: string; isNew: boolean; isDeleted: boolean; additions: number; deletions: number; hunks: VsDiffHunk[]; status?: string };
export type VsDiff = { files: VsDiffFile[]; diffTooLarge?: boolean };
export type VsStatus = {
  isGit: boolean; currentBranch: string | null; isDirty: boolean | null;
  aheadBehind: { ahead: number; behind: number } | null; baseRef: string | null; error: { code: string; message: string } | null;
};
export type VsCommitMeta = { sha: string; shortSha: string; subject: string; authorName: string; authorDate: string };
export type VsStash = { index: number; message: string; branch: string | null; isPaseo: boolean };
export type VsBranches = { current: string | null; branches: { name: string; current: boolean }[] };

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `git request failed (${res.status})`);
  return json as T;
}

function get<T>(action: string, params: Record<string, string | number | undefined>): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  return fetch(`${G}/${action}?${q}`).then((r) => parse<T>(r), (e) => { throw new Error(`Can't reach the VibeSquad server: ${e instanceof Error ? e.message : String(e)}`); });
}

function post<T = { ok: true }>(action: string, cwd: string, body: Record<string, unknown> = {}): Promise<T> {
  return fetch(`${G}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, ...body }) }).then((r) => parse<T>(r), (e) => { throw new Error(`Can't reach the VibeSquad server: ${e instanceof Error ? e.message : String(e)}`); });
}

export type DiffMode = "uncommitted" | "staged" | "base";
export const vsGitStatus = (cwd: string) => get<VsStatus>("status", { cwd });
export const vsGitDiff = (cwd: string, mode: DiffMode = "uncommitted") => get<VsDiff>("diff", { cwd, mode });
export const vsGitCommits = (cwd: string) => get<{ baseRef: string | null; commits: unknown[] }>("commits", { cwd });
/** One commit's diff by hash (7-64 hex); with `path`, `file` is that file's diff. N3 commit links use this. */
export const vsGitCommitDiff = (cwd: string, hash: string, path?: string) => get<{ commit: VsCommitMeta; files: VsDiffFile[]; file?: VsDiffFile | null; diffTooLarge?: boolean }>("commit-diff", { cwd, hash, path });
export const vsGitBranches = (cwd: string) => get<VsBranches>("branches", { cwd });
export const vsGitValidateBranch = (cwd: string, name: string) => get<{ exists: boolean; error: string | null }>("validate-branch", { cwd, name });
export const vsGitStashList = (cwd: string) => get<{ entries: VsStash[] }>("stash-list", { cwd }).then((r) => r.entries);
export const vsGitPrStatus = (cwd: string) => get<{ status: any; githubFeaturesEnabled: boolean; error: { message: string } | null; forge: string }>("pr-status", { cwd });
export const vsGitPrTimeline = (cwd: string, number: number) => get<{ items: any[]; truncated: boolean }>("pr-timeline", { cwd, number });
export const vsGitCheckDetails = (cwd: string, owner: string, name: string, checkRunId: number) => get<{ details: any }>("check-details", { cwd, owner, name, checkRunId });

export const vsGitCommit = (cwd: string, message: string, addAll = true) => post("commit", cwd, { message, addAll });
export const vsGitPush = (cwd: string) => post("push", cwd);
export const vsGitPull = (cwd: string) => post("pull", cwd);
export const vsGitMergeBase = (cwd: string) => post("merge-base", cwd);
export const vsGitSwitch = (cwd: string, branch: string) => post("switch", cwd, { branch });
export const vsGitStashSave = (cwd: string) => post("stash-save", cwd);
export const vsGitStashPop = (cwd: string, index = 0) => post("stash-pop", cwd, { index });
export const vsGitDiscard = (cwd: string, paths: string[]) => post("discard", cwd, { paths });
export const vsGitRenameBranch = (cwd: string, branch: string) => post<{ ok: true; currentBranch: string }>("rename-branch", cwd, { branch });
export const vsGitPrCreate = (cwd: string, title: string, body?: string, baseRef?: string) => post<{ ok: true; url: string }>("pr-create", cwd, { title, ...(body ? { body } : {}), ...(baseRef ? { baseRef } : {}) });
export const vsGitPrMerge = (cwd: string, method: "merge" | "squash" | "rebase" = "merge") => post("pr-merge", cwd, { method });
export const vsGitPrAutoMerge = (cwd: string, enabled: boolean, method: "merge" | "squash" | "rebase" = "merge") => post("pr-automerge", cwd, { enabled, method });

const WATCH_RETRY_MS = 3000;

/**
 * Calls onChange whenever the repo at `cwd` changes (working tree, index, HEAD, refs): one long-poll on git/watch at a time,
 * aborted by the returned stop(). The first poll is a baseline; failures back off and retry. `onRecover` fires after an outage
 * ends, so the caller can re-fetch what it missed.
 */
export function vsGitWatch(cwd: string, onChange: () => void, onRecover?: () => void): () => void {
  const ac = new AbortController();
  const url = (since?: string) => `${G}/watch?cwd=${encodeURIComponent(cwd)}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  void (async () => {
    let since: string | undefined;
    let down = false;
    while (!ac.signal.aborted) {
      try {
        const r = await fetch(url(since), { signal: ac.signal });
        // 400/403 (cwd not allowed, no owner token) will not fix itself: stop; the panel's Retry restarts the watch.
        if (r.status === 400 || r.status === 403) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { seq?: string; changed?: boolean };
        if (ac.signal.aborted) return;
        const first = since === undefined;
        since = j.seq;
        if (down) { down = false; onRecover?.(); }
        else if (j.changed && !first) onChange();
      } catch {
        if (ac.signal.aborted) return;
        down = true;
        await new Promise((res) => setTimeout(res, WATCH_RETRY_MS));
      }
    }
  })();
  return () => ac.abort();
}

/** Runs `fn` now, or once more after the current run if called meanwhile (a burst of calls costs at most one extra run). */
export function coalesceRuns(fn: () => Promise<unknown>): () => void {
  let running = false;
  let again = false;
  const run = (): void => {
    if (running) { again = true; return; }
    running = true;
    void fn().catch(() => {}).finally(() => { running = false; if (again) { again = false; run(); } });
  };
  return run;
}
