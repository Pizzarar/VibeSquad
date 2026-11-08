// Block 4 of docs/PLAN_HUB_BUDDY.md: the RiffBot bar under the title bar. One button opens the Squad's
// hub Buddy (or starts a fresh one from its brief), same as a pin click.
import "./HubBar.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hubPinForSquad, pinsForSquad, type Pin } from "./pins";
import { isPinStarting, subscribePinStarts } from "./pinActions";
import type { TeamView } from "./teams";
import { Avatar } from "./pixel";
import { PinDot } from "./PinGrid";
import { bugCounts, countUnsplit, resolveBugLane, type BugCard } from "./hubBarLogic";

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

const BUG_POLL_MS = 15_000;
const seenKey = (teamId: string) => `vs.bugSeen.${teamId}`;
const readSeen = (teamId: string): number => {
  try {
    return Number(localStorage.getItem(seenKey(teamId))) || 0;
  } catch {
    return 0;
  }
};

/** Bug Runner inbox count for the Squad's bug lane (parked cards), plus how many are newer than the last open. */
function useBugCount(teamId: string, laneId: string | null) {
  const [cards, setCards] = useState<BugCard[]>([]);
  const [seen, setSeen] = useState(() => readSeen(teamId));
  const [pulse, setPulse] = useState(false);
  const prevUnseen = useRef<number | null>(null);
  useEffect(() => {
    setSeen(readSeen(teamId));
    prevUnseen.current = null;
    if (!laneId) return;
    let cancelled = false;
    const load = () =>
      fetch(`/__vibesquad/inbox?lane=${encodeURIComponent(laneId)}&status=parked`)
        .then((r) => r.json())
        .then((b: { cards?: BugCard[] }) => !cancelled && setCards(Array.isArray(b.cards) ? b.cards : []))
        .catch(() => {});
    void load();
    const t = setInterval(load, BUG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [teamId, laneId]);
  const counts = laneId ? bugCounts(cards, laneId, seen) : { total: 0, unseen: 0, max: 0 };
  useEffect(() => {
    // One pulse when a new item arrives after the first load; never on mount.
    const prev = prevUnseen.current;
    prevUnseen.current = counts.unseen;
    if (prev === null || counts.unseen <= prev) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [counts.unseen]);
  const markSeen = () => {
    try {
      localStorage.setItem(seenKey(teamId), String(counts.max));
    } catch {
      /* private mode: stays per-session */
    }
    setSeen(counts.max);
  };
  return { ...counts, pulse, markSeen };
}

export function HubBar({ view, onOpen }: { view: TeamView | undefined; onOpen: (pin: Pin) => void | Promise<unknown> }) {
  const hub = view ? hubPinForSquad(view) : null;
  const starting = useSyncExternalStore(subscribePinStarts, () => (hub ? isPinStarting(hub) : false));
  const unsplit = useUnsplit(hub?.lane.id ?? "", hub?.brainstorm?.agent.updatedAt ?? "");
  const bugPin = view ? (() => { const { pinned, done } = pinsForSquad(view); const id = resolveBugLane([...pinned, ...done].map((p) => p.lane)); return [...pinned, ...done].find((p) => p.lane.id === id) ?? null; })() : null;
  const bug = useBugCount(view?.team.id ?? "", bugPin?.lane.id ?? null);
  if (!view || !hub) return null;
  const label = starting ? "Starting RiffBot…" : hub.brainstorm ? "Talk to RiffBot" : "Open RiffBot";
  return (
    <div className="hub-bar" data-testid="hub-bar">
      <Avatar id={hub.brainstorm?.agent.id ?? `bs-empty-${view.team.id}-${hub.lane.id}`} provider={hub.brainstorm?.agent.provider ?? "claude"} agentType="brainstorm" size={32} />
      <PinDot pin={hub} />
      <button type="button" className="hub-bar-btn" data-testid="hub-bar-btn" disabled={starting} title={hub.brainstorm ? "Riff on the whole Squad" : "Select RiffBot · click Spin Up inside to start a chat"} onClick={() => void Promise.resolve(onOpen(hub)).catch((e) => alert(`Could not start RiffBot: ${e}`))}>
        <span className="hub-bar-short">Riff</span>
        <span className="hub-bar-long">{label}</span>
      </button>
      {unsplit !== null && unsplit > 0 && (
        <span className="hub-bar-badge" data-testid="hub-bar-unsplit" title="Threads with no Team yet (from the brief)">
          {unsplit} unsplit
        </span>
      )}
      {bugPin && (
        <button
          type="button"
          className={`hub-bar-bug${bug.unseen > 0 ? " has-new" : ""}${bug.pulse ? " pulse" : ""}`}
          data-testid="hub-bar-bug"
          title={bug.total ? `Bug Runner: ${bug.total} open (${bug.unseen} new)` : "Bug Runner: nothing open. Click to report a bug"}
          aria-label={`Bug Runner, ${bug.total} open, ${bug.unseen} new`}
          onClick={() => {
            bug.markSeen();
            void Promise.resolve(onOpen(bugPin)).catch((e) => alert(`Could not start Bug Runner: ${e}`));
          }}
        >
          <span aria-hidden="true">🐞</span>
          <span className="hub-bar-bug-n">{bug.total}</span>
        </button>
      )}
    </div>
  );
}
