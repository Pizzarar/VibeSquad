import { daemonClient, DEMO } from "./paseo";
import { type UsageReportLike } from "./paseoOpsLogic";

export interface DaemonReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

let demoConfigPatch: Record<string, unknown> = {};

export async function fetchDaemonConfig(): Promise<unknown> {
  if (DEMO) return mergePatch({ autoArchiveAfterMerge: false, enableTerminalAgentHooks: false, browserTools: { enabled: false }, mcp: { injectIntoAgents: true }, relay: { enabled: false, token: "demo-secret" }, cors: { allowedOrigins: ["http://localhost:5173"] } }, demoConfigPatch);
  return (await daemonClient.getDaemonConfig()).config;
}

export async function reloadDaemonConfig(): Promise<DaemonReloadResult> {
  if (DEMO) return { appliedPaths: ["mcp"], restartRequiredPaths: [], overrideControlledPaths: [] };
  const r = await daemonClient.reloadDaemonConfig();
  return { appliedPaths: r.appliedPaths, restartRequiredPaths: r.restartRequiredPaths, overrideControlledPaths: r.overrideControlledPaths };
}

export async function fetchUsageReports(forceRefresh = false): Promise<UsageReportLike[]> {
  if (DEMO) {
    return [
      { id: "claude", sourceLabel: "Claude", account: { label: "demo" }, fetchedAt: new Date().toISOString(), report: { status: "available", planLabel: "Max", windows: [{ label: "5h", usedPct: 41 }, { label: "7d", usedPct: 12 }] } },
      { id: "codex", sourceLabel: "Codex", fetchedAt: new Date().toISOString(), report: { status: "error", error: "not signed in" } },
    ];
  }
  return (await daemonClient.listUsageReports({ forceRefresh })).reports;
}

export async function measureRtt(): Promise<number> {
  if (DEMO) return 12 + Math.random() * 6;
  return daemonClient.measureLatency({ timeoutMs: 5000 });
}

/** Apply a validated patch (see buildConfigPatch), then reload; returns the reload result and the fresh config. */
export async function patchAndReloadDaemonConfig(patch: Record<string, unknown>): Promise<{ reload: DaemonReloadResult; config: unknown }> {
  if (DEMO) {
    demoConfigPatch = mergePatch(demoConfigPatch, patch);
    return { reload: { appliedPaths: Object.keys(patch), restartRequiredPaths: [], overrideControlledPaths: [] }, config: await fetchDaemonConfig() };
  }
  // The patch response carries the config as saved; a getDaemonConfig right after reload can still return the pre-patch snapshot.
  const saved = await daemonClient.patchDaemonConfig(patch);
  const reload = await reloadDaemonConfig();
  return { reload, config: saved.config };
}

function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? mergePatch((out[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>) : v;
  }
  return out;
}
