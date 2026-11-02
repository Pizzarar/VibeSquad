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

// ---- Daemon config editing (allowlisted, non-secret, low-risk fields only) ----

export type ConfigFieldSpec =
  | { path: string; label: string; help: string; kind: "boolean"; fallback: boolean }
  | { path: string; label: string; help: string; kind: "enum"; options: string[]; fallback: string }
  | { path: string; label: string; help: string; kind: "number"; min: number; max: number; fallback: number }
  | { path: string; label: string; help: string; kind: "string"; maxLength: number; fallback: string };

// Only paths the 0.14 MutableDaemonConfigPatch schema accepts AND that are harmless to flip at runtime.
export const EDITABLE_CONFIG_FIELDS: ConfigFieldSpec[] = [
  { path: "autoArchiveAfterMerge", label: "Auto-archive after merge", help: "Archive a workspace's agents once its branch is merged.", kind: "boolean", fallback: false },
  { path: "enableTerminalAgentHooks", label: "Terminal agent hooks", help: "Let terminal-run agents report status back to the daemon.", kind: "boolean", fallback: false },
  { path: "idleRuntimeCleanup", label: "Idle runtime cleanup", help: "Free runtime resources of idle agents.", kind: "boolean", fallback: false },
  { path: "browserTools.enabled", label: "Browser tools", help: "Expose the daemon's browser automation tools to agents.", kind: "boolean", fallback: false },
];

// Shown read-only with "change via Paseo CLI": security or connectivity critical.
export const LOCKED_CONFIG_SECTIONS: { path: string; label: string }[] = [
  { path: "auth / password", label: "Daemon password" },
  { path: "relay", label: "Relay settings" },
  { path: "listen / host / port", label: "Listen address and port" },
  { path: "hostnames", label: "Allowed hostnames" },
  { path: "cors.allowedOrigins", label: "CORS / allowed origins" },
  { path: "trustedProxies", label: "Trusted proxies" },
  { path: "plugins", label: "Plugin install sources" },
  { path: "providers.*.env / args / command", label: "Provider env, args and commands" },
  { path: "mcp", label: "MCP" },
];
export const LOCKED_NOTE = "change via Paseo CLI";

export function isEditableConfigPath(path: string): boolean {
  return EDITABLE_CONFIG_FIELDS.some((f) => f.path === path);
}

export function readConfigPath(config: unknown, path: string): unknown {
  let cur: unknown = config;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export type FieldValidation = { ok: true; value: boolean | string | number } | { ok: false; error: string };

export function validateFieldValue(field: ConfigFieldSpec, raw: unknown): FieldValidation {
  switch (field.kind) {
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, error: "must be on or off" };
    case "enum":
      return typeof raw === "string" && field.options.includes(raw) ? { ok: true, value: raw } : { ok: false, error: `must be one of ${field.options.join(", ")}` };
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isInteger(n)) return { ok: false, error: "must be a whole number" };
      if (n < field.min || n > field.max) return { ok: false, error: `must be between ${field.min} and ${field.max}` };
      return { ok: true, value: n };
    }
    case "string":
      if (typeof raw !== "string") return { ok: false, error: "must be text" };
      if (raw.length > field.maxLength) return { ok: false, error: `at most ${field.maxLength} characters` };
      if (SECRET_VALUE.test(raw)) return { ok: false, error: "looks like a credential" };
      return { ok: true, value: raw };
  }
}

export interface ConfigDiffEntry {
  path: string;
  label: string;
  from: unknown;
  to: unknown;
}

/** Entries for editable fields whose draft value differs from the current one. Unknown paths are ignored. */
export function buildConfigDiff(config: unknown, draft: Record<string, unknown>): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  for (const f of EDITABLE_CONFIG_FIELDS) {
    if (!(f.path in draft)) continue;
    const v = validateFieldValue(f, draft[f.path]);
    if (!v.ok) continue;
    const cur = readConfigPath(config, f.path);
    if (cur === v.value || (cur === undefined && v.value === f.fallback)) continue;
    out.push({ path: f.path, label: f.label, from: cur === undefined ? f.fallback : cur, to: v.value });
  }
  return out;
}

/** Nested patch object ({ browserTools: { enabled } }) for the diff entries; non-editable paths are dropped. */
export function buildConfigPatch(diff: ConfigDiffEntry[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const d of diff) {
    if (!isEditableConfigPath(d.path)) continue;
    const segs = d.path.split(".");
    let cur = patch;
    for (const s of segs.slice(0, -1)) cur = (cur[s] ??= {}) as Record<string, unknown>;
    cur[segs[segs.length - 1]] = d.to;
  }
  return patch;
}

export function formatDiffValue(v: unknown): string {
  return typeof v === "boolean" ? (v ? "on" : "off") : String(v);
}
