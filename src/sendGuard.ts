// Send guard: the pure logic behind AgentDrawer's send. No React, no Paseo: test/send-guard.test.mjs runs it under plain node.
// A synchronous lock (not React state, which a same-tick second keydown can't see) plus optimistic clear with restore on failure.

export type SendLock = { held: boolean };

export const createSendLock = (): SendLock => ({ held: false });

/** Take the lock synchronously. False means a send is already in flight: the caller must do nothing. */
export function tryAcquire(lock: SendLock): boolean {
  if (lock.held) return false;
  lock.held = true;
  return true;
}

/** Text to put back after a failed send: keeps anything typed meanwhile instead of overwriting it. */
export function restoredDraft(sent: string, typedSince: string): string {
  return typedSince.trim() ? `${sent}\n${typedSince}` : sent;
}

export type GuardedSend<T> = {
  lock: SendLock;
  /** Empty the box now (optimistic). Runs after the lock is taken, before the first await. */
  clear: () => void;
  /** Do the work. Resolve with a value, or `undefined` to mean "nothing was sent": the text is restored. */
  run: () => Promise<T | undefined>;
  /** Put the text back (failure, or nothing was sent). */
  restore: () => void;
  onError: (e: unknown) => void;
};

/** Runs at most one send at a time. Returns false when it was dropped by the lock. */
export async function guardedSend<T>(g: GuardedSend<T>): Promise<boolean> {
  if (!tryAcquire(g.lock)) return false;
  g.clear();
  try {
    const r = await g.run();
    if (r === undefined) g.restore();
  } catch (e) {
    g.restore();
    g.onError(e);
  } finally {
    g.lock.held = false;
  }
  return true;
}
