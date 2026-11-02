// Remove team (docs/PLAN_BUGS_BATCH1.md block 1): Team ⋯ → Remove team… → confirm → the lane is hidden
// (state "removed", the teams.json row and brief stay) and its agents are archived. Worktrees + branches
// are deleted only when the confirm dialog's opt-in box is ticked, and never when another live team
// shares the folders. Pure plan + injected effects, like src/pinComplete.ts; src/pinActions.ts wires them, src/PinRemove.tsx is the dialog.
import type { PaseoAgent } from "@getpaseo/client";
import type { LaneDef, Member, TeamDef, TeamsUpdater } from "./teams.ts";
import { appendBriefLine, briefStamp, patchLane, type Pin } from "./pins.ts";

/** The slice of a Paseo workspace the plan needs. */
export type WorkspaceLike = {
  id: string;
  workspaceDirectory?: string | null;
  workspaceKind?: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
};

export type TeamWorktree = { path: string; branch: string | null; workspaceId: string };

export type RemovePlan = {
  /** Every agent in the lane that is not archived yet (live, idle, closed, retired). */
  agents: PaseoAgent[];
  /** Linked git worktrees the team's agents work in. */
  worktrees: TeamWorktree[];
  /** Name of another live team that shares this team's folders; the delete box is disabled when set. */
  sharedWith: string | null;
};

const norm = (p?: string | null) => (p ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
const inside = (cwd: string | undefined, dir: string) => {
  const c = norm(cwd);
  return Boolean(dir) && (c === dir || c.startsWith(dir + "/"));
};
const laneKeys = (lane: LaneDef) => new Set([lane.id, ...(lane.aliases ?? [])].map((x) => x.toLowerCase()));
const labelsOf = (a: PaseoAgent) => (a.labels ?? {}) as Record<string, string>;
const laneOfMember = (m: Member) => (m.laneId ?? labelsOf(m.agent).lane ?? labelsOf(m.agent).lead ?? "").toLowerCase();

function inLane(m: Member, squadId: string, keys: Set<string>): boolean {
  if (!keys.has(laneOfMember(m))) return false;
  // Resolved into this squad, or labelled for it (a cross-squad Brainstorm/Lead still belongs to the lane).
  return m.team.id === squadId || labelsOf(m.agent).team === squadId;
}

export function removeTeamPlan(input: {
  squadId: string;
  laneId: string;
  teams: TeamDef[];
  /** Every resolved agent (src/teams.ts resolve), live and closed. */
  members: Member[];
  /** Archived agents already gone from the live list; only used to find the team's worktrees. */
  archived?: PaseoAgent[];
  workspaces: WorkspaceLike[];
}): RemovePlan {
  const squad = input.teams.find((t) => t.id === input.squadId);
  const lane = squad?.lanes.find((l) => l.id.toLowerCase() === input.laneId.toLowerCase()) ?? { id: input.laneId, name: input.laneId };
  const keys = laneKeys(lane);
  const mine = input.members.filter((m) => inLane(m, input.squadId, keys));
  const agents = mine.map((m) => m.agent).filter((a) => !a.archivedAt);

  const archivedMine = (input.archived ?? []).filter((a) => {
    const l = labelsOf(a);
    return keys.has((l.lane || l.lead || "").toLowerCase()) && l.team === input.squadId;
  });
  const cwds = [...mine.map((m) => m.agent.cwd), ...archivedMine.map((a) => a.cwd)];
  const worktrees: TeamWorktree[] = [];
  const seen = new Set<string>();
  for (const w of input.workspaces) {
    const dir = norm(w.workspaceDirectory);
    if (w.workspaceKind !== "worktree" || !dir || seen.has(dir)) continue;
    if (!cwds.some((c) => inside(c, dir))) continue;
    seen.add(dir);
    worktrees.push({ path: String(w.workspaceDirectory), branch: w.gitRuntime?.currentBranch ?? null, workspaceId: w.id });
  }

  return { agents, worktrees, sharedWith: sharedWith(input, squad, lane, worktrees) };
}

/**
 * Another live (not removed) team that shares this team's folders: the same declared path
 * (the legacy `pinned` lane ↔ `vibesquad`), or a non-archived agent of its own inside one of the worktrees.
 */
function sharedWith(
  input: { squadId: string; teams: TeamDef[]; members: Member[] },
  squad: TeamDef | undefined,
  lane: LaneDef,
  worktrees: TeamWorktree[],
): string | null {
  const own = new Set((lane.paths ?? []).map((p) => p.toLowerCase()));
  for (const t of input.teams)
    for (const other of t.lanes) {
      if (other.state === "removed" || (t.id === squad?.id && other.id.toLowerCase() === lane.id.toLowerCase())) continue;
      if ((other.paths ?? []).some((p) => own.has(p.toLowerCase()))) return other.name || other.id;
      const keys = laneKeys(other);
      const dirs = worktrees.map((w) => norm(w.path));
      if (input.members.some((m) => !m.agent.archivedAt && inLane(m, t.id, keys) && dirs.some((d) => inside(m.agent.cwd, d))))
        return other.name || other.id;
    }
  return null;
}

export type WorktreeResult = { path: string; branch: string | null; worktree: "removed" | "kept" | "missing"; branchResult: string; reason?: string };

export type RemoveEffects = {
  archive: (id: string) => Promise<unknown>;
  saveTeams: (update: TeamsUpdater) => Promise<unknown>;
  readBrief?: (laneId: string) => Promise<string>;
  writeBrief?: (laneId: string, content: string) => Promise<void>;
  /** git worktree remove + git branch -d on the server (server/team-worktrees.mjs). */
  removeWorktrees?: (items: { path: string; branch: string | null }[]) => Promise<WorktreeResult[]>;
  /** Paseo archive_workspace, so the workspace record goes too. */
  archiveWorkspace?: (workspaceId: string) => Promise<unknown>;
  now?: () => Date;
};

export type RemoveResult = { archived: string[]; worktrees: WorktreeResult[] };

/**
 * Archive every agent, then hide the lane (state "removed" + removedAt), then (opt-in, not shared)
 * delete the worktrees and branches. An archive failure throws before the state changes, so the click
 * can be retried. Worktree failures never undo the removal; they come back as "kept" with git's reason.
 */
export async function runRemoveTeam(
  pin: Pin,
  plan: RemovePlan,
  opts: { deleteWorktrees: boolean },
  fx: RemoveEffects,
): Promise<RemoveResult> {
  const now = fx.now?.() ?? new Date();
  for (const a of plan.agents) await fx.archive(a.id);
  await fx.saveTeams((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { state: "removed", removedAt: now.toISOString() }));

  if (fx.readBrief && fx.writeBrief) {
    const line = `Removed ${briefStamp(now)}`;
    await fx
      .readBrief(pin.lane.id)
      .then((b) => fx.writeBrief!(pin.lane.id, appendBriefLine(b, line)))
      .catch(() => {});
  }

  let worktrees: WorktreeResult[] = [];
  if (opts.deleteWorktrees && !plan.sharedWith && plan.worktrees.length && fx.removeWorktrees) {
    worktrees = await fx.removeWorktrees(plan.worktrees.map(({ path, branch }) => ({ path, branch })));
    for (const w of plan.worktrees) {
      const r = worktrees.find((x) => norm(x.path) === norm(w.path));
      if (r && r.worktree !== "kept") await fx.archiveWorkspace?.(w.workspaceId).catch(() => {});
    }
  }
  return { archived: plan.agents.map((a) => a.id), worktrees };
}
