// Composer queue: messages typed while an agent is busy. A module-level store (not drawer React state), so
// it survives closing the drawer and flushes whenever the agent goes idle. Text persists to localStorage
// (survives a reload); image blobs stay in memory only, so a reload keeps the text and drops the images.
import { useSyncExternalStore } from "react";
import type { QueuedTurnItem } from "./Composer";

export const QUEUE_STORAGE_KEY = "vs.composer-queue";
const EMPTY: QueuedTurnItem[] = [];

let queues: Record<string, QueuedTurnItem[]> = load();
const listeners = new Set<() => void>();

function load(): Record<string, QueuedTurnItem[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) ?? "{}");
    const out: Record<string, QueuedTurnItem[]> = {};
    for (const [id, list] of Object.entries(raw ?? {})) {
      if (!Array.isArray(list)) continue;
      const items = list.filter((q) => q && typeof q.text === "string" && typeof q.id === "string");
      if (items.length) out[id] = items.map((q) => ({ id: q.id, text: q.text, createdAt: Number(q.createdAt) || 0 }));
    }
    return out;
  } catch {
    return {};
  }
}

function commit(next: Record<string, QueuedTurnItem[]>) {
  queues = next;
  try {
    const slim: Record<string, Array<Pick<QueuedTurnItem, "id" | "text" | "createdAt">>> = {};
    for (const [id, list] of Object.entries(next)) slim[id] = list.map(({ id: i, text, createdAt }) => ({ id: i, text, createdAt }));
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(slim));
  } catch {
    /* storage full or unavailable: the in-memory queue still works */
  }
  for (const l of listeners) l();
}

function setList(agentId: string, list: QueuedTurnItem[]) {
  const next = { ...queues };
  if (list.length) next[agentId] = list;
  else delete next[agentId];
  commit(next);
}

export const getQueued = (agentId: string): QueuedTurnItem[] => queues[agentId] ?? EMPTY;
export const subscribeQueue = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export function useQueued(agentId: string): QueuedTurnItem[] {
  return useSyncExternalStore(subscribeQueue, () => getQueued(agentId));
}

export function enqueueQueued(agentId: string, item: QueuedTurnItem) {
  setList(agentId, [...getQueued(agentId), item]);
}

/** Remove and return every queued item for the agent (flush / Send now). */
export function takeQueued(agentId: string): QueuedTurnItem[] {
  const items = getQueued(agentId);
  if (items.length) setList(agentId, []);
  return items;
}

/** Put items back at the front of the queue (a send failed after they were taken). */
export function requeueQueued(agentId: string, items: QueuedTurnItem[]) {
  setList(agentId, [...items, ...getQueued(agentId)]);
}

export const restoreText = (items: QueuedTurnItem[]): string => items.map((q) => q.text).join("\n\n");

type FlushDeps = {
  getStatus: (agentId: string) => string | undefined;
  subscribe: (l: () => void) => () => void;
  send: (agentId: string, text: string, images: Array<{ blob: Blob }>) => Promise<void>;
  /** Once the first roster has arrived, entries for agents missing from it are pruned (they can never flush). */
  roster?: () => { loaded: boolean; has: (agentId: string) => boolean };
};

/** Roster view for pruning: an empty or not-yet-populated roster is "unknown", never "everyone is gone". */
export const rosterForQueue = (st: { rosterLoaded: boolean; agents: Map<string, unknown> }) => ({
  loaded: st.rosterLoaded && st.agents.size > 0,
  has: (id: string) => st.agents.has(id),
});

/** Drop queued entries for agents that are gone from the roster (lingered in vs.composer-queue forever). */
export function pruneQueued(has: (agentId: string) => boolean) {
  const next: Record<string, QueuedTurnItem[]> = {};
  let changed = false;
  for (const [id, list] of Object.entries(queues)) {
    if (has(id)) next[id] = list;
    else changed = true;
  }
  if (changed) commit(next);
}

/** Sends each agent's queue as one steer turn as soon as that agent is neither running nor closed. Needs no drawer. */
export function startQueueFlusher(deps: FlushDeps): () => void {
  const inflight = new Set<string>();
  const run = () => {
    const r = deps.roster?.();
    if (r?.loaded) pruneQueued(r.has);
    for (const agentId of Object.keys(queues)) {
      const status = deps.getStatus(agentId);
      if (!status || status === "running" || status === "closed" || inflight.has(agentId)) continue;
      const items = takeQueued(agentId);
      if (!items.length) continue;
      inflight.add(agentId);
      deps
        .send(agentId, restoreText(items), items.flatMap((q) => q.images ?? []))
        .catch(() => {
          requeueQueued(agentId, items);
        })
        .finally(() => {
          inflight.delete(agentId);
        });
    }
  };
  const stop = deps.subscribe(run);
  const unsub = subscribeQueue(run);
  run();
  return () => {
    stop();
    unsub();
  };
}

export function __resetQueueForTest(opts: { keepStorage?: boolean } = {}) {
  if (!opts.keepStorage) localStorage.removeItem(QUEUE_STORAGE_KEY);
  queues = load();
}
