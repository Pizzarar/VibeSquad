export type WatchKind = "agent" | "suite" | "restart";
export type WatchItemState = "waiting" | "done" | "fail" | "stalled";

export interface WatchItem {
  kind: WatchKind;
  ref: string;
  state: WatchItemState;
  since: string;
  phase?: string;
  phaseSince?: string;
  reason?: string;
  report?: string;
  doneAt?: string;
  stallFiredAt?: string;
  /** suite: the full run whose record set the verdict */
  run?: { pid: number | null; startedAt: number | string };
}

export interface WatchPing {
  key: string;
  at: string;
  text: string;
  attemptedAt?: string;
  deliveredAt?: string;
  to?: string;
  error?: string;
}

export interface WatchSet {
  id: string;
  owner: string;
  team: string;
  lane: string;
  createdAt: string;
  stallMin: number;
  items: WatchItem[];
  pings: WatchPing[];
  firedAt?: string;
  lastPingAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  /** W4: timestamp of the set's one Flash merge spawn (at most one per set). */
  digestSpawnedAt?: string;
}

export interface WatchDelivery {
  key: string;
  setId: string;
  pingKey: string;
  text: string;
  owner: string;
  team: string;
  lane: string;
  set: WatchSet;
}

export const WATCH_KINDS: readonly WatchKind[];
export const DEFAULT_STALL_MIN: number;
export const SUITE_RESULT_FILE: string;
export const SUITE_LOCK_FILE: string;
export const PRUNE_AFTER_MS: number;
export const DIGEST_MERGE_MAX: number;
export function watchesPath(opts?: { home?: string }): string;

export function addWatch(
  spec: { owner: string; team?: string; lane?: string; items: Array<{ kind: WatchKind; ref?: string }>; stallMin?: number },
  opts?: { home?: string; now?: number },
): { id: string };
export function listWatches(filter?: { owner?: string; team?: string }, opts?: { home?: string }): Array<WatchSet & { status: "armed" | "fired" | "cancelled" }>;
export function cancelWatch(id: string, callerId: string, opts?: { home?: string; now?: number }): { ok: boolean; id: string; error?: string; already?: boolean };

export function classifyItem(item: WatchItem, set: WatchSet, ctx: any): { phase: string; phaseSince?: string; state: WatchItemState; reason?: string; report?: string };
export function stepSet(set: WatchSet, ctx: any): WatchPing | null;

export interface WatchEngineOptions {
  home?: string;
  tmpdir?: string;
  now?: () => number;
  alive?: (pid: number) => boolean;
  getAgent?: (id: string) => Promise<any>;
  deliver?: (d: WatchDelivery) => Promise<void> | void;
  /** W4: spawn the merge worker for a too-long ping; truthy = spawned (the worker sends the merged digest). */
  spawnDigest?: (d: WatchDelivery) => Promise<boolean> | boolean;
  log?: (msg: string) => void;
  retryMs?: number;
}

export interface WatchEngine {
  file: string;
  reload(): { version: number; sets: WatchSet[] };
  start(): void;
  tick(): Promise<void>;
  onRunnerEvent(ev: any): void;
  onLogEntry(team: string, entry: { ts: string; agent: string; lane: string; type: string; text: string; refs: string[] }): string[];
  holdingSets(entry: any, setIds: string[]): Promise<WatchSet[]>;
  markAttempted(keys: string[], to: string): void;
  markDelivered(keys: string[], to: string): void;
  markFailed(keys: string[], error: string): void;
  get(id: string): WatchSet | null;
  list(): WatchSet[];
}

export function createWatchEngine(opts?: WatchEngineOptions): WatchEngine;
