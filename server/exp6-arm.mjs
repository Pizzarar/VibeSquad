// EXP6 arm pick (idea-440): the server alternates stakes=normal implementer spawns between `Implement - Sonnet` (wf=sonnet) and
// `Work Order - DSP` (wf=dsp) per lane, so the alternation survives lead handoffs. Pure functions; the caller injects the
// agent list and the experiment-verdict probe. Everything fails open: any error keeps the requested profile.
// After the verdict (EXP6_WINNER), the same site applies the post-experiment default instead of the alternation.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXP6_SINCE = "2026-11-19T00:00:00Z";
export const EXP6_DEFAULT_END = "2026-11-27T00:00:00Z";
export const EXP6_ARMS = {
  "implement - sonnet": { profile: "Implement - Sonnet", wf: "sonnet" },
  "work order - dsp": { profile: "Work Order - DSP", wf: "dsp" },
};
const WF_TO_ARM = { sonnet: EXP6_ARMS["implement - sonnet"], dsp: EXP6_ARMS["work order - dsp"] };

// Post-experiment default (PLAN_EXP6_DSP_DEFAULT D1): EXP6 closed with `@per EXP6 verdict change` (2026-11-23, E2 read:
// DSP within 10 pts first-try at ~45-57% lower $/unit). Once the experiment is closed, a stakes=normal implementer spawn
// asking for the Sonnet implementer resolves to the winner. Set by hand, never parsed from verdict text.
// B0 (PLAN_PER_BEST_USE_1125, 2026-11-25): "sonnet". Routing is judged on best use (first-try PASS first, $ only as a
// tiebreak) and DSP won EXP6 only on $ (.62 vs .67 first-try), so normal implementers stay on Sonnet: a Sonnet/Worker
// request is already the winner arm (no swap) and a `Work Order - DSP` request is never a default source (kept as asked;
// DSP also stays in the failover chains). "dsp" re-enables the swap (cap-checked, idea-703); "" = no default at all.
// B2 replaces this with the per-kind table from the EXP10 read.
export const EXP6_WINNER = "sonnet";
// Spawn names that mean "the normal implementer" -> the winner-arm name to use instead: only the profile EXP6 measured
// (`Implement - Sonnet`) and the `Worker` alias that resolves to it. No role names (D1b, Buddy fix-forward): the
// `implement` role also carries the legacy Planner/Spec/Senior Reasoning names (LEGACY_PROFILE_ROLES), and EXP6 never
// measured planning, so a role-name `implement` spawn and every planning/spec profile keep today's route.
const DEFAULT_SOURCES = {
  "implement - sonnet": { wf: "sonnet", to: { dsp: "Work Order - DSP" } },
  worker: { wf: "sonnet", to: { dsp: "Work Order - DSP" } },
};
// Provider families whose cap blocks a swap to that arm. A deepseek cap is keyed "deepseek" (`vs cap set deepseek`)
// while the DSP profile runs on provider "opencode": both count (idea-703: the A/B swap ignored a deepseek cap).
export const ARM_CAP_FAMILIES = { dsp: ["opencode", "deepseek"], sonnet: ["claude"] };

/**
 * Live `vs cap` map (capped-providers.json, expired caps dropped) for the spawn caller's VibeSquad home. Lazy import:
 * the MCP server loads this module at startup. A missing file = no caps. A file that exists but cannot be read or
 * parsed THROWS (readCappedProviders would read it as "no caps"): decideArm then treats the arm as capped and keeps the
 * requested profile, so a corrupt cap file never swaps a spawn onto a dead provider (idea-703). Other callers of
 * provider-failover.mjs keep their behaviour.
 */
export async function readArmCaps({ env = process.env } = {}) {
  const { readCappedProviders, resolveCappedProvidersPath } = await import("./provider-failover.mjs");
  const cappedProvidersPath = env?.VIBESQUAD_CAPPED_PROVIDERS_PATH || (env?.VIBESQUAD_HOME ? join(env.VIBESQUAD_HOME, "capped-providers.json") : undefined);
  const path = resolveCappedProvidersPath(cappedProvidersPath ? { cappedProvidersPath } : {});
  if (existsSync(path)) {
    const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); // unreadable/torn -> throws
    const map = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc.capped ?? doc) : null;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`capped-providers.json: unexpected shape at ${path}`);
  }
  return readCappedProviders({ useDiskCaps: true, cappedProvidersPath: path });
}

/** True when any family of `wf` is in the capped map/array. */
export function armCapped(wf, capped) {
  const fams = ARM_CAP_FAMILIES[wf] ?? [];
  const keys = Array.isArray(capped) ? capped : Object.keys(capped ?? {});
  return keys.some((k) => fams.includes(String(k ?? "").trim().toLowerCase().split("/")[0]));
}

/** The arm a profile name belongs to, or null (any other profile is never touched). */
export function armOfProfile(name) {
  return EXP6_ARMS[String(name ?? "").trim().toLowerCase()] ?? null;
}

/** Open until a verdict is logged or the end date passes. `endIso` is VS_EXP6_END (or the default). */
export function experimentOpen({ now = Date.now(), endIso, verdict = false } = {}) {
  if (verdict) return false;
  const end = Date.parse(endIso || EXP6_DEFAULT_END);
  return Number.isFinite(end) ? now < end : now < Date.parse(EXP6_DEFAULT_END);
}

/** Does a lane-log entry list contain a `@per EXP6 verdict` decision? */
export function hasVerdictEntry(entries) {
  return (entries ?? []).some((e) => e?.type === "decision" && /exp6\s+verdict/i.test(String(e.text ?? "")));
}

/** The EXP6 owner Squad: the verdict is logged in its perfection lane, whichever Squad the spawning caller is in. */
export const EXP6_TEAM = "vibesquad";
const verdictCache = new Map(); // path -> { mtimeMs, size, verdict }

/** Read the perfection lane log from disk, cached by mtime+size. Throws on unreadable input; callers fail open. */
export function readPerfectionVerdict({ team = EXP6_TEAM, home } = {}) {
  const base = home || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  const path = join(base, "logs", `${team}--perfection.jsonl`);
  if (!existsSync(path)) return false;
  const st = statSync(path);
  const hit = verdictCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.verdict;
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!/verdict/i.test(line)) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  const verdict = hasVerdictEntry(entries);
  verdictCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, verdict });
  return verdict;
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Per-wf counts of normal-stakes worker spawns in `lane` since `since`. Agents: records with labels + createdAt. */
export function countArms(agents, { lane, team = "", since = EXP6_SINCE } = {}) {
  const floor = Date.parse(since);
  const counts = { sonnet: 0, dsp: 0 };
  for (const a of agents ?? []) {
    const l = a?.labels ?? {};
    if (!norm(lane) || norm(l.lane) !== norm(lane)) continue;
    if (norm(team) && norm(l.team) !== norm(team)) continue;
    if (l.respawnedAs || l.digestFor) continue; // a respawned worker counts once (its replacement); digests are not implementers
    if (norm(l.role) && norm(l.role) !== "worker") continue;
    if ((norm(l.stakes) || "normal") !== "normal") continue;
    const t = Date.parse(a.createdAt);
    if (!Number.isFinite(t) || (Number.isFinite(floor) && t < floor)) continue;
    const wf = norm(l.wf);
    if (wf in counts) counts[wf]++;
  }
  return counts;
}

/** The arm with fewer spawns; a tie keeps the requested one. */
export function pickArm(requested, counts) {
  const other = requested.wf === "sonnet" ? WF_TO_ARM.dsp : WF_TO_ARM.sonnet;
  return counts[other.wf] < counts[requested.wf] ? other : requested;
}

/** Is the swap target capped? A throwing probe counts as capped: the spawn keeps its requested profile (fail open). */
async function targetCapped(wf, capProbe) {
  if (!capProbe) return false;
  try { return armCapped(wf, await capProbe()); } catch { return true; }
}

/**
 * Post-experiment default: { mode: "default", arm, requestedArm, swapped, profile, capped? } or null (not a default
 * source, no winner, or the request already is the winner). A capped winner keeps the requested profile (swapped=false).
 */
async function decideDefault(profile, { winner, capProbe }) {
  const src = DEFAULT_SOURCES[norm(profile)];
  const to = src?.to?.[winner];
  if (!src || !to || src.wf === winner) return null;
  if (await targetCapped(winner, capProbe)) return { mode: "default", arm: src.wf, requestedArm: src.wf, swapped: false, capped: true, counts: null, profile: String(profile) };
  return { mode: "default", arm: winner, requestedArm: src.wf, swapped: true, counts: null, profile: to };
}

/**
 * Decide the arm for a spawn. Returns null when nothing applies (not worker/normal/arm profile, pinned, closed with no
 * default), else { mode: "ab"|"default", arm, swapped, counts, profile }. While EXP6 is open: per-lane alternation.
 * Once closed: the EXP6_WINNER default. A swap never targets a capped arm (`capProbe` -> capped map/array, idea-703).
 * A throwing agent list, verdict probe or cap probe fails open: the requested profile, no throw.
 */
export async function decideArm({ profile, stakes, asLead, labels = {}, lane, team, listAgents, verdictProbe, capProbe, now = Date.now(), endIso, winner = EXP6_WINNER }) {
  if (asLead || !norm(lane)) return null;
  if ((norm(stakes) || "normal") !== "normal") return null;
  if (norm(labels.wf) || norm(labels.ab) === "pin") return null;
  const requested = armOfProfile(profile);
  if (!requested && !DEFAULT_SOURCES[norm(profile)]) return null;
  let open;
  try {
    const verdict = verdictProbe ? await verdictProbe() : false;
    open = experimentOpen({ now, endIso, verdict });
  } catch {
    return null;
  }
  if (!open) return decideDefault(profile, { winner: norm(winner), capProbe });
  if (!requested) return null; // aliases/role names are not EXP6 arms: alternation stays exactly as before
  let counts;
  try {
    counts = countArms(await listAgents(), { lane, team });
  } catch {
    return { mode: "ab", arm: requested.wf, swapped: false, counts: null, profile: requested.profile, failOpen: true };
  }
  const arm = pickArm(requested, counts);
  if (arm !== requested && (await targetCapped(arm.wf, capProbe))) {
    return { mode: "ab", arm: requested.wf, requestedArm: requested.wf, swapped: false, capped: true, counts, profile: requested.profile };
  }
  return { mode: "ab", arm: arm.wf, requestedArm: requested.wf, swapped: arm !== requested, counts, profile: arm.profile };
}
