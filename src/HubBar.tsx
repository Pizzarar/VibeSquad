// Block 4 of docs/PLAN_HUB_BUDDY.md: the RiffBot bar under the title bar. One button opens the Squad's
// hub Buddy (or starts a fresh one from its brief), same as a pin click.
import "./HubBar.css";
import { useEffect, useState } from "react";
import { pinsForSquad, type Pin } from "./pins";
import type { LaneDef, TeamDef } from "./teams";
import type { TeamView } from "./teams";
import { Avatar } from "./pixel";
import { PinDot } from "./PinGrid";

// TODO: import from teams.ts after block 1
export const isHubLane = (team: TeamDef, lane: LaneDef): boolean => {
  const flagged = team.lanes.some((l) => (l as LaneDef & { hub?: boolean }).hub === true);
  return (lane as LaneDef & { hub?: boolean }).hub === true || (!flagged && lane.id === team.id);
};

/** Count the bullets under `## Unsplit threads` (a lone "none" bullet counts as 0). */
export function countUnsplit(brief: string): number {
  const lines = brief.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Unsplit threads\s*$/i.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^\s*[-*]\s+(.*\S)/.exec(l);
    if (m && !/^(none|n\/a|-)\.?$/i.test(m[1].replace(/[*_`]/g, "").trim())) n++;
  }
  return n;
}

function useUnsplit(laneId: string, refreshKey: string): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(laneId)}`)
      .then((r) => r.json())
      .then((b: { ok?: boolean; content?: string }) => !cancelled && setN(b.ok ? countUnsplit(String(b.content ?? "")) : null))
      .catch(() => !cancelled && setN(null));
    return () => {
      cancelled = true;
    };
  }, [laneId, refreshKey]);
  return n;
}

export function HubBar({ view, onOpen }: { view: TeamView | undefined; onOpen: (pin: Pin) => void | Promise<unknown> }) {
  const hubLane = view?.team.lanes.find((l) => isHubLane(view.team, l));
  const pin = view && hubLane ? pinsForSquad(view).pinned.concat(pinsForSquad(view).done).find((p) => p.lane.id === hubLane.id) : undefined;
  const unsplit = useUnsplit(hubLane?.id ?? "", pin?.brainstorm?.agent.updatedAt ?? "");
  if (!view || !hubLane || !pin) return null;
  const label = pin.brainstorm ? "Talk to RiffBot" : "Start RiffBot";
  return (
    <div className="hub-bar" data-testid="hub-bar">
      <Avatar id={pin.brainstorm?.agent.id ?? `bs-empty-${view.team.id}-${hubLane.id}`} provider={pin.brainstorm?.agent.provider ?? "claude"} agentType="brainstorm" size={24} />
      <PinDot pin={pin} />
      <button type="button" className="hub-bar-btn" data-testid="hub-bar-btn" title={pin.brainstorm ? "Riff on the whole Squad" : "No session yet · click to start"} onClick={() => void Promise.resolve(onOpen(pin)).catch((e) => alert(`Could not start RiffBot: ${e}`))}>
        <span className="hub-bar-short">Riff</span>
        <span className="hub-bar-long">{label}</span>
      </button>
      {unsplit !== null && unsplit > 0 && (
        <span className="hub-bar-badge" data-testid="hub-bar-unsplit" title="Threads with no Team yet (from the brief)">
          {unsplit} unsplit
        </span>
      )}
    </div>
  );
}
