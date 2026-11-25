// Normal implementer arm pick (PLAN_PER_ROLES_LADDER_1125 R0; grew out of the EXP6 pick, idea-440). The server alternates
// stakes=normal implementer spawns per lane between the Claude Sonnet arm (`Implement - Sonnet`, wf=sonnet) and the Gemini
// Neon arm (`Implement - Gemini (trial)`, wf=neon), so the alternation survives lead handoffs and feeds EXP10/EXP11.
// DSP (`Work Order - DSP`) is never an arm: it runs only when asked for by name or reached by provider failover.
// Every pick is visible: decideArm returns { arm, reason, swapped, profile } and spawn_worker prints/stamps it (no silent swap).
// Pure functions; the caller injects the agent list and the cap probe. Everything fails open: any error keeps the requested
// profile. R3 replaces the two-arm set with the EXP10 per-kind table (IMPLEMENTER_ARMS is the seam; R8 adds tier arms).
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// EXP6 (Sonnet vs DSP, 11-19..11-23) is closed; these stay for the history readers (verdict probe, EXP6.md re-reads).
export const EXP6_SINCE = "2026-11-19T00:00:00Z";
export const EXP6_DEFAULT_END = "2026-11-27T00:00:00Z";

/** Arm table: wf key -> the profile that runs it. Only these profiles are ever picked. */
export const ARMS = {
  sonnet: { profile: "Implement - Sonnet", wf: "sonnet" },
  neon: { profile: "Implement - Gemini (trial)", wf: "neon" },
};
/** The live arm set for stakes=normal implementer spawns (order = tie-break order). [] turns the alternation off. */
export const IMPLEMENTER_ARMS = ["sonnet", "neon"];
/** Label stamped on every picked spawn: the arm it was picked for (countArms counts these, so both arms start at 0). */
export const ARM_LABEL = "vs.arm";
/** Label carrying the pick reason (alternation | capped:<family> | pin | wf | override | fail-open). */
export const ARM_REASON_LABEL = "vs.arm-reason";
/** Label carrying the model the spawn resolved to (the spawn hook re-syncs it after failover / the stakes ladder). */
export const MODEL_LABEL = "vs.model";

// Spawn names that join the alternation: the two arm profiles and the `Worker` alias (resolves to Implement - Sonnet).
// No role names (D1b): the `implement` role also carries the legacy Planner/Spec/Senior Reasoning names
// (LEGACY_PROFILE_ROLES) and routes through resolveRoute (the stakes ladder); R1 moves role spawns onto the ladder pick.
const ARM_SOURCES = {
  "implement - sonnet": "sonnet",
  worker: "sonnet",
  "implement - gemini (trial)": "neon",
};
// Provider families whose cap blocks picking that arm. Keys as readCappedProviders normalizes them (claude,
// antigravity-cli) plus the raw spellings a hand-written cap map may use. The `wf` arms of other spawns are unaffected.
export const ARM_CAP_FAMILIES = { sonnet: ["claude", "anthropic"], neon: ["antigravity-cli", "antigravity", "agy", "gemini"], dsp: ["opencode", "deepseek"] };

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

/** The capped family key of `wf`'s provider in the capped map/array, or "" (not capped). */
export function armCapKey(wf, capped) {
  const fams = ARM_CAP_FAMILIES[wf] ?? [];
  const keys = Array.isArray(capped) ? capped : Object.keys(capped ?? {});
  for (const k of keys) {
    const fam = String(k ?? "").trim().toLowerCase().split("/")[0];
    if (fams.includes(fam) || (wf === "neon" && fam.startsWith("gemini-"))) return fam;
  }
  return "";
}

/** True when any family of `wf` is in the capped map/array. */
export function armCapped(wf, capped) {
  return armCapKey(wf, capped) !== "";
}

/** The arm a profile name joins, or null (any other profile is never touched). */
export function armOfProfile(name) {
  const wf = ARM_SOURCES[String(name ?? "").trim().toLowerCase()];
  return wf ? ARMS[wf] : null;
}

/** EXP6 history: open until a verdict is logged or the end date passes. `endIso` is VS_EXP6_END (or the default). */
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

/**
 * Per-arm counts of normal-stakes worker spawns in `lane` that carry the `vs.arm` pick label. Only picked spawns count:
 * EXP6-era spawns (wf=sonnet/dsp, no `vs.arm`) are history, and counting them would hand Neon every pick until it caught
 * up instead of alternating. A respawned worker counts once (its replacement inherits `vs.arm`); digests never count.
 */
export function countArms(agents, { lane, team = "", arms = IMPLEMENTER_ARMS } = {}) {
  const counts = Object.fromEntries(arms.map((wf) => [wf, 0]));
  for (const a of agents ?? []) {
    const l = a?.labels ?? {};
    if (!norm(lane) || norm(l.lane) !== norm(lane)) continue;
    if (norm(team) && norm(l.team) !== norm(team)) continue;
    if (l.respawnedAs || l.digestFor) continue;
    if (norm(l.role) && norm(l.role) !== "worker") continue;
    if ((norm(l.stakes) || "normal") !== "normal") continue;
    const wf = norm(l[ARM_LABEL]);
    if (wf in counts) counts[wf]++;
  }
  return counts;
}

/** The uncapped arm with the fewest picks; a tie keeps the requested arm, else the first in `arms` order. */
export function pickArm(requested, counts, { arms = IMPLEMENTER_ARMS, capped = new Set() } = {}) {
  let best = null;
  for (const wf of arms) {
    if (capped.has(wf)) continue;
    const n = counts?.[wf] ?? 0;
    if (!best || n < best.n || (n === best.n && wf === requested.wf)) best = { wf, n };
  }
  return best ? ARMS[best.wf] : null;
}

/**
 * Decide the arm for a spawn. Returns null when this is not a stakes=normal implementer arm request (lead, no lane,
 * tierA-* / mechanical, any other profile, alternation off). Else { mode: "arm", arm, requestedArm, swapped, reason,
 * counts, profile }: reason "pin" / "wf" (caller opted out: requested profile kept), "alternation" (fewest picks),
 * "capped:<family>" (a capped arm was skipped; both capped -> requested kept), "fail-open" (agent list or cap probe threw:
 * requested kept). `capProbe` -> capped map/array (readArmCaps). Never throws.
 */
export async function decideArm({ profile, stakes, asLead, labels = {}, lane, team, listAgents, capProbe, arms = IMPLEMENTER_ARMS }) {
  if (asLead || !norm(lane)) return null;
  if ((norm(stakes) || "normal") !== "normal") return null;
  const requested = armOfProfile(profile);
  const set = (Array.isArray(arms) ? arms : []).filter((wf) => ARMS[wf]);
  if (!requested || set.length < 2 || !set.includes(requested.wf)) return null;
  const keep = (reason, extra = {}) => ({ mode: "arm", arm: requested.wf, requestedArm: requested.wf, swapped: false, reason, counts: null, profile: String(profile), ...extra });
  if (norm(labels.ab) === "pin") return keep("pin");
  if (norm(labels.wf)) return keep("wf");
  let capped;
  try {
    const caps = capProbe ? await capProbe() : {};
    capped = new Map(set.map((wf) => [wf, armCapKey(wf, caps)]).filter(([, k]) => k));
  } catch {
    return keep("fail-open"); // unreadable caps: never swap onto a possibly dead provider (idea-703)
  }
  let counts;
  try {
    counts = countArms(await listAgents(), { lane, team, arms: set });
  } catch {
    return keep("fail-open");
  }
  const arm = pickArm(requested, counts, { arms: set, capped: new Set(capped.keys()) });
  if (!arm) return keep(`capped:${[...capped.values()].join("+")}`, { counts, capped: true }); // every arm capped
  // The reason names a cap only when it changed the outcome (the uncapped pick was a capped arm).
  const free = pickArm(requested, counts, { arms: set });
  const reason = free.wf !== arm.wf ? `capped:${capped.get(free.wf)}` : "alternation";
  const swapped = arm.wf !== requested.wf;
  return { mode: "arm", arm: arm.wf, requestedArm: requested.wf, swapped, reason, counts, profile: swapped ? arm.profile : String(profile), ...(reason !== "alternation" ? { capped: true } : {}) };
}
