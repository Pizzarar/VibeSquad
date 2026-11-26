export type SpawnReason = "ladder" | "override" | "arm" | "failover" | "soft" | "legacy-name" | "all-capped";
export const SPAWN_REASON: Readonly<{
  LADDER: "ladder";
  OVERRIDE: "override";
  ARM: "arm";
  FAILOVER: "failover";
  SOFT: "soft";
  LEGACY_NAME: "legacy-name";
  ALL_CAPPED: "all-capped";
}>;
export const SPAWN_REASONS: readonly SpawnReason[];
export const LEGACY_SPAWN_REASONS: Readonly<Record<string, SpawnReason>>;
export const ROUTE_WHY_KEY: "why";
export function shownSpawnReason(f?: {
  hookReason?: string;
  soft?: boolean;
  failover?: boolean;
  override?: boolean;
  allCapped?: boolean;
  arm?: boolean;
  legacyName?: boolean;
  routed?: boolean;
}): SpawnReason;
export function routeWhy(routeText: unknown): SpawnReason | "";
export function routeSoftReason(routeText: unknown): string;
export function spawnShownLine(p: { role?: unknown; model?: unknown; reason?: unknown }): string;

export const PROVIDER_DISPLAY_NAME: Record<string, string>;
export function formatSoftReason(raw: string, opts?: { family?: string }): string;
