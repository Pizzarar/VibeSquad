// Studio-wide 4-signal audit contract (F2). Every lane emits findings in the one shape the Studio Hub will read:
//
//   AuditFinding = { signal:'coverage'|'integrity'|'cohesion'|'signoff', severity:'error'|'warn'|'info',
//                    entityId:<project>:<kind>:<id>|null, lane:<lane handle>|null, msg, source:{path,line}|null }
//
// Signals (docs/research/storybook-studio-pitch-2026-11-24.md §3):
//   coverage   registry entities missing content in this lane
//   integrity  broken ids, dead ends, unreachable states, unused orphans
//   cohesion   drift from project rules (tone/canon, style, mix, balance)
//   signoff    still placeholder / ai-generated vs. human-verified final
//
// Storybook is the first consumer (docs/PLAN_STORYBOOK_V1.md Phase F, F2). Its check ids map onto the signals:
//   #1/#2/#5/#7             -> integrity
//   #3/#4/#6/#9/#10/#11/#12 -> cohesion
//   #8 (STORY-TODO)          -> signoff, plus the status column (csv status -> production placeholder/ai-draft/needs-review)
//   entities missing text/lore -> coverage (per-kind slot lists, server/registry/kinds/*.mjs)
//
// `entityId` is the stable studio id (ids.mjs) of the entity, null when a finding has no single entity (e.g. a #8 .gd
// comment). `lane` is the emitting lane handle (Storybook's wiring passes "storybook"), NOT the entity kind's `lane`.
import { SEVERITIES, PRODUCTION_STATES } from "./schema.mjs";
import { studioId, isStudioId, entityStudioId } from "./ids.mjs";
import { KIND_TABLE } from "./index.mjs";

export const SIGNALS = Object.freeze(["coverage", "integrity", "cohesion", "signoff"]);
const SIGNAL_ORDER = new Map(SIGNALS.map((s, i) => [s, i]));

/** Storybook check id -> signal (the first consumer's mapping). */
export const CHECK_SIGNALS = Object.freeze({
  "#1": "integrity", "#2": "integrity", "#5": "integrity", "#7": "integrity",
  "#3": "cohesion", "#4": "cohesion", "#6": "cohesion", "#9": "cohesion", "#10": "cohesion", "#11": "cohesion", "#12": "cohesion",
  "#8": "signoff",
});

/** Slots that carry text/lore content (vs art/audio/icon assets). */
const CONTENT_SLOTS = new Set(["text", "lore"]);
/** Production states that are not yet final: still placeholder / ai-generated / needs review (the signoff signal). */
const NOT_FINAL = new Set(PRODUCTION_STATES.filter((s) => s !== "missing" && s !== "final"));

const isStr = (v) => typeof v === "string";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isSource = (s) => isObj(s) && isStr(s.path) && s.path !== "" && (s.line === null || (Number.isInteger(s.line) && s.line >= 1));

/** One audit finding. Throws on a bad signal/severity (a programming error, not a data finding). */
export function makeAuditFinding({ signal, severity, entityId = null, lane = null, msg, source = null }) {
  if (!SIGNALS.includes(signal)) throw new TypeError(`audit signal ${JSON.stringify(signal)} must be one of ${SIGNALS.join("|")}`);
  if (!SEVERITIES.includes(severity)) throw new TypeError(`audit severity ${JSON.stringify(severity)} must be ${SEVERITIES.join("|")}`);
  return { signal, severity, entityId, lane, msg, source };
}

/** Validate one audit finding. Returns {ok, errors[]}. */
export function validateAuditFinding(f) {
  const errors = [];
  if (!isObj(f)) return { ok: false, errors: ["audit finding is not an object"] };
  if (!SIGNALS.includes(f.signal)) errors.push(`signal must be one of ${SIGNALS.join("|")}`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be ${SEVERITIES.join("|")}`);
  if (f.entityId !== null && !isStudioId(f.entityId)) errors.push("entityId must be a studio id (<project>:<kind>:<id>) or null");
  if (f.lane !== null && (!isStr(f.lane) || !f.lane)) errors.push("lane must be a non-empty string or null");
  if (!isStr(f.msg) || !f.msg) errors.push("msg must be a non-empty string");
  if (f.source !== null && !isSource(f.source)) errors.push("source must be {path,line} or null");
  return { ok: errors.length === 0, errors };
}

/** Map one storybook check finding to an audit finding. Throws when the check id has no signal mapping. */
export function auditFromFinding(finding, { project, lane = null } = {}) {
  const signal = CHECK_SIGNALS[finding.check];
  if (!signal) throw new Error(`audit: no signal mapped for check ${JSON.stringify(finding.check)}`);
  const ref = finding.entityRef ?? null;
  const entityId = ref ? studioId(project, ref.kind, ref.id) : null;
  return makeAuditFinding({ signal, severity: finding.severity, entityId, lane, msg: finding.msg, source: finding.source ?? null });
}

/** productionOf (schema.mjs) for one entity against its kind def's slots. */
function productionOf(e, slot, def) {
  const own = isObj(e.productionSlots) ? e.productionSlots[slot] : undefined;
  if (own !== undefined) return own;
  return slot === def.slots[0] ? (e.production ?? null) : null;
}

/**
 * Coverage: entities whose kind declares a text/lore slot (its per-kind slot list) and that slot is missing
 * (production state "missing", or the primary slot falls back to `production`). Reserved kinds with no text/lore slot
 * (e.g. art_slot) never emit here.
 */
export function coverageFindings(snapshot, { lane = null, table = KIND_TABLE } = {}) {
  const out = [];
  for (const e of snapshot.entities ?? []) {
    const def = table.byKind.get(e.kind);
    if (!def) continue;
    const slots = def.slots.filter((s) => CONTENT_SLOTS.has(s));
    for (const slot of slots) {
      if (productionOf(e, slot, def) === "missing") {
        out.push(makeAuditFinding({ signal: "coverage", severity: "warn", entityId: entityStudioId(snapshot.project, e), lane, msg: `${e.kind} ${e.id} is missing its ${slot} slot`, source: e.source ?? null }));
      }
    }
  }
  return out;
}

/**
 * Art coverage: when the project tracks art (the snapshot has at least one art_slot entity, i.e. an art manifest was
 * ingested), a character-kind entity with no linked art_slot, or only art_slots whose production is "missing", gets one
 * info coverage finding. Projects with no art_slot entities are unchanged. Distinct from the text/lore rule above (that one
 * reads the entity's own text/lore slot; this one reads the art_slot entities linking to it), so nothing double-counts.
 */
export function artCoverageFindings(snapshot, { lane = null, table = KIND_TABLE } = {}) {
  // character kinds (KindDef.character) should have a portrait/sprite when the project tracks art at all
  const ART_CHARACTER_KINDS = new Set(table.defs.filter((d) => d.character).map((d) => d.kind));
  const ents = snapshot.entities ?? [];
  const arts = ents.filter((e) => e.kind === "art_slot");
  if (!arts.length) return [];
  const present = new Set();
  for (const a of arts) {
    if (a.production === "missing") continue;
    for (const l of a.links ?? []) if (l.project === undefined && ART_CHARACTER_KINDS.has(l.kind)) present.add(`${l.kind}\u0000${l.id}`);
  }
  const out = [];
  for (const e of ents) {
    if (!ART_CHARACTER_KINDS.has(e.kind) || present.has(`${e.kind}\u0000${e.id}`)) continue;
    out.push(makeAuditFinding({ signal: "coverage", severity: "info", entityId: entityStudioId(snapshot.project, e), lane, msg: `${e.kind} ${e.id} has no art (portrait or sprite)`, source: e.source ?? null }));
  }
  return out;
}

/**
 * Signoff (asset status): entities whose primary slot is still placeholder / ai-draft / needs-review. This is where the
 * csv status column lands (the EFI adapter maps status -> production); a "final" (OWNER-OK) or "missing" slot is not it.
 */
export function signoffFindings(snapshot, { lane = null, table = KIND_TABLE } = {}) {
  const out = [];
  for (const e of snapshot.entities ?? []) {
    const def = table.byKind.get(e.kind);
    if (!def) continue;
    const primary = def.slots[0];
    const state = productionOf(e, primary, def);
    if (state && NOT_FINAL.has(state)) {
      out.push(makeAuditFinding({ signal: "signoff", severity: state === "placeholder" ? "info" : "warn", entityId: entityStudioId(snapshot.project, e), lane, msg: `${e.kind} ${e.id} ${primary} slot is ${state}`, source: e.source ?? null }));
    }
  }
  return out;
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Deterministic order: signal, entityId, source path, source line, msg. */
export function sortAudit(audit) {
  return [...audit].sort((a, b) =>
    (SIGNAL_ORDER.get(a.signal) - SIGNAL_ORDER.get(b.signal))
    || cmpStr(a.entityId ?? "", b.entityId ?? "")
    || cmpStr(a.source?.path ?? "", b.source?.path ?? "")
    || ((a.source?.line ?? 0) - (b.source?.line ?? 0))
    || cmpStr(a.msg, b.msg));
}
