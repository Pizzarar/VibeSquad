// Schedule CRUD + inspect wrappers (Parity block E). Heartbeats are schedules whose target is
// { type: "self" }: the daemon has no separate heartbeat RPC, so they share these calls.
// Runner lanes (rn-* agents, or new agents while the runner is enabled) use the VS native store at
// /__vibesquad/schedules; rows from that store carry backend: "vs" and keep routing there. Paseo schedules are untouched.
import { daemonClient } from "./paseo";

const call = (name: string, ...args: any[]): Promise<any> => {
  const fn = (daemonClient as any)[name];
  if (typeof fn !== "function") return Promise.reject(new Error(`daemon has no ${name}`));
  return fn.apply(daemonClient, args);
};

const unwrap = (r: any) => {
  if (r?.error) throw new Error(String(r.error));
  return r;
};

const BASE = "/__vibesquad/schedules";

async function vs<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `schedules ${res.status}`);
  return body as T;
}
const vsPost = (path: string, body: unknown = {}) => vs(path, { method: "POST", body: JSON.stringify(body) });

export const isVsSchedule = (s: any): boolean => s?.backend === "vs";

// Only a successful probe is cached; a failed one is retried after a short backoff instead of pinning "off" for the page's life.
let runnerOn: Promise<boolean> | null = null;
let runnerFailedAt = 0;
const runnerEnabled = (): Promise<boolean> => {
  if (runnerOn && (!runnerFailedAt || Date.now() - runnerFailedAt < 10_000)) return runnerOn;
  runnerFailedAt = 0;
  return (runnerOn = fetch("/__vibesquad/runner/status")
    .then((r) => {
      if (!r.ok) throw new Error(`runner status ${r.status}`);
      return r.json();
    })
    .then((b) => !!b?.enabled)
    .catch(() => {
      runnerFailedAt = Date.now();
      return false;
    }));
};

async function wantsVs(req: any): Promise<boolean> {
  const t = req?.target;
  if (t?.type === "new-agent") return runnerEnabled();
  return typeof t?.agentId === "string" && t.agentId.startsWith("rn-");
}

/** Paseo schedules plus the VS native ones (VS errors never hide the Paseo list). */
export async function listSchedules(): Promise<{ schedules: any[]; error?: string }> {
  let r: any = { schedules: [] };
  let error: string | undefined;
  try {
    r = await call("scheduleList");
    if (r?.error) error = String(r.error);
  } catch (e) {
    error = String((e as Error).message ?? e);
  }
  let own: any[] = [];
  try {
    own = (await vs<{ schedules: any[] }>("")).schedules ?? [];
  } catch {}
  if (own.length) error = undefined; // the runner side answered, Paseo being down is not fatal
  return { schedules: [...(r?.schedules ?? []), ...own], ...(error ? { error } : {}) };
}

export const createSchedule = async (req: any) =>
  (await wantsVs(req)) ? (await vsPost("", req)).schedule : unwrap(await call("scheduleCreate", req)).schedule;
export const updateSchedule = async (req: any, row?: any) =>
  isVsSchedule(row) ? (await vsPost(`/${req.id}/update`, req)).schedule : unwrap(await call("scheduleUpdate", req)).schedule;
export const deleteSchedule = async (id: string, row?: any) =>
  isVsSchedule(row) ? vs(`/${id}`, { method: "DELETE" }) : unwrap(await call("scheduleDelete", { id }));
export const inspectSchedule = async (id: string, row?: any) =>
  isVsSchedule(row) ? (await vs(`/${id}`)).schedule : unwrap(await call("scheduleInspect", { id })).schedule;

export async function scheduleAction(row: any, action: "pause" | "resume" | "run") {
  if (isVsSchedule(row)) return vsPost(`/${row.id}/${action === "run" ? "run-once" : action}`);
  const method = action === "pause" ? "schedulePause" : action === "resume" ? "scheduleResume" : "scheduleRunOnce";
  return call(method, { id: row.id });
}

export async function scheduleLogs(row: any): Promise<any> {
  return isVsSchedule(row) ? vs(`/${row.id}/logs`) : call("scheduleLogs", { id: row.id });
}
