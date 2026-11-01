// Pinned teams (docs/PLAN_PINNED_FEATURES.md): the team (a lane in teams.json) is the place Aub
// clicks; its Brainstorm, Lead and Workers are swappable occupants behind it.
// This file is the shared contract for the pinned-team UI. Keep it pure (no fetch, no React):
// steps 1 (sidebar + grid), 2 (focus rail) and 3 (resolver + quick start) all build on it.
import type { LaneDef, Member, TeamDef, TeamView } from "./teams.ts";
import { brainstormUsedTokens } from "./teams.ts";

export type PinState = "pinned" | "done";

/** Extra lane fields stored in teams.json. Lanes without `state` count as pinned. */
export type PinFields = {
  state?: PinState;
  /** ISO time the team was marked complete. */
  doneAt?: string;
  /** Fixed sort order inside the squad; falls back to teams.json order. */
  order?: number;
  /** Profile name of the last Brainstorm, reused when the pin quick-starts. */
  lastProfile?: string;
};

export type PinLane = LaneDef & PinFields;

export type Pin = {
  squad: TeamDef;
  lane: PinLane;
  state: PinState;
  order: number;
  /** The live main Brainstorm, or null when the pin has to quick-start one. */
  brainstorm: Member | null;
  /** The live lead, or null. */
  lead: Member | null;
  /** Live workers (not retired, not archived). */
  workers: Member[];
  needsYou: number;
  running: number;
  /** Context tokens used by the live Brainstorm (0 when none). */
  contextUsed: number;
};

export type PinResolution =
  | { kind: "live"; agent: Member }
  | { kind: "quick-start"; squadId: string; laneId: string; profile: string | null; briefPath: string };

/** Lane briefs live in the VibeSquad repo for every squad (server/brainstorm.mjs reads them there). */
export const briefPathFor = (laneId: string): string => `docs/brainstorm/${laneId}.md`;

export const pinStateOf = (lane: LaneDef): PinState => ((lane as PinLane).state === "done" ? "done" : "pinned");

const isLive = (m: Member | null | undefined): m is Member =>
  Boolean(m) && !m!.agent.archivedAt && m!.agent.status !== "closed";

const live = (ms: Member[]) => ms.filter(isLive);

/** Build the pins for one squad. Pins are ordered by `order`, then by teams.json order. The "_other" bucket is never a pin. */
export function pinsForSquad(view: TeamView): { pinned: Pin[]; done: Pin[] } {
  const pins = view.lanes
    .filter((l) => l.lane.id !== "_other")
    .map((l, i): Pin => {
      const lane = l.lane as PinLane;
      const brainstorm = isLive(l.brainstorm) ? l.brainstorm : null;
      const workers = live(l.members.filter((m) => m.kind === "worker"));
      return {
        squad: view.team,
        lane,
        state: pinStateOf(lane),
        order: lane.order ?? i,
        brainstorm,
        lead: isLive(l.lead) ? l.lead : null,
        workers,
        needsYou: l.members.filter((m) => m.attention && m.attention.tone !== "finished" && m.kind !== "old-lead").length,
        running: l.members.filter((m) => m.agent.status === "running").length,
        contextUsed: brainstorm ? brainstormUsedTokens(brainstorm.agent) : 0,
      };
    })
    .sort((a, b) => a.order - b.order);
  return { pinned: pins.filter((p) => p.state === "pinned"), done: pins.filter((p) => p.state === "done") };
}

/** Decide what clicking a pin does: open the live Brainstorm, or quick-start one from the brief. */
export function resolvePin(pin: Pin): PinResolution {
  if (pin.brainstorm) return { kind: "live", agent: pin.brainstorm };
  return {
    kind: "quick-start",
    squadId: pin.squad.id,
    laneId: pin.lane.id,
    profile: pin.lane.lastProfile ?? null,
    briefPath: briefPathFor(pin.lane.id),
  };
}

/** Profile a pin quick-starts with when it has no `lastProfile` yet. */
export const DEFAULT_PIN_PROFILE = "Brainstorm - Claude";

/** Returns a copy of the squad list with one lane's pin fields (or its display name) patched (for saveTeams). */
export function patchLane(
  teams: TeamDef[],
  squadId: string,
  laneId: string,
  patch: Partial<PinFields> & { name?: string },
): TeamDef[] {
  return teams.map((t) =>
    t.id !== squadId ? t : { ...t, lanes: t.lanes.map((l) => (l.id === laneId ? { ...l, ...patch } : l)) },
  );
}

/** Split a brief into its `## ` sections (the preamble before the first heading is ""). */
function briefSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur = "";
  out.set(cur, []);
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1];
      if (!out.has(cur)) out.set(cur, []);
      continue;
    }
    out.get(cur)!.push(line);
  }
  return out;
}

/** Blank lines and placeholders like "- None." or "- (none recorded yet)" are not content. */
const isContentLine = (l: string): boolean => Boolean(l) && !/^[-*]?\s*\(?\s*(none|nothing)( recorded)?( yet)?\s*\)?\.?$/i.test(l);

/**
 * One-line summary of a brief edit for the steer message, e.g. "Decided +2 −1, Open +1".
 * Counts content lines added/removed per `## ` section (multiset diff, order ignored).
 */
export function briefDiffSummary(before: string, after: string): string {
  const a = briefSections(before);
  const b = briefSections(after);
  const parts: string[] = [];
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    const left = (a.get(name) ?? []).map((l) => l.trim()).filter(isContentLine);
    const right = (b.get(name) ?? []).map((l) => l.trim()).filter(isContentLine);
    const pool = new Map<string, number>();
    for (const l of left) pool.set(l, (pool.get(l) ?? 0) + 1);
    let added = 0;
    for (const l of right) {
      const n = pool.get(l) ?? 0;
      if (n > 0) pool.set(l, n - 1);
      else added++;
    }
    const removed = [...pool.values()].reduce((s, n) => s + n, 0);
    const label = !a.has(name) ? `new section ${name}` : !b.has(name) ? `removed section ${name}` : name || "header";
    if (!a.has(name) || !b.has(name)) {
      if (left.length || right.length || name) parts.push(label);
      continue;
    }
    if (added || removed) parts.push(`${label} ${[added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ")}`);
  }
  return parts.length ? parts.join(", ") : "no content changes";
}
