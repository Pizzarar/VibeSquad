import { daemonClient, DEMO } from "./paseo";
import { type UsageReportLike } from "./paseoOpsLogic";

export interface DaemonReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export async function fetchDaemonConfig(): Promise<unknown> {
  if (DEMO) return { mcp: { injectIntoAgents: true }, relay: { enabled: false, token: "demo-secret" }, cors: { allowedOrigins: ["http://localhost:5173"] } };
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
