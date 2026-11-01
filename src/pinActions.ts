// Pinned teams step 3 (docs/PLAN_PINNED_FEATURES.md §3): the side-effecting half of the pin resolver.
// src/pins.ts stays pure; this file talks to the dev-server middleware and the teams store.
import type { PaseoAgent } from "@getpaseo/client";
import { DEMO, getPaseoState, upsertLocalAgent } from "./paseo";
import { DEFAULT_PIN_PROFILE, patchLane, resolvePin, type Pin } from "./pins";
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
