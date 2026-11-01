// Three-way merge for the teams registry. When a save hits 409 (someone else, e.g. `vs pin new`, wrote teams.json
// since our last GET), saveTeams re-applies our edit on top of the fresh file instead of overwriting it.
// `base` is what we started editing from, `mine` is our edited copy, `fresh` is the file as it is now.

type WithId = { id: string };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Per-field: a field we changed takes our value, any other field takes the fresh one. */
function mergeFields<T extends object>(base: T, mine: T, fresh: T, skip: string[] = []): T {
  const out: Record<string, unknown> = {};
  const b = base as Record<string, unknown>;
  const m = mine as Record<string, unknown>;
  const f = fresh as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(f)])) {
    if (skip.includes(k)) continue;
    const v = same(b[k], m[k]) ? f[k] : m[k];
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/**
 * Merge lists by id: ours keep our order; items only in `fresh` (added elsewhere) are appended;
 * items we removed stay removed; items removed elsewhere stay removed unless we edited them.
 */
function mergeList<T extends WithId>(base: T[], mine: T[], fresh: T[], mergeItem: (b: T, m: T, f: T) => T): T[] {
  const baseById = new Map(base.map((x) => [x.id, x]));
  const mineIds = new Set(mine.map((x) => x.id));
  const freshById = new Map(fresh.map((x) => [x.id, x]));
  const out: T[] = [];
  for (const m of mine) {
    const b = baseById.get(m.id);
    const f = freshById.get(m.id);
    if (!b) out.push(m);
    else if (!f) {
      if (!same(b, m)) out.push(m);
    } else out.push(mergeItem(b, m, f));
  }
  for (const f of fresh) if (!mineIds.has(f.id) && !baseById.has(f.id)) out.push(f);
  return out;
}

export function mergeTeams<L extends WithId, T extends WithId & { lanes?: L[] }>(base: T[], mine: T[], fresh: T[]): T[] {
  return mergeList(base, mine, fresh, (b, m, f) => {
    const merged = mergeFields(b, m, f, ["lanes"]);
    const lanes = mergeList(b.lanes ?? [], m.lanes ?? [], f.lanes ?? [], (bl, ml, fl) => mergeFields(bl, ml, fl));
    return { ...merged, lanes } as T;
  });
}
