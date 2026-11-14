// Generated "In flight (live)" block for a Buddy boot prompt (docs/PLAN_SPAWN_HYGIENE.md block 5).
import { homedir } from "node:os";
import { join } from "node:path";
import { linesFromEndSync } from "./log-tail.mjs";
import { BOOT_CONTEXT_BUDGET, MORE_WORKERS_HINT, bootRoster, fitRows } from "./boot-roster.mjs";

/** Last `n` non-metric team-log entries for a lane, oldest first. Missing/garbled log gives []. */
export function recentLaneLog({ teamId, laneId, n = 5, home }) {
  const base = home || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  const want = String(laneId ?? "").trim().toLowerCase();
  const out = [];
  if (!(n > 0)) return out;
  // A plain lane id appears verbatim (any case) in the raw JSON of every line that can match: skip JSON.parse for the
  // rest, so a lane with few entries does not parse the whole log (ids with JSON-escaped characters always parse).
  const plain = /^[a-z0-9._-]+$/.test(want);
  // Newest first from EOF (unit-loop-stall): stops reading once `n` lane entries are found, never the whole log.
  try {
    for (const line of linesFromEndSync(join(base, "teams", String(teamId), "log.jsonl"))) {
      if (plain && !line.toLowerCase().includes(want)) continue;
      try {
        const e = JSON.parse(line);
        if (String(e.lane ?? "").toLowerCase() === want && e.type !== "metric") out.push(e);
      } catch {}
      if (out.length >= n) break;
    }
  } catch {
    return [];
  }
  return out.reverse();
}

/** `agents` null means the live list could not be read. Capped at BOOT_CONTEXT_BUDGET chars (plan B2). */
export function liveInFlightBlock({ agents, laneId, teamId, home, budget = BOOT_CONTEXT_BUDGET }) {
  const head = "In flight (live, generated at boot; trust this over the hand-kept section in the brief):";
  const row = (a) => `${String(a.title || a.id).trim()} [${a.status || "?"}${a.updatedAt ? `, active ${a.updatedAt}` : ""}]`;
  const fixed = [];
  let workerRows = [];
  if (agents == null) {
    fixed.push("- Live agents: unavailable (could not read the daemon). Run `vs who all` before saying what is running.");
  } else {
    const { lead, workers } = bootRoster(agents, laneId);
    fixed.push(`- Lead: ${lead ? row(lead) : "none running"}`);
    workerRows = workers.map(row);
  }
  const log = recentLaneLog({ teamId, laneId, home });
  const logRows = log.map((e) => `  - ${e.ts} ${e.agent} ${e.type}: ${String(e.text).slice(0, 240)}`);
  const logHead = log.length ? "- Latest lane log:" : "- Latest lane log: (no entries)";
  // Fill order: header + lead, running workers, then the newest lane log lines, then `+N more`.
  let room = budget - head.length - fixed.join("\n").length - 2 - logHead.length - 1 - 80;
  // Workers ride inline on one line ("- Workers: a [running]; b [queued]; +N more → vs who all"), cut to the budget.
  const wLabel = workerRows.length ? "- Workers: " : "- Workers: none running";
  // Reserve room for the log first (up to half of what is left), so a long worker list never starves it.
  const logNeed = logRows.reduce((n, r) => n + r.length + 1, 0);
  const logReserve = Math.min(logNeed, Math.floor(room / 2));
  const w = fitRows(workerRows.map((r) => `${r}; `), Math.max(0, room - logReserve - wLabel.length));
  room -= w.used + wLabel.length;
  const l = fitRows([...logRows].reverse(), Math.max(0, room));
  const out = [head, ...fixed];
  if (agents != null) {
    out.push(workerRows.length ? `${wLabel}${w.kept.join("").replace(/; $/, "")}${w.dropped ? `; +${w.dropped} more ${MORE_WORKERS_HINT}` : ""}` : wLabel);
  }
  if (!log.length || l.kept.length) out.push(logHead, ...l.kept.reverse());
  return out.join("\n");
}
