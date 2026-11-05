// Pinned teams step 2 (docs/PLAN_PINNED_FEATURES.md §2): the focus view. The focused Team's
// Brainstorm is the real drawer in the middle (an ordinary panes.ts tab); every pin of the squad
// stays in a scrollable right rail in fixed pin order. Clicking a rail tile swaps it in. Needs-you is
// a badge and never reorders the rail. The bar on top of the drawer is the only route to the plumbing.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDraft, useDraft } from "./drafts";
import { NeedsBadge, PinDot, PinTeamTree, usePreview } from "./PinGrid";
import { exitPinFocus, type PinFocus } from "./pinFocus";
import { TopBreadcrumb } from "./Breadcrumb";
import { escGoesHome } from "./pinFocusLogic";
import { DEFAULT_PIN_PROFILE, getLastBrainstormProfile, setLastBrainstormProfile } from "./pinActions";
import { hubPinForSquad, isHubPin, pinsForSquad, type Pin } from "./pins";
import { SendToBar } from "./PinIdeas";
import { useProfiles } from "./profiles";
import { slotRef } from "./pinSlots";
import type { TeamView } from "./teams";
import { laneCodeFor } from "./identity";
import { Avatar, NeonEmblem } from "./pixel";
import { Spinner } from "./QuickWinsUi";

const SWAP_MS = 150;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function animate(el: Element | null | undefined, frames: Keyframe[]) {
  if (!el || reducedMotion() || typeof (el as HTMLElement).animate !== "function") return;
  (el as HTMLElement).animate(frames, { duration: SWAP_MS, easing: "ease-out" });
}

// ── Rail tile ────────────────────────────────────────────────────────────────
// Only the *other* Buddies are tiles; the focused one is the Active Buddy Card above them.
const RailTile = memo(function RailTile(props: { pin: Pin; onPick: (pin: Pin) => void }) {
  const { pin, onPick } = props;
  const bs = pin.brainstorm;
  const lines = usePreview(bs && bs.agent.status !== "closed" ? bs.agent.id : null);
  const [draft] = useDraft(bs ? `${bs.agent.id}:draft` : "pin-rail:none");
  const last = lines[lines.length - 1];
  return (
    <button
      type="button"
      className={`pin-rail-tile ${bs ? "" : "no-session"} ${pin.needsYou ? "needs-you" : ""}`}
      data-testid={`pin-rail-${pin.lane.id}`}
      title={bs ? `Open ${pin.lane.name}` : `${pin.lane.name}: no session · click to start a fresh Brainstorm`}
      onClick={() => onPick(pin)}
    >
      <Avatar id={bs ? bs.agent.id : `bs-empty-${pin.squad.id}-${pin.lane.id}`} provider={bs?.agent.provider ?? "claude"} agentType="brainstorm" size={28} />
      <span className="pin-rail-col">
        <span className="pin-rail-name">
          <PinDot pin={pin} />
          {pin.lane.name}
          {draft.trim() && (
            <span className="tab-draft" title="Unsent draft">
              ✎
            </span>
          )}
        </span>
        <span className="pin-rail-line muted small">
          {!bs ? "No session yet" : last ? `${last.who === "you" ? "you: " : ""}${last.text}` : "No messages yet"}
        </span>
      </span>
      <NeedsBadge pin={pin} />
    </button>
  );
});

export function PinRail({ view, focus, onPick }: { view: TeamView; focus: PinFocus; onPick: (pin: Pin) => void }) {
  const allPins = pinsForSquad(view);
  const { pinned } = allPins;
  const hubPin = hubPinForSquad(view);
  const active = pinned.find((p) => p.lane.id === focus.laneId) ?? allPins.done.find((p) => p.lane.id === focus.laneId) ?? (hubPin?.lane.id === focus.laneId ? hubPin : undefined);
  const others = pinned.filter((p) => p.lane.id !== focus.laneId);
  const bs = active?.brainstorm;
  return (
    <aside className="pin-rail" data-testid="pin-rail" aria-label={`${view.team.name} teams`}>
      <div className="pin-rail-head">
        <NeonEmblem color={view.team.color} seed={view.team.id} size={16} />
        <span className="pin-rail-squad">{view.team.name}</span>
        <span className="muted small">{pinned.length} teams</span>
      </div>
      <div className="pin-rail-scroll">
        <section className={`pin-rail-active-buddy ${active?.needsYou ? "needs-you" : ""}`} data-testid="pin-rail-active-buddy" aria-label="Active Buddy">
          <div className="pin-rail-active-head">
            {active && <PinDot pin={active} />}
            <span className="pin-rail-name">{active?.lane.name ?? focus.laneId}</span>
            {active && <NeedsBadge pin={active} />}
          </div>
          {active && focus.agentId && <SendToBar pin={active} />}
          {!focus.agentId && (
            <span className="muted small">{focus.gone ? "No active chat" : bs ? "Starting…" : "Starting a fresh Brainstorm…"}</span>
          )}
          {active && <PinTeamTree pin={active} />}
          {/* The focused drawer's DrawerHeader portals its inspector here (src/pinSlots.ts). */}
          <div className="pin-rail-active-inspector" ref={slotRef("card")} />
        </section>
        <div className="pin-rail-section-label" data-testid="pin-rail-others-label">
          Other Buddies
        </div>
        <div className="pin-rail-list">
          {others.map((p) => (
            <RailTile key={p.lane.id} pin={p} onPick={onPick} />
          ))}
          {others.length === 0 && <span className="muted small">No other Buddies pinned</span>}
        </div>
      </div>
    </aside>
  );
}

// ── Focus bar: replaces the tab strip above the focused drawer ───────────────
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT");

function PinFocusBar({ view, focus, onSelectSquad }: { view: TeamView; focus: PinFocus; onSelectSquad: (id: string) => void }) {
  const hubPin = hubPinForSquad(view);
  const pin = pinsForSquad(view).pinned.find((p) => p.lane.id === focus.laneId) ?? (hubPin?.lane.id === focus.laneId ? hubPin : undefined);
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

  const handle = "@" + ((pin?.lane.code || laneCodeFor(focus.laneId, [view.team]) || focus.laneId.slice(0, 3)).toLowerCase());
  return (
    <div className="pin-focus-bar" data-testid="pin-focus-bar">
      <button type="button" className="btn ghost small pin-focus-home" data-testid="pin-focus-home" title="Back to all teams (Esc)" onClick={exitPinFocus}>
        ⊞
      </button>
      <TopBreadcrumb squadsHome={false} squadId={view.team.id} squadName={view.team.name} laneName={pin?.lane.name ?? focus.laneId} hub={pin ? isHubPin(pin) : false} onSelectSquad={onSelectSquad} />
      <span className="pin-lane-handle" data-testid="pin-focus-handle">{handle}</span>
      {/* The focused drawer's DrawerHeader portals its compact controls here (src/pinSlots.ts). */}
      <div className="pin-focus-slot" ref={slotRef("bar")} />
      {!focus.agentId && <span className="pin-focus-name">{pin?.lane.name ?? focus.laneId}</span>}
    </div>
  );
}

/** Row 1 of the focused middle: the bar, plus the "Start fresh" panel when the Brainstorm is gone. */
export function PinFocusHeader(props: {
  view: TeamView;
  focus: PinFocus;
  onStart: (pin: Pin, profile?: string) => void;
  onSelectSquad: (id: string) => void;
  /** Rendered under the bar in the same row-1 grid cell (the hub bar). */
  belowBar?: ReactNode;
  spinUpError?: string | null;
}) {
  const { view, focus, onStart, onSelectSquad, belowBar } = props;
  const spinUpError = props.spinUpError ?? focus.spinUpError ?? null;
  const hubPin = hubPinForSquad(view);
  const allPins = pinsForSquad(view);
  const pin = allPins.pinned.find((p) => p.lane.id === focus.laneId) ?? allPins.done.find((p) => p.lane.id === focus.laneId) ?? (hubPin?.lane.id === focus.laneId ? hubPin : undefined);
  const { profiles } = useProfiles();
  const brainstormProfiles = useMemo(() => {
    const names = profiles.filter((p) => p.role === "brainstorm").map((p) => p.name);
    const list = names.length > 0 ? names : ["Brainstorm - Claude", "Brainstorm - Gemini"];
    const last = pin?.lane?.lastProfile?.trim();
    if (last && !list.includes(last)) return [...list, last];
    return list;
  }, [profiles, pin?.lane?.lastProfile]);
  const pinKey = `${focus.squadId}:${focus.laneId}`;
  const [selectedProfile, setSelectedProfile] = useState(
    () => pin?.lane?.lastProfile || getLastBrainstormProfile(DEFAULT_PIN_PROFILE),
  );
  useEffect(() => {
    setSelectedProfile(pin?.lane?.lastProfile || getLastBrainstormProfile(DEFAULT_PIN_PROFILE));
  }, [pinKey, pin?.lane?.lastProfile]);
  return (
    <>
      {belowBar ? (
        <div className="pin-focus-head">
          <PinFocusBar view={view} focus={focus} onSelectSquad={onSelectSquad} />
          {belowBar}
        </div>
      ) : (
        <PinFocusBar view={view} focus={focus} onSelectSquad={onSelectSquad} />
      )}
      {!focus.agentId && (
        <div className="pin-focus-empty" data-testid="pin-focus-empty">
          {spinUpError && (
            <div className="pin-focus-spinup-error" role="alert" data-testid="pin-spin-up-error">
              {spinUpError}
            </div>
          )}
          {focus.gone ? (
            <>
              <span className="muted">
                {pin && isHubPin(pin)
                  ? "RiffBot has no active chat yet. Click Spin Up when you want to start a session."
                  : `${pin?.lane.name ?? "This team"} has no active Brainstorm chat yet. Click Spin Up when you want to start a session from the brief.`}
              </span>
              {pin && (
                <>
                  <div className="pin-profile-chips" data-testid="pin-spin-up-profile-chips">
                    {brainstormProfiles.map((name) => {
                      const active = selectedProfile === name;
                      const shortName = name.replace(/^(?:Brainstorm)\s*-\s*/i, "") || name;
                      return (
                        <button
                          type="button"
                          key={name}
                          className={"idea-box-profile-chip" + (active ? " is-active" : "")}
                          aria-pressed={active}
                          data-testid={`pin-spin-up-profile-chip-${name}`}
                          onClick={() => {
                            setSelectedProfile(name);
                            setLastBrainstormProfile(name);
                            onStart(pin, name);
                          }}
                        >
                          {shortName}
                        </button>
                      );
                    })}
                  </div>
                  <button type="button" className="btn ok" data-testid="pin-start-fresh" onClick={() => onStart(pin, selectedProfile)}>
                    {isHubPin(pin) ? "Spin Up RiffBot" : "Spin Up Brainstorm"}
                  </button>
                </>
              )}
            </>
          ) : (
            <div className="pin-focus-spinning" data-testid="pin-focus-spinning">
              <Spinner
                label={
                  pin && isHubPin(pin)
                    ? `Spinning up RiffBot (${selectedProfile.replace(/^Brainstorm\s*-\s*/i, "")}) — booting session from brief…`
                    : `Spinning up ${pin?.lane.name ?? "Brainstorm"} (${selectedProfile.replace(/^Brainstorm\s*-\s*/i, "")}) from the brief…`
                }
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}
