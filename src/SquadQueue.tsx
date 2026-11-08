// Squad floor phase 1: the squad-wide "Needs you" queue on the hub page. Pure UI over agent state:
// permissions first, then oldest first; one click on a row opens that chat.
import { useEffect, useState } from "react";
import { answerItem, clearItem, formatAge, itemSince, laterItem, squadQueue, type AttentionDeps, type AttentionItem } from "./attentionItems";
import { clearUnreadLocal, dismissLocal, snoozeLocal } from "./attentionLocal";
import { respondToPermission } from "./PermissionCard";
import { bumpAgents, clearAgentAttention, clearNeedsYou, snoozeNeedsYou } from "./paseo";
import { openPinMember } from "./pinFocus";
import { hubPinForSquad, pinsForSquad, type Pin } from "./pins";
import { Avatar } from "./pixel";
import { queueStripState } from "./skyZonesLogic";
import type { Member, TeamView } from "./teams";

const deps: AttentionDeps = {
  clearNeedsYou: (a) => clearNeedsYou(a, { optimistic: true }),
  snoozeNeedsYou: (a, ms) => snoozeNeedsYou(a, ms, { optimistic: true }),
  clearAgentAttention: (id) => clearAgentAttention(id),
  respondToPermission,
  snoozeLocal,
  dismissLocal,
  clearUnreadLocal: (id) => clearUnreadLocal(id),
  now: () => Date.now(),
  after: (ms, fn) => void setTimeout(fn, Math.min(ms, 2 ** 31 - 1)),
  refresh: bumpAgents,
};

function Row({ item, member, lane, now, onOpen, onError }: { item: AttentionItem; member: Member | undefined; lane: string; now: number; onOpen: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const age = formatAge(itemSince(item), now);
  return (
    <li className={`sq-row attn-${item.kind}`} data-testid={`sq-row-${item.id}`}>
      <button
        type="button"
        className="sq-open"
        title="Open this chat"
        onClick={() => {
          if (item.kind === "unread") deps.clearUnreadLocal(item.id); // opening it is reading it
          onOpen();
        }}
      >
        <Avatar id={item.agent.id} provider={item.agent.provider} agentType={member?.agentType ?? "unknown"} size={28} />
        <span className="sq-text">
          <span className="sq-who">
            <b>{item.who}</b>
            <span className="sq-lane muted small">{lane}</span>
          </span>
          <span className="sq-reason">{item.reason}</span>
        </span>
        <span className="sq-age muted small" data-testid="sq-age">{age}</span>
      </button>
      <div className="sq-actions">
        {item.kind === "permission" ? (
          item.quickPermission && (
            <>
              <button className="btn ok small" disabled={busy} data-testid="sq-approve" onClick={() => run(() => answerItem(item, "allow", deps))}>
                Approve
              </button>
              <button className="btn bad small" disabled={busy} data-testid="sq-deny" onClick={() => run(() => answerItem(item, "deny", deps))}>
                Deny
              </button>
            </>
          )
        ) : (
          <>
            <button className="btn ghost small" disabled={busy} data-testid="sq-later" title="Hide for 2 hours" onClick={() => run(() => laterItem(item, deps))}>
              Later
            </button>
            <button className="btn ok small" disabled={busy} data-testid="sq-clear" onClick={() => run(() => clearItem(item, deps))}>
              Clear
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** `strip` = the sky-gods hub (docs/PLAN_SKY_GODS_C2B.md G3): a horizontal row in the clouds above the roof that collapses to a thin line when empty. */
export function SquadQueue({ view, variant = "panel" }: { view: TeamView; variant?: "panel" | "strip" }) {
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = squadQueue(view.members);
  const { pinned, done } = pinsForSquad(view, { includeHidden: true });
  const hub = hubPinForSquad(view);
  const pins: Pin[] = [...pinned, ...done, ...(hub ? [hub] : [])];
  const byId = new Map(view.members.map((m) => [m.agent.id, m]));
  const laneName = (m: Member | undefined) => view.team.lanes.find((l) => l.id === m?.laneId)?.name ?? (m?.laneId ? m.laneId : "RiffBot");
  if (variant === "strip" && queueStripState(items.length) === "empty") {
    return <aside className="sq-panel sq-strip is-empty" data-testid="squad-queue" data-strip="empty" aria-label="Needs you: nobody" title="Nobody needs you" />;
  }
  return (
    <aside className={`sq-panel${variant === "strip" ? " sq-strip" : ""}`} data-testid="squad-queue" data-strip={variant === "strip" ? "open" : undefined} aria-label="Needs you">
      <div className="sq-head">
        <b>Needs you</b>
        <span className="muted small">{items.length}</span>
      </div>
      {err && <div className="attn-err">{err}</div>}
      {items.length === 0 ? (
        <div className="sq-empty muted" data-testid="sq-empty">Nobody needs you</div>
      ) : (
        <ul className="sq-rows">
          {items.map((i) => {
            const m = byId.get(i.id);
            const pin = pins.find((p) => p.lane.id === m?.laneId) ?? hub;
            return <Row key={i.id} item={i} member={m} lane={laneName(m)} now={now} onError={setErr} onOpen={() => pin && openPinMember(pin, i.id)} />;
          })}
        </ul>
      )}
    </aside>
  );
}
