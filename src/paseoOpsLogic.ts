// Pure helpers for the Paseo ops panel (daemon config view, usage reports, latency). No imports.

export const REDACTED = "••• hidden";

// Allowlist of MutableDaemonConfig (@getpaseo/protocol) leaf paths that are clearly non-secret.
// "*" matches any record key or array index. Everything else (unknown keys the $loose schemas
// pass through, env maps, args, commands, free text) renders as REDACTED; key names stay visible.
const SHOWN_PATHS = [
  "relay.enabled", "relay.requireProtectedSecurity",
  "mcp.enabled", "mcp.injectIntoAgents",
  "hostnames", "hostnames.*",
  "cors.allowedOrigins.*",
  "trustedProxies", "trustedProxies.*",
  "git.maxProcessesPerSecond", "git.maxProcessConcurrency",
  "app.baseUrl",
  "catalogRefreshTimeoutMs",
  "browserTools.enabled",
  "providers.*.enabled", "providers.*.paseoTools.enabled", "providers.*.paseoTools.disabledTools.*",
  "providers.*.additionalModels.*.id", "providers.*.additionalModels.*.label", "providers.*.additionalModels.*.isDefault",
  "metadataGeneration.providers.*.provider", "metadataGeneration.providers.*.model", "metadataGeneration.providers.*.thinkingOptionId",
  "autoArchiveAfterMerge", "enableTerminalAgentHooks",
  "terminalProfiles.*.id", "terminalProfiles.*.name", "terminalProfiles.*.icon",
  "agentProfiles.*.id", "agentProfiles.*.name", "agentProfiles.*.icon", "agentProfiles.*.color",
  "agentProfiles.*.provider", "agentProfiles.*.model", "agentProfiles.*.modeId", "agentProfiles.*.thinkingOptionId",
  "skills.selection.mode", "skills.selection.skills.*",
  "pluginsEnabled", "plugins.*.source", "plugins.*.enabled",
].map((p) => p.split("."));

function pathShown(path: string[]): boolean {
  return SHOWN_PATHS.some((pat) => pat.length === path.length && pat.every((seg, i) => seg === "*" || seg === path[i]));
}

// Backstop for strings that are on the allowlist but still look like credentials.
const SECRET_VALUE =
  /sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|xox[abeoprs]-[A-Za-z0-9-]{6,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+\S+|\$2[abxy]?\$\d+\$[./A-Za-z0-9]{20,}|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

export function maskSecretValue(s: string): string {
  return SECRET_VALUE.test(s) ? REDACTED : s;
}

/** Deep copy of a daemon config showing only allowlisted leaves (booleans are always shown). */
export function redactConfig(value: unknown, path: string[] = []): unknown {
  if (path.length > 12) return "…";
  if (Array.isArray(value)) return value.map((v, i) => redactConfig(v, [...path, String(i)]));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactConfig(v, [...path, k]);
    return out;
  }
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return value;
  if (!pathShown(path)) return REDACTED;
  return typeof value === "string" ? maskSecretValue(value) : value;
}

/** Pretty JSON for non-config payloads (usage reports): shown as-is except credential-shaped strings. */
export function formatMaskedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "string" ? maskSecretValue(v) : v), 2);
}

export function formatConfigJson(config: unknown): string {
  return JSON.stringify(redactConfig(config), null, 2);
}

export function latencyTone(ms: number | null): "ok" | "warn" | "hot" | "none" {
  if (ms === null || !Number.isFinite(ms)) return "none";
  if (ms < 150) return "ok";
  if (ms < 500) return "warn";
  return "hot";
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export interface UsageReportLike {
  id: string;
  sourceLabel: string;
  account?: { label?: string };
  fetchedAt: string;
  report: {
    status: string;
    planLabel?: string;
    error?: string;
    problem?: { kind: string; detail?: string; expiresAt?: string; status?: number };
    windows?: { label: string; usedPct?: number | null; remainingPct?: number | null; resetsAt?: string | null }[];
  };
}

export interface UsageReportRow {
  id: string;
  title: string;
  status: string;
  summary: string;
  fetchedAt: string;
}

function pct(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)}%` : null;
}

export function summarizeUsageReport(entry: UsageReportLike): UsageReportRow {
  const acct = entry.account?.label ? ` · ${entry.account.label}` : "";
  const r = entry.report;
  let summary: string;
  if (r.status === "available") {
    const parts = (r.windows ?? []).map((w) => {
      const used = pct(w.usedPct);
      const left = pct(w.remainingPct);
      return `${w.label}: ${used ? `${used} used` : left ? `${left} left` : "n/a"}`;
    });
    summary = [r.planLabel, ...parts].filter(Boolean).join(" · ") || "available";
  } else if (r.status === "error") {
    summary = r.error ?? "error";
  } else {
    if (r.problem) {
      const extra = r.problem.detail ?? (r.problem.status ? `HTTP ${r.problem.status}` : r.problem.expiresAt);
      summary = `${r.problem.kind}${extra ? `: ${extra}` : ""}`;
    } else summary = r.status;
  }
  return { id: entry.id, title: `${entry.sourceLabel}${acct}`, status: r.status, summary, fetchedAt: entry.fetchedAt };
}
