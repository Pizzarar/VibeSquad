import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { updateAgent } from "./paseo";
import { getPanes, pruneRestoredTabs } from "./panes";
import { exitSquadsHome, getPinFocus } from "./pinFocus";
import { planAgentRename, renameDraftFor } from "./renameAgent";
import { UNASSIGNED, saveTeams, type TeamDef } from "./teams";
import {
  BASE_TITLE,
  BUSY_DELAY_MS,
  attentionTotal,
  fullTime,
  renameKeyAction,
  renameOutcome,
  tabTitle,
} from "./quickwins";
import { formatTimestamp, usePref } from "./prefs";
import { useClock } from "./ui";

// ---- tab title + favicon dot (walk 57) -------------------------------------------------
let baseIcon: HTMLImageElement | null = null;
let originalHref: string | null = null;
let dottedHref: string | null = null;

function paintFavicon(count: number) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  originalHref ??= link.href;
  const origType = "image/x-icon";
  if (count <= 0) {
    if (link.href !== originalHref) {
      link.href = originalHref;
      link.type = origType;
    }
    return;
  }
  if (dottedHref) {
    link.type = "image/png";
    link.href = dottedHref;
    return;
  }
  const draw = (img: HTMLImageElement) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g) return;
    g.drawImage(img, 0, 0, 64, 64);
    g.beginPath();
    g.arc(46, 18, 16, 0, Math.PI * 2);
    g.fillStyle = "#ff3d8b";
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#090714";
    g.stroke();
    link.type = "image/png";
    dottedHref = c.toDataURL("image/png");
    link.href = dottedHref;
  };
  if (baseIcon?.complete) return draw(baseIcon);
  baseIcon = new Image();
  baseIcon.onload = () => baseIcon && draw(baseIcon);
  baseIcon.src = "/vibesquad-192.png";
}

/** "(3) VibeSquad" in the tab title and a dot on the favicon while anything needs you. */
export function useAttentionTitle(views: ReadonlyArray<{ needsYou: number }>) {
  const count = attentionTotal(views);
  useEffect(() => {
    document.title = tabTitle(count);
    paintFavicon(count);
  }, [count]);
  useEffect(
    () => () => {
      document.title = BASE_TITLE;
      paintFavicon(0);
    },
    [],
  );
}

// ---- timestamps (walk 64) ---------------------------------------------------------------
export function Stamp({ iso, className = "tl-stamp" }: { iso?: string | null; className?: string }) {
  const [fmt] = usePref("chat.timestampFormat");
  const text = useClock((now) => formatTimestamp(iso, fmt, now));
  if (!text) return null;
  return (
    <div className={className} title={fullTime(iso)} data-testid="tl-stamp">
      {text}
    </div>
  );
}

// ---- delayed busy indicator (walk 58) ---------------------------------------------------
/** True only once `busy` has lasted past the delay, so fast loads never flash a spinner. */
export function useDelayedBusy(busy: boolean, delay = BUSY_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) return setShown(false);
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [busy, delay]);
  return shown;
}

export function Spinner({ label, className = "" }: { label?: string; className?: string }) {
  return (
    <span className={`qw-spinner-wrap ${className}`} role="status" aria-live="polite">
      <span className="qw-spinner" aria-hidden="true" />
      {label && <span className="muted small">{label}</span>}
    </span>
  );
}

/** Skeleton rows shown in an empty transcript while the first load is slow. */
export function TimelineSkeleton() {
  return (
    <div className="qw-skeleton" data-testid="tl-skeleton" role="status" aria-label="Loading messages">
      {[70, 90, 55, 80].map((w, i) => (
        <div key={i} className="qw-skel-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// ---- inline rename (walk 62) ------------------------------------------------------------
/** Double-click the text to edit. Enter / blur saves, Esc cancels. `onSave` gets the trimmed new name. */
export function InlineRename({
  value,
  onSave,
  children,
  className = "",
  disabled = false,
}: {
  value: string;
  onSave: (next: string) => Promise<void> | void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const begin = () => {
    if (disabled) return;
    done.current = false;
    setDraft(value);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = save ? renameOutcome(draft, value) : null;
    if (next) void Promise.resolve(onSave(next)).catch((e) => alert(`Rename failed: ${e}`));
  };
  const onKey = (e: KeyboardEvent) => {
    const act = renameKeyAction(e.key);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    finish(act === "save");
  };
  if (editing) {
    return (
      <input
        className={`qw-rename ${className}`}
        data-testid="inline-rename-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onKeyUp={(e) => e.stopPropagation()}
        onBlur={() => finish(true)}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        size={Math.max(8, draft.length + 1)}
      />
    );
  }
  return (
    <span className={className} title={disabled ? undefined : "Double-click to rename"} onDoubleClick={begin}>
      {children ?? value}
    </span>
  );
}

// ---- team + agent rename wrappers -------------------------------------------------------
export function TeamNameEdit({ team }: { team: Pick<TeamDef, "id" | "name"> }) {
  return (
    <InlineRename
      value={team.name}
      disabled={team.id === UNASSIGNED.id}
      onSave={async (name) => {
        await saveTeams((cur) => cur.map((t) => (t.id === team.id ? { ...t, name } : t)));
      }}
    >
      {team.name}
    </InlineRename>
  );
}

export function AgentTitleEdit({ agent, children }: { agent: PaseoAgent; children: ReactNode }) {
  return (
    <InlineRename
      value={renameDraftFor(agent)}
      disabled={!!agent.archivedAt}
      onSave={async (next) => {
        const { name, labels } = planAgentRename(agent, next);
        await updateAgent(agent.id, { name, ...(labels ? { labels } : {}) });
      }}
    >
      {children}
    </InlineRename>
  );
}

// ---- restore last view (walk 42) --------------------------------------------------------
/** Once the roster has loaded, drop restored tabs whose agent is gone or archived. Runs once per launch. */
export function useRestorePrune(agents: ReadonlyMap<string, PaseoAgent>, ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready || agents.size === 0) return;
    done.current = true;
    pruneRestoredTabs((id) => {
      const a = agents.get(id);
      return !!a && !a.archivedAt;
    });
    // Nothing left to show (restored agent gone or archived): land on the grid, not an empty pane.
    if (!getPanes().leftActiveId && !getPinFocus()) exitSquadsHome();
  }, [agents, ready]);
}
