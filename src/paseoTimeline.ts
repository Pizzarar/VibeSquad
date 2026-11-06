import { daemonClient } from "./paseo";
import { DEMO } from "./demoFlag";
import type { SearchLocation } from "./timelineFilter";

export type TimelinePrompt = { seq: number; timestamp: string; preview: string };

/** Transcript search; follows nextCursor up to a few pages. */
export async function searchTimeline(agentId: string, query: string): Promise<SearchLocation[]> {
  if (DEMO || !query.trim()) return [];
  const out: SearchLocation[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await daemonClient.searchAgentTimeline({ agentId, query, cursor });
    if (res.error) throw new Error(res.error);
    out.push(...res.locations);
    if (res.nextCursor == null) break;
    cursor = res.nextCursor;
  }
  return out;
}

export async function listTimelinePrompts(agentId: string): Promise<TimelinePrompt[]> {
  if (DEMO) return [];
  const res = await daemonClient.listAgentTimelinePrompts(agentId);
  if (res.error) throw new Error(res.error);
  return res.prompts;
}
