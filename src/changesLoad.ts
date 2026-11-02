// Changes tab load guard (docs/PLAN_BUGS_BATCH2.md block 4). The daemon can take 15-50s to answer a diff
// subscription on a busy machine (measured 2026-11-02: VibeSquad repo 15-24s, unknown cwd 50s), and a failed
// subscription used to land on an empty "No uncommitted changes". Now: a "still loading" hint, a hard timeout, an error with Retry.

export const CHANGES_SLOW_MS = 8_000;
export const CHANGES_TIMEOUT_MS = 40_000;

/** Reject if `p` has not settled within `ms`, so the tab never spins forever. */
export function withTimeout<T>(p: Promise<T>, ms: number = CHANGES_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`The daemon did not answer within ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** One-line message for the Changes tab error state. */
export function changesErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.trim() || "Could not load changes";
}
