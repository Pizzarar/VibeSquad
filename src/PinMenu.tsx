// Pinned teams step 3: the pin's ⋯ menu (docs/PLAN_PINNED_FEATURES.md §3).
// Edit brief · Rename · Show plumbing · Mark complete (step 5, src/PinDone.tsx) · Remove team… (src/PinRemove.tsx).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placePinMenu } from "./pinMenuPlace";
import { patchLane, type Pin } from "./pins";
import { saveTeams, type TeamsUpdater } from "./teams";
import { openBriefEditor, renamePin } from "./pinActions";
import { MarkCompleteButton } from "./PinDone";
import { RemoveTeamDialog } from "./PinRemove";

/** Flip a pin between disposable (`standing: false`) and permanent standing (`standing: true`) in teams.json. */
export async function togglePinStanding(
  pin: Pin,
  save: (update: TeamsUpdater) => Promise<unknown> = saveTeams,
): Promise<void> {
  const next = !pin.lane.standing;
  await save((cur) =>
    patchLane(cur, pin.squad.id, pin.lane.id, { standing: next }),
  );
}

type Props = {
  pin: Pin;
  /** Show the team's agents, workers and worktrees (FULL view for this team). */
  onShowPlumbing: (pin: Pin) => void;
  /** Defaults to opening the shared brief editor. */
  onEditBrief?: (pin: Pin) => void;
};

export function PinMenu({ pin, onShowPlumbing, onEditBrief }: Props) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [name, setName] = useState(pin.lane.name);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The list is portaled to <body> (the rail's overflow:hidden clipped it); place it from the ⋯ button, re-place after content changes (rename form).
  useLayoutEffect(() => {
    if (!open || !btn.current || !list.current) return;
    const el = list.current;
    const place = () => {
      if (!btn.current) return;
      const a = btn.current.getBoundingClientRect();
      const l = el.getBoundingClientRect();
      const next = placePinMenu(
        a,
        { w: l.width, h: l.height },
        { w: window.innerWidth, h: window.innerHeight },
      );
      setPos((cur) =>
        cur && cur.top === next.top && cur.left === next.left ? cur : next,
      );
    };
    place();
    // The list can change size while open (rename form, Mark complete idle -> armed/blocked).
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, renaming]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        root.current &&
        !root.current.contains(t) &&
        !(list.current && list.current.contains(t))
      )
        close();
    };
    const away2 = (e: Event) => {
      if (
        list.current &&
        e.target instanceof Node &&
        list.current.contains(e.target)
      )
        return; // scrolling inside the list itself
      close();
    };
    // Capture phase: the focus bar's Esc (PinRail.tsx) is a bubble-phase window listener that sends you home; an open menu eats the Esc first.
    // While renaming, the input's own Esc handler cancels the rename and stops the event, so leave it alone here.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || renaming) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", away2);
    window.addEventListener("scroll", away2, true);
    return () => {
      window.removeEventListener("resize", away2);
      window.removeEventListener("scroll", away2, true);
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open, renaming]);

  const close = () => {
    setOpen(false);
    setPos(null);
    setRenaming(false);
  };

  const commitRename = async () => {
    await renamePin(pin, name);
    close();
  };

  return (
    <div
      className="pin-menu"
      ref={root}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <button
        className="btn ghost small pin-menu-btn"
        ref={btn}
        aria-label={`${pin.lane.name} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`pin-menu-${pin.lane.id}`}
        onClick={() => {
          setName(pin.lane.name);
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div
            className="pin-menu-list"
            role="menu"
            ref={list}
            style={
              pos
                ? { top: pos.top, left: pos.left }
                : { top: 0, left: 0, visibility: "hidden" }
            }
          >
            {renaming ? (
              <form
                className="pin-menu-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void commitRename();
                }}
              >
                <input
                  autoFocus
                  value={name}
                  aria-label="Team name"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setRenaming(false);
                    }
                  }}
                />
                <button
                  type="submit"
                  className="btn ok small"
                  disabled={!name.trim()}
                >
                  Save
                </button>
              </form>
            ) : (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    if (onEditBrief) onEditBrief(pin);
                    else
                      openBriefEditor({
                        squadId: pin.squad.id,
                        laneId: pin.lane.id,
                        laneName: pin.lane.name,
                      });
                  }}
                >
                  Edit brief
                </button>
                <button role="menuitem" onClick={() => setRenaming(true)}>
                  Rename
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    onShowPlumbing(pin);
                  }}
                >
                  Show plumbing
                </button>
                <button
                  role="menuitem"
                  data-testid={`pin-standing-toggle-${pin.lane.id}`}
                  onClick={() => {
                    close();
                    void togglePinStanding(pin);
                  }}
                >
                  {pin.lane.standing
                    ? "Make disposable team"
                    : "Make standing team"}
                </button>
                <MarkCompleteButton pin={pin} role="menuitem" />
                <button
                  role="menuitem"
                  className="pin-remove-item"
                  data-testid={`pin-remove-item-${pin.lane.id}`}
                  onClick={() => {
                    close();
                    setRemoving(true);
                  }}
                >
                  Remove team…
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {removing && (
        <RemoveTeamDialog pin={pin} onClose={() => setRemoving(false)} />
      )}
    </div>
  );
}
