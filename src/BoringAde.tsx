import { useEffect, useState, type ReactNode } from "react";
import { AgentDrawer } from "./AgentDrawer";
import { IdeaInbox, refreshInboxCards, useInboxCards } from "./IdeaInbox";
import { openAgent, usePanes } from "./panes";
import { sendMessage, usePaseo } from "./paseo";
import { createQuickBugsPin } from "./pinActions";
import { openPinMember } from "./pinFocus";
import { isHubPin, perfectionPin, pinsForSquad, quickBugsChipState, type Pin } from "./pins";
import { formatTimestamp, setPref } from "./prefs";
import { runCheckin } from "./railCheckin";
import { skyZonesFor } from "./skyZonesLogic";
import type { TeamView } from "./teams";
import { TeamFeed } from "./TeamFeed";
import type { PinHandler } from "./PinGrid";
import { StatusDot } from "./ui";
import { UsageDashboard } from "./UsageDashboard";

export { VIBE_PICKED_KEY, VibePickerCards, FirstLaunchVibePicker, shouldShowFirstLaunchVibePicker } from "./FirstRunModal";

// Boring Mode B2 (docs/PLAN_BORING_MODE.md): the whole app as a corporate ADE. Sidebar of Projects > Conversations on the left,
// one centered chat (the existing AgentDrawer) or a plain dashboard on the right. Replaces the sky/tower entirely when app.vibe = "boring".
// Thanks to Antigravity by Google DeepMind for the layout inspiration.

type Role = "brainstorm" | "lead";
type Mode = "chat" | "project" | "usage";
type OverviewTab = "overview" | "inbox" | "feed";

/** Relative age ("5m", "2h", "1d") of the newest agent update on a pin; "" when none has one. */
export function boringConversationAge(pin: Pick<Pin, "brainstorm" | "lead" | "workers">, now = Date.now()): string {
  const stamps = [pin.brainstorm?.agent.updatedAt, pin.lead?.agent.updatedAt, ...pin.workers.map((w) => w.agent.updatedAt)].filter((s): s is string => Boolean(s));
  if (!stamps.length) return "";
  const latest = stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  return formatTimestamp(latest, "relative", now);
}

/**
 * Which agent the chat shows for a pin role. Normally the pin's own member; but right after a Buddy restart / provider switch the
 * drawer opens the successor (activeAgentId) before the pin re-resolves, and ignoring it snapped the chat back to the retired agent.
 */
export function resolvePinChatAgentId(
  pin: Pick<Pin, "brainstorm" | "lead"> & { lane?: { id?: string } },
  role: Role,
  activeAgentId: string | null | undefined,
  agents: ReadonlyMap<string, { id: string; labels?: Record<string, string> | null }>,
): string | null {
  const base = (role === "lead" ? pin.lead : pin.brainstorm)?.agent.id ?? null;
  if (!activeAgentId || activeAgentId === base) return base;
  const next = agents.get(activeAgentId);
  if (!next) return base;
  const labels = (next.labels ?? {}) as Record<string, string>;
  const laneOk = !pin.lane?.id || (labels.lane ?? "").toLowerCase() === String(pin.lane.id).toLowerCase();
  const roleOk = (labels.role ?? role) === role || (role === "brainstorm" && labels.role === "brainstorm");
  const successor = labels["vs.restarted-from"] === base || (base !== null && !agents.has(base));
  return laneOk && roleOk && successor ? next.id : base;
}

export function boringActiveRole(pin: Pick<Pin, "brainstorm" | "lead">, activeAgentId: string | null | undefined): Role {
  return activeAgentId && pin.lead?.agent.id === activeAgentId ? "lead" : "brainstorm";
}

export function boringSidebarModel(view: TeamView | undefined, now = Date.now()) {
  const zones = skyZonesFor(view);
  const bugs = quickBugsChipState(view);
  const zoneRow = (label: string, z: typeof zones.overlord) => ({
    label,
    agentId: z.agentId,
    status: z.member?.agent.status ?? "none",
    needsYou: z.member?.attention && z.member.attention.tone !== "finished" ? 1 : 0,
    age: formatTimestamp(z.member?.agent.updatedAt, "relative", now),
  });
  const core = {
    overlord: zoneRow("★ Overlord", zones.overlord),
    riffbot: zoneRow("RiffBot", zones.riffbot),
    bugs: {
      label: "Bugs (@bug)",
      pin: bugs.pin,
      agentId: bugs.pin?.brainstorm?.agent.id ?? bugs.pin?.lead?.agent.id ?? null,
      leadRunning: bugs.leadRunning,
      needsYou: bugs.needsYou,
      age: bugs.pin ? boringConversationAge(bugs.pin, now) : "",
    },
  };
  const conversations = (view ? pinsForSquad(view).pinned : [])
    .filter((p) => !isHubPin(p))
    .map((pin) => ({
      laneId: pin.lane.id,
      name: pin.lane.name,
      code: pin.lane.code ? `@${pin.lane.code}` : `@${pin.lane.id.slice(0, 3)}`,
      pin,
      brainstormId: pin.brainstorm?.agent.id ?? null,
      brainstormStatus: pin.brainstorm?.agent.status ?? "none",
      leadId: pin.lead?.agent.id ?? null,
      leadStatus: pin.lead?.agent.status ?? "none",
      needsYou: pin.needsYou,
      running: pin.running,
      age: boringConversationAge(pin, now),
    }));
  return { core, conversations };
}

type Props = {
  views: TeamView[];
  view: TeamView | undefined;
  onSelectSquad: (id: string) => void;
  onOpenPin: PinHandler;
  onSpinUpPin: (pin: Pin, profile?: string) => void;
  onSpinUpOverlord: (view: TeamView) => void;
  overlordBusy?: boolean;
  onAddBuddy: () => void;
  onNewSquad: () => void;
  onSettings: () => void;
  onSuccessor: (agentId: string) => void;
  /** App's banners, modals and overlays, so they stay mounted in Boring Mode. */
  children?: ReactNode;
};

const toVibespace = () => setPref("app.vibe", "fun");

export function BoringApp({ views, view, onSelectSquad, onOpenPin, onSpinUpPin, onSpinUpOverlord, overlordBusy = false, onAddBuddy, onNewSquad, onSettings, onSuccessor, children }: Props) {
  const [mode, setMode] = useState<Mode>("chat");
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>("brainstorm");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<OverviewTab>("overview");
  const [openIdleLanes, setOpenIdleLanes] = useState(false);
  const inboxCount = useInboxCards().length;
  const [feedCount, setFeedCount] = useState<number>(() => (globalThis as { __feedCount?: number }).__feedCount ?? 0);
  useEffect(() => {
    if (mode !== "chat" && mode !== "project") return;
    void refreshInboxCards?.();
    const teamId = view?.team.id;
    if (!teamId || typeof fetch !== "function") return;
    let live = true;
    fetch(`/__vibesquad/log?team=${encodeURIComponent(teamId)}`)
      .then((r) => r.json())
      .then((rows: unknown) => { if (live && Array.isArray(rows)) setFeedCount(rows.length); })
      .catch(() => {});
    return () => { live = false; };
  }, [mode, view?.team.id]);
  const { agents } = usePaseo();
  const panes = usePanes();
  const activeAgentId = panes.activePane === "left" ? panes.leftActiveId : panes.rightActiveId;
  const model = boringSidebarModel(view);
  const { core, conversations } = model;
  const zones = skyZonesFor(view);
  const hubPin = zones.hub;

  const currentConv = conversations.find((c) => c.laneId === selectedLaneId) ?? null;
  const currentPin: Pin | null = selectedLaneId === "_bugs" ? core.bugs.pin : currentConv?.pin ?? null;
  const inLane = Boolean(currentPin);
  const leadStatus = currentPin?.lead?.agent.status ?? "none";

  const pickRole = (pin: Pin, laneId: string, role: Role) => {
    setSelectedLaneId(laneId);
    setSelectedRole(role);
    setMode("chat");
    const m = role === "lead" ? pin.lead : pin.brainstorm;
    if (role === "lead") {
      if (m) openPinMember(pin, m.agent.id);
    } else if (m) openAgent(m.agent.id);
    else void onOpenPin(pin);
  };
  const pickCore = (laneId: "_overlord" | "_riffbot", agentId: string | null) => {
    setSelectedLaneId(laneId);
    setMode("chat");
    if (agentId) openAgent(agentId);
  };
  const pickBugs = () => {
    setSelectedLaneId("_bugs");
    setSelectedRole("brainstorm");
    setMode("chat");
    if (core.bugs.pin) {
      if (core.bugs.agentId) openAgent(core.bugs.agentId);
      else void onOpenPin(core.bugs.pin);
    } else if (view) void createQuickBugsPin(view.team.id).then((p) => void onOpenPin(p));
  };

  // Resolve the chat target.
  let agentId: string | null = null;
  let emptyKind: "overlord" | "riffbot" | "brainstorm" | "lead" = "riffbot";
  if (selectedLaneId === "_overlord") {
    agentId = zones.overlord.member?.agent.id ?? null;
    emptyKind = "overlord";
  } else if (selectedLaneId === "_riffbot") {
    agentId = zones.riffbot.member?.agent.id ?? null;
  } else if (currentPin) {
    emptyKind = selectedRole;
    agentId = resolvePinChatAgentId(currentPin, selectedRole, activeAgentId, agents);
  } else {
    agentId = (activeAgentId && agents.get(activeAgentId) ? activeAgentId : null) ?? zones.riffbot.member?.agent.id ?? zones.overlord.member?.agent.id ?? null;
  }
  const agent = agentId ? agents.get(agentId) : undefined;
  const topRole = currentPin ? selectedRole : boringActiveRole(currentPin ?? { brainstorm: null, lead: null }, agentId);

  const viewTitle =
    mode === "usage" ? "Usage & Workflows" : mode === "project" ? "Project Overview"
    : selectedLaneId === "_overlord" ? "Overlord" : selectedLaneId === "_riffbot" ? "RiffBot" : selectedLaneId === "_bugs" ? "Bugs (@bug)"
    : currentConv?.name ?? "Conversation";

  const emptyCard = () => {
    const spec = {
      overlord: { text: "No Overlord is running for this project yet.", cta: "Start Overlord", run: () => view && onSpinUpOverlord(view), disabled: overlordBusy },
      riffbot: { text: "RiffBot is sleeping.", cta: "Start RiffBot", run: () => hubPin && onSpinUpPin(hubPin), disabled: !hubPin },
      brainstorm: { text: "No Brainstorm session is running for this conversation yet.", cta: "Start Brainstorm", run: () => currentPin && onOpenPin(currentPin), disabled: !currentPin },
      lead: { text: "No Lead is running yet — ask Brainstorm to hand off a plan.", cta: "Switch to Brainstorm", run: () => setSelectedRole("brainstorm"), disabled: false },
    }[emptyKind];
    return (
      <div className="boring-empty-card" data-testid="boring-empty-card">
        <p>{spec.text}</p>
        <button type="button" className="boring-primary-cta" data-testid="boring-empty-cta" disabled={spec.disabled} onClick={() => void spec.run()}>
          {spec.cta}
        </button>
      </div>
    );
  };

  const badge = (n: number) => (n > 0 ? <span className="badge boring-badge">{n}</span> : null);
  const coreRow = (testid: string, label: string, status: string, needsYou: number, age: string, onClick: () => void, agentObj?: typeof agent) => (
    <button key={testid} type="button" className={`boring-core-row ${mode === "chat" && selectedLaneId && testid.endsWith(selectedLaneId.slice(1)) ? "on" : ""}`} data-testid={testid} onClick={onClick}>
      {agentObj ? <StatusDot agent={agentObj} /> : <span className={`boring-dot ${status}`} />}
      <span className="boring-row-label">{label}</span>
      <span className="boring-conv-age">{age}</span>
      {badge(needsYou)}
    </button>
  );
  const coreTile = (key: string, label: string, status: string, age: string, needsYou: number, startLabel: string | null, onClick: () => void, disabled = false) => (
    <div key={key} className="boring-lane-card boring-core-tile" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} data-testid={`boring-card-${key}`} onClick={() => !disabled && onClick()} onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}>
      <div className="boring-card-head">
        <span className={`boring-dot ${status}`} />
        <span className="boring-row-label">{label}</span>
        <span className="boring-conv-age">{age}</span>
        {needsYou > 0 && <span className="badge boring-badge">Needs you · {needsYou}</span>}
      </div>
      <div className="boring-card-line">{startLabel ?? status}</div>
    </div>
  );
  const laneCard = (c: (typeof conversations)[number]) => (
    <div key={c.laneId} className="boring-card boring-lane-card" role="button" tabIndex={0} data-testid={`boring-card-${c.laneId}`} onClick={() => pickRole(c.pin, c.laneId, "brainstorm")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickRole(c.pin, c.laneId, "brainstorm"); } }}>
      <div className="boring-card-head">
        <span className={`boring-dot ${c.running > 0 ? "running" : c.brainstormStatus}`} />
        <span className="boring-row-label">{c.name}</span>
        <code className="boring-conv-code">{c.code}</code>
        <span className="boring-conv-age">{c.age}</span>
        {c.needsYou > 0 && <span className="badge boring-badge">Needs you · {c.needsYou}</span>}
      </div>
      <div className="boring-card-line">Brainstorm · {c.brainstormStatus ?? "idle"}  ·  ★ Lead · {c.leadStatus ?? "none"}</div>
    </div>
  );
  const isActiveLane = (c: (typeof conversations)[number]) => c.needsYou > 0 || c.brainstormStatus === "running" || c.leadStatus === "running";
  const activeLanes = conversations.filter(isActiveLane);
  const idleLanes = conversations.filter((c) => !isActiveLane(c));
  const memberAgent = (id: string | null) => (id ? agents.get(id) : undefined);

  return (
    <div className="boring-app" data-testid="boring-app">
      <aside className="boring-sidebar" data-testid="boring-sidebar">
        <button type="button" className="boring-new-conv-btn" data-testid="boring-new-conv-btn" onClick={onAddBuddy}>
          + New Conversation
        </button>
        <div className="boring-project-header">
          {views.length > 1 ? (
            <select className="boring-project-select" data-testid="boring-project-select" aria-label="Project" value={view?.team.id ?? ""} onChange={(e) => onSelectSquad(e.target.value)}>
              {views.map((v) => (
                <option key={v.team.id} value={v.team.id}>{v.team.name}</option>
              ))}
            </select>
          ) : (
            <span className="boring-project-name">{view?.team.name ?? "No project"}</span>
          )}
          <button type="button" className={`boring-footer-btn${mode === "project" ? " on" : ""}`} data-testid="boring-project-overview-btn" onClick={() => setMode("project")}>
            Project Overview
          </button>
          <button type="button" className="boring-footer-btn" data-testid="boring-new-project-btn" onClick={onNewSquad}>
            + New Project
          </button>
        </div>
        <div className="boring-core-group" data-testid="boring-core-group">
          {coreRow("boring-core-overlord", core.overlord.label, core.overlord.status, core.overlord.needsYou, core.overlord.age, () => pickCore("_overlord", core.overlord.agentId), memberAgent(core.overlord.agentId))}
          {coreRow("boring-core-riffbot", core.riffbot.label, core.riffbot.status, core.riffbot.needsYou, core.riffbot.age, () => pickCore("_riffbot", core.riffbot.agentId), memberAgent(core.riffbot.agentId))}
          {coreRow("boring-core-bugs", core.bugs.label, core.bugs.leadRunning ? "running" : "none", core.bugs.needsYou, core.bugs.age, pickBugs, memberAgent(core.bugs.agentId))}
        </div>
        <div className="boring-conv-list" data-testid="boring-conv-list">
          {conversations.length === 0 && <p className="boring-muted">No conversations yet.</p>}
          {conversations.map((c) => (
            <div key={c.laneId} className={`boring-conv-row ${mode === "chat" && selectedLaneId === c.laneId ? "on" : ""}`} data-testid={`boring-conv-${c.laneId}`}>
              <button type="button" className="boring-conv-title" onClick={() => pickRole(c.pin, c.laneId, "brainstorm")}>
                <span className={`boring-dot ${c.running > 0 ? "running" : c.brainstormStatus}`} />
                <span className="boring-row-label">{c.name}</span>
                <code className="boring-conv-code">{c.code}</code>
                <span className="boring-conv-age">{c.age}</span>
                {badge(c.needsYou)}
              </button>
              <div className="boring-role-pills">
                <button type="button" className="boring-role-pill" data-testid={`boring-conv-brainstorm-${c.laneId}`} onClick={() => pickRole(c.pin, c.laneId, "brainstorm")}>
                  Brainstorm
                </button>
                <button type="button" className="boring-role-pill" data-testid={`boring-conv-lead-${c.laneId}`} onClick={() => pickRole(c.pin, c.laneId, "lead")}>
                  Lead
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="boring-sidebar-footer" data-testid="boring-sidebar-footer">
          <button type="button" className={`boring-footer-btn${mode === "usage" ? " on" : ""}`} data-testid="boring-usage-btn" onClick={() => setMode("usage")}>
            📊 Usage & Workflows
          </button>
          <button type="button" className="boring-footer-btn" data-testid="boring-settings-btn" onClick={onSettings}>
            ⚙ Settings
          </button>
          <button type="button" className="boring-footer-btn" data-testid="boring-switch-vibespace-btn" onClick={toVibespace}>
            ✦ Switch to Psycho
          </button>
        </div>
      </aside>
      <main className="boring-main" data-testid="boring-main">
        <header className="boring-topbar" data-testid="boring-topbar">
          <div className="boring-topbar-title">{view?.team.name ?? "No project"} › {viewTitle}</div>
          {mode === "chat" && inLane && (
            <div className="boring-topbar-switcher">
              <button type="button" className={`boring-switch-pill ${topRole === "brainstorm" ? "on" : ""}`} data-testid="boring-top-brainstorm" onClick={() => currentPin && selectedLaneId && pickRole(currentPin, selectedLaneId, "brainstorm")}>
                Brainstorm
              </button>
              <button type="button" className={`boring-switch-pill ${topRole === "lead" ? "on" : ""}`} data-testid="boring-top-lead" onClick={() => currentPin && selectedLaneId && pickRole(currentPin, selectedLaneId, "lead")}>
                ★ Lead · {leadStatus}
              </button>
              <button type="button" className="boring-checkin-btn" data-testid="boring-checkin-btn" disabled={!currentPin?.lead} onClick={() => currentPin && void runCheckin(currentPin, { open: openAgent, send: sendMessage })}>
                Check in
              </button>
            </div>
          )}
          <div className="boring-topbar-actions">
            {mode === "chat" && agent && (
              <button type="button" className={`boring-switch-pill ${detailsOpen ? "on" : ""}`} data-testid="boring-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
                {detailsOpen ? "▾ Details" : "⋯ Details"}
              </button>
            )}
          </div>
        </header>
        {mode === "usage" && (
          <div className="boring-dashboard-wrap" data-testid="boring-usage-view">
            <UsageDashboard perfection={{ pin: perfectionPin(views), onOpen: (p) => { setMode("chat"); setSelectedLaneId(p.lane.id); return onOpenPin(p); } }} />
          </div>
        )}
        {mode === "project" && (
          <div className="boring-dashboard-wrap" data-testid="boring-project-view">
            <div className="boring-overview-tabs" data-testid="boring-overview-tabs">
              <button type="button" className={`boring-switch-pill ${overviewTab === "overview" ? "on" : ""}`} data-testid="boring-tab-overview" onClick={() => setOverviewTab("overview")}>Overview</button>
              <button type="button" className={`boring-switch-pill ${overviewTab === "inbox" ? "on" : ""}`} data-testid="boring-tab-inbox" onClick={() => setOverviewTab("inbox")}>{`Idea Inbox (${inboxCount})`}</button>
              <button type="button" className={`boring-switch-pill ${overviewTab === "feed" ? "on" : ""}`} data-testid="boring-tab-feed" onClick={() => setOverviewTab("feed")}>{`Standup Feed (${feedCount})`}</button>
            </div>
            {overviewTab === "overview" && (
              <>
                <div className="boring-core-strip" data-testid="boring-core-strip">
                  {coreTile("overlord", core.overlord.label, core.overlord.status, core.overlord.age, core.overlord.needsYou, core.overlord.agentId ? null : "Start", () => (core.overlord.agentId ? pickCore("_overlord", core.overlord.agentId) : view && onSpinUpOverlord(view)), !core.overlord.agentId && overlordBusy)}
                  {coreTile("riffbot", core.riffbot.label, core.riffbot.status, core.riffbot.age, core.riffbot.needsYou, core.riffbot.agentId ? null : "Start", () => (core.riffbot.agentId ? pickCore("_riffbot", core.riffbot.agentId) : hubPin && onSpinUpPin(hubPin)))}
                  {coreTile("bugs", core.bugs.label, core.bugs.leadRunning ? "running" : "none", core.bugs.age, core.bugs.needsYou, null, pickBugs)}
                </div>
                <div className="boring-card-grid" data-testid="boring-card-grid">
                  {activeLanes.map(laneCard)}
                </div>
                {activeLanes.length === 0 && <p className="boring-muted">Nothing needs you right now.</p>}
                {idleLanes.length > 0 && (
                  <>
                    <button type="button" className="boring-idle-toggle" data-testid="boring-idle-lanes-toggle" aria-expanded={openIdleLanes} onClick={() => setOpenIdleLanes((v) => !v)}>
                      {openIdleLanes ? `▾ Hide ${idleLanes.length} idle lanes` : `▸ Show ${idleLanes.length} idle lanes`}
                    </button>
                    {openIdleLanes && <div className="boring-card-grid boring-idle-grid" data-testid="boring-idle-grid">{idleLanes.map(laneCard)}</div>}
                  </>
                )}
              </>
            )}
            {overviewTab === "inbox" && view && <IdeaInbox team={view.team} view={view} onOpenLane={onOpenPin} />}
            {overviewTab === "feed" && view && <TeamFeed team={view.team} />}
          </div>
        )}
        {mode === "chat" && (
          <div className={`boring-chat-column${detailsOpen ? " boring-details-open" : ""}`} data-testid="boring-chat-column">
            {agent ? <AgentDrawer key={agent.id} agent={agent} onClose={() => setMode("project")} onSuccessor={() => onSuccessor(agent.id)} active /> : emptyCard()}
          </div>
        )}
      </main>
      {children}
    </div>
  );
}
