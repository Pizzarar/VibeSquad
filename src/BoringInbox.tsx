import { useEffect, useState } from "react";
import { answerItem, attentionItems, clearItem, formatAge, itemSince, laterItem, type AttentionDeps, type AttentionItem } from "./attentionItems";
import { clearUnreadLocal, dismissLocal, snoozeLocal } from "./attentionLocal";
import type { FeedEntry } from "./demo";
import { bumpAgents, clearAgentAttention, clearNeedsYou, snoozeNeedsYou } from "./paseo";
import { respondToPermission } from "./PermissionCard";
import { formatDisplayTitle } from "./identity";
import { boringLocationLane } from "./boringLocation";
import type { Member, TeamView } from "./teams";
import { cleanTitle } from "./ui";
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

export type NeedsYouRow = { item: AttentionItem; member: Member; view: TeamView; teamId: string; project: string; lane: string; age: string; since: number; who: string };
type DoneLog = { teamId: string; project: string; entries: FeedEntry[] };

/** What the row says: for a permission, the tool and its command ("Bash: rg --stats"); otherwise the attention reason. */
export function needsYouReason(item: Pick<AttentionItem, "kind" | "reason" | "agent">): string {
  if (item.kind !== "permission") return item.reason;
  const p = item.agent.pendingPermissions?.[0] as { name?: string; title?: string; input?: Record<string, unknown>; detail?: Record<string, unknown> } | undefined;
  if (!p) return item.reason;
  const tool = p.name ?? p.title;
  const arg = [p.input?.command, p.detail?.command, p.input?.file_path, p.input?.path, p.input?.pattern].find((v): v is string => typeof v === "string" && v.length > 0);
  if (!tool) return item.reason;
  if (!arg && typeof p.title === "string" && p.title.startsWith(tool)) return p.title;
  return arg ? `${tool}: ${arg}` : tool;
}

/** Opening a row: an `unread` row is read once opened (same as SquadQueue). */
export function openNeedsYouRow(row: NeedsYouRow, onOpen: (row: NeedsYouRow) => void, clearUnread: (id: string) => void = deps.clearUnreadLocal): void {
  if (row.item.kind === "unread") clearUnread(row.item.id);
  onOpen(row);
}

export const NEEDS_YOU_VISIBLE = 5;
export const RECENT_DONE_VISIBLE = 8;
const KIND_RANK: Record<AttentionItem["kind"], number> = { permission: 0, label: 1, unread: 1, error: 2, stalled: 3, finished: 4 };

/**
 * What the row calls the agent. Leads and Buddies are named from their resolved labels with formatDisplayTitle (hub lead = "Overlord",
 * hub Buddy = "RiffBot", "★ MAIN GAME ord75" = lane code + ord); anything without the labels falls back to cleanTitle ("★ LEAD · Plugins" = "Plugins").
 */
export function needsYouTitle(item: Pick<AttentionItem, "who">, member: Pick<Member, "kind" | "agent">, lane: { laneName?: string; laneId?: string; hub?: boolean }): string {
  const l = (member.agent.labels ?? {}) as Record<string, string>;
  const fallback = cleanTitle(item.who);
  if (member.kind === "lead" && (l.ord || lane.hub)) return formatDisplayTitle({ role: "lead", ...lane, ord: l.ord, job: l.job }).replace(/^★s*/, "");
  if (member.kind === "brainstorm" && lane.hub && !l.topic?.trim()) return formatDisplayTitle({ role: "brainstorm", ...lane });
  return fallback;
}

/** Cross-project queue: permission › question/pick (needs-you label, marked unread) › error › stalled › finished; oldest first within a rank. */
export function needsYouRows(views: TeamView[], now = Date.now()): NeedsYouRow[] {
  const rows: NeedsYouRow[] = [];
  for (const view of views) {
    const byId = new Map(view.members.map((m) => [m.agent.id, m]));
    for (const item of attentionItems(view.members, now)) {
      const member = byId.get(item.id);
      if (!member) continue;
      const laneDef = view.team.lanes.find((l) => l.id === member.laneId);
      const lane = boringLocationLane(view.team, member.laneId, view.lanes?.map((l) => l.lane));
      const hub = lane === "Desk";
      const since = itemSince(item);
      const who = needsYouTitle(item, member, { laneName: laneDef?.name, laneId: member.laneId ?? undefined, hub });
      rows.push({ item, member, view, teamId: view.team.id, project: view.team.name, lane, age: formatAge(since, now), since: since ?? Infinity, who });
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

type DoneItem = { key: string; text: string; where: string; age: string; ts: number; row?: NeedsYouRow };
/** Done recently: agents that finished and wait to be read, plus the newest `done` log entries; newest first, capped. */
export function doneRecently(finished: NeedsYouRow[], logs: DoneLog[], limit = RECENT_DONE_VISIBLE, now = Date.now(), views: TeamView[] = []): DoneItem[] {
  const fromAgents: DoneItem[] = finished.map((r) => ({ key: `fin|${r.item.id}`, text: needsYouReason(r.item), where: `${r.project} › ${r.lane}`, age: r.age, ts: Number.isFinite(r.since) ? r.since : 0, row: r }));
  const fromLog: DoneItem[] = recentDone(logs, limit).map((d) => ({ key: `${d.teamId}|${d.entry.ts}|${d.entry.agent}`, text: d.entry.text, where: `${d.project} › ${boringLocationLane(views.find((v) => v.team.id === d.teamId)?.team ?? { id: d.teamId, lanes: [] }, d.entry.lane, views.find((v) => v.team.id === d.teamId)?.lanes?.map((l) => l.lane))}`, age: formatAge(Date.parse(d.entry.ts), now), ts: Date.parse(d.entry.ts) || 0 }));
  return [...fromAgents, ...fromLog].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function BoringInbox({ views, onOpen, now: nowProp, logs: injected }: { views: TeamView[]; onOpen: (row: NeedsYouRow) => void; now?: number; logs?: DoneLog[] }) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (nowProp !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [nowProp]);
  const now = nowProp ?? tick;
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
  const all = needsYouRows(views, now);
  // Finished work is not a request: it lists under Done recently, so the count always equals the rows above it.
  const rows = all.filter((r) => r.item.kind !== "finished");
  const finished = all.filter((r) => r.item.kind === "finished");
  const shown = showAll ? rows : rows.slice(0, NEEDS_YOU_VISIBLE);
  const done = doneRecently(finished, injected ?? fetched, RECENT_DONE_VISIBLE, now, views);
  const run = (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr(null);
    fn().catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null));
  };
  /** Hover `⋯` menu (shown on row hover or keyboard focus): Snooze for 2h / Dismiss. Permissions are answered, never dismissed. */
  const menu = (r: NeedsYouRow) => {
    const { item } = r;
    const dis = busy === item.id;
    return (
      <div className="boring-needs-menu-wrap">
        <button type="button" className="boring-needs-more" data-testid={`boring-needs-menu-${item.id}`} aria-haspopup="menu" aria-label={`More actions for ${r.who}`} title="More actions">⋯</button>
        <div className="boring-needs-menu" role="menu">
          <button type="button" role="menuitem" className="boring-needs-menu-item" disabled={dis} data-testid="boring-needs-snooze" onClick={() => run(item.id, () => laterItem(item, deps))}>Snooze 2h</button>
          {item.kind !== "permission" && (
            <button type="button" role="menuitem" className="boring-needs-menu-item" disabled={dis} data-testid="boring-needs-dismiss" onClick={() => run(item.id, () => clearItem(item, deps))}>Dismiss</button>
          )}
        </div>
      </div>
    );
  };
  return (
    <section className="boring-needs-you" data-testid="boring-needs-you" aria-label="Needs you">
      <div className="boring-section-label boring-needs-head">
        <span>Needs you</span>
        {rows.length > 0 && <span className="badge boring-badge" data-testid="boring-needs-you-count">{rows.length}</span>}
        <kbd className="boring-kbd" title="Open the top NEEDS YOU agent">Ctrl+J</kbd>
      </div>
      {err && <div className="boring-needs-err" role="alert">{err}</div>}
      {rows.length === 0 ? (
        <p className="boring-muted" data-testid="boring-needs-you-empty">All clear. Nobody needs you.</p>
      ) : (
        <ul className="boring-needs-rows">
          {shown.map((r) => {
            const { item } = r;
            const dis = busy === item.id;
            const quick = item.kind === "permission" && item.quickPermission;
            return (
              <li key={item.id} className={`boring-needs-item attn-${item.kind}`} data-testid="boring-needs-you-item" data-kind={item.kind}>
                <div className="boring-needs-line">
                  <button type="button" className="boring-needs-open" data-testid={`boring-needs-open-${item.id}`} title={`${r.who}: ${needsYouReason(item)}`} onClick={() => openNeedsYouRow(r, onOpen)}>
                    <span className={`boring-dot st-${item.kind === "error" ? "err" : item.kind === "stalled" ? "stalled" : "attn"}`} />
                    <span className="boring-needs-who">{r.who}</span>
                    <span className="boring-conv-age">{r.age}</span>
                  </button>
                  {menu(r)}
                </div>
                <div className="boring-needs-why" title={`${needsYouReason(item)} · ${r.project} › ${r.lane}`}>
                  <span className="boring-needs-reason">{needsYouReason(item)}</span>
                  <span className="boring-needs-where" data-testid="boring-needs-where">{r.project} › {r.lane}</span>
                </div>
                  {quick && (
                    <span className="boring-needs-actions">
                      <button type="button" className="boring-needs-btn ok" disabled={dis} data-testid="boring-needs-allow" onClick={() => run(item.id, () => answerItem(item, "allow", deps))}>Allow</button>
                      <button type="button" className="boring-needs-btn bad" disabled={dis} data-testid="boring-needs-deny" onClick={() => run(item.id, () => answerItem(item, "deny", deps))}>Deny</button>
                    </span>
                  )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > NEEDS_YOU_VISIBLE && (
        <button type="button" className="boring-idle-toggle" data-testid="boring-needs-you-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "▾ Show fewer" : `▸ + ${rows.length - NEEDS_YOU_VISIBLE} more`}
        </button>
      )}
      <div className="boring-recent-done" data-testid="boring-recent-done">
        <button type="button" className="boring-idle-toggle" data-testid="boring-recent-done-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
          {doneOpen ? "▾" : "▸"} Done recently ({done.length})
        </button>
        {doneOpen && (
          <ul className="boring-done-rows">
            {done.map((d) =>
              d.row ? (
                <li key={`fin|${d.row.item.id}`} className="boring-done-row" data-testid="boring-recent-done-item" data-kind="finished" title={d.text}>
                  <button type="button" className="boring-needs-open boring-done-open" data-testid={`boring-needs-open-${d.row.item.id}`} onClick={() => openNeedsYouRow(d.row!, onOpen)}>
                    <span className="boring-dot st-done" />
                    <span className="boring-done-text">{d.row.who}: {d.text}</span>
                  </button>
                  {menu(d.row)}
                  <span className="boring-needs-where">{d.where} · {d.age}</span>
                </li>
              ) : (
                <li key={d.key} className="boring-done-row" data-testid="boring-recent-done-item" title={d.text}>
                  <div className="boring-needs-line"><span className="boring-dot st-done" /><span className="boring-done-text">{d.text}</span></div>
                  <span className="boring-needs-where">{d.where} · {d.age}</span>
                </li>
              ),
            )}
            {done.length === 0 && <li className="boring-muted">No finished work logged yet.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}
