// Optimistic user messages: shown the instant the user sends, reconciled against the daemon's
// user_message timeline entry (no duplicate), flipped to "failed" when the send RPC rejects.
// Pure helpers + a tiny external store; no daemon imports so node --test can load it.

export type PendingSend = { id: string; agentId: string; text: string; at: number; state: "pending" | "failed"; error?: string; baselineSeq: number | null; delivered: boolean };
type Ent = { item: any; timestamp?: string; seqStart?: number };

let seq = 0;
let all: PendingSend[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const subscribePending = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const getPending = () => all;

// Newest timeline seq each mounted Timeline has seen: a send records it as its baseline, so a user_message past it is the send's own.
const agentSeq = new Map<string, number>();
export function noteAgentSeq(agentId: string, seq: number | null): void {
  if (seq != null && seq > (agentSeq.get(agentId) ?? -1)) agentSeq.set(agentId, seq);
}
export const pendingFor = (list: PendingSend[], agentId: string) => list.filter((p) => p.agentId === agentId);

export function addPending(agentId: string, text: string, now = Date.now()): string {
  const id = `pending-${now}-${++seq}`;
  all = [...all, { id, agentId, text, at: now, state: "pending", baselineSeq: agentSeq.get(agentId) ?? null, delivered: false }];
  emit();
  return id;
}
/** The send RPC resolved: the runner has the message, so a newer user_message in the timeline is it, whatever its text. */
export function markDelivered(id: string): void {
  all = all.map((p) => (p.id === id ? { ...p, delivered: true } : p));
  emit();
}
export function failPending(id: string, error: string): void {
  all = all.map((p) => (p.id === id ? { ...p, state: "failed", error } : p));
  emit();
}
export function retryPending(id: string, now = Date.now()): PendingSend | undefined {
  const p = all.find((x) => x.id === id);
  if (!p) return undefined;
  all = all.map((x) => (x.id === id ? { ...x, state: "pending", error: undefined, at: now, delivered: false, baselineSeq: agentSeq.get(x.agentId) ?? null } : x));
  emit();
  return p;
}
export function dismissPending(id: string): void {
  all = all.filter((p) => p.id !== id);
  emit();
}
export function dropReconciled(ids: string[]): void {
  if (!ids.length) return;
  all = all.filter((p) => !ids.includes(p.id));
  emit();
}
export function resetPending(): void {
  all = [];
  emit();
}

const CLOCK_SKEW_MS = 5000;
/** Timeline.tsx fetches the newest 60 entries; a full window is the only one that can have scrolled a message out. */
const TAIL_WINDOW = 60;

/**
 * Match each still-pending (not failed) message to a distinct daemon user_message with the same text
 * that arrived at/after the send. Returns the ids that the timeline now covers.
 */
export function reconciledIds(pending: PendingSend[], entries: Ent[]): string[] {
  const used = new Set<number>();
  const out: string[] = [];
  const firstSeq = entries.reduce<number | null>((m, e) => (e.seqStart != null && (m === null || e.seqStart < m) ? e.seqStart : m), null);
  for (const p of pending) {
    if (p.state !== "pending") continue;
    const want = p.text.trim();
    let hit = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (used.has(i) || e.item?.type !== "user_message" || String(e.item.text ?? "").trim() !== want) continue;
      const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!Number.isNaN(t) && t < p.at - CLOCK_SKEW_MS) continue;
      hit = i;
      break;
    }
    // Delivered but the text did not match (hook rewrote it, clock skew): the oldest user_message past the send's baseline is it.
    if (hit < 0 && p.delivered && p.baselineSeq != null) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!used.has(i) && e.item?.type === "user_message" && e.seqStart != null && e.seqStart > p.baselineSeq) {
          hit = i;
          break;
        }
      }
      // The tail window now starts after the baseline: the message landed and scrolled out of the window.
      if (hit < 0 && entries.length >= TAIL_WINDOW && firstSeq !== null && firstSeq > p.baselineSeq) {
        out.push(p.id);
        continue;
      }
    }
    if (hit >= 0) {
      used.add(hit);
      out.push(p.id);
    }
  }
  return out;
}
