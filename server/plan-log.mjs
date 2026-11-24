// idea-454: plan lifecycle fields of a handoff/done log entry (pure helpers; no heavy imports).
const MAX_LOG_TEXT = 240;

/** idea-454: a plan lifecycle path: repo-relative docs/PLAN_*.md (same shape handoffLogText tags). */
export const PLAN_PATH_RE = /^docs\/PLAN_[\w.-]+\.md$/i;
export const MAX_PLAN_PATH = 120;
/** One Buddy -> lead handoff per (lane, agent, plan) inside this window (server-side, against the lane log). */
export const PLAN_HANDOFF_DEDUPE_MS = 30 * 60_000;
const PLAN_IN_TEXT_RE = /(?:^|[^\w./-])(docs\/PLAN_[\w.-]+\.md)(?![\w-]|\.\w)/i;
/** The validated plan path, or "" when absent; throws on a present but malformed one (CLI and server share this). */
export function validatePlanPath(plan) {
  const p = String(plan ?? "").trim().replace(/\\/g, "/");
  if (!p) return "";
  if (p.length > MAX_PLAN_PATH || !PLAN_PATH_RE.test(p)) throw new Error(`--plan must be a repo-relative docs/PLAN_*.md path (got "${p}")`);
  return p;
}
/** The first docs/PLAN_*.md path a text names, or "". A trailing sentence period is not part of the path. */
export function planPathInText(text) {
  const m = PLAN_IN_TEXT_RE.exec(String(text ?? ""));
  return m ? m[1] : "";
}
/**
 * Plan metrics fields of a handoff/done entry: `plan=<path>` (from the flag, else auto-filled from a plan path the text names),
 * and for done a `pass` flag. The text carries a parseable `plan=<path>` tag (and `PASS`) the usage readers key on.
 */
export function planLogFields(type, text, plan, pass) {
  if (type !== "handoff" && type !== "done") return { text, plan: "", pass: false };
  const p = validatePlanPath(plan) || planPathInText(text);
  if (!p) return { text, plan: "", pass: false };
  const isPass = type === "done" && pass === true;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagRe = new RegExp(`\\s*plan=${esc}(?![\\w-]|\\.\\w)`, "i");
  const hasTag = tagRe.test(text);
  const needPass = isPass && !/\bPASS\b/.test(text);
  let base = text;
  let tag = "";
  if (!hasTag) tag = ` plan=${p}`;
  else if (needPass) { base = text.replace(tagRe, "").trimEnd(); tag = ` plan=${p}`; } // re-append so the clip below can never cut the tag
  if (needPass) tag += " PASS";
  if (!tag) return { text, plan: p, pass: isPass };
  const room = Math.max(0, MAX_LOG_TEXT - tag.length); // a path is capped at MAX_PLAN_PATH, so room is never negative in practice
  return { text: `${base.length > room ? base.slice(0, room) : base}${tag}`.slice(0, MAX_LOG_TEXT), plan: p, pass: isPass };
}
