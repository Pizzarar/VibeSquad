// Pinned teams, step 1 (docs/PLAN_PINNED_FEATURES.md §1): the default squad page is a grid of pinned
// Teams, and the sidebar lists the same pins. Clicking a pin opens its live Brainstorm in today's drawer;
// with no live Brainstorm the caller's onQuickStart(pin) decides what happens (src/pinActions.ts openPin).
// FULL brings back the old plumbing view (agent cards, workers, handoff, folders, retired agents).
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { client, DEMO, sendMessage } from "./paseo";
import { demoTimeline } from "./demo";
import { pinsForSquad, type Pin } from "./pins";
import { getBrainstormThresholds, type TeamView } from "./teams";
import { StatusDot, usePaneClass } from "./ui";
import { Avatar } from "./pixel";

// ── FULL toggle (persisted) ──────────────────────────────────────────────────
const FULL_VIEW_KEY = "vibesquad.squadFullView";
const fullListeners = new Set<() => void>();
let fullView = (() => {
  try {
    return localStorage.getItem(FULL_VIEW_KEY) === "1";
  } catch {
    return false;
  }
})();

export function setFullView(on: boolean) {
  fullView = on;
  try {
    localStorage.setItem(FULL_VIEW_KEY, on ? "1" : "0");
  } catch {}
  fullListeners.forEach((l) => l());
}

export function useFullView(): boolean {
  return useSyncExternalStore(
    (l) => {
      fullListeners.add(l);
      return () => fullListeners.delete(l);
    },
    () => fullView,
  );
}

export function FullToggle() {
  const full = useFullView();
  return (
    <button
      type="button"
      className={`tchip pin-full-toggle ${full ? "on" : ""}`}
      data-testid="squad-full-toggle"
      aria-pressed={full}
      title={full ? "Back to the Teams grid" : "Show the full plumbing view: agent cards, workers, handoffs, folders, retired agents"}
      onClick={() => setFullView(!full)}
    >
      {full ? "⊞ TEAMS" : "FULL"}
    </button>
  );
}

export type PinHandler = (pin: Pin) => void | Promise<unknown>;

/** Opens the live Brainstorm, or hands the pin to onQuickStart when there is none. */
export function openPinOr(pin: Pin, onOpenAgent: (id: string) => void, onQuickStart: PinHandler) {
  if (pin.brainstorm) onOpenAgent(pin.brainstorm.agent.id);
  else return onQuickStart(pin);
}

// ── Context meter for the live Brainstorm ────────────────────────────────────
function PinCtx({ pin }: { pin: Pin }) {
  if (!pin.brainstorm) return null;
  const { warnTokens, restartTokens } = getBrainstormThresholds(pin.squad);
  const used = pin.contextUsed;
  const pct = Math.min(100, Math.max(0, (used / Math.max(1, restartTokens)) * 100));
  const tone = used >= restartTokens ? "red" : used >= warnTokens ? "amber" : "ok";
  return (
    <span
      className={`pin-ctx tone-${tone}`}
      title={`Brainstorm context: ${Math.round(used / 1000)}k / ${Math.round(restartTokens / 1000)}k tok`}
      data-testid={`pin-ctx-${pin.lane.id}`}
    >
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

export function PinDot({ pin }: { pin: Pin }) {
  if (pin.brainstorm) return <StatusDot agent={pin.brainstorm.agent} />;
  return <span className="signal closed" title="No session yet" />;
}

export function NeedsBadge({ pin }: { pin: Pin }) {
  if (!pin.needsYou) return null;
  return (
    <span className="badge alert pin-needs" title={`${pin.needsYou} need you`}>
      {pin.needsYou}
    </span>
  );
}

// ── Sidebar: a squad's pins + a collapsed Done shelf ─────────────────────────
const PinRow = memo(function PinRow({ pin, onPin }: { pin: Pin; onPin: (pin: Pin) => void }) {
  const paneCls = usePaneClass(pin.brainstorm?.agent.id ?? "");
  return (
    <button
      type="button"
      className={`pin-row ${paneCls} ${pin.brainstorm ? "" : "no-session"}`}
      data-testid={`sidebar-pin-${pin.lane.id}`}
      title={pin.brainstorm ? `Open ${pin.lane.name}` : `${pin.lane.name}: no session yet · click to start`}
      onClick={() => onPin(pin)}
    >
      <PinDot pin={pin} />
      <span className="pin-row-name">{pin.lane.name}</span>
      <NeedsBadge pin={pin} />
      <PinCtx pin={pin} />
    </button>
  );
});

export function SidebarPins({ view, onPin }: { view: TeamView; onPin: (pin: Pin) => void }) {
  const { pinned, done } = pinsForSquad(view);
  const [doneOpen, setDoneOpen] = useState(false);
  return (
    <div className="pin-list" data-testid={`sidebar-pins-${view.team.id}`}>
      {pinned.map((p) => (
        <PinRow key={p.lane.id} pin={p} onPin={onPin} />
      ))}
      {!pinned.length && <div className="pin-empty muted small">No teams yet</div>}
      {done.length > 0 && (
        <>
          <button
            type="button"
            className="pin-done-toggle"
            aria-expanded={doneOpen}
            data-testid={`sidebar-done-${view.team.id}`}
            onClick={() => setDoneOpen((v) => !v)}
          >
            {doneOpen ? "▾" : "▸"} Done ({done.length})
          </button>
          {doneOpen &&
            done.map((p) => (
              <div key={p.lane.id} className="pin-row done" data-testid={`sidebar-done-pin-${p.lane.id}`} title={p.lane.doneAt ? `Done ${new Date(p.lane.doneAt).toLocaleDateString()}` : "Done"}>
                <span className="pin-done-check">✓</span>
                <span className="pin-row-name">{p.lane.name}</span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

// ── Grid tile: last few chat lines, read-only ────────────────────────────────
export type Line = { who: "you" | "bs"; text: string };
const PREVIEW_LINES = 4;

function linesFrom(entries: { item: any }[]): Line[] {
  const out: Line[] = [];
  for (const e of entries) {
    const it = e.item;
    if (!it || typeof it.text !== "string") continue;
    const who = it.type === "user_message" ? "you" : it.type === "assistant_message" ? "bs" : null;
    if (!who) continue;
    for (const raw of it.text.split("\n")) {
      const text = raw.replace(/[`*#>_]+/g, "").trim();
      if (text) out.push({ who, text });
    }
  }
  return out.slice(-PREVIEW_LINES);
}

// Tail of the Brainstorm's timeline. Light version of the drawer's loader: small tail, debounced refetch.
export function usePreview(agentId: string | null): Line[] {
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => {
    setLines([]);
    if (!agentId) return;
    if (DEMO) {
      setLines(linesFrom(demoTimeline(agentId)));
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = client.agents.ref(agentId);
    const load = async () => {
      try {
        const t = await handle.timeline.refetch({ direction: "tail", limit: 16, projection: "projected" });
        if (alive && !t.error) setLines(linesFrom(t.entries as { item: any }[]));
      } catch {}
    };
    load();
    const sub = handle.timeline.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, 1500);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (typeof sub === "function") sub();
      else if (sub && typeof (sub as any).unsubscribe === "function") (sub as any).unsubscribe();
    };
  }, [agentId]);
  return lines;
}

function QuickReply({ pin }: { pin: Pin }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const agentId = pin.brainstorm!.agent.id;
  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await sendMessage(agentId, msg);
      setText("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="pin-reply"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input
        value={text}
        placeholder={`Message ${pin.lane.name}…`}
        disabled={busy}
        data-testid={`pin-reply-${pin.lane.id}`}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn ok small" disabled={busy || !text.trim()} title="Send to the Brainstorm">
        {busy ? "…" : "Send"}
      </button>
      {err && <span className="stat-alert small pin-reply-err">{err}</span>}
    </form>
  );
}

const PinTile = memo(function PinTile({ pin, onPin }: { pin: Pin; onPin: (pin: Pin) => Promise<void> }) {
  const bs = pin.brainstorm;
  const lines = usePreview(bs?.agent.id ?? null);
  const paneCls = usePaneClass(bs?.agent.id ?? "");
  const [starting, setStarting] = useState(false);
  const busy = useRef(false);
  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    if (!bs) setStarting(true);
    try {
      await onPin(pin);
    } finally {
      busy.current = false;
      setStarting(false);
    }
  };
  return (
    <div
      className={`pin-tile ${paneCls} ${bs ? "" : "no-session"} ${pin.needsYou ? "needs-you" : ""}`}
      role="button"
      tabIndex={0}
      data-testid={`pin-tile-${pin.lane.id}`}
      onClick={() => void open()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void open();
        }
      }}
    >
      <div className="pin-tile-head">
        {bs ? (
          <Avatar id={bs.agent.id} provider={bs.agent.provider} agentType="brainstorm" size={40} />
        ) : (
          <Avatar id={`bs-empty-${pin.squad.id}-${pin.lane.id}`} provider="claude" agentType="brainstorm" size={40} />
        )}
        <div className="pin-tile-title">
          <span className="pin-tile-name">{pin.lane.name}</span>
          <span className="pin-tile-sub muted small">
            <PinDot pin={pin} /> {bs ? (bs.agent.status === "running" ? "Brainstorm working" : "Brainstorm") : "No session yet"}
          </span>
        </div>
        <NeedsBadge pin={pin} />
        <PinCtx pin={pin} />
      </div>
      {bs ? (
        <>
          <div className="pin-tile-lines" data-testid={`pin-lines-${pin.lane.id}`}>
            {lines.length ? (
              lines.map((l, i) => (
                <div key={i} className={`pin-line ${l.who}`}>
                  {l.who === "you" && <b>you: </b>}
                  {l.text}
                </div>
              ))
            ) : (
              <div className="pin-line muted">No messages yet</div>
            )}
          </div>
          <QuickReply pin={pin} />
        </>
      ) : (
        <div className="pin-tile-empty" data-testid={`pin-quickstart-${pin.lane.id}`}>
          {starting ? "Starting…" : "No session yet · click to start"}
        </div>
      )}
    </div>
  );
});

export function PinGrid({
  view,
  onOpenAgent,
  onQuickStart,
}: {
  view: TeamView;
  onOpenAgent: (id: string) => void;
  onQuickStart: PinHandler;
}) {
  const { pinned, done } = pinsForSquad(view);
  const onPin = async (pin: Pin) => {
    try {
      await openPinOr(pin, onOpenAgent, onQuickStart);
    } catch (e) {
      alert(`Could not start ${pin.lane.name}: ${e}`);
    }
  };
  return (
    <section className="pin-grid-wrap" data-testid="pin-grid">
      <div className="pin-grid">
        {pinned.map((p) => (
          <PinTile key={p.lane.id} pin={p} onPin={onPin} />
        ))}
      </div>
      {!pinned.length && <div className="muted">No pinned teams in {view.team.name} yet. Use + Team to add one.</div>}
      {done.length > 0 && <div className="muted small pin-grid-done">Done ({done.length}): {done.map((p) => p.lane.name).join(" · ")}</div>}
    </section>
  );
}
