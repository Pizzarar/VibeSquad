// Pinned teams, step 1 (docs/PLAN_PINNED_FEATURES.md §1): the default squad page is a grid of pinned
// Teams, and the sidebar lists the same pins. Clicking a pin opens its live Brainstorm in today's drawer;
// with no live Brainstorm the caller's onQuickStart(pin) decides what happens (src/pinActions.ts openPin).
// FULL brings back the old plumbing view (agent cards, workers, handoff, folders, retired agents).
import { AttentionBadge } from "./AttentionList";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getPaseoState, markAgentRead, sendMessage } from "./paseo";
import { isRunnerId, runnerHandle } from "./runnerBridge";
import { DEMO } from "./demoFlag";
import { openContextMenu } from "./CommandPalette";
import { demoTimeline } from "./demo";
import { chipIconSrc, hasLooksDone, gridPinsForSquad, hubPinForSquad, isHubPin, liveBuddyDupes, liveBuddyId, looksDoneFor, LOOKS_DONE_MARKER, perfectionPin, pinsForSquad, quickBugsChipState, SEND_TO_MARKER, snapChipSize, topicOfBrainstorm, withoutSpinOffFence, type Pin } from "./pins";
import { createQuickBugsPin, keepPinBuddy, openBriefEditor, openPin as openPinAction } from "./pinActions";
import { openPinMember, usePinFocus } from "./pinFocus";
import { useIsShown } from "./panes";
import { IdeaBox, IdeaPlusTile, noteSendTo, SendToCard, showPinToast, SpinOffCard, useSendTo, useSpinOff } from "./PinIdeas";
import { PinMenu } from "./PinMenu";
import { DoneRow, DoneShelf, LooksDoneCard, useDoneShelfOpen } from "./PinDone";
import { countsAsNeedsYou, getBrainstormThresholds, isHubLane, saveTeams, type Member, type TeamView } from "./teams";
import { ConfirmButton, StatusDot, usePaneClass } from "./ui";
import { Avatar, TeamEmblem } from "./pixel";
import { UsageDashboard } from "./UsageDashboard";
import { laneCodeOf, ordOf } from "./teams";
import { laneCodeFor } from "./identity";
import { cleanTitle } from "./ui";
import { PixelIcon } from "./PixelIcon";
import { pickLead } from "./pinFocusLogic";
import { useDpr, useImageOk, useTheme } from "./useBotFace";
import { useUiScale } from "./uiScale";

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
      {full ? <><PixelIcon name="teams" alt="" fallback="⊞" /> TEAMS</> : "FULL"}
    </button>
  );
}

export type PinHandler = (pin: Pin) => void | Promise<unknown>;

export function pinByKey(views: TeamView[], key: { squadId: string; laneId: string }): Pin | null {
  for (const v of views) {
    if (v.team.id !== key.squadId) continue;
    const { pinned, done } = pinsForSquad(v, { includeHidden: true });
    const hit = [...pinned, ...done].find((p) => p.lane.id === key.laneId);
    if (hit) return hit;
    const hub = hubPinForSquad(v);
    if (hub && hub.lane.id === key.laneId) return hub;
  }
  return null;
}

export async function ensureHubLaneRegistered(pin: Pin): Promise<void> {
  if (isHubLane(pin.squad, pin.lane) && !pin.squad.lanes.some((l) => isHubLane(pin.squad, l) && l.state !== "removed")) {
    await saveTeams((cur) =>
      cur.map((t) =>
        t.id !== pin.squad.id
          ? t
          : {
              ...t,
              lanes: [{ id: pin.lane.id, name: "RiffBot", hub: true, state: "pinned" }, ...t.lanes.filter((l) => l.id !== pin.lane.id)],
            },
      ),
    );
  }
}

export async function openPin(pin: Pin, profile?: string): Promise<string> {
  await ensureHubLaneRegistered(pin);
  return openPinAction(pin, profile ? { profile } : undefined);
}

/** Opens the live Brainstorm, or hands the pin to onQuickStart (the Spin Up picker) when there is none or it is closed. */
export function openPinOr(pin: Pin, onOpenAgent: (id: string) => void, onQuickStart: PinHandler) {
  const live = liveBuddyId(pin);
  if (live) onOpenAgent(live);
  else {
    void ensureHubLaneRegistered(pin);
    return onQuickStart(pin);
  }
}

// ── Context meter for the live Brainstorm ────────────────────────────────────
function PinCtx({ pin, showLabel }: { pin: Pin; showLabel?: boolean }) {
  if (!pin.brainstorm) return null;
  if (!showLabel && (pin.brainstorm.agent.status === "closed" || pin.contextUsed <= 0)) return null;
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

export async function markPinRead(pin: Pin): Promise<void> {
  const members =
    (pin.lane as { members?: Member[] }).members ??
    ([pin.brainstorm, pin.lead, ...(pin.workers ?? []), ...(pin.topicBrainstorms ?? []), ...(pin.duplicateBrainstorms ?? [])].filter(
      Boolean,
    ) as Member[]);
  await Promise.all(members.filter(countsAsNeedsYou).map((m) => markAgentRead(m.agent)));
}

export function NeedsBadge({ pin }: { pin: Pin }) {
  if (!pin.needsYou) return null;
  return (
    <button
      type="button"
      className="badge alert pin-needs"
      data-testid={`pin-needs-${pin.lane.id}`}
      title={`${pin.needsYou} need you — click to mark read`}
      onClick={(e) => {
        e.stopPropagation();
        void markPinRead(pin);
      }}
    >
      {pin.needsYou}
    </button>
  );
}

// ── Team under a Buddy: its Lead, workers and topic Buddies (rail card) ──
/** NeedsBadge for use INSIDE another button (the sidebar pin rows): a <button> in a <button> is invalid HTML and a React hydration error, so this is the same badge as a role=button span. */
export function NeedsBadgeInline({ pin }: { pin: Pin }) {
  if (!pin.needsYou) return null;
  const mark = () => void markPinRead(pin);
  return (
    <span
      role="button"
      tabIndex={0}
      className="badge alert pin-needs"
      data-testid={`pin-needs-${pin.lane.id}`}
      title={`${pin.needsYou} need you — click to mark read`}
      onClick={(e) => {
        e.stopPropagation();
        mark();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        mark();
      }}
    >
      {pin.needsYou}
    </span>
  );
}

const memberTitle = (m: Member) => cleanTitle(m.agent.title) || m.agent.id.slice(0, 8);
const hasTeam = (pin: Pin) => !!pin.lead || pin.workers.length > 0 || pin.topicBrainstorms.length > 0;
/** Team-row status label: a queued agent shows its queue position instead of the bare running/idle. */
const memberStatusLabel = (agent: { status: string; queued?: { ahead: number } }): string =>
  agent.queued ? `queued · ${agent.queued.ahead} ahead` : agent.status === "running" ? "running" : "idle";

function TeamRow({ pin, m, glyph, depth, testId, active }: { pin: Pin; m: Member; glyph: string; depth: number; testId: string; active: boolean }) {
  const shown = useIsShown(m.agent.id);
  const rawTitle = memberTitle(m);
  const cleanTitle = rawTitle.replace(/^(?:[★💬•]\s*)+/, "");
  return (
    <button
      type="button"
      className={`pin-team-row ${active || shown ? "on" : ""}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      data-testid={testId}
      title={`Open ${rawTitle} (${m.agent.status})`}
      onClick={() => openPinMember(pin, m.agent.id)}
    >
      <StatusDot agent={m.agent} />
      <span className="pin-row-name">
        {glyph} {cleanTitle}
      </span>
      <span className="muted small">{memberStatusLabel(m.agent)}</span>
    </button>
  );
}

// Visible without opening "Completed": working, starting, erroring, or anything still asking for the owner.
const isActiveWorker = (w: Member) =>
  w.agent.status === "running" ||
  w.agent.status === "initializing" ||
  w.agent.status === "error" ||
  countsAsNeedsYou(w) ||
  Boolean(w.attention && w.attention.tone !== "finished");

/** Buddy, Lead and running workers; finished workers and topic Buddies sit behind a collapsed "Completed" toggle. */
export function PinTeamRows({ pin, withBuddy, prefix }: { pin: Pin; withBuddy?: boolean; prefix: string }) {
  const bs = pin.brainstorm;
  const [showDone, setShowDone] = useState(false);
  const running = pin.workers.filter(isActiveWorker);
  const completed = pin.workers.filter((w) => !isActiveWorker(w));
  const wDepth = withBuddy ? 2 : 1;
  return (
    <>
      {withBuddy && bs && <TeamRow pin={pin} m={bs} glyph="💬" depth={0} testId={`${prefix}-buddy`} active={false} />}
      {pin.lead && <TeamRow pin={pin} m={pin.lead} glyph="★" depth={withBuddy ? 1 : 0} testId={`${prefix}-lead`} active={false} />}
      {running.map((w) => (
        <TeamRow key={w.agent.id} pin={pin} m={w} glyph="•" depth={wDepth} testId={`${prefix}-worker-${w.agent.id}`} active={false} />
      ))}
      {pin.topicBrainstorms.map((t) => (
        <TeamRow key={t.agent.id} pin={pin} m={t} glyph="💬" depth={withBuddy ? 1 : 0} testId={`${prefix}-topic-${t.agent.id}`} active={false} />
      ))}
      {completed.length > 0 && (
        <button
          type="button"
          className="pin-team-row pin-team-completed"
          style={{ paddingLeft: 6 + wDepth * 14 }}
          aria-expanded={showDone}
          data-testid={`${prefix}-completed-toggle`}
          onClick={() => setShowDone((v) => !v)}
        >
          <span className="muted small">
            {showDone ? "▾" : "▸"} Completed ({completed.length})
          </span>
        </button>
      )}
      {showDone &&
        completed.map((w) => (
          <TeamRow key={w.agent.id} pin={pin} m={w} glyph="•" depth={wDepth} testId={`${prefix}-worker-${w.agent.id}`} active={false} />
        ))}
    </>
  );
}

/** The rail card's "Team under this Buddy" tree. */
export function PinTeamTree({ pin }: { pin: Pin }) {
  if (!pin.brainstorm && !hasTeam(pin)) return null;
  return (
    <div className="pin-rail-team-tree" data-testid="pin-rail-team-tree">
      <div className="pin-rail-section-label">Team in this Lane</div>
      <PinTeamRows pin={pin} withBuddy prefix="pin-team" />
    </div>
  );
}

// ── Sidebar: a squad's pins + a collapsed Done shelf ─────────────────────────
/** The `@<code>` handle for a pin: stored `code`, else the generated one, else the id's first 3 letters. */
function laneHandleOf(pin: Pin): string {
  const c = (pin.lane.code || laneCodeFor(pin.lane.id, [pin.squad]) || pin.lane.id.slice(0, 3)).toLowerCase();
  return `@${c}`;
}

const PinRow = memo(function PinRow({ pin, dimmed, onPin }: { pin: Pin; dimmed?: boolean; onPin: (pin: Pin) => void }) {
  const paneCls = usePaneClass(pin.brainstorm?.agent.id ?? "");
  const focus = usePinFocus();
  const isSelected = focus ? focus.squadId === pin.squad.id && focus.laneId === pin.lane.id : Boolean(paneCls);
  return (
    <>
      <div className="pin-row-wrap">
        <button
          type="button"
          className={`pin-row ${isSelected ? (paneCls || "sel pane-left") : ""} ${pin.brainstorm ? "" : "no-session"} ${dimmed ? "done" : ""}`}
          data-testid={`sidebar-pin-${pin.lane.id}`}
          title={pin.brainstorm ? `Open ${pin.lane.name}` : `${pin.lane.name}: no session yet · click to start`}
          onClick={() => {
            void ensureHubLaneRegistered(pin);
            onPin(pin);
          }}
        >
          <PinDot pin={pin} />
          <span className="pin-row-name">{isHubPin(pin) ? "RiffBot" : pin.lane.name}</span>
          <span className="pin-lane-handle" data-testid={`pin-handle-${pin.lane.id}`}>{laneHandleOf(pin)}</span>
          {pin.brainstorm?.agent.queued && (
            <span className="pin-row-status muted small">{`queued · ${pin.brainstorm.agent.queued.ahead} ahead`}</span>
          )}
          <NeedsBadgeInline pin={pin} />
          <PinCtx pin={pin} />
        </button>
        {!isHubPin(pin) && <PinMenu pin={pin} onShowPlumbing={() => setFullView(true)} />}
      </div>
    </>
  );
});

export const SidebarRiffBot = memo(function SidebarRiffBot({ pin, onPin }: { pin: Pin; onPin?: (pin: Pin) => void }) {
  const bs = pin.brainstorm;
  const paneCls = usePaneClass(bs?.agent.id ?? "");
  const focus = usePinFocus();
  const isSelected = focus ? focus.squadId === pin.squad.id && focus.laneId === pin.lane.id : Boolean(paneCls);
  const statusMod = bs?.agent.status === "running" ? "is-running" : bs && bs.agent.status !== "closed" ? "is-live" : "is-ready";
  return (
    <button
      type="button"
      className={`sidebar-riffbot ${isSelected ? (paneCls || "sel pane-left") : ""} ${statusMod}`}
      data-testid={`sidebar-riffbot-${pin.squad.id}`}
      title={bs ? `Open RiffBot (${pin.squad.name} Hub)` : `Start RiffBot for ${pin.squad.name}`}
      onClick={() => {
        void ensureHubLaneRegistered(pin);
        if (onPin) onPin(pin);
        else void openPin(pin);
      }}
    >
      <PinDot pin={pin} />
      <span className="sidebar-riffbot-badge">RIFFBOT</span>
      <span className="sidebar-riffbot-title">Squad Hub</span>
      {pin.needsYou > 0 ? (
        <NeedsBadgeInline pin={pin} />
      ) : bs?.agent.status === "running" ? (
        <span className="sidebar-riffbot-state running">THINKING</span>
      ) : bs && bs.agent.status !== "closed" ? (
        <span className="sidebar-riffbot-state live">LIVE</span>
      ) : (
        <span className="sidebar-riffbot-state ready">READY</span>
      )}
      <PinCtx pin={pin} />
    </button>
  );
});

export function SidebarPins({ view, onPin, onOpenAgent }: { view: TeamView; onPin: (pin: Pin) => void; onOpenAgent?: (id: string) => void }) {
  const hub = hubPinForSquad(view);
  const { pinned, done } = gridPinsForSquad(view);
  const [doneOpen, toggleDone] = useDoneShelfOpen(view.team.id);
  const [addingBrainstorm, setAddingBrainstorm] = useState(false);
  if (!hub && !pinned.length && !done.length) return null;
  return (
    <div className="sidebar-pins" data-testid={`sidebar-pins-${view.team.id}`}>
      {hub && (
        <div className="sidebar-riffbot-wrap">
          <SidebarRiffBot pin={hub} onPin={onPin} />
        </div>
      )}
      <div className="sidebar-teams-divider">
        <span>TEAMS</span>
        <i>{pinned.length}</i>
        <button
          type="button"
          className="sidebar-add-brainstorm-btn"
          data-testid={`sidebar-add-brainstorm-${view.team.id}`}
          title="Spin up a new Brainstorm team"
          aria-label="Spin up a new Brainstorm team"
          onClick={(e) => {
            e.stopPropagation();
            setAddingBrainstorm(true);
          }}
        >
          +
        </button>
      </div>
      <div className="pin-list">
        {pinned.map((p) => (
          <div key={p.lane.id}>
            <PinRow pin={p} onPin={onPin} />
          </div>
        ))}
        {done.length > 0 && (
          <>
            <button
              type="button"
              className="pin-done-toggle"
              aria-expanded={doneOpen}
              data-testid={`sidebar-done-${view.team.id}`}
              onClick={toggleDone}
            >
              {doneOpen ? "▾" : "▸"} Done ({done.length})
            </button>
            {doneOpen && done.map((p) => <DoneRow key={p.lane.id} pin={p} testId={`sidebar-done-pin-${p.lane.id}`} />)}
          </>
        )}
      </div>
      {addingBrainstorm && <IdeaBox view={view} presetMode="new" onClose={() => setAddingBrainstorm(false)} onQuickStart={onPin} />}
    </div>
  );
}

// ── Grid tile: last few chat lines, read-only ────────────────────────────────
export type Line = { who: "you" | "bs"; text: string };
const PREVIEW_LINES = 4;

type TimelineEntry = { item: any; seqStart?: number; timestamp?: string };

function linesFrom(entries: TimelineEntry[]): Line[] {
  const out: Line[] = [];
  for (const e of entries) {
    const it = e.item;
    if (!it || typeof it.text !== "string") continue;
    const who = it.type === "user_message" ? "you" : it.type === "assistant_message" ? "bs" : null;
    if (!who) continue;
    for (const raw of withoutSpinOffFence(it.text.split("\n"))) {
      const text = raw.replace(/[`*#>_]+/g, "").trim();
      if (text && text !== LOOKS_DONE_MARKER && !text.startsWith(SEND_TO_MARKER)) out.push({ who, text });
    }
  }
  return out.slice(-PREVIEW_LINES);
}

/** Id of the newest Brainstorm message when it carries the vs:looks-done marker (step 5), else null. */
function looksDoneIdFrom(agentId: string, entries: TimelineEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const it = entries[i].item;
    if (it?.type !== "assistant_message" || typeof it.text !== "string") continue;
    if (!hasLooksDone(it.text)) return null;
    return `${agentId}:${it.id ?? it.messageId ?? entries[i].seqStart ?? entries[i].timestamp ?? it.text.length}`;
  }
  return null;
}

// Looks-done id per Brainstorm, fed by usePreview's loads so tiles read it without a second fetch.
const looksDoneIds = new Map<string, string | null>();
const looksDoneListeners = new Set<() => void>();
function setLooksDoneId(agentId: string, id: string | null) {
  if ((looksDoneIds.get(agentId) ?? null) === id) return;
  looksDoneIds.set(agentId, id);
  looksDoneListeners.forEach((l) => l());
}

/** Id of the Brainstorm's newest message when it is a "looks done" card, else null. Needs a usePreview for the same agent. */
export function useLooksDoneId(agentId: string | null): string | null {
  return useSyncExternalStore(
    (l) => {
      looksDoneListeners.add(l);
      return () => looksDoneListeners.delete(l);
    },
    () => (agentId ? (looksDoneIds.get(agentId) ?? null) : null),
  );
}

export function noteTimelineOffers(agentId: string, entries: TimelineEntry[]) {
  setLooksDoneId(agentId, looksDoneIdFrom(agentId, entries));
  noteSendTo(agentId, entries);
}

// Tail of the Brainstorm's timeline. Light version of the drawer's loader: small tail, debounced refetch.
export function usePreview(agentId: string | null): Line[] {
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => {
    setLines([]);
    if (!agentId) return;
    const apply = (entries: TimelineEntry[]) => {
      setLines(linesFrom(entries));
      noteTimelineOffers(agentId, entries);
    };
    if (DEMO) {
      apply(demoTimeline(agentId));
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = runnerHandle(agentId) as any;
    const agent = getPaseoState().agents.get(agentId);
    if (agent?.status === "closed") {
      const snap = (handle.timeline as any).getSnapshot?.();
      const cached = snap?.entries ?? snap?.items;
      if (Array.isArray(cached) && cached.length) apply(cached as TimelineEntry[]);
      return;
    }
    const load = async () => {
      try {
        const t = await handle.timeline.refetch({ direction: "tail", limit: 16, projection: "projected" });
        if (alive && !t.error) apply(t.entries as TimelineEntry[]);
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

/** Two live Buddies in one lane (docs/PLAN_BUGS_BATCH2.md block 0): list them, "Keep this one" retires the others. */
function BuddyDupeWarning({ pin, onOpenAgent }: { pin: Pin; onOpenAgent: (id: string) => void }) {
  const dupes = liveBuddyDupes(pin);
  if (!dupes.length) return null;
  return (
    <div className="dup-warning" role="alert" data-testid={`pin-buddy-dupes-${pin.lane.id}`} onClick={(e) => e.stopPropagation()}>
      <b>⚠ {dupes.length} live Buddies in this team · keep one</b>
      {dupes.map((m) => (
        <div key={m.agent.id} className="dup-row">
          <StatusDot agent={m.agent} />
          <button type="button" className="btn ghost small" onClick={() => onOpenAgent(m.agent.id)}>
            {cleanTitle(m.agent.title) || m.agent.id.slice(0, 8)}
          </button>
          <span className="muted small">{m.agent.id.slice(0, 8)}</span>
          <ConfirmButton
            label="Keep this one"
            armedLabel="Tap again to retire the others"
            busyLabel="Retiring…"
            tone="warn"
            onConfirm={async () => {
              const { failed } = await keepPinBuddy(pin, m.agent.id);
              if (failed.length) throw new Error(`could not retire ${failed.join(", ")}`);
            }}
          />
        </div>
      ))}
    </div>
  );
}

const PinTile = memo(function PinTile({ pin, onPin, onOpenAgent }: { pin: Pin; onPin: (pin: Pin) => Promise<void>; onOpenAgent: (id: string) => void }) {
  const bs = pin.brainstorm;
  const lines = usePreview(bs && bs.agent.status !== "closed" ? bs.agent.id : null);
  const looksDoneId = looksDoneFor(pin, useLooksDoneId(bs?.agent.id ?? null));
  const sendTo = useSendTo(bs?.agent.id ?? null);
  const spinOff = useSpinOff(bs?.agent.id ?? null);
  const paneCls = usePaneClass(bs?.agent.id ?? "");
  const [starting, setStarting] = useState(false);
  const busy = useRef(false);
  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await onPin(pin);
    } finally {
      busy.current = false;
      setStarting(false);
    }
  };
  const buildPinCtxItems = () => {
    const items: Array<{ label: string; run: () => void }> = [];
    if (bs) items.push({ label: `Open ${pin.lane.name} Brainstorm`, run: () => onOpenAgent(bs.agent.id) });
    items.push({ label: "Edit brief", run: () => openBriefEditor({ squadId: pin.squad.id, laneId: pin.lane.id, laneName: pin.lane.name }) });
    return items;
  };
  return (
    <div
      className={`pin-tile ${paneCls} ${bs ? "" : "no-session"} ${pin.needsYou ? "needs-you" : ""}`}
      role="button"
      tabIndex={0}
      data-testid={`pin-tile-${pin.lane.id}`}
      onClick={() => void open()}
      onContextMenu={(e) => openContextMenu(e, buildPinCtxItems())}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void open();
        }
      }}
    >
      <div className="pin-tile-bar">
        <span className="pin-tile-name">{pin.lane.name}</span>
        <span className="pin-lane-handle">{laneHandleOf(pin)}</span>
        <PinMenu pin={pin} onShowPlumbing={() => setFullView(true)} />
      </div>
      <div className="pin-tile-head">
        {bs ? (
          <Avatar id={bs.agent.id} provider={bs.agent.provider} agentType="brainstorm" size={40} />
        ) : (
          <Avatar id={`bs-empty-${pin.squad.id}-${pin.lane.id}`} provider="claude" agentType="brainstorm" size={40} />
        )}
        <div className="pin-tile-title">
          <span className="pin-tile-sub muted small">
            <PinDot pin={pin} /> {bs ? (bs.agent.queued ? `queued · ${bs.agent.queued.ahead} ahead` : bs.agent.status === "running" ? "Brainstorm working" : "Brainstorm") : "No session yet"}
          </span>
        </div>
        <NeedsBadge pin={pin} />
        <PinCtx pin={pin} showLabel />
      </div>
      <BuddyDupeWarning pin={pin} onOpenAgent={onOpenAgent} />
      {bs && looksDoneId && <LooksDoneCard pin={pin} messageId={looksDoneId} />}
      {bs && sendTo && <SendToCard pin={pin} offer={sendTo} />}
      {bs && spinOff && <SpinOffCard pin={pin} offer={spinOff} />}
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
          {starting ? "Starting…" : "No session yet · select to spin up"}
        </div>
      )}
      {(pin.topicBrainstorms ?? []).length > 0 && (
        <div className="pin-topics-bar" data-testid={`pin-topics-${pin.lane.id}`}>
          {(pin.topicBrainstorms ?? []).map((tb) => (
            <button
              key={tb.agent.id}
              type="button"
              className="tchip pin-topic-chip"
              data-testid={`pin-topic-buddy-${tb.agent.id}`}
              onClick={(e) => { e.stopPropagation(); onOpenAgent(tb.agent.id); }}
            >
              <StatusDot agent={tb.agent} />
              {tb.agent.title || `Topic: ${topicOfBrainstorm(tb.agent)}`}
            </button>
          ))}
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
  const { pinned, done } = gridPinsForSquad(view);
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
          <PinTile key={p.lane.id} pin={p} onPin={onPin} onOpenAgent={onOpenAgent} />
        ))}
        <IdeaPlusTile view={view} onQuickStart={onPin} />
      </div>
      {!pinned.length && <div className="muted">No pinned teams in {view.team.name} yet. Use + New idea to pin one.</div>}
      <DoneShelf done={done} squadId={view.team.id} />
    </section>
  );
}

// ── Project header Bugs quick-chip (docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md C1) ──
export function QuickBugsChip({
  view,
  onOpen,
  testId,
}: {
  view: TeamView;
  onOpen: PinHandler;
  testId?: string;
}) {
  const theme = useTheme();
  const dpr = useDpr();
  const zoom = useUiScale();
  const { device, css } = snapChipSize(dpr, zoom);
  const bugsAsset = chipIconSrc("bugs", theme, device);
  const dotAsset = chipIconSrc("dot", theme, device);
  const bugsOk = useImageOk(bugsAsset.src);
  const dotOk = useImageOk(dotAsset.src);
  const [busy, setBusy] = useState(false);
  const { pin, leadRunning, needsYou } = quickBugsChipState(view);
  const missing = !pin;
  const label = missing
    ? `Create Bugs team for ${view.team.name}`
    : `${pin.lane.name || "Bugs"}${leadRunning ? " · lead running" : ""}${needsYou > 0 ? ` · ${needsYou} need you` : ""}`;
  return (
    <button
      type="button"
      className={`quick-chip quick-chip-bugs ${missing ? "missing" : ""} ${leadRunning ? "lead-running" : ""} ${needsYou > 0 ? "needs-you" : ""}`}
      data-testid={testId ?? `squad-bugs-chip-${view.team.id}`}
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        if (busy) return;
        if (pin) {
          void Promise.resolve(onOpen(pin)).catch((err) => showPinToast(`Could not start ${pin.lane.name}: ${err}`));
          return;
        }
        setBusy(true);
        void createQuickBugsPin(view.team.id)
          .then((created) => Promise.resolve(onOpen(created)))
          .catch((err) => showPinToast(`Could not create Bugs team: ${err}`))
          .finally(() => setBusy(false));
      }}
    >
      <span className="quick-chip-art" style={{ width: css, height: css }}>
        {bugsOk && (
          <img
            className="quick-chip-img"
            src={bugsAsset.src}
            srcSet={bugsAsset.srcSet}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}
        {leadRunning && dotOk && (
          <img
            className="quick-chip-dot"
            data-testid={`squad-bugs-dot-${view.team.id}`}
            src={dotAsset.src}
            srcSet={dotAsset.srcSet}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}
      </span>
      {needsYou > 0 && (
        <span className="badge alert quick-chip-needs" data-testid={`squad-bugs-needs-${view.team.id}`}>
          {needsYou}
        </span>
      )}
    </button>
  );
}

// ── Squads Home: one tile per squad, one level above the squad page (docs/PLAN_SQUADS_HOME.md §H1) ──
function SquadTile({ v, onSelectSquad, onOpenPin, onOpenAgent }: { v: TeamView; onSelectSquad: (id: string) => void; onOpenPin: PinHandler; onOpenAgent?: (teamId: string, agentId: string) => void }) {
  const { pinned } = pinsForSquad(v);
  const lead = pickLead(v.lanes);
  const ord = lead ? ordOf(lead.agent) : null;
  const leadName = lead ? (ord ? `${laneCodeOf(lead.laneId || v.team.id)}${ord}` : cleanTitle(lead.agent.title)) : "none";
  const leadState = !lead ? "idle" : lead.agent.status === "running" ? "working" : lead.agent.status === "error" ? "error" : "idle";
  const open = () => onSelectSquad(v.team.id);
  return (
    <div
      className={`squad-home-tile ${v.needsYou > 0 ? "needs-you" : ""}`}
      role="button"
      tabIndex={0}
      data-testid={`squad-home-tile-${v.team.id}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="squad-home-tile-head">
        <TeamEmblem name={v.team.name} color={v.team.color} size={28} />
        <span className="squad-home-tile-name">{v.team.name}</span>
        {v.needsYou > 0 && onOpenAgent ? (
          <AttentionBadge view={v} onOpen={(id) => onOpenAgent(v.team.id, id)} testId={`squad-home-needs-${v.team.id}`}>
            {v.needsYou} need you
          </AttentionBadge>
        ) : (
          <span className={`badge ${v.needsYou > 0 ? "alert" : "muted"}`} data-testid={`squad-home-needs-${v.team.id}`}>
            {v.needsYou} need you
          </span>
        )}
      </div>
      <div className="squad-home-huddle" data-testid={`squad-home-huddle-${v.team.id}`}>
        {pinned.map((pin) => (
          <button
            key={pin.lane.id}
            type="button"
            className="squad-home-portrait"
            data-testid={`squad-home-portrait-${v.team.id}-${pin.lane.id}`}
            title={`${pin.lane.name}${pin.brainstorm ? ` (${pin.brainstorm.agent.title ?? "Brainstorm"})` : " (click to start Brainstorm)"}`}
            onClick={(e) => {
              e.stopPropagation();
              void Promise.resolve(onOpenPin(pin)).catch((err) => alert(`Could not start ${pin.lane.name}: ${err}`));
            }}
          >
            <Avatar
              id={pin.brainstorm ? pin.brainstorm.agent.id : `bs-empty-${v.team.id}-${pin.lane.id}`}
              provider={pin.brainstorm?.agent.provider ?? "claude"}
              agentType="brainstorm"
              size={38}
            />
            <span className="squad-home-portrait-pip">
              <PinDot pin={pin} />
              <NeedsBadgeInline pin={pin} />
              <PinCtx pin={pin} />
            </span>
          </button>
        ))}
      </div>
      <div className="squad-home-lead-line muted small" data-testid={`squad-home-lead-${v.team.id}`}>
        Lead: {leadName} · {leadState}
      </div>
    </div>
  );
}

const SQUAD_ROWS = 2;

export function SquadsHome({
  views,
  onSelectSquad,
  onOpenPin,
  onNewSquad,
  onOpenAgent,
}: {
  views: TeamView[];
  onSelectSquad: (id: string) => void;
  onOpenPin: PinHandler;
  onNewSquad: () => void;
  onOpenAgent?: (teamId: string, agentId: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);
  const [rowOffset, setRowOffset] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
      if (n > 0) setCols(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = views.length + 1; // squads + the NEW SQUAD tile
  const totalRows = Math.ceil(total / cols);
  const maxOffset = Math.max(0, totalRows - SQUAD_ROWS);
  const offset = Math.min(rowOffset, maxOffset);
  const paged = totalRows > SQUAD_ROWS;
  useEffect(() => {
    if (rowOffset > maxOffset) setRowOffset(maxOffset);
  }, [rowOffset, maxOffset]);
  const step = (d: number) => setRowOffset(Math.max(0, Math.min(maxOffset, offset + d)));
  const first = offset * cols;
  const slice = views.slice(first, first + SQUAD_ROWS * cols);
  const showNew = views.length >= first && views.length < first + SQUAD_ROWS * cols;
  return (
    <section className="squads-home" data-testid="squads-home">
      <div
        className={`squads-section squads-home-pager-wrap ${paged ? "paged" : ""}`}
        onKeyDown={(e) => {
          if (!paged || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          if (e.target instanceof HTMLElement && e.target.closest(".squad-home-tile")) return;
          e.preventDefault();
          step(e.key === "ArrowUp" ? -1 : 1);
        }}
      >
        <h2 className="squads-section-title" data-testid="squads-section-title">Squads</h2>
        <div className="squads-home-grid" ref={gridRef} data-testid="squads-home-grid">
          {slice.map((v) => (
            <SquadTile key={v.team.id} v={v} onSelectSquad={onSelectSquad} onOpenPin={onOpenPin} onOpenAgent={onOpenAgent} />
          ))}
          {showNew && (
            <button type="button" className="squad-home-tile pin-plus" data-testid="squad-home-new-tile" onClick={onNewSquad}>
              <span className="pin-plus-icon">+</span>
              <span>+ NEW SQUAD</span>
            </button>
          )}
        </div>
        {paged && (
          <div className="squads-home-pager" data-testid="squads-home-pager" role="group" aria-label="Squad rows">
            <button type="button" className="squads-pager-btn" data-testid="squads-pager-up" aria-label="Previous squad row" aria-disabled={offset <= 0} onClick={() => step(-1)}>
              ▲
            </button>
            <span className="squads-pager-pos muted small" data-testid="squads-pager-pos">
              {offset + 1}–{Math.min(totalRows, offset + SQUAD_ROWS)} / {totalRows}
            </span>
            <button type="button" className="squads-pager-btn" data-testid="squads-pager-down" aria-label="Next squad row" aria-disabled={offset >= maxOffset} onClick={() => step(1)}>
              ▼
            </button>
          </div>
        )}
      </div>
      <UsageDashboard perfection={{ pin: perfectionPin(views), onOpen: onOpenPin }} />
    </section>
  );
}
