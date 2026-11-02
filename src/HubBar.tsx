// Block 4 of docs/PLAN_HUB_BUDDY.md: the RiffBot bar under the title bar. One button opens the Squad's
// hub Buddy (or starts a fresh one from its brief), same as a pin click.
import "./HubBar.css";
import { useEffect, useRef, useState } from "react";
import { pinsForSquad, type Pin } from "./pins";
import { isHubLane, type TeamView } from "./teams";
import { Avatar } from "./pixel";
import { PinDot } from "./PinGrid";
import { countUnsplit } from "./hubBarLogic";

const REFETCH_MIN_MS = 10_000;

/** Unsplit count from the brief. Refetches when `refreshKey` changes, at most once per 10s per lane. */
function useUnsplit(laneId: string, refreshKey: string): number | null {
  const [n, setN] = useState<number | null>(null);
  const last = useRef({ laneId: "", at: 0 });
  useEffect(() => {
    const sameLane = last.current.laneId === laneId;
    if (!sameLane) setN(null);
    if (!laneId) return;
    const wait = sameLane ? Math.max(0, last.current.at + REFETCH_MIN_MS - Date.now()) : 0;
    let cancelled = false;
    const t = setTimeout(() => {
      last.current = { laneId, at: Date.now() };
      fetch(`/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(laneId)}`)
        .then((r) => r.json())
        .then((b: { ok?: boolean; content?: string }) => !cancelled && setN(b.ok ? countUnsplit(String(b.content ?? "")) : null))
        .catch(() => !cancelled && setN(null));
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [laneId, refreshKey]);
  return n;
}

export function HubBar({ view, onOpen }: { view: TeamView | undefined; onOpen: (pin: Pin) => void | Promise<unknown> }) {
  const hubLane = view?.team.lanes.find((l) => isHubLane(view.team, l));
  const pins = view ? pinsForSquad(view) : undefined;
  const pin = hubLane ? pins?.pinned.concat(pins.done).find((p) => p.lane.id === hubLane.id) : undefined;
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
