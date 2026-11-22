// B11b (docs/PLAN_BORING_MODE_B10.md): pure helpers for the Normal-mode sidebar project folders.
import { isTeamAsleep, refreshTeams, type FolderDef, type TeamView } from "./teams.ts";

export type FolderStat = { needsYou: number; err: boolean };
export type FolderGroup = { folder: FolderDef; views: TeamView[]; count: number; needsYou: number; err: boolean };

/** Stable test-id slug for a folder name. */
export const folderSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "folder";

/** True when the project sits in an asleep folder (no folder / unknown folder = awake). */
export const isViewAsleep = (view: TeamView, folders: FolderDef[]): boolean => isTeamAsleep(view.team, { folders });

/** Drop asleep projects: global badges, the tab title and the Needs-you inbox only count awake work. */
export const filterAwakeViews = (views: TeamView[], folders: FolderDef[]): TeamView[] => views.filter((v) => !isViewAsleep(v, folders));

/** Unfoldered (or unknown-folder) projects first, then one group per folder in folder order. `stat` supplies each project's needs-you count + error flag. */
export function partitionViews(views: TeamView[], folders: FolderDef[], stat: (v: TeamView) => FolderStat = () => ({ needsYou: 0, err: false })) {
  const known = new Set(folders.map((f) => f.name));
  const activeViews = views.filter((v) => !v.team.folder || !known.has(v.team.folder));
  const folderGroups: FolderGroup[] = folders.map((folder) => {
    const fv = views.filter((v) => v.team.folder === folder.name);
    let needsYou = 0;
    let err = false;
    for (const v of fv) { const s = stat(v); needsYou += s.needsYou; err = err || s.err; }
    return { folder, views: fv, count: fv.length, needsYou, err };
  });
  return { activeViews, folderGroups };
}

export type FolderOp =
  | { op: "createFolder"; name: string; asleep?: boolean }
  | { op: "renameFolder"; name: string; newName: string }
  | { op: "deleteFolder"; name: string }
  | { op: "setFolderAsleep"; name: string; asleep: boolean }
  | { op: "setTeamFolder"; teamId: string; folder: string | null };

/** PATCH /api/teams with one folder op, then re-read the registry so the sidebar repaints. */
export async function patchTeamsFolder(op: FolderOp, revision?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/teams", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(revision ? { ...op, revision } : op) });
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return { ok: false, error: typeof body?.error === "string" ? body.error : `HTTP ${r.status}` };
    }
    await refreshTeams();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
