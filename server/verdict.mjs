// idea-170 + idea-175: reviewer verdict lines are handled in code, never paraphrased.
// A reviewer's verdict is one line: `PASS|FAIL H/M/L <tip-hash>` (e.g. "FAIL 1/0/1 3528a4c"). The digest's team-log entry
// starts with that line copied byte-for-byte from the worker's final message (the digest's own PASS/FAIL word never wins),
// and `vs verdict <reviewer> --branch <b>` gates a merge on the reviewer's own first-or-last line matching the branch tip.

/**
 * A reviewer's verdict line. Canonical form: `PASS|FAIL H/M/L <hash>` with numeric counts
 * (e.g. "FAIL 1/0/1 3528a4c"). Accepted variants: a single highest-severity letter instead of
 * the counts (`PASS H abc123`), an optional `VERDICT:` prefix, and markdown bold markers (`**...**`).
 * `VERDICT_CORE` captures (1) PASS|FAIL, (2) `h/m/l` counts or the highest-severity letter, (3) the hash.
 */
const VERDICT_CORE = "(PASS|FAIL)[ \\t]+(\\d+\\/\\d+\\/\\d+|[HhMmLl])[ \\t]+([0-9a-f]{7,40})(?![0-9a-zA-Z])";
const VERDICT_LINE_SRC = `^[ \\t]*(?:\\*\\*|__)?[ \\t]*(?:VERDICT[ \\t]*:[ \\t]*)?${VERDICT_CORE}`;
/** A verdict line anywhere in a message (multiline): the core at the start of a line, tolerating a `VERDICT:` prefix and bold. */
export const VERDICT_LINE_RE = new RegExp(VERDICT_LINE_SRC, "m");
/** The strict parse of one line (the gate reads the reviewer's first or last line). */
const LINE_PARSE_RE = new RegExp(VERDICT_LINE_SRC);
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

/** Parses one line as a verdict: { verdict, high, medium, low, severity, hash } or null. The letter form
 * (`PASS H abc123`) leaves the counts null and sets `severity` to the highest-severity letter. */
export function parseVerdictLine(line) {
  const m = LINE_PARSE_RE.exec(String(line ?? ""));
  if (!m) return null;
  const verdict = m[1];
  const sev = m[2];
  const hash = m[3];
  if (sev.includes("/")) {
    const [high, medium, low] = sev.split("/").map(Number);
    return { verdict, high, medium, low, severity: null, hash };
  }
  return { verdict, high: null, medium: null, low: null, severity: sev.toUpperCase(), hash };
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

/** The last non-blank line of a message (trailing whitespace dropped), "" when there is none. */
function lastLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].replace(/\s+$/, "");
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
export function digestVerdictText({ workerText, digestText, reviewer = false }) {
  const digest = String(digestText ?? "").trim();
  const line = extractVerdictLine(workerText);
  const lead = LEAD_WORD_RE.exec(digest);
  const digestWord = lead ? lead[1] : (/\b(PASS|FAIL)\b/.exec(digest)?.[1] ?? null);
  const summary = (lead ? digest.slice(lead[0].length) : digest).trim();
  if (line) {
    const word = parseVerdictLine(line)?.verdict ?? null;
    if (digest.startsWith(line)) return { text: digest, verdictLine: line, mismatch: false, noVerdict: false };
    const mismatch = Boolean(digestWord && word && digestWord !== word);
    const rest = mismatch ? `VERDICT-MISMATCH: digest said ${digestWord}, the reviewer's line wins${summary ? `; ${summary}` : ""}` : summary;
    return { text: rest ? `${line} — ${rest}` : line, verdictLine: line, mismatch, noVerdict: false };
  }
  if (reviewer) {
    return { text: `NO-VERDICT: ${summary || "reviewer's final message has no PASS|FAIL H/M/L <hash> line"}`, verdictLine: null, mismatch: false, noVerdict: true };
  }
  return { text: digest, verdictLine: null, mismatch: false, noVerdict: false };
}

/** Exit codes of `vs verdict`: 0 only for a PASS whose hash is a prefix of the branch tip. */
export const GATE_EXIT = { pass: 0, fail: 1, noVerdict: 2, staleHash: 3, notReviewer: 4, noBranch: 5 };

/**
 * The merge gate (idea-170): the reviewer's own verdict line (the FIRST or the LAST non-empty line) must be
 * `PASS H/M/L <hash>` (or the accepted variants) and `hash` a prefix of `tip`.
 * `agent`: the reviewer's record ({ title, labels }); `lastMessage`: its last assistant message (uncapped); `tip`: the
 * full `git rev-parse <branch>`. Returns { code, ok, line, reason }.
 */
export function evaluateVerdictGate({ agent, lastMessage, tip, branch = "" }) {
  const first = gateLine(lastMessage);
  if (!isReviewerAgent(agent)) {
    const who = `${agent?.id ?? "?"} ("${agent?.title ?? ""}"${agent?.labels?.profile ? `, profile ${agent.labels.profile}` : ""})`;
    return { code: GATE_EXIT.notReviewer, ok: false, line: first, reason: `not a reviewer: ${who} has no Review profile or reviewer title` };
  }
  // A reviewer often writes findings first and the verdict last: accept either the first or last non-empty line.
  let line = first;
  let v = parseVerdictLine(first);
  if (!v) {
    const last = lastLine(lastMessage);
    if (last && last !== first) {
      const vl = parseVerdictLine(last);
      if (vl) {
        v = vl;
        line = last;
      }
    }
  }
  const out = (code, reason) => ({ code, ok: code === GATE_EXIT.pass, line, reason });
  if (!v) return out(GATE_EXIT.noVerdict, "no verdict line: the reviewer's first or last line is not `PASS|FAIL H/M/L <hash>`");
  if (v.verdict !== "PASS") {
    const counts = v.severity ? `highest severity ${v.severity}` : `${v.high}/${v.medium}/${v.low}`;
    return out(GATE_EXIT.fail, `FAIL: the reviewer failed ${v.hash} (${counts})`);
  }
  const t = String(tip ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(t)) return out(GATE_EXIT.noBranch, `branch ${branch || "?"} did not resolve to a commit`);
  if (!t.startsWith(v.hash.toLowerCase())) {
    return out(GATE_EXIT.staleHash, `hash mismatch (stale review): reviewed ${v.hash}, ${branch || "branch"} tip is ${t.slice(0, 12)}`);
  }
  return out(GATE_EXIT.pass, `PASS on ${branch || "branch"} tip ${t.slice(0, 12)}`);
}
