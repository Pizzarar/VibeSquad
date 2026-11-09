import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PaseoAgent } from "./agentTypes";
import { removeLocalAgent, upsertLocalAgent, usePaseo } from "./paseo";
import { DEMO } from "./demoFlag";
import { useDraft } from "./drafts";
import { closeTab, openAgentInTab } from "./panes";
import { getTeams, isTopicBrainstorm, titleFor, topicOfBrainstorm, useTeams } from "./teams";
import { auditCardPin, laneDisplayName, type Pin } from "./pins";
import { isRemote } from "./remoteSession";
import type { TeamView } from "./teams";
import type { InboxCard, InboxScope, TeamDef } from "./types";

export const TOPIC_SOFT_CAP = 3;

export function isTouchMobileLayout(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(max-width: 600px)").matches ||
    (window.matchMedia("(pointer: coarse)").matches && window.innerWidth <= 900)
  );
}

export function isImeComposing(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return Boolean(
    e.isComposing ||
      e.nativeEvent?.isComposing ||
      (e as any).keyCode === 229 ||
      (e.nativeEvent as any)?.keyCode === 229,
  );
}

export function shouldComposerSubmit(e: React.KeyboardEvent): boolean {
  if (e.key !== "Enter" && e.code !== "Enter" && e.code !== "NumpadEnter") return false;
  if (isImeComposing(e)) return false;
  if (e.ctrlKey || e.metaKey) return true;
  if (e.shiftKey || e.altKey) return false;
  return !isTouchMobileLayout();
}

export const INBOX_LANES = ["main-game", "ui-lab", "plugins", "vibesquad", "site-polish"] as const;
export const INBOX_SCOPES: InboxScope[] = ["art", "mechanic", "plugin", "UI", "infra", "docs", "other"];

const LANE_COLORS: Record<string, string> = {
  "main-game": "#e8a33d",
  "ui-lab": "#ff9e3d",
  plugins: "#7c9cf5",
  vibesquad: "#b07cf5",
  "site-polish": "#5cc9a7",
};

export function laneColor(laneId: string): string {
  return LANE_COLORS[laneId] ?? "#00f0ff";
}

// ---- Shared reactive Inbox store (syncs Sidebar badge, AgentDrawer dump, and TeamPage panel) ----

const DEMO_INBOX_KEY = "vibesquad.demo.inbox";
const INBOX_OPEN_KEY = "vibesquad.inbox.open";

let cardsState: InboxCard[] = [];
let inboxOpenState: boolean = (() => {
  try {
    return localStorage.getItem(INBOX_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
})();
let lastNoticeState = "";
const listeners = new Set<() => void>();

function emitInbox() {
  listeners.forEach((l) => l());
}

export function subscribeInbox(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function getInboxCardsSnapshot(): InboxCard[] {
  return cardsState;
}

export function getInboxOpenSnapshot(): boolean {
  return inboxOpenState;
}

export function getInboxNoticeSnapshot(): string {
  return lastNoticeState;
}

export function setInboxOpen(open: boolean) {
  inboxOpenState = open;
  try {
    localStorage.setItem(INBOX_OPEN_KEY, open ? "1" : "0");
  } catch {}
  emitInbox();
}

export function toggleInboxOpen() {
  setInboxOpen(!inboxOpenState);
}

export function openAndScrollToInbox() {
  setInboxOpen(true);
  if (typeof document !== "undefined") {
    setTimeout(() => {
      const el = document.querySelector('[data-testid="idea-inbox"]');
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 40);
  }
}

/** Open ideas: parked, or accepted from triage (still actionable). Rejected/archived/handed-off leave the list. */
const isOpenIdea = (c: InboxCard) => c.status === "parked" || c.status === "accepted";

export function useInboxCards(): InboxCard[] {
  return useSyncExternalStore(subscribeInbox, getInboxCardsSnapshot);
}

export function useInboxOpen(): boolean {
  return useSyncExternalStore(subscribeInbox, getInboxOpenSnapshot);
}

export function useInboxNotice(): string {
  return useSyncExternalStore(subscribeInbox, getInboxNoticeSnapshot);
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
export function flashInboxNotice(msg: string) {
  lastNoticeState = msg;
  emitInbox();
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    lastNoticeState = "";
    emitInbox();
  }, 5000);
}

export async function refreshInboxCards(): Promise<InboxCard[]> {
  if (DEMO) {
    try {
      const raw = localStorage.getItem(DEMO_INBOX_KEY);
      cardsState = raw ? JSON.parse(raw) : [];
      emitInbox();
    } catch {}
    return cardsState;
  }
  try {
    const res = await fetch("/__vibesquad/inbox");
    const body = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(body.cards)) {
      cardsState = body.cards;
      emitInbox();
    }
  } catch {}
  return cardsState;
}

export async function parkIdeasInInbox(opts: {
  text?: string;
  ideas?: string[];
  teamId?: string;
  defaultLaneId?: string;
  laneId?: string;
  source?: string;
  splitDump?: boolean;
}): Promise<{ added: InboxCard[]; cards: InboxCard[]; summary: string }> {
  const { source, ...rest } = opts;
  const reqBody = isRemote()
    ? { ...rest, laneId: opts.laneId || opts.defaultLaneId }
    : { ...opts, laneId: opts.laneId || opts.defaultLaneId, ...(source !== undefined ? { source } : {}) };
  const res = await fetch("/__vibesquad/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `Inbox park failed (${res.status})`);
  }
  const added: InboxCard[] = Array.isArray(body.added) ? body.added : [];
  const cards: InboxCard[] = Array.isArray(body.cards) ? body.cards : cardsState;
  const summary: string = body.summary || `parked ${added.length} ideas → Inbox`;
  cardsState = cards;
  flashInboxNotice(summary);
  emitInbox();
  return { added, cards, summary };
}

export async function triageInbox(body: {
  action: "merge" | "bounce" | "update" | "delete" | "archive";
  targetId?: string;
  sourceIds?: string[];
  cardId?: string;
  teamId?: string;
  laneId?: string;
  scope?: InboxScope;
  patch?: Partial<InboxCard>;
  archive?: boolean;
}): Promise<{ card?: InboxCard; cards: InboxCard[] }> {
  const res = await fetch("/__vibesquad/inbox/triage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Inbox triage failed (${res.status})`);
  }
  if (Array.isArray(data.cards)) {
    cardsState = data.cards;
    emitInbox();
  } else {
    await refreshInboxCards();
  }
  return { card: data.card, cards: cardsState };
}

export async function openTopicFromCard(opts: {
  cardId: string;
  provider?: string;
  model?: string;
}): Promise<{ card: InboxCard; agent: PaseoAgent; title: string }> {
  const res = await fetch("/__vibesquad/inbox/open-topic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Open topic failed (${res.status})`);
  }
  if (Array.isArray(data.cards)) {
    cardsState = data.cards;
  } else if (data.card) {
    cardsState = cardsState.map((c) => (c.id === data.card.id ? data.card : c));
  }
  const agent: PaseoAgent = data.agent;
  if (agent?.id) {
    upsertLocalAgent(agent);
    openAgentInTab(agent.id);
  }
  flashInboxNotice(`Opened ${data.title || agent?.title || "topic brainstorm"}`);
  emitInbox();
  return { card: data.card, agent, title: data.title || agent?.title || "" };
}

export async function handoffTopicBrainstormClient(opts: {
  cardId?: string;
  agentId: string;
  planNote?: string;
  summaryUpdate?: string;
  usedTokens?: number;
}): Promise<{ card?: InboxCard; cards: InboxCard[] }> {
  const res = await fetch("/__vibesquad/inbox/handoff-topic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !DEMO) {
    throw new Error(data.error ?? `Topic handoff failed (${res.status})`);
  }
  if (Array.isArray(data.cards)) {
    cardsState = data.cards;
  } else if (opts.cardId) {
    cardsState = cardsState.map((c) =>
      c.id === opts.cardId
        ? { ...c, status: "handed-off", handedOffAt: new Date().toISOString(), topicAgentId: null }
        : c,
    );
  }
  removeLocalAgent(opts.agentId);
  closeTab(opts.agentId);
  flashInboxNotice(`Handed off #${data.card?.id ?? opts.cardId ?? "topic"} & closed chat`);
  emitInbox();
  return { card: data.card, cards: cardsState };
}

export async function parkTopicBrainstormClient(opts: {
  cardId?: string;
  agentId: string;
  summaryNote?: string;
}): Promise<{ card?: InboxCard; cards: InboxCard[] }> {
  const res = await fetch("/__vibesquad/inbox/park-topic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !DEMO) {
    throw new Error(data.error ?? `Park topic failed (${res.status})`);
  }
  if (Array.isArray(data.cards)) {
    cardsState = data.cards;
  } else if (opts.cardId) {
    cardsState = cardsState.map((c) =>
      c.id === opts.cardId
        ? { ...c, status: "parked", topicAgentId: null, summaryNote: opts.summaryNote || c.summaryNote }
        : c,
    );
  }
  if (opts.agentId) {
    removeLocalAgent(opts.agentId);
    closeTab(opts.agentId);
  }
  flashInboxNotice(`Parked topic back to #${data.card?.id ?? opts.cardId ?? "card"}`);
  emitInbox();
  return { card: data.card, cards: cardsState };
}

export type OpenTopicEntry = {
  agentId: string;
  cardId: string;
  title: string;
  topic: string;
  openedAt: string;
  summaryNote: string;
};

export function useOpenTopicBrainstorms(): {
  openTopics: OpenTopicEntry[];
  count: number;
  oldest: OpenTopicEntry | null;
} {
  const { agents } = usePaseo();
  const cards = useInboxCards();

  return useMemo(() => {
    const byAgentId = new Map<string, OpenTopicEntry>();

    for (const a of agents.values()) {
      if (a.archivedAt || a.status === "closed" || !isTopicBrainstorm(a)) continue;
      const l = (a.labels ?? {}) as Record<string, string>;
      const cardId = l["vs.inbox-card-id"] || "";
      const matchingCard = cardId ? cards.find((c) => c.id === cardId) : cards.find((c) => c.topicAgentId === a.id);
      const topic = topicOfBrainstorm(a) || matchingCard?.title || a.title || a.id;
      const title = a.title || matchingCard?.topicTitle || titleFor("brainstorm", l.lane ?? "", { topic, laneId: l.lane });
      const openedAt = l["vs.opened-at"] || matchingCard?.topicOpenedAt || a.updatedAt || matchingCard?.updatedAt || "";
      byAgentId.set(a.id, {
        agentId: a.id,
        cardId: matchingCard?.id || cardId,
        title,
        topic,
        openedAt,
        summaryNote: matchingCard?.summaryNote || `Parked topic summary: ${topic}`,
      });
    }

    for (const c of cards) {
      if (c.status === "parked" && c.topicAgentId && !byAgentId.has(c.topicAgentId)) {
        byAgentId.set(c.topicAgentId, {
          agentId: c.topicAgentId,
          cardId: c.id,
          title: c.topicTitle || c.title,
          topic: c.title,
          openedAt: c.topicOpenedAt || c.updatedAt || c.createdAt || "",
          summaryNote: c.summaryNote || `Parked topic summary: ${c.title}`,
        });
      }
    }

    const openTopics = [...byAgentId.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    return {
      openTopics,
      count: openTopics.length,
      oldest: openTopics[0] ?? null,
    };
  }, [agents, cards]);
}

export const TopicCapBanner = memo(function TopicCapBanner({ minCount = TOPIC_SOFT_CAP + 1 }: { minCount?: number }) {
  const { count, oldest } = useOpenTopicBrainstorms();
  const [parking, setParking] = useState(false);

  if (count < minCount || !oldest) return null;

  const handleParkOldest = async () => {
    if (parking) return;
    setParking(true);
    try {
      await parkTopicBrainstormClient({
        cardId: oldest.cardId || undefined,
        agentId: oldest.agentId,
        summaryNote: oldest.summaryNote || `Parked topic summary (${oldest.title})`,
      });
    } catch (e) {
      alert(`Park oldest topic failed: ${e}`);
    } finally {
      setParking(false);
    }
  };

  return (
    <div className="topic-cap-banner" role="status" data-testid="topic-cap-banner">
      <span>
        Soft cap: {count} topic brainstorms open (target ≤ {TOPIC_SOFT_CAP}). Park the oldest topic (<b>{oldest.title}</b>) back to its card?
      </span>
      <button
        className="btn warn small btn-park-oldest-topic"
        disabled={parking}
        onClick={() => void handleParkOldest()}
        data-testid="btn-park-oldest-topic"
      >
        {parking ? "Parking…" : "📥 Park oldest back to card"}
      </button>
    </div>
  );
});

export const SidebarInboxBadge = memo(function SidebarInboxBadge({ onSelect }: { onSelect?: () => void }) {
  const cards = useInboxCards();
  const open = useInboxOpen();
  const parkedCount = useMemo(() => cards.filter(isOpenIdea).length, [cards]);

  useEffect(() => {
    void refreshInboxCards();
  }, []);

  return (
    <button
      className={`btn ghost small sidebar-inbox-badge ${open ? "on" : ""}`}
      onClick={() => {
        if (onSelect) onSelect();
        else openAndScrollToInbox();
      }}
      title="Open Idea Inbox on Team Page (0 tokens while parked)"
      data-testid="sidebar-inbox-badge"
    >
      <span>📥 Inbox ({parkedCount})</span>
    </button>
  );
});

/** True when a click landed on a control inside the card (checkbox, selects, buttons): those keep their own behaviour. */
export const isInboxControlClick = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest("button, select, input, label, a, textarea");

export const IdeaInbox = memo(function IdeaInbox({ team, view, onOpenLane }: { team: TeamDef; view?: TeamView; onOpenLane?: (pin: Pin) => void | Promise<unknown> }) {
  const open = useInboxOpen();
  const cards = useInboxCards();
  const notice = useInboxNotice();
  const [draft, setDraft, clearDraft] = useDraft("inbox:draft");
  const [laneFilter, setLaneFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const openAuditChat = (pin: Pin) => {
    setError("");
    void Promise.resolve(onOpenLane?.(pin)).catch((e) => setError(`Could not open ${pin.lane.name}: ${e}`));
  };

  const handleOpenTopic = async (cardId: string) => {
    if (openingId) return;
    setOpeningId(cardId);
    setError("");
    try {
      await openTopicFromCard({ cardId });
    } catch (e) {
      setError(String(e));
    } finally {
      setOpeningId(null);
    }
  };

  useEffect(() => {
    void refreshInboxCards();
    if (DEMO) return;
    const t = setInterval(() => document.hidden || void refreshInboxCards(), 12_000);
    const onVis = () => document.hidden || void refreshInboxCards();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const parkedCards = useMemo(() => cards.filter(isOpenIdea), [cards]);
  useTeams();
  const laneName = (id: string) => laneDisplayName(getTeams(), id);
  const teamLaneIds = useMemo(() => new Set((team.lanes ?? []).map((l) => l.id.toLowerCase())), [team]);

  const filteredCards = useMemo(() => {
    if (laneFilter === "all") return parkedCards;
    if (laneFilter === "team") {
      return parkedCards.filter(
        (c) =>
          teamLaneIds.has(c.laneId.toLowerCase()) ||
          c.teamId.toLowerCase() === team.id.toLowerCase() ||
          false,
      );
    }
    return parkedCards.filter((c) => c.laneId.toLowerCase() === laneFilter.toLowerCase());
  }, [parkedCards, laneFilter, teamLaneIds, team.id]);

  const handlePark = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await parkIdeasInInbox({
        text: trimmed,
        splitDump: true,
        defaultLaneId: team.lanes[0]?.id || "vibesquad",
        teamId: team.id,
        source: "ui",
      });
      clearDraft();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, team, clearDraft]);

  const handleBounce = async (cardId: string, newLane: string) => {
    if (!newLane) return;
    setError("");
    try {
      await triageInbox({ action: "bounce", cardId, teamId: team.id, laneId: newLane });
      flashInboxNotice(`Bounced #${cardId} → ${newLane}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleMerge = async (targetId: string, sourceIds: string[]) => {
    if (!targetId || !sourceIds.length) return;
    setError("");
    try {
      const card = parkedCards.find((c) => c.id === targetId);
      await triageInbox({
        action: "merge",
        targetId,
        sourceIds,
        teamId: team.id,
        laneId: card?.laneId || team.lanes[0]?.id || "vibesquad",
      });
      setSelectedIds((prev) => prev.filter((id) => !sourceIds.includes(id) && id !== targetId));
      flashInboxNotice(`Merged ${sourceIds.map((s) => `#${s}`).join(", ")} → #${targetId}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleArchive = async (cardId: string) => {
    setError("");
    try {
      const card = parkedCards.find((c) => c.id === cardId);
      await triageInbox({
        action: "archive",
        cardId,
        teamId: team.id,
        laneId: card?.laneId || team.lanes[0]?.id || "vibesquad",
      });
      setSelectedIds((prev) => prev.filter((id) => id !== cardId));
      flashInboxNotice(`Archived #${cardId}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleSelect = (cardId: string) => {
    setSelectedIds((prev) => (prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId]));
  };

  const mergeSelected = async () => {
    if (selectedIds.length < 2) return;
    const [targetId, ...sourceIds] = selectedIds;
    await handleMerge(targetId, sourceIds);
  };

  return (
    <section className="idea-inbox" data-testid="idea-inbox">
      <div className="inbox-header">
        <button className="cast-toggle inbox-toggle" onClick={toggleInboxOpen}>
          <span>
            {open ? "▾" : "▸"} 📥 IDEA INBOX ({parkedCards.length})
          </span>
          <span className="inbox-zero-cost muted small">0 TOKENS AT REST · CHEAP SORTER</span>
        </button>
        {notice && (
          <span className="inbox-notice" role="status" data-testid="inbox-notice">
            {notice}
          </span>
        )}
      </div>

      {open && (
        <div className="inbox-body">
          <TopicCapBanner minCount={TOPIC_SOFT_CAP} />
          <div className="inbox-composer">
            <textarea
              className="inbox-input"
              rows={draft.includes("\n") ? Math.min(5, draft.split(/\r?\n/).length) : 1}
              value={draft}
              placeholder="Type an idea or paste a multi-line dump (Enter to park · Shift+Enter for another line · 0 agents spawned)…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (shouldComposerSubmit(e)) {
                  e.preventDefault();
                  void handlePark();
                }
              }}
            />
            <button className="btn ok inbox-park-btn" disabled={busy || !draft.trim()} onClick={() => void handlePark()}>
              {busy ? "Parking…" : "+ Park Idea"}
            </button>
          </div>

          {error && <div className="stat-alert small">{error}</div>}

          <div className="inbox-toolbar">
            <div className="inbox-filters">
              <button
                className={`tchip ${laneFilter === "all" ? "on" : ""}`}
                onClick={() => setLaneFilter("all")}
              >
                All teams ({parkedCards.length})
              </button>
              <button
                className={`tchip ${laneFilter === "team" ? "on" : ""}`}
                onClick={() => setLaneFilter("team")}
              >
                {team.name}
              </button>
              {INBOX_LANES.map((lane) => {
                const count = parkedCards.filter((c) => c.laneId.toLowerCase() === lane).length;
                return (
                  <button
                    key={lane}
                    className={`tchip ${laneFilter === lane ? "on" : ""}`}
                    onClick={() => setLaneFilter(lane)}
                  >
                    {laneName(lane)} ({count})
                  </button>
                );
              })}
            </div>

            {selectedIds.length >= 2 && (
              <button className="btn small ok" onClick={() => void mergeSelected()}>
                Merge selected ({selectedIds.length}) → #{selectedIds[0]}
              </button>
            )}
          </div>

          {filteredCards.length === 0 ? (
            <div className="muted small inbox-empty">
              No parked ideas in this filter. Type above or use [📥 Park in Inbox] in any brainstorm chat.
            </div>
          ) : (
            <div className="inbox-card-list">
              {filteredCards.map((card) => {
                const relatedCard = card.relatedCardId
                  ? parkedCards.find((c) => c.id === card.relatedCardId)
                  : undefined;
                const otherCards = parkedCards.filter((c) => c.id !== card.id);
                const isSelected = selectedIds.includes(card.id);
                const isHighlighted = highlightId === card.id;
                const lColor = laneColor(card.laneId);

                const auditPin = view && onOpenLane ? auditCardPin(view, card) : null;
                return (
                  <div
                    key={card.id}
                    id={`inbox-card-${card.id}`}
                    className={`inbox-card ${isSelected ? "selected" : ""} ${isHighlighted ? "highlighted" : ""}`}
                    data-testid={`inbox-card-${card.id}`}
                    {...(auditPin && {
                      role: "link",
                      tabIndex: 0,
                      title: `Open ${auditPin.lane.name} chat`,
                      "data-audit-finding": "true",
                      onClick: (e: React.MouseEvent) => {
                        if (!isInboxControlClick(e.target)) openAuditChat(auditPin);
                      },
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) openAuditChat(auditPin);
                      },
                    })}
                  >
                    <div className="inbox-card-top">
                      <label className="inbox-card-check" title="Select to merge multiple cards">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(card.id)}
                        />
                        <span className="inbox-id-badge">#{card.id}</span>
                      </label>
                      <span
                        className="inbox-lane-pill"
                        style={{ color: lColor, borderColor: lColor }}
                      >
                        {laneName(card.laneId)}
                      </span>
                      <span className={`inbox-scope-badge scope-${card.scope.toLowerCase()}`}>
                        {card.scope}
                      </span>
                      <strong className="inbox-card-title">{card.title}</strong>
                      {card.status === "accepted" && <span className="inbox-merged-badge">accepted</span>}
                      {card.mergedFromIds && card.mergedFromIds.length > 0 && (
                        <span className="inbox-merged-badge" title={`Merged from: ${card.mergedFromIds.join(", ")}`}>
                          merged ({card.mergedFromIds.map((id) => `#${id}`).join(", ")})
                        </span>
                      )}
                      <div className="inbox-card-triage">
                        {!isRemote() && (
                          <button
                            className="btn small ok inbox-open-topic-btn"
                            disabled={openingId === card.id}
                            onClick={() => void handleOpenTopic(card.id)}
                            title="Spawn or focus a scoped topic brainstorm (<Code> Buddy · <topic>) seeded only with this card + team brief"
                            data-testid={`inbox-open-topic-${card.id}`}
                          >
                            {openingId === card.id ? "Opening…" : "💬 Open Topic"}
                          </button>
                        )}
                        <select
                          className="inbox-select"
                          value=""
                          aria-label={`Move ${card.id} to another team`}
                          onChange={(e) => {
                            if (e.target.value) void handleBounce(card.id, e.target.value);
                          }}
                        >
                          <option value="">Move to team ▾</option>
                          {INBOX_LANES.filter((l) => l !== card.laneId).map((l) => (
                            <option key={l} value={l}>
                              → {laneName(l)}
                            </option>
                          ))}
                        </select>
                        {otherCards.length > 0 && (
                          <select
                            className="inbox-select"
                            value=""
                            aria-label={`Merge ${card.id} into another card`}
                            onChange={(e) => {
                              if (e.target.value) void handleMerge(e.target.value, [card.id]);
                            }}
                          >
                            <option value="">Merge into ▾</option>
                            {otherCards.map((other) => (
                              <option key={other.id} value={other.id}>
                                #{other.id} · {other.title}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          className="btn ghost small inbox-archive-btn"
                          title="Archive idea card"
                          onClick={() => void handleArchive(card.id)}
                        >
                          × Archive
                        </button>
                      </div>
                    </div>

                    <div className="inbox-card-text">{card.text}</div>

                    {card.summaryNote && (
                      <div className="inbox-card-summary-note" data-testid={`inbox-card-note-${card.id}`}>
                        📝 Saved summary: {card.summaryNote}
                      </div>
                    )}

                    {card.relatedCardId && (
                      <div className="inbox-related-row">
                        <button
                          className="inbox-related-chip"
                          onClick={() => {
                            setHighlightId(card.relatedCardId ?? null);
                            setTimeout(() => setHighlightId(null), 2000);
                          }}
                          title={card.relatedReason || `Goes with #${card.relatedCardId}`}
                        >
                          ↳ goes with #{card.relatedCardId}
                          {relatedCard ? ` (${relatedCard.title})` : ""}
                        </button>
                        {relatedCard && (
                          <button
                            className="btn small ok inbox-oneclick-merge"
                            onClick={() => void handleMerge(card.relatedCardId!, [card.id])}
                            title={`Merge #${card.id} into #${card.relatedCardId}`}
                          >
                            Merge
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
});
