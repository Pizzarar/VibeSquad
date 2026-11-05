// Git history / rename / PR-detail wrappers for the Changes panel. Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";

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
  const r: any = await daemonClient.listCheckoutCommits(cwd);
  return { baseRef: r.baseRef ?? null, commits: r.commits ?? [] };
}

export async function commitFileDiff(cwd: string, sha: string, path: string) {
  const r: any = await daemonClient.getCommitFileDiff(cwd, sha, path);
  return r.file ?? null;
}

export async function validateBranchName(cwd: string, branchName: string): Promise<{ exists: boolean; error: string | null }> {
  const r: any = await daemonClient.validateBranch({ cwd, branchName });
  return { exists: !!r.exists, error: r.error ?? null };
}

export async function renameCurrentBranch(cwd: string, branch: string): Promise<string | null> {
  const r: any = await daemonClient.renameBranch({ cwd, branch });
  if (!r.success) throw new Error(r.error?.message ?? "Rename failed");
  return r.currentBranch ?? branch;
}

export async function checkDetails(cwd: string, c: { checkRunId?: number; workflowRunId?: number; repoOwner?: string; repoName?: string; changeRequestNumber?: number }): Promise<CheckDetails | null> {
  const r: any = await daemonClient.checkoutForgeGetCheckDetails({ cwd, ...c });
  if (!r.success) throw new Error(r.error?.message ?? "Could not load check details");
  return r.details ?? null;
}

export async function prTimeline(cwd: string, prNumber: number, repoOwner: string, repoName: string): Promise<{ items: TimelineItem[]; truncated: boolean }> {
  const r: any = await daemonClient.pullRequestTimeline({ cwd, prNumber, repoOwner, repoName });
  if (r.error) throw new Error(r.error.message ?? "Could not load timeline");
  return { items: r.items ?? [], truncated: !!r.truncated };
}

export async function setAutoMerge(cwd: string, enabled: boolean, method: "merge" | "squash" | "rebase" = "merge"): Promise<void> {
  const r: any = await daemonClient.checkoutForgeSetAutoMerge(cwd, enabled ? { enabled: true, method: method as any } : { enabled: false });
  if (r.success === false) throw new Error(r.error?.message ?? "Auto-merge failed");
}
