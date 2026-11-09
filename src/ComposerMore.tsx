// Slim composer (docs/PLAN_CHAT_ROOM.md C4): the rarer controls live behind a semi-transparent ◂ tab on the composer edge.
// Portaled to <body>, fixed + viewport-clamped (PLAN_RAIL_MENU_CLIP M1, same placement as the pin ⋯ menu).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placePinMenuZoomed, rootZoom } from "./pinMenuPlace";

export type ComposerMoreItem = {
  key: string;
  label: ReactNode;
  title?: string;
  testid?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onSelect: () => void;
};

export function ComposerMore({ items }: { items: ComposerMoreItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tab = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) tab.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !tab.current || !list.current) return;
    const a = tab.current.getBoundingClientRect();
    const l = list.current.getBoundingClientRect();
    // The root carries the UI-scale zoom (html { zoom }): rects are viewport px, a fixed top/left on a body child is zoomed CSS px.
    setPos(placePinMenuZoomed(a, { w: l.width, h: l.height }, { w: window.innerWidth, h: window.innerHeight }, rootZoom()));
  }, [open]);

  // Focus the first item once the list is placed (a visibility:hidden list can't take focus).
  const placed = pos !== null;
  useEffect(() => {
    if (open && placed) list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tab.current?.contains(t) || list.current?.contains(t)) return;
      close(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const move = () => close(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", move);
    };
  }, [open]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") return close(false); // let focus move on naturally
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const btns = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!btns.length) return;
    e.preventDefault();
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const n = e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
    btns[n].focus();
  };

  return (
    <>
      <button
        ref={tab}
        type="button"
        className="composer-more-tab"
        title="More composer controls"
        aria-label="More composer controls"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="composer-more-tab"
        onClick={() => (open ? close() : setOpen(true))}
      >
        ◂
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            className="composer-more-list"
            role="menu"
            data-testid="composer-more-menu"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            onKeyDown={onListKey}
          >
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className="composer-more-item"
                title={it.title}
                aria-label={it.ariaLabel}
                data-testid={it.testid}
                disabled={it.disabled}
                onClick={() => {
                  close();
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
