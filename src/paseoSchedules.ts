// Schedule CRUD + inspect wrappers (Parity block E). Heartbeats are schedules whose target is
// { type: "self" }: the daemon has no separate heartbeat RPC, so they share these calls.
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

export const createSchedule = async (req: unknown) => unwrap(await call("scheduleCreate", req)).schedule;
export const updateSchedule = async (req: unknown) => unwrap(await call("scheduleUpdate", req)).schedule;
export const deleteSchedule = async (id: string) => unwrap(await call("scheduleDelete", { id }));
export const inspectSchedule = async (id: string) => unwrap(await call("scheduleInspect", { id })).schedule;
