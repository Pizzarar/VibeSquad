// C2 (PLAN_CRUNCH_MODE): live wake on a per-Squad vibeMode toggle. Rides the teams save handler (POST /__vibesquad/teams):
// diff old vs new vibeMode per Squad. OFF->ON: every live Buddy and Lead of that Squad gets the Crunch rules + "Pick your lean
// and go". ON->OFF: the same agents get "Crunch mode is OFF: back to asking before scope calls.". Idle agents get a normal
// prompt (runner.sendAgentPrompt); busy agents (the BUSY set) get a steer (steerOnly, as token-watch.mjs sendLeadNotice).
// Asleep Squads (asleepTeamIds) are skipped; unchanged and other Squads get nothing. No new endpoint or verb. Never throws out
// of onTeamsSave: errors are caught and logged so a toggle never fails or delays the save. All I/O is injected for tests.

import { appendVsLogEntry } from "./brainstorm.mjs";
import { BUSY, effectiveAgentRole, isLiveAgent } from "./idle-lane-kick.mjs";
import { asleepTeamIds, readTeamsConfig } from "./identity.mjs";
import { CRUNCH_MODE_RULES } from "./hooks/agent-duties.ts";

export const CRUNCH_ON_MESSAGE = `${CRUNCH_MODE_RULES}\n\nPick your lean and go`;
export const CRUNCH_OFF_MESSAGE = "Crunch mode is OFF: back to asking before scope calls.";

/** Squads whose vibeMode flipped between two teams arrays -> [{ teamId, from, to }]. Unchanged/absent Squads yield nothing. */
export function vibeModeChanges(prevTeams = [], nextTeams = []) {
  const prev = new Map();
  for (const t of Array.isArray(prevTeams) ? prevTeams : []) {
    if (t && typeof t.id === "string") prev.set(String(t.id).toLowerCase(), t.vibeMode === true);
  }
  const out = [];
  for (const t of Array.isArray(nextTeams) ? nextTeams : []) {
    if (!t || typeof t.id !== "string") continue;
    const id = String(t.id).toLowerCase();
    const to = t.vibeMode === true;
    const from = prev.get(id) ?? false;
    if (from !== to) out.push({ teamId: t.id, from, to });
  }
  return out;
}

/** Wake/steer live Buddies + Leads on a vibeMode flip. All I/O injected (listAgents, send, log, asleepTeams) so tests use fakes. */
export function createCrunchToggle({
  rootDir,
  listAgents = async () => [],
  send = async () => {},
  asleepTeams = () => asleepTeamIds(readTeamsConfig(rootDir)),
  log = ({ teamId, laneId, text }) => appendVsLogEntry({ teamId, laneId, agent: "vibesquad-server", type: "metric", text }),
} = {}) {
  async function onTeamsSave(prevTeams, nextTeams) {
    try {
      const changes = vibeModeChanges(prevTeams, nextTeams);
      if (!changes.length) return;
      const asleep = asleepTeams() ?? new Set();
      const roster = ((await listAgents()) ?? []).filter((a) => a && isLiveAgent(a));
      const byTeam = new Map(); // lowercased team id -> [{ agent, role, laneId }]
      for (const a of roster) {
        const role = effectiveAgentRole(a);
        if (role !== "lead" && role !== "brainstorm") continue; // workers get nothing
        const team = String(a?.labels?.team ?? "").trim().toLowerCase();
        if (!team) continue;
        if (!byTeam.has(team)) byTeam.set(team, []);
        byTeam.get(team).push({ agent: a, role, laneId: String(a?.labels?.lane ?? "").trim() });
      }
      for (const ch of changes) {
        const team = String(ch.teamId).toLowerCase();
        if (asleep.has(team)) continue; // asleep Squads get nothing
        const members = byTeam.get(team) ?? [];
        for (const m of members) {
          const busy = BUSY.has(String(m.agent.status ?? "").toLowerCase());
          const text = ch.to ? CRUNCH_ON_MESSAGE : CRUNCH_OFF_MESSAGE;
          await send(m.agent.id, text, busy ? { steerOnly: true } : {});
          log({
            teamId: ch.teamId,
            laneId: m.laneId,
            text: `crunch-${ch.to ? "on" : "off"} team=${ch.teamId} lane=${m.laneId} agent=${m.agent.id} role=${m.role}${busy ? " steer" : ""}`,
          });
        }
      }
    } catch (e) {
      console.warn(`[vibesquad] crunch-toggle: ${e?.message ?? e}`);
    }
  }
  return { onTeamsSave };
}
