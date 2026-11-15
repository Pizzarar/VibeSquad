import { useEffect, useState, type ReactNode } from "react";
import { AgentDrawer } from "./AgentDrawer";
import { BoringInbox, type NeedsYouRow } from "./BoringInbox";
import { openOverlay } from "./CommandPalette";
import { IdeaInbox, refreshInboxCards, useInboxCards } from "./IdeaInbox";
import { openAgent, usePanes } from "./panes";
import { sendMessage, usePaseo } from "./paseo";
import { createQuickBugsPin } from "./pinActions";
import { openPinMember, spinUpPin } from "./pinFocus";
import { isHubPin, isLive, liveBuddyId, perfectionPin, pinsForSquad, quickBugsChipState, type Pin } from "./pins";
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
  const member = role === "lead" ? pin.lead : pin.brainstorm;
  const rawBase = member?.agent.id ?? null;
  const base = isLive(member) ? rawBase : null; // a closed Buddy is "no session": show the Start card, not its drawer
  if (!activeAgentId || activeAgentId === rawBase) return base;
  const next = agents.get(activeAgentId);
  if (!next) return base;
  const labels = (next.labels ?? {}) as Record<string, string>;
  const laneOk = !pin.lane?.id || (labels.lane ?? "").toLowerCase() === String(pin.lane.id).toLowerCase();
  const roleOk = (labels.role ?? role) === role || (role === "brainstorm" && labels.role === "brainstorm");
  const successor = labels["vs.restarted-from"] === rawBase || (rawBase !== null && !agents.has(rawBase));
  return laneOk && roleOk && successor ? next.id : base;
}

/** Which sidebar entry owns an agent: the hub desk rows, the Bugs lane, or a feature lane (with the role it plays there). */
export function boringSelectionForAgent(view: TeamView | undefined, agentId: string | null | undefined): { laneId: string; role: Role | "worker" } | null {
  if (!view || !agentId) return null;
  const zones = skyZonesFor(view);
  if (zones.overlord.member?.agent.id === agentId || zones.overlord.agentId === agentId) return { laneId: "_overlord", role: "lead" };
  if (zones.riffbot.member?.agent.id === agentId || zones.riffbot.agentId === agentId) return { laneId: "_riffbot", role: "brainstorm" };
  const bugsPin = quickBugsChipState(view).pin;
  const roleIn = (pin: Pin): Role | "worker" | null =>
    pin.brainstorm?.agent.id === agentId ? "brainstorm" : pin.lead?.agent.id === agentId ? "lead" : (pin.workers ?? []).some((w) => w.agent.id === agentId) ? "worker" : null;
  if (bugsPin) {
    const r = roleIn(bugsPin);
    if (r) return { laneId: "_bugs", role: r };
  }
  for (const pin of pinsForSquad(view).pinned) {
    if (isHubPin(pin)) continue;
    const r = roleIn(pin);
    if (r) return { laneId: pin.lane.id, role: r };
  }
  return null;
}

const ACRONYMS = new Set(["ui", "ux", "ade", "api", "cli", "ci", "cd", "qa", "ai", "mcp", "sdk", "url", "db", "css", "html", "id", "pr", "vs", "ide", "os", "tts", "gpu", "cpu", "efi"]);
/** Normal-mode lane name: keeps known acronyms upper-case ("Ui Lab" → "UI Lab"). */
export function boringLaneLabel(name: string | null | undefined): string {
  return String(name ?? "").replace(/[A-Za-z]+/g, (w) => (ACRONYMS.has(w.toLowerCase()) && (w === w.toLowerCase() || w === w[0].toUpperCase() + w.slice(1).toLowerCase()) ? w.toUpperCase() : w));
}

const URGENCY: Record<string, number> = { permission: 0, "needs-you": 1, error: 2 };
const urgencyOf = (m: { attention?: { tone?: string } | null } | null | undefined) => (m?.attention?.tone != null && m.attention.tone in URGENCY ? URGENCY[m.attention.tone] : null);
/** A worker is shown live in the sidebar while it runs or needs you; everything else collapses into "N idle". */
export const boringWorkerIsLive = (w: { agent: { status?: string }; attention?: { tone?: string } | null }) => w.agent.status === "running" || urgencyOf(w) !== null;

/** The member a lane click opens: the most urgent one (permission › needs-you › error), else Brainstorm. */
export function boringLaneTarget(pin: Pick<Pin, "brainstorm" | "lead" | "workers">): { role: Role | "worker"; agentId: string | null } {
  const cands: { role: Role | "worker"; m: NonNullable<Pin["brainstorm"]>; rank: number }[] = [];
  const add = (role: Role | "worker", m: Pin["brainstorm"] | undefined) => { if (m) { const u = urgencyOf(m); cands.push({ role, m, rank: u ?? 99 }); } };
  add("brainstorm", pin.brainstorm);
  add("lead", pin.lead);
  for (const w of pin.workers ?? []) add("worker", w);
  const best = cands.filter((c) => c.rank < 99).sort((a, b) => a.rank - b.rank)[0];
  if (best) return { role: best.role, agentId: best.m.agent.id };
  return { role: "brainstorm", agentId: pin.brainstorm?.agent.id ?? null };
}

export type Crumb = { key: "project" | "lane" | "agent"; label: string };
/** Project › Lane › Agent, derived from what is actually selected (S8: no generic fallback title). */
export function boringBreadcrumb(o: { project: string; mode: Mode; laneLabel: string | null; agentLabel: string | null }): Crumb[] {
  const out: Crumb[] = [{ key: "project", label: o.project || "No project" }];
  if (o.mode === "usage") out.push({ key: "lane", label: "Usage & workflows" });
  else if (o.mode === "project") out.push({ key: "lane", label: "Overview" });
  else {
    if (o.laneLabel) out.push({ key: "lane", label: o.laneLabel });
    if (o.agentLabel) out.push({ key: "agent", label: o.agentLabel });
  }
  return out;
}

export function boringActiveRole(pin: Pick<Pin, "brainstorm" | "lead">, activeAgentId: string | null | undefined): Role {
  return activeAgentId && pin.lead?.agent.id === activeAgentId ? "lead" : "brainstorm";
}

const workerNeedsYou = (m: { attention?: { tone?: string } | null } | null | undefined) => Boolean(m?.attention && m.attention.tone !== "finished");

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
    overlord: zoneRow("Project Lead · Overlord", zones.overlord),
    riffbot: zoneRow("Project Brainstorm · RiffBot", zones.riffbot),
    bugs: {
      label: "Bugs (@bug)",
      pin: bugs.pin,
      agentId: bugs.pin ? liveBuddyId(bugs.pin) ?? (isLive(bugs.pin.lead) ? bugs.pin.lead.agent.id : null) : null,
      leadRunning: bugs.leadRunning,
      needsYou: bugs.needsYou,
      age: bugs.pin ? boringConversationAge(bugs.pin, now) : "",
    },
  };
  // 2.1: the hub lane (RiffBot/Overlord plus anything else parked in it) and every lane worker count, so these totals match the project badge.
  const hubNeedsYou = zones.hub?.needsYou ?? 0;
  const conversations = (view ? pinsForSquad(view).pinned : [])
    .filter((p) => !isHubPin(p))
    .map((pin) => ({
      laneId: pin.lane.id,
      name: boringLaneLabel(pin.lane.name),
      code: pin.lane.code ? `@${pin.lane.code}` : `@${pin.lane.id.slice(0, 3)}`,
      pin,
      brainstormId: pin.brainstorm?.agent.id ?? null,
      brainstormStatus: pin.brainstorm?.agent.status ?? "none",
      leadId: pin.lead?.agent.id ?? null,
      leadStatus: pin.lead?.agent.status ?? "none",
      needsYou: pin.needsYou,
      workerNeedsYou: (pin.workers ?? []).filter(workerNeedsYou).length,
      running: pin.running,
      age: boringConversationAge(pin, now),
    }));
  const laneTotal = conversations.reduce((n, c) => n + c.needsYou, 0);
  // The project badge (view.needsYou) counts every member; fall back to hub + lanes when a view doesn't carry it.
  const totalNeedsYou = Math.max(view?.needsYou ?? 0, hubNeedsYou + laneTotal);
  return { core, conversations, hubNeedsYou, totalNeedsYou };
}

/**
 * "Start Brainstorm" must really spawn. `onOpenPin` is `focusPin`, which never auto-spawns a dormant pin (it only shows the
 * Spin Up picker, which Boring Mode has no room for), so the CTA was a silent no-op (idea-246). Returns an error message, or null on success.
 */
export async function boringStartBrainstorm(pin: Pin, spinUp: (pin: Pin) => Promise<unknown> = spinUpPin): Promise<string | null> {
  try {
    await spinUp(pin);
    return null;
  } catch (e) {
    return (e as { message?: string } | null)?.message || String(e);
  }
}

/** Bugs with no lane yet: create the Squad's Bugs team, then spawn its Brainstorm. Returns an error message or null. */
export async function boringStartBugs(squadId: string, deps: { create?: (squadId: string) => Promise<Pin>; spinUp?: (pin: Pin) => Promise<unknown> } = {}): Promise<string | null> {
  try {
    const pin = await (deps.create ?? createQuickBugsPin)(squadId);
    return await boringStartBrainstorm(pin, deps.spinUp);
  } catch (e) {
    return (e as { message?: string } | null)?.message || String(e);
  }
}

const startInFlight = new Set<string>();

/** D1 (UX_REVIEW 1.5): one glyph vocabulary from status + attention tone: run, attn, err, stalled, idle, done. */
export type BoringStateGlyph = "run" | "attn" | "err" | "stalled" | "idle" | "done";
export function boringStateGlyph(status: string | null | undefined, tone?: string | null): BoringStateGlyph {
  if (tone === "error" || status === "error") return "err";
  if (tone === "permission" || tone === "needs-you") return "attn";
  if (status === "stalled") return "stalled";
  if (status === "running") return "run";
  if (tone === "finished") return "done";
  return "idle";
}
const glyphCls = (status: string | null | undefined, tone?: string | null) => `st-${boringStateGlyph(status, tone)}`;


export type LaneTableRow = {
  key: string;
  kind: "lane" | "desk";
  laneId: string;
  label: string;
  code: string;
  brainstorm: string;
  lead: string;
  workers: string;
  needsYou: number;
  running: number;
  lastEvent: string;
  age: string;
  sortAge: number;
};
const timeOf = (iso?: string | null) => { const t = Date.parse(iso ?? ""); return Number.isNaN(t) ? 0 : t; };
/** S9: one dense row per lane, urgency-sorted (needs you › running › most recent). The Project desk rows follow the lanes. */
export function boringLaneTableRows(
  model: ReturnType<typeof boringSidebarModel>,
  feed: { lane: string; text: string; ts: string; type?: string }[] = [],
): LaneTableRow[] {
  const lastFor = (c: { laneId: string; code: string }) => {
    const ids = new Set([c.laneId.toLowerCase(), c.code.replace(/^@/, "").toLowerCase()]);
    const hit = feed.filter((e) => ids.has(String(e.lane ?? "").replace(/^@/, "").toLowerCase())).sort((a, b) => b.ts.localeCompare(a.ts))[0];
    return hit ? hit.text : "";
  };
  const lanes: LaneTableRow[] = model.conversations.map((c) => {
    const live = (c.pin.workers ?? []).filter(boringWorkerIsLive).length;
    const total = (c.pin.workers ?? []).length;
    return {
      key: c.laneId, kind: "lane", laneId: c.laneId, label: c.name, code: c.code,
      brainstorm: c.brainstormStatus, lead: c.leadStatus,
      workers: total === 0 ? "—" : `${live} live${total > live ? ` · ${total - live} idle` : ""}`,
      needsYou: c.needsYou, running: c.running, lastEvent: lastFor(c), age: c.age,
      sortAge: Math.max(timeOf(c.pin.brainstorm?.agent.updatedAt), timeOf(c.pin.lead?.agent.updatedAt), ...(c.pin.workers ?? []).map((w) => timeOf(w.agent.updatedAt))),
    };
  });
  lanes.sort((a, b) => b.needsYou - a.needsYou || b.running - a.running || b.sortAge - a.sortAge);
  const desk = (id: "_overlord" | "_riffbot" | "_bugs", label: string, status: string, needsYou: number, age: string): LaneTableRow => ({
    key: id, kind: "desk", laneId: id, label, code: "", brainstorm: id === "_riffbot" || id === "_bugs" ? status : "—", lead: id === "_overlord" ? status : "—",
    workers: "—", needsYou, running: status === "running" ? 1 : 0, lastEvent: "", age, sortAge: 0,
  });
  return [
    ...lanes,
    desk("_overlord", model.core.overlord.label, model.core.overlord.status, model.core.overlord.needsYou, model.core.overlord.age),
    desk("_riffbot", model.core.riffbot.label, model.core.riffbot.status, model.core.riffbot.needsYou, model.core.riffbot.age),
    desk("_bugs", model.core.bugs.label, model.core.bugs.leadRunning ? "running" : "none", model.core.bugs.needsYou, model.core.bugs.age),
  ];
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
  /** Top-level health/update banners, rendered above the topbar. */
  banners?: ReactNode;
};

const toVibespace = () => setPref("app.vibe", "fun");

export function BoringApp({ views, view, onSelectSquad, onOpenPin, onSpinUpPin, onSpinUpOverlord, overlordBusy = false, onAddBuddy, onNewSquad, onSettings, onSuccessor, children, banners }: Props) {
  const [mode, setMode] = useState<Mode>("chat");
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>("brainstorm");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const [laneOpen, setLaneOpen] = useState<Record<string, boolean>>({});
  const [idleWorkersOpen, setIdleWorkersOpen] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<OverviewTab>("overview");
  const [openIdleLanes, setOpenIdleLanes] = useState(false);
  const [startState, setStartState] = useState<{ laneKey: string; busy: boolean; error: string | null } | null>(null);
  const [overviewLayout, setOverviewLayout] = useState<OverviewLayout>(() => {
    try { return localStorage.getItem(BORING_OVERVIEW_LAYOUT_KEY) === "map" ? "map" : "cards"; } catch { return "cards"; }
  });
  const pickOverviewLayout = (next: OverviewLayout) => {
    setOverviewLayout(next);
    try { localStorage.setItem(BORING_OVERVIEW_LAYOUT_KEY, next); } catch { /* ignore */ }
  };
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
  const allViews = views.length > 0 ? views : view ? [view] : [];
  // S8: the active agent owns the sidebar selection + breadcrumb. Keyed on the agent only, so switching project never snaps back.
  useEffect(() => {
    if (!activeAgentId) return;
    for (const v of allViews) {
      const sel = boringSelectionForAgent(v, activeAgentId);
      if (!sel) continue;
      if (v.team.id !== view?.team.id) onSelectSquad(v.team.id);
      setSelectedLaneId(sel.laneId);
      if (sel.role === "worker") setSelectedWorkerId(activeAgentId);
      else { setSelectedRole(sel.role); setSelectedWorkerId(null); }
      setMode("chat");
      return;
    }
  }, [activeAgentId]);
  const model = boringSidebarModel(view);
  const { core, conversations, hubNeedsYou, totalNeedsYou } = model;
  const zones = skyZonesFor(view);
  const hubPin = zones.hub;

  const currentConv = conversations.find((c) => c.laneId === selectedLaneId) ?? null;
  const currentPin: Pin | null = selectedLaneId === "_bugs" ? core.bugs.pin : currentConv?.pin ?? null;
  const inLane = Boolean(currentPin);
  const leadStatus = currentPin?.lead?.agent.status ?? "none";

  /** Open a lane member from any project: switches project first, then the lane, then the member. */
  const openTarget = (v: TeamView, pin: Pin, laneId: string, target: { role: Role | "worker"; agentId: string | null }) => {
    if (v.team.id !== view?.team.id) onSelectSquad(v.team.id);
    if (target.role === "worker" && target.agentId) {
      setSelectedLaneId(laneId);
      setSelectedWorkerId(target.agentId);
      setMode("chat");
      openAgent(target.agentId);
      return;
    }
    pickRole(pin, laneId, target.role === "worker" ? "brainstorm" : target.role);
  };
  const openLane = (v: TeamView, c: { pin: Pin; laneId: string }) => openTarget(v, c.pin, c.laneId, boringLaneTarget(c.pin));
  const pickRole = (pin: Pin, laneId: string, role: Role) => {
    setSelectedLaneId(laneId);
    setSelectedRole(role);
    setSelectedWorkerId(null);
    setMode("chat");
    const m = role === "lead" ? pin.lead : pin.brainstorm;
    if (role === "lead") {
      if (m) openPinMember(pin, m.agent.id);
    } else if (m) openAgent(m.agent.id);
    else void onOpenPin(pin);
  };
  const openNeedsYou = (row: NeedsYouRow) => {
    if (row.teamId !== view?.team.id) onSelectSquad(row.teamId);
    const sel = boringSelectionForAgent(row.view, row.item.id);
    setSelectedLaneId(sel?.laneId ?? null);
    if (sel && sel.role !== "worker") setSelectedRole(sel.role);
    setMode("chat");
    openAgent(row.item.id);
  };
  const pickCore = (laneId: "_overlord" | "_riffbot", agentId: string | null) => {
    setSelectedLaneId(laneId);
    setSelectedWorkerId(null);
    setMode("chat");
    if (agentId) openAgent(agentId);
  };
  const pickBugs = () => {
    setSelectedLaneId("_bugs");
    setSelectedRole("brainstorm");
    setSelectedWorkerId(null);
    setMode("chat");
    // Selecting only shows the lane (live Buddy) or its empty card; spawning is the card's "Start Brainstorm" (never focusPin).
    if (core.bugs.pin && core.bugs.agentId) openAgent(core.bugs.agentId);
  };

  // Resolve the chat target.
  let agentId: string | null = null;
  let emptyKind: "overlord" | "riffbot" | "brainstorm" | "lead" = "riffbot";
  if (selectedLaneId === "_overlord") {
    agentId = zones.overlord.member?.agent.id ?? null;
    emptyKind = "overlord";
  } else if (selectedLaneId === "_riffbot") {
    agentId = zones.riffbot.member?.agent.id ?? null;
  } else if (selectedLaneId === "_bugs" && !currentPin) {
    emptyKind = "brainstorm"; // no Bugs lane yet: the card's CTA creates it, never the RiffBot / stale-active-agent fallback
  } else if (currentPin) {
    emptyKind = selectedRole;
    agentId = selectedWorkerId && agents.get(selectedWorkerId) ? selectedWorkerId : resolvePinChatAgentId(currentPin, selectedRole, activeAgentId, agents);
  } else {
    agentId = (activeAgentId && agents.get(activeAgentId) ? activeAgentId : null) ?? zones.riffbot.member?.agent.id ?? zones.overlord.member?.agent.id ?? null;
  }
  const agent = agentId ? agents.get(agentId) : undefined;
  const topRole = currentPin ? selectedRole : boringActiveRole(currentPin ?? { brainstorm: null, lead: null }, agentId);
  const onWorker = Boolean(selectedWorkerId && agentId === selectedWorkerId);
  const liveWorkers = (currentPin?.workers ?? []).filter(boringWorkerIsLive);

  const laneLabel =
    selectedLaneId === "_overlord" || selectedLaneId === "_riffbot" ? "Project desk" : selectedLaneId === "_bugs" ? "Bugs (@bug)" : currentConv?.name ?? null;
  const roleLabel = selectedLaneId === "_overlord" ? "Overlord" : selectedLaneId === "_riffbot" ? "RiffBot" : onWorker ? (agent?.title ?? "Worker") : selectedRole === "lead" ? "Lead" : "Brainstorm";
  const crumbs = boringBreadcrumb({ project: view?.team.name ?? "", mode, laneLabel: agent || selectedLaneId ? laneLabel : null, agentLabel: agent || selectedLaneId ? roleLabel : null });
  const onCrumb = (key: Crumb["key"]) => {
    if (key === "project") setMode("project");
    else if (key === "lane" && mode === "chat") {
      if (currentConv && view) openLane(view, currentConv);
      else if (selectedLaneId === "_bugs") pickBugs();
    }
  };

  const surrealMotif = (
    <svg className="boring-surreal-motif" aria-hidden="true" viewBox="0 0 200 80" preserveAspectRatio="xMidYMid slice">
      <circle cx="100" cy="46" r="26" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="100" cy="46" rx="14" ry="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="100" cy="46" r="3.5" fill="currentColor" />
      <line x1="0" y1="58" x2="200" y2="58" stroke="currentColor" strokeWidth="1" />
      <line x1="30" y1="66" x2="170" y2="66" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );

  // One stable key per start: the Bugs lane may be created mid-flight (pin goes null -> set), which must not drop busy/error.
  const startKeyFor = (pin: Pin | null) => (selectedLaneId === "_bugs" ? "_bugs" : pin ? `${pin.squad?.id}/${pin.lane.id}` : null);
  const runStart = (laneKey: string, start: () => Promise<string | null>) => {
    const flightKey = `${view?.team.id}|${laneKey}`;
    if (startInFlight.has(flightKey)) return; // synchronous double-click guard (state alone lags a render)
    startInFlight.add(flightKey);
    setStartState({ laneKey, busy: true, error: null });
    void start()
      .then((error) => setStartState({ laneKey, busy: false, error }))
      .finally(() => startInFlight.delete(flightKey));
  };
  const startBrainstorm = (pin: Pin) => runStart(startKeyFor(pin) ?? "", () => boringStartBrainstorm(pin));
  const needsBugsLane = selectedLaneId === "_bugs" && !currentPin;
  const startBugs = () => view && runStart("_bugs", () => boringStartBugs(view.team.id));
  const emptyCard = () => {
    const startKey = startKeyFor(currentPin);
    const startFor = startKey && startState?.laneKey === startKey ? startState : null;
    const spec = {
      overlord: { text: "No Overlord is running for this project yet.", cta: "Start Overlord", run: () => view && onSpinUpOverlord(view), disabled: overlordBusy },
      riffbot: { text: "RiffBot is sleeping.", cta: "Start RiffBot", run: () => hubPin && onSpinUpPin(hubPin), disabled: !hubPin },
      brainstorm: { text: "No Brainstorm session is running for this conversation yet.", cta: startFor?.busy ? "Starting Brainstorm…" : "Start Brainstorm", run: () => (currentPin ? startBrainstorm(currentPin) : startBugs()), disabled: (!currentPin && !needsBugsLane) || Boolean(startFor?.busy) },
      lead: { text: "No Lead is running yet — ask Brainstorm to hand off a plan.", cta: "Switch to Brainstorm", run: () => setSelectedRole("brainstorm"), disabled: false },
    }[emptyKind];
    return (
      <div className="boring-empty-card" data-testid="boring-empty-card">
        {surrealMotif}
        <p>{spec.text}</p>
        <button type="button" className="boring-primary-cta" data-testid="boring-empty-cta" disabled={spec.disabled} onClick={() => void spec.run()}>
          {spec.cta}
        </button>
        {emptyKind === "brainstorm" && startFor?.error && (
          <p className="boring-empty-error" role="alert" data-testid="boring-start-error">Could not start Brainstorm: {startFor.error}</p>
        )}
      </div>
    );
  };

  const badge = (n: number) => (n > 0 ? <span className="badge boring-badge">{n}</span> : null);
  const coreRow = (testid: string, label: string, status: string, needsYou: number, age: string, onClick: () => void, agentObj?: typeof agent) => (
    <button key={testid} type="button" className={`boring-core-row ${mode === "chat" && selectedLaneId && testid.endsWith(selectedLaneId.slice(1)) ? "on" : ""}`} data-testid={testid} onClick={onClick}>
      {agentObj ? <StatusDot agent={agentObj} /> : <span className={`boring-dot ${status} ${glyphCls(status, needsYou > 0 ? "needs-you" : null)}`} />}
      <span className="boring-row-label">{label}</span>
      <span className="boring-conv-age">{age}</span>
      {badge(needsYou)}
    </button>
  );
  const coreTile = (key: string, label: string, status: string, age: string, needsYou: number, startLabel: string | null, onClick: () => void, disabled = false) => (
    <div key={key} className="boring-lane-card boring-core-tile" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} data-testid={`boring-card-${key}`} onClick={() => !disabled && onClick()} onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}>
      <div className="boring-card-head">
        <span className={`boring-dot ${status} ${glyphCls(status, needsYou > 0 ? "needs-you" : null)}`} />
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
        <span className={`boring-dot ${c.running > 0 ? "running" : c.brainstormStatus} ${glyphCls(c.running > 0 ? "running" : c.brainstormStatus, c.needsYou > 0 ? "needs-you" : null)}`} />
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
  const mapAttn = (m: { attention?: { tone?: string } | null } | null | undefined) => (m?.attention && m.attention.tone !== "finished" ? 1 : 0);
  const laneMap = (
    <div className="boring-lane-map" data-testid="boring-lane-map">
      {surrealMotif}
      <div className="boring-map-hubs">
        <button type="button" className={`boring-map-node boring-map-core ${boringNodeStateClass(core.overlord.status, core.overlord.needsYou)}`} data-testid="boring-map-core-overlord" onClick={() => (core.overlord.agentId ? pickCore("_overlord", core.overlord.agentId) : view && onSpinUpOverlord(view))}>{core.overlord.label}</button>
        <button type="button" className={`boring-map-node boring-map-core ${boringNodeStateClass(core.riffbot.status, core.riffbot.needsYou)}`} data-testid="boring-map-core-riffbot" onClick={() => (core.riffbot.agentId ? pickCore("_riffbot", core.riffbot.agentId) : hubPin && onSpinUpPin(hubPin))}>{core.riffbot.label}</button>
        <button type="button" className={`boring-map-node boring-map-core ${boringNodeStateClass(core.bugs.leadRunning ? "running" : "none", core.bugs.needsYou)}`} data-testid="boring-map-core-bugs" onClick={pickBugs}>{core.bugs.label}</button>
      </div>
      <svg className="boring-map-svg" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 10"><line x1="20" y1="0" x2="50" y2="10" /><line x1="50" y1="0" x2="50" y2="10" /><line x1="80" y1="0" x2="50" y2="10" /></svg>
      {conversations.length === 0 && <p className="boring-muted">No lanes yet.</p>}
      <div className="boring-map-grid">
      {conversations.map((c) => {
        const workers = (c.pin.workers ?? []).filter((w) => w.agent.status === "running" || mapAttn(w) > 0);
        return (
          <div key={c.laneId} className="boring-map-cluster" data-testid={`boring-map-cluster-${c.laneId}`}>
            <button type="button" className={`boring-map-node boring-map-lane ${boringNodeStateClass(c.running > 0 ? "running" : c.brainstormStatus, c.needsYou)}`} data-testid={`boring-map-lane-${c.laneId}`} onClick={() => pickRole(c.pin, c.laneId, "brainstorm")}>
              <span className={`boring-dot ${c.running > 0 ? "running" : c.brainstormStatus} ${glyphCls(c.running > 0 ? "running" : c.brainstormStatus, c.needsYou > 0 ? "needs-you" : null)}`} />
              <span className="boring-row-label">{c.name}</span>
              <code className="boring-conv-code">{c.code}</code>
              <span className="boring-conv-age">{c.age}</span>
              {c.needsYou > 0 && <span className="badge boring-badge">Needs you · {c.needsYou}</span>}
            </button>
            <svg className="boring-map-lines" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 20 100">
              {Array.from({ length: 2 + workers.length }, (_, i) => (
                <path key={i} d={`M0 50 C10 50 10 ${(100 * (i + 0.5)) / (2 + workers.length)} 20 ${(100 * (i + 0.5)) / (2 + workers.length)}`} />
              ))}
            </svg>
            <div className="boring-map-children">
              <button type="button" className={`boring-map-node boring-map-agent ${boringNodeStateClass(c.brainstormStatus, mapAttn(c.pin.brainstorm))}`} data-testid={`boring-map-bs-${c.laneId}`} onClick={() => pickRole(c.pin, c.laneId, "brainstorm")}>{`💬 Brainstorm · ${c.brainstormStatus ?? "none"}`}</button>
              <button type="button" className={`boring-map-node boring-map-agent ${boringNodeStateClass(c.leadStatus, mapAttn(c.pin.lead))}`} data-testid={`boring-map-lead-${c.laneId}`} onClick={() => pickRole(c.pin, c.laneId, "lead")}>{`★ Lead · ${c.leadStatus ?? "none"}`}</button>
              {workers.map((w) => (
                <button key={w.agent.id} type="button" className={`boring-map-node boring-map-agent boring-map-worker ${boringNodeStateClass(w.agent.status, mapAttn(w))}`} data-testid={`boring-map-worker-${w.agent.id}`} onClick={() => { setSelectedLaneId(c.laneId); setMode("chat"); openAgent(w.agent.id); }}>{`⚙ ${w.agent.title ?? w.agent.id.slice(0, 8)} · ${w.agent.status}`}</button>
              ))}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
  const memberAgent = (id: string | null) => (id ? agents.get(id) : undefined);
  const activeTeamId = view?.team.id ?? "";
  const projectIsOpen = (id: string) => projectOpen[id] ?? id === activeTeamId;
  const selectProject = (id: string) => {
    if (id === activeTeamId) setProjectOpen((o) => ({ ...o, [id]: !projectIsOpen(id) }));
    else {
      // Multiple projects can stay expanded: keep the one we leave open.
      setProjectOpen((o) => ({ ...o, [activeTeamId]: o[activeTeamId] ?? true, [id]: true }));
      onSelectSquad(id);
    }
  };
  const workerRow = (v: TeamView, c: { pin: Pin; laneId: string }, w: Pin["workers"][number]) => (
    <button key={w.agent.id} type="button" className={`boring-worker-row${selectedWorkerId === w.agent.id && agentId === w.agent.id ? " on" : ""}`} data-testid={`boring-worker-${w.agent.id}`} onClick={() => openTarget(v, c.pin, c.laneId, { role: "worker", agentId: w.agent.id })}>
      <span className={`boring-dot ${w.agent.status} ${glyphCls(w.agent.status, w.attention?.tone)}`} />
      <span className="boring-row-label">{w.agent.title ?? w.agent.id.slice(0, 8)}</span>
      <span className="boring-conv-age">{formatTimestamp(w.agent.updatedAt, "relative")}</span>
    </button>
  );
  const convRow = (v: TeamView, c: ReturnType<typeof boringSidebarModel>["conversations"][number]) => {
    const key = `${v.team.id}/${c.laneId}`;
    const isSel = v.team.id === activeTeamId && mode === "chat" && selectedLaneId === c.laneId;
    const open = laneOpen[key] ?? isSel;
    const workers = c.pin.workers ?? [];
    const live = workers.filter(boringWorkerIsLive);
    const idle = workers.filter((w) => !boringWorkerIsLive(w));
    const idleOpen = Boolean(idleWorkersOpen[key]);
    return (
      <div key={c.laneId} className={`boring-conv-row ${isSel ? "on" : ""}`} data-testid={`boring-conv-${c.laneId}`}>
        <div className="boring-conv-line">
          <button type="button" className="boring-chevron-btn" data-testid={`boring-conv-toggle-${c.laneId}`} aria-expanded={open} aria-label={open ? "Collapse workers" : "Expand workers"} disabled={workers.length === 0} onClick={() => setLaneOpen((o) => ({ ...o, [key]: !open }))}>
            {workers.length === 0 ? "" : open ? "▾" : "▸"}
          </button>
          <button type="button" className="boring-conv-title" onClick={() => openLane(v, c)}>
            <span className={`boring-dot ${c.running > 0 ? "running" : c.brainstormStatus} ${glyphCls(c.running > 0 ? "running" : c.brainstormStatus, c.needsYou > 0 ? "needs-you" : null)}`} />
            <span className="boring-row-label">{c.name}</span>
            <code className="boring-conv-code">{c.code}</code>
            <span className="boring-conv-age">{c.age}</span>
            {badge(c.needsYou)}
          </button>
        </div>
        {open && workers.length > 0 && (
          <div className="boring-worker-list" data-testid={`boring-workers-${c.laneId}`}>
            {live.map((w) => workerRow(v, c, w))}
            {idle.length > 0 && (
              <>
                <button type="button" className="boring-idle-toggle boring-worker-idle" data-testid={`boring-workers-idle-${c.laneId}`} aria-expanded={idleOpen} onClick={() => setIdleWorkersOpen((o) => ({ ...o, [key]: !idleOpen }))}>
                  {idleOpen ? "▾" : "▸"} {idle.length} idle
                </button>
                {idleOpen && idle.map((w) => workerRow(v, c, w))}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="boring-app" data-testid="boring-app">
      <aside className="boring-sidebar" data-testid="boring-sidebar">
        <button type="button" className="boring-new-conv-btn" data-testid="boring-new-conv-btn" onClick={onAddBuddy}>
          + New lane
        </button>
        <BoringInbox views={views.length > 0 ? views : view ? [view] : []} onOpen={openNeedsYou} />
        <div className="boring-project-header">
          <div className="boring-project-tree" data-testid="boring-project-tree">
            {allViews.map((v) => {
              const active = v.team.id === activeTeamId;
              const open = projectIsOpen(v.team.id);
              return (
                <div key={v.team.id} className="boring-project-block">
                  <button type="button" className={"boring-project-row" + (active ? " on" : "")} data-testid={`boring-project-header-${v.team.id}`} aria-expanded={open} onClick={() => selectProject(v.team.id)}>
                    <span className="boring-chevron">{open ? "▾" : "▸"}</span>
                    <span className={`boring-dot ${(v.running ?? 0) > 0 ? "running" : "idle"} ${glyphCls((v.running ?? 0) > 0 ? "running" : "idle", (v.needsYou ?? 0) > 0 ? "needs-you" : null)}`} />
                    <span className="boring-project-name">{v.team.name}</span>
                    {(v.needsYou ?? 0) > 0 && <span className="badge boring-badge">{v.needsYou}</span>}
                  </button>
                  {open && !active && (
                    <div className="boring-project-lanes" data-testid={`boring-project-lanes-${v.team.id}`}>
                      {boringSidebarModel(v).conversations.map((c) => convRow(v, c))}
                    </div>
                  )}
                </div>
              );
            })}
            {views.length === 0 && !view && <span className="boring-project-name">No project</span>}
          </div>
          <button type="button" className={`boring-footer-btn${mode === "project" ? " on" : ""}`} data-testid="boring-project-overview-btn" onClick={() => setMode("project")}>
            Overview{badge(totalNeedsYou)}
          </button>
          <button type="button" className="boring-footer-btn" data-testid="boring-new-project-btn" onClick={onNewSquad}>
            + New project
          </button>
        </div>
        {projectIsOpen(activeTeamId) && (
        <div className="boring-core-group boring-trinity-card" data-testid="boring-core-group">
          <div className="boring-section-label" data-testid="boring-trinity-label"><span>Project desk</span>{badge(hubNeedsYou)}</div>
          {coreRow("boring-core-overlord", core.overlord.label, core.overlord.status, core.overlord.needsYou, core.overlord.age, () => pickCore("_overlord", core.overlord.agentId), memberAgent(core.overlord.agentId))}
          {coreRow("boring-core-riffbot", core.riffbot.label, core.riffbot.status, core.riffbot.needsYou, core.riffbot.age, () => pickCore("_riffbot", core.riffbot.agentId), memberAgent(core.riffbot.agentId))}
          {coreRow("boring-core-bugs", core.bugs.label, core.bugs.leadRunning ? "running" : "none", core.bugs.needsYou, core.bugs.age, pickBugs, memberAgent(core.bugs.agentId))}
        </div>
        )}
        {projectIsOpen(activeTeamId) && (
        <div className="boring-conv-list" data-testid="boring-conv-list">
          <div className="boring-section-label" data-testid="boring-lanes-label">Lanes</div>
          {conversations.length === 0 && <p className="boring-muted">No lanes yet.</p>}
          {conversations.map((c) => (view ? convRow(view, c) : null))}
        </div>
        )}
        <div className="boring-sidebar-footer" data-testid="boring-sidebar-footer">
          <button type="button" className={`boring-footer-btn${mode === "usage" ? " on" : ""}`} data-testid="boring-usage-btn" onClick={() => setMode("usage")}>
            Usage & workflows
          </button>
          <button type="button" className="boring-footer-btn" data-testid="boring-settings-btn" onClick={onSettings}>
            Settings
          </button>
          <button type="button" className="boring-footer-btn" data-testid="boring-switch-vibespace-btn" onClick={toVibespace}>
            Switch to Psycho
          </button>
        </div>
      </aside>
      <main className="boring-main" data-testid="boring-main">
        {banners}
        <header className="boring-topbar" data-testid="boring-topbar">
          <nav className="boring-topbar-title boring-breadcrumb" data-testid="boring-breadcrumb" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={c.key} className="boring-crumb-seg">
                {i > 0 && <span className="boring-crumb-sep" aria-hidden="true">›</span>}
                {i === crumbs.length - 1 ? (
                  <span className="boring-crumb-cur" data-testid={`boring-crumb-${c.key}`} aria-current="page">{c.label}</span>
                ) : (
                  <button type="button" className="boring-crumb-btn" data-testid={`boring-crumb-${c.key}`} onClick={() => onCrumb(c.key)}>{c.label}</button>
                )}
              </span>
            ))}
          </nav>
          {mode === "chat" && inLane && (
            <div className="boring-topbar-switcher">
              <button type="button" className={`boring-switch-pill ${!onWorker && topRole === "brainstorm" ? "on" : ""}`} data-testid="boring-top-brainstorm" onClick={() => currentPin && selectedLaneId && pickRole(currentPin, selectedLaneId, "brainstorm")}>
                Brainstorm
              </button>
              <button type="button" className={`boring-switch-pill ${!onWorker && topRole === "lead" ? "on" : ""}`} data-testid="boring-top-lead" onClick={() => currentPin && selectedLaneId && pickRole(currentPin, selectedLaneId, "lead")}>
                ★ Lead · {leadStatus}
              </button>
              {liveWorkers.map((w) => (
                <button key={w.agent.id} type="button" className={`boring-switch-pill boring-worker-tab ${selectedWorkerId === w.agent.id ? "on" : ""}`} data-testid={`boring-top-worker-${w.agent.id}`} title={w.agent.title ?? w.agent.id} onClick={() => currentPin && selectedLaneId && openTarget(view!, currentPin, selectedLaneId, { role: "worker", agentId: w.agent.id })}>
                  ⚙ {w.agent.title ?? w.agent.id.slice(0, 8)}
                </button>
              ))}
              <button type="button" className="boring-checkin-btn" data-testid="boring-checkin-btn" disabled={!currentPin?.lead} onClick={() => currentPin && void runCheckin(currentPin, { open: openAgent, send: sendMessage })}>
                Check in
              </button>
            </div>
          )}
          <div className="boring-topbar-actions">
            <button type="button" className="boring-switch-pill" data-testid="boring-global-search-btn" title="Search all transcripts" aria-label="Search transcripts" onClick={() => openOverlay("search")}>Search</button>
            <button type="button" className="boring-switch-pill" data-testid="boring-shortcuts-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => openOverlay("shortcuts")}>Shortcuts <kbd className="boring-kbd">?</kbd></button>
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
            <div className="boring-overview-bar">
            <div className="boring-overview-tabs" data-testid="boring-overview-tabs">
              <button type="button" className={`boring-switch-pill ${overviewTab === "overview" ? "on" : ""}`} data-testid="boring-tab-overview" onClick={() => setOverviewTab("overview")}>Overview</button>
              <button type="button" className={`boring-switch-pill ${overviewTab === "inbox" ? "on" : ""}`} data-testid="boring-tab-inbox" onClick={() => setOverviewTab("inbox")}>{`Idea Inbox (${inboxCount})`}</button>
              <button type="button" className={`boring-switch-pill ${overviewTab === "feed" ? "on" : ""}`} data-testid="boring-tab-feed" onClick={() => setOverviewTab("feed")}>{`Standup Feed (${feedCount})`}</button>
            </div>
            {overviewTab === "overview" && (
              <div className="boring-overview-tabs boring-layout-toggle" data-testid="boring-overview-layout-toggle">
                <button type="button" className={`boring-switch-pill ${overviewLayout === "cards" ? "on" : ""}`} data-testid="boring-layout-cards" onClick={() => pickOverviewLayout("cards")}>Cards</button>
                <button type="button" className={`boring-switch-pill ${overviewLayout === "map" ? "on" : ""}`} data-testid="boring-layout-map" onClick={() => pickOverviewLayout("map")}>Map</button>
              </div>
            )}
            </div>
            {overviewTab === "overview" && overviewLayout === "map" && laneMap}
            {overviewTab === "overview" && overviewLayout === "cards" && (
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
            {agent ? <AgentDrawer key={agent.id} agent={agent} onClose={() => setMode("project")} onSuccessor={() => onSuccessor(agent.id)} active pinDecisions /> : emptyCard()}
          </div>
        )}
      </main>
      {children}
    </div>
  );
}
