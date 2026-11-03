// Block 4 of docs/PLAN_HUB_BUDDY.md: the RiffBot bar under the title bar. One button opens the Squad's
// hub Buddy (or starts a fresh one from its brief), same as a pin click.
import "./HubBar.css";
import { useEffect, useRef, useState } from "react";
import { hubPinForSquad, type Pin } from "./pins";
import type { TeamView } from "./teams";
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
  const hub = view ? hubPinForSquad(view) : null;
  const unsplit = useUnsplit(hub?.lane.id ?? "", hub?.brainstorm?.agent.updatedAt ?? "");
  if (!view || !hub) return null;
  const label = hub.brainstorm ? "Talk to RiffBot" : "Start RiffBot";
  return (
    <div className="hub-bar" data-testid="hub-bar">
      <Avatar id={hub.brainstorm?.agent.id ?? `bs-empty-${view.team.id}-${hub.lane.id}`} provider={hub.brainstorm?.agent.provider ?? "claude"} agentType="brainstorm" size={24} />
      <PinDot pin={hub} />
      <button type="button" className="hub-bar-btn" data-testid="hub-bar-btn" title={hub.brainstorm ? "Riff on the whole Squad" : "No session yet · click to start"} onClick={() => void Promise.resolve(onOpen(hub)).catch((e) => alert(`Could not start RiffBot: ${e}`))}>
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
