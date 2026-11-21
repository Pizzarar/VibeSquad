// idea-170 + idea-175: reviewer verdict lines are handled in code, never paraphrased.
// A reviewer's verdict is one line: `PASS|FAIL H/M/L <tip-hash>` (e.g. "FAIL 1/0/1 3528a4c"). The digest's team-log entry
// starts with that line copied byte-for-byte from the worker's final message (the digest's own PASS/FAIL word never wins),
// and `vs verdict <reviewer> --branch <b>` gates a merge on the reviewer's own FIRST line matching the branch tip.

/** A verdict line anywhere in a message (multiline): `PASS|FAIL H/M/L <hash>` at the start of a line. */
export const VERDICT_LINE_RE = /^(PASS|FAIL) \d+\/\d+\/\d+ [0-9a-f]{7,40}/m;
/** The strict parse of one line (the gate reads only the reviewer's first line). */
const LINE_PARSE_RE = /^(PASS|FAIL) (\d+)\/(\d+)\/(\d+) ([0-9a-f]{7,40})(?![0-9A-Za-z])/;
const NON_IMPLEMENTER_REVIEW_PROFILE_RE = /^Review\b/i;
const UX_REVIEWER_RE = /\bUX Review(?:er)?\b/i;
const REVIEWER_TITLE_RE = /\b(?:re-?review|reviewer)\b|(?:^|[·:\s-])review(?:\s|$)/i;

/** The full verdict line (byte-for-byte, minus a trailing \r) of the first `PASS|FAIL H/M/L <hash>` line in `text`, or null. */
export function extractVerdictLine(text) {
  const s = String(text ?? "");
  const m = VERDICT_LINE_RE.exec(s);
  if (!m) return null;
  const end = s.indexOf("\n", m.index);
  return s.slice(m.index, end < 0 ? s.length : end).replace(/\r$/, "");
}

/** Parses one line as a verdict: { verdict, high, medium, low, hash } or null. */
export function parseVerdictLine(line) {
  const m = LINE_PARSE_RE.exec(String(line ?? ""));
  if (!m) return null;
  return { verdict: m[1], high: Number(m[2]), medium: Number(m[3]), low: Number(m[4]), hash: m[5] };
}

/** idea-300: stamp ` reviewer=<profile>` right after the `PASS|FAIL H/M/L <hash>` prefix of a verdict line. The gate still
 * parses the prefix (the stamp is trailing); the line is unchanged when there is no profile or no verdict prefix. */
function stampReviewer(line, profile) {
  const p = String(profile ?? "").trim();
  if (!p) return line;
  const m = LINE_PARSE_RE.exec(String(line ?? ""));
  if (!m) return line;
  return `${m[0]} reviewer=${p}${line.slice(m[0].length)}`;
}

/** The first non-blank line of a message (trailing whitespace dropped), "" when there is none. */
export function firstLine(text) {
  for (const l of String(text ?? "").split(/\r?\n/)) if (l.trim()) return l.replace(/\s+$/, "");
  return "";
}

/** idea-265: provider transport lines (e.g. "⚠ API error (attempt 1): ... EOF") that may precede the verdict; skipped by the gate. */
const TRANSPORT_NOISE_RE = /^[\s⚠️!*>-]*(?:API error\b|(?:transport|network|connection|stream) error\b|(?:Retrying|Reconnecting)\b|(?:read|write) tcp\b|unexpected EOF\b|EOF\s*$)/i;

/** The first non-blank line that is not provider transport noise (the gate's verdict line). */
export function gateLine(text) {
  for (const l of String(text ?? "").split(/\r?\n/)) {
    if (!l.trim() || TRANSPORT_NOISE_RE.test(l)) continue;
    return l.replace(/\s+$/, "");
  }
  return "";
}

/** A reviewer run: a `Review - …` profile, or a reviewer-shaped title ("Review - Gemini", "re-review", "R2 review"). */
export function isReviewerAgent(agent) {
  const labels = agent?.labels ?? {};
  const profile = String(labels.profile ?? agent?.profile ?? "").trim();
  const title = String(agent?.title ?? "").trim();
  // UX Reviewer is not a code reviewer: its verdict is a plain PASS/FAIL line in docs/UX_REVIEW_R<n>.md (no H/M/L <hash>),
  // so it is excluded here; its digest is not rewritten to NO-VERDICT and `vs verdict` says "not a reviewer".
  if (UX_REVIEWER_RE.test(profile) || UX_REVIEWER_RE.test(title)) return false;
  if (NON_IMPLEMENTER_REVIEW_PROFILE_RE.test(profile)) return true;
  if (/\breview\s+fix/i.test(title)) return false; // an implementer fixing review findings
  return NON_IMPLEMENTER_REVIEW_PROFILE_RE.test(title) || REVIEWER_TITLE_RE.test(title);
}

const LEAD_WORD_RE = /^\s*(PASS|FAIL)\b\s*:?\s*/;

/**
 * The team-log text for a digest's `done` entry, with the verdict taken from the worker's own message in code:
 * - the worker's message has a verdict line: the entry starts with that line byte-for-byte, then the digest's summary.
 *   When the digest's own PASS/FAIL word disagrees, the line still wins and the entry is marked VERDICT-MISMATCH.
 * - no verdict line and the worker is a reviewer: "NO-VERDICT: <summary>" (never a PASS).
 * - otherwise the digest's text is unchanged.
 * Returns { text, verdictLine, mismatch, noVerdict }.
 */
export function digestVerdictText({ workerText, digestText, reviewer = false, profile = null }) {
  const digest = String(digestText ?? "").trim();
  const line = extractVerdictLine(workerText);
  const lead = LEAD_WORD_RE.exec(digest);
  const digestWord = lead ? lead[1] : (/\b(PASS|FAIL)\b/.exec(digest)?.[1] ?? null);
  const summary = (lead ? digest.slice(lead[0].length) : digest).trim();
  if (line) {
    const stamped = stampReviewer(line, profile);
    const word = line.slice(0, 4);
    if (digest.startsWith(line)) {
      // idea-300: a digest that already copies the verdict line verbatim (the prompt's happy path) must still carry the
      // reviewer stamp; stamp it here (guarding against double-stamp) so every path emits `reviewer=<profile>`.
      const text = !/\breviewer=/.test(digest) ? stampReviewer(digest, profile) : digest;
      return { text, verdictLine: line, mismatch: false, noVerdict: false };
    }
    const mismatch = Boolean(digestWord && digestWord !== word);
    const rest = mismatch ? `VERDICT-MISMATCH: digest said ${digestWord}, the reviewer's line wins${summary ? `; ${summary}` : ""}` : summary;
    return { text: rest ? `${stamped} — ${rest}` : stamped, verdictLine: line, mismatch, noVerdict: false };
  }
  if (reviewer) {
    return { text: `NO-VERDICT: ${summary || "reviewer's final message has no PASS|FAIL H/M/L <hash> line"}`, verdictLine: null, mismatch: false, noVerdict: true };
  }
  return { text: digest, verdictLine: null, mismatch: false, noVerdict: false };
}

/** Exit codes of `vs verdict`: 0 only for a PASS whose hash is a prefix of the branch tip. */
export const GATE_EXIT = { pass: 0, fail: 1, noVerdict: 2, staleHash: 3, notReviewer: 4, noBranch: 5 };

/**
 * The merge gate (idea-170): the reviewer's own FIRST line must be `PASS H/M/L <hash>` and `hash` a prefix of `tip`.
 * `agent`: the reviewer's record ({ title, labels }); `lastMessage`: its last assistant message (uncapped); `tip`: the
 * full `git rev-parse <branch>`. Returns { code, ok, line, reason }.
 */
export function evaluateVerdictGate({ agent, lastMessage, tip, branch = "" }) {
  const line = gateLine(lastMessage);
  const out = (code, reason) => ({ code, ok: code === GATE_EXIT.pass, line, reason });
  if (!isReviewerAgent(agent)) {
    const who = `${agent?.id ?? "?"} ("${agent?.title ?? ""}"${agent?.labels?.profile ? `, profile ${agent.labels.profile}` : ""})`;
    return out(GATE_EXIT.notReviewer, `not a reviewer: ${who} has no Review profile or reviewer title`);
  }
  const v = parseVerdictLine(line);
  if (!v) return out(GATE_EXIT.noVerdict, "no verdict line: the reviewer's first line is not `PASS|FAIL H/M/L <hash>`");
  if (v.verdict !== "PASS") return out(GATE_EXIT.fail, `FAIL: the reviewer failed ${v.hash} (${v.high}/${v.medium}/${v.low})`);
  const t = String(tip ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(t)) return out(GATE_EXIT.noBranch, `branch ${branch || "?"} did not resolve to a commit`);
  if (!t.startsWith(v.hash.toLowerCase())) {
    return out(GATE_EXIT.staleHash, `hash mismatch (stale review): reviewed ${v.hash}, ${branch || "branch"} tip is ${t.slice(0, 12)}`);
  }
  return out(GATE_EXIT.pass, `PASS on ${branch || "branch"} tip ${t.slice(0, 12)}`);
}
