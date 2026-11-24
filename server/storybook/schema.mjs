// Storybook registry schema (SB1). The JSON contract SB2-SB5 code against. Pure data + validators, Node stdlib only.
//
// Entity   = { id, kind, display, aliases[], source:{path,line}, links:[{rel,kind,id}], production, data:{} }
// Snapshot = { schemaVersion:1, project, ref, sha, generatedAt, entities[], findings[], warnings[] }
// Finding  = { check:'#1'..'#12', severity:'error'|'warn'|'info', entityRef:{kind,id}|null, msg, source:{path,line}|null }
//
// Identity is (kind,id), NOT id alone: EFI's `doc` is both a trader and a squad member.

export const SCHEMA_VERSION = 1;

/** v1 kinds, each with the data keys it must carry (the adapter fills them; [] means "free-form"). */
export const KINDS = Object.freeze({
  trader: { label: "Trader (character)", required: [] },
  squad: { label: "Squad member", required: [] },
  enemy: { label: "Enemy", required: ["boss"] },
  location: { label: "Location", required: ["enemy_pool"] },
  room: { label: "Hideout room", required: [] },
  item: { label: "Item", required: [] },
  skill: { label: "Skill", required: [] },
  contract: { label: "Contract template", required: [] },
  recipe: { label: "Recipe", required: [] },
  quest_step: { label: "Quest step", required: ["trader", "task"] },
  line: { label: "Text line", required: ["text", "origin"] },
  voice_card: { label: "Voice card", required: ["neverSays"] },
  lore: { label: "Lore block", required: ["text"] },
});

/** Reserved kinds: schema only. An entity of these kinds is valid but must carry no data (later lanes fill them). */
export const RESERVED_KINDS = Object.freeze(["faction", "dialogue_node", "dialogue_choice", "cutscene", "ability", "art_slot", "audio_cue", "map_graph"]);
export const ALL_KINDS = Object.freeze([...Object.keys(KINDS), ...RESERVED_KINDS]);

export const PRODUCTION_STATES = Object.freeze(["missing", "placeholder", "ai-draft", "needs-review", "final"]);
export const SEVERITIES = Object.freeze(["error", "warn", "info"]);
export const CHECK_IDS = Object.freeze(Array.from({ length: 12 }, (_, i) => `#${i + 1}`));

const isStr = (v) => typeof v === "string";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isSource = (s) => isObj(s) && isStr(s.path) && s.path !== "" && (s.line === null || (Number.isInteger(s.line) && s.line >= 1));

/** Validate one entity. Returns {ok, errors[]} (strings). */
export function validateEntity(e) {
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
  });
  if (e.production !== null && !PRODUCTION_STATES.includes(e.production)) errors.push(`production must be null or one of ${PRODUCTION_STATES.join("|")}`);
  if (!isObj(e.data)) errors.push("data must be an object");
  else if (RESERVED_KINDS.includes(e.kind)) {
    if (Object.keys(e.data).length) errors.push(`reserved kind ${e.kind} must have empty data`);
  } else if (KINDS[e.kind]) {
    for (const k of KINDS[e.kind].required) if (!(k in e.data)) errors.push(`${e.kind} data is missing "${k}"`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate one finding. Returns {ok, errors[]}. */
export function validateFinding(f) {
  const errors = [];
  if (!isObj(f)) return { ok: false, errors: ["finding is not an object"] };
  if (!CHECK_IDS.includes(f.check)) errors.push(`check must be one of #1..#12`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be ${SEVERITIES.join("|")}`);
  if (f.entityRef !== null && !(isObj(f.entityRef) && ALL_KINDS.includes(f.entityRef.kind) && isStr(f.entityRef.id))) errors.push("entityRef must be {kind,id} or null");
  if (!isStr(f.msg) || !f.msg) errors.push("msg must be a non-empty string");
  if (f.source !== null && !isSource(f.source)) errors.push("source must be {path,line} or null");
  return { ok: errors.length === 0, errors };
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

/** Validate a whole snapshot. Returns {ok, errors[]}; errors are prefixed with where they happened. */
export function validateSnapshot(s) {
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

/** Assemble a snapshot object (does not validate; call validateSnapshot). */
export function makeSnapshot({ project, ref, sha, entities, findings = [], warnings = [], generatedAt = new Date().toISOString() }) {
  return { schemaVersion: SCHEMA_VERSION, project, ref, sha, generatedAt, entities, findings, warnings };
}

/** Convenience constructor with defaults so adapters stay terse. */
export function entity({ id, kind, display, aliases = [], source, links = [], production = null, data = {} }) {
  const al = [...new Set(aliases.filter((a) => isStr(a) && a !== "" && a !== display && a !== id))];
  return { id, kind, display: display ?? id, aliases: al, source, links, production, data };
}
