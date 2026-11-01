import { FIRST_RUN_DONE_KEY, FirstRunModal, fetchFirstRunStatus, type FirstRunStatus } from "./FirstRunModal";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { ProviderQuotaView } from "./antigravity";
import { LEGACY_NEEDS_LABEL, dismissUpdateBanner, loadUpdaterStatus, setLanExposureState, setServerConfigWarnings, triggerUpdateInstall, useConfigWarnings, useExposedIpsStore, useUpdaterStatus } from "./userName";
import { DEMO, archiveAgent, detachAgent, getPaseoState, loadArchived, retireAgent, setNeedsYou, updateAgent, upsertLocalAgent, usePaseo } from "./paseo";
import {
  AGENT_TYPE_LABEL,
  MAX_TREE_DEPTH,
  leadVariant,
  budgetFor,
  chainedLeads,
  findCrossTeamBrainstorm,
  fmtTok,
  handoffPairs,
  isBrainstormAgent,
  isLanBannerDismissed,
  isOverBudget,
  isTopicBrainstorm,
  isUnsortedMember,
  lanIpSetKey,
  ordOf,
  successorDue,
  topicOfBrainstorm,
  usedTokens,
  LEAD_BUDGET,
  TEAMS,
  UNASSIGNED,
  assignAgentToLane,
  getLeadThresholds,
  leadLadderFor,
  matchesSearch,
  resolve,
  sortMembers,
  useTeams,
  type HandoffPair,
  type Member,
  type TeamView,
} from "./teams";
import { AgentPanes } from "./AgentPanes";
import { CommandPaletteHost, agentCtxItems, dateBucket, openContextMenu, openOverlay, parseUrlState, serializeUrlState, type DateBucket } from "./CommandPalette";
import { PaseoUsageHeaderChip } from "./PaseoSettingsSection";
import { MobileBar, useMobileTeamView } from "./MobileBar";
import { FocusRail, railAlerts } from "./FocusRail";
import { activateNth, getPanes, openAgent, openAgentInTab, setFocus, subscribePanes, toggleFocus, useFocusMode, useHasTabs } from "./panes";
import {
  AgentActions,
  AgentRow,
  Ago,
  AlertPill,
  BrainstormCtxPill,
  ConfirmButton,
  DiagBadges,
  StatusDot,
  TreeCaret,
  TreeChildren,
  alertOrder,
  cleanTitle,
  clickable,
  derived,
  getTreeState,
  sameList,
  sameMember,
  selectAgent,
  setTreeShowClosed,
  shortPath,
  subscribeTree,
  usePaneClass,
  useSelect,
  useTreeState,
  IdeaInbox,
  SidebarInboxBadge,
  openAndScrollToInbox,
} from "./ui";
import { WorkspacesView } from "./WorkspacesView";
import { FullToggle, PinGrid, SidebarPins, useFullView, type PinHandler } from "./PinGrid";
import { pinsForSquad, type Pin } from "./pins";
import { clearPinFocus, exitPinFocus, focusPin, usePinFocus, usePinsHome } from "./pinFocus";
import { PinFocusHeader, PinRail } from "./PinRail";
import { PinToast } from "./PinIdeas";
import { AddBuddyModal, Modal, NewAgentModal, ProfileImportModal, TeamSettingsModal, useProfiles } from "./TeamActions";
import { PairDeviceModal } from "./PairDeviceModal";
import { DaemonStatusBanner, DiagnosticsModal, HelpModal, checkForUpdates, updateLabel, type UpdateCheck } from "./DiagnosticsModal";
import { BriefEditorHost } from "./BriefEditor";
import { TeamFeed } from "./TeamFeed";
import { HandoffModal } from "./HandoffModal";
import { Avatar, NeonEmblem, TokenMeter, providerSpec } from "./pixel";
import { PushNotificationControls } from "./notifications";
import {
  applyUiScaleToDom,
  cycleUiScalePreset,
  getUiScale,
  handleUiScaleKeyDown,
  useUiScale,
  useUiScaleHud,
} from "./uiScale";

const COLLAPSED_TEAMS_KEY = "vibesquad.collapsedTeams";
const DISMISSED_LAN_IPS_KEY = "vibesquad.dismissedLanIps";
const SIDEBAR_COLLAPSED_KEY = "vibesquad.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "vibesquad.sidebarWidth";
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 440;
const SIDEBAR_DEFAULT_W = 265;

function readCollapsedTeams(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_TEAMS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= SIDEBAR_MIN_W && raw <= SIDEBAR_MAX_W) {
      return Math.round(raw);
    }
  } catch {}
  return SIDEBAR_DEFAULT_W;
}

export async function startLaneBrainstorm(opts: {
  teamId: string;
  laneId: string;
  laneName: string;
  cwd: string;
  onPick: (id: string) => void;
  agents?: Map<string, PaseoAgent>;
}): Promise<string | null> {
  const { teamId, laneId, laneName, cwd, onPick } = opts;
  const existing = findCrossTeamBrainstorm(resolve(opts.agents ?? getPaseoState().agents), laneId);
  if (existing) {
    onPick(existing.agent.id);
    return existing.agent.id;
  }
  const res = await fetch("/__vibesquad/brainstorm-restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      teamId,
      laneId,
      laneName,
      cwd,
      reason: "start-brainstorm",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !DEMO) {
    throw new Error(body.error ?? `Start brainstorm failed (${res.status})`);
  }
  if (body.reused && (body.existingAgentId || body.newAgentId)) {
    const reusedId = String(body.existingAgentId || body.newAgentId);
    onPick(reusedId);
    return reusedId;
  }
  const newAgentId: string = body.newAgentId || `demo-bs-${laneId}-${Date.now().toString(36)}`;
  const title: string = body.title || `BRAINSTORM · ${laneName.toUpperCase()}`;
  const createdAgent: PaseoAgent =
    body.agent ??
    ({
      id: newAgentId,
      title,
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: cwd || `/projects/${teamId}`,
      status: "idle",
      updatedAt: new Date().toISOString(),
      lastUsage: { contextWindowUsedTokens: 0, inputTokens: 0 },
      labels: {
        team: teamId,
        lane: laneId,
        lead: laneId,
        role: "brainstorm",
      },
    } as unknown as PaseoAgent);
  upsertLocalAgent(createdAgent);
  if (newAgentId) onPick(newAgentId);
  return newAgentId;
}

// Fire a desktop notification when an agent newly needs you.
function useAttentionAlerts(members: Member[]) {
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const m of members) {
      const key = m.attention && m.attention.tone !== "finished" ? `${m.attention.tone}:${m.attention.reason}` : "";
      const prev = seen.current.get(m.agent.id);
      seen.current.set(m.agent.id, key);
      // prev === undefined means first load: don't spam for everything already waiting.
      if (key && prev !== undefined && prev !== key && "Notification" in window && Notification.permission === "granted") {
        new Notification(`${m.team.name}: ${m.agent.title ?? "agent"}`, { body: m.attention!.reason, tag: m.agent.id });
      }
    }
  }, [members]);
}

// Context tokens in use across a team's live agents, plus a flag for workers past workerBudgetTokens.
function TeamTokens({ view }: { view: TeamView }) {
  const live = view.members.filter((m) => m.kind !== "old-lead" && m.agent.status !== "closed");
  const total = live.reduce((n, m) => n + usedTokens(m), 0);
  const over = live.filter(isOverBudget);
  if (!total) return null;
  return (
    <div className="team-tokens" title={over.map((m) => `${m.agent.title}: ${fmtTok(usedTokens(m))}`).join(", ")}>
      <span className="tok-total">{fmtTok(total)} tok</span>
      {over.length > 0 && <span className="pill diag hot">{over.length} OVER BUDGET</span>}
    </div>
  );
}

const quotaTone = (pct?: number) => (pct === undefined ? "" : pct >= 85 ? "hot" : pct >= 60 ? "warn" : "ok");

type PickTeamAgent = (teamId: string, agentId: string) => void;

// Agents already on screen inside an expanded lead/brainstorm tree carry their own alert marker; the rest
// of the team's alerts go in the sidebar alert strip.
function sideAlerts(v: TeamView): Member[] {
  const { open, showClosed } = getTreeState();
  const { tree } = derived();
  const shownInTree = (rootId: string, out: Set<string>, depth = 0) => {
    if (!open.has(rootId) || depth >= MAX_TREE_DEPTH) return out;
    for (const c of tree.childrenOf(rootId, showClosed))
      if (!out.has(c.agent.id)) shownInTree(c.agent.id, out.add(c.agent.id), depth + 1);
    return out;
  };
  const shown = new Set<string>();
  for (const l of v.lanes) {
    if (l.brainstorm) shownInTree(l.brainstorm.agent.id, shown.add(l.brainstorm.agent.id));
    if (l.lead) shownInTree(l.lead.agent.id, shown.add(l.lead.agent.id));
  }
  return v.members.filter((m) => m.attention && m.kind !== "old-lead" && !shown.has(m.agent.id)).sort(alertOrder);
}

const LaneTopics = memo(
  function LaneTopics({ laneId, topics, pick }: { laneId: string; topics: Member[]; pick: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    if (!topics.length) return null;
    return (
      <div className={`lane-topics ${open ? "open" : ""}`} data-testid={`lane-topics-${laneId}`}>
        <button
          className="lane-topics-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid={`lane-topics-toggle-${laneId}`}
        >
          <span>
            {open ? "▾" : "▸"} Topics ({topics.length})
          </span>
        </button>
        {open && (
          <div className="lane-topics-list">
            {topics.map((m) => (
              <button
                key={m.agent.id}
                className="lane-topic-item"
                onClick={() => pick(m.agent.id)}
                title={m.agent.title ?? ""}
                data-testid={`lane-topic-item-${m.agent.id}`}
              >
                <StatusDot agent={m.agent} />
                <span className="lane-topic-name">{topicOfBrainstorm(m.agent) || cleanTitle(m.agent.title)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
  (p, n) => p.laneId === n.laneId && p.pick === n.pick && sameList(p.topics, n.topics),
);

const LeadBlock = memo(
  function LeadBlock({
    teamId,
    laneId,
    laneName,
    cwd,
    brainstorm,
    lead,
    topics = [],
    pick,
  }: {
    teamId: string;
    laneId: string;
    laneName: string;
    cwd: string;
    brainstorm: Member | null;
    lead: Member | null;
    topics?: Member[];
    pick: (id: string) => void;
  }) {
    const bsPaneCls = usePaneClass(brainstorm?.agent.id ?? "");
    const leadPaneCls = usePaneClass(lead?.agent.id ?? "");
    const [startingBs, setStartingBs] = useState(false);
    const leadNeedsYou = !!(lead?.attention && lead.attention.tone !== "finished");

    const onStartBs = async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (startingBs) return;
      setStartingBs(true);
      try {
        await startLaneBrainstorm({ teamId, laneId, laneName, cwd, onPick: pick });
      } catch (err) {
        alert(`Start brainstorm failed: ${err}`);
      } finally {
        setStartingBs(false);
      }
    };

    return (
      <div className="lead-block" data-testid={`sidebar-lane-${laneId}`}>
        {/* DESIGN T1-4: Primary slot is the lane's active Brainstorm ("TALK HERE") */}
        {brainstorm ? (
          <>
            <div className="lead-line">
              <button
                className={`lead-link primary-talk ${bsPaneCls}`}
                onClick={() => pick(brainstorm.agent.id)}
                title={brainstorm.agent.title ?? ""}
              >
                <Avatar
                  id={brainstorm.agent.id}
                  provider={brainstorm.agent.provider}
                  agentType={brainstorm.agentType}
                  size={28}
                />
                <span className="lead-name">{laneName}</span>
                <b className="talk-here sidebar-role-pill">TALK HERE</b>
                <StatusDot agent={brainstorm.agent} />
              </button>
              <TreeCaret id={brainstorm.agent.id} />
            </div>
            {brainstorm.attention && (
              <div className="lead-alert">
                <AlertPill m={brainstorm} onOpen={pick} named={false} />
              </div>
            )}
            <TreeChildren parentId={brainstorm.agent.id} onPick={pick} compact />
          </>
        ) : (
          <div className="lead-line">
            <span className="lead-link muted">{laneName}</span>
            <button
              type="button"
              className="btn ok small sidebar-start-bs-btn"
              disabled={startingBs}
              data-testid={`sidebar-start-brainstorm-${laneId}`}
              onClick={onStartBs}
              title={`Spawn fresh brainstorm from docs/brainstorm/${laneId}.md`}
            >
              {startingBs ? "…" : "+ Brainstorm"}
            </button>
          </div>
        )}

        {/* DESIGN T1-4: Secondary slot is the Lead ("RUNS THE WORK"), promoted when needs-you/attention */}
        {lead && (
          <>
            <div className="lead-line lead-secondary-line">
              <button
                className={`lead-link secondary-lead ${leadNeedsYou ? "lead-needs-you" : ""} ${leadPaneCls}`}
                onClick={() => pick(lead.agent.id)}
                title={lead.agent.title ?? ""}
              >
                <Avatar
                  id={lead.agent.id}
                  provider={lead.agent.provider}
                  agentType={lead.agentType}
                  variant={leadVariant(lead)}
                  size={24}
                />
                <span className="lead-name">★ {cleanTitle(lead.agent.title) || laneName}</span>
                <span className="runs-the-work sidebar-role-pill">RUNS WORK</span>
                <StatusDot agent={lead.agent} />
              </button>
              <TreeCaret id={lead.agent.id} />
            </div>
            {lead.attention && (
              <div className="lead-alert">
                <AlertPill m={lead} onOpen={pick} named={false} />
              </div>
            )}
            <TreeChildren parentId={lead.agent.id} onPick={pick} compact />
          </>
        )}
        {topics.length > 0 && <LaneTopics laneId={laneId} topics={topics} pick={pick} />}
      </div>
    );
  },
  (p, n) =>
    p.teamId === n.teamId &&
    p.laneId === n.laneId &&
    p.laneName === n.laneName &&
    p.cwd === n.cwd &&
    sameMember(p.brainstorm, n.brainstorm) &&
    sameMember(p.lead, n.lead) &&
    sameList(p.topics ?? [], n.topics ?? []) &&
    p.pick === n.pick,
);

const SidebarTeam = memo(function SidebarTeam({
  view: v,
  active,
  expanded,
  onTeamHeaderClick,
  onToggleExpand,
  onTeam,
  onAgent,
  onQuickStart,
}: {
  view: TeamView;
  active: boolean;
  expanded: boolean;
  onTeamHeaderClick: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onTeam: (id: string) => void;
  onAgent: PickTeamAgent;
  onQuickStart: PinHandler;
}) {
  const full = useFullView();
  const others = useSelect(subscribeTree, () => sideAlerts(v), sameList);
  const pick = useCallback((id: string) => onAgent(v.team.id, id), [onAgent, v.team.id]);
  const onPin = useCallback(
    (pin: Pin) => void Promise.resolve(onQuickStart(pin)).catch((e) => alert(`Could not start ${pin.lane.name}: ${e}`)),
    [onQuickStart],
  );
  const firstAlert = v.members
    .filter((m) => m.attention && m.attention.tone !== "finished" && m.kind !== "old-lead")
    .sort(alertOrder)[0];
  return (
    <div className={`team ${active ? "active" : ""} ${expanded ? "expanded" : "collapsed"}`} data-testid={`sidebar-team-${v.team.id}`}>
      <div className="team-head-line">
        <button
          className="team-head"
          aria-expanded={expanded}
          onClick={() => onTeamHeaderClick(v.team.id)}
          data-testid={`team-head-${v.team.id}`}
        >
          <span
            className="team-chevron"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(v.team.id);
            }}
            title={expanded ? `Collapse ${v.team.name}` : `Expand ${v.team.name}`}
          >
            {expanded ? "▾" : "▸"}
          </span>
          <NeonEmblem color={v.team.color} seed={v.team.id} size={18} />
          <span className="team-name">{v.team.name}</span>
          {v.running > 0 && <span className="badge">{v.running}▶</span>}
        </button>
        {firstAlert && (
          <button
            className="badge alert"
            title={`Open ${firstAlert.agent.title ?? "agent"} (${v.needsYou} need you)`}
            onClick={(e) => {
              e.stopPropagation();
              pick(firstAlert.agent.id);
            }}
          >
            {v.needsYou}
          </button>
        )}
      </div>
      {expanded && !full && v.team.id !== UNASSIGNED.id && <SidebarPins view={v} onPin={onPin} onOpenAgent={pick} />}
      {expanded && full && (
        <>
          <TeamTokens view={v} />
          {v.lanes.map((l) => {
            const topics = l.members.filter(
              (m) => m.kind === "brainstorm" && isTopicBrainstorm(m.agent) && !m.agent.archivedAt,
            );
            if (!l.lead && !l.brainstorm && !topics.length && l.lane.id === "_other") return null;
            return (
              <LeadBlock
                key={l.lane.id}
                teamId={v.team.id}
                laneId={l.lane.id}
                laneName={l.lane.name}
                cwd={l.lead?.agent.cwd || l.brainstorm?.agent.cwd || v.team.paths?.[0] || ""}
                brainstorm={l.brainstorm}
                lead={l.lead}
                topics={topics}
                pick={pick}
              />
            );
          })}
          {others.length > 0 && (
            <div className="side-alerts">
              {others.slice(0, 3).map((m) => (
                <AlertPill key={m.agent.id} m={m} onOpen={pick} />
              ))}
              {others.length > 3 && (
                <button className="tchip" onClick={() => onTeam(v.team.id)} title="See every alert on the team page">
                  +{others.length - 3} more
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

const Sidebar = memo(function Sidebar(props: {
  views: TeamView[];
  teamId: string;
  conn: string;
  collapsedTeams: Set<string>;
  onTeamHeaderClick: (id: string) => void;
  onToggleTeamExpand: (id: string) => void;
  onToggleAllTeams: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebarCollapse: () => void;
  onStartResize: (e: React.MouseEvent) => void;
  onTeam: (id: string) => void;
  onAgent: PickTeamAgent;
  onQuickStart: PinHandler;
  onPairDevice?: () => void;
  onAbout?: () => void;
  onHelp?: () => void;
  onDiagnostics?: () => void;
  onSettings: () => void;
  usage: ProviderQuotaView[];
  lanExposed?: boolean;
  lanIps?: string[];
}) {
  const uiScale = useUiScale();
  const uiScalePct = Math.round(uiScale * 100);
  const views = props.views;
  const allCollapsed = views.length > 0 && views.every((v) => props.collapsedTeams.has(v.team.id));
  return (
    <nav className={`sidebar ${props.sidebarCollapsed ? "collapsed" : ""}`} data-testid="sidebar">
      <div className="brand">
        <NeonEmblem color="#00f0ff" seed="vibesquad-brand" size={22} />
        <div className="brand-text">
          <span>VIBESQUAD</span>
          <span className="brand-sub">NEON-NOIR // 198X</span>
        </div>
        <span className={`conn ${props.conn}`} title={`daemon: ${props.conn}`} />
        {props.lanExposed && (
          <span className="lan-status-dot badge warn" data-testid="lan-status-dot" title={`Exposed on LAN: ${(props.lanIps ?? []).join(", ")}`}>LAN</span>
        )}
        <button
          type="button"
          className="btn ghost small sidebar-collapse-btn"
          onClick={props.onToggleSidebarCollapse}
          title={props.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar to 56px rail"}
          data-testid="sidebar-collapse-toggle"
        >
          {props.sidebarCollapsed ? "»" : "«"}
        </button>
      </div>
      <SidebarInboxBadge
        onSelect={() => {
          if (props.teamId) props.onTeam(props.teamId);
          openAndScrollToInbox();
        }}
      />
      <div className="sidebar-teams-header">
        <span className="sidebar-teams-label">SQUADS</span>
        <button
          type="button"
          className="btn ghost small sidebar-collapse-all-btn"
          onClick={props.onToggleAllTeams}
          data-testid="sidebar-collapse-all"
          title={allCollapsed ? "Expand all squads" : "Collapse all squads"}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      {views.map((v) => (
        <SidebarTeam
          key={v.team.id}
          view={v}
          active={v.team.id === props.teamId}
          expanded={!props.collapsedTeams.has(v.team.id)}
          onTeamHeaderClick={props.onTeamHeaderClick}
          onToggleExpand={props.onToggleTeamExpand}
          onTeam={props.onTeam}
          onAgent={props.onAgent}
          onQuickStart={props.onQuickStart}
        />
      ))}
      <div className="sidebar-legend">
        <div className="legend-title">PROVIDER SIGNALS</div>
        <div className="legend-row">
          <span style={{ color: "#ff8573" }}>✶ Claude</span>
          <span style={{ color: "#38f6ff" }}>◆ Gemini</span>
          <span style={{ color: "#c28cff" }}>▲ DeepSeek</span>
          <span style={{ color: "#e2e8f0" }}>● Codex</span>
        </div>
        {props.usage.map((u) => {
          const prov = providerSpec(u.provider);
          return (
            <div
              key={`${u.provider}-${u.account ?? ""}`}
              className={`quota-pill ${quotaTone(u.usedPct)}`}
              title={[u.account, u.resetAt && `resets ${new Date(u.resetAt).toLocaleString()}`, u.staleModelListWarning && "model list may be stale"].filter(Boolean).join(" · ")}
            >
              <span style={{ color: prov.color }}>{prov.symbol} {prov.name}</span>
              <span>{u.usedPct !== undefined ? `${Math.round(u.usedPct)}% used` : u.remainingLabel}</span>
              <span className="quota-bar"><i style={{ width: `${u.usedPct ?? 0}%` }} /></span>
            </div>
          );
        })}
      </div>
      <button className="btn ghost small" onClick={props.onPairDevice} title="Pair a phone or PC over NordVPN Meshnet HTTPS">
        📱 PAIR DEVICE
      </button>
      <button className="btn ghost small" data-testid="about-licenses-btn" onClick={props.onAbout} title="About VibeSquad and third-party licenses">
        ℹ ABOUT &amp; LICENSES
      </button>
      <button className="btn ghost small" data-testid="open-help-btn" onClick={props.onHelp}>
        ❓ Help &amp; Docs
      </button>
      <button className="btn ghost small" data-testid="open-diagnostics-btn" onClick={props.onDiagnostics}>
        🩺 Diagnostics &amp; Logs
      </button>
      <div className="sidebar-footer-row">
        <button className="btn ghost small" onClick={props.onSettings} title="Edit squads, teams, path matchers and 4K UI scale">
          ⚙ SQUADS
        </button>
        <button
          className={`btn ghost small ui-scale-sidebar-btn ${uiScalePct !== 100 ? "on" : ""}`}
          onClick={() => cycleUiScalePreset(true)}
          title="Cycle UI scale preset (Ctrl+= / Ctrl+- / Ctrl+0)"
          data-testid="sidebar-ui-scale-btn"
        >
          🔍 {uiScalePct}%
        </button>
      </div>
      <PushNotificationControls />
      <div
        className="sidebar-resizer"
        data-testid="sidebar-resizer"
        onMouseDown={props.onStartResize}
        title="Drag to resize sidebar width"
      />
    </nav>
  );
});

const Section = memo(function Section({
  title,
  members,
  onPick,
  collapsed,
  archive,
}: {
  title: string;
  members: Member[];
  onPick: (id: string) => void;
  collapsed?: boolean;
  archive?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  if (!members.length) return null;
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen(!open)}>
        <span className="section-chevron">{open ? "▾" : "▸"}</span> {title} <span className="muted">({members.length})</span>
      </button>
      {open &&
        sortMembers(members).map((m) => (
          <div key={m.agent.id} className="tree-root">
            <AgentRow m={m} onPick={onPick} archive={archive} caret />
            <TreeChildren parentId={m.agent.id} onPick={onPick} />
          </div>
        ))}
    </div>
  );
}, (p, n) => p.title === n.title && p.collapsed === n.collapsed && p.archive === n.archive && p.onPick === n.onPick && sameList(p.members, n.members));

type CardProps = { label: string; m: Member | null; onPick: (id: string) => void; onSuccessor?: (m: Member) => void };

const Card = memo(function Card({ label, m, onPick, onSuccessor }: CardProps) {
  const paneCls = usePaneClass(m?.agent.id ?? "");
  if (!m) return <div className="card empty">{label}: none</div>;
  const a = m.agent;
  const prov = providerSpec(a.provider);
  const isBs = m.kind === "brainstorm" || isBrainstormAgent(a);
  const isLead = m.kind === "lead";
  const hasNeedsYou = !!(m.attention && m.attention.tone !== "finished");
  const slotCls = isBs
    ? "card-primary-talk"
    : isLead
      ? `card-secondary-lead ${hasNeedsYou ? "card-lead-needs-you" : ""}`
      : "";
  return (
    <div
      className={`card ${paneCls} card-${m.agentType} ${slotCls}`}
      {...clickable(() => onPick(a.id))}
      onContextMenu={(ev) =>
        openContextMenu(
          ev,
          agentCtxItems(a, {
            open: () => onPick(a.id),
            split: () => openAgentInTab(a.id, "right"),
            archive: () => void archiveAgent(a.id),
          }),
        )
      }
    >
      <Avatar id={a.id} provider={a.provider} agentType={m.agentType} variant={leadVariant(m)} size={56} />
      <div className="card-body">
        <div className="card-top-row">
          <span className="card-label">{m.agentType === "brainstorm" ? "BRAINSTORM" : AGENT_TYPE_LABEL[m.agentType]}</span>
          <span className="card-top-right">
            <AgentActions agent={a} />
            <span className="prov-pill" style={{ color: prov.color, borderColor: prov.color }}>
              {prov.symbol} {prov.name}
            </span>
          </span>
        </div>
        <div className="card-title">
          <StatusDot agent={a} /> {cleanTitle(a.title)} <TreeCaret id={a.id} />
        </div>
        <div className="muted small">
          {isBs && (
            <b className="talk-here" data-testid="talk-here-badge">
              TALK HERE ·{" "}
            </b>
          )}
          {isLead && (
            <span className="runs-the-work" data-testid="runs-the-work-badge">
              RUNS THE WORK ·{" "}
            </span>
          )}
          {a.model} · {shortPath(a.cwd)} · <Ago iso={a.updatedAt} />
        </div>
        {isBs ? (
          <BrainstormCtxPill agent={a} team={m.team} />
        ) : (
          <TokenMeter
            used={usedTokens(m)}
            budget={budgetFor(m)}
            ladder={isLead ? leadLadderFor(m.team) : undefined}
          />
        )}
        {m.attention && (
          <div className="card-alert">
            <AlertPill m={m} onOpen={onPick} named={false} />
            <span className="muted small">{m.attention.reason}</span>
          </div>
        )}
        <DiagBadges m={m} />
        {onSuccessor && successorDue(m) && (
          <button
            className={`btn successor ${usedTokens(m) >= LEAD_BUDGET ? "hot" : "warn"}`}
            onClick={(e) => {
              e.stopPropagation();
              onSuccessor(m);
            }}
          >
            SPAWN SUCCESSOR (ord{ordOf(a) + 1})
          </button>
        )}
      </div>
    </div>
  );
}, (p, n) => p.label === n.label && sameMember(p.m, n.m) && p.onPick === n.onPick && p.onSuccessor === n.onSuccessor);

function EmptyBrainstormCard({
  teamId,
  laneId,
  laneName,
  cwd,
  onPick,
}: {
  teamId: string;
  laneId: string;
  laneName: string;
  cwd: string;
  onPick: (id: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await startLaneBrainstorm({ teamId, laneId, laneName, cwd, onPick });
    } catch (err) {
      alert(`Start brainstorm failed: ${err}`);
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="card card-brainstorm-empty card-primary-talk" data-testid={`brainstorm-empty-card-${laneId}`}>
      <Avatar id={`bs-empty-${teamId}-${laneId}`} provider="claude" agentType="brainstorm" size={56} />
      <div className="card-body">
        <div className="card-top-row">
          <span className="card-label">BRAINSTORM</span>
          <b className="talk-here" data-testid="talk-here-badge">
            TALK HERE
          </b>
        </div>
        <div className="card-title">BRAINSTORM · {laneName.toUpperCase()}</div>
        <div className="muted small">
          <b className="talk-here">TALK HERE · </b>
          Seeded from <code>docs/brainstorm/{laneId}.md</code>
        </div>
        <button
          type="button"
          className="btn ok start-brainstorm-btn"
          disabled={starting}
          data-testid={`start-brainstorm-${laneId}`}
          onClick={() => void handleStart()}
        >
          {starting ? "Starting Brainstorm…" : "+ Start Brainstorm"}
        </button>
      </div>
    </div>
  );
}

function ArchRow({ m }: { m: Member }) {
  const paneCls = usePaneClass(m.agent.id);
  return (
    <div className={`arch-row ${paneCls}`}>
      <Avatar id={m.agent.id} provider={m.agent.provider} agentType={m.agentType} variant={leadVariant(m)} size={24} />
      <span className="row-name">{cleanTitle(m.agent.title) || m.agent.id.slice(0, 8)}</span>
      <span className="role-tag">{AGENT_TYPE_LABEL[m.agentType]}</span>
      <span className={`status-pill ${m.agent.status}`}>{m.agent.status}</span>
      <span className="muted small">archived <Ago iso={m.agent.archivedAt} /> ago</span>
    </div>
  );
}

function ArchivedSection({ members }: { members: Member[] }) {
  return (
    <section className="lane archived-lane">
      <h2>Archived ({members.length})</h2>
      {members.length === 0 && <div className="muted small">Nothing archived for this team.</div>}
      {[...members]
        .sort((a, b) => Date.parse(b.agent.archivedAt ?? "") - Date.parse(a.agent.archivedAt ?? ""))
        .map((m) => (
          <ArchRow key={m.agent.id} m={m} />
        ))}
    </section>
  );
}

type Handoff = { chained: Member[]; pairs: (HandoffPair & { laneName: string })[] };

function handoffOf(view: TeamView): Handoff {
  const laneName = (id: string | null) => view.lanes.find((l) => l.lane.id === id)?.lane.name ?? "—";
  return { chained: chainedLeads(view.members), pairs: handoffPairs(view.members).map((p) => ({ ...p, laneName: laneName(p.laneId) })) };
}

type PairRow = Handoff["pairs"][number];
const samePair = (x: PairRow, y: PairRow) =>
  sameMember(x.oldLead, y.oldLead) && sameMember(x.lead, y.lead) && x.liveWorkers === y.liveWorkers && x.laneName === y.laneName;

const parentOf = (m: Member) => String((m.agent.labels as Record<string, string>)["paseo.parent-agent-id"]);

const ChainedRow = memo(
  function ChainedRow({ m }: { m: Member }) {
    return (
      <div className="handoff-row warn">
        <span className="warn-badge">⚠ CHAINED</span>
        <span className="row-name">{m.agent.title}</span>
        <span className="muted small">still parented to {parentOf(m).slice(0, 8)}</span>
        <ConfirmButton
          label="Fix chain (detach)"
          armedLabel="Tap to detach"
          busyLabel="Detaching…"
          tone="warn"
          onConfirm={async () => {
            await detachAgent(m.agent.id);
            await updateAgent(m.agent.id, { labels: { ...(m.agent.labels as Record<string, string>), "paseo.parent-agent-id": "" } });
          }}
        />
      </div>
    );
  },
  (p, n) => sameMember(p.m, n.m),
);

const HandoffPairRow = memo(
  function HandoffPairRow({ p }: { p: PairRow }) {
    const rawOld = cleanTitle(p.oldLead.agent.title);
    const strippedOld = rawOld.toLowerCase().startsWith("(old)") ? rawOld.slice(5).trim() : rawOld;
    return (
      <div className="handoff-row">
        <span className="lane-tag">{p.laneName}</span>
        <span className="row-name">
          <span className="muted">(old)</span> {strippedOld}{" "}
          <span className="arrow">→</span>{" "}
          {p.lead ? <b className="cur-lead">★ {cleanTitle(p.lead.agent.title)}</b> : <span className="muted">no current lead</span>}
        </span>
        <span className={`badge ${p.liveWorkers ? "alert" : ""}`} title="workers still attached to the old lead">
          {p.liveWorkers} attached
        </span>
        <ConfirmButton
          label="Archive old lead"
          armedLabel="Tap to archive"
          busyLabel="Archiving…"
          tone="warn"
          onConfirm={async () => void (await archiveAgent(p.oldLead.agent.id))}
        />
      </div>
    );
  },
  (a, b) => samePair(a.p, b.p),
);

function HandoffPanel({ handoff }: { handoff: Handoff }) {
  const { chained, pairs } = handoff;
  if (!chained.length && !pairs.length) return null;
  return (
    <section className="handoff-panel">
      <h2>LEAD HANDOFF &amp; CHAIN</h2>
      {chained.map((m) => (
        <ChainedRow key={m.agent.id} m={m} />
      ))}
      {pairs.map((p) => (
        <HandoffPairRow key={p.oldLead.agent.id} p={p} />
      ))}
    </section>
  );
}

type Folders = [cwd: string, n: number][];
const LiveFolders = memo(
  function LiveFolders({ worktrees }: { worktrees: Folders }) {
    if (!worktrees.length) return null;
    return (
      <section className="lane">
        <h2>Live folders</h2>
        {worktrees.map(([cwd, n]) => (
          <div key={cwd} className="wt" title={cwd}>
            <NeonEmblem color="#64748b" seed={cwd} size={14} /> <code>{shortPath(cwd)}</code>{" "}
            <span className="muted small">{cwd}</span> <span className="badge">{n}</span>
          </div>
        ))}
      </section>
    );
  },
  (p, n) => p.worktrees.length === n.worktrees.length && p.worktrees.every(([c, k], i) => c === n.worktrees[i][0] && k === n.worktrees[i][1]),
);

function UnassignedTray({
  members,
  onPick,
}: {
  members: Member[];
  onPick: (id: string) => void;
}) {
  const allLanes = useMemo(
    () =>
      TEAMS.flatMap((team) =>
        team.lanes.map((lane) => ({
          teamId: team.id,
          teamName: team.name,
          laneId: lane.id,
          laneName: lane.name,
        })),
      ),
    [],
  );
  const defaultLaneId = allLanes[0]?.laneId ?? "vibesquad";
  const [selectedByAgent, setSelectedByAgent] = useState<Record<string, string>>({});
  const [assigningId, setAssigningId] = useState<string | null>(null);

  if (!members.length) return null;

  const handleAssign = async (agent: PaseoAgent) => {
    const laneId = selectedByAgent[agent.id] || defaultLaneId;
    if (!laneId) return;
    setAssigningId(agent.id);
    try {
      await assignAgentToLane(agent, laneId, updateAgent);
    } catch (err) {
      alert(`Failed to assign lane: ${err}`);
    } finally {
      setAssigningId(null);
    }
  };

  return (
    <section className="lane unassigned-tray" data-testid="unassigned-tray">
      <h2>UNASSIGNED TRAY · ORPHAN AGENTS ({members.length})</h2>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Agents whose labels and working folder did not match any registered team in <code>teams.json</code>. Assign each to a team with one click:
      </div>
      {members.map((m) => {
        const a = m.agent;
        const labels = (a.labels ?? {}) as Record<string, string>;
        const labelPairs = Object.entries(labels)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        const selectedLane = selectedByAgent[a.id] || defaultLaneId;
        return (
          <div
            key={a.id}
            className="handoff-row warn unassigned-row"
            data-testid={`unassigned-agent-${a.id}`}
          >
            <StatusDot agent={a} />
            <span className="row-name" {...clickable(() => onPick(a.id))}>
              <b>{a.title || a.id}</b> <code className="muted small">({a.id.slice(0, 8)})</code>
            </span>
            <span className="muted small">
              cwd: <code>{a.cwd || "(none)"}</code> · labels: <code>{labelPairs || "(none)"}</code>
            </span>
            <select
              className="lane-select"
              data-testid={`assign-lane-select-${a.id}`}
              value={selectedLane}
              onChange={(e) =>
                setSelectedByAgent((prev) => ({
                  ...prev,
                  [a.id]: e.target.value,
                }))
              }
            >
              {allLanes.map((item) => (
                <option key={item.laneId} value={item.laneId}>
                  {item.teamName} · {item.laneName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ok"
              disabled={assigningId === a.id}
              data-testid={`assign-lane-btn-${a.id}`}
              onClick={() => void handleAssign(a)}
            >
              {assigningId === a.id ? "Assigning…" : "Assign to team"}
            </button>
          </div>
        );
      })}
    </section>
  );
}

function SquadUnsortedGroup({ view, onPick }: { view: TeamView; onPick: (id: string) => void }) {
  const unsorted = view.unsorted ?? [];
  const [selectedLanes, setSelectedLanes] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const m of unsorted) {
      defaults[m.agent.id] = view.team.lanes[0]?.id ?? "";
    }
    return defaults;
  });
  const [assigningId, setAssigningId] = useState<string | null>(null);
  if (!unsorted.length) return null;
  const allLanes = [
    ...view.team.lanes.map((l) => ({ teamId: view.team.id, laneId: l.id, label: `${view.team.name} / ${l.name}` })),
    ...TEAMS.filter((t) => t.id !== view.team.id).flatMap((t) =>
      t.lanes.map((l) => ({ teamId: t.id, laneId: l.id, label: `${t.name} / ${l.name}` })),
    ),
  ];
  const adopt = async (a: PaseoAgent) => {
    const laneId = selectedLanes[a.id] ?? allLanes[0]?.laneId ?? "";
    if (!laneId) return;
    setAssigningId(a.id);
    try {
      await assignAgentToLane(a, laneId, updateAgent);
    } catch (err) {
      alert(`Failed to assign lane: ${err}`);
    } finally {
      setAssigningId(null);
    }
  };
  return (
    <section data-testid="squad-unsorted-group" className="squad-unsorted-group">
      <h3>{`UNSORTED IN ${view.team.name.toUpperCase()} (${unsorted.length})`}</h3>
      {unsorted.map((m) => {
        const a = m.agent;
        return (
          <div key={a.id} data-testid={`unsorted-agent-${a.id}`} className="unsorted-agent-row">
            <button type="button" className="btn ghost small" onClick={() => onPick(a.id)}>
              {cleanTitle(a.title) || a.id.slice(0, 8)}
            </button>
            <span className="muted small">{a.cwd}</span>
            <select
              data-testid={`adopt-lane-select-${a.id}`}
              value={selectedLanes[a.id] ?? ""}
              onChange={(e) => setSelectedLanes((prev) => ({ ...prev, [a.id]: e.target.value }))}
            >
              {allLanes.map((opt) => (
                <option key={opt.laneId} value={opt.laneId}>{opt.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn ok small"
              data-testid={`adopt-agent-btn-${a.id}`}
              disabled={assigningId === a.id}
              onClick={() => void adopt(a)}
            >
              {assigningId === a.id ? "Adopting…" : "Adopt into lane…"}
            </button>
          </div>
        );
      })}
    </section>
  );
}

const TeamPage = memo(function TeamPage(props: {
  view: TeamView;
  unassignedMembers: Member[];
  onPick: (id: string) => void;
  query: string;
  showOld: boolean;
  archivedMembers: Member[] | null;
  onAddBuddy: () => void;
  onNewAgent: () => void;
  onSettings: () => void;
  onSuccessor: (m: Member) => void;
  onQuickStart: PinHandler;
}) {
  const { view, unassignedMembers, onPick, query, showOld, archivedMembers } = props;
  const full = useFullView();
  const alerts = view.members.filter((m) => m.attention && m.kind !== "old-lead").sort(alertOrder);
  const worktrees = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of view.members) if (m.agent.status !== "closed") map.set(m.agent.cwd, (map.get(m.agent.cwd) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]) as Folders;
  }, [view]);
  const hit = (m: Member | null) => (m && matchesSearch(m, query) ? m : null);
  const handoff = useMemo(() => handoffOf(view), [view]);

  // Default squad page: one tile per pinned Team. FULL brings back the plumbing view below.
  if (!full) {
    const teamCount = view.lanes.filter((l) => l.lane.id !== "_other" && l.lane.state !== "done").length;
    return (
      <div className="team-body">
        <header className="team-header">
          <h1>
            <NeonEmblem color={view.team.color} seed={view.team.id} size={32} />
            <span>{view.team.name}</span>
            <span className="h1-stats">
              {teamCount} TEAMS · <span className={view.needsYou > 0 ? "stat-alert" : ""}>{view.needsYou} NEED YOU</span>
            </span>
          </h1>
          <div className="team-actions">
            <button className="btn ok" data-testid="add-buddy-btn" onClick={props.onAddBuddy} title="Add a Team with its own Brainstorm">
              + TEAM
            </button>
            <button className="btn ghost" onClick={props.onSettings}>
              ⚙ SETTINGS
            </button>
            <FullToggle />
          </div>
        </header>
        <PinGrid
          view={view}
          onOpenAgent={(id) => {
            const pin = pinsForSquad(view).pinned.find((p) => p.brainstorm?.agent.id === id);
            if (pin) void props.onQuickStart(pin);
            else onPick(id);
          }}
          onQuickStart={props.onQuickStart}
        />
        <SquadUnsortedGroup view={view} onPick={onPick} />
        <IdeaInbox team={view.team} />
      </div>
    );
  }

  return (
    <div className="team-body">
      <header className="team-header">
        <h1>
          <NeonEmblem color={view.team.color} seed={view.team.id} size={32} />
          <span>{view.team.name}</span>
          <span className="h1-stats">
            <span className="stat-cyan">{view.running} WORKING</span> ·{" "}
            <span className={view.needsYou > 0 ? "stat-alert" : ""}>{view.needsYou} NEED YOU</span> · {view.members.length} AGENTS
          </span>
        </h1>
        <div className="team-actions">
          <PaseoUsageHeaderChip onOpenSettings={props.onSettings} />
          <button className="btn ok" data-testid="add-buddy-btn" onClick={props.onAddBuddy}>
            + TEAM
          </button>
          <button className="btn ok" onClick={props.onNewAgent}>
            + NEW AGENT
          </button>
          <button className="btn ghost" onClick={props.onSettings}>
            ⚙ SETTINGS
          </button>
          <FullToggle />
        </div>
      </header>

      {alerts.length > 0 && (
        <div className="header-alerts">
          {alerts.map((m) => (
            <AlertPill key={m.agent.id} m={m} onOpen={onPick} />
          ))}
        </div>
      )}
      <HandoffPanel handoff={handoff} />
      <UnassignedTray members={unassignedMembers} onPick={onPick} />
      <IdeaInbox team={view.team} />
      <TeamFeed team={view.team} />
      <SquadUnsortedGroup view={view} onPick={onPick} />

      {view.lanes.map(({ lane, lead, duplicateLeads, brainstorm, duplicateBrainstorms, topicBrainstorms, members }) => {
        const dupes = [...duplicateLeads, ...duplicateBrainstorms];
        const rest = members.filter((m) => m !== lead && m !== brainstorm && !dupes.includes(m) && !(topicBrainstorms ?? []).includes(m) && matchesSearch(m, query));
        const live = rest.filter((m) => m.kind !== "old-lead");
        const shownBs = query ? hit(brainstorm) : brainstorm;
        const shownLead = query ? hit(lead) : lead;
        return (
          <section key={lane.id} className="lane">
            <h2>{lane.name}</h2>
            {dupes.length > 0 && (
              <div className="dup-warning" role="alert">
                <b>⚠ DUPLICATE LIVE LEAD/BRAINSTORM · RETIRE ONE</b>
                {[lead, ...duplicateLeads, brainstorm, ...duplicateBrainstorms]
                  .filter((m): m is Member => !!m && (m === lead ? duplicateLeads.length > 0 : m === brainstorm ? duplicateBrainstorms.length > 0 : true))
                  .map((m) => (
                    <div key={m.agent.id} className="dup-row">
                      <span className="muted small">{m.kind}</span> {cleanTitle(m.agent.title)}{" "}
                      <ConfirmButton label={`Retire (${cleanTitle(m.agent.title)})`} armedLabel="Tap again to retire" busyLabel="Retiring…" tone="warn" onConfirm={() => retireAgent(m.agent, lane.name)} />
                    </div>
                  ))}
              </div>
            )}
            {lane.id !== "_other" && (
              <>
                {/* DESIGN T1-4: Brainstorm ("TALK HERE") in the top/primary slot; Lead ("RUNS THE WORK") in the secondary slot */}
                <div className="cards">
                  {shownBs ? (
                    <Card label="Brainstorm" m={shownBs} onPick={onPick} />
                  ) : !brainstorm ? (
                    <EmptyBrainstormCard
                      teamId={view.team.id}
                      laneId={lane.id}
                      laneName={lane.name}
                      cwd={lead?.agent.cwd || view.team.paths?.[0] || ""}
                      onPick={onPick}
                    />
                  ) : (
                    <Card label="Brainstorm" m={null} onPick={onPick} />
                  )}
                  <Card label="★ Lead" m={shownLead} onPick={onPick} onSuccessor={props.onSuccessor} />
                  {(topicBrainstorms ?? []).map((tb) => (
                    <Card key={tb.agent.id} label={`Topic Buddy · ${topicOfBrainstorm(tb.agent) || "topic"}`} m={tb} onPick={onPick} />
                  ))}
                </div>
                {[brainstorm, lead].map(
                  (m) =>
                    m && (
                      <div key={m.agent.id} className="card-tree">
                        <TreeChildren parentId={m.agent.id} onPick={onPick} />
                      </div>
                    ),
                )}
              </>
            )}
            <Section
              title="Needs you"
              members={live.filter((m) => m.attention && m.attention.tone !== "finished")}
              onPick={onPick}
            />
            <Section
              title="Working"
              members={live.filter((m) => !(m.attention && m.attention.tone !== "finished") && m.agent.status === "running")}
              onPick={onPick}
            />
            <Section
              title="Idle"
              members={live.filter(
                (m) => !(m.attention && m.attention.tone !== "finished") && m.agent.status !== "running" && m.agent.status !== "closed",
              )}
              onPick={onPick}
              archive
            />
            <Section title="Closed" collapsed members={live.filter((m) => m.agent.status === "closed")} onPick={onPick} archive />
            {showOld && (
              <Section title="Retired leads" collapsed members={rest.filter((m) => m.kind === "old-lead")} onPick={onPick} archive />
            )}
          </section>
        );
      })}
      {archivedMembers && <ArchivedSection members={archivedMembers} />}
      <LiveFolders worktrees={worktrees} />
    </div>
  );
});

function ShowClosedChip() {
  const { showClosed } = useTreeState();
  return (
    <button
      className={`tchip ${showClosed ? "on" : ""}`}
      title="Show closed agents in the nested agent tree"
      onClick={() => setTreeShowClosed(!showClosed)}
    >
      Show closed
    </button>
  );
}

const Toolbar = memo(function Toolbar(props: {
  screen: "teams" | "workspaces";
  onScreen: (s: "teams" | "workspaces") => void;
  workspaceCount: number;
  query: string;
  onQuery: (q: string) => void;
  showOld: boolean;
  onShowOld: (v: boolean) => void;
  showArchived: boolean;
  onShowArchived: (v: boolean) => void;
  dateGroup: DateBucket | "all";
  onDateGroup: (v: DateBucket | "all") => void;
}) {
  const uiScale = useUiScale();
  const uiScalePct = Math.round(uiScale * 100);
  const full = useFullView();
  return (
    <div className="toolbar">
      <div className="seg">
        <button className={props.screen === "teams" ? "on" : ""} onClick={() => props.onScreen("teams")}>
          SQUADS
        </button>
        <button className={props.screen === "workspaces" ? "on" : ""} onClick={() => props.onScreen("workspaces")}>
          WORKSPACES ({props.workspaceCount})
        </button>
      </div>
      {/* Agent search and plumbing chips only filter the FULL view. */}
      {props.screen === "teams" && full && (
        <>
          <input
            className="search"
            value={props.query}
            placeholder="Search title, id, model, label key=val…"
            onChange={(e) => props.onQuery(e.target.value)}
          />
          <button className={`tchip ${props.showOld ? "on" : ""}`} onClick={() => props.onShowOld(!props.showOld)}>
            Old leads
          </button>
          <button className={`tchip ${props.showArchived ? "on" : ""}`} onClick={() => props.onShowArchived(!props.showArchived)}>
            Archived
          </button>
          <ShowClosedChip />
        </>
      )}
      {props.screen === "teams" && (
        <select
          className="tchip"
          data-testid="roster-date-group-toggle"
          title="Find an agent by last-active day across all squads (enable Archived to include closed ones)"
          value={props.dateGroup}
          onChange={(e) => props.onDateGroup(e.target.value as DateBucket | "all")}
        >
          <option value="all">By squad</option>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="older">Older</option>
        </select>
      )}
      <button className="tchip" data-testid="global-transcript-search-btn" title="Search all transcripts" onClick={() => openOverlay("search")}>
        🔍
      </button>
      <button className="tchip" data-testid="shortcut-help-btn" title="Keyboard shortcuts (?)" onClick={() => openOverlay("shortcuts")}>
        ?
      </button>
      <button
        className={`tchip ui-scale-indicator ${uiScalePct !== 100 ? "on" : ""}`}
        onClick={() => cycleUiScalePreset(true)}
        title="Cycle UI scale (Ctrl+= / Ctrl+- / Ctrl+0)"
        data-testid="ui-scale-indicator"
      >
        {uiScalePct}%
      </button>
    </div>
  );
});

const useSheet = () => useSyncExternalStore(subscribePanes, () => getPanes().sheet);
const useSplit = () => useSyncExternalStore(subscribePanes, () => getPanes().split);

// Ctrl+= / Ctrl+- / Ctrl+0 UI scale, Ctrl+. focus, Ctrl+J top NEEDS YOU, Ctrl+1..9 tabs of the active pane. Esc stays the composer's.
function onShortcut(e: KeyboardEvent) {
  if (handleUiScaleKeyDown(e)) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (e.key === ".") toggleFocus();
  else if (e.key === "j" || e.key === "J") {
    const top = railAlerts().list[0];
    if (top) openAgent(top.agent.id);
  } else if (/^[1-9]$/.test(e.key)) activateNth(Number(e.key) - 1);
  else return;
  e.preventDefault();
}

const LICENSES_FALLBACK =
  "Paseo (@getpaseo/client, @getpaseo/protocol) — Apache-2.0, Copyright (c) 2025-present Mohamed Boudra. Full third-party license list unavailable offline.";

/** Reports which non-loopback addresses the server listens on (empty unless --lan / VIBESQUAD_LAN=1 / Settings). */
function useExposedIps(): string[] {
  const storeIps = useExposedIpsStore();
  useEffect(() => {
    let alive = true;
    fetch("/__vibesquad/health")
      .then((r) => r.json())
      .then((h) => {
        if (alive && Array.isArray(h?.exposedIps)) {
          setLanExposureState(Boolean(h.lanEnabled), h.exposedIps.map(String));
        }
        if (alive && Array.isArray(h?.configWarnings)) {
          setServerConfigWarnings(h.configWarnings);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return storeIps;
}

function AboutLicensesModal({ onClose, onChecklist }: { onClose: () => void; onChecklist: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const updaterStatus = useUpdaterStatus();
  const [upd, setUpd] = useState<UpdateCheck["state"]>("idle");
  useEffect(() => {
    void loadUpdaterStatus();
    let alive = true;
    fetch("/THIRD-PARTY-LICENSES.txt")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(LICENSES_FALLBACK));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Modal title="About VibeSquad & Third-Party Licenses" onClose={onClose} wide>
      <div data-testid="about-licenses-modal">
        <p data-testid="about-version-channel">
          <b>VibeSquad v{updaterStatus.currentVersion}</b> · Channel: <code>{updaterStatus.channel}</code>
        </p>
        <p>
          <button
            className="btn ghost small"
            data-testid="about-check-updates-btn"
            disabled={upd === "checking"}
            onClick={() => {
              setUpd("checking");
              void checkForUpdates().then((ok) => setUpd(ok ? "ok" : "error"));
            }}
          >
            {updateLabel(upd, updaterStatus.currentVersion)}
          </button>
        </p>
        <p>VibeSquad works with Paseo (pinned CLI v0.13.2).</p>
        <p>Licensed under the MIT License.</p>
        <p>
          <button className="btn ghost small" data-testid="about-setup-checklist-btn" onClick={onChecklist}>
            Setup Checklist
          </button>
        </p>
        <pre style={{ maxHeight: "50vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11 }}>{text ?? "Loading…"}</pre>
      </div>
    </Modal>
  );
}

export function App() {
  const { conn, archivedAgents, workspaces, providerUsage } = usePaseo();
  const teamsVersion = useTeams();
  const { members, views } = derived();
  const full = useFullView();
  // The Unassigned tray is plumbing: only FULL lists it in the sidebar or lets it be the selected squad.
  const sidebarViews = useMemo(() => (full ? views : views.filter((v) => v.team.id !== UNASSIGNED.id)), [full, views]);
  const focus = useFocusMode();
  const hasTabs = useHasTabs();
  const sheet = useSheet();
  const split = useSplit();
  const mobileTeamView = useMobileTeamView();
  const uiScale = useUiScale();
  const uiScaleHud = useUiScaleHud();
  const [modal, setModal] = useState<"new-agent" | "add-buddy" | "settings" | "pair-device" | "about" | "help" | "diagnostics" | "first-run" | null>(null);
  const [firstRunStatus, setFirstRunStatus] = useState<FirstRunStatus | null>(null);
  const exposedIps = useExposedIps();
  const [dismissedLanKey, setDismissedLanKey] = useState<string>(() => localStorage.getItem(DISMISSED_LAN_IPS_KEY) ?? "");
  useEffect(() => {
    if (exposedIps.length === 0 && dismissedLanKey !== "") {
      setDismissedLanKey("");
      localStorage.removeItem(DISMISSED_LAN_IPS_KEY);
    }
  }, [exposedIps, dismissedLanKey]);
  const updaterStatus = useUpdaterStatus();
  const configWarnings = useConfigWarnings();
  useEffect(() => {
    void loadUpdaterStatus();
    const id = setInterval(() => void loadUpdaterStatus(), 60_000);
    return () => clearInterval(id);
  }, []);
  const [successorId, setSuccessorId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState(() => parseUrlState(location.search).team ?? localStorage.getItem("vs.team") ?? views[0]?.team.id ?? "efi");
  const { needsSetup: profilesNeedSetup, setupDismissed: profilesSetupDismissed } = useProfiles();
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(() => readCollapsedTeams());
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth());
  const [screen, setScreen] = useState<"teams" | "workspaces">("teams");
  const [query, setQuery] = useState("");
  const [showOld, setShowOld] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [dateGroup, setDateGroup] = useState<DateBucket | "all">("all");
  const archivedMembers = useMemo(() => resolve(archivedAgents), [archivedAgents, teamsVersion]);
  useAttentionAlerts(members);

  // A lead past its handoff budget with no needs-you flag would otherwise sit silently (only the card's
  // SPAWN SUCCESSOR button hints at it). Flag it once; "handoff-flagged" stops a cleared flag re-firing.
  const flaggedLeads = useRef(new Set<string>());
  useEffect(() => {
    if (DEMO) return;
    for (const m of members) {
      const { flagTokens } = getLeadThresholds(m.team);
      if (m.kind !== "lead" || m.agent.archivedAt || usedTokens(m) < flagTokens) continue;
      const labels = (m.agent.labels ?? {}) as Record<string, string>;
      const needsValue = labels["needs-you"] || labels[LEGACY_NEEDS_LABEL];
      const flagged = !!needsValue && needsValue !== "cleared";
      if (flagged || labels["handoff-flagged"] || flaggedLeads.current.has(m.agent.id)) continue;
      flaggedLeads.current.add(m.agent.id);
      const reason = "Lead at 150k+ tokens: wrap up and hand off at a good stopping point";
      setNeedsYou({ ...m.agent, labels: { ...labels, "handoff-flagged": "1" } } as PaseoAgent, reason).catch(() => flaggedLeads.current.delete(m.agent.id));
    }
  }, [members]);

  useEffect(() => {
    if (DEMO) return;
    void fetchFirstRunStatus().then((s) => {
      if (!s) return;
      setFirstRunStatus(s);
      if (!s.ready || !localStorage.getItem(FIRST_RUN_DONE_KEY)) setModal((m) => m ?? "first-run");
    });
  }, []);

  useEffect(() => {
    applyUiScaleToDom(uiScale);
  }, [uiScale]);

  useEffect(() => {
    loadArchived(); // palette + date finder search archived agents too
  }, []);

  useEffect(() => {
    localStorage.setItem("vs.team", teamId);
  }, [teamId]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_TEAMS_KEY, JSON.stringify([...collapsedTeams]));
    } catch {}
  }, [collapsedTeams]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  useEffect(() => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  // Deep-link handling on startup (?agent=<id>&focus=needs-you) + service worker notificationclick messages.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const linkedAgent = params.get("agent");
    const linkedFocus = params.get("focus");
    if (linkedAgent) {
      openAgent(linkedAgent);
    }
    if (linkedFocus === "needs-you") {
      setFocus(true);
      setTimeout(() => {
        document.querySelector(".focus-rail, .header-alerts")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }, 60);
    }

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "vs:select-agent") {
        if (typeof data.agentId === "string" && data.agentId) {
          openAgent(data.agentId);
        }
        if (typeof data.url === "string" && data.url.includes("focus=needs-you")) {
          setFocus(true);
        }
      }
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
    };
  }, []);

  const view = sidebarViews.find((v) => v.team.id === teamId) ?? sidebarViews[0] ?? views[0];
  const activeTeamId = view?.team.id ?? teamId;

  // URL routing: ?team=&agent= mirrors the selection; Back/Forward restore it.
  const activeAgentId = useSyncExternalStore(subscribePanes, () => getPanes().leftActiveId);
  useEffect(() => {
    const next = serializeUrlState({ team: activeTeamId || null, agent: activeAgentId }, location.search);
    if (next !== (location.search || "")) history.pushState(null, "", `${location.pathname}${next}${location.hash}`);
  }, [activeTeamId, activeAgentId]);
  useEffect(() => {
    const onPop = () => {
      const u = parseUrlState(location.search);
      if (u.team) setTeamId(u.team);
      if (u.agent) openAgent(u.agent);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Stable callbacks so the memoized sidebar and team page skip renders they do not need.
  // Switching teams never touches open tabs.
  const onTeam = useCallback((id: string) => {
    exitPinFocus();
    setTeamId(id);
    setScreen("teams");
    setCollapsedTeams((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const onToggleTeamExpand = useCallback((id: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Clicking a squad name opens its overview (expanding it if collapsed); only the caret collapses.
  const onTeamHeaderClick = useCallback((id: string) => {
    exitPinFocus();
    setTeamId(id);
    setScreen("teams");
    setCollapsedTeams((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const onToggleAllTeams = useCallback(() => {
    setCollapsedTeams((prev) => {
      const allIds = sidebarViews.map((v) => v.team.id);
      const everyCollapsed = allIds.length > 0 && allIds.every((id) => prev.has(id));
      return everyCollapsed ? new Set() : new Set(allIds);
    });
  }, [sidebarViews]);

  const onToggleSidebarCollapse = useCallback(() => {
    setSidebarCollapsed((c) => !c);
  }, []);

  const onStartResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarCollapsed ? SIDEBAR_MIN_W : sidebarWidth;
      const scale = getUiScale() || 1;
      const onMove = (ev: MouseEvent) => {
        const rawW = startW + (ev.clientX - startX) / scale;
        if (rawW < 110) {
          setSidebarCollapsed(true);
        } else {
          setSidebarCollapsed(false);
          setSidebarWidth(Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(rawW))));
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarCollapsed, sidebarWidth],
  );

  const onAgent = useCallback((tid: string, aid: string) => {
    setTeamId(tid);
    selectAgent(aid);
    setScreen("teams");
  }, []);
  const openSettings = useCallback(() => setModal("settings"), []);
  const openPairDevice = useCallback(() => setModal("pair-device"), []);
  const openAbout = useCallback(() => setModal("about"), []);
  const openHelp = useCallback(() => setModal("help"), []);
  const openDiagnostics = useCallback(() => setModal("diagnostics"), []);
  const openAddBuddy = useCallback(() => setModal("add-buddy"), []);
  const openNewAgent = useCallback(() => setModal("new-agent"), []);
  const onSuccessor = useCallback((m: Member) => setSuccessorId(m.agent.id), []);
  // Pin click (grid tile, sidebar pin, rail tile): focus that Team's Brainstorm in the middle with the
  // other pins in the right rail; a pin with no live Brainstorm quick-starts one from its brief.
  const onQuickStart = useCallback<PinHandler>((pin) => {
    setTeamId(pin.squad.id);
    setScreen("teams");
    return focusPin(pin);
  }, []);
  const onRailPick = useCallback(
    (pin: Pin) => void focusPin(pin).catch((e) => alert(`Could not start ${pin.lane.name}: ${e}`)),
    [],
  );
  // The pinned layout (focus view + rail, or the clean grid) is the default page only: FULL, focus mode
  // and the Workspaces screen show the panes as before.
  const pinFocus = usePinFocus();
  const pinsHome = usePinsHome();
  const pinLayout = !full && !focus && screen === "teams";
  const pinFocusView = pinLayout && pinFocus ? views.find((v) => v.team.id === pinFocus.squadId) : undefined;
  const pinFocused = !!pinFocusView;
  const hidePanes = pinLayout && pinsHome && !pinFocused;
  const withPanes = (hasTabs || focus) && !pinFocused && !hidePanes;
  const leftPinLayout = useRef(false);
  useEffect(() => {
    if (!pinLayout) clearPinFocus();
    else if (leftPinLayout.current) exitPinFocus(); // back from FULL / focus mode: land on the grid
    leftPinLayout.current = !pinLayout;
  }, [pinLayout]);
  const dateGrouped = useMemo(() => {
    if (dateGroup === "all") return null;
    const pool = showArchived ? [...members, ...archivedMembers] : members;
    return pool
      .filter((m) => dateBucket(m.agent.updatedAt) === dateGroup && matchesSearch(m, query))
      .sort((a, b) => Date.parse(b.agent.updatedAt ?? "") - Date.parse(a.agent.updatedAt ?? ""));
  }, [dateGroup, showArchived, members, archivedMembers, query]);
  const paletteActions = useMemo(
    () => ({ newAgent: openNewAgent, settings: openSettings, workspaces: () => setScreen("workspaces"), toggleFocus }),
    [openNewAgent, openSettings],
  );
  const onPaletteAgent = useCallback((m: Member) => onAgent(m.team.id, m.agent.id), [onAgent]);
  const paneSuccessor = useCallback((id: string) => setSuccessorId(id), []);

  // Entering focus with nothing open shows the team's brainstorm or lead (opens it; never spawns).
  const defaultFocusAgentId =
    view?.lanes.find((l) => l.brainstorm)?.brainstorm?.agent.id ??
    view?.lanes.find((l) => l.lead)?.lead?.agent.id;
  useEffect(() => {
    if (focus && defaultFocusAgentId && !getPanes().leftTabs.length) openAgent(defaultFocusAgentId);
  }, [focus, defaultFocusAgentId]);
  const successorLead = successorId ? members.find((m) => m.agent.id === successorId && m.kind === "lead") : undefined;
  const unassignedMembers = useMemo(
    () =>
      members.filter(
        (m) =>
          !m.agent.archivedAt &&
          m.agent.status !== "closed" &&
          (m.team.id === UNASSIGNED.id || (m.agent.labels as Record<string, string> | undefined)?.orphan === "1"),
      ),
    [members],
  );
  const archivedForTeam = useMemo(
    () => (showArchived && view ? archivedMembers.filter((m) => m.team.id === view.team.id && matchesSearch(m, query)) : null),
    [showArchived, view, archivedMembers, query],
  );

  return (
    <div
      className={`app ${focus ? "focus" : ""} ${withPanes ? "with-panes" : ""} ${split && withPanes ? "split" : ""} ${pinFocused ? `pin-focus ${pinFocus?.agentId ? "" : "pin-no-drawer"}` : ""} ${hidePanes ? "pins-home" : ""} ${sheet ? "sheet-open" : ""} ${mobileTeamView ? "mobile-team-view" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {exposedIps.length > 0 && !isLanBannerDismissed(exposedIps, dismissedLanKey) && (
        <div className="exposed-network-banner" data-testid="exposed-network-banner" role="alert" style={{ gridColumn: "1 / -1", background: "#ff2a85", color: "#05060d", fontWeight: 800, padding: "6px 12px", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span>{`⚠ EXPOSED ON ${exposedIps.join(", ")} — LAN/meshnet access enabled`}</span>
          <button
            type="button"
            data-testid="dismiss-lan-banner-btn"
            aria-label="Dismiss LAN exposure banner"
            style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 900, fontSize: 16, color: "inherit", lineHeight: 1 }}
            onClick={() => {
              const key = lanIpSetKey(exposedIps);
              setDismissedLanKey(key);
              localStorage.setItem(DISMISSED_LAN_IPS_KEY, key);
            }}
          >
            ✕
          </button>
        </div>
      )}
      {configWarnings.length > 0 && (
        <div
          className="config-warning-banner"
          data-testid="config-warning-banner"
          role="alert"
          style={{
            gridColumn: "1 / -1",
            background: "#ffb000",
            color: "#05060d",
            fontWeight: 800,
            padding: "6px 12px",
            textAlign: "center",
          }}
        >
          {`⚠ Config JSON parse error (using fallback defaults without overwriting): ${configWarnings.join(" · ")}`}
        </div>
      )}
      {updaterStatus.updateAvailable && !updaterStatus.dismissed && (
        <div
          className="update-available-banner"
          data-testid="update-available-banner"
          role="alert"
          style={{
            gridColumn: "1 / -1",
            background: "#00f0ff",
            color: "#05060d",
            fontWeight: 800,
            padding: "6px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <span>{`Update available (v${updaterStatus.availableVersion}) — restart?`}</span>
          <button
            type="button"
            className="btn small"
            data-testid="update-restart-btn"
            style={{ background: "#05060d", color: "#00f0ff", borderColor: "#05060d" }}
            onClick={() => void triggerUpdateInstall()}
          >
            Restart &amp; Update
          </button>
          <button
            type="button"
            className="btn small ghost"
            data-testid="update-later-btn"
            style={{ color: "#05060d", borderColor: "#05060d" }}
            onClick={() => dismissUpdateBanner()}
          >
            Later
          </button>
        </div>
      )}
      <DaemonStatusBanner />
      {!focus && (
        <Sidebar
          views={sidebarViews}
          teamId={view?.team.id ?? ""}
          conn={conn}
          collapsedTeams={collapsedTeams}
          onTeamHeaderClick={onTeamHeaderClick}
          onToggleTeamExpand={onToggleTeamExpand}
          onToggleAllTeams={onToggleAllTeams}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebarCollapse={onToggleSidebarCollapse}
          onStartResize={onStartResize}
          usage={providerUsage}
          onTeam={onTeam}
          onPairDevice={openPairDevice}
          onAbout={openAbout}
          onHelp={openHelp}
          onDiagnostics={openDiagnostics}
          onSettings={openSettings}
          onAgent={onAgent}
          onQuickStart={onQuickStart}
          lanExposed={exposedIps.length > 0}
          lanIps={exposedIps}
        />
      )}
      {(focus || sheet) && (
        <FocusRail
          views={views}
          view={view}
          onTeam={onTeam}
          usage={providerUsage}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebarCollapse={onToggleSidebarCollapse}
          onStartResize={onStartResize}
        />
      )}
      {!focus && !pinFocused && (
        <main className="team-page main">
          <Toolbar
            screen={screen}
            onScreen={setScreen}
            workspaceCount={workspaces.size}
            query={query}
            onQuery={setQuery}
            showOld={showOld}
            onShowOld={setShowOld}
            showArchived={showArchived}
            onShowArchived={setShowArchived}
            dateGroup={dateGroup}
            onDateGroup={setDateGroup}
          />
          {screen === "workspaces" ? (
            <WorkspacesView />
          ) : dateGrouped ? (
            <div className="team-body date-group-list" data-testid="roster-date-group-list">
              {dateGrouped.length === 0 && <div className="muted">No agents active {dateGroup === "older" ? "before yesterday" : dateGroup} in any squad.</div>}
              {dateGrouped.map((m) => (
                <div key={m.agent.id} onContextMenu={(ev) => openContextMenu(ev, agentCtxItems(m.agent, { open: () => onAgent(m.team.id, m.agent.id), split: () => openAgentInTab(m.agent.id, "right"), archive: () => void archiveAgent(m.agent.id) }))}>
                  <div className="muted small">{m.team.name}</div>
                  <AgentRow m={m} onPick={(id) => onAgent(m.team.id, id)} />
                </div>
              ))}
            </div>
          ) : view ? (
            <TeamPage
              view={view}
              unassignedMembers={unassignedMembers}
              onPick={selectAgent}
              query={query}
              showOld={showOld}
              archivedMembers={archivedForTeam}
              onAddBuddy={openAddBuddy}
              onNewAgent={openNewAgent}
              onSettings={openSettings}
              onSuccessor={onSuccessor}
              onQuickStart={onQuickStart}
            />
          ) : (
            <div className="muted">Connecting to Paseo…</div>
          )}
        </main>
      )}
      {(hasTabs || focus || pinFocused) && (
        <AgentPanes
          onSuccessor={paneSuccessor}
          header={pinFocusView && pinFocus ? <PinFocusHeader view={pinFocusView} focus={pinFocus} onStart={onRailPick} /> : undefined}
        />
      )}
      {pinFocusView && pinFocus && <PinRail view={pinFocusView} focus={pinFocus} onPick={onRailPick} />}
      <PinToast />
      <MobileBar />
      {uiScaleHud && (
        <div className="ui-scale-hud" data-testid="ui-scale-hud" role="status" aria-live="polite">
          UI SCALE · {Math.round(uiScale * 100)}% <span className="muted">(Ctrl+0 to reset)</span>
        </div>
      )}
      {modal === "add-buddy" && view && (
        <AddBuddyModal
          view={view}
          onClose={() => setModal(null)}
          onCreated={selectAgent}
          onOpenExisting={(id) => {
            selectAgent(id);
            setModal(null);
          }}
        />
      )}
      {modal === "new-agent" && view && <NewAgentModal view={view} onClose={() => setModal(null)} onCreated={selectAgent} />}
      {modal === "settings" && <TeamSettingsModal onClose={() => setModal(null)} />}
      {modal === "pair-device" && <PairDeviceModal onClose={() => setModal(null)} />}
      {modal === "about" && <AboutLicensesModal onClose={() => setModal(null)} onChecklist={() => setModal("first-run")} />}
      {modal === "help" && <HelpModal onClose={() => setModal(null)} onTour={() => setModal("first-run")} />}
      {modal === "diagnostics" && <DiagnosticsModal onClose={() => setModal(null)} />}
      {modal === "first-run" && <FirstRunModal initial={firstRunStatus} onClose={() => setModal(null)} />}
      <CommandPaletteHost members={members} archived={archivedMembers} views={views} onAgent={onPaletteAgent} onTeam={onTeam} actions={paletteActions} />
      <BriefEditorHost />
      {!modal && profilesNeedSetup && !profilesSetupDismissed && <ProfileImportModal onClose={() => {}} />}
      {successorLead && (
        <HandoffModal
          view={views.find((v) => v.team.id === successorLead.team.id) ?? view!}
          lead={successorLead}
          onClose={() => setSuccessorId(null)}
          onCreated={selectAgent}
        />
      )}
    </div>
  );
}
