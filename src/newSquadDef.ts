// The TeamDef a new Squad is created with: its first lane is the Squad's hub (RiffBot's lane).
import {
  BRAINSTORM_RESTART_DEFAULT,
  BRAINSTORM_WARN_DEFAULT,
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  type TeamDef,
} from "./teams.ts";
import { allLaneIds, slugLaneId, uniqueLaneId, type PinLane } from "./pins.ts";
import { freezeLaneCodes } from "./identity.ts";

export function buildNewSquadTeamDef(opts: {
  id: string;
  name: string;
  folderPath: string;
  existingTeams: TeamDef[];
  lastProfile?: string;
}): TeamDef {
  const normalized = opts.folderPath.replace(/\.git$/, "").replace(/[/\\]+$/, "");
  const parts = normalized.replace(/\\/g, "/").split("/");
  const folderSegment = parts.filter(Boolean).pop() ?? opts.folderPath.trim();
  const taken = allLaneIds(opts.existingTeams);
  const laneId = uniqueLaneId(slugLaneId(opts.name.trim() || "new-team"), taken);
  const lane: PinLane = {
    id: laneId,
    name: opts.name.trim() || "New Squad",
    hub: true,
    state: "pinned",
    ...(opts.lastProfile ? { lastProfile: opts.lastProfile } : {}),
  };
  return {
    id: opts.id,
    name: opts.name.trim() || "New Squad",
    color: "#00f0ff",
    brainstormWarnTokens: BRAINSTORM_WARN_DEFAULT,
    brainstormRestartTokens: BRAINSTORM_RESTART_DEFAULT,
    leadFlagTokens: LEAD_FLAG_DEFAULT,
    leadAutoHandoffTokens: LEAD_AUTO_HANDOFF_DEFAULT,
    leadHardCapTokens: LEAD_HARD_CAP_DEFAULT,
    lanes: freezeLaneCodes([lane]),
    paths: [
      folderSegment || opts.folderPath.trim(),
      ...(/^([a-z]:|[\\/])/i.test(normalized) && normalized !== folderSegment ? [normalized] : []),
    ],
  };
}
