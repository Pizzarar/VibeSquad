// Generated "In flight (live)" block for a Buddy boot prompt (docs/PLAN_SPAWN_HYGIENE.md block 5).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { effectiveAgentRole, isDigestAgent, isLiveAgent } from "./identity.mjs";

function laneOf(agent) {
  const l = agent?.labels ?? {};
  return String(l.lane || l.lead || "").trim().toLowerCase();
}

/** Last `n` non-metric team-log entries for a lane, oldest first. Missing/garbled log gives []. */
export function recentLaneLog({ teamId, laneId, n = 5, home }) {
  const base = home || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  let lines = [];
  try {
    lines = readFileSync(join(base, "teams", String(teamId), "log.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const want = String(laneId ?? "").trim().toLowerCase();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (String(e.lane ?? "").toLowerCase() === want && e.type !== "metric") out.push(e);
    } catch {}
  }
  return out.reverse();
}

/** `agents` null means the live list could not be read. */
export function liveInFlightBlock({ agents, laneId, teamId, home }) {
  const out = ["In flight (live, generated at boot; trust this over the hand-kept section in the brief):"];
  if (agents == null) {
    out.push("- Live agents: unavailable (could not read the daemon). Run `vs who all` before saying what is running.");
  } else {
    const want = String(laneId ?? "").trim().toLowerCase();
    const live = agents
      .map((a) => a?.agent ?? a)
      .filter((a) => isLiveAgent(a) && !isDigestAgent(a))
      .filter((a) => laneOf(a) === want);
    const row = (a) => `${String(a.title || a.id).trim()} [${a.status || "?"}${a.updatedAt ? `, active ${a.updatedAt}` : ""}]`;
    const lead = live.filter((a) => effectiveAgentRole(a) === "lead").map(row);
    const workers = live.filter((a) => effectiveAgentRole(a) === "worker").map(row);
    out.push(`- Lead: ${lead.length ? lead.join("; ") : "none running"}`);
    out.push(`- Workers: ${workers.length ? workers.join("; ") : "none running"}`);
  }
  const log = recentLaneLog({ teamId, laneId, home });
  if (log.length) {
    out.push("- Latest lane log:");
    for (const e of log) out.push(`  - ${e.ts} ${e.agent} ${e.type}: ${String(e.text).slice(0, 240)}`);
  } else {
    out.push("- Latest lane log: (no entries)");
  }
  return out.join("\n");
}
