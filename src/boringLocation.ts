import { isHubLane, type LaneDef, type TeamDef } from "./teams.ts";

const ACRONYMS = new Set(["ui", "ux", "ade", "api", "cli", "ci", "cd", "qa", "ai", "mcp", "sdk", "url", "db", "css", "html", "id", "pr", "vs", "ide", "os", "tts", "gpu", "cpu", "efi"]);
/** Normal-mode lane name: keeps known acronyms upper-case ("Ui Lab" → "UI Lab"). */
export function boringLaneLabel(name: string | null | undefined): string {
  return String(name ?? "").replace(/[A-Za-z]+/g, (w) => (ACRONYMS.has(w.toLowerCase()) && (w === w.toLowerCase() || w === w[0].toUpperCase() + w.slice(1).toLowerCase()) ? w.toUpperCase() : w));
}

const humanizeSlug = (k: string) => (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(k) ? k.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : k);

/**
 * The one lane display name (R4-2): the hub, a lane named after the project (id === team id, as the sidebar folds into the Desk)
 * and no lane at all read "Desk"; a registered lane reads its registered name; an unregistered/dynamic lane reads its id
 * ("main-game" → "Main Game"). A Buddy topic is never the name (see laneTopic). "Desk" is reserved for the hub (R4-5): a registered
 * lane that collides reads "Desk lane".
 */
export function boringLocationLane(team: { id: string; lanes?: Pick<LaneDef, "id" | "name" | "hub" | "code">[] }, laneKey: string | null | undefined, extraLanes: Pick<LaneDef, "id" | "name" | "hub" | "dynamic">[] = []): string {
  const key = (laneKey ?? "").trim();
  if (!key || key.toLowerCase() === team.id.toLowerCase()) return "Desk";
  const lane = [...(team.lanes ?? []), ...extraLanes.filter((l) => !l.dynamic)].find((l) => l.id.toLowerCase() === key.toLowerCase());
  if (lane && isHubLane({ id: team.id, lanes: team.lanes ?? [] } as TeamDef, lane)) return "Desk";
  const name = boringLaneLabel(lane?.name ?? humanizeSlug(key));
  return name.trim().toLowerCase() === "desk" ? "Desk lane" : name;
}
export const laneDisplayName = boringLocationLane;

/** The one lane code (R4-2): the registered code, else the lane id. Used by the tree, Overview and header alike. */
export function laneCode(team: { lanes?: Pick<LaneDef, "id" | "code">[] }, laneKey: string | null | undefined): string {
  const key = (laneKey ?? "").trim();
  const lane = (team.lanes ?? []).find((l) => l.id.toLowerCase() === key.toLowerCase());
  const code = (lane?.code || key).replace(/^@/, "");
  return code ? `@${code}` : "";
}

/** A dynamic lane's Buddy topic as a secondary label ("Main Game · OpenRouter pipeline critique"); "" when none or the same as the name. */
export function laneTopicLabel(name: string, topic: string | null | undefined): string {
  const t = (topic ?? "").trim();
  return !t || t.toLowerCase() === name.toLowerCase() ? "" : `${name} · ${t}`;
}
