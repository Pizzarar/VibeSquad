// @desk F1 (docs/PLAN_DESK_DD_FILTER.md): pure helpers for Decision Desk project filter pills.
// "Asleep" reuses the folder primitive (isViewAsleep); localStorage stores explicit overrides only.
import { isViewAsleep } from "./boringFolders";
import type { FolderDef, TeamView } from "./teams";

export const DECISION_FILTER_KEY = "vs.decisionFilterOverrides";

/** Explicit per-project visibility overrides keyed by lowercased squad id. Absent = follow awake/asleep default. */
export type DecisionFilterOverrides = Record<string, boolean>;

export type DecisionFilterPill = {
  squadId: string;
  squadName: string;
  openCount: number;
  asleep: boolean;
  active: boolean;
  overridden: boolean;
};

type StorageReader = Pick<Storage, "getItem"> | null | undefined;
type StorageWriter = Pick<Storage, "setItem" | "removeItem"> | null | undefined;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readDecisionFilterOverrides(storage: StorageReader = defaultStorage()): DecisionFilterOverrides {
  if (!storage) return {};
  try {
    const raw = storage.getItem(DECISION_FILTER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DecisionFilterOverrides = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = k.trim().toLowerCase();
      if (key && typeof v === "boolean") out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDecisionFilterOverrides(overrides: DecisionFilterOverrides, storage: StorageWriter = defaultStorage()): void {
  if (!storage) return;
  try {
    const clean: DecisionFilterOverrides = {};
    for (const [k, v] of Object.entries(overrides)) {
      const key = k.trim().toLowerCase();
      if (key && typeof v === "boolean") clean[key] = v;
    }
    if (Object.keys(clean).length === 0) storage.removeItem(DECISION_FILTER_KEY);
    else storage.setItem(DECISION_FILTER_KEY, JSON.stringify(clean));
  } catch {}
}

/** True when the squad is visible given its asleep state and explicit overrides. */
export function isSquadVisible(squadId: string, asleep: boolean, overrides: Readonly<DecisionFilterOverrides>): boolean {
  const key = squadId.toLowerCase();
  return Object.prototype.hasOwnProperty.call(overrides, key) ? Boolean(overrides[key]) : !asleep;
}

/**
 * Build the project filter pills: one per project that is awake or has open items, each with its open count.
 * Awake projects default ON; asleep projects default OFF in the trailing `onHold` group.
 */
export function buildDecisionPills(
  views: readonly TeamView[],
  folders: readonly FolderDef[],
  items: readonly { squad: string; squadName?: string }[],
  overrides: Readonly<DecisionFilterOverrides>,
): { awake: DecisionFilterPill[]; onHold: DecisionFilterPill[]; all: DecisionFilterPill[] } {
  const openCounts = new Map<string, number>();
  const itemSquadMeta = new Map<string, { squadId: string; squadName: string }>();
  for (const item of items) {
    const key = item.squad.toLowerCase();
    openCounts.set(key, (openCounts.get(key) ?? 0) + 1);
    if (!itemSquadMeta.has(key)) {
      itemSquadMeta.set(key, { squadId: item.squad, squadName: item.squadName || item.squad });
    }
  }

  const awake: DecisionFilterPill[] = [];
  const onHold: DecisionFilterPill[] = [];
  const seen = new Set<string>();
  const folderList = folders as FolderDef[];

  for (const view of views) {
    const key = view.team.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const asleep = isViewAsleep(view, folderList);
    const openCount = openCounts.get(key) ?? 0;
    if (asleep && openCount === 0) continue;
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
    const active = overridden ? Boolean(overrides[key]) : !asleep;
    const pill: DecisionFilterPill = {
      squadId: view.team.id,
      squadName: view.team.name,
      openCount,
      asleep,
      active,
      overridden,
    };
    if (asleep) onHold.push(pill);
    else awake.push(pill);
  }

  // Include any open-item squad not present in views (e.g. demo fallback) as awake so nothing is orphaned.
  for (const [key, meta] of itemSquadMeta) {
    if (seen.has(key)) continue;
    seen.add(key);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
    const active = overridden ? Boolean(overrides[key]) : true;
    awake.push({
      squadId: meta.squadId,
      squadName: meta.squadName,
      openCount: openCounts.get(key) ?? 0,
      asleep: false,
      active,
      overridden,
    });
  }

  return { awake, onHold, all: [...awake, ...onHold] };
}

/** Toggle one project pill. Toggling back to its awake/asleep default clears the explicit override. */
export function toggleDecisionPill(
  overrides: Readonly<DecisionFilterOverrides>,
  squadId: string,
  asleep: boolean,
): DecisionFilterOverrides {
  const key = squadId.toLowerCase();
  const defaultOn = !asleep;
  const nextVal = !isSquadVisible(key, asleep, overrides);
  const next: DecisionFilterOverrides = { ...overrides };
  if (nextVal === defaultOn) delete next[key];
  else next[key] = nextVal;
  return next;
}

/** `Active` preset: clears all explicit overrides (awake ON, asleep OFF). */
export function applyActivePreset(): DecisionFilterOverrides {
  return {};
}

/** `All` preset: turns every pill ON (stores explicit overrides only for asleep projects). */
export function applyAllPreset(pills: readonly DecisionFilterPill[]): DecisionFilterOverrides {
  const next: DecisionFilterOverrides = {};
  for (const p of pills) {
    if (p.asleep) next[p.squadId.toLowerCase()] = true;
  }
  return next;
}

/** Preset button pressed states derived from the current pill visibility. */
export function decisionFilterPresetState(pills: readonly DecisionFilterPill[]): { isActivePreset: boolean; isAllPreset: boolean } {
  const isActivePreset = pills.length > 0 && pills.every((p) => p.active === !p.asleep);
  const isAllPreset = pills.length > 0 && pills.every((p) => p.active);
  return { isActivePreset, isAllPreset };
}

export function visibleSquadIds(pills: readonly DecisionFilterPill[]): Set<string> {
  return new Set(pills.filter((p) => p.active).map((p) => p.squadId.toLowerCase()));
}

export function filterDecisionItems<T extends { squad: string }>(items: readonly T[], visible: ReadonlySet<string>): T[] {
  return items.filter((i) => visible.has(i.squad.toLowerCase()));
}

/** Count open decisions visible under the current filter (saved overrides + asleep-folder defaults). */
export function countVisibleDecisions(
  views: readonly TeamView[],
  folders: readonly FolderDef[],
  items: readonly { squad: string; squadName?: string }[],
  overrides: Readonly<DecisionFilterOverrides>,
): number {
  const pills = buildDecisionPills(views, folders, items, overrides);
  return filterDecisionItems(items, visibleSquadIds(pills.all)).length;
}

export function filterStatusGroups<T extends { squadId: string }>(groups: readonly T[], visible: ReadonlySet<string>): T[] {
  return groups.filter((g) => visible.has(g.squadId.toLowerCase()));
}

type StagedLike = { choice: string; text?: string };

export function isStagedSendable(sel: StagedLike | undefined): boolean {
  if (!sel) return false;
  if (sel.choice === "reply") return typeof sel.text === "string" && sel.text.trim().length > 0;
  return true;
}

/** Count sendable staged answers whose project is currently hidden by the filter. */
export function countHiddenStaged(
  allItems: readonly { id: string; squad: string }[],
  visible: ReadonlySet<string>,
  staged: Readonly<Record<string, StagedLike | undefined>>,
): number {
  let hidden = 0;
  for (const item of allItems) {
    if (visible.has(item.squad.toLowerCase())) continue;
    if (isStagedSendable(staged[item.id])) hidden++;
  }
  return hidden;
}
