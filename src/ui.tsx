import { memo, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { archiveAgent, getPaseoState, stopAgent, subscribePaseo } from "./paseo";
import { auditAntigravityAgent } from "./antigravity";
import { useUserName } from "./userName";
import {
  AGENT_TYPE_LABEL,
  alertLabel,
  MAX_TREE_DEPTH,
  OWNER_LABEL,
  attentionOf,
  brainstormUsedTokens,
  budgetFor,
  buildTeamViews,
  buildTree,
  fmtTok,
  getBrainstormThresholds,
  getTeamsVersion,
  isBrainstormAgent,
  isOverBudget,
  leadLadderFor,
  leadVariant,
  resolve,
  subscribeTeams,
  teamForAgent,
  usedTokens,
  WORKER_BUDGET,
  type AgentTree,
  type Member,
  type TeamDef,
  type TeamView,
} from "./teams";
import { Avatar, TokenMeter, providerSpec } from "./pixel";
import { getPanes, modeFromEvent, openAgent, subscribePanes, useAgentPane } from "./panes";

export function ago(iso?: string | null, now = Date.now()): string {
  if (!iso) return "?";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const shortPath = (p: string) => p.split(/[\\/]+/).filter(Boolean).slice(-1)[0] ?? p;

// Neon status indicator: cyan = running, violet = idle, hot-pink = alert/attention/error, slate = closed.
export function StatusDot({ agent }: { agent: PaseoAgent }) {
  const att = attentionOf(agent);
  const cls = att && att.tone !== "finished" ? `attn-${att.tone}` : agent.status;
  return <span className={`signal ${cls}`} title={att?.reason ?? agent.status} />;
}

// Strip legacy display prefixes and "(talk here: ...)" suffix for compact card headers.
export const cleanTitle = (t?: string | null) => {
  let s = (t ?? "untitled").replace(/\s*\(talk here[^)]*\)/gi, "").trim();
  const lower = s.toLowerCase();
  if (lower.startsWith("★ lead · ")) s = s.slice("★ lead · ".length).trim();
  else if (lower.startsWith("brainstorm · ")) s = s.slice("brainstorm · ".length).trim();
  return s;
};

const needsYou = (m: Member) => m.attention && m.attention.tone !== "finished";

// Compact Brainstorm context pill for cards & rows (BF-P1).
export function BrainstormCtxPill({ agent, team }: { agent: PaseoAgent; team?: TeamDef }) {
  if (!isBrainstormAgent(agent)) return null;
  const used = brainstormUsedTokens(agent);
  const { warnTokens, restartTokens } = getBrainstormThresholds(team ?? teamForAgent(agent).team);
  const usedK = Math.round(used / 1000);
  const restartK = Math.round(restartTokens / 1000);
  const warnK = Math.round(warnTokens / 1000);
  const pct = Math.min(100, Math.max(0, (used / Math.max(1, restartTokens)) * 100));
  const warnPct = Math.min(100, Math.max(0, (warnTokens / Math.max(1, restartTokens)) * 100));
  const tone = used >= restartTokens ? "red" : used >= warnTokens ? "amber" : "ok";
  return (
    <div
      className={`brainstorm-ctx-pill tone-${tone}`}
      title={`Brainstorm context: ${usedK}k / ${restartK}k tok (warn at ${warnK}k, auto-restart at ${restartK}k)`}
    >
      <span className="brainstorm-ctx-readout">
        {usedK}k / {restartK}k tok
      </span>
      <span className="brainstorm-ctx-track">
        <i className={`brainstorm-ctx-fill tone-${tone}`} style={{ width: `${pct}%` }} />
        <span className="brainstorm-ctx-marker" style={{ left: `${warnPct}%` }} title={`Warn threshold (${warnK}k)`} />
      </span>
    </div>
  );
}

// Two-tap button: first tap arms it (auto-disarms after 4s), second tap confirms.
export function ConfirmButton(props: {
  label: string;
  armedLabel: string;
  busyLabel: string;
  tone?: "danger" | "warn" | "cool";
  onConfirm: () => Promise<void> | void;
  className?: string;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "armed" | "busy">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "busy") return;
    if (state === "idle") {
      setState("armed");
      timer.current = setTimeout(() => setState("idle"), 4000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setState("busy");
    try {
      await props.onConfirm();
    } catch (err) {
      alert(`${props.label} failed: ${err}`);
    } finally {
      setState("idle");
    }
  };

  const text = state === "busy" ? props.busyLabel : state === "armed" ? props.armedLabel : props.label;
  return (
    <button
      className={`btn confirm ${props.tone ?? "danger"} ${state} ${props.className ?? ""}`}
      disabled={state === "busy"}
      title={props.title}
      onClick={click}
    >
      {text}
    </button>
  );
}

// Stop on running agents; Archive on the rest when asked for.
export function AgentActions({ agent, archive }: { agent: PaseoAgent; archive?: boolean }) {
  if (agent.archivedAt) return null;
  if (agent.status === "running")
    return (
      <ConfirmButton label="Stop" armedLabel="Tap to stop" busyLabel="Stopping…" tone="danger" onConfirm={() => stopAgent(agent.id)} />
    );
  if (archive)
    return (
      <ConfirmButton
        label="Archive"
        armedLabel="Tap to archive"
        busyLabel="Archiving…"
        tone="warn"
        onConfirm={async () => void (await archiveAgent(agent.id))}
      />
    );
  return null;
}

export const clickable = (onClick: () => void) => ({
  role: "button" as const,
  tabIndex: 0,
  onClick,
  // Middle click opens a background tab (modeFromEvent reads the auxclick).
  onAuxClick: (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onClick();
    }
  },
  onKeyDown: (e: KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onClick();
    }
  },
});

// ---- one shared clock --------------------------------------------------------------
// A single interval for the whole page, paused while the tab is hidden. Components read it
// through useClock() and only re-render when the value they derive from it changes.

const TICK_MS = 5_000;
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setInterval> | undefined;
const tickListeners = new Set<() => void>();
const fireTick = () => {
  tickNow = Date.now();
  tickListeners.forEach((l) => l());
};
const syncTicker = () => {
  const want = tickListeners.size > 0 && !document.hidden;
  if (want && !tickTimer) tickTimer = setInterval(fireTick, TICK_MS);
  else if (!want && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) fireTick();
  syncTicker();
});
function subscribeTick(l: () => void) {
  if (!tickListeners.size) tickNow = Date.now();
  tickListeners.add(l);
  syncTicker();
  return () => {
    tickListeners.delete(l);
    syncTicker();
  };
}

/** Re-render on every shared tick so age-based detectors (stalled, hung) fire without a daemon update. */
export const useTick = (): number => useSyncExternalStore(subscribeTick, () => tickNow);

/** Re-render only when `read(now)` changes between ticks. `read` must return a primitive. */
export const useClock = <T extends string | number | boolean>(read: (now: number) => T): T =>
  useSyncExternalStore(subscribeTick, () => read(tickNow));

/** Relative age ("5m") that refreshes itself without re-rendering its parent. */
export function Ago({ iso }: { iso?: string | null }) {
  return <>{useClock((now) => ago(iso, now))}</>;
}

// ---- selection ---------------------------------------------------------------------
// Opening an agent opens (or focuses) its tab in panes.ts. The click's modifiers pick the pane:
// plain = active pane, Shift = other pane (opens the split), Ctrl/Cmd/middle = background tab.
// Rows subscribe to their own pane slice, so a tab change re-renders only rows whose mark flips.

export function selectAgent(id: string | null) {
  if (id) openAgent(id, modeFromEvent());
}
export const useSelectedId = () => useSyncExternalStore(subscribePanes, () => getActiveId());
const getActiveId = () => {
  const s = getPanes();
  return s.activePane === "right" && s.split ? s.rightActiveId : s.leftActiveId;
};
/** Open in a tab (either pane). */
export const useIsSelected = (id: string) => useAgentPane(id) !== null;
/** Row classes for an open agent: lit edge, cyan for the left pane, violet for the right. */
export function usePaneClass(id: string): string {
  const pane = useAgentPane(id);
  return pane ? `sel pane-${pane}` : "";
}

// ---- derived members / tree / views ------------------------------------------------

type Derived = { agents: Map<string, PaseoAgent> | null; tv: number; members: Member[]; tree: AgentTree; views: TeamView[] };
let dc: Derived = { agents: null, tv: -1, members: [], tree: buildTree([]), views: [] };

export const sameList = <T,>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

/** Members, tree and team views for the current store, recomputed once per agents/teams change. */
export function derived(): Derived {
  const { agents } = getPaseoState();
  const tv = getTeamsVersion();
  if (agents !== dc.agents || tv !== dc.tv) {
    const members = resolve(agents);
    // A team whose members are all the same objects keeps its old view, so its memoized UI skips.
    const views = buildTeamViews(members).map((v) => {
      const old = dc.views.find((o) => o.team === v.team);
      return old && sameList(old.members, v.members) ? old : v;
    });
    dc = { agents, tv, members, tree: buildTree(members), views };
  }
  return dc;
}

/** useSyncExternalStore with a custom equality, so a selector may build a fresh array each call. */
export function useSelect<T>(subscribe: (l: () => void) => () => void, read: () => T, eq: (a: T, b: T) => boolean): T {
  const last = useRef<{ v: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const v = read();
    if (last.current && eq(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  });
}

/** Memo comparator: would these two members render the same row, card or pill? */
export function sameMember(a: Member | null, b: Member | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = a.agent;
  const y = b.agent;
  const xl = (x.labels ?? {}) as Record<string, string>;
  const yl = (y.labels ?? {}) as Record<string, string>;
  return (
    a.kind === b.kind &&
    a.agentType === b.agentType &&
    a.team === b.team &&
    a.laneId === b.laneId &&
    a.attention?.tone === b.attention?.tone &&
    a.attention?.reason === b.attention?.reason &&
    (x === y ||
      (x.id === y.id &&
        x.updatedAt === y.updatedAt &&
        x.status === y.status &&
        x.requiresAttention === y.requiresAttention &&
        (x.pendingPermissions?.length ?? 0) === (y.pendingPermissions?.length ?? 0) &&
        x.lastUsage?.contextWindowUsedTokens === y.lastUsage?.contextWindowUsedTokens &&
        xl["vs.mock-tokens"] === yl["vs.mock-tokens"] &&
        xl["vs.restarted-from"] === yl["vs.restarted-from"] &&
        xl.topic === yl.topic &&
        xl["vs.inbox-card-id"] === yl["vs.inbox-card-id"] &&
        x.title === y.title &&
        x.model === y.model &&
        x.cwd === y.cwd &&
        x.archivedAt === y.archivedAt))
  );
}

// What DiagBadges shows, as a string, so a clock tick only re-renders badges that changed.
const diagKey = (m: Member, now: number) => {
  const audit = auditAntigravityAgent(m.agent, [], now);
  const a4 = audit.a4TransientError;
  return `${audit.a1Stalled?.message ?? ""}|${a4 && a4.retryable ? `${a4.kind}|${a4.summary}` : ""}`;
};

/** Compact warning pills: Antigravity stalled / retryable error, and over-budget workers. */
export const DiagBadges = memo(
  function DiagBadges({ m }: { m: Member }) {
    useClock((now) => diagKey(m, now));
    const audit = auditAntigravityAgent(m.agent, [], tickNow);
    const a4 = audit.a4TransientError;
    const over = isOverBudget(m);
    if (!audit.a1Stalled && !(a4 && a4.retryable) && !over) return null;
    return (
      <span className="diag-pills">
        {audit.a1Stalled && (
          <span className="pill diag warn" title={audit.a1Stalled.message}>
            STALLED &gt;90S
          </span>
        )}
        {a4 && a4.retryable && (
          <span className="pill diag warn" title={a4.summary}>
            RETRYABLE: {a4.kind.toUpperCase()}
          </span>
        )}
        {over && (
          <span className="pill diag hot" title={`${usedTokens(m)} tokens used, worker budget ${WORKER_BUDGET}`}>
            OVER BUDGET · {fmtTok(usedTokens(m))}/{fmtTok(WORKER_BUDGET)}
          </span>
        )}
      </span>
    );
  },
  (p, n) => sameMember(p.m, n.m),
);

type RowProps = { m: Member; onPick: (id: string) => void; archive?: boolean; caret?: boolean };

export const AgentRow = memo(
  function AgentRow({ m, onPick, archive, caret }: RowProps) {
    const a = m.agent;
    const paneCls = usePaneClass(a.id);
    const prov = providerSpec(a.provider);
    return (
      <div className={`row ${paneCls} ${a.status}`} {...clickable(() => onPick(a.id))}>
        <Avatar id={a.id} provider={a.provider} agentType={m.agentType} variant={leadVariant(m)} size={32} />
        <span className="row-title">
          {caret && <TreeCaret id={a.id} />}
          <StatusDot agent={a} />
          <span className="row-name">{(a.title ?? a.id.slice(0, 8)).replace(/\s*\(talk here[^)]*\)/gi, "").trim()}</span>
          <span className="role-tag">{AGENT_TYPE_LABEL[m.agentType]}</span>
          <DiagBadges m={m} />
        </span>
        {needsYou(m) && <span className={`pill ${m.attention!.tone}`}>{m.attention!.reason}</span>}
        <span className="row-meta">
          <span className="prov-inline" style={{ color: prov.color }}>
            {prov.symbol} {a.model ?? a.provider}
          </span>{" "}
          · {shortPath(a.cwd)} · <Ago iso={a.updatedAt} />
        </span>
        <span className="row-actions">
          <AgentActions agent={a} archive={archive} />
        </span>
        <span className="row-meter">
          {m.kind === "brainstorm" || isBrainstormAgent(a) ? (
            <BrainstormCtxPill agent={a} team={m.team} />
          ) : (
            <TokenMeter
              used={a.lastUsage?.contextWindowUsedTokens}
              budget={budgetFor(m)}
              ladder={m.kind === "lead" ? leadLadderFor(m.team) : undefined}
            />
          )}
        </span>
      </div>
    );
  },
  (p, n) => sameMember(p.m, n.m) && p.onPick === n.onPick && p.archive === n.archive && p.caret === n.caret,
);

// ---- alerts ------------------------------------------------------------------------

const shortName = (m: Member) => {
  const t = cleanTitle(m.agent.title);
  return t.length > 18 ? t.slice(0, 17) + "…" : t;
};

type AlertPillProps = { m: Member; onOpen: (id: string) => void; named?: boolean };

/**
 * Alert marker: who raised it (LEAD / WORKER / BRAINSTORM + short name) and its type.
 * One click opens exactly the agent that raised it.
 */
export const AlertPill = memo(
  function AlertPill({ m, onOpen, named = true }: AlertPillProps) {
    const att = m.attention;
    const userName = useUserName();
    if (!att) return null;
    return (
      <button
        className={`alert-pill tone-${att.tone}`}
        title={`${m.agent.title ?? m.agent.id}: ${att.reason}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(m.agent.id);
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          e.stopPropagation();
          onOpen(m.agent.id);
        }}
      >
        <b className="alert-owner">{OWNER_LABEL[m.kind]}</b>
        {named && <span className="alert-who">{shortName(m)}</span>}
        <span className="alert-type">{alertLabel(att.tone, userName)}</span>
      </button>
    );
  },
  (p, n) => sameMember(p.m, n.m) && p.onOpen === n.onOpen && p.named === n.named,
);

const TONE_ORDER = { permission: 0, "needs-you": 1, error: 2, finished: 3 } as const;
export const alertOrder = (a: Member, b: Member) => TONE_ORDER[a.attention!.tone] - TONE_ORDER[b.attention!.tone];

// ---- nested agent tree ---------------------------------------------------------------

const TREE_KEY = "vibesquad.tree.open";
const CLOSED_KEY = "vibesquad.tree.closed";
let treeOpen = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(TREE_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);
let treeShowClosed = localStorage.getItem(CLOSED_KEY) === "1";
const treeListeners = new Set<() => void>();
let snap = { open: treeOpen, showClosed: treeShowClosed };
const emitTree = () => {
  snap = { open: treeOpen, showClosed: treeShowClosed };
  treeListeners.forEach((l) => l());
};

export function toggleTreeOpen(id: string) {
  treeOpen = new Set(treeOpen);
  if (treeOpen.has(id)) treeOpen.delete(id);
  else treeOpen.add(id);
  localStorage.setItem(TREE_KEY, JSON.stringify([...treeOpen]));
  emitTree();
}

export function setTreeShowClosed(v: boolean) {
  treeShowClosed = v;
  localStorage.setItem(CLOSED_KEY, v ? "1" : "0");
  emitTree();
}

const subscribeTreeState = (l: () => void) => {
  treeListeners.add(l);
  return () => void treeListeners.delete(l);
};

/** Open/closed per agent id (persisted) and the shared "Show closed" toggle. */
export function useTreeState(): { open: Set<string>; showClosed: boolean } {
  return useSyncExternalStore(subscribeTreeState, () => snap);
}

export const getTreeState = () => snap;

// Tree consumers re-read on agent, team and open/closed changes, but each one re-renders only
// when its own slice (caret counts, children list) changes.
export const subscribeTree = (l: () => void) => {
  const a = subscribePaseo(l);
  const b = subscribeTeams(l);
  const c = subscribeTreeState(l);
  return () => {
    a();
    b();
    c();
  };
};
const NONE: Member[] = [];

/** Expand/collapse caret. Its own click target: never opens the drawer. Null when there are no children. */
export function TreeCaret({ id }: { id: string }) {
  const key = useSyncExternalStore(subscribeTree, () => {
    const { tree } = derived();
    const total = tree.totalDescendants(id, snap.showClosed);
    return total ? `${total}|${tree.runningDescendants(id)}|${snap.open.has(id) ? 1 : 0}` : "";
  });
  if (!key) return null;
  const [total, running, open] = key.split("|").map(Number);
  const isOpen = open === 1;
  return (
    <button
      className={`tree-caret ${isOpen ? "open" : ""} ${running ? "live" : ""}`}
      title={`${total} below (${running} running)`}
      aria-expanded={isOpen}
      onClick={(e) => {
        e.stopPropagation();
        toggleTreeOpen(id);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {isOpen ? "▼" : "▶"}
      {!isOpen && <span className="tree-count">{running ? `${running} running` : total}</span>}
    </button>
  );
}

type TreeRowProps = { m: Member; depth: number; last: boolean; onPick: (id: string) => void; compact?: boolean };

const TreeRow = memo(
  function TreeRow({ m, depth, last, onPick, compact }: TreeRowProps) {
    const a = m.agent;
    const paneCls = usePaneClass(a.id);
    return (
      <div
        className={`tree-row ${compact ? "compact" : ""} ${paneCls} ${a.status} ${last ? "last" : ""}`}
        style={{ paddingLeft: depth * 16 }}
        {...clickable(() => onPick(a.id))}
        title={a.title ?? ""}
      >
        <span className="tree-elbow" style={{ left: depth * 16 - 10 }} />
        <Avatar id={a.id} provider={a.provider} agentType={m.agentType} variant={leadVariant(m)} size={28} />
        <span className="tree-main">
          <span className="tree-name-line">
            <StatusDot agent={a} />
            <span className="row-name">{cleanTitle(a.title) || a.id.slice(0, 8)}</span>
            {!compact && <span className="role-tag">{AGENT_TYPE_LABEL[m.agentType]}</span>}
            <TreeCaret id={a.id} />
          </span>
          <TokenMeter
            used={a.lastUsage?.contextWindowUsedTokens}
            budget={budgetFor(m)}
            ladder={m.kind === "lead" ? leadLadderFor(m.team) : undefined}
          />
          {compact && m.attention && <AlertPill m={m} onOpen={onPick} named={false} />}
        </span>
        {!compact && m.attention && <AlertPill m={m} onOpen={onPick} named={false} />}
      </div>
    );
  },
  (p, n) => sameMember(p.m, n.m) && p.depth === n.depth && p.last === n.last && p.onPick === n.onPick && p.compact === n.compact,
);

/** Children of `parentId` inline, recursing into any child that is expanded too. */
export const TreeChildren = memo(function TreeChildren({
  parentId,
  depth = 1,
  onPick,
  compact,
}: {
  parentId: string;
  depth?: number;
  onPick: (id: string) => void;
  compact?: boolean;
}) {
  const kids = useSelect(
    subscribeTree,
    () => (snap.open.has(parentId) && depth <= MAX_TREE_DEPTH ? derived().tree.childrenOf(parentId, snap.showClosed) : NONE),
    sameList,
  );
  if (!kids.length) return null;
  return (
    <div className={`tree-branch depth-${depth}`} style={{ "--tree-x": `${depth * 16 - 10}px` } as React.CSSProperties}>
      {kids.map((c, i) => (
        <div key={c.agent.id} className="tree-node">
          <TreeRow m={c} depth={depth} last={i === kids.length - 1} onPick={onPick} compact={compact} />
          <TreeChildren parentId={c.agent.id} depth={depth + 1} onPick={onPick} compact={compact} />
        </div>
      ))}
    </div>
  );
});

export {
  IdeaInbox,
  SidebarInboxBadge,
  TOPIC_SOFT_CAP,
  TopicCapBanner,
  handoffTopicBrainstormClient,
  openAndScrollToInbox,
  openTopicFromCard,
  parkIdeasInInbox,
  parkTopicBrainstormClient,
  refreshInboxCards,
  setInboxOpen,
  toggleInboxOpen,
  triageInbox,
  useInboxCards,
  useInboxNotice,
  useInboxOpen,
  useOpenTopicBrainstorms,
} from "./IdeaInbox";
