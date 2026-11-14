// Provider catalog wrappers. Everything reads /__vibesquad/providers* (server/providers-catalog.mjs); no daemon.
import { cachedLoader } from "./cachedLoad";
import type { CatalogMode, CatalogModel, CatalogProvider } from "./paseoProvidersLogic";

export type ProvidersAvailable = { providers: CatalogProvider[] };
export type ProviderModelsPayload = { models: CatalogModel[]; error?: string | null };
export type ProviderModesPayload = { modes: CatalogMode[]; error?: string | null };

const BASE = "/__vibesquad/providers";

async function catalogGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `providers ${res.status}`);
  return body as T;
}

export const listAvailableProviders = () => catalogGet<ProvidersAvailable>("");
export const listProviderModels = (provider: string) => catalogGet<ProviderModelsPayload>(`/models?provider=${encodeURIComponent(provider)}`);
export const listProviderModes = (provider: string) => catalogGet<ProviderModesPayload>(`/modes?provider=${encodeURIComponent(provider)}`);

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
/** Shared by the sidebar poll, the runner-up refetch and the settings chip: one in-flight call, reused for 30s (idea-239). */
export const loadRunnerUsage: (force?: boolean) => Promise<RunnerUsage> = cachedLoader(() => catalogGet<RunnerUsage>("/usage"), 30_000);
