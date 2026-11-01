// Pinned teams step 6 (docs/PLAN_PINNED_FEATURES.md §5): idea capture. The misroute card
// ("Send to <Team> ↗ · Dismiss") on a tile and above the focused drawer, the overview "+" idea box,
// and the toast both report to. Side effects live in src/pinActions.ts.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { bestOverlap, nameFromIdea, parseSendTo, pinsForSquad, type Pin } from "./pins";
import { createPin, dismissSendTo, isSendToDismissed, sendIdeaToTeam } from "./pinActions";
import { getTeams, type TeamView } from "./teams";
import type { PinHandler } from "./PinGrid";

// ── Toast ──────────────────────────────────────────────────────────────────
let toast = "";
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const toastListeners = new Set<() => void>();

export function showPinToast(msg: string) {
  toast = msg;
  toastListeners.forEach((l) => l());
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast = "";
    toastListeners.forEach((l) => l());
  }, 4000);
}

/** Mounted once (App). */
export function PinToast() {
  const msg = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toast,
  );
  if (!msg) return null;
  return (
    <div className="pin-toast" role="status" data-testid="pin-toast">
      {msg}
    </div>
  );
}

// ── Misroute offer (vs:send-to marker in the newest Brainstorm message) ───────
export type SendToOffer = { id: string; laneId: string; text: string };
type TimelineEntry = { item: any; seqStart?: number; timestamp?: string };

/** The offer in the newest Brainstorm message, else null. Same message-id scheme as looks-done. */
export function sendToFrom(agentId: string, entries: TimelineEntry[]): SendToOffer | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const it = entries[i].item;
    if (it?.type !== "assistant_message" || typeof it.text !== "string") continue;
    const offer = parseSendTo(it.text);
    if (!offer) return null;
    return { ...offer, id: `${agentId}:${it.id ?? it.messageId ?? entries[i].seqStart ?? entries[i].timestamp ?? it.text.length}` };
  }
  return null;
}

// Offer per Brainstorm, fed by PinGrid's usePreview loads (tiles and rail) so nothing fetches twice.
const offers = new Map<string, SendToOffer | null>();
const offerListeners = new Set<() => void>();

export function noteSendTo(agentId: string, entries: TimelineEntry[]) {
  const next = sendToFrom(agentId, entries);
  const cur = offers.get(agentId) ?? null;
  if (cur?.id === next?.id && cur?.text === next?.text) return;
  offers.set(agentId, next);
  offerListeners.forEach((l) => l());
}

export function useSendTo(agentId: string | null): SendToOffer | null {
  return useSyncExternalStore(
    (l) => {
      offerListeners.add(l);
      return () => offerListeners.delete(l);
    },
    () => (agentId ? (offers.get(agentId) ?? null) : null),
  );
}

const laneName = (laneId: string): string | null => {
  for (const t of getTeams()) for (const l of t.lanes) if (l.id.toLowerCase() === laneId.toLowerCase()) return l.name;
  return null;
};

/**
 * "<idea> · Send to <Team> ↗ · Dismiss". A one-line idea sends on one click; a longer one opens the full text
 * first, so what gets sent to B's Brainstorm (or parked in B's inbox) is always what you saw.
 */
export function SendToCard({ pin, offer, variant = "tile" }: { pin: Pin; offer: SendToOffer; variant?: "tile" | "bar" }) {
  const [hidden, setHidden] = useState(() => isSendToDismissed(offer.id));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    setHidden(isSendToDismissed(offer.id));
    setPreview(false);
  }, [offer.id, offer.text]);
  if (hidden || !offer.text) return null;
  const target = laneName(offer.laneId);
  const lines = offer.text.split("\n");
  const multiLine = lines.length > 1;
  const sendLabel = target ? `Send to ${target} ↗` : "Park in inbox ↗";
  const send = async () => {
    setPreview(false);
    setBusy(true);
    try {
      showPinToast(await sendIdeaToTeam(offer.laneId, offer.text, pin.lane.name));
      dismissSendTo(offer.id);
      setHidden(true);
    } catch (e) {
      showPinToast(`Could not send: ${(e as Error)?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`pin-send-to ${variant}`} data-testid={`pin-send-to-${pin.lane.id}`} onClick={(e) => e.stopPropagation()}>
      <span className="pin-send-to-text" title={offer.text}>
        {lines[0]}
      </span>
      {multiLine && <span className="muted small pin-send-to-more">+{lines.length - 1} more lines</span>}
      <button
        type="button"
        className="btn ok small"
        disabled={busy}
        data-testid={`pin-send-to-go-${pin.lane.id}`}
        onClick={() => (multiLine ? setPreview(true) : void send())}
      >
        {busy ? "…" : sendLabel}
      </button>
      {preview &&
        createPortal(
        <div className="modal-back" onClick={() => setPreview(false)}>
          <div
            className="modal pin-send-preview"
            role="dialog"
            aria-label="Send idea"
            data-testid={`pin-send-preview-${pin.lane.id}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setPreview(false);
              }
            }}
          >
            <div className="modal-head">
              <span>{target ? `SEND TO ${target.toUpperCase()}` : "PARK IN INBOX"}</span>
              <button type="button" className="btn ghost small" onClick={() => setPreview(false)} title="Close (Esc)">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="muted small">This whole message gets sent:</div>
              <pre className="pin-send-preview-text" data-testid={`pin-send-preview-text-${pin.lane.id}`}>
                {offer.text}
              </pre>
            </div>
            <div className="modal-foot pin-idea-actions">
              <button type="button" className="btn ghost" onClick={() => setPreview(false)}>
                Cancel
              </button>
              <button type="button" className="btn ok" autoFocus data-testid={`pin-send-confirm-${pin.lane.id}`} onClick={() => void send()}>
                {sendLabel}
              </button>
            </div>
          </div>
        </div>,
          document.body,
        )}
      <button
        type="button"
        className="btn ghost small"
        onClick={() => {
          dismissSendTo(offer.id);
          setHidden(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/** The card above the focused drawer (rendered in PinFocusHeader). */
export function SendToBar({ pin }: { pin: Pin }) {
  const offer = useSendTo(pin.brainstorm?.agent.id ?? null);
  return offer ? <SendToCard pin={pin} offer={offer} variant="bar" /> : null;
}

// ── Overview "+": type an idea, pick a team or make a new one ────────────────
const NEW = "__new";

function IdeaBox({ view, onClose, onQuickStart }: { view: TeamView; onClose: () => void; onQuickStart: PinHandler }) {
  const pinned = pinsForSquad(view).pinned;
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(null); // null = follow the best match
  const [name, setName] = useState<string | null>(null); // null = follow the first line
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const match = useMemo(() => (text.trim() ? bestOverlap(text, pinned.map((p) => p.lane)) : null), [text, pinned]);
  const target = picked ?? match?.lane.id ?? NEW;
  const teamName = name ?? nameFromIdea(text);

  const submit = async () => {
    const idea = text.trim();
    if (!idea || busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (target !== NEW) {
        showPinToast(await sendIdeaToTeam(target, idea));
        onClose();
        return;
      }
      const pin = await createPin(view.team.id, teamName || "New team", idea);
      onClose();
      showPinToast(`Pinned ${pin.lane.name}`);
      await onQuickStart(pin);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const overlapHint = target === NEW && match ? match.lane : null;
  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal pin-idea-box"
        role="dialog"
        aria-label="New idea"
        data-testid="pin-idea-box"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="modal-head">
          <span>NEW IDEA</span>
          <button type="button" className="btn ghost small" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <textarea
            ref={ref}
            value={text}
            rows={4}
            placeholder="I just thought of…"
            data-testid="pin-idea-text"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="pin-idea-row">
            <label className="muted small" htmlFor="pin-idea-team">
              Team
            </label>
            <select id="pin-idea-team" value={target} data-testid="pin-idea-team" onChange={(e) => setPicked(e.target.value)}>
              {pinned.map((p) => (
                <option key={p.lane.id} value={p.lane.id}>
                  {p.lane.name}
                  {match?.lane.id === p.lane.id ? " (best match)" : ""}
                </option>
              ))}
              <option value={NEW}>+ New team</option>
            </select>
            {target === NEW && (
              <input
                value={teamName}
                placeholder="Team name"
                data-testid="pin-idea-name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            )}
          </div>
          {overlapHint && (
            <div className="pin-idea-hint small" data-testid="pin-idea-overlap">
              Sounds like {overlapHint.name}.{" "}
              <button type="button" className="btn ghost small" onClick={() => setPicked(overlapHint.id)}>
                Use it
              </button>
              <span className="muted"> · or make a new team</span>
            </div>
          )}
          <div className="muted small pin-idea-foot">
            {target === NEW
              ? "Pins a new team with this idea in its brief and starts its Brainstorm."
              : "Goes to that team's Brainstorm, or its inbox if nobody is there."}
          </div>
          {err && <div className="stat-alert small">{err}</div>}
        </div>
        <div className="modal-foot pin-idea-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn ok" disabled={busy || !text.trim() || (target === NEW && !teamName.trim())} data-testid="pin-idea-submit" onClick={() => void submit()}>
            {busy ? "…" : target === NEW ? "Pin new team" : `Send to ${pinned.find((p) => p.lane.id === target)?.lane.name ?? "team"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "+" tile at the end of the squad grid. */
export function IdeaPlusTile({ view, onQuickStart }: { view: TeamView; onQuickStart: PinHandler }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="pin-tile pin-plus" data-testid="pin-plus" title="Capture an idea: send it to a team or pin a new one" onClick={() => setOpen(true)}>
        <span className="pin-plus-icon">+</span>
        <span className="muted small">New idea</span>
      </button>
      {open && <IdeaBox view={view} onClose={() => setOpen(false)} onQuickStart={onQuickStart} />}
    </>
  );
}
