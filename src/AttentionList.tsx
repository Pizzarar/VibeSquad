import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  answerItem,
  attentionItems,
  clearAll,
  clearItem,
  countedItems,
  laterItem,
  type AttentionDeps,
  type AttentionItem,
} from "./attentionItems";
import { clearUnreadLocal, dismissLocal, snoozeLocal } from "./attentionLocal";
import { respondToPermission } from "./PermissionCard";
import { bumpAgents, clearAgentAttention, clearNeedsYou, snoozeNeedsYou } from "./paseo";
import type { TeamView } from "./teams";

const deps: AttentionDeps = {
  clearNeedsYou,
  snoozeNeedsYou,
  clearAgentAttention,
  respondToPermission,
  snoozeLocal,
  dismissLocal,
  clearUnreadLocal,
  now: () => Date.now(),
  after: (ms, fn) => void setTimeout(fn, Math.min(ms, 2 ** 31 - 1)),
  refresh: bumpAgents,
};

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  permission: "PERMISSION",
  label: "NEEDS YOU",
  unread: "UNREAD",
  error: "ERROR",
  finished: "FINISHED",
};

function Row({ item, onOpen, onError }: { item: AttentionItem; onOpen: (id: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <li className={`attn-row attn-${item.kind}`} data-testid={`attn-row-${item.id}`}>
      <div className="attn-who">
        <b>{item.who}</b>
        <span className="attn-kind">{KIND_LABEL[item.kind]}</span>
      </div>
      <div className="attn-reason">{item.reason}</div>
      <div className="attn-actions">
        <button
          className="btn ghost small"
          onClick={() => {
            if (item.kind === "unread") clearUnreadLocal(item.id); // opening it is reading it
            onOpen(item.id);
          }}
        >
          Open
        </button>
        {item.kind === "permission" ? (
          item.quickPermission && (
            <>
              <button className="btn ok small" disabled={busy} data-testid="attn-approve" onClick={() => run(() => answerItem(item, "allow", deps))}>
                Approve
              </button>
              <button className="btn bad small" disabled={busy} data-testid="attn-deny" onClick={() => run(() => answerItem(item, "deny", deps))}>
                Deny
              </button>
            </>
          )
        ) : (
          <>
            <button className="btn ghost small" disabled={busy} data-testid="attn-later" title="Hide for 2 hours" onClick={() => run(() => laterItem(item, deps))}>
              Later
            </button>
            <button className="btn ok small" disabled={busy} data-testid="attn-clear" onClick={() => run(() => clearItem(item, deps))}>
              Clear
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function Popover({ view, anchor, onClose, onOpen }: { view: TeamView; anchor: DOMRect; onClose: () => void; onOpen: (id: string) => void }) {
  const items = attentionItems(view.members);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);
  const clearable = items.filter((i) => i.kind !== "permission");
  const counted = countedItems(items).length;
  const style = { top: Math.min(anchor.bottom + 6, window.innerHeight - 120), left: Math.max(8, Math.min(anchor.left, window.innerWidth - 360)) };
  return createPortal(
    <div className="attn-pop" ref={ref} style={style} role="dialog" aria-label={`${view.team.name} needs you`} data-testid="attn-list">
      <div className="attn-head">
        <b>{view.team.name}</b> · {counted} need you
        <button className="btn ghost small attn-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {err && <div className="attn-err">{err}</div>}
      <ul className="attn-rows">
        {items.map((i) => (
          <Row
            key={i.id}
            item={i}
            onError={setErr}
            onOpen={(id) => {
              onClose();
              onOpen(id);
            }}
          />
        ))}
      </ul>
      {clearable.length > 0 && (
        <div className="attn-foot">
          <button
            className={`btn small ${confirm ? "bad" : "ghost"}`}
            data-testid="attn-clear-all"
            onClick={() => {
              if (!confirm) return setConfirm(true);
              setConfirm(false);
              void clearAll(items, deps).then((r) => r.failed && setErr(`${r.failed} could not be cleared`));
            }}
          >
            {confirm ? `Tap again to clear ${clearable.length}` : "Clear all"}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The pink badge: click opens the list of everything needing attention in this team. */
export function AttentionBadge({
  view,
  onOpen,
  className = "badge alert",
  testId,
  children,
}: {
  view: TeamView;
  onOpen: (agentId: string) => void;
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className={className}
        data-testid={testId}
        title={`${view.needsYou} need you: click to review`}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
        }}
      >
        {children ?? view.needsYou}
      </button>
      {anchor && <Popover view={view} anchor={anchor} onClose={() => setAnchor(null)} onOpen={onOpen} />}
    </>
  );
}
