// Chat inline code that is exactly one commit hash becomes a link into the Changes panel. Pure, so node --test can load it.
// Needs an a-f letter: a pure-digit token (1234567, 86400000, 20261107) is a number, not a hash.
const COMMIT_TOKEN_RE = /^(?=[0-9]*[a-f])[0-9a-f]{7,40}$/i;

/** The hash if the whole backtick span is a standalone 7-40 hex token, else null. Never matches hex inside longer code. */
export function parseCommitToken(code: string): string | null {
  return COMMIT_TOKEN_RE.test(code) ? code : null;
}
