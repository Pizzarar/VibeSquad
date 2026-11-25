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
  // UX Reviewer is not a code reviewer: its verdict is a plain PASS/FAIL line in docs/UX_REVIEW_<lane>_R<n>.md (no H/M/L <hash>),
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

// ---- idea-883: the recorded verdict gates merging / pushing a unit commit (fail closed) ----
// A unit merge's tip (the merged branch head) needs a recorded verdict: a team-log `done` entry in the repo's own Squad log that
// carries the server-attested `verdict` field (written only by verbatimDigestText for a digest of a reviewer agent, see
// digestVerdictRecord; the log body cannot set it), whose hash resolves in the repo to exactly that tip, or a reviewer's own
// last message in its runner record (runnerRecordVerdict, read by push-guard readRunnerVerdicts). The latest such verdict
// decides; FAIL or none refuses. Enforced by .githooks/pre-merge-commit + pre-commit (git merge into master/main) and
// .githooks/pre-push (server/push-guard.mjs). Owner/lead override: `git -c vs.verdictOverride=<sha> merge|push` or
// VS_VERDICT_OVERRIDE=<sha>[,<sha>] (the merge or tip sha); every use is logged as a `decision` entry in the Squad log.
// idea-941 rollout guard: until the running server attests `VERDICT_WRITER_CAPABILITY` at boot (server-start-*.json capabilities),
// the gate warns instead of refusing. Once attested, it fails closed.

/** Capability token the server writes at boot (server-start-*.json) and exposes on /api/health once it writes `verdict` on done entries (idea-941). */
export const VERDICT_WRITER_CAPABILITY = "attested-verdict";

/** A unit merge subject: `Merge unit-…` / `Merge branch 'unit-…'` (unit branches are `unit-<lane>-<idea>…`, made with `vs worktree create`; the
 * lead's `Merge unit-<x>: … (@<lane> …)` subject is the one server/push-guard.mjs reads the lane tag from). */
// Also git's default for `git merge origin/unit-x`: Merge remote-tracking branch 'origin/unit-x'. Never `Merge master into unit-x`.
export const UNIT_MERGE_RE = /^Merge (?:(?:remote-tracking )?branch ['"](?:[\w.-]+\/)?)?unit-/;
export function isUnitMergeSubject(subject) {
  return UNIT_MERGE_RE.test(String(subject ?? "").trim());
}

/** idea-883: an orphan-sweep / unreadable-report prefix ("UNVERIFIED (digest failed): <final>") stripped from every line, so the
 * verdict line under it still reads as one (extractVerdictLine anchors at line start). */
const UNVERIFIED_PREFIX_RE = /^(\s*)UNVERIFIED\b[^:\n]*:\s*/gm;
export function stripUnverifiedPrefix(text) {
  return String(text ?? "").replace(UNVERIFIED_PREFIX_RE, "$1");
}

/**
 * idea-883: the attested verdict a digest's `done` entry records: { reviewer, profile, line } when the digested worker is a
 * reviewer (isReviewerAgent, the same rule as `vs verdict`) and its own final carries a verdict line, else null. Server-only:
 * verbatimDigestText stores it as the entry's `verdict` field; the log endpoints never read a `verdict` from the request.
 */
export function attestedVerdict({ worker, workerText }) {
  if (!isReviewerAgent(worker)) return null;
  const line = extractVerdictLine(workerText);
  if (!line || !parseVerdictLine(line)) return null;
  const profile = String(worker?.labels?.profile ?? worker?.profile ?? "").trim() || null;
  return { reviewer: String(worker?.id ?? ""), profile, line };
}

/**
 * The verdict a team-log entry records: { verdict, hash, line, reviewer } for a `done` entry carrying a server-attested reviewer
 * verdict (`entry.verdict = { reviewer, line }`), else null. The entry's free text is never read: any agent can write a `done`
 * entry whose text contains `PASS 0/0/0 <hash> reviewer=...`, but only the server sets `verdict`, and only for a reviewer.
 */
export function entryVerdict(entry) {
  if (!entry || entry.type !== "done") return null;
  const att = entry.verdict;
  if (!att || typeof att !== "object" || !String(att.reviewer ?? "").trim()) return null;
  const line = String(att.line ?? "");
  const v = parseVerdictLine(line);
  return v ? { verdict: v.verdict, hash: v.hash.toLowerCase(), line, reviewer: String(att.reviewer), v } : null;
}

/**
 * The latest recorded verdict for `tip` (a full sha) among team-log `entries` (append order): the last attested `done` entry
 * whose verdict hash names the tip. A hash names the tip when `resolve(hash)` (the repo's `git rev-parse <hash>^{commit}`)
 * returns exactly the tip; an ambiguous or foreign prefix resolves to something else or nothing. Without `resolve`, a 7+ hex
 * prefix of the tip matches (pure callers / tests). Docs targets never match a commit. Returns { verdict, line, ts, agent,
 * reviewer } or null.
 */
export function latestRecordedVerdict(entries, tip, { resolve } = {}) {
  const t = String(tip ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(t)) return null;
  const names = new Map();
  const namesTip = (hash) => {
    if (!names.has(hash)) names.set(hash, typeof resolve === "function" ? String(resolve(hash) ?? "").trim().toLowerCase() === t : true);
    return names.get(hash);
  };
  let best = null;
  for (const e of entries ?? []) {
    const r = entryVerdict(e);
    if (!r || isDocsTarget(r.hash) || !/^[0-9a-f]{7,64}$/.test(r.hash) || !t.startsWith(r.hash) || !namesTip(r.hash)) continue;
    best = { verdict: r.verdict, line: r.line, ts: e.ts ?? null, agent: e.agent ?? null, reviewer: r.reviewer };
  }
  return best;
}

/**
 * idea-883 fallback (deploy skew, undigested turns): the verdict a reviewer's own last message gives `tip`, read from the
 * reviewer's runner record (the same source and rule as `vs verdict`, evaluateVerdictGate). Covers a digest `done` entry
 * written without the server-attested field (server not yet restarted onto the writer) and a re-tasked reviewer's later turn
 * that was never digested. Trust comes from the record, never from a team-log entry's text: `agent` must be a reviewer
 * (isReviewerAgent), and only verdict lines whose hash `resolve` maps to exactly the tip count. Any FAIL naming the tip is a
 * FAIL; a PASS needs the whole message to pass evaluateVerdictGate on the tip. `ts`: when the message was written (epoch ms
 * or ISO). Returns { verdict, line, ts (ISO), agent: null, reviewer, source: "runner" } or null.
 */
export function runnerRecordVerdict({ agent, lastMessage, tip, resolve, ts = null } = {}) {
  const t = String(tip ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(t) || !isReviewerAgent(agent)) return null;
  const namesTip = (hash) => {
    const h = String(hash ?? "").toLowerCase();
    if (isDocsTarget(h) || !/^[0-9a-f]{7,64}$/.test(h) || !t.startsWith(h)) return false;
    return typeof resolve === "function" ? String(resolve(h) ?? "").trim().toLowerCase() === t : true;
  };
  const mine = scanVerdicts(lastMessage).filter((x) => namesTip(x.verdict.hash));
  if (!mine.length) return null;
  const when = ts == null || ts === "" ? null : new Date(typeof ts === "number" ? ts : Date.parse(ts));
  const out = (verdict, line) => ({ verdict, line, ts: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null, agent: null, reviewer: String(agent?.id ?? ""), source: "runner" });
  const fail = mine.find((x) => x.verdict.verdict === "FAIL");
  if (fail) return out("FAIL", fail.line);
  const gate = evaluateVerdictGate({ agent, lastMessage, tip: t });
  if (!gate.ok || !namesTip(parseVerdictLine(gate.line)?.hash)) return null;
  return out("PASS", gate.line);
}

/** idea-883: the newest of several recorded verdicts for one tip (attested log entry, runner record), by ts; nulls skipped.
 * A verdict without a ts sorts oldest. On a ts tie (both null included) a FAIL beats a PASS (fail closed); between equals the
 * later argument wins. */
export function newestVerdict(...verdicts) {
  let best = null;
  let bestAt = -Infinity;
  for (const v of verdicts) {
    if (!v) continue;
    const at = Date.parse(v.ts ?? "") || 0;
    if (!best || at > bestAt || (at === bestAt && !(best.verdict === "FAIL" && v.verdict !== "FAIL"))) {
      best = v;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Decide a batch of unit merges. merges: [{ sha, subject, tip }] (tip = the merged branch head); recorded(tip) -> the latest
 * recorded verdict or null; overrides: sha prefixes (merge or tip). Non-unit merges are skipped. Pure.
 * Returns { ok, passed: [], overridden: [], refused: [{ sha, subject, tip, reason: "fail"|"no-verdict", line }] }.
 */
export function evaluateMergeVerdicts({ merges = [], recorded = () => null, overrides = [] } = {}) {
  const passed = [];
  const overridden = [];
  const refused = [];
  const ov = (overrides ?? []).map((s) => String(s).toLowerCase()).filter(Boolean);
  for (const m of merges) {
    if (!isUnitMergeSubject(m.subject)) continue;
    const sha = String(m.sha ?? "").toLowerCase();
    const tip = String(m.tip ?? "").toLowerCase();
    const entry = { sha, subject: m.subject, tip };
    if (ov.some((p) => (sha && sha.startsWith(p)) || (tip && tip.startsWith(p)))) {
      overridden.push(entry);
      continue;
    }
    const r = tip ? recorded(tip) : null;
    if (r?.verdict === "PASS") passed.push({ ...entry, line: r.line, ...(r.source ? { source: r.source, reviewer: r.reviewer } : {}) });
    else refused.push({ ...entry, reason: r ? "fail" : "no-verdict", line: r?.line ?? "" });
  }
  return { ok: refused.length === 0, passed, overridden, refused };
}

/** Human-readable refusal (or rollout-guard warning when `attested === false`) for stderr; "" when every unit merge has a recorded PASS (or is overridden). `squads`: the Squad
 * logs that were read ([] = the repo matches no Squad in teams.json, so nothing can be recorded). */
export function formatVerdictRefusal(result, { action = "push", squads, attested = true } = {}) {
  if (result.ok) return "";
  const short = (s) => String(s ?? "").slice(0, 8);
  const lines = [
    attested
      ? `vs verdict gate: refusing to ${action}: a unit commit's latest recorded verdict is FAIL or missing (idea-883, fail closed).`
      : `vs verdict gate: WARNING (rollout guard, idea-941) — allowing ${action}: the running server has not attested \`${VERDICT_WRITER_CAPABILITY}\` yet, so the gate warns instead of refusing.`,
  ];
  if (Array.isArray(squads)) {
    lines.push(
      squads.length
        ? `  verdicts read from Squad log(s): ${squads.join(", ")} (only attested reviewer digests, or the reviewer's own runner record, count; other Squads' never do)`
        : "  this repo matches no Squad's paths in teams.json, so no verdict can be recorded for it (fail closed)",
    );
  }
  for (const r of result.refused) {
    const head = r.sha ? `${short(r.sha)} ${String(r.subject ?? "").slice(0, 80)}` : String(r.subject ?? "").slice(0, 80);
    lines.push(`  ${head}`);
    lines.push(
      r.reason === "fail"
        ? `           tip ${short(r.tip)}: latest recorded verdict is ${r.line.slice(0, 100)}`
        : `           tip ${short(r.tip)}: no recorded verdict (no reviewer digest \`PASS|FAIL H/M/L <hash>\` line names this tip)`,
    );
  }
  const shas = result.refused.map((r) => short(r.tip || r.sha)).join(",");
  if (!attested) {
    lines.push(
      "Once the server restarts onto the verdict-writer build, this gate fails closed (FAIL or missing verdict refuses).",
      `Note: PASS digests written before that restart never get the \`verdict\` field retroactively, so after the restart they need a re-review or an override (git -c vs.verdictOverride=${shas} ${action} ...).`,
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "Get a review PASS on the exact tip (vs verdict <reviewer> --branch <unit> exits 0), then retry.",
    "Pre-restart PASS digests (written before the server restarted onto the verdict-writer build) never get the `verdict` field retroactively: re-review the tip or use an override below.",
  );
  lines.push(
    "Docs-only or lead-checked unit (no code reviewer, or a docs:<path> review, which names no commit): the lead overrides with the tip",
    `and says why in the merge subject. Owner/lead only: git -c vs.verdictOverride=${shas} ${action} ... (or VS_VERDICT_OVERRIDE=${shas}).`,
    "The override is per command: pass it on the git merge AND again on the git push. Every use is logged as a decision entry.",
  );
  return `${lines.join("\n")}\n`;
}

/** idea-883: the stderr notice for overridden unit merges (merge and push both print it); "" when none. */
export function formatVerdictOverrides(result, { action = "push", logged = [] } = {}) {
  const ov = result?.overridden ?? [];
  if (!ov.length) return "";
  const where = logged.length ? `logged to Squad log(s) ${logged.join(", ")}` : "NOT logged (no Squad log for this repo); tell the lead";
  const lines = [`vs verdict gate: OVERRIDE on ${action} (${where}):`];
  for (const m of ov) lines.push(`  ${m.sha ? `${m.sha.slice(0, 8)} ` : ""}${String(m.subject ?? "").slice(0, 80)}  tip ${m.tip.slice(0, 8)}: no recorded PASS required (vs.verdictOverride)`);
  return `${lines.join("\n")}\n`;
}
