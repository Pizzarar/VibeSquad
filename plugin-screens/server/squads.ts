import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { Squad, readSquads, screensGate } from "../shared/squads";

type Output = RpcOutput<typeof readSquads>;
type Gate = PluginSettings<(typeof screensGate)["schema"]>;

// Loopback skips VS's device-token check (server/auth.mjs isLocal / isLocalBrowserSafe).
// Fixed URL: the plugin never fetches a caller-supplied path.
const port = Number(process.env.VIBESQUAD_PORT || 4180);
const TEAMS_URL = `http://127.0.0.1:${port}/__vibesquad/teams`;

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

// Only the fields the Squads screen needs: no thresholds, briefs, profiles or settings.
function pick(raw: any): Squad | null {
  if (!raw || typeof raw.id !== "string") return null;
  const lanes = Array.isArray(raw.lanes) ? raw.lanes : [];
  return {
    id: raw.id,
    name: str(raw.name) ?? raw.id,
    color: str(raw.color),
    paths: strings(raw.paths) ?? [],
    lanes: lanes
      .filter((l: any) => l && typeof l.id === "string")
      .map((l: any) => ({
        id: l.id,
        name: str(l.name) ?? l.id,
        code: str(l.code),
        state: str(l.state),
        paths: strings(l.paths),
        aliases: strings(l.aliases),
      })),
  };
}

export function makeReadSquads(gate: Gate) {
  return async (): Promise<Output> => {
    const settings = await gate.read();
    if (settings.status !== "ready" || !settings.values.enabled) return { status: "off" };
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5000);
      const res = await fetch(TEAMS_URL, { signal: abort.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) return { status: "error", error: `VibeSquad server answered ${res.status}` };
      const body = (await res.json()) as { teams?: unknown[] };
      const teams = (body.teams ?? []).map(pick).filter((t): t is Squad => t !== null);
      return { status: "ready", teams };
    } catch {
      return { status: "error", error: `VibeSquad server unreachable on 127.0.0.1:${port}` };
    }
  };
}
