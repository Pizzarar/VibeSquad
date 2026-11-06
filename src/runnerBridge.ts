// Runner lanes in the UI (docs/PLAN_OWN_DAEMON.md Block 3). The browser only speaks the Paseo websocket, so agents
// owned by the VS runner come through /__vibesquad/runner/*. Everything here is inert unless a lane is switched:
// the first status probe answers enabled:false and nothing else ever runs.
import type { PaseoAgent } from "@getpaseo/client";

export const isRunnerId = (id: string | undefined | null): boolean => typeof id === "string" && id.startsWith("rn-");

const BASE = "/__vibesquad/runner";
const POLL_MS = 2000;

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

export const runnerSend = (id: string, text: string) => post(id, "input", { text }).then(() => undefined);
export const runnerCancel = (id: string) => post(id, "cancel").then(() => undefined);
export const runnerArchive = (id: string) => post(id, "archive").then(() => ({ archivedAt: new Date().toISOString() }));
export const runnerUpdate = (id: string, updates: { name?: string; labels?: Record<string, string> }) => post(id, "meta", updates).then(() => undefined);

let enabledLanes: Set<string> | null = null;
/** True when `lane` runs on the runner (known after the first bridge probe). */
export const isRunnerLane = (lane: string | undefined): boolean => !!lane && !!enabledLanes?.has(lane.toLowerCase());

export async function runnerSpawn(payload: unknown): Promise<PaseoAgent> {
  return (await call<{ agent: PaseoAgent }>("/spawn", { method: "POST", body: JSON.stringify(payload) })).agent;
}

type TimelineResult = { entries: unknown[]; hasOlder?: boolean; startCursor?: unknown };

/** Stands in for client.agents.ref(id) in Timeline.tsx: refetch over HTTP, subscribe by polling the seq. */
export function runnerHandle(id: string) {
  const refetch = async (opts: { limit?: number } = {}): Promise<TimelineResult> => call<TimelineResult>(`/agents/${id}/timeline?limit=${opts.limit ?? 60}`);
  return {
    timeline: {
      refetch,
      subscribe(cb: (ev: { event: { type: string } }) => void) {
        let last = -1;
        const t = setInterval(async () => {
          try {
            const r = await refetch({ limit: 1 });
            const seq = (r.entries.at(-1) as { seqEnd?: number } | undefined)?.seqEnd ?? -1;
            if (seq !== last) {
              if (last !== -1) cb({ event: { type: "runner-changed" } });
              last = seq;
            }
          } catch {
            /* runner restarting: next tick */
          }
        }, POLL_MS);
        return () => clearInterval(t);
      },
    },
  };
}

export const runnerFetchTimeline = (id: string, opts: { limit?: number; cursor?: { seq: number }; direction?: string }) => {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 60) });
  return call<TimelineResult>(`/agents/${id}/timeline?${q}`);
};

/** Poll the runner roster into the store. `apply` gets the full runner set each time (it drops agents that vanished). */
export function startRunnerBridge(apply: (agents: PaseoAgent[]) => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    try {
      const r = await call<{ enabled: boolean; agents?: PaseoAgent[] }>("/agents");
      if (!r.enabled) return; // nothing switched: stop for this page load
      apply(r.agents ?? []);
    } catch {
      /* server restarting */
    }
    timer = setTimeout(tick, POLL_MS);
  };
  call<{ enabled: boolean; lanes: string[] }>("/status")
    .then((s) => {
      if (!s.enabled) return;
      enabledLanes = new Set(s.lanes);
      tick();
    })
    .catch(() => {});
  void timer;
}
