// Block B3 of docs/PLAN_BUG_RUNNER.md: the Bug Runner button at the right end of a Squad's sidebar row (before the ⋯).
// Shows the bug lane's open inbox count: red while items are newer than the last open, grey after, one short pulse on arrival.
import "./BugButton.css";
import { useEffect, useRef, useState } from "react";
import { bugRoachSheetSrc, pinsForSquad, snapChipSize, type Pin } from "./pins";
import { useDpr, useImageOk, useTheme } from "./useBotFace";
import { useUiScale } from "./uiScale";
import { findBugLane, type TeamView } from "./teams";
import { bugCounts, type BugCard } from "./hubBarLogic";

const BUG_POLL_MS = 15_000;
const seenKey = (teamId: string) => `vs.bugSeen.${teamId}`;
const readSeen = (teamId: string): number => {
  try {
    return Number(localStorage.getItem(seenKey(teamId))) || 0;
  } catch {
    return 0;
  }
};

/** Open (parked) bug-lane cards. `cards` is null until the first fetch for this (team, lane) lands. */
function useBugCards(teamId: string, laneId: string) {
  const [state, setState] = useState<{ key: string; cards: BugCard[] } | null>(null);
  useEffect(() => {
    if (!laneId) return;
    const key = `${teamId}/${laneId}`;
    setState(null);
    let cancelled = false;
    const load = () =>
      fetch(`/__vibesquad/inbox?lane=${encodeURIComponent(laneId)}&status=parked`)
        .then((r) => r.json())
        .then((b: { cards?: BugCard[] }) => !cancelled && setState({ key, cards: Array.isArray(b.cards) ? b.cards : [] }))
        .catch(() => {});
    void load();
    const t = setInterval(load, BUG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [teamId, laneId]);
  return state && state.key === `${teamId}/${laneId}` ? state.cards : null;
}

export function BugButton({ view, onOpen }: { view: TeamView; onOpen: (pin: Pin) => void | Promise<unknown> }) {
  const lane = findBugLane(view.team);
  const all = pinsForSquad(view, { includeHidden: true });
  const pin = lane ? [...all.pinned, ...all.done].find((p) => p.lane.id === lane.id) ?? null : null;
  const teamId = view.team.id;
  const theme = useTheme();
  const { device, css } = snapChipSize(useDpr(), useUiScale());
  const sheet = bugRoachSheetSrc(theme, device);
  const roachOk = useImageOk(sheet);
  const cards = useBugCards(teamId, pin?.lane.id ?? "");
  const [seen, setSeen] = useState(() => readSeen(teamId));
  const [pulse, setPulse] = useState(false);
  const prevMax = useRef<number | null>(null);
  useEffect(() => {
    setSeen(readSeen(teamId));
    prevMax.current = null;
  }, [teamId, pin?.lane.id]);
  const counts = cards && pin ? bugCounts(cards, pin.lane.id, seen) : { total: 0, unseen: 0, max: 0 };
  useEffect(() => {
    if (!cards) return;
    // Baseline is the first completed fetch; after that a pulse fires only when a newer card id appears while some are unseen.
    const prev = prevMax.current;
    prevMax.current = counts.max;
    if (prev === null || counts.max <= prev || counts.unseen === 0) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [cards, counts.max, counts.unseen]);
  if (!pin) return null;
  const markSeen = () => {
    if (!cards) return;
    const next = Math.max(seen, counts.max);
    try {
      localStorage.setItem(seenKey(teamId), String(next));
    } catch {
      /* private mode: stays per-session */
    }
    setSeen(next);
  };
  return (
    <button
      type="button"
      className={`bug-btn${counts.unseen > 0 ? " has-new" : ""}${pulse ? " pulse" : ""}`}
      data-testid={`bug-btn-${teamId}`}
      title={counts.total ? `Bug Runner: ${counts.total} open (${counts.unseen} new)` : "Bug Runner: nothing open. Click to report a bug"}
      aria-label={`Bug Runner, ${counts.total} open, ${counts.unseen} new`}
      onClick={() => {
        markSeen();
        void Promise.resolve(onOpen(pin)).catch((e) => alert(`Could not start Bug Runner: ${e}`));
      }}
    >
      <span
        className="bug-btn-roach"
        data-testid={`bug-roach-${teamId}`}
        aria-hidden="true"
        style={{ backgroundImage: roachOk ? `url(${sheet})` : undefined, width: css, height: css }}
      />
      <span className="bug-btn-n">{counts.total}</span>
    </button>
  );
}
