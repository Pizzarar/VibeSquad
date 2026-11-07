// Shared alert dedupe for the snapshot-path alerts (useAttentionAlerts and attentionItems).
import { createAlertDedupe, type AlertTone } from "./paseoAttentionCore";

const dedupe = createAlertDedupe();

/** Shared claim for both alert paths; false means the other path already alerted for this agent/tone. */
export const claimAlert = (agentId: string, tone: AlertTone): boolean => dedupe.claim(agentId, tone, Date.now());
