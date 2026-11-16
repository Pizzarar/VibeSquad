import { useEffect, useState, type ReactNode } from "react";
import { AgentDrawer } from "./AgentDrawer";
import { stalledCount } from "./attentionItems";
import { toolRunningSecondsAt } from "./openTools";
import { BoringInbox, type NeedsYouRow } from "./BoringInbox";
import { openOverlay } from "./CommandPalette";
import { IdeaInbox, refreshInboxCards, useInboxCards } from "./IdeaInbox";
import { openAgent, usePanes } from "./panes";
import { sendMessage, usePaseo } from "./paseo";
import { createQuickBugsPin } from "./pinActions";
import { openPinMember, spinUpPin } from "./pinFocus";
import { boringLaneLabel } from "./boringLocation";
import { isHubPin, isLive, liveBuddyId, perfectionPin, pinsForSquad, quickBugsChipState, type Pin } from "./pins";
import { formatTimestamp, setPref } from "./prefs";
import { runCheckin } from "./railCheckin";
import { skyZonesFor } from "./skyZonesLogic";
import type { Member, TeamView } from "./teams";
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
  if ((zones.hub?.workers ?? []).some((w) => w.agent.id === agentId)) return { laneId: "_desk", role: "worker" };
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
    // A lane named after the project (id === team id) is the Desk's own: its members show as Desk rows, not a second "VibeSquad" lane.
    if (r) return pin.lane.id === view.team.id ? { laneId: "_desk", role: "worker" } : { laneId: pin.lane.id, role: r };
  }
  return null;
}

/** Where an agent opened from outside the sidebar (?agent= deep link, Ctrl+J) lands: always the chat; the lane/role only when the agent belongs to a pinned lane. */
export function boringAgentLanding(views: TeamView[], agentId: string | null | undefined, known: (id: string) => boolean = () => true): { view: TeamView | null; sel: ReturnType<typeof boringSelectionForAgent>; mode: "chat" } | null {
  if (!agentId) return null;
  for (const v of views) {
    const sel = boringSelectionForAgent(v, agentId);
    if (sel) return { view: v, sel, mode: "chat" };
  }
  return known(agentId) ? { view: null, sel: null, mode: "chat" } : null;
}

export { boringLaneLabel };

/** Ctrl+J (App) asks the Normal-mode shell to open an agent like a Needs-you click; preventDefault()ed = handled. */
export const BORING_OPEN_AGENT_EVENT = "vs:boring-open-agent";

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

export type ActiveSelection = { teamId: string | null; mode: Mode; laneId: string | null; role: Role | "worker" | null; workerId: string | null; agentLabel: string | null; rowKey: string | null };
/**
 * R2.1: the ONE derivation of "what is selected", read by the sidebar `.on` highlight (at most one row) and the breadcrumb.
 * In chat it follows the agent actually on screen (resolved across every project, so Ctrl+J / Needs-you jumps land right);
 * the lane/role state is only the fallback while no agent is shown (Start card). rowKey = `${teamId}|project|desk:lead|desk:brainstorm|lane:<id>|worker:<id>`.
 */
export function boringActiveSelection(o: { mode: Mode; views: TeamView[]; teamId: string | null; agentId: string | null; agentTitle?: string | null; laneId: string | null; role: Role; workerId: string | null }): ActiveSelection {
  const base = { teamId: o.teamId, mode: o.mode, laneId: null, role: null, workerId: null, agentLabel: null, rowKey: null } as ActiveSelection;
  if (o.mode === "usage") return base;
  if (o.mode === "project") return { ...base, rowKey: o.teamId ? `${o.teamId}|project` : null };
  let teamId = o.teamId;
  let laneId = o.laneId;
  let role: Role | "worker" | null = o.workerId && o.agentId === o.workerId ? "worker" : laneId ? o.role : null;
  if (o.agentId) {
    const ordered = [...o.views.filter((v) => v.team.id === o.teamId), ...o.views.filter((v) => v.team.id !== o.teamId)];
    for (const v of ordered) {
      const sel = boringSelectionForAgent(v, o.agentId);
      if (sel) { teamId = v.team.id; laneId = sel.laneId; role = sel.role; break; }
    }
  }
  const workerId = role === "worker" ? o.agentId : null;
  const agentLabel = !laneId ? null : role === "worker" ? o.agentTitle || "Worker" : laneId === "_overlord" ? "Overlord" : laneId === "_riffbot" ? "RiffBot" : role === "lead" ? "Lead" : "Brainstorm";
  const rowKey = !teamId || !laneId ? null : workerId ? `${teamId}|worker:${workerId}` : laneId === "_overlord" ? `${teamId}|desk:lead` : laneId === "_riffbot" ? `${teamId}|desk:brainstorm` : `${teamId}|lane:${laneId}`;
  return { teamId, mode: "chat", laneId, role, workerId, agentLabel, rowKey };
}

/** R3.5: the sidebar header carries the fixed app name, never the current project (the breadcrumb owns that). */
export const APP_NAME = "VibeSquad";
/** R3.1: folded-away workers as "N running · M idle" (zero parts omitted); null when nothing is folded. */
export function boringWorkerFold(rest: { agent: { status?: string; archivedAt?: string | null } }[]): string | null {
  if (rest.length === 0) return null;
  const running = rest.filter((w) => boringWorkerIsLive(w as never)).length;
  return [running > 0 && `${running} running`, rest.length - running > 0 && `${rest.length - running} idle`].filter(Boolean).join(" · ");
}
/** R3.1: open the right panel on its Workers tab. A not-yet-mounted panel reads the localStorage prefs; a mounted one hears the event. */
export function openWorkersTab() {
  try { localStorage.setItem("vs.context-panel.tab", "Workers"); localStorage.setItem("vs.context-panel.open", "1"); } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("vs:open-context-tab", { detail: { tab: "Workers" } }));
}

const workerNeedsYou = (m: { attention?: { tone?: string } | null } | null | undefined) => Boolean(m?.attention && m.attention.tone !== "finished");

type MemberLike = { agent: { status?: string }; attention?: { tone?: string } | null } | null | undefined;
const memberErr = (m: MemberLike) => Boolean(m) && boringStateGlyph(m!.agent.status, m!.attention?.tone) === "err";
/** Sidebar worker row classes: selected, plus a red tint when it errored or amber when it needs you. */
const workerRowCls = (on: boolean, w: MemberLike) => ["boring-worker-row", on && "on", memberErr(w) ? "needs-err" : workerNeedsYou(w) && "needs-attn"].filter(Boolean).join(" ");
const pinErr = (p: Pick<Pin, "brainstorm" | "lead" | "workers"> | null | undefined) => Boolean(p) && [p!.brainstorm, p!.lead, ...(p!.workers ?? [])].some(memberErr);

export function boringSidebarModel(view: TeamView | undefined, now = Date.now()) {
  const zones = skyZonesFor(view);
  const bugs = quickBugsChipState(view);
  // R3.2: every badge = its pin's needsYou + stalled agents at `now`, so the sum equals needsYouCount (the Needs-you heading).
  // L2: pins.ts counts needsYou over ALL of the lane's members, so stalled members come from the same list (duplicate leads, duplicate Buddies,
  // hidden lanes); the pin's own slots are only the fallback for a pin whose lane isn't in view.lanes. Same members => badge sum == list count.
  const pinMembers = (p: Pin | null | undefined): Member[] =>
    p ? view?.lanes?.find((l) => l.lane.id === p.lane.id)?.members ?? [p.brainstorm, p.lead, ...(p.workers ?? []), ...(p.topicBrainstorms ?? [])].filter((m): m is Member => !!m) : [];
  const toolSecs = toolRunningSecondsAt(now);
  const pinNeeds = (p: Pin | null | undefined) => (p?.needsYou ?? 0) + stalledCount(pinMembers(p), now, toolSecs);
  const zoneRow = (label: string, z: typeof zones.overlord) => ({
    label,
    agentId: z.agentId,
    status: z.member?.agent.status ?? "none",
    needsYou: z.member ? (z.member.attention && z.member.attention.tone !== "finished" ? 1 : 0) + stalledCount([z.member], now, toolSecs) : 0,
    age: formatTimestamp(z.member?.agent.updatedAt, "relative", now),
    updatedAt: z.member?.agent.updatedAt ?? null,
  });
  // A feature lane whose id is the project id duplicates the hub: fold its members into the Desk instead of a second row.
  const deskPins = (view ? pinsForSquad(view).pinned : []).filter((p) => !isHubPin(p) && p.lane.id === view?.team.id);
  const deskWorkers: Pin["workers"] = [];
  for (const m of [...(zones.hub?.workers ?? []), ...deskPins.flatMap((p) => [p.lead, p.brainstorm, ...(p.workers ?? [])])]) {
    if (m && !deskWorkers.some((x) => x.agent.id === m.agent.id) && m.agent.id !== zones.overlord.member?.agent.id && m.agent.id !== zones.riffbot.member?.agent.id) deskWorkers.push(m);
  }
  const core = {
    deskWorkers,
    overlord: zoneRow("Lead · Overlord", zones.overlord),
    riffbot: zoneRow("Brainstorm · RiffBot", zones.riffbot),
    bugs: {
      label: "Bugs",
      pin: bugs.pin,
      err: pinErr(bugs.pin),
      agentId: bugs.pin ? liveBuddyId(bugs.pin) ?? (isLive(bugs.pin.lead) ? bugs.pin.lead.agent.id : null) : null,
      leadRunning: bugs.leadRunning,
      needsYou: bugs.needsYou + stalledCount(pinMembers(bugs.pin), now, toolSecs),
      age: bugs.pin ? boringConversationAge(bugs.pin, now) : "",
    },
  };
  // 2.1: the hub lane (RiffBot/Overlord plus anything else parked in it) and every lane worker count, so these totals match the project badge.
  const hubNeedsYou = pinNeeds(zones.hub) + deskPins.reduce((n, p) => n + pinNeeds(p), 0);
  const conversations = (view ? pinsForSquad(view).pinned : [])
    .filter((p) => !isHubPin(p) && p.lane.id !== view?.team.id && p.lane.id !== bugs.pin?.lane.id) // the Bugs lane has its own desk row: never count it twice
    .map((pin) => ({
      laneId: pin.lane.id,
      name: boringLaneLabel(pin.lane.name),
      code: pin.lane.code ? `@${pin.lane.code}` : `@${pin.lane.id.replace(/-.*/, "").slice(0, 4)}`,
      pin,
      brainstormId: pin.brainstorm?.agent.id ?? null,
      brainstormStatus: pin.brainstorm?.agent.status ?? "none",
      leadId: pin.lead?.agent.id ?? null,
      leadStatus: pin.lead?.agent.status ?? "none",
      needsYou: pinNeeds(pin),
      err: pinErr(pin),
      workerNeedsYou: (pin.workers ?? []).filter(workerNeedsYou).length,
      running: pin.running,
      age: boringConversationAge(pin, now),
    }));
  const laneTotal = conversations.reduce((n, c) => n + c.needsYou, 0);
  // The project badge is the sum of its rows' counts (no view.needsYou max: that never counts stalled items), so collapsed badges add up to the Needs-you count.
  const totalNeedsYou = hubNeedsYou + laneTotal + core.bugs.needsYou;
  // Worst state per container (R2.5): red if anything inside errored, else amber. Only collapsed containers show a badge.
  const deskErr = pinErr(zones.hub) || deskPins.some(pinErr) || memberErr(zones.overlord.member) || memberErr(zones.riffbot.member);
  const projectErr = deskErr || core.bugs.err || conversations.some((c) => c.err);
  return { core, conversations, hubNeedsYou, totalNeedsYou, deskErr, projectErr };
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
const zones0 = (model: ReturnType<typeof boringSidebarModel>, k: "overlord" | "riffbot") => (model.core[k].updatedAt ? ({ agent: { updatedAt: model.core[k].updatedAt } } as unknown as Pin["lead"]) : null);
const timeOf = (iso?: string | null) => { const t = Date.parse(iso ?? ""); return Number.isNaN(t) ? 0 : t; };
/** S9: one dense row per lane, urgency-sorted (needs you › running › most recent). The Project desk rows follow the lanes. */
export function boringLaneTableRows(
  model: ReturnType<typeof boringSidebarModel>,
  feed: { lane: string; text: string; ts: string; type?: string }[] = [],
): LaneTableRow[] {
  const lastFor = (c: { laneId: string; code: string }) => {
    const ids = new Set([c.laneId.toLowerCase(), c.code.replace(/^@/, "").toLowerCase()]);
    // R4: internal telemetry (log type "metric": hook-timing, mcp-alias, brief-orphan-conflict) is not what the lane did.
    const hit = feed.filter((e) => e.type !== "metric" && ids.has(String(e.lane ?? "").replace(/^@/, "").toLowerCase())).sort((a, b) => b.ts.localeCompare(a.ts))[0];
    return hit ? hit.text : "";
  };
  const workerSummary = (ws: { agent: { status?: string }; attention?: { tone?: string } | null }[]) => {
    const live = ws.filter(boringWorkerIsLive).length;
    return ws.length === 0 ? "—" : `${live} live${ws.length > live ? ` · ${ws.length - live} idle` : ""}`;
  };
  const lanes: LaneTableRow[] = model.conversations.map((c) => {
    return {
      key: c.laneId, kind: "lane", laneId: c.laneId, label: c.name, code: c.code,
      brainstorm: c.brainstormStatus, lead: c.leadStatus,
      workers: workerSummary(c.pin.workers ?? []),
      needsYou: c.needsYou, running: c.running, lastEvent: lastFor(c), age: c.age,
      sortAge: Math.max(timeOf(c.pin.brainstorm?.agent.updatedAt), timeOf(c.pin.lead?.agent.updatedAt), ...(c.pin.workers ?? []).map((w) => timeOf(w.agent.updatedAt))),
    };
  });
  lanes.sort((a, b) => b.needsYou - a.needsYou || b.running - a.running || b.sortAge - a.sortAge);
  const { overlord, riffbot, bugs } = model.core;
  // R2.6: the hub is ONE Desk row (Lead = Overlord, Brainstorm = RiffBot), then Bugs.
  const deskRow: LaneTableRow = {
    key: "_desk", kind: "desk", laneId: "_desk", label: "Desk", code: "", brainstorm: riffbot.status, lead: overlord.status,
    workers: workerSummary(model.core.deskWorkers), needsYou: model.hubNeedsYou, running: [overlord.status, riffbot.status].filter((x) => x === "running").length + model.core.deskWorkers.filter((w) => w.agent.status === "running").length,
    lastEvent: "", age: boringConversationAge({ brainstorm: zones0(model, "riffbot"), lead: zones0(model, "overlord"), workers: model.core.deskWorkers }) || overlord.age || riffbot.age, sortAge: 0,
  };
  const bugsRow: LaneTableRow = {
    key: "_bugs", kind: "desk", laneId: "_bugs", label: bugs.label, code: "", brainstorm: "—", lead: bugs.leadRunning ? "running" : "none",
    workers: workerSummary(bugs.pin?.workers ?? []), needsYou: bugs.needsYou, running: bugs.leadRunning ? 1 : 0, lastEvent: "", age: bugs.age, sortAge: 0,
  };
  return [deskRow, bugsRow, ...lanes];
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
  const [mode, setMode] = useState<Mode>("project");
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>("brainstorm");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const [laneOpen, setLaneOpen] = useState<Record<string, boolean>>({});
  const [deskOpen, setDeskOpen] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<OverviewTab>("overview");
  const [startState, setStartState] = useState<{ laneKey: string; busy: boolean; error: string | null } | null>(null);
  const inboxCount = useInboxCards().length;
  const [feedCount, setFeedCount] = useState<number>(() => (globalThis as { __feedCount?: number }).__feedCount ?? 0);
  const [feedRows, setFeedRows] = useState<{ lane: string; text: string; ts: string; type?: string }[]>([]);
  useEffect(() => {
    if (mode !== "chat" && mode !== "project") return;
    void refreshInboxCards?.();
    const teamId = view?.team.id;
    if (!teamId || typeof fetch !== "function") return;
    let live = true;
    fetch(`/__vibesquad/log?team=${encodeURIComponent(teamId)}`)
      .then((r) => r.json())
      .then((rows: unknown) => { if (live && Array.isArray(rows)) { setFeedCount(rows.length); setFeedRows(rows as typeof feedRows); } })
      .catch(() => {});
    return () => { live = false; };
  }, [mode, view?.team.id]);
  const { agents } = usePaseo();
  const panes = usePanes();
  const activeAgentId = panes.activePane === "left" ? panes.leftActiveId : panes.rightActiveId;
  const allViews = views.length > 0 ? views : view ? [view] : [];
  // S8: the active agent owns the sidebar selection + breadcrumb. Keyed on the agent only, so switching project never snaps back.
  useEffect(() => {
    const land = boringAgentLanding(allViews, activeAgentId, (id) => agents.has(id));
    if (!land || !activeAgentId) return;
    if (land.sel && land.view) {
      if (land.view.team.id !== view?.team.id) onSelectSquad(land.view.team.id);
      setSelectedLaneId(land.sel.laneId);
      if (land.sel.role === "worker") setSelectedWorkerId(activeAgentId);
      else { setSelectedRole(land.sel.role); setSelectedWorkerId(null); }
      revealAgent(land.view, land.sel, activeAgentId);
    }
    setMode(land.mode);
  }, [activeAgentId]);
  const activeTeamId = view?.team.id ?? "";
  // ONE `now` for the sidebar badges and the Needs-you list (R3 L1): both must cross the 600s stall boundary together.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const model = boringSidebarModel(view, now);
  const laneRows = boringLaneTableRows(model, feedRows);
  const hasEvents = laneRows.some((r) => r.lastEvent);
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
  /** Open every parent of a jumped-to agent (project, Desk / lane): an explicit collapse never hides the selected row. */
  const revealAgent = (v: TeamView, s: { laneId: string; role: Role | "worker" } | null, id: string) => {
    if (!s) return;
    const tid = v.team.id;
    setProjectOpen((o) => ({ ...o, [tid]: true }));
    if (s.laneId === "_overlord" || s.laneId === "_riffbot" || s.laneId === "_desk") {
      setDeskOpen((o) => ({ ...o, [tid]: true }));
      return;
    }
    const key = `${tid}/${s.laneId}`;
    setLaneOpen((o) => ({ ...o, [key]: true }));
  };
  const openAgentIn = (v: TeamView, agentId: string) => {
    if (v.team.id !== view?.team.id) onSelectSquad(v.team.id);
    const sel = boringSelectionForAgent(v, agentId);
    setSelectedLaneId(sel?.laneId ?? null);
    if (sel && sel.role !== "worker") setSelectedRole(sel.role);
    setSelectedWorkerId(sel?.role === "worker" ? agentId : null);
    revealAgent(v, sel, agentId);
    setMode("chat");
    openAgent(agentId);
  };
  const openNeedsYou = (row: NeedsYouRow) => openAgentIn(row.view, row.item.id);
  // R4-6: Ctrl+J opens the top Needs-you agent through this same path (so ?agent= and reload keep your place).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ agentId?: string }>).detail?.agentId;
      const v = id ? allViews.find((x) => boringSelectionForAgent(x, id)) : undefined;
      if (!id || !v) return;
      e.preventDefault();
      openAgentIn(v, id);
    };
    window.addEventListener(BORING_OPEN_AGENT_EVENT, onOpen);
    return () => window.removeEventListener(BORING_OPEN_AGENT_EVENT, onOpen);
  });
  const pickCore = (laneId: "_overlord" | "_riffbot", agentId: string | null, teamId?: string) => {
    if (teamId && teamId !== view?.team.id) onSelectSquad(teamId);
    setSelectedLaneId(laneId);
    setSelectedWorkerId(null);
    setMode("chat");
    if (agentId) openAgent(agentId);
  };
  const pickBugs = (b: { pin: Pin | null; agentId: string | null } = core.bugs) => {
    setSelectedLaneId("_bugs");
    setSelectedRole("brainstorm");
    setSelectedWorkerId(null);
    setMode("chat");
    // Selecting only shows the lane (live Buddy) or its empty card; spawning is the card's "Start Brainstorm" (never focusPin).
    if (b.pin && b.agentId) openAgent(b.agentId);
  };

  // Resolve the chat target.
  let agentId: string | null = null;
  let emptyKind: "overlord" | "riffbot" | "brainstorm" | "lead" = "riffbot";
  if (selectedLaneId === "_overlord") {
    agentId = zones.overlord.member?.agent.id ?? null;
    emptyKind = "overlord";
  } else if (selectedLaneId === "_riffbot") {
    agentId = zones.riffbot.member?.agent.id ?? null;
  } else if (selectedLaneId === "_desk") {
    agentId = selectedWorkerId && agents.get(selectedWorkerId) ? selectedWorkerId : null; // a hub worker opened from the Desk
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
  // Header tabs stay short so Check in never leaves the screen: the selected worker plus the first live ones, the rest summarised.
  const tabWorkers = [...liveWorkers.filter((w) => w.agent.id === selectedWorkerId), ...liveWorkers.filter((w) => w.agent.id !== selectedWorkerId)].slice(0, 3);
  const moreWorkers = liveWorkers.length - tabWorkers.length;

  const sel = boringActiveSelection({ mode, views: allViews, teamId: activeTeamId, agentId: agent?.id ?? null, agentTitle: agent?.title, laneId: selectedLaneId, role: selectedRole, workerId: selectedWorkerId });
  const selView = allViews.find((v) => v.team.id === sel.teamId) ?? view;
  const selModel = selView === view ? model : boringSidebarModel(selView, now);
  const laneLabel =
    sel.laneId === "_overlord" || sel.laneId === "_riffbot" || sel.laneId === "_desk" ? "Desk" : sel.laneId === "_bugs" ? "Bugs" : selModel.conversations.find((c) => c.laneId === sel.laneId)?.name ?? null;
  const crumbs = boringBreadcrumb({ project: selView?.team.name ?? "", mode, laneLabel: sel.laneId ? laneLabel : null, agentLabel: sel.agentLabel });
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

  // R2.5: a container shows its count only while collapsed, tinted by its worst state inside (red error, else amber).
  const badge = (n: number, err = false) => (n > 0 ? <span className={`badge boring-badge${err ? " err" : ""}`}>{n}</span> : null);
  const memberAgent = (id: string | null) => (id ? agents.get(id) : undefined);
  const projectIsOpen = (id: string) => projectOpen[id] ?? (id === activeTeamId || id === sel.teamId);
  const toggleProject = (id: string) => setProjectOpen((o) => ({ ...o, [id]: !projectIsOpen(id) }));
  /** Clicking a project's name opens its Overview (switching Squad if needed); only the chevron expands/collapses. */
  const openProject = (id: string) => {
    if (id !== activeTeamId) onSelectSquad(id);
    // Multiple projects can stay expanded: keep the one we leave open.
    setProjectOpen((o) => ({ ...o, [activeTeamId]: o[activeTeamId] ?? true, [id]: true }));
    setMode("project");
  };
  const isOn = (v: TeamView, key: string) => sel.rowKey === `${v.team.id}|${key}`;
  /** Fixed 16px chevron column on every row, so the state dots line up at each indent level (R2.5). */
  const chevronCol = (open: boolean, onToggle: (() => void) | null, label: string, testid?: string) =>
    onToggle ? (
      <button type="button" className="boring-chevron-btn" data-testid={testid} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${label}`} onClick={onToggle}>{open ? "▾" : "▸"}</button>
    ) : (
      <span className="boring-chevron-btn boring-chevron-spacer" data-testid={testid} aria-hidden="true" />
    );
  const suffix = (v: TeamView, base: string) => (v.team.id === activeTeamId ? base : `${base}-${v.team.id}`);
  const workerRow = (v: TeamView, pin: Pin, laneId: string, w: Pin["workers"][number]) => (
    <button key={w.agent.id} type="button" className={workerRowCls(isOn(v, "worker:" + w.agent.id), w)} data-testid={`boring-worker-${w.agent.id}`} onClick={() => openTarget(v, pin, laneId, { role: "worker", agentId: w.agent.id })}>
      <span className={`boring-dot ${w.agent.status} ${glyphCls(w.agent.status, w.attention?.tone)}`} />
      <span className="boring-row-label">{w.agent.title ?? w.agent.id.slice(0, 8)}</span>
      <span className="boring-conv-age">{formatTimestamp(w.agent.updatedAt, "relative")}</span>
    </button>
  );
  /** R3.1: under Desk / a lane the tree shows only the on-screen worker and workers that need you (one line, no reason); the rest folds into "▸ N running · M idle", which opens the right panel's Workers tab. */
  const workerList = (v: TeamView, pin: Pin, laneId: string, workers: Pin["workers"], listId: string, foldId: string, onScreen: boolean, open: () => void) => {
    const shown = workers.filter((w) => isOn(v, "worker:" + w.agent.id) || workerNeedsYou(w) || memberErr(w));
    const rest = workers.filter((w) => !shown.includes(w));
    const fold = boringWorkerFold(rest);
    return (
      <div className="boring-worker-list" data-testid={listId}>
        {shown.map((w) => workerRow(v, pin, laneId, w))}
        {fold && (
          <button type="button" className="boring-idle-toggle boring-worker-idle boring-worker-fold" data-testid={foldId} title="Open the Workers tab" onClick={() => { if (!onScreen) open(); openWorkersTab(); }}>
            <span className="boring-idle-chev" aria-hidden="true">▸</span>{fold}
          </button>
        )}
      </div>
    );
  };
  /** One lane shape for Bugs and every feature lane: chevron column, dot, name, collapsed badge; workers under the chevron. */
  const laneRow = (v: TeamView, c: { laneId: string; name: string; code: string; pin: Pin | null; status: string; needsYou: number; err: boolean; age: string; titleTestId?: string; onOpen: () => void }) => {
    const key = `${v.team.id}/${c.laneId}`;
    const isSel = sel.teamId === v.team.id && sel.laneId === c.laneId;
    const open = laneOpen[key] ?? isSel;
    const workers = c.pin?.workers ?? [];
    return (
      <div key={c.laneId} className={`boring-conv-row ${isOn(v, `lane:${c.laneId}`) ? "on" : ""}`} data-testid={`boring-conv-${c.laneId}`}>
        <div className="boring-conv-line">
          <button type="button" className="boring-chevron-btn" data-testid={`boring-conv-toggle-${c.laneId}`} aria-expanded={open} aria-label={open ? "Collapse workers" : "Expand workers"} disabled={workers.length === 0} onClick={() => setLaneOpen((o) => ({ ...o, [key]: !open }))}>
            {workers.length === 0 ? "" : open ? "▾" : "▸"}
          </button>
          <button type="button" className="boring-conv-title" data-testid={c.titleTestId} onClick={c.onOpen}>
            <span className={`boring-dot ${c.status} ${glyphCls(c.status, c.err ? "error" : c.needsYou > 0 ? "needs-you" : null)}`} />
            <span className="boring-row-label">{c.name}</span>
            {c.code && <code className="boring-conv-code">{c.code}</code>}
            <span className="boring-conv-age">{c.age}</span>
            {!open && badge(c.needsYou, c.err)}
          </button>
        </div>
        {open && c.pin && workers.length > 0 && workerList(v, c.pin, c.laneId, workers, `boring-workers-${c.laneId}`, `boring-workers-fold-${c.laneId}`, isSel, c.onOpen)}
      </div>
    );
  };
  const coreRow = (v: TeamView, testid: string, key: string, label: string, status: string, needsYou: number, age: string, onClick: () => void, agentObj?: typeof agent) => (
    <div key={testid} className="boring-conv-line">
      {chevronCol(false, null, label)}
      <button type="button" className={`boring-core-row ${isOn(v, key) ? "on" : ""}`} data-testid={suffix(v, testid)} onClick={onClick}>
        {agentObj ? <StatusDot agent={agentObj} /> : <span className={`boring-dot ${status} ${glyphCls(status, needsYou > 0 ? "needs-you" : null)}`} />}
        <span className="boring-row-label">{label}</span>
        <span className="boring-conv-age">{age}</span>
        {badge(needsYou, memberErr(agentObj ? { agent: agentObj } : null))}
      </button>
    </div>
  );
  const deskBlock = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
    const hubPinV = skyZonesFor(v).hub;
    const key = v.team.id;
    const inDesk = sel.teamId === v.team.id && (sel.laneId === "_overlord" || sel.laneId === "_riffbot" || sel.laneId === "_desk");
    const open = deskOpen[key] ?? inDesk;
    const hw = m.core.deskWorkers;
    const deskRunning = m.core.overlord.status === "running" || m.core.riffbot.status === "running" ? "running" : "idle";
    const liveNames = [m.core.overlord.agentId && m.core.overlord.status !== "none" ? "Overlord" : null, m.core.riffbot.agentId && m.core.riffbot.status !== "none" ? "RiffBot" : null].filter(Boolean).join(" · ");
    const deskGlyph = m.deskErr ? "error" : m.hubNeedsYou > 0 ? "needs-you" : null;
    return (
      <div key="desk" className="boring-desk-block" data-testid={suffix(v, "boring-desk")}>
        <div className="boring-conv-line">
          {chevronCol(open, () => setDeskOpen((o) => ({ ...o, [key]: !open })), "Desk", suffix(v, "boring-desk-toggle"))}
          <button type="button" className="boring-core-row boring-desk-row" aria-expanded={open} data-testid={suffix(v, "boring-desk-row")} onClick={() => setDeskOpen((o) => ({ ...o, [key]: !open }))}>
            <span className={`boring-dot ${deskRunning} ${glyphCls(deskRunning, deskGlyph)}`} />
            <span className="boring-row-label">Desk</span>
            {liveNames && <span className="boring-desk-sub">{liveNames}</span>}
            {!open && badge(m.hubNeedsYou, m.deskErr)}
          </button>
        </div>
        {open && (
          <div className="boring-desk-children">
            {coreRow(v, "boring-core-overlord", "desk:lead", m.core.overlord.label, m.core.overlord.status, m.core.overlord.needsYou, m.core.overlord.age, () => pickCore("_overlord", m.core.overlord.agentId, v.team.id), memberAgent(m.core.overlord.agentId))}
            {coreRow(v, "boring-core-riffbot", "desk:brainstorm", m.core.riffbot.label, m.core.riffbot.status, m.core.riffbot.needsYou, m.core.riffbot.age, () => pickCore("_riffbot", m.core.riffbot.agentId, v.team.id), memberAgent(m.core.riffbot.agentId))}
            {hw.length > 0 && hubPinV && workerList(v, hubPinV, "_desk", hw, suffix(v, "boring-desk-workers"), suffix(v, "boring-desk-workers-fold"), inDesk, () => pickCore("_overlord", m.core.overlord.agentId, v.team.id))}
          </div>
        )}
      </div>
    );
  };
  const bugsRow = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
    const b = m.core.bugs;
    const openBugs = () => { if (v.team.id !== activeTeamId) onSelectSquad(v.team.id); pickBugs(b); };
    return laneRow(v, { laneId: "_bugs", name: b.label, code: "", pin: b.pin, status: b.pin?.running ? "running" : b.pin?.brainstorm?.agent.status ?? "none", needsYou: b.needsYou, err: b.err, age: b.age, titleTestId: suffix(v, "boring-core-bugs"), onOpen: openBugs });
  };

  return (
    <div className="boring-app" data-testid="boring-app">
      <aside className="boring-sidebar" data-testid="boring-sidebar">
        <div className="boring-sidebar-head" data-testid="boring-sidebar-head">
          <span className="boring-sidebar-title" data-testid="boring-sidebar-title">{APP_NAME}</span>
          <button type="button" className="boring-search-trigger" data-testid="boring-sidebar-search-btn" title="Command palette (Ctrl+K)" aria-label="Search: open command palette (Ctrl+K)" onClick={() => openOverlay("palette")}>
            <span aria-hidden="true">⌕</span><span>Search</span><kbd className="boring-kbd">Ctrl+K</kbd>
          </button>
        </div>
        <BoringInbox views={views.length > 0 ? views : view ? [view] : []} onOpen={openNeedsYou} now={now} />
        <div className="boring-section-head" data-testid="boring-projects-head">
          <span className="boring-section-label">Projects</span>
          <button type="button" className="boring-icon-btn" data-testid="boring-new-project-btn" title="New project" aria-label="New project" onClick={onNewSquad}>+</button>
        </div>
        <div className="boring-project-tree" data-testid="boring-project-tree">
          {allViews.map((v) => {
            const active = v.team.id === activeTeamId;
            const open = projectIsOpen(v.team.id);
            const m = active ? model : boringSidebarModel(v, now);
            const projectRowCls = isOn(v, "project") ? "boring-project-row on" : "boring-project-row";
            return (
              <div key={v.team.id} className="boring-project-block">
                <div className="boring-conv-line boring-project-line">
                  {chevronCol(open, () => toggleProject(v.team.id), v.team.name, `boring-project-toggle-${v.team.id}`)}
                  <button type="button" className={projectRowCls} data-testid={`boring-project-header-${v.team.id}`} aria-expanded={open} onClick={() => openProject(v.team.id)}>
                    <span className={`boring-dot ${(v.running ?? 0) > 0 ? "running" : "idle"} ${glyphCls((v.running ?? 0) > 0 ? "running" : "idle", m.projectErr ? "error" : m.totalNeedsYou > 0 ? "needs-you" : null)}`} />
                    <span className="boring-project-name">{v.team.name}</span>
                    {!open && badge(m.totalNeedsYou, m.projectErr)}
                  </button>
                  {active && (
                    <button type="button" className="boring-lane-add" data-testid="boring-new-conv-btn" title="New lane" aria-label="New lane" onClick={onAddBuddy}>+ lane</button>
                  )}
                </div>
                {open && (
                  <div className="boring-project-lanes" data-testid={`boring-project-lanes-${v.team.id}`}>
                    {deskBlock(v, m)}
                    {bugsRow(v, m)}
                    {m.conversations.map((c) => laneRow(v, { laneId: c.laneId, name: c.name, code: c.code, pin: c.pin, status: c.running > 0 ? "running" : c.brainstormStatus, needsYou: c.needsYou, err: c.err, age: c.age, onOpen: () => openLane(v, c) }))}
                    {active && m.conversations.length === 0 && <p className="boring-muted">No lanes yet.</p>}
                  </div>
                )}
              </div>
            );
          })}
          {views.length === 0 && !view && <span className="boring-project-name">No project</span>}
        </div>
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
                <span className={`boring-dot ${currentPin?.brainstorm?.agent.status ?? "none"} ${glyphCls(currentPin?.brainstorm?.agent.status, currentPin?.brainstorm?.attention?.tone)}`} />
                <span className="boring-tab-label">Brainstorm</span>
              </button>
              <button type="button" className={`boring-switch-pill ${!onWorker && topRole === "lead" ? "on" : ""}`} data-testid="boring-top-lead" onClick={() => currentPin && selectedLaneId && pickRole(currentPin, selectedLaneId, "lead")}>
                <span className={`boring-dot ${leadStatus} ${glyphCls(leadStatus, currentPin?.lead?.attention?.tone)}`} />
                <span className="boring-tab-label">Lead · {leadStatus}</span>
              </button>
              {tabWorkers.map((w) => (
                <button key={w.agent.id} type="button" className={`boring-switch-pill boring-worker-tab ${selectedWorkerId === w.agent.id ? "on" : ""}`} data-testid={`boring-top-worker-${w.agent.id}`} title={w.agent.title ?? w.agent.id} onClick={() => currentPin && selectedLaneId && openTarget(view!, currentPin, selectedLaneId, { role: "worker", agentId: w.agent.id })}>
                  <span className={`boring-dot ${w.agent.status} ${glyphCls(w.agent.status, w.attention?.tone)}`} />
                  <span className="boring-tab-label">{w.agent.title ?? w.agent.id.slice(0, 8)}</span>
                </button>
              ))}
              {moreWorkers > 0 && <span className="boring-tab-more" data-testid="boring-top-workers-more" title="More live workers are listed under this lane in the sidebar">+{moreWorkers} live</span>}
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
            <button type="button" className="boring-lane-add boring-overview-add" data-testid="boring-overview-new-lane-btn" onClick={onAddBuddy}>+ New lane</button>
            </div>
            {overviewTab === "overview" && (
              <table className="boring-lane-table" data-testid="boring-lane-table">
                <thead><tr><th>Lane</th><th>Brainstorm</th><th>Lead</th><th>Workers</th>{hasEvents && <th>Last event</th>}<th>Age</th></tr></thead>
                <tbody>
                  {laneRows.map((r) => {
                    const c = r.kind === "lane" ? conversations.find((x) => x.laneId === r.laneId) : undefined;
                    const go = (role: Role | "worker") => {
                      if (r.laneId === "_desk") {
                        const hw = core.deskWorkers.find(boringWorkerIsLive) ?? core.deskWorkers[0];
                        if (role === "worker" && hw && hubPin) return openTarget(view!, hubPin, "_desk", { role: "worker", agentId: hw.agent.id });
                        if (role === "brainstorm") return core.riffbot.agentId ? pickCore("_riffbot", core.riffbot.agentId) : hubPin && onSpinUpPin(hubPin);
                        return core.overlord.agentId ? pickCore("_overlord", core.overlord.agentId) : view && onSpinUpOverlord(view);
                      }
                      if (r.laneId === "_bugs") return pickBugs();
                      if (c && view) return role === "worker" ? openLane(view, c) : openTarget(view, c.pin, c.laneId, { role, agentId: null });
                    };
                    const stat = (s: string) => (s === "—" || s === "none" ? <span className="boring-muted">—</span> : <>{<span className={`boring-dot ${s} ${glyphCls(s)}`} />}{s}</>);
                    return (
                      <tr key={r.key} className={`boring-lane-row${r.needsYou > 0 ? " attn" : ""}${r.kind === "desk" ? " desk" : ""}`} data-testid={`boring-lane-row-${r.laneId}`}>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("brainstorm")}>
                          <span className={`boring-dot ${r.running > 0 ? "running" : r.brainstorm} ${glyphCls(r.running > 0 ? "running" : r.brainstorm, r.needsYou > 0 ? "needs-you" : null)}`} />
                          <span className="boring-row-label boring-lane-name">{r.label}</span>{r.code && <code className="boring-lane-code">{r.code}</code>}
                          {r.needsYou > 0 && <span className="badge boring-badge">Needs you · {r.needsYou}</span>}
                        </button></td>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("brainstorm")}>{stat(r.brainstorm)}</button></td>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("lead")}>{stat(r.lead)}</button></td>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("worker")}>{r.workers}</button></td>
                        {hasEvents && <td className="boring-lane-event">{r.lastEvent || "—"}</td>}
                        <td className="boring-conv-age">{r.age}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
