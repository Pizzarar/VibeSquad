import { useEffect, useState, useSyncExternalStore } from "react";
import { alternativeText, approvalText, decisionFromEntries, type DecisionOffer } from "./decisionLogic";
import { dismissDecision, dismissedVersion, isDecisionDismissed, subscribeDismissed } from "./pinActions";
import { clearNeedsYou, getPaseoState, sendMessage } from "./paseo";
import { openBuddy } from "./phoneCockpitLogic";

// E2: one-tap Overlord escalation. "pin" sits above the Overlord chat on the phone; "inline" replaces the raw fence in the Timeline.
// Both share one dismissal id, so acting on either hides both (and on every device, via the dismissed-cards store).

type Props = { agentId: string; offer: DecisionOffer; variant?: "pin" | "inline" };

async function sendAndClear(agentId: string, text: string): Promise<void> {
  await sendMessage(agentId, text);
  const agent = getPaseoState().agents.get(agentId);
  const needs = (agent?.labels as Record<string, string> | undefined)?.["needs-you"];
  if (agent && needs && needs !== "cleared") await clearNeedsYou(agent, { optimistic: true }).catch(() => undefined);
}

export function DecisionCard({ agentId, offer, variant = "pin" }: Props) {
  const dv = useSyncExternalStore(subscribeDismissed, dismissedVersion);
  const [hidden, setHidden] = useState(() => isDecisionDismissed(offer.id));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setHidden(isDecisionDismissed(offer.id));
    setOpen(false);
    setErr("");
  }, [offer.id, dv]);
  if (hidden) return null;

  const act = async (text: string) => {
    setBusy(true);
    setErr("");
    try {
      await sendAndClear(agentId, text);
      dismissDecision(offer.id);
      setHidden(true);
    } catch (e) {
      setErr(`Could not send: ${(e as Error)?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };
  const replyMyself = () => document.querySelector<HTMLTextAreaElement>(".composer-row textarea")?.focus();

  return (
    <section className={`decision-card ${variant}`} data-testid={`decision-card-${variant}`} aria-label="Overlord decision">
      <p className="dc-summary" data-testid="decision-summary">{offer.summary}</p>
      <div className="dc-actions">
        <button type="button" className="btn dc-primary" data-testid="decision-do" disabled={busy} onClick={() => void act(approvalText(offer))}>
          ✓ Do obvious fix: {offer.action}
        </button>
        {offer.riffLane && (
          <button type="button" className="btn dc-riff" data-testid="decision-riff" onClick={() => openBuddy(offer.riffLane!)}>
            Riff with @{offer.riffLane} Buddy →
          </button>
        )}
        <button type="button" className="btn ghost small dc-more" data-testid="decision-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "▴" : "▾"} Worse / other options ({offer.alternatives.length})
        </button>
        {open && (
          <div className="dc-alts" data-testid="decision-alts">
            {offer.alternatives.map((a) => (
              <button key={a} type="button" className="btn dc-alt" disabled={busy} onClick={() => void act(alternativeText(a))}>
                {a}
              </button>
            ))}
            <button type="button" className="btn ghost dc-alt" data-testid="decision-reply" onClick={replyMyself}>
              Reply myself…
            </button>
            <button type="button" className="btn ghost small dc-alt" data-testid="decision-dismiss" onClick={() => { dismissDecision(offer.id); setHidden(true); }}>
              Dismiss
            </button>
          </div>
        )}
      </div>
      {err && <div className="dc-err" role="alert">{err}</div>}
    </section>
  );
}

/** Pinned above the Overlord chat: the decision in the newest assistant message, if still undismissed. */
export function DecisionPin({ agentId, entries }: { agentId: string; entries: Parameters<typeof decisionFromEntries>[1] }) {
  const offer = decisionFromEntries(agentId, entries);
  return offer ? <DecisionCard agentId={agentId} offer={offer} variant="pin" /> : null;
}
