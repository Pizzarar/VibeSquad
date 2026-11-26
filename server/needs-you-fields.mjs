// @desk D1 (docs/PLAN_DESK_DECISION_DESK.md): structured fields for `vs log needs-you` and `/__vibesquad/log`.
// Uses the same field names as `vs:decision` (summary = ask, do = lean, alt = options), plus `decides` and `kind`.
// Pure helpers; no heavy imports (mirrors server/plan-log.mjs).
import { LEGACY_NEEDS_LABEL } from "./user-settings.mjs";

export const NEEDS_YOU_KINDS = ["yesno", "answer", "offscreen"];
export const NEEDS_YOU_KIND_SET = new Set(NEEDS_YOU_KINDS);
export const NEEDS_YOU_MAX_FIELD = 240;
export const NEEDS_YOU_MAX_ALTS = 6;

export const isNeedsYouType = (type) => type === "needs-you" || type === LEGACY_NEEDS_LABEL;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function checkStringField(name, raw) {
  if (typeof raw !== "string") throw new Error(`${name} must be a string`);
  const v = norm(raw);
  if (!v) throw new Error(`${name} cannot be empty`);
  if (v.length > NEEDS_YOU_MAX_FIELD) throw new Error(`${name} is ${v.length} chars, limit ${NEEDS_YOU_MAX_FIELD}`);
  return v;
}

/**
 * Validate and normalize optional structured fields on a `needs-you` log entry.
 * Returns `null` when no structured fields were provided (free-text entries stay unchanged)
 * or when `type` is not `needs-you`. Rejects invalid `kind`, bad types, >6 alts, or fields >240 chars.
 */
export function validateNeedsYouFields(type, text, raw = {}) {
  if (!isNeedsYouType(type)) return null;
  const hasSummary = raw.summary !== undefined;
  const hasDecides = raw.decides !== undefined;
  const hasDo = raw.do !== undefined;
  const hasAlt = raw.alt !== undefined && !(Array.isArray(raw.alt) && raw.alt.length === 0);
  const hasKind = raw.kind !== undefined;
  if (!hasSummary && !hasDecides && !hasDo && !hasAlt && !hasKind) return null;

  const summary = hasSummary ? checkStringField("summary", raw.summary) : checkStringField("summary", String(text ?? ""));
  const decides = hasDecides ? checkStringField("decides", raw.decides) : "";
  const doVal = hasDo ? checkStringField("do", raw.do) : "";

  let alts = [];
  if (hasAlt) {
    const list = typeof raw.alt === "string" ? [raw.alt] : Array.isArray(raw.alt) ? raw.alt : null;
    if (!list) throw new Error("alt must be an array of strings");
    if (list.length > NEEDS_YOU_MAX_ALTS) throw new Error(`alt has ${list.length} options, max ${NEEDS_YOU_MAX_ALTS}`);
    alts = list.map((item) => checkStringField("alt", item));
    if (doVal) alts = alts.filter((a) => a.toLowerCase() !== doVal.toLowerCase());
  }

  let kind = "";
  if (hasKind) {
    if (typeof raw.kind !== "string") throw new Error(`invalid kind (expected: ${NEEDS_YOU_KINDS.join(", ")})`);
    const k = norm(raw.kind).toLowerCase();
    if (!NEEDS_YOU_KIND_SET.has(k)) {
      throw new Error(`invalid kind "${raw.kind}" (expected: ${NEEDS_YOU_KINDS.join(", ")})`);
    }
    kind = k;
  }

  return {
    summary,
    ...(decides ? { decides } : {}),
    ...(doVal ? { do: doVal } : {}),
    ...(alts.length ? { alt: alts } : {}),
    ...(kind ? { kind } : {}),
  };
}

/**
 * @desk C3 (PLAN_DESK_DD_CHOICES): does an ask name lettered options ("A, B, or C", "A/B/C", "(a) ... or (b)",
 * "option A", "Option 1/2")? Warn-only heuristic, tuned against false positives:
 *  - a standalone uppercase letter A-F needs a second, different marker next to it (", " / "/" / "or" / "vs"), so the
 *    article "A" at a sentence start and a lone "Plan B" never match;
 *  - letters are case-sensitive uppercase, so the article "a" never matches; "(a)"/"(b)" needs two distinct markers
 *    (a single "(a)" is a footnote);
 *  - "option A" (letter uppercase) counts alone; numbers need a pair ("Option 1/2", "option 1 or 2"), so "option 2" alone does not.
 */
export const NEEDS_YOU_LETTERED_WARNING = "this needs-you names lettered/numbered options but has no alt; pass one alt (CLI --alt) \"<option, defined in one line>\" per option so the owner sees each choice";

export function namesLetteredOptions(text) {
  const t = String(text ?? "");
  const paren = new Set([...t.matchAll(/\(([a-fA-F])\)/g)].map((m) => m[1].toLowerCase()));
  if (paren.size >= 2) return true;
  if (/(?<![\w'’-])[A-F]\s*(?:\/|,\s*(?:or\s+)?|\s+or\s+|\s+vs\.?\s+)[A-F](?![\w'’-])/.test(t)) return true;
  if (/\b[Oo]ptions?\s+(?:[A-F]\b|\d\s*[\/,]\s*\d|\d\s+(?:or|and)\s+\d)/.test(t)) return true;
  return false;
}

