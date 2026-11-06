// Right-rail lead check-ins (docs/PLAN_RAIL_CHECKIN.md). Pure logic: the rail asks the lead directly
// instead of making the Buddy relay the question.
import type { Pin } from "./pins";

export const CHECKIN_PROMPT = "Check-in from Aub: status in 3 lines: done / doing / blocked.";
export const CHECKIN_BUSY_NOTE = "Lead's heads-down, working away. Check back later.";
export const CHECKIN_BUSY_MS = 2500;

export type CheckinAction = "send" | "busy" | "none";

export function checkinAction(pin: Pick<Pin, "lead">): CheckinAction {
  const lead = pin.lead;
  if (!lead || lead.agent.status === "closed") return "none";
  return lead.agent.status === "running" ? "busy" : "send";
}

/** Status line for a tile / the Active card: the lead's last line, or why there is none. */
export function leadLine(pin: Pick<Pin, "lead">, last?: { who: string; text: string } | null): string {
  if (!pin.lead) return "No lead running";
  return `Lead · ${last ? last.text : "No messages yet"}`;
}

export async function runCheckin(
  pin: Pick<Pin, "lead">,
  deps: { open: (agentId: string) => void; send: (agentId: string, text: string) => Promise<void> },
): Promise<CheckinAction> {
  const action = checkinAction(pin);
  if (action !== "send" || !pin.lead) return action;
  const id = pin.lead.agent.id;
  deps.open(id);
  await deps.send(id, CHECKIN_PROMPT);
  return action;
}
