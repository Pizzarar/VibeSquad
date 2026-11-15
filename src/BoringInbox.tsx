import { useEffect, useState } from "react";
import { answerItem, attentionItems, clearItem, formatAge, itemSince, type AttentionDeps, type AttentionItem } from "./attentionItems";
import { clearUnreadLocal, dismissLocal, snoozeLocal } from "./attentionLocal";
import type { FeedEntry } from "./demo";
import { bumpAgents, clearAgentAttention, clearNeedsYou, snoozeNeedsYou } from "./paseo";
import { respondToPermission } from "./PermissionCard";
import type { Member, TeamView } from "./teams";
import { fetchLog } from "./TeamFeed";

// D2 2.2 (docs/PLAN_DESK_UX_REDESIGN.md): the Normal-mode top-of-sidebar attention strip across every project.
// Labelled NEEDS YOU, never "Inbox": "Idea Inbox" stays the parked-ideas backlog. Thanks to Antigravity by Google DeepMind.

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

export type NeedsYouRow = { item: AttentionItem; member: Member; view: TeamView; teamId: string; project: string; lane: string; age: string; since: number };
type DoneLog = { teamId: string; project: string; entries: FeedEntry[] };

export const NEEDS_YOU_VISIBLE = 6;
export const RECENT_DONE_VISIBLE = 8;
const KIND_RANK: Record<AttentionItem["kind"], number> = { permission: 0, label: 1, unread: 1, error: 2, finished: 3 };

/** Cross-project queue: permission › question/pick (needs-you label, marked unread) › error › finished; oldest first within a rank. */
export function needsYouRows(views: TeamView[], now = Date.now()): NeedsYouRow[] {
  const rows: NeedsYouRow[] = [];
  for (const view of views) {
    const byId = new Map(view.members.map((m) => [m.agent.id, m]));
    for (const item of attentionItems(view.members)) {
      const member = byId.get(item.id);
      if (!member) continue;
      const lane = view.team.lanes.find((l) => l.id === member.laneId)?.name;
      const since = itemSince(item);
      rows.push({ item, member, view, teamId: view.team.id, project: view.team.name, lane: lane ?? (member.laneId ? member.laneId : "Project desk"), age: formatAge(since, now), since: since ?? Infinity });
    }
  }
  return rows.sort((a, b) => KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] || (a.since === b.since ? 0 : a.since - b.since));
}

export type DoneRow = { entry: FeedEntry; project: string; teamId: string };
/** Newest `done` entries across every Squad. */
export function recentDone(logs: DoneLog[], limit = 12): DoneRow[] {
  const out: DoneRow[] = [];
  for (const l of logs) for (const entry of l.entries) if (entry.type === "done") out.push({ entry, project: l.project, teamId: l.teamId });
  return out.sort((a, b) => b.entry.ts.localeCompare(a.entry.ts)).slice(0, limit);
}

export function BoringInbox({ views, onOpen, now = Date.now(), logs: injected }: { views: TeamView[]; onOpen: (row: NeedsYouRow) => void; now?: number; logs?: DoneLog[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [fetched, setFetched] = useState<DoneLog[]>([]);
  const teamKey = views.map((v) => v.team.id).join("|");
  useEffect(() => {
    if (injected) return;
    let live = true;
    Promise.all(views.map((v) => fetchLog(v.team.id).then((entries) => ({ teamId: v.team.id, project: v.team.name, entries }), () => null))).then((all) => {
      if (live) setFetched(all.filter((x): x is DoneLog => x !== null));
    });
    return () => { live = false; };
  }, [teamKey, injected]);
  const rows = needsYouRows(views, now);
  const shown = showAll ? rows : rows.slice(0, NEEDS_YOU_VISIBLE);
  const done = recentDone(injected ?? fetched, RECENT_DONE_VISIBLE);
  const run = (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr(null);
    fn().catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null));
  };
  const counted = rows.filter((r) => r.item.kind !== "finished").length;
  return (
    <section className="boring-needs-you" data-testid="boring-needs-you" aria-label="Needs you">
      <div className="boring-section-label boring-needs-head">
        <span>NEEDS YOU</span>
        {counted > 0 && <span className="badge boring-badge" data-testid="boring-needs-you-count">{counted}</span>}
        <kbd className="boring-kbd" title="Open the top NEEDS YOU agent">Ctrl+J</kbd>
      </div>
      {err && <div className="boring-needs-err" role="alert">{err}</div>}
      {rows.length === 0 ? (
        <p className="boring-muted" data-testid="boring-needs-you-empty">Nobody needs you.</p>
      ) : (
        <ul className="boring-needs-rows">
          {shown.map((r) => {
            const { item } = r;
            const dis = busy === item.id;
            return (
              <li key={item.id} className={`boring-needs-item attn-${item.kind}`} data-testid="boring-needs-you-item" data-kind={item.kind}>
                <button type="button" className="boring-needs-open" data-testid={`boring-needs-open-${item.id}`} title={item.reason} onClick={() => onOpen(r)}>
                  <span className={`boring-dot st-${item.kind === "error" ? "err" : item.kind === "finished" ? "done" : "attn"}`} />
                  <span className="boring-needs-who">{item.who}</span>
                  <span className="boring-conv-age">{r.age}</span>
                </button>
                <div className="boring-needs-why" title={item.reason}>{item.reason}</div>
                <div className="boring-needs-where">{r.project} › {r.lane}</div>
                <div className="boring-needs-actions">
                  {item.kind === "permission" && item.quickPermission && (
                    <>
                      <button type="button" className="boring-needs-btn ok" disabled={dis} data-testid="boring-needs-allow" onClick={() => run(item.id, () => answerItem(item, "allow", deps))}>Allow</button>
                      <button type="button" className="boring-needs-btn bad" disabled={dis} data-testid="boring-needs-deny" onClick={() => run(item.id, () => answerItem(item, "deny", deps))}>Deny</button>
                    </>
                  )}
                  {item.kind !== "permission" && (
                    <button type="button" className="boring-needs-btn" disabled={dis} data-testid="boring-needs-dismiss" onClick={() => run(item.id, () => clearItem(item, deps))}>Dismiss</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > NEEDS_YOU_VISIBLE && (
        <button type="button" className="boring-idle-toggle" data-testid="boring-needs-you-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "▾ Show fewer" : `▸ ${rows.length - NEEDS_YOU_VISIBLE} more`}
        </button>
      )}
      <div className="boring-recent-done" data-testid="boring-recent-done">
        <button type="button" className="boring-idle-toggle" data-testid="boring-recent-done-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
          {doneOpen ? "▾" : "▸"} Recent done ({done.length})
        </button>
        {doneOpen && (
          <ul className="boring-done-rows">
            {done.map((d) => (
              <li key={`${d.teamId}|${d.entry.ts}|${d.entry.agent}`} className="boring-done-row" data-testid="boring-recent-done-item" title={d.entry.text}>
                <span className="boring-dot st-done" />
                <span className="boring-done-text">{d.entry.text}</span>
                <span className="boring-needs-where">{d.project}{d.entry.lane ? ` › ${d.entry.lane}` : ""} · {formatAge(Date.parse(d.entry.ts), now)}</span>
              </li>
            ))}
            {done.length === 0 && <li className="boring-muted">No finished work logged yet.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}
