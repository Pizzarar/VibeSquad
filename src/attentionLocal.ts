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

function load() {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as Partial<Snapshot>;
    snoozed = new Map(Object.entries(s.snoozed ?? {}));
    dismissed = new Map(Object.entries(s.dismissed ?? {}));
    unread = new Set(s.unread ?? []);
  } catch {
    /* corrupt entry: start clean */
  }
}
load();

function save() {
  try {
    const s: Snapshot = { snoozed: Object.fromEntries(snoozed), dismissed: Object.fromEntries(dismissed), unread: [...unread] };
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
