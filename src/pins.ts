// Pinned teams (docs/PLAN_PINNED_FEATURES.md): the team (a lane in teams.json) is the place the owner
// clicks; its Brainstorm, Lead and Workers are swappable occupants behind it.
// This file is the shared contract for the pinned-team UI. Keep it pure (no fetch, no React):
// steps 1 (sidebar + grid), 2 (focus rail) and 3 (resolver + quick start) all build on it.
import type { LaneDef, Member, TeamDef, TeamView } from "./teams.ts";
import { UNASSIGNED, brainstormUsedTokens, countsAsNeedsYou, formerNewest, isFormerBrainstormMember, isHubLane, isTopicBrainstorm } from "./teams.ts";
export { topicOfBrainstorm } from "./teams.ts";

/** "removed" lanes stay in teams.json (brief + history kept) but are hidden everywhere. */
export type PinState = "pinned" | "done" | "removed";

/** Extra lane fields stored in teams.json. Lanes without `state` count as pinned. */
export type PinFields = {
  state?: PinState;
  /** True for permanent standing teams that log "Shipped <date>: <goal>" and sleep in place instead of moving to the Done shelf. */
  standing?: boolean;
  /** ISO time the team was marked complete. */
  doneAt?: string;
  /** ISO time the team was removed (Team ⋯ → Remove team). */
  removedAt?: string;
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
  /** The main Brainstorm (live, or closed but unarchived: opening it reopens the session), or null when the pin has to quick-start one. */
  brainstorm: Member | null;
  /** The live lead, or null. */
  lead: Member | null;
  /** Live workers (not retired, not archived). */
  workers: Member[];
  needsYou: number;
  running: number;
  /** Context tokens used by the live Brainstorm (0 when none). */
  contextUsed: number;
  /** Live topic Brainstorms for this lane. */
  topicBrainstorms: Member[];
  /** Further live main Buddies besides `brainstorm` (should be none; the pin warns, docs/PLAN_BUGS_BATCH2.md block 0). */
  duplicateBrainstorms?: Member[];
};

export type PinResolution =
  | { kind: "live"; agent: Member }
  | { kind: "quick-start"; squadId: string; laneId: string; profile: string | null; briefPath: string };

/** Lane briefs live in the VibeSquad repo for every squad (server/brainstorm.mjs reads them there). */
export const briefPathFor = (laneId: string): string => `docs/brainstorm/${laneId}.md`;

export const pinStateOf = (lane: LaneDef): PinState => {
  const s = (lane as PinLane).state;
  return s === "done" || s === "removed" ? s : "pinned";
};

/** True for a lane removed with Remove team. Removed lanes never show as pins, Done entries or squad counts. */
export const isRemovedLane = (lane: LaneDef | null | undefined): boolean => (lane as PinLane | undefined)?.state === "removed";

export const isLive = (m: Member | null | undefined): m is Member =>
  Boolean(m) && !m!.agent.archivedAt && m!.agent.status !== "closed";

const live = (ms: Member[]) => ms.filter(isLive);

/** Build the pins for one squad. Pins are ordered by `order`, then by teams.json order. The "_other" bucket and removed lanes are never pins. */
export function pinsForSquad(view: TeamView): { pinned: Pin[]; done: Pin[] } {
  const pins = view.lanes
    .filter((l) => l.lane.id !== "_other" && !isRemovedLane(l.lane))
    .map((l, i): Pin => {
      const lane = l.lane as PinLane;
      // A closed Buddy (daemon restart) is still the pin's Buddy: clicking reopens it, never replaces it (block 0c).
      const brainstorm = l.brainstorm && !l.brainstorm.agent.archivedAt ? l.brainstorm : null;
      const workers = live(l.members.filter((m) => m.kind === "worker"));
      return {
        squad: view.team,
        lane,
        state: pinStateOf(lane),
        order: lane.order ?? i,
        brainstorm,
        lead: isLive(l.lead) ? l.lead : null,
        workers,
        needsYou: l.members.filter(countsAsNeedsYou).length,
        running: l.members.filter((m) => m.agent.status === "running").length,
        contextUsed: brainstorm ? brainstormUsedTokens(brainstorm.agent) : 0,
        topicBrainstorms: (l.topicBrainstorms ?? []).filter(isLive),
        duplicateBrainstorms: live(l.duplicateBrainstorms ?? []),
      };
    })
    .sort((a, b) => a.order - b.order);
  return { pinned: pins.filter((p) => p.state === "pinned"), done: pins.filter((p) => p.state === "done") };
}

/** True for the Squad's hub pin (RiffBot's lane). It lives in the hub bar, not the Team grid or Done shelf. */
export const isHubPin = (pin: Pin): boolean => isHubLane(pin.squad, pin.lane);

/** True when the pin is a permanent standing team (`lane.standing === true`). */
export const isStandingPin = (pin: Pin): boolean => Boolean(pin.lane.standing);

/** Every non-unassigned Squad has a ready-to-go RiffBot hub pin, even if teams.json has no explicit hub lane yet. */
export function hubPinForSquad(view: TeamView | null | undefined): Pin | null {
  if (!view?.team?.id || view.team.id === UNASSIGNED.id) return null;
  const { pinned, done } = pinsForSquad(view);
  const existing = [...pinned, ...done].find((p) => isHubLane(view.team, p.lane));
  if (existing) return existing;
  const hubLane: PinLane = { id: view.team.id, name: "RiffBot", hub: true, state: "pinned" };
  const target = view.team.id.toLowerCase();
  const inHub = (view.members ?? []).filter((m) => {
    const l = (m.agent.labels ?? {}) as Record<string, string>;
    const lid = (m.laneId ?? l.lane ?? l.lead ?? "").trim().toLowerCase();
    return lid === target;
  });
  const newest = (a: Member, b: Member) => (b.agent.updatedAt ?? "").localeCompare(a.agent.updatedAt ?? "");
  const mainBsCands = inHub.filter((m) => m.kind === "brainstorm" && !isTopicBrainstorm(m) && !m.agent.archivedAt);
  const liveBs = mainBsCands.filter(isLive).sort(newest);
  const formerBs = inHub.filter(isFormerBrainstormMember).sort(formerNewest);
  const brainstorm = liveBs[0] ?? mainBsCands.sort(newest)[0] ?? formerBs[0] ?? null;
  const lead = inHub.filter((m) => m.kind === "lead" && isLive(m)).sort(newest)[0] ?? null;
  const workers = live(inHub.filter((m) => m.kind === "worker"));
  const topicBrainstorms = inHub.filter((m) => m.kind === "brainstorm" && isTopicBrainstorm(m) && isLive(m)).sort(newest);
  return {
    squad: view.team,
    lane: hubLane,
    state: "pinned",
    order: -1,
    brainstorm,
    lead,
    workers,
    needsYou: inHub.filter(countsAsNeedsYou).length,
    running: inHub.filter((m) => m.agent.status === "running").length,
    contextUsed: brainstorm ? brainstormUsedTokens(brainstorm.agent) : 0,
    topicBrainstorms,
    duplicateBrainstorms: liveBs.slice(1),
  };
}

/** The pins the squad page shows as Team tiles and Done entries: `pinsForSquad` without the hub lane. */
export function gridPinsForSquad(view: TeamView): { pinned: Pin[]; done: Pin[] } {
  const { pinned, done } = pinsForSquad(view);
  return { pinned: pinned.filter((p) => !isHubPin(p)), done: done.filter((p) => !isHubPin(p)) };
}

/** The pin's looks-done message id, or null: never offered for the hub (it is never marked done). */
export const looksDoneFor = (pin: Pin, id: string | null): string | null => (isHubPin(pin) ? null : id);

/** Every live main Buddy of the pin when there are 2+ (the duplicate warning lists them), else []. */
export function liveBuddyDupes(pin: Pin): Member[] {
  const all = [pin.brainstorm, ...(pin.duplicateBrainstorms ?? [])].filter(isLive);
  return all.length > 1 ? all : [];
}

export type KeepBuddyDeps = {
  /** Detach a Buddy's live children so a later archive can't cascade to its lead. */
  detachChildren: (buddyId: string) => Promise<unknown>;
  /** Relabel one Buddy (name + labels patch). */
  update: (id: string, updates: { name?: string; labels: Record<string, string> }) => Promise<unknown>;
};

/**
 * "Keep this one" on the duplicate-Buddy warning: retire every other live main Buddy of the pin
 * (children detached, "(old)" title, former-brainstorm, vs.restarted-into=<kept id>). Nothing is archived.
 * A failure on one Buddy doesn't stop the rest.
 */
export async function keepBuddy(pin: Pin, keepId: string, deps: KeepBuddyDeps): Promise<{ retired: string[]; failed: string[] }> {
  const retired: string[] = [];
  const failed: string[] = [];
  const dupes = liveBuddyDupes(pin);
  if (!dupes.some((m) => m.agent.id === keepId)) return { retired, failed };
  for (const m of dupes) {
    if (m.agent.id === keepId) continue;
    const title = (m.agent.title ?? "").trim() || "Buddy";
    try {
      await deps.detachChildren(m.agent.id);
      await deps.update(m.agent.id, {
        ...(title.toLowerCase().startsWith("(old)") ? {} : { name: `(old) ${title}` }),
        labels: { role: "former-brainstorm", "vs.restarted-into": keepId },
      });
      retired.push(m.agent.id);
    } catch {
      failed.push(m.agent.id);
    }
  }
  return { retired, failed };
}

/** Decide what clicking a pin does: open the live Brainstorm, or quick-start one from the brief. */
export function resolvePin(pin: Pin): PinResolution {
  // A closed Buddy (daemon restart) is not live: it goes through the server's reopen-or-replace start.
  if (pin.brainstorm && pin.brainstorm.agent.status !== "closed") return { kind: "live", agent: pin.brainstorm };
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
export const isContentLine = (l: string): boolean => Boolean(l) && !/^[-*]?\s*\(?\s*(none|nothing)( recorded)?( yet)?\s*\)?\.?$/i.test(l);

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

// ── Step 5: completing a team (docs/PLAN_PINNED_FEATURES.md §4) ──────────────

/**
 * Why Mark complete is refused right now, or null when it is allowed. Running workers (and a running
 * lead) or any open permission on the team block it. The Brainstorm itself may be running.
 */
export function completeBlocker(pin: Pin): string | null {
  const crew = [...(pin.lead ? [pin.lead] : []), ...pin.workers];
  const perms = [pin.brainstorm, ...crew].reduce((n, m) => n + (m?.agent.pendingPermissions?.length ?? 0), 0);
  const runningWorkers = pin.workers.filter((m) => m.agent.status === "running").length;
  const leadRunning = pin.lead?.agent.status === "running";
  const parts: string[] = [];
  if (runningWorkers) parts.push(`${runningWorkers} worker${runningWorkers === 1 ? "" : "s"} still running`);
  if (leadRunning) parts.push("Lead still running");
  if (perms) parts.push(`${perms} open permission${perms === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : null;
}

/** The fenced line a Brainstorm posts under "<Team> looks done. ✓ Mark complete · Not yet". */
export const LOOKS_DONE_MARKER = "vs:looks-done";

/** True when a message carries the looks-done marker on a line of its own (fenced or bare). */
export const hasLooksDone = (text: string): boolean =>
  text.replace(/\r\n/g, "\n").split("\n").some((l) => l.replace(/`/g, "").trim() === LOOKS_DONE_MARKER);

/** Date stamp for the brief's "Done <date>" / "Reopened <date>" lines (local YYYY-MM-DD). */
export function briefStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Append one line to the end of a brief, keeping exactly one trailing newline. */
export const appendBriefLine = (brief: string, line: string): string => `${brief.replace(/\s+$/, "")}\n\n${line}\n`;

export type SpinOffResult<P = unknown> = { name: string; pin?: P; error?: string };

/** Run `create` for each row in order (lane ids are global, so each sees the previous lane). A failed row does not stop the rest. */
export async function runSpinOff<P>(create: (name: string, brief: string) => Promise<P>, teams: { name: string; brief: string }[]): Promise<SpinOffResult<P>[]> {
  const out: SpinOffResult<P>[] = [];
  for (const t of teams) {
    try {
      out.push({ name: t.name, pin: await create(t.name, t.brief) });
    } catch (e) {
      out.push({ name: t.name, error: (e as Error)?.message ?? String(e) });
    }
  }
  return out;
}

/** "Pinned 3 Teams", plus " · Failed: Name (reason), …" per failed row. */
export function describeSpinOff(results: SpinOffResult[]): string {
  const ok = results.filter((r) => r.pin).length;
  const failed = results.filter((r) => r.error);
  const head = `Pinned ${ok} Team${ok === 1 ? "" : "s"}`;
  return failed.length ? `${head} · Failed: ${failed.map((r) => `${r.name} (${r.error})`).join(", ")}` : head;
}

/** The lines of a message without any ```vs:spin-off fence (its rows belong to the card, not the tile preview). */
export function withoutSpinOffFence(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (inside) inside = !/^\s*```/.test(l);
    else if (/^\s*```\s*vs:spin-off\s*$/.test(l)) inside = true;
    else out.push(l);
  }
  return out;
}

// One run per offer (agentId:messageId) at a time, however many cards show it (tile + drawer bar, double click).
// Rows that already succeeded are remembered, so a retry after a partial failure only offers the failed ones.
const spinFlight = new Set<string>();
const spinDone = new Map<string, Set<number>>();
const spinListeners = new Set<() => void>();
let spinVersion = 0;
const spinChanged = () => {
  spinVersion++;
  spinListeners.forEach((l) => l());
};

export const subscribeSpinOff = (l: () => void): (() => void) => {
  spinListeners.add(l);
  return () => spinListeners.delete(l);
};
export const spinOffVersion = (): number => spinVersion;
export const isSpinOffRunning = (key: string): boolean => spinFlight.has(key);
/** The rows of an offer that have not been created yet. */
export const spinOffRemaining = <T,>(key: string, teams: T[]): T[] => teams.filter((_, i) => !spinDone.get(key)?.has(i));

/** Create the not-yet-created rows. Null when a run for this key is already in flight (nothing happens). */
export async function runSpinOffOnce<P>(key: string, create: (name: string, brief: string) => Promise<P>, teams: { name: string; brief: string }[]): Promise<SpinOffResult<P>[] | null> {
  if (spinFlight.has(key)) return null;
  spinFlight.add(key);
  spinChanged();
  try {
    const todo = teams.map((t, i) => ({ t, i })).filter(({ i }) => !spinDone.get(key)?.has(i));
    const results = await runSpinOff(create, todo.map(({ t }) => t));
    const done = spinDone.get(key) ?? new Set<number>();
    results.forEach((r, k) => r.pin && done.add(todo[k].i));
    spinDone.set(key, done);
    return results;
  } finally {
    spinFlight.delete(key);
    spinChanged();
  }
}

// ── Step 6: idea capture (docs/PLAN_PINNED_FEATURES.md §5) ────────────────────
// Shared with `vs pin new` (cli/vs.mjs), so the pure helpers live in server/pin-ideas.mjs.
import { takenLaneIds } from "../server/pin-ideas.mjs";
export {
  bestOverlap,
  nameFromIdea,
  newPinBrief,
  OVERLAP_THRESHOLD,
  overlapScore,
  parseSendTo,
  parseSpinOff,
  spinOffFrom,
  SPIN_OFF_MARKER,
  SEND_TO_MARKER,
  slugLaneId,
  takenLaneIds,
  uniqueLaneId,
} from "../server/pin-ideas.mjs";

/** Every lane id and alias in every squad (lane ids and brief files are global). */
export const allLaneIds = (teams: TeamDef[]): string[] => takenLaneIds(teams.flatMap((t) => t.lanes));

// ── Polish: display names, persisted focus (docs/PLAN_PINNED_FEATURES.md) ─────

/** The Team's display name for a lane id (or alias) in any squad; the id itself when the lane is unknown. */
export function laneDisplayName(teams: TeamDef[], laneId: string): string {
  const key = laneId.toLowerCase();
  for (const t of teams)
    for (const l of t.lanes)
      if (l.id.toLowerCase() === key || (l.aliases ?? []).some((a) => a.toLowerCase() === key)) return l.name || laneId;
  return laneId;
}

// Same thresholds as server/brief-write.mjs (the server guard is the authority; this only explains it before the round trip).
const BRIEF_SHRINK_FROM = 1000;
const BRIEF_SHRINK_TO = 300;

/** Non-empty reason when saving `after` over `before` would be refused as a near-empty replace. */
export function briefShrinkWarning(before: string, after: string): string {
  const old = new TextEncoder().encode(before).length;
  const next = new TextEncoder().encode(after).length;
  if (old > BRIEF_SHRINK_FROM && next < BRIEF_SHRINK_TO) {
    return `This would replace a ${old}-byte brief with ${next} bytes. The save is refused; the old brief is kept.`;
  }
  return "";
}

/** The pin's Buddy id only while it is live; a closed (or archived) Buddy is dormant and goes through the Spin Up picker. */
export const liveBuddyId = (pin: Pin): string | null => (isLive(pin.brainstorm) ? pin.brainstorm.agent.id : null);

/**
 * The pin's closed-but-unarchived Buddy (runner `lost`/`exited`, daemon restart): its history is still on disk, so the pin
 * opens it read-only with the Spin Up picker above it. Null for a truly dormant pin (no Buddy at all) and while one is live.
 */
export const dormantBuddyId = (pin: Pin): string | null => (pin.brainstorm && !pin.brainstorm.agent.archivedAt && pin.brainstorm.agent.status === "closed" ? pin.brainstorm.agent.id : null);
