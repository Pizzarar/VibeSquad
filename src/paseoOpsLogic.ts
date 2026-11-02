// Pure helpers for the Paseo ops panel (daemon config view, usage reports, latency). No imports.

const SECRET_KEY = /pass(word|wd)?|token|secret|api[-_]?key|private[-_]?key|credential|auth|bearer|(^|[-_])key$/i;
export const REDACTED = "••• redacted";

/** Deep copy of `value` with every secret-looking key's value replaced. */
export function redactConfig(value: unknown, depth = 0): unknown {
  if (depth > 12) return "…";
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== "" ? REDACTED : redactConfig(v, depth + 1);
    }
    return out;
  }
  return value;
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
    problem?: { kind: string; detail?: string };
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
    summary = r.problem ? `${r.problem.kind}${r.problem.detail ? `: ${r.problem.detail}` : ""}` : r.status;
  }
  return { id: entry.id, title: `${entry.sourceLabel}${acct}`, status: r.status, summary, fetchedAt: entry.fetchedAt };
}
