// Provider catalog wrappers (parity block P2). Kept out of paseo.ts on purpose.
// Runner lanes read /__vibesquad/providers* (server/providers-catalog.mjs); Paseo lanes still ask the daemon.
import { daemonClient } from "./paseo";

export type ProvidersAvailable = Awaited<ReturnType<typeof daemonClient.listAvailableProviders>>;
export type ProviderModelsPayload = Awaited<ReturnType<typeof daemonClient.listProviderModels>>;
export type ProviderModesPayload = Awaited<ReturnType<typeof daemonClient.listProviderModes>>;

const BASE = "/__vibesquad/providers";

async function catalogGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `providers ${res.status}`);
  return body as T;
}

/** Pass `runner: true` for runner-backed agents/lanes (id `rn-…`, or when the runner owns the lane). */
export const listAvailableProviders = (runner = false) =>
  runner ? catalogGet<ProvidersAvailable>("") : daemonClient.listAvailableProviders();
export const listProviderModels = (provider: string, runner = false) =>
  runner ? catalogGet<ProviderModelsPayload>(`/models?provider=${encodeURIComponent(provider)}`) : daemonClient.listProviderModels(provider);
export const listProviderModes = (provider: string, runner = false) =>
  runner ? catalogGet<ProviderModesPayload>(`/modes?provider=${encodeURIComponent(provider)}`) : daemonClient.listProviderModes(provider);

export interface RunnerProviderSettings {
  enabled?: boolean;
  models?: string[];
  modes?: string[];
  defaultModel?: string;
  defaultMode?: string;
}
export interface RunnerSettings { providers: Record<string, RunnerProviderSettings> }

export const loadRunnerSettings = () => catalogGet<{ ok: boolean; path: string; runner: RunnerSettings }>("/settings");
export async function saveRunnerSettings(runner: { providers: Record<string, RunnerProviderSettings | null> }) {
  const res = await fetch(`${BASE}/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runner }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `settings ${res.status}`);
  return (body as { runner: RunnerSettings }).runner;
}

export interface UsageTotals { turns: number; costUsd: number }
export interface RunnerUsage {
  note: string;
  files: number;
  totals: UsageTotals;
  byProvider: (UsageTotals & { provider: string })[];
  byModel: (UsageTotals & { model: string })[];
  byLane: (UsageTotals & { lane: string })[];
  byDay: (UsageTotals & { day: string })[];
}
export const loadRunnerUsage = () => catalogGet<RunnerUsage>("/usage");
