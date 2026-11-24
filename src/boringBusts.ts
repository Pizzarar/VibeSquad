/** Single source for Normal-mode mascot bust art: Art14 canon 64x64 exports (B13e, public/ui/busts/busts.json); light theme uses the -light variants. */
export type BustRole = "overlord" | "riffbot" | "bugs" | "buddy" | "lead" | "worker";

export const bustUrl = (role: BustRole, theme: "dark" | "light" = "dark"): string => `/ui/busts/${role}${theme === "light" ? "-light" : ""}.png`;

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** Map an agent's labels to its bust. Hub lane = Desk (Overlord lead / RiffBot brainstorm); bug lane = Bugs. */
export function bustRoleForAgent(agent?: { labels?: Record<string, string> } | null): BustRole {
  const labels = agent?.labels ?? {};
  const role = norm(labels.role);
  const lane = norm(labels.lane);
  if (lane === "bug-chaser" || lane === "_bugs") return "bugs";
  if (role === "lead" && (lane === "hub" || lane === "overlord" || lane === "_overlord")) return "overlord";
  if (role === "brainstorm" && (lane === "hub" || lane === "riffbot" || lane === "_riffbot")) return "riffbot";
  if (role === "brainstorm") return "buddy";
  if (role === "lead") return "lead";
  return "worker";
}
