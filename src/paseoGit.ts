// Git history / rename / PR-detail wrappers for the Changes panel, on the VS git routes (src/vsGit.ts), not the Paseo daemon.
import { vsGitCommits, vsGitCommitDiff, vsGitValidateBranch, vsGitRenameBranch, vsGitCheckDetails, vsGitPrTimeline, vsGitPrAutoMerge } from "./vsGit";

export type CommitFile = { path: string; additions: number; deletions: number; status?: string };
export type CommitInfo = {
  sha: string; shortSha: string; subject: string; authorName: string; authorDate: string;
  isOnRemote: boolean; isOnBase?: boolean; files: CommitFile[];
};
export type TimelineItem = { id: string; kind: string; author: string; body: string; createdAt: number; url: string; reviewState?: string };
export type CheckDetails = {
  name: string; status?: string | null; conclusion?: string | null; url?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
  failedJobs?: { name?: string }[];
};

export async function listCommits(cwd: string): Promise<{ baseRef: string | null; commits: CommitInfo[] }> {
  const r = await vsGitCommits(cwd);
  return { baseRef: r.baseRef ?? null, commits: (r.commits ?? []) as CommitInfo[] };
}

export async function commitFileDiff(cwd: string, sha: string, path: string) {
  const r = await vsGitCommitDiff(cwd, sha, path);
  return r.file ?? null;
}

export async function validateBranchName(cwd: string, branchName: string): Promise<{ exists: boolean; error: string | null }> {
  const r = await vsGitValidateBranch(cwd, branchName);
  return { exists: !!r.exists, error: r.error ?? null };
}

export async function renameCurrentBranch(cwd: string, branch: string): Promise<string | null> {
  const r = await vsGitRenameBranch(cwd, branch);
  return r.currentBranch ?? branch;
}

export async function checkDetails(cwd: string, c: { checkRunId?: number; workflowRunId?: number; repoOwner?: string; repoName?: string; changeRequestNumber?: number }): Promise<CheckDetails | null> {
  if (!c.checkRunId || !c.repoOwner || !c.repoName) throw new Error("This check has no details to load");
  const r = await vsGitCheckDetails(cwd, c.repoOwner, c.repoName, c.checkRunId);
  return r.details ?? null;
}

export async function prTimeline(cwd: string, prNumber: number, _repoOwner?: string, _repoName?: string): Promise<{ items: TimelineItem[]; truncated: boolean }> {
  const r = await vsGitPrTimeline(cwd, prNumber);
  return { items: r.items ?? [], truncated: !!r.truncated };
}

export async function setAutoMerge(cwd: string, enabled: boolean, method: "merge" | "squash" | "rebase" = "merge"): Promise<void> {
  await vsGitPrAutoMerge(cwd, enabled, method);
}
