// Runner lanes in the UI (docs/PLAN_OWN_DAEMON.md Block 3). The browser only speaks the Paseo websocket, so agents
// owned by the VS runner come through /__vibesquad/runner/*. Everything here is inert unless a lane is switched:
// the first status probe answers enabled:false and nothing else ever runs.
import type { PaseoAgent } from "@getpaseo/client";

export const isRunnerId = (id: string | undefined | null): boolean => typeof id === "string" && id.startsWith("rn-");

const BASE = "/__vibesquad/runner";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `runner ${res.status}`);
  return body as T;
}

const post = (id: string, action: string, body: unknown = {}) => call<unknown>(`/agents/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });

export type RunnerSendOpts = { images?: Array<{ data: string; mimeType: string }>; activeTurnBehavior?: "steer" | "interrupt" };
/** Composer send. Images are base64 (claude: stream-json image blocks; ACP: image content blocks); 'interrupt' cancels the active turn first. */
export const runnerSend = (id: string, text: string, opts: RunnerSendOpts = {}) =>
  post(id, "input", {
    text,
    ...(opts.images?.length ? { images: opts.images } : {}),
    ...(opts.activeTurnBehavior === "interrupt" ? { activeTurnBehavior: "interrupt" } : {}),
  }).then(() => undefined);
export const runnerCancel = (id: string) => post(id, "cancel").then(() => undefined);
export const runnerArchive = (id: string) => post(id, "archive").then(() => ({ archivedAt: new Date().toISOString() }));
export const runnerUpdate = (id: string, updates: { name?: string; labels?: Record<string, string> }) => post(id, "meta", updates).then(() => undefined);

let enabledLanes: Set<string> | null = null;
/** True when `lane` runs on the runner (known after the first bridge probe). */
export const isRunnerLane = (lane: string | undefined): boolean => !!lane && !!enabledLanes?.has(lane.toLowerCase());

export async function runnerSpawn(payload: unknown): Promise<PaseoAgent> {
  return (await call<{ agent: PaseoAgent }>("/spawn", { method: "POST", body: JSON.stringify(payload) })).agent;
}

type TimelineResult = { entries: unknown[]; hasOlder?: boolean; startCursor?: unknown; lastSeq?: number };

const timelineListeners = new Map<string, Set<() => void>>();
const notifyTimeline = (id?: string) => {
  for (const [k, set] of timelineListeners) if (!id || k === id) for (const cb of [...set]) cb();
};

/** Stands in for client.agents.ref(id) in Timeline.tsx: refetch over HTTP, subscribe to the runner event stream (no polling). */
export function runnerHandle(id: string) {
  const refetch = async (opts: { limit?: number } = {}): Promise<TimelineResult> => call<TimelineResult>(`/agents/${id}/timeline?limit=${opts.limit ?? 60}`);
  return {
    timeline: {
      refetch,
      subscribe(cb: (ev: { event: { type: string } }) => void) {
        const fire = () => cb({ event: { type: "runner-changed" } });
        let set = timelineListeners.get(id);
        if (!set) timelineListeners.set(id, (set = new Set()));
        set.add(fire);
        return () => {
          set!.delete(fire);
          if (!set!.size) timelineListeners.delete(id);
        };
      },
    },
  };
}

export const runnerFetchTimeline = (id: string, opts: { limit?: number; cursor?: { seq: number }; direction?: string }) => {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 60) });
  if (opts.direction === "before" && opts.cursor) {
    q.set("direction", "before");
    q.set("cursor", String(opts.cursor.seq));
  }
  return call<TimelineResult>(`/agents/${id}/timeline?${q}`);
};

export type RunnerStreamEvent =
  | { kind: "roster"; agents: PaseoAgent[] }
  | { kind: "agent"; agent: PaseoAgent }
  | { kind: "remove"; agentId: string }
  | { kind: "status"; agentId: string; from: string; to: string }
  | { kind: "timeline"; agentId: string; seq: number; type: string }
  | { kind: "connected" | "disconnected" };

/** Pure reducer for the roster view of the stream. Returns the next roster, or null when the event does not change it. */
export function reduceRunnerRoster(roster: Map<string, PaseoAgent>, ev: RunnerStreamEvent): Map<string, PaseoAgent> | null {
  if (ev.kind === "roster") return new Map(ev.agents.map((a) => [a.id, a]));
  if (ev.kind === "agent") return new Map(roster).set(ev.agent.id, ev.agent);
  if (ev.kind === "remove" && roster.has(ev.agentId)) {
    const next = new Map(roster);
    next.delete(ev.agentId);
    return next;
  }
  return null;
}

/**
 * Mirror the runner roster into the store from the VS server's SSE stream (/__vibesquad/runner/events): no polling.
 * `apply` gets the full runner set on each change plus the ids a real archive event removed (agents that merely vanish from
 * a roster are dropped without being archived); `onConnection` reports the stream
 * itself, which is what makes state.conn "connected" without the Paseo websocket. EventSource reconnects on its own and
 * every reconnect starts with a fresh roster, which also tells open timelines to refetch.
 */
export function startRunnerBridge(apply: (agents: PaseoAgent[], archivedIds: string[]) => void, onConnection?: (connected: boolean) => void): void {
  call<{ enabled: boolean; lanes: string[] }>("/status")
    .then((s) => {
      if (!s.enabled || typeof EventSource === "undefined") return; // nothing switched: stay inert for this page load
      enabledLanes = new Set(s.lanes);
      let roster = new Map<string, PaseoAgent>();
      const es = new EventSource(`${BASE}/events`);
      es.onopen = () => onConnection?.(true);
      es.onerror = () => onConnection?.(false);
      es.onmessage = (m) => {
        let ev: RunnerStreamEvent;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        if (ev.kind === "timeline") return notifyTimeline(ev.agentId);
        // Runner unreachable: the server says "disconnected" instead of an (empty) roster, so keep every agent we have.
        if (ev.kind === "disconnected") return onConnection?.(false);
        if (ev.kind === "connected") return onConnection?.(true);
        const next = reduceRunnerRoster(roster, ev);
        if (!next) return;
        roster = next;
        apply([...roster.values()], ev.kind === "remove" ? [ev.agentId] : []);
        if (ev.kind === "roster") notifyTimeline();
      };
    })
    .catch(() => {});
}
