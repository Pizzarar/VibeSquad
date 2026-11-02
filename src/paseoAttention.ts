// Bridge between Paseo's attention events/flags and VS's own attention model (additive: the snapshot
// path in useAttentionAlerts and attentionItems stay the source of truth).
import { useEffect, useRef } from "react";
import { daemonClient, DEMO, getPaseoState } from "./paseo";
import { alertEnabled, getPrefs } from "./prefs";
import { playAlertChime } from "./notifications";
import { attentionOf, type Member } from "./teams";
import { createAlertDedupe, decideEvent, workspaceToClear, type AlertTone } from "./paseoAttentionCore";

const dedupe = createAlertDedupe();

/** Shared claim for both alert paths; false means the other path already alerted for this agent/tone. */
export const claimAlert = (agentId: string, tone: AlertTone): boolean => dedupe.claim(agentId, tone, Date.now());

/** Subscribe to the daemon's attention event; alerts through the same prefs/chime as the snapshot path. */
export function usePaseoAttention(members: Member[]) {
  const ref = useRef(members);
  ref.current = members;
  useEffect(() => {
    if (DEMO) return;
    return daemonClient.onAgentAttentionRequired((ev) => {
      const prefs = getPrefs();
      if (decideEvent(ev, (t) => alertEnabled(t, prefs)) !== "alert") return;
      if (!claimAlert(ev.agentId, ev.reason)) return;
      const m = ref.current.find((x) => x.agent.id === ev.agentId);
      if ("Notification" in window && Notification.permission === "granted") {
        const title = m ? `${m.team.name}: ${m.agent.title ?? "agent"}` : (ev.notification?.title ?? "Agent needs you");
        new Notification(title, { body: m?.attention?.reason ?? ev.notification?.body ?? ev.reason, tag: ev.agentId });
      }
      if (prefs["notify.sound"]) playAlertChime();
    });
  }, []);
}

/** Best effort: after VS clears an agent, clear Paseo's workspace flag if nothing else there needs you. */
export async function clearWorkspaceIfQuiet(agentId: string): Promise<void> {
  if (DEMO) return;
  const agents = [...getPaseoState().agents.values()] as Array<{ id: string; workspaceId?: string }>;
  const ws = workspaceToClear(agentId, agents, (a) => {
    const full = a as unknown as Parameters<typeof attentionOf>[0];
    return !(full as { archivedAt?: unknown }).archivedAt && full.status !== "closed" && !!attentionOf(full);
  });
  if (!ws) return;
  try {
    await daemonClient.clearWorkspaceAttention(ws);
  } catch (err) {
    console.warn("clearWorkspaceAttention failed", err);
  }
}
