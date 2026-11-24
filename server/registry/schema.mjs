// Registry schema (F1, promoted from Storybook SB1). Pure data + validators over a kind table, Node stdlib only.
//
// Entity   = { id, kind, display, aliases[], source:{path,line}, links:[{rel,kind,id,project?}], production, data:{},
//              productionSlots?:{[slot]: state|null} }
// Snapshot = { schemaVersion:1, project, ref, sha, generatedAt, entities[], findings[], warnings[] }
// Finding  = { check:'#1'..'#12', severity:'error'|'warn'|'info', entityRef:{kind,id}|null, msg, source:{path,line}|null }
//
// Identity is (kind,id) inside a project, NOT id alone: EFI's `doc` is both a trader and a squad member. Across projects
// it is the studio ID <project>:<kind>:<id> (ids.mjs).
//
// Production: `production` is the entity's primary-slot state (null = unknown). `productionSlots` (optional, never set by
// SB1 adapters) tracks per-slot state for the slots its kind declares. `link.project` (optional) makes a cross-project link.
import { PROJECT_RE } from "./ids.mjs";

export const SCHEMA_VERSION = 1;
export const PRODUCTION_STATES = Object.freeze(["missing", "placeholder", "ai-draft", "needs-review", "final"]);
export const SEVERITIES = Object.freeze(["error", "warn", "info"]);
export const CHECK_IDS = Object.freeze(Array.from({ length: 12 }, (_, i) => `#${i + 1}`));

const isStr = (v) => typeof v === "string";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isSource = (s) => isObj(s) && isStr(s.path) && s.path !== "" && (s.line === null || (Number.isInteger(s.line) && s.line >= 1));

/**
 * Validators bound to one kind table (kind-table.mjs). index.mjs binds the default table; a caller with an extended table
 * (extra kind files) gets validators that know its kinds.
 */
export function makeSchema(table) {
  const { KINDS, RESERVED_KINDS, ALL_KINDS, byKind } = table;

  /** Validate one entity. Returns {ok, errors[]} (strings). */
  function validateEntity(e) {
    const errors = [];
    if (!isObj(e)) return { ok: false, errors: ["entity is not an object"] };
    if (!isStr(e.id) || e.id === "") errors.push("id must be a non-empty string");
    if (!ALL_KINDS.includes(e.kind)) errors.push(`unknown kind ${JSON.stringify(e.kind)}`);
    if (!isStr(e.display)) errors.push("display must be a string");
    if (!Array.isArray(e.aliases) || !e.aliases.every(isStr)) errors.push("aliases must be string[]");
    if (!isSource(e.source)) errors.push("source must be {path:string, line:int>=1|null}");
    if (!Array.isArray(e.links)) errors.push("links must be an array");
    else e.links.forEach((l, i) => {
      if (!isObj(l) || !isStr(l.rel) || !l.rel || !ALL_KINDS.includes(l.kind) || !isStr(l.id) || !l.id) errors.push(`links[${i}] must be {rel, kind, id}`);
      else if ("project" in l && !(isStr(l.project) && PROJECT_RE.test(l.project))) errors.push(`links[${i}].project must be a studio project key`);
    });
    if (e.production !== null && !PRODUCTION_STATES.includes(e.production)) errors.push(`production must be null or one of ${PRODUCTION_STATES.join("|")}`);
    if ("productionSlots" in e) {
      const slots = byKind.get(e.kind)?.slots ?? [];
      if (!isObj(e.productionSlots)) errors.push("productionSlots must be an object");
      else for (const [slot, st] of Object.entries(e.productionSlots)) {
        if (!slots.includes(slot)) errors.push(`productionSlots.${slot}: ${e.kind} has no such slot (${slots.join("|")})`);
        else if (st !== null && !PRODUCTION_STATES.includes(st)) errors.push(`productionSlots.${slot} must be null or one of ${PRODUCTION_STATES.join("|")}`);
      }
    }
    if (!isObj(e.data)) errors.push("data must be an object");
    else if (RESERVED_KINDS.includes(e.kind)) {
      if (Object.keys(e.data).length) errors.push(`reserved kind ${e.kind} must have empty data`);
    } else if (KINDS[e.kind]) {
      for (const k of KINDS[e.kind].required) if (!(k in e.data)) errors.push(`${e.kind} data is missing "${k}"`);
    }
    return { ok: errors.length === 0, errors };
  }

  /** Validate one finding. Returns {ok, errors[]}. */
  function validateFinding(f) {
    const errors = [];
    if (!isObj(f)) return { ok: false, errors: ["finding is not an object"] };
    if (!CHECK_IDS.includes(f.check)) errors.push(`check must be one of #1..#12`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be ${SEVERITIES.join("|")}`);
    if (f.entityRef !== null && !(isObj(f.entityRef) && ALL_KINDS.includes(f.entityRef.kind) && isStr(f.entityRef.id) && f.entityRef.id !== "")) errors.push("entityRef must be {kind,id} or null");
    if (!isStr(f.msg) || !f.msg) errors.push("msg must be a non-empty string");
    if (f.source !== null && !isSource(f.source)) errors.push("source must be {path,line} or null");
    return { ok: errors.length === 0, errors };
  }

  /** Validate a whole snapshot. Returns {ok, errors[]}; errors are prefixed with where they happened. */
  function validateSnapshot(s) {
    const errors = [];
    if (!isObj(s)) return { ok: false, errors: ["snapshot is not an object"] };
    if (s.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
    for (const k of ["project", "ref", "sha", "generatedAt"]) if (!isStr(s[k]) || !s[k]) errors.push(`${k} must be a non-empty string`);
    if (isStr(s.sha) && !/^[0-9a-f]{7,64}$/.test(s.sha)) errors.push("sha must be hex");
    if (!Array.isArray(s.entities)) errors.push("entities must be an array");
    else {
      const seen = new Set();
      s.entities.forEach((e, i) => {
        const v = validateEntity(e);
        for (const m of v.errors) errors.push(`entities[${i}] ${e?.kind}:${e?.id}: ${m}`);
        if (isObj(e)) {
          const key = entityKey(e.kind, e.id);
          if (seen.has(key)) errors.push(`entities[${i}] duplicate (kind,id) ${e.kind}:${e.id}`);
          seen.add(key);
        }
      });
    }
    if (!Array.isArray(s.findings)) errors.push("findings must be an array");
    else s.findings.forEach((f, i) => { for (const m of validateFinding(f).errors) errors.push(`findings[${i}]: ${m}`); });
    if (!Array.isArray(s.warnings) || !s.warnings.every(isStr)) errors.push("warnings must be string[]");
    return { ok: errors.length === 0, errors };
  }

  /** Production state of one slot: productionSlots[slot], else `production` for the kind's primary slot, else null. */
  function productionOf(e, slot) {
    const def = byKind.get(e?.kind);
    if (!def || !def.slots.includes(slot)) return null;
    const own = isObj(e.productionSlots) ? e.productionSlots[slot] : undefined;
    if (own !== undefined) return own;
    return slot === def.slots[0] ? (e.production ?? null) : null;
  }

  /** Links whose target kind belongs to a different lane than the entity's kind, or that point at another project. */
  function crossLaneLinks(e) {
    const lane = byKind.get(e?.kind)?.lane ?? null;
    return (e?.links ?? []).filter((l) => l.project !== undefined || (byKind.get(l.kind)?.lane ?? null) !== lane);
  }

  return { table, KINDS, RESERVED_KINDS, ALL_KINDS, validateEntity, validateFinding, validateSnapshot, productionOf, crossLaneLinks };
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
export const entityKey = (kind, id) => `${kind}\u0000${id}`;

/**
 * Registry over entities. Lookup by (kind,id); by alias/display across kinds (case-insensitive); duplicates of (kind,id)
 * are recorded in `duplicates` (first one wins) instead of throwing, so a check can report them.
 */
export function makeRegistry(entities = []) {
  const byKey = new Map();
  const byKind = new Map();
  const byName = new Map();
  const duplicates = [];
  const indexName = (name, e) => {
    const k = norm(name);
    if (!k) return;
    const arr = byName.get(k) ?? [];
    if (!arr.includes(e)) arr.push(e);
    byName.set(k, arr);
  };
  const reg = {
    duplicates,
    add(e) {
      const key = entityKey(e.kind, e.id);
      if (byKey.has(key)) { duplicates.push(e); return false; }
      byKey.set(key, e);
      (byKind.get(e.kind) ?? byKind.set(e.kind, []).get(e.kind)).push(e);
      indexName(e.display, e);
      indexName(e.id, e);
      for (const a of e.aliases ?? []) indexName(a, e);
      return true;
    },
    get: (kind, id) => byKey.get(entityKey(kind, id)) ?? null,
    has: (kind, id) => byKey.has(entityKey(kind, id)),
    all: () => [...byKey.values()],
    byKind: (kind) => [...(byKind.get(kind) ?? [])],
    /** Every entity (any kind) whose id, display or alias equals `name`. */
    findByName: (name) => [...(byName.get(norm(name)) ?? [])],
    /** All entities sharing an id across kinds (the `doc` trader/squad case). */
    sameId: (id) => reg.all().filter((e) => e.id === id),
    /** Resolve a link {kind,id} to its entity, or null when dangling. */
    resolve: (link) => reg.get(link.kind, link.id),
    size: () => byKey.size,
    counts() {
      const out = {};
      for (const [k, v] of byKind) out[k] = v.length;
      return out;
    },
  };
  for (const e of entities) reg.add(e);
  return reg;
}

/** Assemble a snapshot object (does not validate; call validateSnapshot). */
export function makeSnapshot({ project, ref, sha, entities, findings = [], warnings = [], generatedAt = new Date().toISOString() }) {
  return { schemaVersion: SCHEMA_VERSION, project, ref, sha, generatedAt, entities, findings, warnings };
}

/** Convenience constructor with defaults so adapters stay terse. */
export function entity({ id, kind, display, aliases = [], source, links = [], production = null, data = {} }) {
  const al = [...new Set(aliases.filter((a) => isStr(a) && a !== "" && a !== display && a !== id))];
  return { id, kind, display: display ?? id, aliases: al, source, links, production, data };
}
