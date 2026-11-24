// Context-ref popover (docs/PLAN_CONTEXT_REFS.md R1): a `` `msg:-N` `` / `` `idea-N` `` token in chat
// renders as a link; hover (desktop) or tap (coarse pointer) opens a compact, viewport-clamped popover
// with the referenced message or inbox card. Portal to <body>, PinMenu/AttentionList placement pattern.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rootZoom } from "./pinMenuPlace";
import { parseContextRef, resolveMsgRef, type RefEntry } from "./contextRefs";
import { openAndScrollToInbox, refreshInboxCards, useInboxCards } from "./IdeaInbox";

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 160;
const CLAMP_MARGIN = 4;

/** Coarse primary pointer (touch): tap toggles instead of hover/focus. */
const coarsePointer = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

type RefLinkProps = {
  /** The raw backtick token text, e.g. "msg:-1" (rendered verbatim as the code link). */
  token: string;
  agentId?: string;
  entries?: RefEntry[];
  citing?: RefEntry;
};

export function RefLink({ token, agentId, entries, citing }: RefLinkProps) {
  const ref = parseContextRef(token);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const [focused, setFocused] = useState(false);
  const coarse = useMemo(coarsePointer, []);
  const inboxCards = useInboxCards();

  // A lone idea ref opened before anything fetched the inbox: pull the cards once.
  useEffect(() => {
    if (ref?.kind === "idea" && inboxCards.length === 0) void refreshInboxCards();
  }, [ref, inboxCards.length]);

  const cancelTimer = useCallback(() => {
    if (hoverTimer.current != null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelTimer();
    hovered.current = false;
    setOpen(false);
    setPos(null);
  }, [cancelTimer]);

  const openNow = useCallback(() => {
    cancelTimer();
    setOpen(true);
  }, [cancelTimer]);

  const resolved = useMemo(() => {
    if (!ref) return null;
    if (ref.kind === "msg") {
      const r = resolveMsgRef(entries ?? [], citing ?? ({} as RefEntry), ref.n, agentId);
      return r.status === "ok"
        ? { kind: "msg" as const, text: String(r.entry.item?.text ?? ""), entry: r.entry }
        : { kind: "msg-missing" as const };
    }
    const card = inboxCards.find((c) => c.id === ref.id) ?? null;
    return card ? { kind: "idea" as const, card } : { kind: "idea-missing" as const };
  }, [ref, entries, citing, agentId, inboxCards]);

  // Place the popover anchored under the token, clamped into the viewport (flip above when short).
  useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) return;
    const place = () => {
      const t = trigger.current;
      const p = pop.current;
      if (!t || !p) return;
      const a = t.getBoundingClientRect();
      const z = rootZoom();
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const vw = window.innerWidth / z;
      const vh = window.innerHeight / z;
      const left = Math.max(CLAMP_MARGIN, Math.min(a.left / z, vw - w - CLAMP_MARGIN));
      const below = a.bottom / z + CLAMP_MARGIN;
      const above = a.top / z - CLAMP_MARGIN - h;
      const top = below + h <= vh - CLAMP_MARGIN ? below : above >= CLAMP_MARGIN ? above : Math.max(CLAMP_MARGIN, vh - h - CLAMP_MARGIN);
      setPos((cur) => (cur && cur.top === top && cur.left === left ? cur : { top, left }));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(pop.current);
    return () => ro.disconnect();
  }, [open]);

  // Esc / outside click close.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (trigger.current && !trigger.current.contains(t) && pop.current && !pop.current.contains(t)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open, close]);

  useEffect(() => cancelTimer, [cancelTimer]);

  const scheduleClose = () => {
    cancelTimer();
    hoverTimer.current = setTimeout(() => {
      if (!hovered.current && !focused) {
        setOpen(false);
        setPos(null);
      }
    }, HOVER_CLOSE_MS);
  };

  const onTriggerEnter = () => {
    if (coarse) return;
    hovered.current = true;
    cancelTimer();
    hoverTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
  };
  const onTriggerLeave = () => {
    if (coarse) return;
    hovered.current = false;
    cancelTimer();
    if (!focused) scheduleClose();
  };
  const onPopEnter = () => {
    if (coarse) return;
    hovered.current = true;
    cancelTimer();
  };
  const onPopLeave = () => {
    if (coarse) return;
    hovered.current = false;
    scheduleClose();
  };
  const onTriggerFocus = () => {
    if (coarse) return;
    setFocused(true);
    openNow();
  };
  const onTriggerBlur = (e: React.FocusEvent) => {
    if (coarse) return;
    const next = e.relatedTarget as Node | null;
    if (next && pop.current && pop.current.contains(next)) return; // focus moved into the popover
    setFocused(false);
    close();
  };

  const jumpToMessage = () => {
    close();
    if (!resolved || resolved.kind !== "msg") return;
    const seq = resolved.entry.seqStart;
    if (seq == null) return;
    const marker = document.querySelector<HTMLElement>(`[data-tl-seq="${seq}"]`);
    const el = marker?.nextElementSibling as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("tl-flash");
      setTimeout(() => el.classList.remove("tl-flash"), 1800);
    }
  };

  const loadOlder = () => {
    close();
    document.querySelector<HTMLElement>('[data-testid="tl-load-older-btn"]')?.click();
  };

  const openInbox = () => {
    close();
    openAndScrollToInbox();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (open) close();
      else openNow();
    }
  };

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (coarse) {
      if (open) close();
      else openNow();
    } else openNow();
  };

  return (
    <>
      <code
        ref={trigger}
        className="tl-icode tl-ref-link"
        data-testid="tl-ref-link"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        onMouseEnter={onTriggerEnter}
        onMouseLeave={onTriggerLeave}
        onFocus={onTriggerFocus}
        onBlur={onTriggerBlur}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {token}
      </code>
      {open &&
        resolved &&
        createPortal(
          <div
            ref={pop}
            className="ref-popover"
            role="dialog"
            aria-label="Context reference"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            onMouseEnter={onPopEnter}
            onMouseLeave={onPopLeave}
          >
            <div className="ref-popover-body">
              {resolved.kind === "msg" ? (
                <div className="ref-popover-text">{resolved.text}</div>
              ) : resolved.kind === "idea" ? (
                <>
                  <div className="ref-popover-title">{resolved.card.title}</div>
                  <div className="ref-popover-text">{resolved.card.text}</div>
                </>
              ) : resolved.kind === "msg-missing" ? (
                <div className="ref-popover-note">
                  Not loaded —{" "}
                  <button type="button" className="ref-popover-jump" onClick={loadOlder}>
                    Jump to load older
                  </button>
                </div>
              ) : (
                <div className="ref-popover-note">Card not found</div>
              )}
            </div>
            {(resolved.kind === "msg" || resolved.kind === "idea") && (
              <div className="ref-popover-foot">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={resolved.kind === "msg" ? jumpToMessage : openInbox}
                >
                  {resolved.kind === "msg" ? "Jump to message" : "Open in Inbox"}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
