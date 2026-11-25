// PLAN_PROJECT_ORDER O1: sidebar project order + the single "Main project" flag. Pure logic (teams.json array order is the order),
// deps injected like crunchMode.ts so it is unit-testable without React. Persists through saveTeams; a failed save rolls back.
type Ordered = { id: string; folder?: string; main?: boolean };
export type OrderDir = "up" | "down";

/** Main first, then the incoming (teams.json) order. No Main set = the input order, untouched. */
export function orderViews<T extends { team: { main?: boolean } }>(views: T[]): T[] {
  const main = views.filter((v) => v.team.main === true).slice(0, 1);
  return main.length ? [...main, ...views.filter((v) => v !== main[0])] : views;
}

/** The Main project's view (first flagged), or null. */
export const mainView = <T extends { team: { main?: boolean } }>(views: T[]): T | null => views.find((v) => v.team.main === true) ?? null;

/** Set (on) or clear (off) Main. Setting one clears every other, so at most one team ever carries it; off drops the key. */
export function setMainTeams<T extends Ordered>(teams: T[], id: string, on: boolean): T[] {
  return teams.map((t) => {
    if (t.id === id && on) return { ...t, main: true };
    if (t.main === undefined) return t;
    const { main: _m, ...rest } = t;
    return rest as T;
  });
}

/** A project sits in its folder's list; no folder or an unknown folder = the unfoldered list (matches partitionViews). */
const groupOf = (t: Ordered, known: ReadonlySet<string>): string => (t.folder && known.has(t.folder) ? t.folder : "");

/** Index of the neighbour a Move up/down would swap with (same folder/list), or -1 at the end. */
function neighbour(teams: Ordered[], id: string, dir: OrderDir, known: ReadonlySet<string>): number {
  const i = teams.findIndex((t) => t.id === id);
  // The Main project is pinned above the tree, so it is never a visible neighbour and has no Move of its own.
  if (i < 0 || teams[i].main === true) return -1;
  const g = groupOf(teams[i], known);
  const step = dir === "up" ? -1 : 1;
  for (let j = i + step; j >= 0 && j < teams.length; j += step) if (teams[j].main !== true && groupOf(teams[j], known) === g) return j;
  return -1;
}

export const canMove = (teams: Ordered[], id: string, dir: OrderDir, known: ReadonlySet<string>): boolean => neighbour(teams, id, dir, known) >= 0;

/** Swap with the previous/next project of the same folder/list; the array is returned as-is at the ends. */
export function moveTeam<T extends Ordered>(teams: T[], id: string, dir: OrderDir, known: ReadonlySet<string>): T[] {
  const j = neighbour(teams, id, dir, known);
  if (j < 0) return teams;
  const i = teams.findIndex((t) => t.id === id);
  const out = [...teams];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Drop `id` before/after `targetId`. Only inside one folder/list; anything else (other list, same row, unknown id) is a no-op. */
export function dropTeam<T extends Ordered>(teams: T[], id: string, targetId: string, where: "before" | "after", known: ReadonlySet<string>): T[] {
  const from = teams.find((t) => t.id === id);
  const to = teams.find((t) => t.id === targetId);
  if (!from || !to || from.main === true || to.main === true || id === targetId || groupOf(from, known) !== groupOf(to, known)) return teams;
  const rest = teams.filter((t) => t.id !== id);
  const at = rest.findIndex((t) => t.id === targetId) + (where === "after" ? 1 : 0);
  const out = [...rest.slice(0, at), from, ...rest.slice(at)];
  // Compare what the sidebar shows (Main is lifted out): a drop that only hops the hidden Main slot is not a write.
  const shown = (ts: T[]) => ts.filter((t) => t.main !== true).map((t) => t.id).join();
  return shown(out) === shown(teams) ? teams : out;
}

export type OrderDeps = {
  /** Applies the updater locally and to the registry; {disk:false} when the write did not land. */
  save: (update: (cur: Ordered[]) => Ordered[]) => Promise<{ disk: boolean }>;
  /** Drops the optimistic local copy and returns to the registry file. */
  rollback: () => void;
};

/** One chain for all order writes: a second click or drop never races the first into a 409. A failed save rolls back. */
export function createOrderOps(deps: OrderDeps) {
  let tail: Promise<unknown> = Promise.resolve();
  const run = (update: (cur: Ordered[]) => Ordered[]): Promise<boolean> => {
    const p = tail.then(async () => {
      let ok = false;
      try { ok = (await deps.save(update)).disk; } catch { ok = false; }
      if (!ok) deps.rollback();
      return ok;
    });
    tail = p.catch(() => undefined);
    return p;
  };
  return {
    setMain: (id: string, on: boolean) => run((cur) => setMainTeams(cur, id, on)),
    move: (id: string, dir: OrderDir, known: ReadonlySet<string>) => run((cur) => moveTeam(cur, id, dir, known)),
    drop: (id: string, targetId: string, where: "before" | "after", known: ReadonlySet<string>) => run((cur) => dropTeam(cur, id, targetId, where, known)),
  };
}
