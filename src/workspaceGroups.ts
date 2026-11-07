// Workspaces page model (docs/PLAN_WORKSPACES_CLEANUP.md): one row per real folder, a true "in use".
// Paseo makes a workspace record for nearly every agent started in a folder, so records are grouped by
// normalized directory and agents are matched by workspace id (cwd only when an agent has none).
import type { PaseoAgent, PaseoWorkspace } from "./agentTypes";

export type Verdict = "in-use" | "check" | "safe";

export const STALE_DAYS = 3;
const DAY = 86_400_000;

export const normDir = (p?: string) => (p ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();

export type Folder = {
  key: string;
  /** Newest-activity record: its name, branch and git state represent the folder. */
  w: PaseoWorkspace;
  records: PaseoWorkspace[];
  /** Records Clear may archive: not the primary, not in use, and never a worktree (that could delete files). */
  oldSessions: PaseoWorkspace[];
  verdict: Verdict;
  reasons: string[];
  live: number;
  archived: number;
  idleDays: number;
  owned: boolean;
  /** Archiving this folder's records removes a real folder (Paseo-owned worktree), not just Paseo's record. */
  deletesFolder: boolean;
};

const time = (iso?: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Live = running, or idle/other but not closed or archived, and active within STALE_DAYS. */
export function isLiveAgent(a: PaseoAgent, now = Date.now()): boolean {
  if (a.status === "closed" || a.archivedAt) return false;
  if (a.status === "running") return true;
  return now - time(a.updatedAt) < STALE_DAYS * DAY;
}

/** Agents whose workspaceId is missing (the cwd fallback is used for these). */
export const agentsWithoutWorkspaceId = (agents: PaseoAgent[]) => agents.filter((a) => !a.workspaceId).length;

export function buildFolders(workspaces: PaseoWorkspace[], agents: PaseoAgent[], archived: PaseoAgent[], now = Date.now()): Folder[] {
  const groups = new Map<string, PaseoWorkspace[]>();
  for (const w of workspaces) {
    const k = normDir(w.workspaceDirectory) || `id:${w.id}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(w);
  }

  return [...groups].map(([key, records]) => {
    records.sort((a, b) => time(b.activityAt) - time(a.activityAt));
    const ids = new Set(records.map((r) => r.id));
    const dir = normDir(records[0].workspaceDirectory);
    const mine = (a: PaseoAgent) => {
      if (a.workspaceId) return ids.has(a.workspaceId);
      const c = normDir(a.cwd);
      return !!dir && (c === dir || c.startsWith(dir + "/"));
    };
    const liveAgents = agents.filter((a) => mine(a) && isLiveAgent(a, now));
    const liveIds = new Set(liveAgents.map((a) => a.workspaceId).filter(Boolean) as string[]);
    const arch = archived.filter(mine).length;

    const w = records[0];
    const git = w.gitRuntime;
    const owned = records.some((r) => r.workspaceKind === "worktree" && !!r.gitRuntime?.isPaseoOwnedWorktree);
    const ahead = Math.max(git?.aheadBehind?.ahead ?? 0, git?.aheadOfOrigin ?? 0);
    const pr = w.githubRuntime?.pullRequest;
    const idleDays = w.activityAt ? (now - Date.parse(w.activityAt)) / DAY : Infinity;
    const live = liveAgents.length;
    const oldSessions = records.slice(1).filter((r) => r.workspaceKind !== "worktree" && !liveIds.has(r.id));
    const base = { key, w, records, oldSessions, live, archived: arch, idleDays, owned, deletesFolder: owned };

    if (live > 0) return { ...base, verdict: "in-use" as Verdict, reasons: [`${live} live agent${live > 1 ? "s" : ""}`] };
    const reasons: string[] = [];
    if (!owned) reasons.push("not a Paseo worktree");
    if (git?.isDirty) reasons.push("uncommitted changes");
    if (ahead > 0) reasons.push(`${ahead} unpushed commit${ahead > 1 ? "s" : ""}`);
    if (pr && !pr.isMerged && String(pr.state).toLowerCase() === "open") reasons.push(`open PR${pr.number ? ` #${pr.number}` : ""}`);
    if (!reasons.length && !(idleDays >= STALE_DAYS || (arch > 0 && liveAgents.length === 0))) reasons.push(`active < ${STALE_DAYS}d ago`);
    return { ...base, verdict: (reasons.length ? "check" : "safe") as Verdict, reasons };
  });
}

/** Button wording: "Delete" only when the action really deletes a folder. */
export function clearLabels(deletesFolder: boolean) {
  return deletesFolder
    ? { label: "Archive", armed: "Delete folder?" }
    : { label: "Clear records", armed: "Clear records?" };
}

/** Wording for the bulk "safe" button over a set of folders. */
export function bulkLabels(safe: Pick<Folder, "deletesFolder">[]) {
  const del = safe.filter((f) => f.deletesFolder).length;
  const n = safe.length;
  if (del === n) return { label: `Archive ${n} safe`, armed: `Delete ${n} folders?` };
  if (del === 0) return { label: `Clear ${n} safe`, armed: `Clear ${n} folder records?` };
  return { label: `Archive ${n} safe`, armed: `Delete ${del} folders, clear ${n - del}?` };
}
