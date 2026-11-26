// Normal implementer arm pick (PLAN_PER_ROLES_LADDER_1125 R0; grew out of the EXP6 pick, idea-440). The server alternates
// (weighted 2:1 Neon:Sonnet, ARM_WEIGHTS, @per G1) stakes=normal implementer spawns per lane between the Claude Sonnet arm (`Implement - Sonnet`, wf=sonnet) and the Gemini
// Neon arm (`Implement - Gemini (trial)`, wf=neon), so the alternation survives lead handoffs and feeds EXP10/EXP11.
// DSP (`Work Order - DSP`) is never an arm: it runs only when asked for by name or reached by provider failover.
// Every pick is visible: decideArm returns { arm, reason, swapped, profile } and spawn_worker prints/stamps it (no silent swap).
// R1 (roles only): the role name `Implement` joins the same alternation. A role spawn is never swapped onto an old
// profile name: it keeps profile=Implement and the picked arm only sets the provider the role route tries first
// (`provider` below; spawn_worker + the spawn hook pass it as roleSpawnProfile `prefer`, read back from `vs.arm`).
// Pure functions; the caller injects the agent list and the cap probe. Everything fails open: any error keeps the requested
// profile. R3 replaces the two-arm set with the EXP10 per-kind table (IMPLEMENTER_ARMS is the seam; R8 adds tier arms).
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isInterruptibleWork } from "./provider-failover.mjs";

// EXP6 (Sonnet vs DSP, 11-19..11-23) is closed; these stay for the history readers (verdict probe, EXP6.md re-reads).
export const EXP6_SINCE = "2026-11-19T00:00:00Z";
export const EXP6_DEFAULT_END = "2026-11-27T00:00:00Z";

/**
 * Arm table: wf key -> the old profile that runs it for an old-name spawn, and the provider family a role-name spawn
 * (`Implement`) is routed onto (its model then comes from the tier ladder rung, never named here).
 */
export const ARMS = {
  sonnet: { profile: "Implement - Sonnet", wf: "sonnet", provider: "claude" },
  neon: { profile: "Implement - Gemini (trial)", wf: "neon", provider: "antigravity-cli" },
  // R8 (PLAN_PER_ROLES_LADDER_1125 Amend 11-25): opt-in cheap-tier arm on Gemini; model comes from the ladder, never named here.
  flash: { profile: null, wf: "flash", provider: "antigravity-cli", tier: "cheap", optIn: true },
};
/** The live arm set for stakes=normal implementer spawns (order = tie-break order). [] turns the alternation off. */
export const IMPLEMENTER_ARMS = ["sonnet", "neon"];
/** Alternation weights (@per G1): picks go to the uncapped arm with the lowest picks/weight, so Neon gets 2 of every 3. */
export const ARM_WEIGHTS = { sonnet: 1, neon: 2 };
const weightOf = (weights, wf) => {
  const w = weights?.[wf];
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
};
/** Label stamped on every picked spawn: the arm it was picked for (countArms counts these, so both arms start at 0). */
export const ARM_LABEL = "vs.arm";
/** Label carrying the pick reason (alternation | capped:<family> | pin | wf | override | fail-open). */
export const ARM_REASON_LABEL = "vs.arm-reason";
/** Label carrying the model the spawn resolved to (the spawn hook re-syncs it after failover / the stakes ladder). */
export const MODEL_LABEL = "vs.model";

// Spawn names that join the alternation: the two arm profiles and the `Worker` alias (resolves to Implement - Sonnet).
const ARM_SOURCES = {
  "implement - sonnet": "sonnet",
  worker: "sonnet",
  "implement - gemini (trial)": "neon",
};
// R1: the ROLE name `Implement` (role key "implement", any case/spacing) joins too; its requested arm is the ladder
// default (claude mid rung = Sonnet). Matched by the spawn name only, never by LEGACY_PROFILE_ROLES: old planning/spec
// names (Planner - Sonnet, Spec - Opus: planner role since R1; Senior Reasoning - DSP: implement role; D1b) and the
// Planner role stay out.
const ROLE_ARM_SOURCES = { implement: "sonnet" };
const roleArmKey = (name) => String(name ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
// Provider families whose cap blocks picking that arm. Keys as readCappedProviders normalizes them (claude,
// antigravity-cli) plus the raw spellings a hand-written cap map may use. The `wf` arms of other spawns are unaffected.
const AGY_CAP_FAMILIES = ["antigravity-cli", "antigravity", "agy", "gemini"];
export const ARM_CAP_FAMILIES = { sonnet: ["claude", "anthropic"], neon: AGY_CAP_FAMILIES, flash: AGY_CAP_FAMILIES, dsp: ["opencode", "deepseek"] };

/**
 * Live `vs cap` map (capped-providers.json, expired caps dropped) for the spawn caller's VibeSquad home. Lazy import:
 * the MCP server loads this module at startup. A missing file = no caps. A file that exists but cannot be read or
 * parsed THROWS (readCappedProviders would read it as "no caps"): decideArm then treats the arm as capped and keeps the
 * requested profile, so a corrupt cap file never swaps a spawn onto a dead provider (idea-703). Other callers of
 * provider-failover.mjs keep their behaviour.
 * G2 r1 (@per, idea-1012): families >=95% on live quota (runner/limits.jsonl, limits-read liveQuotaUsage, the same source
 * and isProviderOverQuota test the spawn hook fails over on) are added as caps, so the arm the hook would hop off is never
 * picked: the pick goes to the other arm with reason capped:<family>, and vs.arm / wf name the provider that actually runs.
 * A `vs cap` entry for the family wins (kept as is). The quota read never throws (unreadable = no quota caps).
 */
export async function readArmCaps({ env = process.env, stakes, kind, role, softThreshold, softThresholds } = {}) {
  const { isProviderOverQuota, normalizeProviderFamily, readCappedProviders, resolveCappedProvidersPath } = await import("./provider-failover.mjs");
  const { liveQuotaUsage } = await import("./limits-read.mjs");
  const cappedProvidersPath = env?.VIBESQUAD_CAPPED_PROVIDERS_PATH || (env?.VIBESQUAD_HOME ? join(env.VIBESQUAD_HOME, "capped-providers.json") : undefined);
  const path = resolveCappedProvidersPath(cappedProvidersPath ? { cappedProvidersPath } : {});
  if (existsSync(path)) {
    const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); // unreadable/torn -> throws
    const map = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc.capped ?? doc) : null;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`capped-providers.json: unexpected shape at ${path}`);
  }
  const caps = { ...readCappedProviders({ useDiskCaps: true, cappedProvidersPath: path }) };
  const quota = liveQuotaUsage({ home: env?.VIBESQUAD_HOME || undefined });
  for (const entry of quota) {
    const fam = normalizeProviderFamily(entry?.id);
    if (!fam || caps[fam]) continue;
    const q = isProviderOverQuota(fam, quota, undefined, { ignoreDiskCaps: true, env, stakes, kind, role, softThreshold, softThresholds });
    if (q.overQuota) caps[fam] = { reason: q.reason, quota: true };
    else if (q.softOverQuota) caps[fam] = { reason: q.softReason, quota: true, soft: true };
  }
  return caps;
}

/** The capped family key of `wf`'s provider in the capped map/array, or "" (not capped). */
export function armCapKey(wf, capped, { role = false } = {}) {
  const fams = ARM_CAP_FAMILIES[wf] ?? [];
  const keys = Array.isArray(capped) ? capped : Object.keys(capped ?? {});
  for (const k of keys) {
    const fam = String(k ?? "").trim().toLowerCase().split("/")[0];
    if (fams.includes(fam) || ((wf === "neon" || wf === "flash") && fam.startsWith("gemini-"))) {
      // R10 fu2/fu3: a role-spawn (`Implement`) sonnet arm lands on agy-claude first and falls back to direct claude, so it
      // is capped only when BOTH are. Legacy `Implement - Sonnet` does not walk agy-claude, so direct claude alone caps it.
      if (role && wf === "sonnet" && !keys.some((x) => String(x ?? "").trim().toLowerCase().split("/")[0] === "agy-claude")) continue;
      return fam;
    }
  }
  return "";
}

/** True when any family of `wf` is in the capped map/array. */
export function armCapped(wf, capped, opts) {
  return armCapKey(wf, capped, opts) !== "";
}

/**
 * The arm a spawn name joins, or null (any other profile is never touched). A role-name hit (`Implement`) comes back
 * with `role: true`: the caller keeps the role name and routes it with `prefer: arm.provider` instead of swapping.
 */
export function armOfProfile(name) {
  const wf = ARM_SOURCES[String(name ?? "").trim().toLowerCase()];
  if (wf) return ARMS[wf];
  const rwf = ROLE_ARM_SOURCES[roleArmKey(name)];
  return rwf ? { ...ARMS[rwf], role: true } : null;
}

/** Provider family a `vs.arm` label value routes a role-name spawn onto ("" = no arm / unknown). */
export function armProvider(wf) {
  return ARMS[String(wf ?? "").trim().toLowerCase()]?.provider ?? "";
}

/** Ladder tier a `vs.arm` label value routes a role-name spawn onto ("" = role default tier). */
export function armTier(wf) {
  return ARMS[String(wf ?? "").trim().toLowerCase()]?.tier ?? "";
}

/**
 * Route options a `vs.arm` label gives a role-name spawn: only arm-eligible roles (`Implement`, via ROLE_ARM_SOURCES)
 * take the arm's provider/tier; Review, Pre-check, Planner... never do, even when they inherit a vs.arm label.
 */
export function armRouteFor(roleName, wf) {
  if (!ROLE_ARM_SOURCES[roleArmKey(roleName)]) return { prefer: "", tier: "" };
  return { prefer: armProvider(wf), tier: armTier(wf) };
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

/** The uncapped arm with the lowest picks/weight; a tie keeps the requested arm, else the first in `arms` order. */
export function pickArm(requested, counts, { arms = IMPLEMENTER_ARMS, capped = new Set(), weights = ARM_WEIGHTS } = {}) {
  let best = null;
  for (const wf of arms) {
    if (capped.has(wf)) continue;
    const n = (counts?.[wf] ?? 0) / weightOf(weights, wf);
    if (!best || n < best.n || (n === best.n && wf === requested.wf)) best = { wf, n };
  }
  return best ? ARMS[best.wf] : null;
}

function splitHardCaps(caps) {
  if (!caps || Array.isArray(caps)) return caps ?? {};
  const hard = {};
  for (const [k, v] of Object.entries(caps)) {
    if (v && typeof v === "object" && v.soft === true) continue;
    hard[k] = v;
  }
  return hard;
}

function softReasonForArm(wf, caps, { role = false } = {}) {
  if (!caps || Array.isArray(caps)) return "";
  const fams = ARM_CAP_FAMILIES[wf] ?? [];
  const check = (k) => {
    const v = caps[k];
    return v && typeof v === "object" && v.soft === true && typeof v.reason === "string" ? v.reason : "";
  };
  if (role && wf === "sonnet") {
    for (const k of Object.keys(caps)) {
      if (String(k ?? "").trim().toLowerCase().split("/")[0] === "agy-claude") {
        const r = check(k);
        if (r) return r;
      }
    }
  }
  for (const k of Object.keys(caps)) {
    const fam = String(k ?? "").trim().toLowerCase().split("/")[0];
    if (fams.includes(fam) || ((wf === "neon" || wf === "flash") && fam.startsWith("gemini-"))) {
      const r = check(k);
      if (r) return r;
    }
  }
  return "";
}

/**
 * Decide the arm for a spawn. Returns null when this is not a stakes=normal implementer arm request (lead, no lane,
 * tierA-* / mechanical, any other profile, alternation off). Else { mode: "arm", arm, requestedArm, swapped, reason,
 * counts, profile, role?, provider? }: reason "pin" / "wf" (caller opted out: requested profile kept), "alternation" (fewest picks),
 * "capped:<family>" (a capped arm was skipped; both capped -> requested kept), "fail-open" (agent list or cap probe threw:
 * requested kept). `capProbe` -> capped map/array (readArmCaps). Never throws.
 */
export async function decideArm({ profile, stakes, asLead, labels = {}, lane, team, listAgents, capProbe, arms = IMPLEMENTER_ARMS, weights = ARM_WEIGHTS }) {
  if (asLead || !norm(lane)) return null;
  if ((norm(stakes) || "normal") !== "normal") return null;
  const requested = armOfProfile(profile);
  if (!requested) return null;
  const roleSpawn = requested.role === true;
  const interruptible = isInterruptibleWork({ stakes, kind: labels?.kind, role: profile });
  const keep = (reason, extra = {}) => ({ mode: "arm", arm: requested.wf, requestedArm: requested.wf, swapped: false, reason, counts: null, profile: String(profile), ...(roleSpawn ? { role: true } : {}), ...extra });
  const abVal = norm(labels.ab);
  const wfVal = norm(labels.wf);
  // R8: opt-in arms (e.g. flash) never join IMPLEMENTER_ARMS; requested via labels.ab or labels.wf, still cap-checked.
  const optInKey = abVal === "pin" ? "" : (ARMS[abVal]?.optIn ? abVal : (ARMS[wfVal]?.optIn ? wfVal : ""));
  if (optInKey) {
    const optInArm = ARMS[optInKey];
    if (!roleSpawn && !optInArm.profile) return keep("fail-open");
    let hardKey = "";
    let allKey = "";
    let rawCaps = {};
    try {
      rawCaps = capProbe ? await capProbe() : {};
      const hardCaps = splitHardCaps(rawCaps);
      hardKey = armCapKey(optInKey, hardCaps, { role: roleSpawn });
      allKey = interruptible ? hardKey : armCapKey(optInKey, rawCaps, { role: roleSpawn });
    } catch {
      return keep("fail-open"); // unreadable caps: never swap onto a possibly dead provider (idea-703)
    }
    if (hardKey) return keep(`capped:${hardKey}`, { capped: true });
    if (allKey && !armCapKey(requested.wf, rawCaps, { role: roleSpawn })) {
      const sr = softReasonForArm(optInKey, rawCaps, { role: roleSpawn }) || "soft quota: interruptible only";
      // C fu1 L3: a soft-line skip is not a cap: report soft (spawn_worker result.ab.soft), never capped.
      return keep(`${sr} -> ${requested.provider}`, { soft: true, softFailover: true });
    }
    const swapped = optInArm.wf !== requested.wf;
    const profileOut = swapped && !roleSpawn ? optInArm.profile : String(profile);
    return {
      mode: "arm", arm: optInArm.wf, requestedArm: requested.wf, swapped, reason: "opt-in", counts: null, profile: profileOut,
      ...(roleSpawn ? { role: true, provider: optInArm.provider, ...(optInArm.tier ? { tier: optInArm.tier } : {}) } : {}),
    };
  }
  const set = (Array.isArray(arms) ? arms : []).filter((wf) => ARMS[wf]);
  if (set.length < 2 || !set.includes(requested.wf)) return null;
  if (abVal === "pin") return keep("pin");
  if (wfVal) return keep("wf");
  let rawCaps;
  let hardCapped;
  let allCapped;
  try {
    rawCaps = capProbe ? await capProbe() : {};
    const hardCaps = splitHardCaps(rawCaps);
    hardCapped = new Map(set.map((wf) => [wf, armCapKey(wf, hardCaps, { role: roleSpawn })]).filter(([, k]) => k));
    allCapped = interruptible
      ? hardCapped
      : new Map(set.map((wf) => [wf, armCapKey(wf, rawCaps, { role: roleSpawn })]).filter(([, k]) => k));
  } catch {
    return keep("fail-open"); // unreadable caps: never swap onto a possibly dead provider (idea-703)
  }
  let counts;
  try {
    counts = countArms(await listAgents(), { lane, team, arms: set });
  } catch {
    return keep("fail-open");
  }
  const free = pickArm(requested, counts, { arms: set, weights });
  // Pass 1: prefer an arm under both hard and soft lines.
  let arm = pickArm(requested, counts, { arms: set, capped: new Set(allCapped.keys()), weights });
  let usedHardFallback = false;
  if (!arm) {
    // Pass 2: every arm is past soft (or hard). Fall back to hard caps only so we don't strand the spawn.
    arm = pickArm(requested, counts, { arms: set, capped: new Set(hardCapped.keys()), weights });
    usedHardFallback = true;
    if (!arm) return keep(`capped:${[...hardCapped.values()].join("+")}`, { counts, capped: true }); // every arm hard-capped
  }
  // The reason names a cap/soft line only when it changed the outcome (the uncapped pick was skipped).
  let reason = "alternation";
  let softFailover = false;
  if (free.wf !== arm.wf) {
    if (usedHardFallback || hardCapped.has(free.wf)) {
      reason = `capped:${hardCapped.get(free.wf)}`;
    } else {
      const sr = softReasonForArm(free.wf, rawCaps, { role: roleSpawn }) || "soft quota: interruptible only";
      reason = `${sr} -> ${arm.provider}`;
      softFailover = true;
    }
  }
  const swapped = arm.wf !== requested.wf;
  // A role spawn keeps its role name: the arm only picks the provider (`provider`), the ladder picks the model.
  const profileOut = swapped && !roleSpawn ? arm.profile : String(profile);
  return {
    mode: "arm", arm: arm.wf, requestedArm: requested.wf, swapped, reason, counts, profile: profileOut,
    ...(roleSpawn ? { role: true, provider: arm.provider } : {}),
    ...(reason !== "alternation" && !softFailover ? { capped: true } : {}),
    ...(softFailover ? { soft: true, softFailover: true } : {}),
  };
}
