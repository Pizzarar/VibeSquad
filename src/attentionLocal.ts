// Local attention state: snoozes and dismissals for kinds Paseo labels can't carry (errors, finished,
// permissions) plus the "mark unread" flag. Kept in localStorage so a reload doesn't bring them back.
// No imports from paseo.ts/React: teams.ts reads it, and tests import it directly.

const KEY = "vs.attention-local.v1";

type Snapshot = { snoozed: Record<string, number>; dismissed: Record<string, string>; unread: string[] };

let snoozed = new Map<string, number>();
let dismissed = new Map<string, string>();
let unread = new Set<string>();
const listeners = new Set<() => void>();

const store = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const MAX_ENTRIES = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keep only well-typed entries, newest MAX_ENTRIES, and drop snoozes that already ended. */
function parse(raw: string | null | undefined, now: number): Snapshot {
  const out: Snapshot = { snoozed: {}, dismissed: {}, unread: [] };
  if (!raw) return out;
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(s)) return out;
  if (isRecord(s.snoozed))
    for (const [k, v] of Object.entries(s.snoozed)) if (typeof v === "number" && Number.isFinite(v) && v > now) out.snoozed[k] = v;
  if (isRecord(s.dismissed)) for (const [k, v] of Object.entries(s.dismissed)) if (typeof v === "string") out.dismissed[k] = v;
  if (Array.isArray(s.unread)) out.unread = s.unread.filter((v): v is string => typeof v === "string");
  out.snoozed = Object.fromEntries(Object.entries(out.snoozed).slice(-MAX_ENTRIES));
  out.dismissed = Object.fromEntries(Object.entries(out.dismissed).slice(-MAX_ENTRIES));
  out.unread = out.unread.slice(-MAX_ENTRIES);
  return out;
}

/** Exported for tests: parse a stored snapshot into the in-memory state. */
export function loadAttentionLocal(raw: string | null | undefined, now: number = Date.now()) {
  const s = parse(raw, now);
  snoozed = new Map(Object.entries(s.snoozed));
  dismissed = new Map(Object.entries(s.dismissed));
  unread = new Set(s.unread);
}

/** Exported for tests: the snapshot save() would persist (pruned and capped). */
export function snapshotAttentionLocal(now: number = Date.now()): Snapshot {
  return parse(JSON.stringify({ snoozed: Object.fromEntries(snoozed), dismissed: Object.fromEntries(dismissed), unread: [...unread] }), now);
}

loadAttentionLocal(store()?.getItem(KEY));

function save() {
  const s = snapshotAttentionLocal();
  snoozed = new Map(Object.entries(s.snoozed));
  dismissed = new Map(Object.entries(s.dismissed));
  unread = new Set(s.unread);
  try {
    store()?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota or private mode: in-memory only */
  }
  listeners.forEach((l) => l());
}

export const subscribeAttentionLocal = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function snoozeLocal(id: string, untilMs: number) {
  snoozed.set(id, untilMs);
  save();
}

/** Hide an error/finished item until its signature (error text / attention reason) changes. */
export function dismissLocal(id: string, signature: string) {
  dismissed.set(id, signature);
  save();
}

export function markUnreadLocal(id: string) {
  unread.add(id);
  snoozed.delete(id);
  dismissed.delete(id);
  save();
}

export function clearUnreadLocal(id: string) {
  if (unread.delete(id)) save();
}

export const isMarkedUnread = (id: string) => unread.has(id);

/** True while a local snooze is running or the item's current signature was dismissed. */
export function isLocallyHidden(id: string, signature: string, now: number = Date.now()): boolean {
  const until = snoozed.get(id);
  if (until !== undefined && until > now) return true;
  return dismissed.get(id) === signature;
}

export const localSnoozeUntil = (id: string) => snoozed.get(id);

/** Test hook. */
export function resetAttentionLocal() {
  snoozed = new Map();
  dismissed = new Map();
  unread = new Set();
  listeners.clear();
}
