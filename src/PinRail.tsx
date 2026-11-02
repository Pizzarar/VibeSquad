// Pinned teams step 2 (docs/PLAN_PINNED_FEATURES.md §2): the focus view. The focused Team's
// Brainstorm is the real drawer in the middle (an ordinary panes.ts tab); every pin of the squad
// stays in a scrollable right rail in fixed pin order. Clicking a rail tile swaps it in. Needs-you is
// a badge and never reorders the rail. The bar on top of the drawer is the only route to the plumbing.
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { getDraft, useDraft } from "./drafts";
import { NeedsBadge, PinDot, setFullView, usePreview } from "./PinGrid";
import { exitPinFocus, type PinFocus } from "./pinFocus";
import { TopBreadcrumb } from "./Breadcrumb";
import { escGoesHome } from "./pinFocusLogic";
import { isHubPin, pinsForSquad, type Pin } from "./pins";
import { SendToBar } from "./PinIdeas";
import { openAgent } from "./panes";
import type { TeamView } from "./teams";
import { Avatar, NeonEmblem } from "./pixel";

const SWAP_MS = 150;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function animate(el: Element | null | undefined, frames: Keyframe[]) {
  if (!el || reducedMotion() || typeof (el as HTMLElement).animate !== "function") return;
  (el as HTMLElement).animate(frames, { duration: SWAP_MS, easing: "ease-out" });
}

const statusWord = (status: string) => (status === "running" || status === "error" ? status : "idle");

// ── Rail tile ────────────────────────────────────────────────────────────────
const RailTile = memo(function RailTile(props: { pin: Pin; focused: boolean; gone: boolean; onPick: (pin: Pin) => void }) {
  const { pin, focused, gone, onPick } = props;
  const bs = pin.brainstorm;
  // The focused tile is inert while its Brainstorm is in the middle; once that Brainstorm is gone it
  // is the one-click fresh start.
  const clickable = !focused || gone;
  const lines = usePreview(bs?.agent.id ?? null);
  const [draft] = useDraft(bs ? `${bs.agent.id}:draft` : "pin-rail:none");
  const last = lines[lines.length - 1];
  const ref = useRef<HTMLButtonElement>(null);
  const wasFocused = useRef(focused);
  // The Brainstorm that just left the middle shrinks back into its rail slot.
  useLayoutEffect(() => {
    if (wasFocused.current && !focused)
      animate(ref.current, [
        { transform: "scale(1.06)", opacity: 0.5 },
        { transform: "scale(1)", opacity: 1 },
      ]);
    wasFocused.current = focused;
  }, [focused]);
  return (
    <button
      ref={ref}
      type="button"
      className={`pin-rail-tile ${focused ? "on" : ""} ${clickable ? "" : "inert"} ${bs ? "" : "no-session"} ${pin.needsYou ? "needs-you" : ""}`}
      data-testid={`pin-rail-${pin.lane.id}`}
      aria-current={focused ? "true" : undefined}
      title={
        focused && !gone ? `${pin.lane.name} is open` : bs ? `Open ${pin.lane.name}` : `${pin.lane.name}: no session · click to start a fresh Brainstorm`
      }
      onClick={() => clickable && onPick(pin)}
    >
      <Avatar id={bs ? bs.agent.id : `bs-empty-${pin.squad.id}-${pin.lane.id}`} provider={bs?.agent.provider ?? "claude"} agentType="brainstorm" size={28} />
      <span className="pin-rail-col">
        <span className="pin-rail-name">
          <PinDot pin={pin} />
          {pin.lane.name}
          {draft.trim() && !focused && (
            <span className="tab-draft" title="Unsent draft">
              ✎
            </span>
          )}
        </span>
        <span className="pin-rail-line muted small">
          {focused && gone ? "Start fresh Brainstorm" : focused ? (bs ? "Open in the middle" : "Starting…") : !bs ? "No session yet" : last ? `${last.who === "you" ? "you: " : ""}${last.text}` : "No messages yet"}
        </span>
      </span>
      <NeedsBadge pin={pin} />
    </button>
  );
});

export function PinRail({ view, focus, onPick }: { view: TeamView; focus: PinFocus; onPick: (pin: Pin) => void }) {
  const { pinned } = pinsForSquad(view);
  return (
    <aside className="pin-rail" data-testid="pin-rail" aria-label={`${view.team.name} teams`}>
      <div className="pin-rail-head">
        <NeonEmblem color={view.team.color} seed={view.team.id} size={16} />
        <span className="pin-rail-squad">{view.team.name}</span>
        <span className="muted small">{pinned.length} teams</span>
      </div>
      <div className="pin-rail-list">
        {pinned.map((p) => (
          <RailTile key={p.lane.id} pin={p} focused={p.lane.id === focus.laneId} gone={focus.gone} onPick={onPick} />
        ))}
      </div>
    </aside>
  );
}

// ── Focus bar: replaces the tab strip above the focused drawer ───────────────
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT");

function PinFocusBar({ view, focus, onSelectSquad }: { view: TeamView; focus: PinFocus; onSelectSquad: (id: string) => void }) {
  const pin = pinsForSquad(view).pinned.find((p) => p.lane.id === focus.laneId);
  const agentIdRef = useRef(focus.agentId);
  agentIdRef.current = focus.agentId;

  // Esc with an empty composer (or from anywhere that isn't a filled-in field) goes back to the grid.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inComposer = !!t?.closest(".composer");
      const id = agentIdRef.current;
      // A half-written message in the focused drawer keeps you there, wherever keyboard focus is.
      const draft = (id ? getDraft(`${id}:draft`) : "") + (inComposer && isTyping(t) ? ((t as HTMLTextAreaElement).value ?? "") : "");
      const home = escGoesHome({
        inModal: !!document.querySelector(".modal-back, [role='dialog']"),
        inPerm: !!t?.closest(".perm"),
        target: isTyping(t) ? (inComposer ? "composer" : "field") : "none",
        draft,
      });
      if (home) {
        e.preventDefault(); // the squad page's own Esc handler must not climb a second level
        exitPinFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The Brainstorm coming in expands into the middle.
  useLayoutEffect(() => {
    if (!focus.agentId) return;
    animate(document.querySelector(`.agent-panes .pane-slot[data-agent="${CSS.escape(focus.agentId)}"]`), [
      { transform: "translateX(24px) scale(0.98)", opacity: 0.4 },
      { transform: "none", opacity: 1 },
    ]);
  }, [focus.agentId, focus.seq]);

  const lead = pin?.lead ?? null;
  const workers = pin?.workers.length ?? 0;
  const showPlumbing = () => {
    setFullView(true);
    if (lead) openAgent(lead.agent.id);
  };
  return (
    <div className="pin-focus-bar" data-testid="pin-focus-bar">
      <button type="button" className="btn ghost small pin-focus-home" data-testid="pin-focus-home" title="Back to all teams (Esc)" onClick={exitPinFocus}>
        ⊞
      </button>
      <TopBreadcrumb squadsHome={false} squadId={view.team.id} squadName={view.team.name} laneName={pin?.lane.name ?? focus.laneId} hub={pin ? isHubPin(pin) : false} onSelectSquad={onSelectSquad} />
      <span className="pin-focus-name">{pin?.lane.name ?? focus.laneId}</span>
      <span className="muted small pin-focus-squad">{view.team.name}</span>
      {pin && focus.agentId && <SendToBar pin={pin} />}
      <span className="pin-focus-spacer" />
      <button
        type="button"
        className="pin-focus-plumbing small"
        data-testid="pin-focus-plumbing"
        title="Show this team's lead, workers, handoffs and worktrees (FULL view)"
        onClick={showPlumbing}
      >
        Lead: {lead ? statusWord(lead.agent.status) : "none"} · {workers} {workers === 1 ? "worker" : "workers"} ▸
      </button>
    </div>
  );
}

/** Row 1 of the focused middle: the bar, plus the "Start fresh" panel when the Brainstorm is gone. */
export function PinFocusHeader(props: { view: TeamView; focus: PinFocus; onStart: (pin: Pin) => void; onSelectSquad: (id: string) => void }) {
  const { view, focus, onStart, onSelectSquad } = props;
  const pin = pinsForSquad(view).pinned.find((p) => p.lane.id === focus.laneId);
  return (
    <>
      <PinFocusBar view={view} focus={focus} onSelectSquad={onSelectSquad} />
      {!focus.agentId && (
        <div className="pin-focus-empty" data-testid="pin-focus-empty">
          {focus.gone ? (
            <>
              <span className="muted">{pin?.lane.name ?? "This team"}'s Brainstorm has ended. The brief keeps what was decided.</span>
              {pin && (
                <button type="button" className="btn ok" data-testid="pin-start-fresh" onClick={() => onStart(pin)}>
                  Start fresh Brainstorm
                </button>
              )}
            </>
          ) : (
            <span className="muted">Starting a fresh Brainstorm from the brief…</span>
          )}
        </div>
      )}
    </>
  );
}
