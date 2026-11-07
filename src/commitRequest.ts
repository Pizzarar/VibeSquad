// "Open this commit's diff in Changes": a one-slot request the Changes panel consumes (live via subscribe, or on mount if the
// dock was closed when it was made). Pure, so node --test can load it. Callers use openCommit() in changesNav.ts.
export type CommitRequest = { cwd: string; sha: string; nonce: number };
export const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,64}$/;

let pending: CommitRequest | null = null;
let nonce = 0;
const listeners = new Set<(r: CommitRequest) => void>();

/** Records a request (null if `sha` is not 7-64 hex) and tells live panels. */
export function requestCommit(cwd: string, sha: string): CommitRequest | null {
  if (!cwd || !COMMIT_SHA_RE.test(sha)) return null;
  pending = { cwd, sha, nonce: ++nonce };
  for (const l of [...listeners]) l(pending);
  return pending;
}

/** Takes the pending request for `cwd` (a request for another folder is left in place). */
export function takeCommitRequest(cwd: string): CommitRequest | null {
  if (!pending || pending.cwd !== cwd) return null;
  const r = pending;
  pending = null;
  return r;
}

export function onCommitRequest(fn: (r: CommitRequest) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
