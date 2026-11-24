// Context-ref popover (docs/PLAN_CONTEXT_REFS.md R1): a `` `msg:-N` `` / `` `idea-N` `` token in chat
// renders as a link; hover (desktop) or tap (coarse pointer) opens a compact, viewport-clamped popover
// with the referenced message or inbox card. Portal to <body>, PinMenu/AttentionList placement pattern.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rootZoom } from "./pinMenuPlace";
import { parseContextRef, resolveMsgRef, type ContextRef, type IdeaRef, type RefEntry } from "./contextRefs";
import { focusInboxCard, isInboxLoadedOnce, openAndScrollToInbox, refreshInboxCards, useInboxCards } from "./IdeaInbox";

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 160;
const CLAMP_MARGIN = 4;
const FLASH_MS = 1800;

/** Coarse primary pointer (touch): tap toggles instead of hover/focus. */
const coarsePointer = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

const boringMode = (): boolean =>
  typeof document !== "undefined" && document.documentElement.getAttribute("data-vibe") === "boring";

const phoneShell = (): boolean => typeof window !== "undefined" && window.innerWidth <= 600;

const reducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type RefLinkProps = {
  /** The raw backtick token text, e.g. "msg:-1" (rendered verbatim as the code link). */
  token: string;
  agentId?: string;
  entries?: RefEntry[];
  citing?: RefEntry;
  /** Whether the timeline has older history to load (R13-3: "No earlier message" vs "Jump to load older"). */
  hasMore?: boolean;
};

export function RefLink({ token, agentId, entries, citing, hasMore }: RefLinkProps) {
  const ref = useMemo(() => parseContextRef(token), [token]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const suppressFocusOpen = useRef(false);
  const pendingFocusAction = useRef(false);
  const pendingJump = useRef(false);
  const coarse = useMemo(coarsePointer, []);
  const phone = useMemo(phoneShell, []);
  const boring = useMemo(boringMode, []);

  const cancelTimer = useCallback(() => {
    if (hoverTimer.current != null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelTimer();
    hovered.current = false;
    pendingFocusAction.current = false;
    setOpen(false);
    setPos(null);
  }, [cancelTimer]);

  const openNow = useCallback(() => {
    cancelTimer();
    setOpen(true);
  }, [cancelTimer]);

  // Place the popover anchored under the token, clamped into the viewport (flip above when short);
  // re-place on window resize (L2).
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
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(pop.current);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [open]);

  // Esc / outside pointerdown close; any ancestor scroll closes (R13-5, PinMenu behaviour).
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (trigger.current && !trigger.current.contains(t) && pop.current && !pop.current.contains(t)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (trigger.current !== document.activeElement) suppressFocusOpen.current = true;
        close();
        trigger.current?.focus();
      }
    };
    const scrollClose = () => close();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", scrollClose, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", scrollClose, true);
    };
  }, [open, close]);

  // Enter/Space from a closed trigger opens then moves focus into the popover (M2 / R13-4).
  useEffect(() => {
    if (open && pendingFocusAction.current) {
      pendingFocusAction.current = false;
      pop.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [open]);

  // R13-3: after "Jump to load older" loads a page, re-resolve and land on the now-loaded message.
  useEffect(() => {
    if (!pendingJump.current || !ref || ref.kind !== "msg") return;
    const r = resolveMsgRef(entries ?? [], citing ?? ({} as RefEntry), ref.n, agentId);
    if (r.status === "ok") {
      pendingJump.current = false;
      jumpToEntry(r.entry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, citing, agentId, ref]);

  useEffect(
    () => () => {
      if (flashTimer.current != null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const scheduleClose = () => {
    cancelTimer();
    hoverTimer.current = setTimeout(() => {
      const active = document.activeElement;
      const within =
        active &&
        active !== document.body &&
        ((trigger.current && trigger.current.contains(active)) || (pop.current && pop.current.contains(active)));
      if (!hovered.current && !within) {
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
    scheduleClose();
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
    if (suppressFocusOpen.current) {
      suppressFocusOpen.current = false;
      return;
    }
    openNow();
  };
  const onTriggerBlur = (e: React.FocusEvent) => {
    if (coarse) return;
    const next = e.relatedTarget as Node | null;
    if (next && pop.current && pop.current.contains(next)) return; // focus moved into the popover
    close();
  };
  const onPopBlur = (e: React.FocusEvent) => {
    if (coarse) return;
    const next = e.relatedTarget as Node | null;
    if (
      next &&
      ((pop.current && pop.current.contains(next)) || (trigger.current && trigger.current.contains(next)))
    ) {
      return; // focus stays within the trigger/popover pair
    }
    close();
  };

  const timelineEl = (): HTMLElement | null =>
    (trigger.current?.closest(".timeline") as HTMLElement | null) ?? null;

  const jumpToEntry = (entry: RefEntry) => {
    const timeline = timelineEl();
    close();
    const seq = entry.seqStart ?? entries?.indexOf(entry);
    if (seq == null || seq < 0) return;
    const marker = timeline?.querySelector<HTMLElement>(`[data-tl-seq="${seq}"]`);
    const el = marker?.nextElementSibling as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    el.classList.add("tl-flash");
    if (flashTimer.current != null) clearTimeout(flashTimer.current); // R13-7: never stack stale flash clears
    flashTimer.current = setTimeout(() => el.classList.remove("tl-flash"), FLASH_MS);
  };

  const loadOlder = () => {
    const timeline = timelineEl();
    close();
    pendingJump.current = true;
    timeline?.querySelector<HTMLElement>('[data-testid="tl-load-older-btn"]')?.click();
  };

  const openInbox = (cardId: string) => {
    close();
    if (boring) focusInboxCard(cardId);
    else openAndScrollToInbox();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      pop.current?.querySelector<HTMLElement>("button")?.focus();
    } else {
      pendingFocusAction.current = true;
      openNow();
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
        aria-expanded={open}
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
        ref &&
        createPortal(
          <div
            ref={pop}
            className="ref-popover"
            role="dialog"
            aria-label="Context reference"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            onMouseEnter={onPopEnter}
            onMouseLeave={onPopLeave}
            onBlur={onPopBlur}
          >
            <PopoverBody
              ref={ref}
              agentId={agentId}
              entries={entries}
              citing={citing}
              hasMore={hasMore}
              phone={phone}
              onJump={jumpToEntry}
              onLoadOlder={loadOlder}
              onOpenInbox={openInbox}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

type PopoverBodyProps = {
  ref: ContextRef;
  agentId?: string;
  entries?: RefEntry[];
  citing?: RefEntry;
  hasMore?: boolean;
  phone: boolean;
  onJump: (entry: RefEntry) => void;
  onLoadOlder: () => void;
  onOpenInbox: (cardId: string) => void;
};

/** Resolves the ref (msg inline, idea via the inbox store) — only ever mounted while the popover is open (M3/H1). */
function PopoverBody({ ref, agentId, entries, citing, hasMore, phone, onJump, onLoadOlder, onOpenInbox }: PopoverBodyProps) {
  if (ref.kind === "msg") {
    const r = resolveMsgRef(entries ?? [], citing ?? ({} as RefEntry), ref.n, agentId);
    if (r.status === "ok") {
      return (
        <>
          <div className="ref-popover-body">
            <div className="ref-popover-text">{String(r.entry.item?.text ?? "")}</div>
          </div>
          <div className="ref-popover-foot">
            <button type="button" className="btn ghost small" onClick={() => onJump(r.entry)}>
              Jump to message
            </button>
          </div>
        </>
      );
    }
    return (
      <div className="ref-popover-body">
        {hasMore ? (
          <div className="ref-popover-note">
            Not loaded —{" "}
            <button type="button" className="ref-popover-jump" onClick={onLoadOlder}>
              Jump to load older
            </button>
          </div>
        ) : (
          <div className="ref-popover-note">No earlier message</div>
        )}
      </div>
    );
  }
  return <IdeaBody ref={ref} phone={phone} onOpenInbox={onOpenInbox} />;
}

/** Idea ref body: subscribes to the inbox store only while open; fetches once (deduped) if never loaded. */
function IdeaBody({ ref, phone, onOpenInbox }: { ref: IdeaRef; phone: boolean; onOpenInbox: (cardId: string) => void }) {
  const inboxCards = useInboxCards();
  useEffect(() => {
    if (inboxCards.length === 0 && !isInboxLoadedOnce()) void refreshInboxCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const card = inboxCards.find((c) => c.id === ref.id) ?? null;
  if (!card) {
    return (
      <div className="ref-popover-body">
        <div className="ref-popover-note">Card not found</div>
      </div>
    );
  }
  return (
    <>
      <div className="ref-popover-body">
        <div className="ref-popover-title">{card.title}</div>
        <div className="ref-popover-text">{card.text}</div>
      </div>
      {!phone && (
        <div className="ref-popover-foot">
          <button type="button" className="btn ghost small" onClick={() => onOpenInbox(card.id)}>
            Open in Inbox
          </button>
        </div>
      )}
    </>
  );
}
