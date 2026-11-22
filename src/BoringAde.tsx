import { useEffect, useState, type ReactNode } from "react";
import { useNowTick } from "./useNowTick";
import { AgentDrawer } from "./AgentDrawer";
import { BoringContextPanel } from "./BoringContextPanel";
import { TimelineErrorBoundary } from "./Timeline";
import { glyphStatusOf, isInNeedsYou, stalledCount } from "./attentionItems";
import { BoringInbox, type NeedsYouRow } from "./BoringInbox";
import { laneCtxItems, openContextMenu, type CtxItem, openOverlay, teamCtxItems } from "./CommandPalette";
import { RemoveTeamDialog } from "./PinRemove";
import { demoLog } from "./demo";
import { DEMO } from "./demoFlag";
import { IdeaInbox, refreshInboxCards, useInboxCards } from "./IdeaInbox";
import { closeTab, collapseSplit, getPanes, openAgent, openAgentInTab, setActivePane, toggleSplit, usePanes } from "./panes";
import { sendMessage, usePaseo } from "./paseo";
import { createQuickBugsPin } from "./pinActions";
import { setBoringShownAgent, spinUpPin } from "./pinFocus";
import { boringDeepLinkPending, boringUrlAgent } from "./pinFocusLogic";
import { boringLaneLabel, laneCode, laneDisplayName, laneTopicLabel } from "./boringLocation";
import { isHubPin, isLive, liveBuddyId, perfectionPin, pinsForSquad, quickBugsChipState, type Pin } from "./pins";
import { formatTimestamp, setPref } from "./prefs";
import { runCheckin } from "./railCheckin";
import { skyZonesFor } from "./skyZonesLogic";
import type { FolderDef, Member, TeamView } from "./teams";
import { filterAwakeViews, folderSlug, isViewAsleep, partitionViews, patchTeamsFolder, type FolderOp } from "./boringFolders";
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
export function boringSelectionForAgent(view: TeamView | undefined, agentId: string | null | undefined): { laneId: string; role: Role | "worker"; label?: string } | null {
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
    if (r) return pin.lane.id === view.team.id ? { laneId: "_desk", role: "worker", ...(r === "brainstorm" ? { label: "Brainstorm" } : r === "lead" ? { label: "Lead" } : {}) } : { laneId: pin.lane.id, role: r };
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
  // idea-494: an idle (not closed) Lead is the lane's Lead; prefer it over an absent / closed Brainstorm instead of the empty Start card.
  if (!isLive(pin.brainstorm) && isLive(pin.lead)) return { role: "lead", agentId: pin.lead.agent.id };
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
export function boringActiveSelection(o: { mode: Mode; views: TeamView[]; teamId: string | null; agentId: string | null; laneId: string | null; role: Role; workerId: string | null }): ActiveSelection {
  const base = { teamId: o.teamId, mode: o.mode, laneId: null, role: null, workerId: null, agentLabel: null, rowKey: null } as ActiveSelection;
  if (o.mode === "usage") return base;
  if (o.mode === "project") return { ...base, rowKey: o.teamId ? `${o.teamId}|project` : null };
  let teamId = o.teamId;
  let laneId = o.laneId;
  let roleLabel: string | undefined;
  let role: Role | "worker" | null = o.workerId && o.agentId === o.workerId ? "worker" : laneId ? o.role : null;
  if (o.agentId) {
    const ordered = [...o.views.filter((v) => v.team.id === o.teamId), ...o.views.filter((v) => v.team.id !== o.teamId)];
    for (const v of ordered) {
      const sel = boringSelectionForAgent(v, o.agentId);
      if (sel) { teamId = v.team.id; laneId = sel.laneId; role = sel.role; roleLabel = sel.label; break; }
    }
  }
  const workerId = role === "worker" ? o.agentId : null;
  const agentLabel = !laneId ? null : role === "worker" ? roleLabel || "Worker" : laneId === "_overlord" ? "Overlord" : laneId === "_riffbot" ? "RiffBot" : role === "lead" ? "Lead" : "Brainstorm";
  // idea-494: a Lead on screen owns its own tree row (`lane:<id>:lead`); without an agent (empty card) the lane row stays selected, so exactly one row is on.
  const leadOnScreen = Boolean(o.agentId) && role === "lead" && laneId !== "_desk";
  const rowKey = !teamId || !laneId ? null : workerId ? `${teamId}|worker:${workerId}` : laneId === "_overlord" ? `${teamId}|desk:lead` : laneId === "_riffbot" ? `${teamId}|desk:brainstorm` : leadOnScreen ? `${teamId}|lane:${laneId}:lead` : `${teamId}|lane:${laneId}`;
  return { teamId, mode: "chat", laneId, role, workerId, agentLabel, rowKey };
}

/** R3.5: the sidebar header carries the fixed app name, never the current project (the breadcrumb owns that). */
export const APP_NAME = "VibeSquad";
/** R3.1: folded-away workers as "N running · M idle" (zero parts omitted); null when nothing is folded. */
export function boringWorkerFold(rest: { agent: { status?: string; archivedAt?: string | null; updatedAt?: string | null } }[], now = Date.now()): string | null {
  if (rest.length === 0) return null;
  const live = rest.filter((w) => boringWorkerIsLive(w as never));
  const quiet = live.filter((w) => glyphStatusOf(w.agent as never, now) === "quiet").length;
  const running = live.length - quiet;
  return [running > 0 && `${running} running`, quiet > 0 && `${quiet} quiet`, rest.length - live.length > 0 && `${rest.length - live.length} idle`].filter(Boolean).join(" · ");
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
  const pinNeeds = (p: Pin | null | undefined) => (p?.needsYou ?? 0) + stalledCount(pinMembers(p), now);
  const zoneRow = (label: string, z: typeof zones.overlord) => ({
    label,
    agentId: z.agentId,
    status: z.member?.agent.status ?? "none",
    err: memberErr(z.member),
    needsYou: z.member ? (z.member.attention && z.member.attention.tone !== "finished" ? 1 : 0) + stalledCount([z.member], now) : 0,
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
      needsYou: bugs.needsYou + stalledCount(pinMembers(bugs.pin), now),
      age: bugs.pin ? boringConversationAge(bugs.pin, now) : "",
    },
  };
  // 2.1: the hub lane (RiffBot/Overlord plus anything else parked in it) and every lane worker count, so these totals match the project badge.
  const hubNeedsYou = pinNeeds(zones.hub) + deskPins.reduce((n, p) => n + pinNeeds(p), 0);
  const conversations = (view ? pinsForSquad(view).pinned : [])
    .filter((p) => !isHubPin(p) && p.lane.id !== view?.team.id && p.lane.id !== bugs.pin?.lane.id) // the Bugs lane has its own desk row: never count it twice
    .map((pin) => ({
      laneId: pin.lane.id,
      name: laneDisplayName(view!.team, pin.lane.id, [pin.lane]),
      code: laneCode({ lanes: [...(view!.team.lanes ?? []), ...(pin.lane.dynamic ? [] : [pin.lane])] }, pin.lane.id),
      topicLabel: laneTopicLabel(laneDisplayName(view!.team, pin.lane.id, [pin.lane]), pin.lane.topic),
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
  // R8-6: Overlord and RiffBot render their own badges on always-visible rows, so the Desk header counts only the remaining Desk workers (header + rows == hubNeedsYou).
  const deskWorkersNeedsYou = Math.max(0, hubNeedsYou - core.overlord.needsYou - core.riffbot.needsYou);
  const deskWorkersErr = deskWorkers.some(memberErr);
  return { core, conversations, hubNeedsYou, totalNeedsYou, deskErr, projectErr, deskWorkersNeedsYou, deskWorkersErr };
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
export type BoringStateGlyph = "run" | "attn" | "err" | "stalled" | "quiet" | "idle" | "done";
export function boringStateGlyph(status: string | null | undefined, tone?: string | null): BoringStateGlyph {
  if (tone === "error" || status === "error") return "err";
  if (tone === "permission" || tone === "needs-you") return "attn";
  if (status === "stalled") return "stalled";
  if (status === "quiet") return "quiet";
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
  topicLabel?: string;
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
      key: c.laneId, kind: "lane", laneId: c.laneId, label: c.name, topicLabel: c.topicLabel, code: c.code,
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
  /** B11b: project folders from GET /api/teams. */
  folders?: FolderDef[];
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


export function BoringApp({ views, folders = [], view, onSelectSquad, onOpenPin, onSpinUpPin, onSpinUpOverlord, overlordBusy = false, onAddBuddy, onNewSquad, onSettings, onSuccessor, children, banners }: Props) {
  const [mode, setMode] = useState<Mode>("project");
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>("brainstorm");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const [laneOpen, setLaneOpen] = useState<Record<string, boolean>>({});
  const [removingPin, setRemovingPin] = useState<{ pin: Pin; name: string } | null>(null);
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
    // ?demo is a fixed cast: never read the real squad log (its verdict lines would show up as lane "Last event").
    if (DEMO) { const rows = demoLog(); setFeedCount(rows.length); setFeedRows(rows as typeof feedRows); return; }
    let live = true;
    fetch(`/__vibesquad/log?team=${encodeURIComponent(teamId)}`)
      .then((r) => r.json())
      .then((rows: unknown) => { if (live && Array.isArray(rows)) { setFeedCount(rows.length); setFeedRows(rows as typeof feedRows); } })
      .catch(() => {});
    return () => { live = false; };
  }, [mode, view?.team.id]);
  const { agents, rosterLoaded } = usePaseo();
  const panes = usePanes();
  const activeAgentId = panes.activePane === "left" ? panes.leftActiveId : panes.rightActiveId;
  /** Shift+click on any agent opener (sidebar, Needs you, Overview) opens it in the right pane; the click event is read, so no row markup changes. */
  const shiftHeld = () => {
    const e = typeof window === "undefined" ? undefined : (window.event as MouseEvent | undefined);
    return !!e && e.type === "click" && e.shiftKey;
  };
  // Normal mode shows no tab strip, so per-pane tab history is invisible: with split on, a plain click lands in the ACTIVE pane
  // (or just focuses the other pane when that agent is already its visible one), never in a pane that merely remembers the agent.
  const openHere = (id: string) => {
    if (shiftHeld()) return openAgentInTab(id, "right");
    // Live state, not the render closure: the workers fold calls collapseSplit() right before this, so `panes` is stale there.
    const live = getPanes();
    if (!live.split) return openAgent(id);
    const otherSide = live.activePane === "left" ? "right" : "left";
    const otherVisible = otherSide === "left" ? live.leftActiveId : live.rightActiveId;
    if (id === otherVisible) return setActivePane(otherSide);
    return openAgentInTab(id, live.activePane);
  };
  const allViews = views.length > 0 ? views : view ? [view] : [];
  // S8: the active agent owns the sidebar selection + breadcrumb. Keyed on the agent only, so switching project never snaps back.
  // R5-1: also when it becomes landable: a deep-linked agent can reach the roster after the first render.
  const activeLandable = !!boringAgentLanding(allViews, activeAgentId, (id) => agents.has(id));
  // The tab this effect last landed: until it runs for the current one the mode lags, so the URL keeps that tab (R5-4).
  const [landedFor, setLandedFor] = useState<string | null>(null);
  useEffect(() => {
    const land = boringAgentLanding(allViews, activeAgentId, (id) => agents.has(id));
    if (!land || !activeAgentId) return;
    setLandedFor(activeAgentId);
    if (land.sel && land.view) {
      if (land.view.team.id !== view?.team.id) onSelectSquad(land.view.team.id);
      setSelectedLaneId(land.sel.laneId);
      if (land.sel.role === "worker") setSelectedWorkerId(activeAgentId);
      else { setSelectedRole(land.sel.role); setSelectedWorkerId(null); }
      revealAgent(land.view, land.sel, activeAgentId);
    }
    setMode(land.mode);
  }, [activeAgentId, activeLandable]);
  const activeTeamId = view?.team.id ?? "";
  // ONE `now` for the sidebar badges and the Needs-you list (R3 L1): both must cross the 600s stall boundary together.
  const now = useNowTick();
  const model = boringSidebarModel(view, now);
  const laneRows = boringLaneTableRows(model, feedRows);
  const hasEvents = laneRows.some((r) => r.lastEvent);
  const { core, conversations, hubNeedsYou, totalNeedsYou } = model;
  const zones = skyZonesFor(view);
  const hubPin = zones.hub;

  const currentConv = conversations.find((c) => c.laneId === selectedLaneId) ?? null;
  const currentPin: Pin | null = selectedLaneId === "_bugs" ? core.bugs.pin : currentConv?.pin ?? null;
  const inLane = Boolean(currentPin);
  // idea-468: Desk selections (_overlord/_riffbot/_desk) have no lane pin of their own; their workers live on the hub pin.
  const panelPin: Pin | null = currentPin ?? (selectedLaneId === "_overlord" || selectedLaneId === "_riffbot" || selectedLaneId === "_desk" ? hubPin : null);
  const leadStatus = currentPin?.lead?.agent.status ?? "none";

  /** Open a lane member from any project: switches project first, then the lane, then the member. */
  const openTarget = (v: TeamView, pin: Pin, laneId: string, target: { role: Role | "worker"; agentId: string | null }) => {
    if (v.team.id !== view?.team.id) onSelectSquad(v.team.id);
    if (target.role === "worker" && target.agentId) {
      setSelectedLaneId(laneId);
      setSelectedWorkerId(target.agentId);
      setMode("chat");
      openHere(target.agentId);
      return;
    }
    pickRole(pin, laneId, target.role === "worker" ? "brainstorm" : target.role);
  };
  const openLane = (v: TeamView, c: { pin: Pin; laneId: string }) => openTarget(v, c.pin, c.laneId, boringLaneTarget(c.pin));
  const pickRoleIn = (v: TeamView, pin: Pin, laneId: string, role: Role) => {
    if (v.team.id !== view?.team.id) onSelectSquad(v.team.id);
    pickRole(pin, laneId, role);
  };
  const pickRole = (pin: Pin, laneId: string, role: Role) => {
    setSelectedLaneId(laneId);
    setSelectedRole(role);
    setSelectedWorkerId(null);
    setMode("chat");
    const m = role === "lead" ? pin.lead : pin.brainstorm;
    // Lead and Brainstorm both open through openHere: openPinMember would fold an open split (and Shift+click could never target the right pane).
    if (m) openHere(m.agent.id);
    else void onOpenPin(pin);
  };
  /** Open every parent of a jumped-to agent (project, lane): an explicit collapse never hides the selected row. */
  const revealAgent = (v: TeamView, s: { laneId: string; role: Role | "worker" } | null, id: string) => {
    if (!s) return;
    const tid = v.team.id;
    setProjectOpen((o) => ({ ...o, [tid]: true }));
    if (s.laneId === "_overlord" || s.laneId === "_riffbot" || s.laneId === "_desk") return; // Trinity card is always visible
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
    openHere(agentId);
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
    if (agentId) openHere(agentId);
  };
  const pickBugs = (b: { pin: Pin | null; agentId: string | null } = core.bugs) => {
    setSelectedLaneId("_bugs");
    setSelectedRole("brainstorm");
    setSelectedWorkerId(null);
    setMode("chat");
    // Selecting only shows the lane (live Buddy) or its empty card; spawning is the card's "Start Brainstorm" (never focusPin).
    if (b.pin && b.agentId) openHere(b.agentId);
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
  // R5-4: App's URL sync names the agent on screen: every way back to Overview or usage (project row, breadcrumb, drawer
  // close) drops ?agent=, and a lane's resolved Buddy/Lead or the hub fallback is named even when it is not the pane's tab.
  const urlAgent = boringUrlAgent({
    rosterLoaded: !!rosterLoaded,
    landingPending: activeLandable && landedFor !== activeAgentId,
    activeAgentId,
    shownAgentId: mode === "chat" && agent ? agent.id : null,
  });
  useEffect(() => setBoringShownAgent(urlAgent), [urlAgent]);
  useEffect(() => () => setBoringShownAgent(undefined), []);
  const topRole = currentPin ? selectedRole : boringActiveRole(currentPin ?? { brainstorm: null, lead: null }, agentId);
  const onWorker = Boolean(selectedWorkerId && agentId === selectedWorkerId);

  const selRaw = boringActiveSelection({ mode, views: allViews, teamId: activeTeamId, agentId: agent?.id ?? null, laneId: selectedLaneId, role: selectedRole, workerId: selectedWorkerId });
  // An empty active pane names nobody: no row is selected and the breadcrumb says so, instead of echoing the other pane's agent.
  const splitEmptyActive = mode === "chat" && panes.split && !activeAgentId;
  const sel = splitEmptyActive ? { ...selRaw, rowKey: null, laneId: null, role: null, workerId: null, agentLabel: null } : selRaw;
  // idea-500: keep the selected row visible; only when the selection changes (never on re-render), nearest so it never fights user scrolling.
  useEffect(() => {
    if (!sel.rowKey) return;
    if (typeof document === "undefined") return;
    document.querySelector<HTMLElement>(".boring-sidebar .boring-project-row.on, .boring-sidebar .boring-conv-row.on, .boring-sidebar .boring-worker-row.on, .boring-sidebar .boring-core-row.on")?.scrollIntoView?.({ block: "nearest" });
  }, [sel.rowKey]);
  const selView = allViews.find((v) => v.team.id === sel.teamId) ?? view;
  const selModel = selView === view ? model : boringSidebarModel(selView, now);
  const laneLabel =
    sel.laneId === "_overlord" || sel.laneId === "_riffbot" || sel.laneId === "_desk" ? "Desk" : sel.laneId === "_bugs" ? "Bugs" : selModel.conversations.find((c) => c.laneId === sel.laneId)?.name ?? null;
  // R7-1: a deep link waiting on the roster shows a bare breadcrumb + "Opening agent…", never the default project's Overview.
  const opening = boringDeepLinkPending({ rosterLoaded: !!rosterLoaded, activeAgentId });
  const crumbs = opening ? [{ key: "project" as const, label: "Opening…" }] : boringBreadcrumb({ project: selView?.team.name ?? "", mode, laneLabel: splitEmptyActive ? "Split · pick an agent" : sel.laneId ? laneLabel : null, agentLabel: sel.agentLabel });
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
  const emptySpec = () => {
    const startKey = startKeyFor(currentPin);
    const startFor = startKey && startState?.laneKey === startKey ? startState : null;
    const spec = {
      overlord: { text: "No Overlord is running for this project yet.", cta: "Start Overlord", run: () => view && onSpinUpOverlord(view), disabled: overlordBusy },
      riffbot: { text: "RiffBot is sleeping.", cta: "Start RiffBot", run: () => hubPin && onSpinUpPin(hubPin), disabled: !hubPin },
      brainstorm: { text: "No Brainstorm session is running for this conversation yet.", cta: startFor?.busy ? "Starting Brainstorm…" : "Start Brainstorm", run: () => (currentPin ? startBrainstorm(currentPin) : startBugs()), disabled: (!currentPin && !needsBugsLane) || Boolean(startFor?.busy) },
      lead: { text: "No Lead is running yet — ask Brainstorm to hand off a plan.", cta: "Switch to Brainstorm", run: () => setSelectedRole("brainstorm"), disabled: false },
    }[emptyKind];
    return spec;
  };
  /** idea-468 m1: what the agent-less panel's Changes/Files/Terminal tabs offer: open an existing (idle) Lead, else the empty card's own start action. */
  const noAgentAction = (): { need: string; label: string; disabled?: boolean; run: () => void } => {
    if (currentPin?.lead && selectedLaneId) return { need: "the Lead open", label: "Open the Lead", run: () => pickRole(currentPin, selectedLaneId, "lead") };
    const spec = emptySpec();
    const desk = emptyKind === "overlord" || emptyKind === "riffbot";
    return { need: desk ? "a running Overlord or RiffBot" : "a running Lead or Brainstorm", label: spec.cta, disabled: spec.disabled, run: () => void spec.run() };
  };
  const emptyCard = () => {
    const startKey = startKeyFor(currentPin);
    const startFor = startKey && startState?.laneKey === startKey ? startState : null;
    const spec = emptySpec();
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

  // idea-257: optional 2-pane split. The right pane is panes.rightActiveId; the left falls back to the resolved agent while the left pane is active and has no tab.
  const leftPaneAgent = (panes.leftActiveId ? agents.get(panes.leftActiveId) : undefined) ?? (panes.activePane === "left" ? agent : undefined);
  const rightPaneAgent = panes.rightActiveId ? agents.get(panes.rightActiveId) : undefined;
  const paneCls = (isLeft: boolean) => `boring-pane${panes.activePane === (isLeft ? "left" : "right") ? " boring-pane-active" : ""}`;
  const closePane = (side: "left" | "right") => {
    const id = side === "left" ? panes.leftActiveId : panes.rightActiveId;
    if (id) closeTab(id);
    else if (side === "right") toggleSplit();
    // The other pane keeps the chat; only when nothing else is open does Close go back to Overview.
    if (!(side === "left" ? rightPaneAgent : leftPaneAgent)) setMode("project");
  };
  const splitPanes = (
    <div className="boring-chat-split" data-testid="boring-chat-split">
      <div className={paneCls(true)} data-testid="boring-pane-left" onMouseDownCapture={() => setActivePane("left")} onFocusCapture={() => setActivePane("left")}>
        {leftPaneAgent ? <AgentDrawer key={leftPaneAgent.id} agent={leftPaneAgent} onClose={() => closePane("left")} onSuccessor={() => onSuccessor(leftPaneAgent.id)} active pinDecisions noContextPanel /> : emptyCard()}
      </div>
      <div className={paneCls(false)} data-testid="boring-pane-right" onMouseDownCapture={() => setActivePane("right")} onFocusCapture={() => setActivePane("right")}>
        {rightPaneAgent ? (
          <AgentDrawer key={rightPaneAgent.id} agent={rightPaneAgent} onClose={() => closePane("right")} onSuccessor={() => onSuccessor(rightPaneAgent.id)} active pinDecisions noContextPanel />
        ) : (
          <div className="boring-split-empty" data-testid="boring-split-empty">
            <p>Click an agent in the sidebar or Needs you to open it here.</p>
            <p className="boring-split-hint">Shift+click always opens on the right.</p>
            <button type="button" className="boring-switch-pill" data-testid="boring-split-close" onClick={() => toggleSplit()}>Close split</button>
          </div>
        )}
      </div>
    </div>
  );

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
      <span className={`boring-dot ${w.agent.status} ${glyphCls(glyphStatusOf(w.agent, now), w.attention?.tone)}`} />
      <span className="boring-row-label" title={w.agent.title ?? w.agent.id.slice(0, 8)}>{w.agent.title ?? w.agent.id.slice(0, 8)}</span>
      <span className="boring-conv-age">{formatTimestamp(w.agent.updatedAt, "relative")}</span>
    </button>
  );
  /** R3.1: under Desk / a lane the tree shows only the on-screen worker row (B7a); all other workers, alerting ones included, fold into "▸ N running · M idle", which opens the right panel's Workers tab. */
  const workerList = (v: TeamView, pin: Pin, laneId: string, workers: Pin["workers"], listId: string, foldId: string, onScreen: boolean, open: () => void) => {
    // A worker open in either split pane counts as on screen (R3.1), not only the selected one.
    const inPane = (id: string) => panes.split && (id === panes.leftActiveId || id === panes.rightActiveId);
    // R3.1: every worker Needs-you counts (permission, pick, error, stalled) gets its own row, so own rows == the lane badge.
    const shown = workers.filter((w) => isOn(v, "worker:" + w.agent.id) || inPane(w.agent.id) || isInNeedsYou(w, now));
    const rest = workers.filter((w) => !shown.includes(w));
    const fold = boringWorkerFold(rest, now);
    return (
      <div className="boring-worker-list" data-testid={listId}>
        {shown.map((w) => workerRow(v, pin, laneId, w))}
        {fold && (
          <button type="button" className="boring-idle-toggle boring-worker-idle boring-worker-fold" data-testid={foldId} title={panes.split ? "Leave split and open the Workers tab" : "Open the Workers tab"} onClick={() => {
            // Split panes mount no context panel: fold the split down to the ACTIVE pane's agent (activeAgentId is unchanged, so the
            // S8 landing effect does not overwrite the lane), then route exactly as in the non-split path.
            if (panes.split) collapseSplit("active");
            if (!onScreen) open();
            openWorkersTab();
          }}>
            <span className="boring-idle-chev" aria-hidden="true">▸</span>{fold}
          </button>
        )}
      </div>
    );
  };
  /** One lane shape for Bugs and every feature lane: chevron column, dot, name, collapsed badge; workers under the chevron. */
  const laneRow = (v: TeamView, c: { laneId: string; name: string; topicLabel?: string; code: string; pin: Pin | null; status: string; needsYou: number; err: boolean; age: string; titleTestId?: string; onOpen: () => void }) => {
    const key = `${v.team.id}/${c.laneId}`;
    const isSel = sel.teamId === v.team.id && sel.laneId === c.laneId;
    const open = laneOpen[key] ?? isSel;
    const workers = c.pin?.workers ?? [];
    const lead = c.pin && isLive(c.pin.lead) ? c.pin.lead : null; // idea-494: a live OR idle Lead gets its own row (never for the hub's Overlord)
    const leadKey = ["lane", c.laneId, "lead"].join(":");
    const expandable = workers.length > 0 || Boolean(lead);
    // idea-500: a collapsed lane hides its selected Lead/worker row, so the lane row carries the selected state (derived from sel, no second source).
    const laneCls = "boring-conv-row" + (isOn(v, `lane:${c.laneId}`) || (!open && sel.teamId === v.team.id && sel.laneId === c.laneId && sel.rowKey !== null) ? " on" : "");
    const lanePin = c.pin;
    const laneMenu = lanePin ? () => laneCtxItems(v, lanePin, { displayName: c.name, onRemove: !isHubPin(lanePin) && c.laneId !== "_bugs" ? () => setRemovingPin({ pin: lanePin, name: c.name }) : undefined }) : null;
    return (
      <div key={c.laneId} className={laneCls} data-testid={`boring-conv-${c.laneId}`}>
        <div className="boring-conv-line" onContextMenu={laneMenu ? (e) => openContextMenu(e, laneMenu()) : undefined}>
          <button type="button" className="boring-chevron-btn" data-testid={`boring-conv-toggle-${c.laneId}`} aria-expanded={open} aria-label={open ? "Collapse lane" : "Expand lane"} disabled={!expandable} onClick={() => setLaneOpen((o) => ({ ...o, [key]: !open }))}>
            {!expandable ? "" : open ? "▾" : "▸"}
          </button>
          <button type="button" className="boring-conv-title" data-testid={c.titleTestId} title={c.topicLabel || undefined} onClick={c.onOpen}>
            <span className={`boring-dot ${c.status} ${glyphCls(c.status, c.err ? "error" : c.needsYou > 0 ? "needs-you" : null)}`} />
            <span className="boring-row-label" title={c.name}>{c.name}</span>
            {c.code && <code className="boring-conv-code">{c.code}</code>}
            <span className="boring-conv-age">{c.age}</span>
            {!open && badge(c.needsYou, c.err)}
          </button>
          {laneMenu && (
            <button type="button" className="boring-row-menu-btn" data-testid={`boring-lane-menu-${c.laneId}`} aria-haspopup="menu" aria-label={`${c.name} lane actions`} title="Lane actions" onClick={(e) => openContextMenu(e, laneMenu())}>⋯</button>
          )}
        </div>
        {open && c.pin && lead && (
          <button type="button" className={workerRowCls(isOn(v, leadKey), lead)} data-testid={`boring-lead-${c.laneId}`} onClick={() => pickRoleIn(v, c.pin!, c.laneId, "lead")}>
            <span className={`boring-dot ${lead.agent.status} ${glyphCls(lead.agent.status, lead.attention?.tone)}`} />
            <span className="boring-row-label">Lead</span>
            <span className="boring-conv-age">{formatTimestamp(lead.agent.updatedAt, "relative")}</span>
          </button>
        )}
        {open && c.pin && workers.length > 0 && workerList(v, c.pin, c.laneId, workers, `boring-workers-${c.laneId}`, `boring-workers-fold-${c.laneId}`, isSel, c.onOpen)}
      </div>
    );
  };
  const coreRow = (v: TeamView, testid: string, key: string, label: string, status: string, needsYou: number, age: string, onClick: () => void, agentObj?: typeof agent, err = false) => (
    <div key={testid} className="boring-conv-line">
      {chevronCol(false, null, label)}
      <button type="button" className={`boring-core-row ${isOn(v, key) ? "on" : ""}`} data-testid={suffix(v, testid)} onClick={onClick}>
        {agentObj ? <StatusDot agent={agentObj} /> : <span className={`boring-dot ${status} ${glyphCls(status, needsYou > 0 ? "needs-you" : null)}`} />}
        <span className="boring-row-label" title={label}>{label}</span>
        <span className="boring-conv-age">{age}</span>
        {badge(needsYou, err)}
      </button>
    </div>
  );
  /** B8a: Overlord + RiffBot + Bugs sit in one always-visible Trinity card, separate from the feature lanes (no collapsed Desk). */
  const trinityCard = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
    const hubPinV = skyZonesFor(v).hub;
    const inDesk = sel.teamId === v.team.id && (sel.laneId === "_overlord" || sel.laneId === "_riffbot" || sel.laneId === "_desk");
    const hw = m.core.deskWorkers;
    return (
      <div key="trinity" className="boring-trinity-card" data-testid={suffix(v, "boring-trinity")}>
        <div className="boring-trinity-head" data-testid={suffix(v, "boring-trinity-head")}><span>Desk</span>{badge(m.deskWorkersNeedsYou, m.deskWorkersErr)}</div>
        {coreRow(v, "boring-core-overlord", "desk:lead", m.core.overlord.label, m.core.overlord.status, m.core.overlord.needsYou, m.core.overlord.age, () => pickCore("_overlord", m.core.overlord.agentId, v.team.id), memberAgent(m.core.overlord.agentId), m.core.overlord.err)}
        {hw.length > 0 && hubPinV && workerList(v, hubPinV, "_desk", hw, suffix(v, "boring-desk-workers"), suffix(v, "boring-desk-workers-fold"), inDesk, () => pickCore("_overlord", m.core.overlord.agentId, v.team.id))}
        {coreRow(v, "boring-core-riffbot", "desk:brainstorm", m.core.riffbot.label, m.core.riffbot.status, m.core.riffbot.needsYou, m.core.riffbot.age, () => pickCore("_riffbot", m.core.riffbot.agentId, v.team.id), memberAgent(m.core.riffbot.agentId), m.core.riffbot.err)}
        {bugsRow(v, m)}
      </div>
    );
  };
  const bugsRow = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
    const b = m.core.bugs;
    const openBugs = () => { if (v.team.id !== activeTeamId) onSelectSquad(v.team.id); pickBugs(b); };
    return laneRow(v, { laneId: "_bugs", name: b.label, code: "", pin: b.pin, status: b.pin?.running ? "running" : b.pin?.brainstorm?.agent.status ?? "none", needsYou: b.needsYou, err: b.err, age: b.age, titleTestId: suffix(v, "boring-core-bugs"), onOpen: openBugs });
  };

  /** B11b: sidebar project folders. Open state persists in localStorage; unfoldered projects stay on top. */
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(() => {
    try { const p = JSON.parse(localStorage.getItem("vs.boringOpenFolders") || "{}"); return p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch { return {}; }
  });
  const toggleFolder = (name: string) => setOpenFolders((o) => {
    const next = { ...o, [name]: !o[name] };
    try { localStorage.setItem("vs.boringOpenFolders", JSON.stringify(next)); } catch {}
    return next;
  });
  /** Rename carries the open flag to the new name; delete (no newName) prunes it. */
  const migrateOpenFolder = (from: string, to?: string) => setOpenFolders((o) => {
    if (!(from in o)) return o;
    const next = { ...o };
    const was = next[from];
    delete next[from];
    if (to) next[to] = was;
    try { localStorage.setItem("vs.boringOpenFolders", JSON.stringify(next)); } catch {}
    return next;
  });
  const folderOp = async (op: FolderOp) => {
    const r = await patchTeamsFolder(op);
    if (!r.ok) window.alert(`Folder change failed: ${r.error ?? "unknown error"}`);
    return r.ok;
  };
  const folderCtxItems = (f: FolderDef): CtxItem[] => [
    { label: "Rename folder…", run: () => { const n = window.prompt("Rename folder", f.name)?.trim(); if (n && n !== f.name) void folderOp({ op: "renameFolder", name: f.name, newName: n }).then((ok) => { if (ok) migrateOpenFolder(f.name, n); }); } },
    { label: "Delete folder", danger: true, run: () => { if (window.confirm(`Delete folder "${f.name}"? Its projects move back to Active.`)) void folderOp({ op: "deleteFolder", name: f.name }).then((ok) => { if (ok) migrateOpenFolder(f.name); }); } },
    { label: "New folder…", separatorBefore: true, run: () => { const n = window.prompt("New folder name")?.trim(); if (n) void folderOp({ op: "createFolder", name: n }); } },
  ];
  const stat = (v: TeamView) => { const mm = v.team.id === activeTeamId ? model : boringSidebarModel(v, now); return { needsYou: mm.totalNeedsYou, err: mm.projectErr }; };
  const partition = partitionViews(allViews, folders, stat);
  const awakeViews = filterAwakeViews(allViews, folders);
  const activeAsleep = view ? isViewAsleep(view, folders) : false;
  const renderProject = (v: TeamView) => {
    const active = v.team.id === activeTeamId;
    const open = projectIsOpen(v.team.id);
    const m = active ? model : boringSidebarModel(v, now);
    // idea-523: a collapsed project hides every row of its subtree, so it carries the selected state when the selection lives inside it (derived from sel only: exactly one .on row).
    const projectRowCls = isOn(v, "project") || (!open && sel.teamId === v.team.id && sel.rowKey !== null) ? "boring-project-row on" : "boring-project-row";
    return (
      <div key={v.team.id} className={open ? "boring-project-block open" : "boring-project-block"}>
        <div className="boring-conv-line boring-project-line" onContextMenu={(e) => openContextMenu(e, teamCtxItems(v, { folders }))}>
          {chevronCol(open, () => toggleProject(v.team.id), v.team.name, `boring-project-toggle-${v.team.id}`)}
          <button type="button" className={projectRowCls} data-testid={`boring-project-header-${v.team.id}`} aria-expanded={open} onClick={() => openProject(v.team.id)}>
            <span className={`boring-dot ${(v.running ?? 0) > 0 ? "running" : "idle"} ${glyphCls((v.running ?? 0) > 0 ? "running" : "idle", m.projectErr ? "error" : m.totalNeedsYou > 0 ? "needs-you" : null)}`} />
            <span className="boring-project-name" title={v.team.name}>{v.team.name}</span>
            {!open && badge(m.totalNeedsYou, m.projectErr)}
          </button>
          <button type="button" className="boring-row-menu-btn" data-testid={`boring-project-menu-${v.team.id}`} aria-haspopup="menu" aria-label={`${v.team.name} actions`} title="Project actions" onClick={(e) => openContextMenu(e, teamCtxItems(v, { folders }))}>⋯</button>
          {active && (
            <button type="button" className="boring-lane-add" data-testid="boring-new-conv-btn" title="New lane" aria-label="New lane" onClick={onAddBuddy}>+ lane</button>
          )}
        </div>
        {open && (
          <div className="boring-project-lanes" data-testid={`boring-project-lanes-${v.team.id}`}>
            {trinityCard(v, m)}
            <div className="boring-lanes-divider" data-testid={suffix(v, "boring-lanes-divider")}>Lanes</div>
            {m.conversations.map((c) => laneRow(v, { laneId: c.laneId, name: c.name, topicLabel: c.topicLabel, code: c.code, pin: c.pin, status: c.running > 0 ? "running" : c.brainstormStatus, needsYou: c.needsYou, err: c.err, age: c.age, onOpen: () => openLane(v, c) }))}
            {active && m.conversations.length === 0 && <p className="boring-muted">No lanes yet.</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="boring-app" data-testid="boring-app">
      {removingPin && <RemoveTeamDialog pin={removingPin.pin} displayName={removingPin.name} noun="lane" onClose={() => setRemovingPin(null)} />}
      <aside className="boring-sidebar" data-testid="boring-sidebar">
        <div className="boring-sidebar-head" data-testid="boring-sidebar-head">
          <span className="boring-sidebar-title" data-testid="boring-sidebar-title">{APP_NAME}</span>
          <button type="button" className="boring-search-trigger" data-testid="boring-sidebar-search-btn" title="Command palette (Ctrl+K)" aria-label="Search: open command palette (Ctrl+K)" onClick={() => openOverlay("palette")}>
            <span aria-hidden="true">⌕</span><span>Search</span><kbd className="boring-kbd">Ctrl+K</kbd>
          </button>
        </div>
        <BoringInbox views={awakeViews} onOpen={openNeedsYou} now={now} />
        <div className="boring-section-head" data-testid="boring-projects-head">
          <span className="boring-section-label">Projects</span>
          <button type="button" className="boring-icon-btn" data-testid="boring-new-project-btn" title="New project" aria-label="New project" onClick={onNewSquad}>+</button>
        </div>
        <div className="boring-project-tree" data-testid="boring-project-tree">
          {partition.activeViews.map(renderProject)}
          {partition.folderGroups.map((g) => {
            const slug = folderSlug(g.folder.name);
            const fOpen = openFolders[g.folder.name] === true;
            const asleep = g.folder.asleep;
            return (
              <div key={`folder:${g.folder.name}`} className={`boring-folder${fOpen ? " open" : ""}${asleep ? " asleep" : ""}`} data-testid={`boring-folder-${slug}`}>
                <div className="boring-conv-line boring-folder-line" onContextMenu={(e) => openContextMenu(e, folderCtxItems(g.folder))}>
                  <button type="button" className="boring-folder-row" data-testid={`boring-folder-row-${slug}`} aria-expanded={fOpen} onClick={() => toggleFolder(g.folder.name)}>
                    <span className="boring-chevron-btn" aria-hidden="true">{fOpen ? "▾" : "▸"}</span>
                    <span className="boring-folder-name" title={g.folder.name}>{g.folder.name}</span>
                    <span className="boring-folder-count">{`· ${g.count}`}</span>
                    {asleep && <span className="boring-folder-zzz" role="img" aria-label="Asleep">💤</span>}
                    {g.needsYou > 0 && <span className={asleep ? `boring-badge${g.err ? " err" : ""} muted` : `badge boring-badge${g.err ? " err" : ""}`} data-testid={`boring-folder-badge-${slug}`}>{g.needsYou}</span>}
                  </button>
                  <button type="button" className={`boring-folder-sleep${asleep ? " asleep" : ""}`} data-testid={`boring-folder-sleep-${slug}`} aria-label={`Sleep ${g.folder.name}`} aria-pressed={asleep} title={asleep ? "Asleep: automated wake-ups paused. Click to make Active" : "Active: click to put to sleep"} onClick={(e) => { e.stopPropagation(); void folderOp({ op: "setFolderAsleep", name: g.folder.name, asleep: !asleep }); }}>{asleep ? "Asleep" : "Active"}</button>
                  <button type="button" className="boring-row-menu-btn" data-testid={`boring-folder-menu-${slug}`} aria-haspopup="menu" aria-label={`${g.folder.name} folder actions`} title="Folder actions" onClick={(e) => openContextMenu(e, folderCtxItems(g.folder))}>⋯</button>
                </div>
                {fOpen && (
                  <div className="boring-folder-projects" data-testid={`boring-folder-projects-${slug}`}>
                    {g.views.map(renderProject)}
                    {g.views.length === 0 && <p className="boring-muted">No projects.</p>}
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
              <button type="button" className="boring-checkin-btn" data-testid="boring-checkin-btn" disabled={!currentPin?.lead} onClick={() => currentPin && void runCheckin(currentPin, { open: openAgent, send: sendMessage })}>
                Check in
              </button>
            </div>
          )}
          <div className="boring-topbar-actions">
            <button type="button" className="boring-switch-pill" data-testid="boring-global-search-btn" title="Search all transcripts" aria-label="Search transcripts" onClick={() => openOverlay("search")}>Search</button>
            <button type="button" className="boring-switch-pill" data-testid="boring-shortcuts-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => openOverlay("shortcuts")}>Shortcuts <kbd className="boring-kbd">?</kbd></button>
            {mode === "chat" && (agent || panes.split) && (
              <button type="button" className={`boring-switch-pill ${panes.split ? "on" : ""}`} data-testid="boring-split-toggle" aria-pressed={panes.split} title="Split the chat into two panes (Shift+click an agent to open it on the right)" onClick={() => { if (!panes.split && !panes.leftActiveId && agent) openAgent(agent.id); if (panes.split) collapseSplit("active"); else toggleSplit(); }}>
                {panes.split ? "◫ Unsplit" : "◫ Split"}
              </button>
            )}
            {mode === "chat" && agent && (
              <button type="button" className={`boring-switch-pill ${detailsOpen ? "on" : ""}`} data-testid="boring-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
                {detailsOpen ? "▾ Details" : "⋯ Details"}
              </button>
            )}
          </div>
        </header>
        {view && activeAsleep && (
          <div className="boring-asleep-bar" data-testid="boring-asleep-bar" role="status">
            <span>Asleep · Automated wake-ups paused</span>
            <button type="button" className="boring-asleep-wake" data-testid="boring-asleep-wake-btn" onClick={() => view.team.folder && void folderOp({ op: "setFolderAsleep", name: view.team.folder, asleep: false })}>{`Wake ${view.team.folder ?? "folder"}`}</button>
          </div>
        )}
        {opening && (
          <div className="boring-opening" data-testid="boring-opening" role="status">Opening agent…</div>
        )}
        {!opening && mode === "usage" && (
          <div className="boring-dashboard-wrap" data-testid="boring-usage-view">
            <UsageDashboard perfection={{ pin: perfectionPin(views), onOpen: (p) => { setMode("chat"); setSelectedLaneId(p.lane.id); return onOpenPin(p); } }} />
          </div>
        )}
        {!opening && mode === "project" && (
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
                          <span className="boring-row-label boring-lane-name" title={r.topicLabel || undefined}>{r.label}</span>{r.code && <code className="boring-lane-code">{r.code}</code>}
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
        {!opening && mode === "chat" && (
          <div className={`boring-chat-column${detailsOpen ? " boring-details-open" : ""}`} data-testid="boring-chat-column">
            {panes.split ? splitPanes : agent ? <AgentDrawer key={agent.id} agent={agent} onClose={() => setMode("project")} onSuccessor={() => onSuccessor(agent.id)} active pinDecisions /> : panelPin ? (
              // idea-468: a lane (or the Desk) with only workers has no agent to host the drawer, but its Workers fold must still open the panel.
              // The panel matches workers/feed by the REAL lane id (Bugs and the hub use sentinel selection ids), hence panelPin.lane.id.
              <div data-testid="boring-lane-no-agent" style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}><div className="boring-agent-header" data-testid="boring-lane-no-agent-head"><span><strong>{laneLabel ?? "Lane"}</strong><span className="muted"> · {emptyKind === "overlord" || emptyKind === "riffbot" ? "no Overlord or RiffBot running" : "no Lead or Brainstorm running"}</span></span></div><div className="drawer-shell"><div style={{ flex: "1 1 0", minWidth: 0, display: "flex" }}>{emptyCard()}</div><TimelineErrorBoundary fallbackLabel="context panel"><BoringContextPanel key={panelPin.lane.id} entries={[]} teamId={activeTeamId} laneId={panelPin.lane.id} noAgentAction={noAgentAction()} /></TimelineErrorBoundary></div></div>
            ) : emptyCard()}
          </div>
        )}
      </main>
      {children}
    </div>
  );
}
