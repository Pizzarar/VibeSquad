// Per-lane fail-streak spawn cap (idea-820; dups idea-660, idea-825). A lane whose last FAIL_STREAK_MAX worker spawns all
// failed at start (the first turn ended failed: died on launch, errored before any completed turn) is held: spawn_worker in
// that lane is refused for a cooldown instead of storming (usage review: 892 storms, android-app up to x11). The first refused
// spawn of each hold logs ONE needs-you line (the caller's identity, server/mcp/tools.mjs). A worker's first turn completing
// clears the lane. A spawn after the cooldown is the half-open probe: if it fails too, the hold re-trips with a doubled cooldown.
// State is one JSON file (the `vs cap` store pattern, server/provider-failover.mjs) so the server (recorder,
// server/backend/runner-backend.mjs) and any MCP/CLI process (spawn_worker) share it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { updateJsonFile } from "./file-lock.mjs";
import { isForbiddenRealHome } from "./test-guard.mjs";

export const FAIL_STREAK_MAX = 3;
export const FAIL_STREAK_COOLDOWN_MS = 10 * 60_000;
export const FAIL_STREAK_COOLDOWN_MAX_MS = 60 * 60_000;
/** Failures older than this no longer count toward a streak (a lane idle for an hour starts fresh). */
export const FAIL_STREAK_WINDOW_MS = 60 * 60_000;
const KEEP_IDS = 50;

export function spawnStreakPath(env = process.env) {
  if (env.VIBESQUAD_SPAWN_STREAK_PATH) return env.VIBESQUAD_SPAWN_STREAK_PATH;
  return join(env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "lane-spawn-streaks.json");
}

export const laneKey = (team, lane) => `${String(team ?? "").trim().toLowerCase()}:${String(lane ?? "").trim().toLowerCase()}`;

// A test that forgot a temp VIBESQUAD_HOME must neither read nor write the real lane holds (test-guard.mjs).
const offLimits = (file) => isForbiddenRealHome(dirname(file));
const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const cooldownFor = (trips) => Math.min(FAIL_STREAK_COOLDOWN_MS * 2 ** Math.max(0, trips - 1), FAIL_STREAK_COOLDOWN_MAX_MS);

/**
 * Pure step: the lane record after one worker turn outcome. `outcome` is "completed" | "failed" (anything else: unchanged).
 * Only a worker's FIRST turn counts (an id that already completed a turn is a running worker, not a spawn). Returns
 * { rec, tripped } where tripped = this failure started a new hold.
 */
export function stepLaneStreak(rec0, { agentId, outcome, error = "", now = Date.now() } = {}) {
  const rec = { fails: [], ok: [], trips: 0, heldUntil: 0, ...asObj(rec0) };
  rec.fails = (Array.isArray(rec.fails) ? rec.fails : []).filter((f) => f && now - f.at <= FAIL_STREAK_WINDOW_MS);
  rec.ok = Array.isArray(rec.ok) ? rec.ok : [];
  const id = String(agentId ?? "");
  if (!id || rec.ok.includes(id)) return { rec, tripped: false };
  if (outcome === "completed") {
    rec.ok = [...rec.ok, id].slice(-KEEP_IDS);
    return { rec: { ...rec, fails: [], trips: 0, heldUntil: 0, notifiedAt: undefined }, tripped: false };
  }
  if (outcome !== "failed" || rec.fails.some((f) => f.id === id)) return { rec, tripped: false };
  rec.fails = [...rec.fails, { id, at: now, error: String(error).replace(/\s+/g, " ").slice(0, 160) }].slice(-KEEP_IDS);
  if (rec.fails.length < FAIL_STREAK_MAX || now < (rec.heldUntil || 0)) return { rec, tripped: false };
  rec.trips = (rec.trips || 0) + 1;
  rec.heldUntil = now + cooldownFor(rec.trips);
  rec.notifiedAt = undefined;
  return { rec, tripped: true };
}

/** Recorder (server): fold one worker turn outcome into the lane's record. Never rejects; resolves the step result or null. */
export async function noteLaneSpawnOutcome({ team, lane, agentId, outcome, error, now = Date.now() }, { file = spawnStreakPath() } = {}) {
  if (!lane || !agentId || (outcome !== "completed" && outcome !== "failed") || offLimits(file)) return null;
  let out = null;
  try {
    await updateJsonFile(file, (doc) => {
      const lanes = asObj(asObj(doc).lanes);
      const key = laneKey(team, lane);
      out = stepLaneStreak(lanes[key], { agentId, outcome, error, now });
      return { lanes: { ...lanes, [key]: out.rec } };
    }, { fallback: { lanes: {} } });
  } catch {
    return null; // best effort: a missed outcome only delays a hold
  }
  return out;
}

/** The lane's live hold, or null: { streak, until, lastError, ids, notified }. Reads only. */
export function laneSpawnHold({ team, lane, now = Date.now() }, { file = spawnStreakPath() } = {}) {
  if (offLimits(file)) return null;
  let rec;
  try {
    rec = asObj(asObj(JSON.parse(readFileSync(file, "utf8"))).lanes)[laneKey(team, lane)];
  } catch {
    return null;
  }
  if (!rec || !(now < Number(rec.heldUntil))) return null;
  const fails = Array.isArray(rec.fails) ? rec.fails : [];
  return { streak: fails.length, until: Number(rec.heldUntil), lastError: fails.at(-1)?.error ?? "", ids: fails.slice(-FAIL_STREAK_MAX).map((f) => f.id), notified: !!rec.notifiedAt };
}

/** Claim the hold's one notice: true for exactly one caller per hold (sets notifiedAt). Never rejects. */
export async function claimHoldNotice({ team, lane, now = Date.now() }, { file = spawnStreakPath() } = {}) {
  if (offLimits(file)) return false;
  let claimed = false;
  try {
    await updateJsonFile(file, (doc) => {
      const lanes = asObj(asObj(doc).lanes);
      const key = laneKey(team, lane);
      const rec = lanes[key];
      if (!rec || !(now < Number(rec.heldUntil)) || rec.notifiedAt) return doc;
      claimed = true;
      return { lanes: { ...lanes, [key]: { ...rec, notifiedAt: now } } };
    }, { fallback: { lanes: {} } });
  } catch {
    return false;
  }
  return claimed;
}

/** "8:00 AM EST" (R15: owner-read times in US Eastern). */
export function etClock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/** The refusal / needs-you text for a hold. */
export function holdText(lane, hold) {
  const mins = Math.max(1, Math.ceil((hold.until - Date.now()) / 60_000));
  return `SPAWN HOLD lane ${lane}: last ${hold.streak} worker spawns failed at start (${hold.ids.join(", ")}; last: ${hold.lastError || "no error text"}). spawn_worker refused until ${etClock(hold.until)} (~${mins} min). Fix the cause (provider cap/balance, cwd, binary) first.`;
}
