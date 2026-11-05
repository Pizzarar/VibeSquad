// Optimistic user messages: shown the instant the user sends, reconciled against the daemon's
// user_message timeline entry (no duplicate), flipped to "failed" when the send RPC rejects.
// Pure helpers + a tiny external store; no daemon imports so node --test can load it.

export type PendingSend = { id: string; agentId: string; text: string; at: number; state: "pending" | "failed"; error?: string };
type Ent = { item: any; timestamp?: string };

let seq = 0;
let all: PendingSend[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const subscribePending = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const getPending = () => all;
export const pendingFor = (list: PendingSend[], agentId: string) => list.filter((p) => p.agentId === agentId);

export function addPending(agentId: string, text: string, now = Date.now()): string {
  const id = `pending-${now}-${++seq}`;
  all = [...all, { id, agentId, text, at: now, state: "pending" }];
  emit();
  return id;
}
export function failPending(id: string, error: string): void {
  all = all.map((p) => (p.id === id ? { ...p, state: "failed", error } : p));
  emit();
}
export function retryPending(id: string, now = Date.now()): PendingSend | undefined {
  const p = all.find((x) => x.id === id);
  if (!p) return undefined;
  all = all.map((x) => (x.id === id ? { ...x, state: "pending", error: undefined, at: now } : x));
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

/**
 * Match each still-pending (not failed) message to a distinct daemon user_message with the same text
 * that arrived at/after the send. Returns the ids that the timeline now covers.
 */
export function reconciledIds(pending: PendingSend[], entries: Ent[]): string[] {
  const used = new Set<number>();
  const out: string[] = [];
  for (const p of pending) {
    if (p.state !== "pending") continue;
    const want = p.text.trim();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (used.has(i) || e.item?.type !== "user_message" || String(e.item.text ?? "").trim() !== want) continue;
      const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!Number.isNaN(t) && t < p.at - CLOCK_SKEW_MS) continue;
      used.add(i);
      out.push(p.id);
      break;
    }
  }
  return out;
}
