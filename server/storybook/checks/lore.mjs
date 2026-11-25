// Storybook lore checks (SB7): #12 lore contradictions.
// Fact triples (who / where / what): a fact is (subject, slot, value). A slot is single-valued when one subject
// should have at most one value for it (e.g. "boss location", "quest location", "speaker", "unlock location").
// Two facts that assign different values to the same (subject, slot) are a contradiction.
//
// Deterministic only (no LLM): facts come from two high-precision sources.
//   1. structured links / data the adapter already emitted (how: "link"), and
//   2. the PLAN_MAP_VIBES per-map "Boss" backtick id (how: "lore"), a doc body already parsed into lore fields.
// A conflict backed entirely by structured links is a warn; one that leans on the lore parse is info (a doc claim).
// Nothing here reads a repo; this runs over the SB1 registry like every other check.
//
// Severity note: a "lore"-sourced fact is still an exact entity id, but it asserts what a design doc says rather than
// what the data says, so any conflict it is part of stays info (low confidence, "prefer precision over recall").

const ref = (e) => ({ kind: e.kind, id: e.id });
const finding = (severity, subject, msg, source) => ({ check: "#12", severity, entityRef: subject ? ref(subject) : null, msg, source: source ?? subject?.source ?? null });
const key = (kind, id) => `${kind}\u0000${id}`;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order: host-independent

/**
 * Single-valued relations carried on an entity's links, mapped to their canonical slot. The subject is the entity that
 * holds the link, EXCEPT `boss` (location -> enemy), which is inverted to `boss_of` (enemy -> location) so a location's
 * boss row groups with the enemy's own `boss_of` link. `seen_at` / `parent` live on `lore` (enemy_look) entities and are
 * re-keyed to the enemy they describe below.
 */
const LINK_SLOTS = new Map([
  ["boss_of", "boss_of"],
  ["boss", "boss_of"],
  ["at_location", "at_location"],
  ["trader", "trader"],
  ["targets_enemy", "targets_enemy"],
  ["wants_item", "wants_item"],
  ["needs_room", "needs_room"],
  ["needs_skill", "needs_skill"],
  ["spoken_by", "spoken_by"],
  ["produces", "produces"],
  ["workshop", "workshop"],
  ["first_clear_unique", "first_clear_unique"],
  ["unlocked_at", "unlocked_at"],
]);

const SLOT_LABEL = {
  boss_of: "boss location",
  at_location: "quest location",
  trader: "trader",
  targets_enemy: "kill target",
  wants_item: "deliverable",
  needs_room: "room",
  needs_skill: "skill",
  spoken_by: "speaker",
  produces: "product",
  workshop: "workshop",
  first_clear_unique: "first-clear reward",
  unlocked_at: "unlock location",
  seen_at: "home location",
  parent: "parent enemy",
};

/** The entity a `lore` (enemy_look) row describes, or null (the enemy is not in the data). */
function lookSubject(lore, registry) {
  if (lore.kind !== "lore" || lore.data?.lore_kind !== "enemy_look") return null;
  const byLink = lore.links.find((l) => l.rel === "describes" && l.kind === "enemy");
  const id = byLink?.id ?? String(lore.id).replace(/^look:/, "");
  return registry.get("enemy", id) ?? null;
}

/** Canonical id within a kind, resolving aliases/display when the value is a name rather than an id. */
function canonId(registry, kind, name) {
  const s = String(name ?? "");
  if (!s) return null;
  if (registry.has(kind, s)) return s;
  for (const e of registry.findByName(s)) if (e.kind === kind) return e.id;
  return null;
}

/** The display/name of a resolved subject or value, used only for the message text. */
const label = (registry, kind, id) => registry.get(kind, id)?.display ?? id;

function collectFacts(registry) {
  const facts = []; // { subj:{kind,id}, slot, val:{kind,id}, how:'link'|'lore', src, entity }
  const add = (subj, slot, val, how, src, entity) => facts.push({ subj, slot, val, how, src, entity });
  for (const e of registry.all()) {
    // enemy_look rows describe an enemy: re-key seen_at / parent to that enemy, not the lore row itself
    const look = lookSubject(e, registry);
    for (const l of e.links ?? []) {
      const slot = LINK_SLOTS.get(l.rel);
      if (!slot) {
        if (look && (l.rel === "seen_at" || l.rel === "parent")) {
          const cid = canonId(registry, l.kind, l.id);
          if (cid) add(look, l.rel, { kind: l.kind, id: cid }, "link", e.source, e);
        }
        continue;
      }
      const cid = canonId(registry, l.kind, l.id);
      if (!cid) continue; // dangling ref: #1's job, not a lore fact
      if (slot === "boss_of" && l.rel === "boss") add({ kind: l.kind, id: cid }, slot, { kind: e.kind, id: e.id }, "link", e.source, e);
      else add({ kind: e.kind, id: e.id }, slot, { kind: l.kind, id: cid }, "link", e.source, e);
    }
  }
  // PLAN_MAP_VIBES per-map "Boss" backtick id -> boss_of (enemy -> map location). Only single-location maps (map_vibe);
  // band_vibe spans several floors and its "Boss" text names one floor, so it is skipped (precision over recall).
  const BOSS = /\*\*Boss\*\*\s*`([a-z0-9_]+)`/;
  for (const l of registry.byKind("lore")) {
    if (l.data?.lore_kind !== "map_vibe") continue;
    const m = BOSS.exec(String(l.data.fields?.roster ?? ""));
    if (!m) continue;
    const bossId = canonId(registry, "enemy", m[1]);
    if (!bossId) continue;
    const locs = (l.links ?? []).filter((x) => x.rel === "describes" && x.kind === "location");
    if (locs.length !== 1) continue; // a map is one location; anything else is a band/aggregate, not a single slot
    const locId = canonId(registry, "location", locs[0].id);
    if (!locId) continue; // dangling ref: #1's job, not a lore fact
    add({ kind: "enemy", id: bossId }, "boss_of", { kind: "location", id: locId }, "lore", l.source, l);
  }
  return facts;
}

export function runLore({ registry }) {
  const facts = collectFacts(registry);
  const byGroup = new Map(); // `${subjKey}\u0000${slot}` -> facts[]
  for (const f of facts) {
    const k = `${key(f.subj.kind, f.subj.id)}\u0000${f.slot}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)).push(f);
  }
  const out = [];
  for (const gk of [...byGroup.keys()].sort()) {
    const g = byGroup.get(gk);
    const slot = g[0].slot;
    const subj = g[0].subj;
    // distinct values for this (subject, slot), each carrying the sources that assert it
    const byVal = new Map();
    for (const f of g) {
      const vk = key(f.val.kind, f.val.id);
      (byVal.get(vk) ?? byVal.set(vk, []).get(vk)).push(f);
    }
    if (byVal.size < 2) continue; // every source agrees: no contradiction
    const subjEnt = registry.get(subj.kind, subj.id) ?? null;
    const vals = [...byVal.entries()].sort(([a], [b]) => cmpStr(a, b));
    const parts = vals.map(([vk, fs]) => {
      const v = fs[0].val;
      const names = [...new Set(fs.map((f) => f.src?.path ?? f.entity.source?.path ?? "?"))].sort();
      return `${label(registry, v.kind, v.id)} (${v.kind}:${v.id}, ${names.join(", ")})`;
    });
    // warn when every distinct value has structured (link) support; info once a value leans only on the lore parse
    const allStructural = [...byVal.values()].every((fs) => fs.some((f) => f.how === "link"));
    // deterministic source: the first fact that asserts a differing value, so the pointer lands on a conflicting claim.
    // Sort by source location first so the pick does not depend on registry/insertion order.
    const bySource = (a, b) => cmpStr(a.src?.path ?? "", b.src?.path ?? "") || ((a.src?.line ?? 0) - (b.src?.line ?? 0));
    const differing = vals.find(([vk]) => vk !== vals[0][0])?.[1]?.slice().sort(bySource)[0];
    const src = differing?.src ?? subjEnt?.source ?? g[0].src;
    const subjLabel = label(registry, subj.kind, subj.id);
    out.push(finding(allStructural ? "warn" : "info", subjEnt, `${subjLabel} (${subj.kind}:${subj.id}) has ${vals.length} ${SLOT_LABEL[slot] ?? slot} values: ${parts.join(" vs ")}`, src));
  }
  return out;
}

export const checks = [{ id: "#12", title: "Lore contradictions (fact triples)", run: runLore }];
export default checks;
