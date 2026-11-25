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
  /** idea-160: idle-no-report escalation steps (owner re-ping, Overlord ping) and the one auto-nudge */
  esc1At?: string;
  esc2At?: string;
  nudgeDueAt?: string;
  nudgeSentAt?: string;
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
  /** idea-160: "overlord" = deliver to the Squad's hub Lead; "owner" (or absent) = the watch owner */
  target?: "owner" | "overlord";
  error?: string;
  /** idea-450: worker refs whose FULL final is delivered by this completion ping (detail or item line). */
  finalRefs?: string[];
}

export interface WatchSet {
  id: string;
  owner: string;
  team: string;
  lane: string;
  createdAt: string;
  stallMin: number;
  /** idea-160: minutes between idle-no-report escalation steps (default DEFAULT_ESCALATE_MIN) */
  escalateMin?: number;
  /** idea-160: false = no auto-nudge */
  nudge?: boolean;
  items: WatchItem[];
  pings: WatchPing[];
  firedAt?: string;
  lastPingAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  /** W4: timestamp of the set's one Flash merge spawn (at most one per set). */
  digestSpawnedAt?: string;
  /** idea-418: earlier owners, oldest first (lead handoff or the retired-owner delivery fallback moved the set). */
  reowned?: Array<{ from: string; at: string; reason?: string }>;
}

export interface WatchDelivery {
  key: string;
  setId: string;
  pingKey: string;
  text: string;
  /** idea-352: watched workers' final messages (completion ping only), delivered after the text. */
  detail?: string;
  /** idea-450: worker refs whose FULL final is delivered by this completion ping (detail or item line). */
  finalRefs?: string[];
  owner: string;
  team: string;
  lane: string;
  target?: "owner" | "overlord";
  set: WatchSet;
}

export const WATCH_KINDS: readonly WatchKind[];
export const DEFAULT_STALL_MIN: number;
export const DEFAULT_ESCALATE_MIN: number;
export const IDLE_NUDGE_TEXT: string;
export const SUITE_RESULT_FILE: string;
export const SUITE_LOCK_FILE: string;
export const PRUNE_AFTER_MS: number;
export const DIGEST_MERGE_MAX: number;
export function watchesPath(opts?: { home?: string }): string;

export function addWatch(
  spec: { owner: string; team?: string; lane?: string; items: Array<{ kind: WatchKind; ref?: string }>; stallMin?: number; escalateMin?: number },
  opts?: { home?: string; now?: number },
): { id: string };
/** addWatch for the server process: waits for the lock without blocking the event loop. */
export function addWatchAsync(
  spec: { owner: string; team?: string; lane?: string; items: Array<{ kind: WatchKind; ref?: string }>; stallMin?: number; escalateMin?: number },
  opts?: { home?: string; now?: number },
): Promise<{ id: string }>;
export function listWatches(filter?: { owner?: string; team?: string; all?: boolean }, opts?: { home?: string }): Array<WatchSet & { status: "armed" | "fired" | "cancelled" }>;
export function cancelWatch(id: string, callerId: string, opts?: { home?: string; now?: number; allow?: (set: WatchSet) => boolean }): { ok: boolean; id: string; error?: string; already?: boolean; refused?: boolean };
export function reownWatches(spec: { from: string; to: string; ids?: string[]; reason?: string }, opts?: { home?: string; now?: number }): { reowned: string[] };
export function reownWatchesAsync(spec: { from: string; to: string; ids?: string[]; reason?: string }, opts?: { home?: string; now?: number }): Promise<{ reowned: string[] }>;
export function cancelWatchAsync(id: string, callerId: string, opts?: { home?: string; now?: number; allow?: (set: WatchSet) => boolean }): Promise<{ ok: boolean; id: string; error?: string; already?: boolean; refused?: boolean }>;

export function classifyItem(item: WatchItem, set: WatchSet, ctx: any): { phase: string; phaseSince?: string; state: WatchItemState; reason?: string; report?: string };
export function stepSet(set: WatchSet, ctx: any): WatchPing | null;
/** idea-352/idea-450: the finals detail text ("" when none) and the refs whose FULL final is delivered. */
export function finalsBlock(set: WatchSet): { text: string; refs: string[] };
/** idea-450: the finals detail with `skipRefs` omitted (already delivered to this recipient). */
export function finalsTextFor(set: WatchSet, skipRefs: string[]): string;

export interface WatchEngineOptions {
  home?: string;
  tmpdir?: string;
  now?: () => number;
  alive?: (pid: number) => boolean;
  getAgent?: (id: string) => Promise<any>;
  deliver?: (d: WatchDelivery) => Promise<void> | void;
  /** W4: spawn the merge worker for a too-long ping; truthy = spawned (the worker sends the merged digest). */
  spawnDigest?: (d: WatchDelivery) => Promise<boolean> | boolean;
  /** idea-160: send the worker its one idle nudge (the caller re-checks it is idle and live) */
  nudge?: (agentId: string, text: string) => Promise<void> | void;
  /** idea-171: the agent's final assistant message text ("" when none), for the activeAt-floor done check */
  lastMessage?: (id: string) => Promise<string> | string;
  log?: (msg: string) => void;
  retryMs?: number;
  /** B11a: true when the Squad is in an asleep folder; its pings and nudges wait (not marked attempted) until a wake. */
  asleep?: (team: string) => boolean;
}

export interface WatchEngine {
  file: string;
  reload(): { version: number; sets: WatchSet[] };
  start(): void;
  tick(): Promise<void>;
  onRunnerEvent(ev: any): void;
  onLogEntry(team: string, entry: { ts: string; agent: string; lane: string; type: string; text: string; refs: string[] }): string[];
  holdingSets(entry: any, setIds: string[]): Promise<WatchSet[]>;
  /** Resolves once attemptedAt is on disk (await it before the send); never rejects. */
  markAttempted(keys: string[], to: string): Promise<void>;
  /** idea-219: true when the ping's set was cancelled (fresh read). Checked right before a send. */
  isCancelled(key: string): boolean;
  markDelivered(keys: string[], to: string): Promise<void>;
  markFailed(keys: string[], error: string): Promise<void>;
  /** idea-418: adopt set `setId` from retired owner `from` for `to` (no-op unless `from` still owns it); never rejects. */
  reown(setId: string, from: string, to: string, reason?: string): Promise<{ reowned: string[] }>;
  get(id: string): WatchSet | null;
  list(): WatchSet[];
}

export function createWatchEngine(opts?: WatchEngineOptions): WatchEngine;
/** idea-883: an agent item's code-read verdict tag (`PASS|FAIL H/M/L <hash>`), or null. */
export function itemVerdict(item: WatchItem): string | null;
/** idea-883: the code-built verdict block (one line per finished agent item), "" when none finished. */
export function verdictBlock(set: WatchSet): string;
/** idea-883: masks verdict words in an LLM merge digest. */
export function maskVerdictWords(text: string): string;
