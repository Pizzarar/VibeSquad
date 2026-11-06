// Pinned teams step 3: the pin's ⋯ menu (docs/PLAN_PINNED_FEATURES.md §3).
// Edit brief · Rename · Show plumbing · Mark complete (step 5, src/PinDone.tsx) · Remove team… (src/PinRemove.tsx).
import { useEffect, useRef, useState } from "react";
import type { Pin } from "./pins";
import { openBriefEditor, renamePin } from "./pinActions";
import { MarkCompleteButton } from "./PinDone";
import { RemoveTeamDialog } from "./PinRemove";

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

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
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
      {open && (
        <div className="pin-menu-list" role="menu">
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
              <button type="submit" className="btn ok small" disabled={!name.trim()}>
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
                  else openBriefEditor({ squadId: pin.squad.id, laneId: pin.lane.id, laneName: pin.lane.name });
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
        </div>
      )}
      {removing && <RemoveTeamDialog pin={pin} onClose={() => setRemoving(false)} />}
    </div>
  );
}
