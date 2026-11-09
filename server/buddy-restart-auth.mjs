// O5: who may restart a lane's Buddy through `vs buddy restart` / the restart_buddy tool (docs/PLAN_OVERLORD_OPS_ROUTING.md).
// Shared by the tool layer and the /__vibesquad/brainstorm-restart route so a direct HTTP call carrying a callerId is re-checked.
// Grants (nothing else): (1) the owner (no callerId, handled by callers), (2) that lane's own live lead,
// (3) the Squad's hub lead (Overlord) for any lane in the SAME Squad. Identity is always the caller's runner record, never env or args.
import { effectiveAgentRole, findLaneInRegistry, findTeamInRegistry, isHubLane, isRetiredAgent } from "./identity.mjs";

const clean = (v) => String(v ?? "").trim();

export const isLiveAgentRecord = (a) => Boolean(a) && !a.archivedAt && !isRetiredAgent(a) && !(a.status === "closed" && a.resumable !== true);

/** Throws a 403-tagged Error unless `caller` (a runner record) may restart `target`'s Buddy. Returns the grant that applied. */
export function assertBuddyRestartAllowed(caller, target, teams) {
  const forbid = (why) => Object.assign(new Error(`buddy restart: forbidden: ${why}`), { status: 403 });
  if (!caller) throw forbid("caller not found");
  if (effectiveAgentRole(caller) !== "lead" || !isLiveAgentRecord(caller)) throw forbid("only a live lead (or the owner) may restart a Buddy");
  const callerLane = findLaneInRegistry(clean(caller.labels?.lane || caller.labels?.lead), teams);
  const callerTeam = findTeamInRegistry(clean(caller.labels?.team), teams);
  if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) throw forbid("caller team/lane is not in the team registry");
  const targetLane = findLaneInRegistry(clean(target?.labels?.lane || target?.labels?.lead), teams);
  const targetTeam = findTeamInRegistry(clean(target?.labels?.team), teams);
  if (!targetLane || !targetTeam || targetLane.team.id !== targetTeam.id) throw forbid("target Buddy team/lane is not in the team registry");
  if (targetTeam.id !== callerTeam.id) throw forbid("target lane is in another Squad");
  if (targetLane.lane.id === callerLane.lane.id) return "lane-lead";
  if (isHubLane(callerTeam, callerLane.lane)) return "overlord";
  throw forbid("a lead may only restart its own lane's Buddy (the Squad's Overlord may restart any lane in its Squad)");
}
