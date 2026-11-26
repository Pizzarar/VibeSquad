import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { OPEN_USAGE_EVENT, takeColdUsageFocus } from "./usageHelpers";
import { useNowTick } from "./useNowTick";
import { AgentDrawer } from "./AgentDrawer";
import { BoringContextPanel } from "./BoringContextPanel";
import { TimelineErrorBoundary } from "./Timeline";
import { glyphStatusOf, isInNeedsYou, stalledCount } from "./attentionItems";
import { BoringInbox, needsYouReason, needsYouRows, type NeedsYouRow } from "./BoringInbox";
import { laneCtxItems, openContextMenu, type CtxItem, openOverlay, parseUrlState, teamCtxItems, type UrlSlot, type UrlTab } from "./CommandPalette";
import { RemoveTeamDialog } from "./PinRemove";
import { captureFocusReturn } from "./ctxMenuLogic";
import { demoLog } from "./demo";
import { DEMO } from "./demoFlag";
import { IdeaInbox, refreshInboxCards, useFocusedInboxCard, useInboxCards } from "./IdeaInbox";
import { closeTab, collapseSplit, getPanes, openAgent, openAgentInTab, setActivePane, toggleSplit, usePanes } from "./panes";
import { sendMessage, usePaseo } from "./paseo";
import { createQuickBugsPin } from "./pinActions";
import { setBoringLandedGen, setBoringScreenKeys, setBoringShownAgent, spinUpPin } from "./pinFocus";
import { boringDeepLinkPending, boringUrlAgent } from "./pinFocusLogic";
import { boringLaneLabel, laneCode, laneDisplayName, laneTopicLabel } from "./boringLocation";
import { isHubPin, isLive, liveBuddyId, perfectionPin, pinsForSquad, quickBugsChipState, type Pin } from "./pins";
import { formatTimestamp, setPref } from "./prefs";
import { runCheckin } from "./railCheckin";
import { skyZonesFor } from "./skyZonesLogic";
import type { FolderDef, Member, TeamView } from "./teams";
import { filterAwakeViews, folderSlug, isViewAsleep, partitionViews, migrateLastFolder, patchTeamsFolder, setLastFolder, type FolderOp } from "./boringFolders";
import { TeamFeed } from "./TeamFeed";
import type { PinHandler } from "./PinGrid";
import { bustUrl, type BustRole } from "./boringBusts";
import { BoringEmptyJumps, BoringPanePicker, buildPickerData, buildQuickJumps, type CardTarget, type PickerHandlers, type StripItem } from "./BoringPanePicker";
import { useTheme } from "./useBotFace";
import { StatusDot } from "./ui";
import { ProjectTabs } from "./ProjectTabs";
import { useStorybookPresent } from "./StorybookView";
import { CrunchToggle } from "./CrunchToggle";
import { mainView } from "./projectOrder";
import { knownFolderNames, projectOrder } from "./projectOrderActions";
import { UsageDashboard } from "./UsageDashboard";
import { BoringDecisionDesk, DECISION_DESK_DEFAULT_LANDING, useDecisionCount } from "./BoringDecisionDesk";

export { VIBE_PICKED_KEY, VibePickerCards, FirstLaunchVibePicker, shouldShowFirstLaunchVibePicker } from "./FirstRunModal";

// Boring Mode B2 (docs/PLAN_BORING_MODE.md): the whole app as a corporate ADE. Sidebar of Projects > Conversations on the left,
// one centered chat (the existing AgentDrawer) or a plain dashboard on the right. Replaces the sky/tower entirely when app.vibe = "boring".
// Thanks to Antigravity by Google DeepMind for the layout inspiration.

type Role = "brainstorm" | "lead";
type Mode = "chat" | "project" | "usage" | "decisions";
type OverviewTab = "overview" | "inbox" | "feed";
// U1 (idea-997/895): URL keys for the screens that have no agent. ?slot= names an empty Desk/Trinity card; ?tab= the Overview sub-tab.
const SLOT_LANE: Record<UrlSlot, "_overlord" | "_riffbot" | "_bugs"> = { overlord: "_overlord", riffbot: "_riffbot", bugs: "_bugs" };
const LANE_SLOT: Record<string, UrlSlot> = { _overlord: "overlord", _riffbot: "riffbot", _bugs: "bugs" };
const TAB_FROM_URL: Record<UrlTab, OverviewTab> = { inbox: "inbox", standup: "feed" };
const TAB_TO_URL: Record<OverviewTab, UrlTab | null> = { overview: null, inbox: "inbox", feed: "standup" };

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

/** B1: what a URL (after Back/Forward) should show in Normal mode — an agent's chat, or a project's Overview. null = no URL routing to apply. */
export function boringLandingFromUrl(
  views: TeamView[],
  search: string,
  known: (id: string) => boolean = () => true,
): { mode: "chat"; teamId: string | null; view: TeamView | null; sel: ReturnType<typeof boringSelectionForAgent>; agentId: string } | { mode: "slot"; teamId: string; slot: UrlSlot; role?: "lead" } | { mode: "lane"; teamId: string; laneId: string; role: Role } | { mode: "project"; teamId: string | null; tab: UrlTab | null } | { mode: "decisions"; teamId: null } | null {
  const { team, agent, slot, lane, role, tab, view } = parseUrlState(search);
  if (view === "decisions") return { mode: "decisions", teamId: null };
  if (agent) {
    const land = boringAgentLanding(views, agent, known);
    if (!land) return null;
    return { mode: "chat", teamId: land.view?.team.id ?? team, view: land.view, sel: land.sel, agentId: agent };
  }
  // U1: an empty Desk slot (?slot=) or an Overview sub-tab (?tab=). Unknown values parse to null: the plain Overview.
  // U2 (UX R33 r2 m3): a team that is not a known view (?team=gone) shows the fallback project's plain Overview: its slot/tab belong to
  // the gone team, never to the fallback (teamId null = stay on the view App falls back to).
  if (team && !views.some((v) => v.team.id === team)) return { mode: "project", teamId: null, tab: null };
  if (team && slot) return { mode: "slot", teamId: team, slot, ...(slot === "bugs" && role === "lead" ? { role } : {}) };
  // P3 (idea-1000): a feature lane's empty card. A lane this project no longer has (removed, hidden, done) is its plain Overview.
  if (team && lane) {
    const v = views.find((x) => x.team.id === team);
    return v && boringLaneKnown(v, lane) ? { mode: "lane", teamId: team, laneId: lane, role: role === "lead" ? "lead" : "brainstorm" } : { mode: "project", teamId: team, tab: null };
  }
  if (team) return { mode: "project", teamId: team, tab: tab ?? null };
  return null;
}

/** P3 (idea-1000): is `laneId` one of `view`'s feature-lane sidebar rows (the ones `?lane=` can name)? Same filter as the sidebar's
 * conversations: pinned, not the hub, not the Desk's own lane (id = team id), not the Bugs lane (that one is `?slot=bugs`). */
export function boringLaneKnown(view: TeamView, laneId: string): boolean {
  const bugsLane = quickBugsChipState(view).pin?.lane.id;
  return pinsForSquad(view).pinned.some((p) => p.lane.id === laneId && !isHubPin(p) && p.lane.id !== view.team.id && p.lane.id !== bugsLane);
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
/** U1 r2 (UX R33 m1): the Overview page names the sub-tab on screen (its pill label, without the count). */
const TAB_CRUMB: Record<OverviewTab, string> = { overview: "Overview", inbox: "Idea Inbox", feed: "Standup Feed" };
export function boringBreadcrumb(o: { project: string; mode: Mode; laneLabel: string | null; agentLabel: string | null; tab?: OverviewTab }): Crumb[] {
  if (o.mode === "decisions") return [{ key: "project", label: "Decision Desk" }];
  const out: Crumb[] = [{ key: "project", label: o.project || "No project" }];
  if (o.mode === "usage") out.push({ key: "lane", label: "Usage & workflows" });
  else if (o.mode === "project") out.push({ key: "lane", label: TAB_CRUMB[o.tab ?? "overview"] });
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
  if (o.mode === "usage" || o.mode === "decisions") return base;
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
  const zoneRow = (label: string, short: string, z: typeof zones.overlord) => ({
    label,
    short,
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
    overlord: zoneRow("Lead · Overlord", "★ Overlord", zones.overlord),
    riffbot: zoneRow("Brainstorm · RiffBot", "RiffBot", zones.riffbot),
    bugs: {
      label: "Bugs",
      short: "Bugs",
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
    workers: workerSummary(bugs.pin?.workers ?? []), needsYou: bugs.needsYou, running: bugs.leadRunning ? 1 : 0, lastEvent: "", age: bugs.age || "—", sortAge: 0,
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
  onSpinUpPin: (pin: Pin, profile?: string, into?: "right") => void;
  /** Resolves to the new Overlord id (or undefined on a failed spawn) so the split's right card can open it in the right pane. */
  onSpinUpOverlord: (view: TeamView) => void | Promise<string | undefined>;
  overlordBusy?: boolean;
  onAddBuddy: () => void;
  onNewSquad: () => void;
  onSettings: () => void;
  onSuccessor: (agentId: string) => void;
  /** App's banners, modals and overlays, so they stay mounted in Boring Mode. */
  children?: ReactNode;
  /** Top-level health/update banners, rendered above the topbar. */
  banners?: ReactNode;
  /** App's URL routing generation: bumps on popstate so BoringAde re-derives mode + selection from the URL (B1). */
  navGen?: number;
};


export function BoringApp({ views, folders = [], view, onSelectSquad, onOpenPin, onSpinUpPin, onSpinUpOverlord, overlordBusy = false, onAddBuddy, onNewSquad, onSettings, onSuccessor, children, banners, navGen = 0 }: Props) {
  // U1: a reload / shared link restores the screen its URL names: an empty Desk slot card (?slot=) or an Overview sub-tab (?tab=).
  const [url0] = useState(() => (typeof location === "undefined" ? null : parseUrlState(location.search)));
  // U1 r2 (Review-Gemini Major 1/2): the URL's ?slot= / ?tab= name a screen of the URL's team only. Mounting on another view (a cold
  // ?team=gone fallback, a Ctrl+K switch out of Storybook while the URL still names the old project) adopts nothing; a view that resolves
  // after mount (registry / roster arrive late) adopts them when it becomes the URL's team (pendingUrl0 below).
  const urlKeys0 = url0 && url0.team && url0.team === (view?.team.id ?? null) ? url0 : null;
  // P3 (idea-1000): ?lane= names a feature lane's empty card (+ ?role=lead: its Lead card); a lane the view doesn't have is its Overview.
  const [urlLane0] = useState(() => (urlKeys0?.lane && view && boringLaneKnown(view, urlKeys0.lane) ? urlKeys0.lane : null));
  const [mode, setMode] = useState<Mode>(() => (takeColdUsageFocus() ? "usage" : urlKeys0?.slot || urlLane0 ? "chat" : "project"));
  const coldUsage = useRef(mode === "usage"); // cold ?focus=usage: the first agent-landing must not override it
  const theme = useTheme(); // B13e: light theme shows the -light busts
  useEffect(() => {
    const open = () => setMode("usage");
    window.addEventListener(OPEN_USAGE_EVENT, open);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, open);
  }, []);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(() => (urlKeys0?.slot ? SLOT_LANE[urlKeys0.slot] : urlLane0));
  const [selectedRole, setSelectedRole] = useState<Role>(() => ((urlKeys0?.slot || urlLane0) && urlKeys0?.role === "lead" ? "lead" : "brainstorm"));
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const decisionCount = useDecisionCount();
  useEffect(() => {
    if (mode === "project" && (url0?.view === "decisions" || (DECISION_DESK_DEFAULT_LANDING && !url0?.team && !url0?.agent))) setMode("decisions");
  }, []);
  const [laneOpen, setLaneOpen] = useState<Record<string, boolean>>({});
  const [removingPin, setRemovingPin] = useState<{ pin: Pin; name: string; returnTo: unknown } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // U1 (idea-895): the sub-tab is tagged with its project, so the commit that switches project already shows (and publishes) the new
  // one's Overview tab: no stray ?team=<new>&tab=<old> entry. Open-in-Inbox and a pop set the tab for their project.
  const [tabFor, setTabFor] = useState<{ team: string | null; tab: OverviewTab }>(() => ({ team: view?.team.id ?? null, tab: (urlKeys0?.tab && TAB_FROM_URL[urlKeys0.tab]) || "overview" }));
  // U1 r2 (Gemini Major 2): the URL's keys while its team's view has not resolved yet. Dropped by the first user input or pop (from
  // then on the screen follows the user / the popped URL, never a stale cold-load key).
  const pendingUrl0 = useRef(url0?.team && !urlKeys0 && (url0.slot || url0.lane || url0.tab) ? url0 : null);
  useEffect(() => {
    if (!pendingUrl0.current || typeof window === "undefined") return;
    const drop = () => { pendingUrl0.current = null; off(); };
    const off = () => { window.removeEventListener("pointerdown", drop, true); window.removeEventListener("keydown", drop, true); };
    window.addEventListener("pointerdown", drop, true);
    window.addEventListener("keydown", drop, true);
    return off;
  }, []);
  const overviewTab: OverviewTab = tabFor.team === (view?.team.id ?? null) ? tabFor.tab : "overview";
  const setOverviewTab = (tab: OverviewTab, team: string | null = view?.team.id ?? null) => setTabFor({ team, tab });
  const [rightCard, setRightCard] = useState<CardTarget | null>(null); // B17: the split's right-pane card target (pane-local)
  const [startState, setStartState] = useState<{ laneKey: string; busy: boolean; error: string | null } | null>(null);
  const inboxCount = useInboxCards().length;
  const storybookPresent = useStorybookPresent(view?.team.id ?? null);
  // R13-1: a ref popover's "Open in Inbox" (Normal) flips to the overview's Idea Inbox tab; the list flashes the card.
  const focusedInboxCard = useFocusedInboxCard();
  useEffect(() => {
    if (focusedInboxCard) {
      setMode("project");
      setOverviewTab("inbox");
    }
  }, [focusedInboxCard]);
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
    if (coldUsage.current) coldUsage.current = false;
    else setMode(land.mode);
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
  const rightCardName = (t: CardTarget) => (t.key === "_bugs" ? "Bugs" : t.key === "_overlord" ? "Overlord" : t.key === "_riffbot" ? "RiffBot" : conversations.find((x) => x.laneId === t.key)?.name ?? "Lane");

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
  // idea-1075 r3: the ONE way a slot lane becomes the screen (sidebar pick, Back/Forward landing, cold-load ?slot=). It clears B17's
  // pane-local right card, so ?slot= (urlSlot) and the rendered card can never name different screens.
  const enterSlotLane = (laneId: string) => {
    setRightCard(null);
    setSelectedLaneId(laneId);
    setSelectedWorkerId(null);
    setMode("chat");
  };
  const navGen0 = useRef(navGen); // B1: a remount starts with the current navGen; only a pop after mount re-lands
  // U2 (idea-983): the pop whose landing this render shows (set with the landing's own state, so it commits in the same render).
  const [landedGen, setLandedGen] = useState(navGen);
  // B1: Back/Forward re-derive mode + selection from the URL, even when the active agent is unchanged (App's openAgent no-ops).
  // U2: location.search is read here, at effect time, so pops that arrive before this runs coalesce to the latest entry.
  useEffect(() => {
    if (!navGen || navGen === navGen0.current || typeof location === "undefined") return;
    setLandedGen(navGen);
    pendingUrl0.current = null; // U1 r2: a pop names its own screen
    const land = boringLandingFromUrl(allViews, location.search, (id) => agents.has(id));
    if (!land) return;
    if (land.teamId && land.teamId !== view?.team.id) onSelectSquad(land.teamId);
    if (land.mode === "chat") {
      if (land.sel) {
        setSelectedLaneId(land.sel.laneId);
        if (land.sel.role === "worker") setSelectedWorkerId(land.agentId);
        else { setSelectedRole(land.sel.role); setSelectedWorkerId(null); }
        if (land.view) revealAgent(land.view, land.sel, land.agentId);
      } else {
        // A known-but-unpinned agent has no sidebar row: clear the stale lane/worker so the chat target falls back to the URL agent.
        setSelectedLaneId(null);
        setSelectedWorkerId(null);
      }
      setMode("chat");
    } else if (land.mode === "decisions") {
      setMode("decisions");
    } else if (land.mode === "slot" || land.mode === "lane") {
      enterSlotLane(land.mode === "slot" ? SLOT_LANE[land.slot] : land.laneId); // P3: a lane's empty card enters like a Desk slot (idea-1075)
      setSelectedRole(land.role === "lead" ? "lead" : "brainstorm");
      if (land.mode === "lane") setProjectOpen((o) => ({ ...o, [land.teamId]: true })); // its lane row is visible (like revealAgent)
    } else {
      setOverviewTab((land.tab && TAB_FROM_URL[land.tab]) || "overview", land.teamId ?? view?.team.id ?? null); // Back to ?team= alone = the Overview tab
      setMode("project");
    }
  }, [navGen]);
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
    enterSlotLane(laneId);
    if (agentId) openHere(agentId);
  };
  const pickBugs = (b: { pin: Pin | null; agentId: string | null } = core.bugs) => {
    enterSlotLane("_bugs");
    setSelectedRole("brainstorm");
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
  // U1: the agent-less screen keys (App writes ?slot= / ?tab=; serializeUrlState drops them whenever an agent is named).
  const urlSlot = mode === "chat" && !agent && selectedLaneId ? LANE_SLOT[selectedLaneId] ?? null : null;
  // P3 (idea-1000): a feature lane's empty card (?lane=) and whose card it is (?role=lead, also for the Bugs slot). Derived from the main
  // selection only: the split's right-pane card (rightCard) is transient pane state and never gets a key (agreed with @bor, Bor3).
  const urlLane = mode === "chat" && !agent && currentConv ? currentConv.laneId : null;
  const urlRole = (urlLane || urlSlot === "bugs") && currentPin && selectedRole === "lead" ? "lead" : null;
  const urlTab = mode === "project" ? TAB_TO_URL[overviewTab] : null;
  const screenTeam = view?.team.id ?? null;
  // U1: a project switch resets the sub-tab for good (returning by its row shows the Overview tab); `overviewTab` already reads
  // "overview" for the new project in the switching commit, so this only drops the stale state. A pop sets the new project's tab first.
  // Functional: a cross-project pop sets the new project's tab in the navGen effect of this same commit, which must win.
  // U1 r2 (Gemini Major 2): ...unless this is the URL's team resolving after mount: adopt its ?slot= / ?tab= instead (once).
  useEffect(() => {
    const p = pendingUrl0.current;
    if (p && p.team === screenTeam) {
      pendingUrl0.current = null;
      const lane = p.slot ? SLOT_LANE[p.slot] : p.lane && view && boringLaneKnown(view, p.lane) ? p.lane : null; // P3: ?lane=
      if (lane) {
        enterSlotLane(lane); // idea-1075: the one slot/lane entry
        setSelectedRole(p.role === "lead" ? "lead" : "brainstorm");
      }
      setTabFor({ team: screenTeam, tab: (p.tab && TAB_FROM_URL[p.tab]) || "overview" });
      return;
    }
    setTabFor((cur) => (cur.team === screenTeam ? cur : { team: screenTeam, tab: "overview" }));
  }, [screenTeam]);
  useEffect(() => setBoringScreenKeys({ team: screenTeam, slot: urlSlot, lane: urlLane, role: urlRole, tab: urlTab }), [screenTeam, urlSlot, urlLane, urlRole, urlTab]);
  useEffect(() => () => setBoringScreenKeys(undefined), []);
  // U2: declared after the shown-agent / screen-key publishers, so App's URL sync reads that landing's values when this one flips.
  useEffect(() => setBoringLandedGen(landedGen), [landedGen]);
  useEffect(() => () => setBoringLandedGen(undefined), []);
  const topRole = currentPin ? selectedRole : boringActiveRole(currentPin ?? { brainstorm: null, lead: null }, agentId);
  const onWorker = Boolean(selectedWorkerId && agentId === selectedWorkerId);

  const selRaw = boringActiveSelection({ mode, views: allViews, teamId: activeTeamId, agentId: agent?.id ?? null, laneId: selectedLaneId, role: selectedRole, workerId: selectedWorkerId });
  // An empty active pane names nobody: no row is selected and the breadcrumb says so, instead of echoing the other pane's agent.
  // idea-1075: a dormant Desk/Bugs slot picked from the sidebar while split has no agent to show in either pane. The URL already names it
  // (?slot=, urlSlot), so the screen must be its empty card too, not the split panes (the split keeps its panes and returns when an agent
  // opens). B17's pane-local right card is the exception: while the right pane is active and showing one, that card is the screen. A sidebar
  // pick (pickBugs/pickCore) clears it, so the two never both claim the screen.
  const rightCardShown = !!rightCard && panes.activePane === "right";
  const dormantSlot = mode === "chat" && !agent && !!selectedLaneId && !!LANE_SLOT[selectedLaneId] && !rightCardShown;
  const splitEmptyActive = mode === "chat" && panes.split && !activeAgentId && !dormantSlot;
  useEffect(() => { if (rightCard && (!panes.split || panes.rightActiveId)) setRightCard(null); }, [rightCard, panes.split, panes.rightActiveId]);
  useEffect(() => { setRightCard(null); }, [view?.team.id]);
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
  const crumbs = opening ? [{ key: "project" as const, label: "Opening…" }] : boringBreadcrumb({ project: selView?.team.name ?? "", mode, laneLabel: splitEmptyActive ? (rightCard && panes.activePane === "right" ? rightCardName(rightCard) : "Split · pick an agent") : sel.laneId ? laneLabel : null, agentLabel: sel.agentLabel, tab: overviewTab });
  const onCrumb = (key: Crumb["key"]) => {
    if (key === "project" && mode === "project") setOverviewTab("overview"); // on a sub-tab, the project crumb is its Overview
    if (key === "project") setMode("project");
    else if (key === "lane" && mode === "chat") {
      if (currentConv && view) openLane(view, currentConv);
      else if (selectedLaneId === "_bugs") pickBugs();
    }
  };

  // One stable key per start: the Bugs lane may be created mid-flight (pin goes null -> set), which must not drop busy/error.
  const startKeyFor = (pin: Pin | null, laneId: string | null = selectedLaneId) => (laneId === "_bugs" ? "_bugs" : pin ? `${pin.squad?.id}/${pin.lane.id}` : null);
  const runStart = (laneKey: string, start: () => Promise<string | null>) => {
    const flightKey = `${view?.team.id}|${laneKey}`;
    if (startInFlight.has(flightKey)) return; // synchronous double-click guard (state alone lags a render)
    startInFlight.add(flightKey);
    setStartState({ laneKey, busy: true, error: null });
    void start()
      .then((error) => setStartState({ laneKey, busy: false, error }))
      .finally(() => startInFlight.delete(flightKey));
  };
  // B17: the split's right-pane empty card has its OWN target (never selectedLaneId / emptyKind) and starts into the right pane.
  type CardCtx = { laneId: string | null; kind: typeof emptyKind; pin: Pin | null; right?: boolean };
  const mainCtx: CardCtx = { laneId: selectedLaneId, kind: emptyKind, pin: currentPin };
  const rightSpin = (p: Pin) => spinUpPin(p, undefined, undefined, "right");
  const startBrainstorm = (pin: Pin, c: CardCtx = mainCtx) => runStart(startKeyFor(pin, c.laneId) ?? "", () => boringStartBrainstorm(pin, c.right ? rightSpin : undefined));
  const startBugs = (c: CardCtx = mainCtx) => view && runStart("_bugs", () => boringStartBugs(view.team.id, c.right ? { spinUp: rightSpin } : {}));
  const emptySpec = (c: CardCtx = mainCtx) => {
    const { pin: cPin, kind: cKind } = c;
    const needsBugsLane = c.laneId === "_bugs" && !cPin;
    const startKey = startKeyFor(cPin, c.laneId);
    const startFor = startKey && startState?.laneKey === startKey ? startState : null;
    const spec = {
      overlord: { text: "No Overlord is running for this project yet.", cta: "Start Overlord", run: () => view && (c.right ? void Promise.resolve(onSpinUpOverlord(view)).then((id) => id && getPanes().split && openAgentInTab(id, "right")).catch(() => {}) : onSpinUpOverlord(view)), disabled: overlordBusy },
      riffbot: { text: "RiffBot is sleeping.", cta: "Start RiffBot", run: () => hubPin && (c.right ? onSpinUpPin(hubPin, undefined, "right") : onSpinUpPin(hubPin)), disabled: !hubPin },
      brainstorm: { text: "No Brainstorm session is running for this conversation yet.", cta: startFor?.busy ? "Starting Brainstorm…" : "Start Brainstorm", run: () => (cPin ? startBrainstorm(cPin, c) : startBugs(c)), disabled: (!cPin && !needsBugsLane) || Boolean(startFor?.busy) },
      lead: { text: "No Lead is running yet — ask Brainstorm to hand off a plan.", cta: "Switch to Brainstorm", run: () => (c.right ? switchRightToBrainstorm(c) : setSelectedRole("brainstorm")), disabled: false },
    }[cKind];
    return spec;
  };
  /** idea-468 m1: what the agent-less panel's Changes/Files/Terminal tabs offer: open an existing (idle) Lead, else the empty card's own start action. */
  const noAgentAction = (): { need: string; label: string; disabled?: boolean; run: () => void } => {
    if (currentPin?.lead && selectedLaneId) return { need: "the Lead open", label: "Open the Lead", run: () => pickRole(currentPin, selectedLaneId, "lead") };
    const spec = emptySpec();
    const desk = emptyKind === "overlord" || emptyKind === "riffbot";
    return { need: desk ? "a running Overlord or RiffBot" : "a running Lead or Brainstorm", label: spec.cta, disabled: spec.disabled, run: () => void spec.run() };
  };
  // B17: open handlers for the split picker + the empty card's quick-jumps (data builders live in BoringPanePicker.tsx).
  const pickerHandlers: PickerHandlers = {
    glyphCls,
    openAgent: (id) => view && openAgentIn(view, id),
    openCore: (laneId, id) => pickCore(laneId, id),
    openBugs: () => pickBugs(),
    openRole: (laneId, role) => { const c = conversations.find((x) => x.laneId === laneId); if (c && view) pickRoleIn(view, c.pin, laneId, role); },
  };
  /** B17: the picker strip = the sidebar's own Needs-you rows (needsYouRows) + every other running member (Desk workers, Buddies, Leads), so the counts agree. */
  const pickerStrip = (): StripItem[] => {
    if (!view) return [];
    const rows = needsYouRows([view], now).filter((r) => r.item.kind !== "finished");
    const seen = new Set(rows.map((r) => r.item.id));
    // Hub members are Overlord / RiffBot and the Bugs lane says Bugs: never "Lead · Desk" / "Buddy · Desk".
    const laneName = (id: string | null | undefined) => (id && id === hubPin?.lane.id ? null : id && id === core.bugs.pin?.lane.id ? "Bugs" : conversations.find((c) => c.laneId === id)?.name ?? null);
    const memberTitle = (m: (typeof view.members)[number]) => {
      if (m.kind !== "lead" && m.kind !== "brainstorm") return m.agent.title ?? m.agent.id.slice(0, 8);
      const hub = Boolean(m.laneId) && m.laneId === hubPin?.lane.id;
      if (hub) return m.kind === "lead" ? "Overlord" : "RiffBot";
      const n = laneName(m.laneId);
      return n === "Bugs" ? (m.kind === "lead" ? "Bugs · Lead" : "Bugs") : n ? `${m.kind === "lead" ? "Lead" : "Buddy"} · ${n}` : (m.agent.title ?? (m.kind === "lead" ? "Lead" : "Buddy"));
    };
    const running = view.members.filter((m) => m.agent.status === "running" && !seen.has(m.agent.id) && !m.agent.archivedAt).map((m): StripItem => ({ id: m.agent.id, needs: false, sub: "Working", title: memberTitle(m) }));
    return [...rows.map((r): StripItem => ({ id: r.item.id, needs: true, err: r.item.kind === "error", title: r.who, sub: r.who.includes(r.lane) ? needsYouReason(r.item) : `${r.lane} · ${needsYouReason(r.item)}` })), ...running];
  };
  // Every open action on the right card lands in the right pane (live -> openAgentInTab("right"); dormant -> update rightCard, never fold split or clobber selectedLaneId).
  const rightHandlers: PickerHandlers = {
    glyphCls,
    openAgent: (id) => { setActivePane("right"); pickerHandlers.openAgent(id); },
    openCore: (laneId, id) => (id ? openAgentInTab(id, "right") : setRightCard({ key: laneId, pill: "open" })),
    openBugs: () => (core.bugs.pin && core.bugs.agentId ? openAgentInTab(core.bugs.agentId, "right") : setRightCard({ key: "_bugs", pill: "open" })),
    openRole: (laneId, role) => {
      const c = conversations.find((x) => x.laneId === laneId);
      const m = c && (role === "lead" ? c.pin.lead : c.pin.brainstorm);
      if (m) openAgentInTab(m.agent.id, "right");
      else setRightCard({ key: laneId, pill: role });
    },
  };
  /** Right-pane card target -> its own ctx (pane-local: clicking the left pane never rewrites it). */
  const rightCtx = (t: CardTarget): CardCtx => {
    if (t.key === "_overlord") return { laneId: t.key, kind: "overlord", pin: null, right: true };
    if (t.key === "_riffbot") return { laneId: t.key, kind: "riffbot", pin: null, right: true };
    if (t.key === "_bugs") return { laneId: t.key, kind: "brainstorm", pin: core.bugs.pin, right: true };
    return { laneId: t.key, kind: t.pill === "lead" ? "lead" : "brainstorm", pin: conversations.find((x) => x.laneId === t.key)?.pin ?? null, right: true };
  };
  const switchRightToBrainstorm = (c: CardCtx) => {
    const id = c.pin?.brainstorm && isLive(c.pin.brainstorm) ? c.pin.brainstorm.agent.id : null;
    if (id) openAgentInTab(id, "right");
    else setRightCard(c.laneId ? { key: c.laneId, pill: "brainstorm" } : null);
  };
  const emptyCard = (target?: CardTarget) => {
    const c = target ? rightCtx(target) : mainCtx;
    const startKey = startKeyFor(c.pin, c.laneId);
    const startFor = startKey && startState?.laneKey === startKey ? startState : null;
    const spec = emptySpec(c);
    return (
      <div className="boring-empty-card" data-testid="boring-empty-card">
        {target && <h3 className="boring-empty-lane" data-testid="boring-empty-lane">{rightCardName(target)}</h3>}
        <p>{spec.text}</p>
        <button type="button" className="boring-primary-cta" data-testid="boring-empty-cta" disabled={spec.disabled} onClick={() => void spec.run()}>
          {spec.cta}
        </button>
        {c.kind === "brainstorm" && startFor?.error && (
          <p className="boring-empty-error" role="alert" data-testid="boring-start-error">Could not start Brainstorm: {startFor.error}</p>
        )}
        <BoringEmptyJumps {...buildQuickJumps(model, c.laneId, c.right ? rightHandlers : pickerHandlers)} />
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
  /** N5: closing the split from the picker (Esc / Close split) returns focus to the header Split button (the picker that held it unmounts). */
  const closeSplitToButton = () => { toggleSplit(); if (typeof document !== "undefined") setTimeout(() => document.querySelector<HTMLElement>('[data-testid="boring-split-toggle"]')?.focus(), 0); };
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
            <BoringPanePicker key={view?.team.id} getData={() => buildPickerData(model, pickerHandlers, pickerStrip())} renderEmpty={(t) => emptyCard(t)} emptyTarget={rightCard} onEmptyTarget={setRightCard} onClose={closeSplitToButton} focusOnMount={panes.activePane === "right"}>
              <button type="button" className="boring-switch-pill" data-testid="boring-split-close" onClick={closeSplitToButton}>Close split</button>
            </BoringPanePicker>
            <p className="boring-split-hint">Shift+click any sidebar row to open it on the right.</p>
          </div>
        )}
      </div>
    </div>
  );

  // R2.5: a container shows its count only while collapsed, tinted by its worst state inside (red error, else amber).
  const badge = (n: number, err = false) => (n > 0 ? <span className={`badge boring-badge${err ? " err" : ""}`}>{n}</span> : null);
  const memberAgent = (id: string | null) => (id ? agents.get(id) : undefined);
  const projectIsOpen = (id: string) => projectOpen[id] ?? (id === activeTeamId || id === sel.teamId);
  /** Clicking a project's name opens its Overview (switching Squad if needed); only the chevron expands/collapses. */
  const openProject = (id: string) => {
    if (id !== activeTeamId) onSelectSquad(id);
    // Multiple projects can stay expanded: keep the one we leave open.
    setProjectOpen((o) => ({ ...o, [activeTeamId]: activeTeamId === mainV?.team.id ? o[activeTeamId] : o[activeTeamId] ?? true, [id]: true }));
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
    <button key={w.agent.id} type="button" className={workerRowCls(isOn(v, "worker:" + w.agent.id), w)} data-testid={`boring-worker-${w.agent.id}`} aria-current={isOn(v, "worker:" + w.agent.id) ? "true" : undefined} onClick={() => openTarget(v, pin, laneId, { role: "worker", agentId: w.agent.id })}>
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
  /** B13c: 22px mini mascot for a lane row: Lead > Brainstorm > worker bust, hollow square when the lane has no agent. */
  const laneMini = (pin: Pin | null, status: string, needsYou: number, err: boolean) => {
    const role: BustRole | null = pin && isLive(pin.lead) ? "lead" : pin?.brainstorm ? "buddy" : pin && pin.workers.length > 0 ? "worker" : null;
    const state = err ? "err" : needsYou > 0 ? "attn" : status === "running" ? "run" : "idle";
    if (!role) return <span className="boring-lane-mini none" aria-hidden="true" />;
    return <span className={`boring-lane-mini ${state}${status === "running" ? " lit" : ""}`} aria-hidden="true"><img className="boring-bust-img" src={bustUrl(role, theme)} alt="" width={22} height={22} /></span>;
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
    const laneMenu = lanePin ? () => laneCtxItems(v, lanePin, { displayName: c.name, onRemove: !isHubPin(lanePin) && c.laneId !== "_bugs" ? () => setRemovingPin({ pin: lanePin, name: c.name, returnTo: captureFocusReturn(typeof document === "undefined" ? null : document.activeElement) }) : undefined }) : null;
    return (
      <div key={c.laneId} className={laneCls} data-testid={`boring-conv-${c.laneId}`}>
        <div className="boring-conv-line" onContextMenu={laneMenu ? (e) => openContextMenu(e, laneMenu()) : undefined}>
          <button type="button" className="boring-chevron-btn" data-testid={`boring-conv-toggle-${c.laneId}`} aria-expanded={open} aria-label={open ? "Collapse lane" : "Expand lane"} disabled={!expandable} onClick={() => setLaneOpen((o) => ({ ...o, [key]: !open }))}>
            {!expandable ? "" : open ? "▾" : "▸"}
          </button>
          <button type="button" className="boring-conv-title" data-testid={c.titleTestId} title={c.topicLabel || undefined} onClick={c.onOpen}>
            {laneMini(c.pin, c.status, c.needsYou, c.err)}
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
  /** B13c: one Desk mascot tile (bust + label + state caption); state rings come from CSS classes, never opacity. */
  const deskTile = (v: TeamView, testid: string, key: string, role: BustRole, label: string, short: string, status: string, needsYou: number, err: boolean, age: string, onClick: () => void, extraOn = false) => {
    const state = err ? "err" : needsYou > 0 ? "attn" : status === "running" ? "run" : "idle";
    // m1: keep the tile caption short so the age survives the 3-col grid at 1920 ("idle 12m", not "idle · 12m ago").
    const shortAge = age === "just now" ? "now" : age.replace(/ ago$/, "");
    // n4: "working 1m" clips to "working n…" in the 290px sidebar at 1280/1440 — drop the age from the working caption.
    const caption = err ? "error" : needsYou > 0 ? "needs you" : status === "running" ? "working" : status === "none" ? "no agent" : `idle${age ? ` ${shortAge}` : ""}`;
    return (
      <button key={testid} type="button" className={`boring-mate ${state}${isOn(v, key) || extraOn ? " on" : ""}`} data-testid={suffix(v, testid)} onClick={onClick} title={label} aria-current={isOn(v, key) || extraOn ? "true" : undefined} aria-label={`${short} ${caption}${needsYou > 0 ? ` (${needsYou})` : ""}`}>
        <span className="boring-mate-av" aria-hidden="true"><img className="boring-bust-img" src={bustUrl(role, theme)} alt="" width={48} height={48} /></span>
        <span className="boring-row-label boring-mate-name">{short}</span>
        <span className="boring-mate-cap">{caption}</span>
        {badge(needsYou, err)}
      </button>
    );
  };
  /** B13c: Overlord + RiffBot + Bugs as a 3-tile mascot grid in the always-visible Desk card, separate from the feature lanes. */
  const trinityCard = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
    const hubPinV = skyZonesFor(v).hub;
    const inDesk = sel.teamId === v.team.id && (sel.laneId === "_overlord" || sel.laneId === "_riffbot" || sel.laneId === "_desk");
    const hw = m.core.deskWorkers;
    const b = m.core.bugs;
    const bugsKey = `${v.team.id}/_bugs`;
    const bugsSel = sel.teamId === v.team.id && sel.laneId === "_bugs";
    const bugsOpen = laneOpen[bugsKey] ?? bugsSel;
    const bugsLead = b.pin && isLive(b.pin.lead) ? b.pin.lead : null;
    const bugsWorkers = b.pin?.workers ?? [];
    const bugsExpandable = bugsWorkers.length > 0 || Boolean(bugsLead);
    const bugsStatus = b.pin?.running ? "running" : b.pin?.brainstorm?.agent.status ?? "none";
    const openBugs = () => { if (v.team.id !== activeTeamId) onSelectSquad(v.team.id); pickBugs(b); };
    const bugsMenu = b.pin ? () => laneCtxItems(v, b.pin!, { displayName: b.label }) : null;
    const bugsLeadKey = "lane:_bugs:lead";
    return (
      <div key="trinity" className="boring-trinity-card" data-testid={suffix(v, "boring-trinity")}>
        <div className="boring-trinity-head" data-testid={suffix(v, "boring-trinity-head")}><span>Desk</span>{badge(m.deskWorkersNeedsYou, m.deskWorkersErr)}</div>
        <div className="boring-desk-grid">
          {deskTile(v, "boring-core-overlord", "desk:lead", "overlord", m.core.overlord.label, m.core.overlord.short, m.core.overlord.status, m.core.overlord.needsYou, m.core.overlord.err, m.core.overlord.age, () => pickCore("_overlord", m.core.overlord.agentId, v.team.id))}
          {deskTile(v, "boring-core-riffbot", "desk:brainstorm", "riffbot", m.core.riffbot.label, m.core.riffbot.short, m.core.riffbot.status, m.core.riffbot.needsYou, m.core.riffbot.err, m.core.riffbot.age, () => pickCore("_riffbot", m.core.riffbot.agentId, v.team.id))}
          <div className="boring-desk-cell" data-testid="boring-conv-_bugs" onContextMenu={bugsMenu ? (e) => openContextMenu(e, bugsMenu()) : undefined}>
            {deskTile(v, "boring-core-bugs", "lane:_bugs", "bugs", b.label, b.short, bugsStatus, b.needsYou, b.err, b.age, openBugs, !bugsOpen && bugsSel && sel.rowKey !== null)}
            {bugsMenu && <button type="button" className="boring-row-menu-btn boring-desk-menu" data-testid="boring-lane-menu-_bugs" aria-haspopup="menu" aria-label={`${b.label} lane actions`} title="Lane actions" onClick={(e) => openContextMenu(e, bugsMenu())}>⋯</button>}
          </div>
        </div>
        {hw.length > 0 && hubPinV && workerList(v, hubPinV, "_desk", hw, suffix(v, "boring-desk-workers"), suffix(v, "boring-desk-workers-fold"), inDesk, () => pickCore("_overlord", m.core.overlord.agentId, v.team.id))}
        {bugsExpandable && b.pin && (
          <div className="boring-bugs-subs">
            <button type="button" className="boring-chevron-btn" data-testid="boring-conv-toggle-_bugs" aria-expanded={bugsOpen} aria-label={bugsOpen ? "Collapse lane" : "Expand lane"} onClick={() => setLaneOpen((o) => ({ ...o, [bugsKey]: !bugsOpen }))}>{bugsOpen ? "▾" : "▸"}</button>
            {bugsOpen && bugsLead && (
              <button type="button" className={workerRowCls(isOn(v, bugsLeadKey), bugsLead)} data-testid="boring-lead-_bugs" title={bugsLead.agent.title ?? bugsLead.agent.id.slice(0, 8)} aria-current={isOn(v, bugsLeadKey) ? "true" : undefined} aria-label={`Lead · ${bugsLead.agent.status}${bugsLead.attention?.tone ? ` · ${bugsLead.attention.tone}` : ""}`} onClick={() => pickRoleIn(v, b.pin!, "_bugs", "lead")}>
                <span className={`boring-dot ${bugsLead.agent.status} ${glyphCls(bugsLead.agent.status, bugsLead.attention?.tone)}`} />
                <span className="boring-row-label">Lead</span>
                <span className="boring-conv-age">{formatTimestamp(bugsLead.agent.updatedAt, "relative")}</span>
              </button>
            )}
            {bugsOpen && bugsWorkers.length > 0 && workerList(v, b.pin, "_bugs", bugsWorkers, "boring-workers-_bugs", "boring-workers-fold-_bugs", bugsSel, openBugs)}
          </div>
        )}
      </div>
    );
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
    { label: "Rename folder…", run: () => { const n = window.prompt("Rename folder", f.name)?.trim(); if (n && n !== f.name) void folderOp({ op: "renameFolder", name: f.name, newName: n }).then((ok) => { if (ok) { migrateOpenFolder(f.name, n); migrateLastFolder(f.name, n); } }); } },
    { label: "Delete folder", danger: true, run: () => { if (window.confirm(`Delete folder "${f.name}"? Its projects move back to Active.`)) void folderOp({ op: "deleteFolder", name: f.name }).then((ok) => { if (ok) { migrateOpenFolder(f.name); migrateLastFolder(f.name); } }); } },
    { label: "New folder…", separatorBefore: true, run: () => { const n = window.prompt("New folder name")?.trim(); if (n) void folderOp({ op: "createFolder", name: n }); } },
  ];
  const stat = (v: TeamView) => { const mm = v.team.id === activeTeamId ? model : boringSidebarModel(v, now); return { needsYou: mm.totalNeedsYou, err: mm.projectErr }; };
  // PLAN_PROJECT_ORDER: the list keeps teams.json order (buildTeamViews); the Main project is lifted out and pinned above the tree.
  const mainV = mainView(allViews);
  const partition = partitionViews(mainV ? allViews.filter((v) => v !== mainV) : allViews, folders, stat);
  const knownF = knownFolderNames(folders);
  /** O2 drag-reorder: a grip drag (pointer events, so mouse and touch behave the same) over rows of the same folder/list. */
  const [drag, setDrag] = useState<{ id: string; over: string | null; where: "before" | "after" } | null>(null);
  const dragRef = useRef(drag);
  /** Ref is set synchronously so a cancel (Escape) beats the pointerup that follows it. */
  const setDragNow = (d: typeof drag) => { dragRef.current = d; setDrag(d); };
  const gripRef = useRef<{ el: HTMLElement; pid: number } | null>(null);
  const dragCancel = () => { const g = gripRef.current; gripRef.current = null; setDragNow(null); try { g?.el.releasePointerCapture(g.pid); } catch {} };
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); dragCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const orderGroup = (v: TeamView) => (v.team.folder && knownF.has(v.team.folder) ? v.team.folder : "");
  const dragMove = (e: PointerEvent<HTMLElement>, v: TeamView) => {
    if (!dragRef.current) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-order-id]");
    if (!hit || hit.dataset.orderId === v.team.id || hit.dataset.orderGroup !== orderGroup(v)) { setDragNow({ id: v.team.id, over: null, where: "before" }); return; }
    const r = hit.getBoundingClientRect();
    setDragNow({ id: v.team.id, over: hit.dataset.orderId ?? null, where: e.clientY < r.top + r.height / 2 ? "before" : "after" });
  };
  const dragEnd = (commit: boolean) => {
    const d = dragRef.current;
    gripRef.current = null;
    setDragNow(null);
    if (commit && d?.over) void projectOrder.drop(d.id, d.over, d.where, knownF);
  };
  const awakeViews = filterAwakeViews(allViews, folders);
  const activeAsleep = view ? isViewAsleep(view, folders) : false;
  // B13b: the living sky reacts to Squad state; an asleep project is always idle.
  const squadState: "idle" | "busy" = view && !activeAsleep && (view.running ?? 0) > 0 ? "busy" : "idle";
  const projectLanes = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
    const active = v.team.id === activeTeamId;
    return (
          <div className="boring-project-lanes" data-testid={`boring-project-lanes-${v.team.id}`}>
          {trinityCard(v, m)}
          <div className="boring-lanes-divider" data-testid={suffix(v, "boring-lanes-divider")}>Lanes</div>
          {m.conversations.map((c) => laneRow(v, { laneId: c.laneId, name: c.name, topicLabel: c.topicLabel, code: c.code, pin: c.pin, status: c.running > 0 ? "running" : c.brainstormStatus, needsYou: c.needsYou, err: c.err, age: c.age, onOpen: () => openLane(v, c) }))}
          {active && m.conversations.length === 0 && <p className="boring-muted">No lanes yet.</p>}
        </div>
    );
  };
  const DROP_CLS = { before: "drop-before", after: "drop-after" } as const;
  const renderProject = (v: TeamView, isMain = false) => {
    const active = v.team.id === activeTeamId;
    const open = isMain ? (projectOpen[v.team.id] ?? false) : projectIsOpen(v.team.id); // the pinned Main row starts compact
    const m = active ? model : boringSidebarModel(v, now);
    // idea-523: a collapsed project hides every row of its subtree, so it carries the selected state when the selection lives inside it (derived from sel only: exactly one .on row).
    const projectRowCls = isOn(v, "project") || (!open && sel.teamId === v.team.id && sel.rowKey !== null) ? "boring-project-row on" : "boring-project-row";
    return (
      <div key={v.team.id} className={[open ? "boring-project-block open" : "boring-project-block", isMain && "is-main", drag?.over === v.team.id && DROP_CLS[drag.where], drag?.id === v.team.id && "dragging"].filter(Boolean).join(" ")} data-order-id={isMain ? undefined : v.team.id} data-order-group={orderGroup(v)} data-testid={isMain ? "boring-main-project" : undefined}>
        <div className={`boring-conv-line boring-project-line${!open && m.totalNeedsYou > 0 ? " has-badge" : ""}` + (isMain ? " boring-main-line" : "")} onContextMenu={(e) => openContextMenu(e, teamCtxItems(v, { folders }))}>
          {!isMain && (
            <span className="boring-drag-grip" aria-hidden="true" title="Drag to reorder (or ⋯ → Move up / Move down)" data-testid={`boring-project-grip-${v.team.id}`} onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); gripRef.current = { el: e.currentTarget, pid: e.pointerId }; setDragNow({ id: v.team.id, over: null, where: "before" }); }} onPointerMove={(e) => dragMove(e, v)} onPointerUp={() => dragEnd(true)} onPointerCancel={() => dragEnd(false)} onLostPointerCapture={() => { if (dragRef.current) dragEnd(false); }}>⠿</span>
          )}
          {chevronCol(open, () => setProjectOpen((o) => ({ ...o, [v.team.id]: !open })), v.team.name, `boring-project-toggle-${v.team.id}`)}
          <button type="button" className={projectRowCls} data-testid={`boring-project-header-${v.team.id}`} aria-expanded={open} onClick={() => openProject(v.team.id)}>
            <span className={`boring-dot ${(v.running ?? 0) > 0 ? "running" : "idle"} ${glyphCls((v.running ?? 0) > 0 ? "running" : "idle", m.projectErr ? "error" : m.totalNeedsYou > 0 ? "needs-you" : null)}`} />
            {isMain && <img className="boring-bust-img boring-main-bust" src={bustUrl("riffbot", theme)} alt="" width={24} height={24} aria-hidden="true" />}
            <span className="boring-project-name" title={v.team.name}>{v.team.name}</span>
            {!open && badge(m.totalNeedsYou, m.projectErr)}
          </button>
          {isMain && <button type="button" className="boring-main-open" data-testid="boring-main-open" title={`Open ${v.team.name}'s Buddy chat`} aria-label={`Open ${v.team.name} Buddy chat`} onClick={() => pickCore("_riffbot", m.core.riffbot.agentId, v.team.id)}>Open</button>}
          <button type="button" className="boring-row-menu-btn" data-testid={`boring-project-menu-${v.team.id}`} aria-haspopup="menu" aria-label={`${v.team.name} actions`} title="Project actions" onClick={(e) => openContextMenu(e, teamCtxItems(v, { folders }))}>⋯</button>
          {active && (
            <button type="button" className="boring-lane-add" data-testid="boring-new-conv-btn" title="New lane" aria-label="New lane" onClick={onAddBuddy}>+ lane</button>
          )}
        </div>
        {open && projectLanes(v, m)}
      </div>
    );
  };

  return (
    <div className="boring-app" data-testid="boring-app" data-squad-state={squadState}>
      {removingPin && <RemoveTeamDialog pin={removingPin.pin} displayName={removingPin.name} noun="lane" returnTo={removingPin.returnTo} onClose={() => setRemovingPin(null)} />}
      <aside className="boring-sidebar" data-testid="boring-sidebar">
        <div className="boring-sidebar-head" data-testid="boring-sidebar-head">
          <span className="boring-sidebar-title" data-testid="boring-sidebar-title">{APP_NAME}</span>
          <button type="button" className="boring-search-trigger" data-testid="boring-sidebar-search-btn" title="Command palette (Ctrl+K)" aria-label="Search: open command palette (Ctrl+K)" onClick={() => openOverlay("palette")}>
            <span aria-hidden="true">⌕</span><span>Search</span><kbd className="boring-kbd">Ctrl+K</kbd>
          </button>
        </div>
        <button type="button" className={`boring-decision-nav${mode === "decisions" ? " on" : ""}`} data-testid="boring-decisions-nav" onClick={() => setMode("decisions")}>
          <span className="boring-decision-nav-label">Decisions</span>
          <span className="boring-decision-nav-count" data-testid="boring-decisions-nav-count">{`· ${decisionCount}`}</span>
        </button>
        <BoringInbox views={awakeViews} onOpen={openNeedsYou} now={now} />
        <div className="boring-section-head" data-testid="boring-projects-head">
          <span className="boring-section-label">Projects</span>
          <button type="button" className="boring-icon-btn" data-testid="boring-new-project-btn" title="New project" aria-label="New project" onClick={onNewSquad}>+</button>
        </div>
        {mainV && <div className="boring-main-pin" data-testid="boring-main-pin">{renderProject(mainV, true)}</div>}
        <div className="boring-project-tree" data-testid="boring-project-tree">
          {partition.activeViews.map((v) => renderProject(v))}
          {partition.folderGroups.map((g) => {
            const slug = folderSlug(g.folder.name);
            const fOpen = openFolders[g.folder.name] === true;
            const asleep = g.folder.asleep;
            return (
              <div key={`folder:${g.folder.name}`} className={`boring-folder${fOpen ? " open" : ""}${asleep ? " asleep" : ""}`} data-testid={`boring-folder-${slug}`}>
                <div className="boring-conv-line boring-folder-line" onContextMenu={(e) => openContextMenu(e, folderCtxItems(g.folder))}>
                  <button type="button" className="boring-folder-row" data-testid={`boring-folder-row-${slug}`} aria-expanded={fOpen} onClick={() => toggleFolder(g.folder.name)}>
                    <span className="boring-chevron-btn" aria-hidden="true">{fOpen ? "▾" : "▸"}</span>
                    <span className="boring-folder-dot-spacer" aria-hidden="true" />
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
                    {g.views.map((v) => renderProject(v))}
                    {g.views.length === 0 && <p className="boring-muted">No projects.</p>}
                  </div>
                )}
              </div>
            );
          })}
          {views.length === 0 && !view && !mainV && <span className="boring-project-name">No project</span>}
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
        <div className="boring-sky" data-testid="boring-sky" aria-hidden="true">
          <i className="boring-sky-dusk" />
          <i className="boring-sky-glow" />
          <i className="boring-sky-grain" />
        </div>
        {banners}
        <header className="boring-topbar" data-testid="boring-topbar">
          <div className="boring-topbar-lead">
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
            {view && storybookPresent && <ProjectTabs projectId={view.team.id} name={view.team.name} active="code" />}
          </div>
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
            {/* Last, so it stays put when Split/Details appear with an open agent (UX R26 n1). */}
            {view && <CrunchToggle key={view.team.id} teamId={view.team.id} variant="boring" />}
          </div>
        </header>
        {view && activeAsleep && (
          <div className="boring-asleep-bar" data-testid="boring-asleep-bar" role="status">
            <span>Asleep · Automated wake-ups paused</span>
            <button type="button" className="boring-asleep-wake" data-testid="boring-asleep-wake-btn" title={`Move ${view.team.name} out of ${view.team.folder ?? "its folder"} to Active (other projects in ${view.team.folder ?? "it"} stay asleep)`} onClick={() => { const prev = view.team.folder; void folderOp({ op: "setTeamFolder", teamId: view.team.id, folder: null }).then((ok) => { if (ok) setLastFolder(view.team.id, prev ?? null); }); }}>Wake project</button>
          </div>
        )}
        {opening && (
          <div className="boring-opening" data-testid="boring-opening" role="status">Opening agent…</div>
        )}
        {!opening && mode === "decisions" && (
          <div className="boring-dashboard-wrap boring-decision-wrap" data-testid="boring-decisions-view">
            <BoringDecisionDesk views={awakeViews} now={now} onOpenAgent={openAgentIn} onOpenProject={(id) => { onSelectSquad(id); setMode("project"); }} />
          </div>
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
                    // B14b: Art14 canon mini-busts for the Brainstorm/Lead cells (mirrors bustRoleForAgent: Desk = RiffBot/Overlord, Bugs = Bugs, lane = Buddy/Lead).
                    const bust: { bs: BustRole; ld: BustRole } = r.laneId === "_desk" ? { bs: "riffbot", ld: "overlord" } : r.laneId === "_bugs" ? { bs: "bugs", ld: "bugs" } : { bs: "buddy", ld: "lead" };
                    // The Bugs lane has no separate Brainstorm role: the row itself is the Bugs mascot, so its bust always
                    // renders with a real working/idle/needs-you cue (never hollow). Other hollows mean "no agent in that role".
                    const bustCell = (role: BustRole, status: string, always: boolean) => {
                      const live = always ? r.running > 0 : status === "running";
                      if (!always && (status === "—" || status === "none")) return <><span className="boring-lane-mini none" aria-hidden="true" /><span className="boring-lane-stat">—</span></>;
                      const text = always && (status === "—" || status === "none") ? (r.needsYou > 0 ? "needs you" : live ? "running" : "idle") : (status === "—" || status === "none" ? "—" : status);
                      const state = status === "error" ? "err" : r.needsYou > 0 ? "attn" : live ? "run" : "idle";
                      return <><span className={`boring-lane-mini ${state}${live ? " lit" : ""}`} aria-hidden="true"><img className="boring-bust-img" src={bustUrl(role, theme)} alt="" width={22} height={22} /></span><span className="boring-lane-stat">{text}</span></>;
                    };
                    return (
                      <tr key={r.key} className={`boring-lane-row${r.needsYou > 0 ? " attn" : ""}${r.kind === "desk" ? " desk" : ""}`} data-testid={`boring-lane-row-${r.laneId}`}>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("brainstorm")}>
                          <span className={`boring-dot ${r.running > 0 ? "running" : r.brainstorm} ${glyphCls(r.running > 0 ? "running" : r.brainstorm, r.needsYou > 0 ? "needs-you" : null)}`} />
                          <span className="boring-row-label boring-lane-name" title={r.topicLabel || undefined}>{r.label}</span>{r.code && <code className="boring-lane-code">{r.code}</code>}
                          {r.needsYou > 0 && <span className="badge boring-badge">Needs you · {r.needsYou}</span>}
                        </button></td>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("brainstorm")}>{bustCell(bust.bs, r.brainstorm, r.laneId === "_bugs")}</button></td>
                        <td><button type="button" className="boring-lane-cell" onClick={() => go("lead")}>{bustCell(bust.ld, r.lead, false)}</button></td>
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
            {panes.split && !dormantSlot ? splitPanes : agent ? <AgentDrawer key={agent.id} agent={agent} onClose={() => setMode("project")} onSuccessor={() => onSuccessor(agent.id)} active pinDecisions /> : panelPin ? (
              // idea-468: a lane (or the Desk) with only workers has no agent to host the drawer, but its Workers fold must still open the panel.
              // The panel matches workers/feed by the REAL lane id (Bugs and the hub use sentinel selection ids), hence panelPin.lane.id.
              <div data-testid="boring-lane-no-agent" style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}><div className="boring-agent-header" data-testid="boring-lane-no-agent-head"><span><strong>{laneLabel ?? "Lane"}</strong><span className="muted"> · {emptyKind === "overlord" || emptyKind === "riffbot" ? "no Overlord or RiffBot running" : currentPin && isLive(currentPin.lead) ? `Lead ${leadStatus === "running" ? "working" : "idle"} · no Brainstorm` : currentPin && isLive(currentPin.brainstorm) ? "Brainstorm ready · no Lead" : "no Lead or Brainstorm running"}</span></span></div><div className="drawer-shell"><div style={{ flex: "1 1 0", minWidth: 0, display: "flex" }}>{emptyCard()}</div><TimelineErrorBoundary fallbackLabel="context panel"><BoringContextPanel key={panelPin.lane.id} entries={[]} teamId={activeTeamId} laneId={panelPin.lane.id} noAgentAction={noAgentAction()} /></TimelineErrorBoundary></div></div>
            ) : emptyCard()}
          </div>
        )}
      </main>
      {children}
    </div>
  );
}
