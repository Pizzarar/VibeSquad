/** Single source for Normal-mode mascot bust art: Art14 canon 64x64 exports (B13e, public/ui/busts/busts.json); light theme uses the -light variants. */
import { BUG_LANE_FALLBACK_IDS, isHubLaneId } from "./teams";

export type BustRole = "overlord" | "riffbot" | "bugs" | "buddy" | "lead" | "worker";

export const bustUrl = (role: BustRole, theme: "dark" | "light" = "dark"): string => `/ui/busts/${role}${theme === "light" ? "-light" : ""}.png`;

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** Hub lane ids that map to the Desk (Overlord lead / RiffBot brainstorm), regardless of what the registry says. */
const HUB_LANE_IDS = new Set(["hub", "overlord", "_overlord", "riffbot", "_riffbot"]);

/** Map an agent's labels to its bust. Hub lane = Desk (Overlord lead / RiffBot brainstorm); bug lane = Bugs. */
export function bustRoleForAgent(agent?: { labels?: Record<string, string> } | null): BustRole {
  const labels = agent?.labels ?? {};
  const role = norm(labels.role);
  const lane = norm(labels.lane);
  if (lane === "_bugs" || BUG_LANE_FALLBACK_IDS.includes(lane)) return "bugs";
  const hub = HUB_LANE_IDS.has(lane) || isHubLaneId(lane);
  if (hub) {
    if (role === "lead") return "overlord";
    if (role === "brainstorm") return "riffbot";
  }
  if (role === "brainstorm") return "buddy";
  if (role === "lead") return "lead";
  return "worker";
}
