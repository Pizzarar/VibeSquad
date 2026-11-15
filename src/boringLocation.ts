import { isHubLane, type LaneDef, type TeamDef } from "./teams.ts";

const ACRONYMS = new Set(["ui", "ux", "ade", "api", "cli", "ci", "cd", "qa", "ai", "mcp", "sdk", "url", "db", "css", "html", "id", "pr", "vs", "ide", "os", "tts", "gpu", "cpu", "efi"]);
/** Normal-mode lane name: keeps known acronyms upper-case ("Ui Lab" → "UI Lab"). */
export function boringLaneLabel(name: string | null | undefined): string {
  return String(name ?? "").replace(/[A-Za-z]+/g, (w) => (ACRONYMS.has(w.toLowerCase()) && (w === w.toLowerCase() || w === w[0].toUpperCase() + w.slice(1).toLowerCase()) ? w.toUpperCase() : w));
}

/**
 * The lane half of a "Project › Lane" location. The hub, a lane named after the project (id === team id, as the sidebar folds
 * into the Desk) and no lane at all all read "Desk"; any other lane reads its registered name via boringLaneLabel (a raw slug as the last resort).
 */
export function boringLocationLane(team: Pick<TeamDef, "id" | "lanes">, laneKey: string | null | undefined, extraLanes: Pick<LaneDef, "id" | "name" | "hub">[] = []): string {
  const key = (laneKey ?? "").trim();
  if (!key || key.toLowerCase() === team.id.toLowerCase()) return "Desk";
  const lane = [...team.lanes, ...extraLanes].find((l) => l.id.toLowerCase() === key.toLowerCase());
  if (lane && isHubLane(team, lane)) return "Desk";
  return boringLaneLabel(lane?.name ?? key);
}
