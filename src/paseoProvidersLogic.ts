// Pure helpers for the read-only Providers catalog (parity block P2). No imports.

export interface CatalogProvider { provider: string; available: boolean; error?: string | null }
export interface CatalogModel { id: string; label: string; description?: string; isDefault?: boolean; contextWindowMaxTokens?: number; thinkingOptions?: { id: string; label: string; isDefault?: boolean }[] }
export interface CatalogMode { id: string; label: string; description?: string }

/** Available providers first, then alphabetical; the daemon order is not stable. */
export function sortProviders<T extends CatalogProvider>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(b.available) - Number(a.available) || a.provider.localeCompare(b.provider));
}

export function providerState(p: CatalogProvider): { label: string; tone: "ok" | "warn" | "hot" } {
  if (p.available) return { label: "available", tone: "ok" };
  return p.error ? { label: "error", tone: "hot" } : { label: "unavailable", tone: "warn" };
}

export function formatContextWindow(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}

export function describeModel(m: CatalogModel): string {
  const parts = [formatContextWindow(m.contextWindowMaxTokens)];
  const n = m.thinkingOptions?.length ?? 0;
  if (n > 0) parts.push(`${n} thinking level${n === 1 ? "" : "s"}`);
  if (m.isDefault) parts.push("default");
  return parts.filter(Boolean).join(" · ");
}
