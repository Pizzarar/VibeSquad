export type SpawnReason = "ladder" | "override" | "arm" | "failover" | "legacy-name" | "all-capped";
export const SPAWN_REASON: Readonly<{
  LADDER: "ladder";
  OVERRIDE: "override";
  ARM: "arm";
  FAILOVER: "failover";
  LEGACY_NAME: "legacy-name";
  ALL_CAPPED: "all-capped";
}>;
export const SPAWN_REASONS: readonly SpawnReason[];
export const LEGACY_SPAWN_REASONS: Readonly<Record<string, SpawnReason>>;
export const ROUTE_WHY_KEY: "why";
export function shownSpawnReason(f?: {
  hookReason?: string;
  failover?: boolean;
  override?: boolean;
  allCapped?: boolean;
  arm?: boolean;
  legacyName?: boolean;
  routed?: boolean;
}): SpawnReason;
export function routeWhy(routeText: unknown): SpawnReason | "";
export function spawnShownLine(p: { role?: unknown; model?: unknown; reason?: unknown }): string;
