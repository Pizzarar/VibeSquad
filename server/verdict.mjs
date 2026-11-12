// idea-170 + idea-175: reviewer verdict lines are handled in code, never paraphrased.
// A reviewer's verdict is one line: `PASS|FAIL H/M/L <tip-hash>` (e.g. "FAIL 1/0/1 3528a4c"). The digest's team-log entry
// starts with that line copied byte-for-byte from the worker's final message (the digest's own PASS/FAIL word never wins),
// and `vs verdict <reviewer> --branch <b>` gates a merge on the reviewer's own FIRST line matching the branch tip.

/** A verdict line anywhere in a message (multiline): `PASS|FAIL H/M/L <hash>` at the start of a line. */
export const VERDICT_LINE_RE = /^(PASS|FAIL) \d+\/\d+\/\d+ [0-9a-f]{7,40}/m;
/** The strict parse of one line (the gate reads only the reviewer's first line). */
const LINE_PARSE_RE = /^(PASS|FAIL) (\d+)\/(\d+)\/(\d+) ([0-9a-f]{7,40})(?![0-9A-Za-z])/;
const NON_IMPLEMENTER_REVIEW_PROFILE_RE = /^Review\b/i;
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

/** The first non-blank line of a message (trailing whitespace dropped), "" when there is none. */
export function firstLine(text) {
  for (const l of String(text ?? "").split(/\r?\n/)) if (l.trim()) return l.replace(/\s+$/, "");
  return "";
}

/** A reviewer run: a `Review - …` profile, or a reviewer-shaped title ("Review - Gemini", "re-review", "R2 review"). */
export function isReviewerAgent(agent) {
  const labels = agent?.labels ?? {};
  const profile = String(labels.profile ?? agent?.profile ?? "").trim();
  if (NON_IMPLEMENTER_REVIEW_PROFILE_RE.test(profile)) return true;
  const title = String(agent?.title ?? "").trim();
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
    const word = line.slice(0, 4);
    if (digest.startsWith(line)) return { text: digest, verdictLine: line, mismatch: false, noVerdict: false };
    const mismatch = Boolean(digestWord && digestWord !== word);
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
 * The merge gate (idea-170): the reviewer's own FIRST line must be `PASS H/M/L <hash>` and `hash` a prefix of `tip`.
 * `agent`: the reviewer's record ({ title, labels }); `lastMessage`: its last assistant message (uncapped); `tip`: the
 * full `git rev-parse <branch>`. Returns { code, ok, line, reason }.
 */
export function evaluateVerdictGate({ agent, lastMessage, tip, branch = "" }) {
  const line = firstLine(lastMessage);
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
