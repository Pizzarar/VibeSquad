import type { PaseoAgent } from "@getpaseo/client";

export type RenamePlan = { name: string; labels?: Record<string, string> };

/** The text the inline editor starts with: the agent's current title. */
export const renameDraftFor = (agent: PaseoAgent): string => agent.title ?? "";

/** What to send to updateAgent for a new name: free-form rename without overwriting the user's chosen title. */
export function planAgentRename(agent: PaseoAgent, next: string): RenamePlan {
  return { name: next.trim() || (agent.title ?? "") };
}
