// Pinned teams step 5 (docs/PLAN_PINNED_FEATURES.md §4): Mark complete, the Done shelf, Reopen and
// the Brainstorm's "looks done" card. Every completion starts from a click here; agents never complete a team.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { completeBlocker, type Pin } from "./pins";
import { createDoneShelfStore } from "./pinFocusLogic";
import { dismissLooksDone, isLooksDoneDismissed, markPinComplete, reopenPin } from "./pinActions";

type MarkState = { kind: "idle" } | { kind: "blocked"; why: string } | { kind: "armed" } | { kind: "busy" };

/** Mark complete with a second tap to confirm. A busy team shows why instead of arming. */
export function useMarkComplete(pin: Pin) {
  const [state, setState] = useState<MarkState>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const resetSoon = (ms = 4000) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState({ kind: "idle" }), ms);
  };
  const click = async () => {
    if (state.kind === "busy") return;
    const why = completeBlocker(pin);
    if (why) {
      setState({ kind: "blocked", why });
      resetSoon(6000);
      return;
    }
    if (state.kind !== "armed") {
      setState({ kind: "armed" });
      resetSoon();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setState({ kind: "busy" });
    try {
      const r = await markPinComplete(pin);
      if (!r.ok) {
        setState({ kind: "blocked", why: r.blocked });
        resetSoon(6000);
        return;
      }
    } catch (e) {
      alert(`Could not complete ${pin.lane.name}: ${(e as Error)?.message ?? e}`);
    }
    setState({ kind: "idle" });
  };
  const label =
    state.kind === "busy"
      ? "Completing…"
      : state.kind === "armed"
        ? "Tap again to complete"
        : state.kind === "blocked"
          ? `⏳ ${state.why}`
          : null;
  return { state, click, label };
}

export function MarkCompleteButton({ pin, idleLabel = "Mark complete", className = "", role }: { pin: Pin; idleLabel?: string; className?: string; role?: string }) {
  const { state, click, label } = useMarkComplete(pin);
  return (
    <button
      type="button"
      role={role}
      className={`pin-complete ${state.kind} ${className}`}
      disabled={state.kind === "busy"}
      data-testid={`pin-complete-${pin.lane.id}`}
      title="Move this team to the Done shelf. Its Brainstorm and Lead retire; Reopen brings it back."
      onClick={(e) => {
        e.stopPropagation();
        void click();
      }}
    >
      {label ?? idleLabel}
    </button>
  );
}

export function ReopenButton({ pin, className = "" }: { pin: Pin; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ghost small pin-reopen ${className}`}
      disabled={busy}
      data-testid={`pin-reopen-${pin.lane.id}`}
      title="Put this team back on the pins. The next click starts a Brainstorm from the same brief."
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await reopenPin(pin);
        } catch (err) {
          alert(`Could not reopen ${pin.lane.name}: ${(err as Error)?.message ?? err}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : "Reopen"}
    </button>
  );
}

const doneDate = (pin: Pin) => (pin.lane.doneAt ? new Date(pin.lane.doneAt).toLocaleDateString() : "");

/** One Done entry: ✓ name · date · Reopen. Shared by the sidebar and the squad page. */
export function DoneRow({ pin, testId }: { pin: Pin; testId: string }) {
  return (
    <div className="pin-row done" data-testid={testId} title={pin.lane.doneAt ? `Done ${doneDate(pin)}` : "Done"}>
      <span className="pin-done-check">✓</span>
      <span className="pin-row-name">{pin.lane.name}</span>
      <ReopenButton pin={pin} />
    </div>
  );
}

/** The Done shelf's open state, remembered across reloads per squad (collapsed by default). */
const doneShelfStore = createDoneShelfStore(typeof localStorage === "undefined" ? undefined : localStorage);
export function useDoneShelfOpen(squadId: string): [boolean, () => void] {
  const open = useSyncExternalStore(doneShelfStore.subscribe, () => doneShelfStore.get(squadId));
  return [open, () => doneShelfStore.toggle(squadId)];
}

/** The squad page's collapsed Done shelf. */
export function DoneShelf({ done, squadId }: { done: Pin[]; squadId: string }) {
  const [open, toggleOpen] = useDoneShelfOpen(squadId);
  if (!done.length) return null;
  return (
    <div className="pin-done-shelf" data-testid={`squad-done-${squadId}`}>
      <button type="button" className="pin-done-toggle" aria-expanded={open} onClick={toggleOpen}>
        {open ? "▾" : "▸"} Done ({done.length})
      </button>
      {open && (
        <div className="pin-done-list">
          {done.map((p) => (
            <div key={p.lane.id} className="pin-done-item" data-testid={`squad-done-pin-${p.lane.id}`}>
              <span className="pin-done-check">✓</span>
              <span className="pin-done-name">{p.lane.name}</span>
              {p.lane.doneAt && <span className="muted small">Done {doneDate(p)}</span>}
              <ReopenButton pin={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "<Team> looks done. ✓ Mark complete · Not yet", shown on the tile while the newest Brainstorm message carries vs:looks-done. */
export function LooksDoneCard({ pin, messageId }: { pin: Pin; messageId: string }) {
  const [dismissed, setDismissed] = useState(() => isLooksDoneDismissed(messageId));
  useEffect(() => setDismissed(isLooksDoneDismissed(messageId)), [messageId]);
  if (dismissed) return null;
  return (
    <div className="pin-looks-done" data-testid={`pin-looks-done-${pin.lane.id}`} onClick={(e) => e.stopPropagation()}>
      <span className="pin-looks-done-text">{pin.lane.name} looks done.</span>
      <MarkCompleteButton pin={pin} idleLabel="✓ Mark complete" className="btn ok small" />
      <button
        type="button"
        className="btn ghost small"
        data-testid={`pin-not-yet-${pin.lane.id}`}
        onClick={() => {
          dismissLooksDone(messageId);
          setDismissed(true);
        }}
      >
        Not yet
      </button>
    </div>
  );
}
