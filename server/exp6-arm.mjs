// EXP6 arm pick (idea-440): the server alternates stakes=normal implementer spawns between `Implement - Sonnet` (wf=sonnet) and
// `Work Order - DSP` (wf=dsp) per lane, so the alternation survives lead handoffs. Pure functions; the caller injects the
// agent list and the experiment-verdict probe. Everything fails open: any error keeps the requested profile.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXP6_SINCE = "2026-11-19T00:00:00Z";
export const EXP6_DEFAULT_END = "2026-11-27T00:00:00Z";
export const EXP6_ARMS = {
  "implement - sonnet": { profile: "Implement - Sonnet", wf: "sonnet" },
  "work order - dsp": { profile: "Work Order - DSP", wf: "dsp" },
};
const WF_TO_ARM = { sonnet: EXP6_ARMS["implement - sonnet"], dsp: EXP6_ARMS["work order - dsp"] };

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

/** Read the perfection lane log from disk (newest verdict probe). Throws on unreadable input; callers fail open. */
export function readPerfectionVerdict({ team = "vibesquad", home = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad") } = {}) {
  const path = join(home, "logs", `${team}--perfection.jsonl`);
  if (!existsSync(path)) return false;
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("erdict")) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return hasVerdictEntry(entries);
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Per-wf counts of normal-stakes worker spawns in `lane` since `since`. Agents: records with labels + createdAt. */
export function countArms(agents, { lane, since = EXP6_SINCE } = {}) {
  const floor = Date.parse(since);
  const counts = { sonnet: 0, dsp: 0 };
  for (const a of agents ?? []) {
    const l = a?.labels ?? {};
    if (norm(l.lane) !== norm(lane)) continue;
    if (norm(l.role) && norm(l.role) !== "worker") continue;
    if ((norm(l.stakes) || "normal") !== "normal") continue;
    const t = Date.parse(a.createdAt);
    if (Number.isFinite(floor) && Number.isFinite(t) && t < floor) continue;
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

/**
 * Decide the arm for a spawn. Returns null when the pick does not apply (not worker/normal/arm profile, pinned, closed),
 * else { arm, swapped, counts, profile }. A throwing agent list or verdict probe fails open: the requested profile, no throw.
 */
export async function decideArm({ profile, stakes, asLead, labels = {}, lane, listAgents, verdictProbe, now = Date.now(), endIso }) {
  const requested = armOfProfile(profile);
  if (!requested || asLead) return null;
  if ((norm(stakes) || "normal") !== "normal") return null;
  if (norm(labels.wf) || norm(labels.ab) === "pin") return null;
  try {
    const verdict = verdictProbe ? await verdictProbe() : false;
    if (!experimentOpen({ now, endIso, verdict })) return null;
  } catch {
    return null;
  }
  let counts;
  try {
    counts = countArms(await listAgents(), { lane });
  } catch {
    return { arm: requested.wf, swapped: false, counts: null, profile: requested.profile, failOpen: true };
  }
  const arm = pickArm(requested, counts);
  return { arm: arm.wf, swapped: arm !== requested, counts, profile: arm.profile };
}
