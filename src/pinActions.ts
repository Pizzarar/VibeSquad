// Pinned teams step 3 (docs/PLAN_PINNED_FEATURES.md §3): the side-effecting half of the pin resolver.
// src/pins.ts stays pure; this file talks to the dev-server middleware and the teams store.
import type { PaseoAgent } from "./agentTypes";
import { archiveAgent, archiveWorkspace, detachAgent, getPaseoState, retireAgent, sendMessage, updateAgent, upsertLocalAgent } from "./paseo";
import { DEMO } from "./demoFlag";
import { canonicalCardId } from "../server/pin-ideas.mjs";
import { parkIdeasInInbox } from "./IdeaInbox";
import { isRemote } from "./remoteSession";
import {
  allLaneIds,
  appendBriefLine,
  bestOverlap,
  isContentLine,
  keepBuddy,
  briefStamp,
  DEFAULT_PIN_PROFILE,
  newPinBrief,
  patchLane,
  resolvePin,
  runSpinOffOnce,
  slugLaneId,
  uniqueLaneId,
  type Pin,
  type PinLane,
} from "./pins";
import { freezeLaneCodes, laneCodesForTeam } from "./identity";
import { runMarkComplete } from "./pinComplete";
import { runRemoveTeam, type RemovePlan, type RemoveResult, type WorktreeResult } from "./pinRemoveLogic";
import { findCrossTeamBrainstorm, getTeams, resolve, saveTeams, titleFor, type TeamDef, type TeamsUpdater } from "./teams";

export { DEFAULT_PIN_PROFILE } from "./pins";

export type OpenPinDeps = {
  /** Agent map to re-check for a live Brainstorm before spawning (defaults to the live Paseo state). */
  agents?: Map<string, PaseoAgent>;
  fetch?: typeof fetch;
  getTeams?: () => TeamDef[];
  /** Takes an updater, re-run on the fresh registry if someone else wrote it first. */
  saveTeams?: (update: TeamsUpdater) => Promise<unknown>;
  /** Called with the spawned agent so the caller can show it before the daemon pushes it (defaults to upsertLocalAgent). */
  onSpawned?: (agent: PaseoAgent) => void;
  /** Explicit Brainstorm profile chosen by the user at Spin Up. */
  profile?: string;
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
export function openPin(pin: Pin, depsOrProfile: OpenPinDeps | string = {}): Promise<string> {
  const deps: OpenPinDeps = typeof depsOrProfile === "string" ? { profile: depsOrProfile } : depsOrProfile;
  const r = resolvePin(pin);
  if (r.kind === "live") return Promise.resolve(r.agent.agent.id);
  const key = laneKey(r.squadId, r.laneId);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const chosenProfile = deps.profile?.trim() || r.profile || pin.lane?.lastProfile || DEFAULT_PIN_PROFILE;
  const run = quickStart(pin, chosenProfile, deps).finally(() => {
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
  const live = findCrossTeamBrainstorm(resolve(deps.agents ?? getPaseoState().agents), laneId, "");
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
      // Send `profileName` so remote relay body policy accepts it while `profile` stays in REMOTE_FORBIDDEN_BODY_KEYS.
      ...(profile ? { profileName: profile } : {}),
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
  if ((!res.ok || body.ok === false) && !DEMO) throw new Error(body.error ?? `Quick start failed (${res.status})`);
  if (body.reused && (body.existingAgentId || body.newAgentId)) {
    const reusedId = String(body.existingAgentId || body.newAgentId);
    // Show it: a reopened or just-spawned Buddy may not be in local state yet, so the pick would land on nothing.
    if (body.agent?.id === reusedId) (deps.onSpawned ?? upsertLocalAgent)(body.agent);
    return reusedId;
  }

  const newAgentId = body.newAgentId || `demo-bs-${laneId}-${Date.now().toString(36)}`;
  const agent =
    body.agent ??
    ({
      id: newAgentId,
      title: titleFor("brainstorm", pin.lane.name, { laneId: pin.lane.id }),
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
  // lastProfile is pinned to disk for remote writes (PINNED_LANE_KEYS), so only a local session records it.
  if (!isRemote() && used !== pin.lane.lastProfile) {
    await (deps.saveTeams ?? saveTeams)((cur) => patchLane(cur, squadId, laneId, { lastProfile: used }));
  }
  return newAgentId;
}

/** Persist a code on every lane of one Squad that lacks one. */
export function freezeSquadCodes(teams: TeamDef[], squadId: string): TeamDef[] {
  return teams.map((t) => (t.id === squadId ? { ...t, lanes: freezeLaneCodes(t.lanes) } : t));
}

/** Rename a pinned team (display name only; the lane id and labels stay). */
export async function renamePin(pin: Pin, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean || clean === pin.lane.name) return;
  // Freeze codes first so the rename can never change this lane's (or a sibling's) generated code.
  await saveTeams((cur) => patchLane(freezeSquadCodes(cur, pin.squad.id), pin.squad.id, pin.lane.id, { name: clean }));
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

const lastBriefRevision = new Map<string, string>();

export function capBriefForSave(content: string, maxChars = 19_500): string {
  if (content.length <= maxChars) return content;
  const sep = "\n\n… [trimmed for length] …\n\n";
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.max(0, maxChars - headLen - 32);
  return content.slice(0, headLen) + sep + content.slice(content.length - tailLen);
}

async function readBrief(laneId: string, doFetch: typeof fetch, teamId?: string): Promise<string> {
  const url = `/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(laneId)}${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""}`;
  const cur = (await (await doFetch(url)).json().catch(() => ({}))) as { ok?: boolean; content?: string; revision?: string; error?: string };
  if (!cur.ok) throw new Error(cur.error ?? "Could not read the brief");
  if (typeof cur.revision === "string") lastBriefRevision.set(laneId, cur.revision);
  return String(cur.content ?? "");
}

// teamId: the Squad id, so the server finds the project folder before the lane is in teams.json. Returns true when the server fell back to its runtime folder.
async function writeBrief(laneId: string, content: string, doFetch: typeof fetch, revision = lastBriefRevision.get(laneId), teamId?: string): Promise<boolean> {
  const capped = content.length >= 20_000 || content.length > 19_500 ? capBriefForSave(content) : content;
  const res = await doFetch("/__vibesquad/brainstorm-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ laneId, content: capped, ...(revision ? { revision } : {}), ...(teamId ? { teamId } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; revision?: string; error?: string; fallback?: boolean };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Brief save failed (${res.status})`);
  if (typeof body.revision === "string") lastBriefRevision.set(laneId, body.revision);
  return body.fallback === true;
}

async function appendToBrief(laneId: string, line: string, doFetch: typeof fetch): Promise<void> {
  await writeBrief(laneId, appendBriefLine(await readBrief(laneId, doFetch), line), doFetch);
}

export type CompleteDeps = Pick<OpenPinDeps, "fetch" | "saveTeams"> & {
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
    writeBrief: (laneId, content) => writeBrief(laneId, content, doFetch).then(() => {}),
    retire: deps.retire ?? retireAgent,
    archive: deps.archive ?? archiveAgent,
    saveTeams: deps.saveTeams ?? saveTeams,
    skipBrief: DEMO,
  });
}

/** Put a done team back on the pins. The next click quick-starts a Brainstorm from the same brief (openPin). */
export async function reopenPin(pin: Pin, deps: Pick<CompleteDeps, "fetch" | "saveTeams"> = {}): Promise<void> {
  await (deps.saveTeams ?? saveTeams)((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { state: "pinned", doneAt: undefined }));
  if (!DEMO) await appendToBrief(pin.lane.id, `Reopened ${briefStamp()}`, deps.fetch ?? fetch).catch(() => {});
}

// ── Duplicate Buddies (docs/PLAN_BUGS_BATCH2.md block 0) ──────────────────────

const PARENT_LABEL = "vs.parent";

/** "Keep this one": retire the pin's other live Buddies (no archive). Their live children are detached first. */
export function keepPinBuddy(pin: Pin, keepId: string): Promise<{ retired: string[]; failed: string[] }> {
  return keepBuddy(pin, keepId, {
    detachChildren: async (buddyId) => {
      for (const a of getPaseoState().agents.values()) {
        if (a.archivedAt || a.status === "closed" || (a.labels as Record<string, string> | undefined)?.[PARENT_LABEL] !== buddyId) continue;
        await detachAgent(a.id);
      }
    },
    update: (id, updates) => updateAgent(id, updates),
  });
}

// ── Remove team (docs/PLAN_BUGS_BATCH1.md block 1) ────────────────────────────
// Only the Team ⋯ menu's confirm dialog calls this; there is no route or CLI to remove a team.

export type RemoveDeps = Pick<CompleteDeps, "fetch" | "saveTeams" | "archive"> & { archiveWorkspace?: (id: string) => Promise<unknown> };

/** Archive the team's agents, hide the lane (state removed) and, when opted in, delete its worktrees + branches. */
export function removePin(pin: Pin, plan: RemovePlan, opts: { deleteWorktrees: boolean }, deps: RemoveDeps = {}): Promise<RemoveResult> {
  const doFetch = deps.fetch ?? fetch;
  return runRemoveTeam(pin, plan, opts, {
    archive: deps.archive ?? archiveAgent,
    saveTeams: deps.saveTeams ?? saveTeams,
    ...(DEMO ? {} : { readBrief: (laneId: string) => readBrief(laneId, doFetch), writeBrief: (laneId: string, c: string) => writeBrief(laneId, c, doFetch).then(() => {}) }),
    removeWorktrees: async (worktrees) => {
      if (DEMO) return worktrees.map((w) => ({ ...w, worktree: "removed" as const, branchResult: "deleted" }));
      const res = await doFetch("/__vibesquad/remove-team-worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktrees }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; results?: WorktreeResult[] };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Worktree removal failed (${res.status})`);
      return body.results ?? [];
    },
    archiveWorkspace: deps.archiveWorkspace ?? archiveWorkspace,
  });
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

// Dismissed cards also live on the server (settings.json `dismissedCards`, newest 500) so every device hides a card
// once any device acted on it. localStorage stays as the offline cache; the two are merged on read.
const DISMISS_KEYS = [LOOKS_DONE_KEY, "vibesquad.sendToDismissed", "vibesquad.spinOffDismissed", "vibesquad.decisionDismissed"];
const SETTINGS_URL = "/__vibesquad/settings";
let serverDismissed = new Set<string>();
let dismissedLoad: Promise<void> | null = null;
let dismissedVer = 0;
const dismissedListeners = new Set<() => void>();
const bumpDismissed = () => {
  dismissedVer++;
  dismissedListeners.forEach((l) => l());
};
export const subscribeDismissed = (l: () => void): (() => void) => {
  dismissedListeners.add(l);
  return () => dismissedListeners.delete(l);
};
export const dismissedVersion = (): number => dismissedVer;

// Every dismissed id (this device's localStorage + the server list), raw and canonicalized once, so a render is an O(1)
// lookup instead of a scan. Rebuilt lazily after any change (merge, dismiss, another tab's localStorage write).
let known: Set<string> | null = null;
const knownIds = (): Set<string> => {
  if (known) return known;
  known = new Set<string>();
  for (const id of [...DISMISS_KEYS.flatMap((k) => [...dismissedSet(k)]), ...serverDismissed]) {
    known.add(id);
    known.add(canonicalCardId(id));
  }
  return known;
};
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", () => {
    known = null;
    bumpDismissed();
  });
}

function mergeServerDismissed(body: { dismissedCards?: unknown } | null): void {
  const ids = Array.isArray(body?.dismissedCards) ? (body!.dismissedCards as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const before = serverDismissed.size;
  for (const id of ids) serverDismissed.add(id);
  if (serverDismissed.size !== before) {
    known = null;
    bumpDismissed();
  }
}

async function postDismissed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const res = await fetch(SETTINGS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dismissedCards: ids }) });
    if (res.ok) mergeServerDismissed((await res.json().catch(() => null)) as { dismissedCards?: unknown } | null);
  } catch {
    // offline: the localStorage copy keeps it hidden here, and the next load pushes it up
  }
}

/** Fetch the shared list once (and push up any ids only this device knows). Safe to call repeatedly. */
export function loadDismissedCards(): Promise<void> {
  if (DEMO) return Promise.resolve();
  watchDismissedRefresh();
  dismissedLoad ??= (async () => {
    try {
      lastDismissedFetch = Date.now();
      const res = await fetch(SETTINGS_URL);
      if (!res.ok) throw new Error(String(res.status));
      mergeServerDismissed((await res.json()) as { dismissedCards?: unknown });
      const local = DISMISS_KEYS.flatMap((k) => [...dismissedSet(k)]);
      await postDismissed(local.filter((id) => !serverDismissed.has(id)));
    } catch {
      dismissedLoad = null; // retry on the next read
    }
  })();
  return dismissedLoad;
}

// The load above is once per tab, so a card fired or dismissed on another tab/device (or by a tab on an older bundle)
// would never reach this one. Re-read the list when the tab is focused again or a Buddy timeline opens.
let lastDismissedFetch = 0;
let refreshWatched = false;
export async function refreshDismissedCards(minGapMs = 5000): Promise<void> {
  if (DEMO) return;
  await loadDismissedCards(); // first call: the initial load is the fetch
  if (Date.now() - lastDismissedFetch < minGapMs) return;
  lastDismissedFetch = Date.now();
  try {
    const res = await fetch(SETTINGS_URL);
    if (res.ok) mergeServerDismissed((await res.json()) as { dismissedCards?: unknown });
  } catch {
    // offline: keep what we have
  }
}
function watchDismissedRefresh(): void {
  if (refreshWatched || typeof window === "undefined" || typeof document === "undefined") return;
  refreshWatched = true;
  const onBack = () => {
    if (!document.hidden) void refreshDismissedCards();
  };
  window.addEventListener("focus", onBack);
  document.addEventListener("visibilitychange", onBack);
}

/** Test hook: forget the in-memory server list, as a freshly opened client would. */
export function resetDismissedCards(): void {
  serverDismissed = new Set();
  dismissedLoad = null;
  dismissedVer = 0;
  lastDismissedFetch = 0;
  known = null;
}

/** `legacyIds`: the pre-D1 `${agentId}:${messageId}` ids of this card, still written by a tab on an old bundle. */
function isDismissed(_key: string, id: string, legacyIds: string[] = []): boolean {
  void loadDismissedCards();
  const ids = knownIds();
  return ids.has(id) || ids.has(canonicalCardId(id)) || legacyIds.some((l) => ids.has(l));
}

export const isLooksDoneDismissed = (messageId: string): boolean => isDismissed(LOOKS_DONE_KEY, messageId);

function dismiss(key: string, messageId: string): void {
  // Keep the newest 200 ids so the key cannot grow without bound.
  const ids = [...dismissedSet(key), messageId].slice(-200);
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {}
  serverDismissed.add(messageId);
  known = null;
  bumpDismissed();
  if (!DEMO) void postDismissed([messageId]);
}

export const dismissLooksDone = (messageId: string): void => dismiss(LOOKS_DONE_KEY, messageId);

// ── Step 6: idea capture (docs/PLAN_PINNED_FEATURES.md §5) ────────────────────
// A new pin is a lane in teams.json plus a brief; no agent is spawned. The first click on the pin
// quick-starts its Brainstorm (openPin), so idle pins cost nothing.

export const LAST_BS_PROFILE_KEY = "vibesquad.lastBrainstormProfile";

export function getLastBrainstormProfile(fallback = DEFAULT_PIN_PROFILE): string {
  try {
    return localStorage.getItem(LAST_BS_PROFILE_KEY) || fallback;
  } catch {
    return fallback;
  }
}

export function setLastBrainstormProfile(profile: string): void {
  try {
    localStorage.setItem(LAST_BS_PROFILE_KEY, profile);
  } catch {}
}

export type CreatePinDeps = Pick<OpenPinDeps, "fetch" | "getTeams" | "saveTeams" | "agents" | "onSpawned" | "profile"> & {
  lastProfile?: string;
  startBuddies?: boolean;
  /** Mark the created/reopened lane as a permanent standing team (`standing: true`). */
  standing?: boolean;
  /** Also point the Squad's `quickLanes[quickLane]` at the created/reopened lane id. */
  quickLane?: "bugs";
  /** Called when the server saved the brief in its runtime folder instead of the project's. */
  onBriefFallback?: (laneId: string) => void;
};

/** The pinned team an idea most likely belongs to in this squad, or null ("Sounds like X. Use it?"). */
export function overlappingPin(squadId: string, text: string, teams: TeamDef[] = getTeams()): PinLane | null {
  const squad = teams.find((t) => t.id === squadId);
  return squad ? (bestOverlap(text, squad.lanes as PinLane[])?.lane ?? null) : null;
}

/** Append an idea bullet to the `## Open` section of an existing brief, or return null when the brief has no `## Open`. */
export function appendIdeaToOpenSection(markdown: string, idea: string): string | null {
  const cleanIdea = idea.trim();
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const headIdx = lines.findIndex((l) => /^##\s+Open\b/i.test(l.trim()));
  if (headIdx < 0) return null;
  if (!cleanIdea) return lines.join("\n");
  const bullet = `- ${cleanIdea.replace(/\r?\n/g, "\n  ")}`;
  let endIdx = headIdx + 1;
  while (endIdx < lines.length && !/^##\s+/.test(lines[endIdx].trim())) endIdx++;
  for (let i = endIdx - 1; i > headIdx; i--) {
    const trimmed = lines[i].trim();
    if (trimmed && !isContentLine(trimmed)) {
      lines.splice(i, 1);
      endIdx--;
    }
  }
  while (endIdx > headIdx + 1 && !lines[endIdx - 1].trim()) endIdx--;
  lines.splice(endIdx, 0, bullet);
  return lines.join("\n");
}

/** Add a pinned team to a squad and write its brief with the idea under Open. Returns the (session-less) pin. */
export async function createPin(squadId: string, name: string, idea: string, deps: CreatePinDeps = {}): Promise<Pin> {
  const clean = name.trim();
  if (!clean) throw new Error("A team needs a name");
  const teams = (deps.getTeams ?? getTeams)();
  const squad = teams.find((t) => t.id === squadId);
  if (!squad) throw new Error(`Unknown squad ${squadId}`);
  const slug = slugLaneId(clean);
  const reopenTarget = (squad.lanes as PinLane[]).find(
    (l) =>
      (l.state === "done" || l.state === "removed") &&
      (l.id.toLowerCase() === slug || (l.name ?? "").toLowerCase() === clean.toLowerCase()),
  );
  // A live team with this name/id is the pin: a double-click or a re-pin after the first save must not mint `<slug>-2`.
  // Standing / quick-lane callers get the same lane, with their flags set on it if it lacks them.
  const liveSame = (squad.lanes as PinLane[]).find(
    (l) => l.state !== "done" && l.state !== "removed" && (l.id.toLowerCase() === slug || (l.name ?? "").toLowerCase() === clean.toLowerCase()),
  );
  if (liveSame) {
    let outSquad = squad;
    let outLane = liveSame;
    if ((deps.standing && !liveSame.standing) || (deps.quickLane && squad.quickLanes?.[deps.quickLane] !== liveSame.id)) {
      await (deps.saveTeams ?? saveTeams)((cur) =>
        (cur.map((t) => {
          if (t.id !== squadId) return t;
          const next = {
            ...t,
            lanes: t.lanes.map((l) => (l.id === liveSame.id && deps.standing ? { ...l, standing: true } : l)),
            ...(deps.quickLane ? { quickLanes: { ...t.quickLanes, [deps.quickLane]: liveSame.id } } : {}),
          };
          outSquad = next;
          outLane = (next.lanes as PinLane[]).find((l) => l.id === liveSame.id) ?? liveSame;
          return next;
        })),
      );
    }
    return {
      squad: outSquad,
      lane: outLane,
      state: "pinned",
      order: (outSquad.lanes as PinLane[]).findIndex((l) => l.id === liveSame.id),
      brainstorm: null,
      lead: null,
      workers: [],
      needsYou: 0,
      running: 0,
      contextUsed: 0,
      topicBrainstorms: [],
    };
  }
  const doFetch = deps.fetch ?? fetch;
  if (reopenTarget) {
    const code = reopenTarget.code || laneCodesForTeam({ lanes: squad.lanes })[reopenTarget.id];
    const reopenedLane: PinLane = {
      ...reopenTarget,
      id: reopenTarget.id,
      name: clean,
      ...(code ? { code } : {}),
      state: "pinned",
      doneAt: undefined,
      removedAt: undefined,
      ...(deps.standing ? { standing: true } : {}),
      ...(deps.lastProfile ? { lastProfile: deps.lastProfile } : {}),
    };
    if (!DEMO) {
      let updated: string | null = null;
      try {
        const existingBrief = await readBrief(reopenTarget.id, doFetch, squadId);
        updated = appendIdeaToOpenSection(existingBrief, idea);
      } catch {
        updated = null;
      }
      const fellBack = await writeBrief(reopenTarget.id, updated ?? newPinBrief(reopenTarget.id, clean, idea), doFetch, undefined, squadId);
      if (fellBack) deps.onBriefFallback?.(reopenTarget.id);
    }
    let next = teams;
    await (deps.saveTeams ?? saveTeams)((cur) =>
      (next = cur.map((t) =>
        t.id === squadId
          ? {
              ...t,
              lanes: freezeLaneCodes(t.lanes.map((l) => (l.id === reopenTarget.id ? reopenedLane : l))),
              ...(deps.quickLane ? { quickLanes: { ...t.quickLanes, [deps.quickLane]: reopenedLane.id } } : {}),
            }
          : t,
      )),
    );
    const updatedSquad = next.find((t) => t.id === squadId) ?? squad;
    const idx = updatedSquad.lanes.findIndex((l) => l.id === reopenTarget.id);
    return {
      squad: updatedSquad,
      lane: reopenedLane,
      state: "pinned",
      order: reopenTarget.order ?? (idx >= 0 ? idx : 0),
      brainstorm: null,
      lead: null,
      workers: [],
      needsYou: 0,
      running: 0,
      contextUsed: 0,
      topicBrainstorms: [],
    };
  }
  const id = uniqueLaneId(slug, allLaneIds(teams));
  // Freeze the generated code on the lane so later registry changes never rename its agents.
  const code = laneCodesForTeam({ lanes: [...squad.lanes, { id, name: clean }] })[id];
  const lane: PinLane = {
    id,
    name: clean,
    ...(code ? { code } : {}),
    state: "pinned",
    ...(deps.standing ? { standing: true } : {}),
    ...(deps.lastProfile ? { lastProfile: deps.lastProfile } : {}),
  };
  // Brief first: a failed write leaves no half-made pin behind.
  if (!DEMO && (await writeBrief(lane.id, newPinBrief(lane.id, clean, idea), doFetch, undefined, squadId))) deps.onBriefFallback?.(lane.id);
  // The brief write is async, so add the lane to whatever the registry holds by then.
  let next = teams;
  await (deps.saveTeams ?? saveTeams)((cur) =>
    (next = cur.map((t) =>
      t.id === squadId && !t.lanes.some((l) => l.id === lane.id)
        ? {
            ...t,
            lanes: freezeLaneCodes([...freezeLaneCodes(t.lanes), lane]),
            ...(deps.quickLane ? { quickLanes: { ...t.quickLanes, [deps.quickLane]: lane.id } } : {}),
          }
        : t,
    )),
  );
  return {
    squad: next.find((t) => t.id === squadId) ?? squad,
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

/** Create a Squad's standing Bugs team and record its id in `quickLanes.bugs` (docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md C1). */
export function createQuickBugsPin(squadId: string, deps: CreatePinDeps = {}): Promise<Pin> {
  return createPin(squadId, "Bugs", "Triage and fix bugs for this project.", {
    ...deps,
    standing: true,
    quickLane: "bugs",
  });
}

export type SendIdeaDeps = OpenPinDeps & {
  send?: (agentId: string, text: string) => Promise<unknown>;
  park?: typeof parkIdeasInInbox;
  openPin?: typeof openPin;
};

/**
 * Hand an idea to another team: its live Brainstorm gets it as a message (Paseo queues it if busy),
 * a sleeping pinned team wakes its Buddy via `openPin` and gets the message, and only an unknown or
 * done/removed lane (or failed wake) parks in the inbox. Returns the toast text.
 */
export async function sendIdeaToTeam(laneId: string, text: string, from?: string, deps: SendIdeaDeps = {}): Promise<string> {
  const idea = text.trim();
  if (!idea) throw new Error("Nothing to send");
  const needle = laneId.trim().toLowerCase();
  const teams = (deps.getTeams ?? getTeams)();
  const matchesLane = (l: { id: string; aliases?: string[] }) =>
    l.id.toLowerCase() === needle || (l.aliases ?? []).some((a) => a.toLowerCase() === needle);
  const squad = teams.find((t) => t.lanes.some(matchesLane));
  const lane = squad?.lanes.find(matchesLane);
  const park = deps.park ?? parkIdeasInInbox;
  if (!squad || !lane) {
    await park({ ideas: [idea], source: "misroute" });
    return "Parked in the inbox";
  }
  const live = findCrossTeamBrainstorm(resolve(deps.agents ?? getPaseoState().agents), lane.id, "", { includeClosed: true });
  const msg = from ? `Idea sent over from ${from}:\n\n${idea}` : idea;
  if (live) {
    await (deps.send ?? sendMessage)(live.agent.id, msg);
    return `Sent to ${lane.name}`;
  }
  const laneState = (lane as PinLane).state;
  if (laneState !== "done" && laneState !== "removed") {
    const targetPin: Pin = {
      squad,
      lane: lane as PinLane,
      state: "pinned",
      order: 0,
      brainstorm: null,
      lead: null,
      workers: [],
      needsYou: 0,
      running: 0,
      contextUsed: 0,
      topicBrainstorms: [],
    };
    try {
      const agentId = await (deps.openPin ?? openPin)(targetPin, deps);
      if (agentId) {
        await (deps.send ?? sendMessage)(agentId, msg);
        return `Sent to ${lane.name}`;
      }
    } catch {
      // fall through to park in inbox
    }
  }
  await park({ ideas: [idea], laneId: lane.id, teamId: squad.id, source: "misroute" });
  return `Parked in ${lane.name}${/s$/i.test(lane.name) ? "'" : "'s"} inbox`;
}

const SEND_TO_KEY = "vibesquad.sendToDismissed";
export const isSendToDismissed = (messageId: string, legacyIds?: string[]): boolean => isDismissed(SEND_TO_KEY, messageId, legacyIds);
export const dismissSendTo = (messageId: string): void => dismiss(SEND_TO_KEY, messageId);

const DECISION_KEY = "vibesquad.decisionDismissed";
export const isDecisionDismissed = (cardId: string): boolean => isDismissed(DECISION_KEY, cardId);
export const dismissDecision = (cardId: string): void => dismiss(DECISION_KEY, cardId);

const SPIN_OFF_KEY = "vibesquad.spinOffDismissed";
export const isSpinOffDismissed = (messageId: string): boolean => isDismissed(SPIN_OFF_KEY, messageId);
export const dismissSpinOff = (messageId: string): void => dismiss(SPIN_OFF_KEY, messageId);

/**
 * Create every Team of a confirmed spin-off block as a pin in the squad (no overlap refusal: the user confirmed the
 * list; exact ids still dedupe inside createPin) and immediately quick-start each new lane's Brainstorm Buddy in
 * parallel (unless `deps.startBuddies === false`).
 */
export const createSpinOffPins = (key: string, squadId: string, teams: { name: string; brief: string }[], deps: CreatePinDeps = {}) =>
  runSpinOffOnce(
    key,
    async (name, brief) => {
      const pin = await createPin(squadId, name, brief, deps);
      if (deps.startBuddies !== false) {
        void openPin(pin, deps).catch(() => {});
      }
      return pin;
    },
    teams,
  );
