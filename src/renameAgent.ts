import type { PaseoAgent } from "@getpaseo/client";
import { expectedV2TitleFor, kindOf } from "./teams.ts";

export type RenamePlan = { name: string; labels?: Record<string, string> };

const labelsOf = (a: PaseoAgent): Record<string, string> => (a.labels ?? {}) as Record<string, string>;

// Lane-coded agents (★ Hub5 · job / Hub Buddy · topic / Hub · job) derive their title from the lane code plus a
// job or topic label, and the title lint flags anything else. Renaming one edits that label and lets the
// title follow; every other agent just takes the typed name. Decided from the labels, never from whether a
// title can be computed (a worker with no job yet is still lane-coded).
const labelKeyFor = (agent: PaseoAgent): "job" | "topic" | null => {
  const l = labelsOf(agent);
  if (!(l.lane ?? l.lead)) return null;
  const role = l.role ?? (kindOf(agent) === "lead" ? "lead" : kindOf(agent) === "brainstorm" ? "brainstorm" : undefined);
  if (role === "brainstorm") return "topic";
  return role === "lead" || role === "worker" ? "job" : null;
};

/** The text the inline editor starts with: the job/topic for lane-coded agents, else the full title. */
export const renameDraftFor = (agent: PaseoAgent): string => {
  const key = labelKeyFor(agent);
  return key ? (labelsOf(agent)[key] ?? "") : (agent.title ?? "");
};

/** What to send to updateAgent for a new name. Lane-coded agents keep the code and ordinal in the title. */
export function planAgentRename(agent: PaseoAgent, next: string): RenamePlan {
  const key = labelKeyFor(agent);
  if (!key) return { name: next };
  const labels = { ...labelsOf(agent), [key]: next };
  const name = expectedV2TitleFor({ ...agent, labels } as PaseoAgent);
  return { name: name ?? next, labels };
}
