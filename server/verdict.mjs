// idea-170 + idea-175: reviewer verdict lines are handled in code, never paraphrased.
// A reviewer's verdict is one line: `PASS|FAIL H/M/L <tip-hash>` (e.g. "FAIL 1/0/1 3528a4c"). The digest's team-log entry
// starts with that line copied byte-for-byte from the worker's final message (the digest's own PASS/FAIL word never wins),
// and `vs verdict <reviewer> --branch <b>` gates a merge on the reviewer's own first-or-last line matching the branch tip.

/**
 * A reviewer's verdict line. Canonical form: `PASS|FAIL H/M/L <hash>` with numeric counts
 * (e.g. "FAIL 1/0/1 3528a4c"). Accepted variants: a single highest-severity letter instead of
 * the counts (`PASS H abc123`), an optional `VERDICT:` prefix, and markdown bold markers (`**...**`),
 * including bold around the prefix (`**VERDICT:**`) or around the verdict (`VERDICT: **…**`).
 * idea-382: the sha slot also accepts a docs target for docs-only reviews of untracked lane docs
 * (which have no commit): `docs:<repo-relative path>` (e.g. `docs:docs/lanes/perfection/EXP3.md`) or a
 * bare repo-relative path ending in `.md` (e.g. `EXP3.md`, `docs/lanes/x/SPEC.md`). Hex shas keep
 * working exactly as before.
 * `VERDICT_CORE` captures (1) PASS|FAIL, (2) `h/m/l` counts or the highest-severity letter, (3) the hash or docs target.
 */
const BOLD = "(?:\\*\\*|__)?";
/** The bold-tolerant verdict prefix, shared with agent-duties / watch-sets: `VERDICT:`, `**VERDICT:**`, `VERDICT: **…**` (matches empty). */
export const VERDICT_PREFIX_SRC = `${BOLD}[ \\t]*(?:VERDICT[ \\t]*:[ \\t]*${BOLD}[ \\t]*)?`;
/** A hex sha (`[0-9a-f]{7,40}`), bounded so it is not a prefix of a longer alphanumeric run. */
const SHA_SRC = "[0-9a-f]{7,40}(?![0-9a-zA-Z])";
/** A single repo-relative path segment (idea-382): starts and ends with `[A-Za-z0-9]`, with `[A-Za-z0-9._-]` in between.
 * Rejects `.`/`..` segments, a leading `/`, a drive letter or scheme (`:` is not in the class), and a trailing `_`/`.`/`-`. */
const PATH_SEG = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const REPO_PATH = PATH_SEG + "(?:/" + PATH_SEG + ")*";
/** A docs target in the sha slot (idea-382): an optional `docs:` prefix + a repo-relative path ending in `.md`
 * (e.g. `docs:docs/lanes/perfection/EXP3.md`, or bare `EXP3.md` / `docs/lanes/x/SPEC.md`). Both forms end in `.md`
 * so a truncated token like `docs:my file.md` never parses. DOCS_SRC is tried before SHA_SRC so a 7-40-hex-stem
 * `.md` file (e.g. `deadbeef.md`) is a docs target, not a sha. */
const DOCS_SRC = "(?:docs:)?" + REPO_PATH + "\\.md";
/** The docs token must not run on into an extension (`foo.mdx`), a scheme/drive (`://`), or a path tail (`/`).
 * Bold markers (`__`/`**`) after the token are left in place, not swallowed. */
const DOCS_BOUNDARY = "(?![A-Za-z0-9.:/])";
const VERDICT_CORE = "(PASS|FAIL)[ \\t]+(\\d+\\/\\d+\\/\\d+|[HhMmLl])[ \\t]+(" + DOCS_SRC + DOCS_BOUNDARY + "|" + SHA_SRC + ")";
const VERDICT_LINE_SRC = `^[ \\t]*${VERDICT_PREFIX_SRC}${VERDICT_CORE}`;
/** A verdict line anywhere in a message (multiline): the core at the start of a line, tolerating a `VERDICT:` prefix and bold. */
export const VERDICT_LINE_RE = new RegExp(VERDICT_LINE_SRC, "m");
/** The strict parse of one line. */
const LINE_PARSE_RE = new RegExp(VERDICT_LINE_SRC);
const NON_IMPLEMENTER_REVIEW_PROFILE_RE = /^Review\b/i;
const UX_REVIEWER_RE = /\bUX Review(?:er)?\b/i;
const REVIEWER_TITLE_RE = /\b(?:re-?review|reviewer)\b|(?:^|[·:\s-])review(?:\s|$)/i;

/** The full verdict line (byte-for-byte, minus trailing whitespace) of the message's effective verdict: the first FAIL if any,
 * else the first PASS — agreeing with evaluateVerdictGate's fail-closed scan — or null when there is none. */
export function extractVerdictLine(text) {
  const vs = scanVerdicts(text);
  if (!vs.length) return null;
  return (vs.find((x) => x.verdict.verdict === "FAIL") ?? vs[0]).line;
}

/** Parses one line as a verdict: { verdict, high, medium, low, severity, hash } or null. The letter form
 * (`PASS H abc123`) leaves the counts null and sets `severity` to the highest-severity letter. `hash` is the
 * hex sha or, for a docs-only review (idea-382), a docs target (`docs:<path>` / a `*.md` path) — see isDocsTarget. */
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

/** idea-382: true when a parsed verdict token is a docs target (`docs:<path>` or a repo-relative `*.md` path),
 * not a hex sha. Same shape as DOCS_SRC, anchored to the whole token. */
const DOCS_TARGET_RE = new RegExp("^(?:docs:)?" + REPO_PATH + "\\.md$");
export function isDocsTarget(token) {
  return DOCS_TARGET_RE.test(String(token ?? ""));
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

/** The last non-blank line of a message (trailing whitespace dropped) that is not provider transport noise, "" when there is none. */
function lastLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim() || TRANSPORT_NOISE_RE.test(lines[i])) continue;
    return lines[i].replace(/\s+$/, "");
  }
  return "";
}

/** Every verdict line in `text`, in order: { line (raw, trailing whitespace stripped), verdict }. Transport noise is skipped. */
function scanVerdicts(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!raw.trim() || TRANSPORT_NOISE_RE.test(raw)) continue;
    const verdict = parseVerdictLine(raw);
    if (verdict) out.push({ line: raw.replace(/\s+$/, ""), verdict });
  }
  return out;
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
    const word = parseVerdictLine(line)?.verdict ?? null;
    if (digest.startsWith(line)) {
      // idea-300: a digest that already copies the verdict line verbatim (the prompt's happy path) must still carry the
      // reviewer stamp; stamp it here (guarding against double-stamp) so every path emits `reviewer=<profile>`.
      const text = !/\breviewer=/.test(digest) ? stampReviewer(digest, profile) : digest;
      return { text, verdictLine: line, mismatch: false, noVerdict: false };
    }
    const mismatch = Boolean(digestWord && word && digestWord !== word);
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
 * The merge gate (idea-170): the reviewer's own verdict line must be `PASS H/M/L <hash>` (or the accepted variants) and
 * `hash` a prefix of `tip`. The gate fails closed: every line of `lastMessage` is scanned, and ANY `FAIL` verdict anywhere
 * fails the gate (whatever the first or last line says); otherwise the first `PASS` is checked against the tip.
 * `agent`: the reviewer's record ({ title, labels }); `lastMessage`: its last assistant message (uncapped); `tip`: the
 * full `git rev-parse <branch>`. Returns { code, ok, line, reason }.
 */
export function evaluateVerdictGate({ agent, lastMessage, tip, branch = "" }) {
  const out = (code, reason, line = "") => ({ code, ok: code === GATE_EXIT.pass, line, reason });
  if (!isReviewerAgent(agent)) {
    const who = `${agent?.id ?? "?"} ("${agent?.title ?? ""}"${agent?.labels?.profile ? `, profile ${agent.labels.profile}` : ""})`;
    return out(GATE_EXIT.notReviewer, `not a reviewer: ${who} has no Review profile or reviewer title`);
  }
  const verdicts = scanVerdicts(lastMessage);
  // Fail closed: a FAIL verdict on any line fails the gate, regardless of a PASS on the first or last line.
  const fail = verdicts.find((x) => x.verdict.verdict === "FAIL");
  if (fail) {
    const counts = fail.verdict.severity ? `highest severity ${fail.verdict.severity}` : `${fail.verdict.high}/${fail.verdict.medium}/${fail.verdict.low}`;
    return out(GATE_EXIT.fail, `FAIL: the reviewer failed ${fail.verdict.hash} (${counts})`, fail.line);
  }
  const pass = verdicts.find((x) => x.verdict.verdict === "PASS");
  if (!pass) return out(GATE_EXIT.noVerdict, "no verdict line: the reviewer's message has no `PASS|FAIL H/M/L <hash>` line");
  const v = pass.verdict;
  // idea-382: a docs target names a file, not a commit. It only passes when nothing is being gated (no tip, no branch);
  // when a tip/branch is supplied (a code merge), a docs target cannot gate it -> stale hash.
  if (isDocsTarget(v.hash)) {
    const tipText = String(tip ?? "").trim();
    const branchText = String(branch ?? "").trim();
    if (tipText || branchText) {
      return out(GATE_EXIT.staleHash, `docs target can't gate a code branch: reviewed ${v.hash}, ${branchText || "branch"} needs a commit hash`, pass.line);
    }
    return out(GATE_EXIT.pass, `PASS on ${v.hash} (docs target: no commit to gate)`, pass.line);
  }
  const t = String(tip ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(t)) return out(GATE_EXIT.noBranch, `branch ${branch || "?"} did not resolve to a commit`, pass.line);
  if (!t.startsWith(v.hash.toLowerCase())) {
    return out(GATE_EXIT.staleHash, `hash mismatch (stale review): reviewed ${v.hash}, ${branch || "branch"} tip is ${t.slice(0, 12)}`, pass.line);
  }
  return out(GATE_EXIT.pass, `PASS on ${branch || "branch"} tip ${t.slice(0, 12)}`, pass.line);
}
