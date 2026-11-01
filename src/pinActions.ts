// Pinned teams step 3 (docs/PLAN_PINNED_FEATURES.md §3): the side-effecting half of the pin resolver.
// src/pins.ts stays pure; this file talks to the dev-server middleware and the teams store.
import type { PaseoAgent } from "@getpaseo/client";
import { DEMO, archiveAgent, getPaseoState, retireAgent, sendMessage, upsertLocalAgent } from "./paseo";
import { parkIdeasInInbox } from "./IdeaInbox";
import {
  allLaneIds,
  appendBriefLine,
  bestOverlap,
  briefStamp,
  DEFAULT_PIN_PROFILE,
  newPinBrief,
  patchLane,
  resolvePin,
  slugLaneId,
  uniqueLaneId,
  type Pin,
  type PinLane,
} from "./pins";
import { runMarkComplete } from "./pinComplete";
import { findCrossTeamBrainstorm, getTeams, resolve, saveTeams, type TeamDef } from "./teams";

export type OpenPinDeps = {
  /** Agent map to re-check for a live Brainstorm before spawning (defaults to the live Paseo state). */
  agents?: Map<string, PaseoAgent>;
  fetch?: typeof fetch;
  getTeams?: () => TeamDef[];
  saveTeams?: (next: TeamDef[]) => Promise<unknown>;
  /** Called with the spawned agent so the caller can show it before the daemon pushes it (defaults to upsertLocalAgent). */
  onSpawned?: (agent: PaseoAgent) => void;
};

const inFlight = new Map<string, Promise<string>>();
const startListeners = new Set<() => void>();
const laneKey = (squadId: string, laneId: string) => `${squadId}:${laneId}`.toLowerCase();

/** True while a quick start for this pin is running (tiles can show "Starting…"). */
export const isPinStarting = (pin: Pin): boolean => inFlight.has(laneKey(pin.squad.id, pin.lane.id));

export function subscribePinStarts(l: () => void): () => void {
  startListeners.add(l);
  return () => startListeners.delete(l);
}

/**
 * Resolve a pin to the agent id to focus. A live Brainstorm opens as is. Otherwise a fresh one is
 * quick-started in (squad, lane) from the team brief and newest plan, with no dialog, and its id
 * is returned. Concurrent calls for the same lane share one spawn.
 */
export function openPin(pin: Pin, deps: OpenPinDeps = {}): Promise<string> {
  const r = resolvePin(pin);
  if (r.kind === "live") return Promise.resolve(r.agent.agent.id);
  const key = laneKey(r.squadId, r.laneId);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = quickStart(pin, r.profile ?? DEFAULT_PIN_PROFILE, deps).finally(() => {
    inFlight.delete(key);
    startListeners.forEach((l) => l());
  });
  inFlight.set(key, run);
  startListeners.forEach((l) => l());
  return run;
}

async function quickStart(pin: Pin, profile: string, deps: OpenPinDeps): Promise<string> {
  const squadId = pin.squad.id;
  const laneId = pin.lane.id;
  // A live Brainstorm may have appeared since the pin was built (another tab, the lead, a slow push).
  const live = findCrossTeamBrainstorm(resolve(deps.agents ?? getPaseoState().agents), laneId);
  if (live) return live.agent.id;

  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch("/__vibesquad/brainstorm-restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reason: "start-brainstorm",
      mode: "quick-start",
      teamId: squadId,
      laneId,
      laneName: pin.lane.name,
      profile,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    reused?: boolean;
    newAgentId?: string;
    existingAgentId?: string;
    profile?: string;
    agent?: PaseoAgent;
  };
  if (!res.ok && !DEMO) throw new Error(body.error ?? `Quick start failed (${res.status})`);
  if (body.reused && (body.existingAgentId || body.newAgentId)) return String(body.existingAgentId || body.newAgentId);

  const newAgentId = body.newAgentId || `demo-bs-${laneId}-${Date.now().toString(36)}`;
  const agent =
    body.agent ??
    ({
      id: newAgentId,
      title: `BRAINSTORM · ${pin.lane.name.toUpperCase()}`,
      provider: "claude",
      model: "claude-opus-5-5",
      cwd: "",
      status: "idle",
      updatedAt: new Date().toISOString(),
      lastUsage: { contextWindowUsedTokens: 0, inputTokens: 0 },
      labels: {
        team: squadId,
        lane: laneId,
        lead: laneId,
        role: "brainstorm",
        profile,
        "vs.restarted-from": "start-brainstorm",
        "vs.fresh-session": "brief",
      },
    } as unknown as PaseoAgent);
  (deps.onSpawned ?? upsertLocalAgent)(agent);

  const used = body.profile || profile;
  if (used !== pin.lane.lastProfile) {
    const teams = (deps.getTeams ?? getTeams)();
    await (deps.saveTeams ?? saveTeams)(patchLane(teams, squadId, laneId, { lastProfile: used }));
  }
  return newAgentId;
}

/** Rename a pinned team (display name only; the lane id and labels stay). */
export async function renamePin(pin: Pin, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean || clean === pin.lane.name) return;
  await saveTeams(patchLane(getTeams(), pin.squad.id, pin.lane.id, { name: clean }));
}

// ── Brief editor bus ───────────────────────────────────────────────────────────
// The pin ⋯ menu and the drawer's "Fresh session · from brief ⋯" divider both open the same
// editor. They call openBriefEditor(); <BriefEditorHost/> (mounted once) renders the modal.

export type BriefTarget = { squadId?: string; laneId: string; laneName?: string };
const BRIEF_EVENT = "vs:open-brief";

export function openBriefEditor(target: BriefTarget): void {
  window.dispatchEvent(new CustomEvent<BriefTarget>(BRIEF_EVENT, { detail: target }));
}

export function onOpenBriefEditor(fn: (t: BriefTarget) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<BriefTarget>).detail);
  window.addEventListener(BRIEF_EVENT, h);
  return () => window.removeEventListener(BRIEF_EVENT, h);
}

// ── Step 5: Mark complete / Reopen (docs/PLAN_PINNED_FEATURES.md §4) ──────────
// Only a click in the UI calls these. Agents never complete a team: there is no route or CLI for it.

async function readBrief(laneId: string, doFetch: typeof fetch): Promise<string> {
  const url = `/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(laneId)}`;
  const cur = (await (await doFetch(url)).json().catch(() => ({}))) as { ok?: boolean; content?: string; error?: string };
  if (!cur.ok) throw new Error(cur.error ?? "Could not read the brief");
  return String(cur.content ?? "");
}

async function writeBrief(laneId: string, content: string, doFetch: typeof fetch): Promise<void> {
  const res = await doFetch("/__vibesquad/brainstorm-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ laneId, content }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Brief save failed (${res.status})`);
}

async function appendToBrief(laneId: string, line: string, doFetch: typeof fetch): Promise<void> {
  await writeBrief(laneId, appendBriefLine(await readBrief(laneId, doFetch), line), doFetch);
}

export type CompleteDeps = Pick<OpenPinDeps, "fetch" | "getTeams" | "saveTeams"> & {
  retire?: typeof retireAgent;
  archive?: (id: string) => Promise<unknown>;
};

/**
 * Move a pin to the Done shelf: refuse while workers run or permissions are open, write
 * "Done <date>" into the brief, retire the live Brainstorm (former-brainstorm, archived like the
 * plugin's retirePredecessors) and the Lead (former-lead), then set state=done + doneAt.
 * Returns the blocker text instead of completing when the team is still busy. Safe to retry
 * after a failure (src/pinComplete.ts).
 */
export function markPinComplete(pin: Pin, deps: CompleteDeps = {}): Promise<{ ok: true } | { ok: false; blocked: string }> {
  const doFetch = deps.fetch ?? fetch;
  return runMarkComplete(pin, {
    readBrief: (laneId) => readBrief(laneId, doFetch),
    writeBrief: (laneId, content) => writeBrief(laneId, content, doFetch),
    retire: deps.retire ?? retireAgent,
    archive: deps.archive ?? archiveAgent,
    getTeams: deps.getTeams ?? getTeams,
    saveTeams: deps.saveTeams ?? saveTeams,
    skipBrief: DEMO,
  });
}

/** Put a done team back on the pins. The next click quick-starts a Brainstorm from the same brief (openPin). */
export async function reopenPin(pin: Pin, deps: Pick<CompleteDeps, "fetch" | "getTeams" | "saveTeams"> = {}): Promise<void> {
  await (deps.saveTeams ?? saveTeams)(
    patchLane((deps.getTeams ?? getTeams)(), pin.squad.id, pin.lane.id, { state: "pinned", doneAt: undefined }),
  );
  if (!DEMO) await appendToBrief(pin.lane.id, `Reopened ${briefStamp()}`, deps.fetch ?? fetch).catch(() => {});
}

// ── "Looks done" card dismissals (per Brainstorm message id) ──────────────────
const LOOKS_DONE_KEY = "vibesquad.looksDoneDismissed";

function dismissedSet(key = LOOKS_DONE_KEY): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export const isLooksDoneDismissed = (messageId: string): boolean => dismissedSet().has(messageId);

function dismiss(key: string, messageId: string): void {
  // Keep the newest 200 ids so the key cannot grow without bound.
  const ids = [...dismissedSet(key), messageId].slice(-200);
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {}
}

export const dismissLooksDone = (messageId: string): void => dismiss(LOOKS_DONE_KEY, messageId);

// ── Step 6: idea capture (docs/PLAN_PINNED_FEATURES.md §5) ────────────────────
// A new pin is a lane in teams.json plus a brief; no agent is spawned. The first click on the pin
// quick-starts its Brainstorm (openPin), so idle pins cost nothing.

export type CreatePinDeps = Pick<OpenPinDeps, "fetch" | "getTeams" | "saveTeams">;

/** The pinned team an idea most likely belongs to in this squad, or null ("Sounds like X. Use it?"). */
export function overlappingPin(squadId: string, text: string, teams: TeamDef[] = getTeams()): PinLane | null {
  const squad = teams.find((t) => t.id === squadId);
  return squad ? (bestOverlap(text, squad.lanes as PinLane[])?.lane ?? null) : null;
}

/** Add a pinned team to a squad and write its brief with the idea under Open. Returns the (session-less) pin. */
export async function createPin(squadId: string, name: string, idea: string, deps: CreatePinDeps = {}): Promise<Pin> {
  const clean = name.trim();
  if (!clean) throw new Error("A team needs a name");
  const teams = (deps.getTeams ?? getTeams)();
  const squad = teams.find((t) => t.id === squadId);
  if (!squad) throw new Error(`Unknown squad ${squadId}`);
  const lane: PinLane = { id: uniqueLaneId(slugLaneId(clean), allLaneIds(teams)), name: clean, state: "pinned" };
  // Brief first: a failed write leaves no half-made pin behind.
  if (!DEMO) await writeBrief(lane.id, newPinBrief(lane.id, clean, idea), deps.fetch ?? fetch);
  const next = teams.map((t) => (t.id === squadId ? { ...t, lanes: [...t.lanes, lane] } : t));
  await (deps.saveTeams ?? saveTeams)(next);
  return {
    squad: next.find((t) => t.id === squadId)!,
    lane,
    state: "pinned",
    order: squad.lanes.length,
    brainstorm: null,
    lead: null,
    workers: [],
    needsYou: 0,
    running: 0,
    contextUsed: 0,
    topicBrainstorms: [],
  };
}

export type SendIdeaDeps = {
  agents?: Map<string, PaseoAgent>;
  getTeams?: () => TeamDef[];
  send?: (agentId: string, text: string) => Promise<unknown>;
  park?: typeof parkIdeasInInbox;
};

/**
 * Hand an idea to another team: its live Brainstorm gets it as a message (Paseo queues it if busy),
 * otherwise it is parked in that team's inbox. An unknown lane parks unassigned. Returns the toast text.
 */
export async function sendIdeaToTeam(laneId: string, text: string, from?: string, deps: SendIdeaDeps = {}): Promise<string> {
  const idea = text.trim();
  if (!idea) throw new Error("Nothing to send");
  const teams = (deps.getTeams ?? getTeams)();
  const squad = teams.find((t) => t.lanes.some((l) => l.id.toLowerCase() === laneId.toLowerCase()));
  const lane = squad?.lanes.find((l) => l.id.toLowerCase() === laneId.toLowerCase());
  const park = deps.park ?? parkIdeasInInbox;
  if (!squad || !lane) {
    await park({ ideas: [idea], source: "misroute" });
    return "Parked in the inbox";
  }
  const live = findCrossTeamBrainstorm(resolve(deps.agents ?? getPaseoState().agents), lane.id);
  if (live) {
    await (deps.send ?? sendMessage)(live.agent.id, from ? `Idea sent over from ${from}:\n\n${idea}` : idea);
    return `Sent to ${lane.name}`;
  }
  await park({ ideas: [idea], laneId: lane.id, teamId: squad.id, source: "misroute" });
  return `Parked in ${lane.name}${/s$/i.test(lane.name) ? "'" : "'s"} inbox`;
}

const SEND_TO_KEY = "vibesquad.sendToDismissed";
export const isSendToDismissed = (messageId: string): boolean => dismissedSet(SEND_TO_KEY).has(messageId);
export const dismissSendTo = (messageId: string): void => dismiss(SEND_TO_KEY, messageId);
