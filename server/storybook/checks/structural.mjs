// SB2 structural checks: #1 dangling ids, #2 kill target spawns, #5 spawn window / reach caps, #7 collisions, #8 STORY-TODO leftovers.
// Project-agnostic: everything project-specific comes from entity data/links and adapter hooks.

import { KIND_TABLE } from "../../registry/index.mjs";

const ref = (e) => ({ kind: e.kind, id: e.id });
const F = (check, severity, e, msg, source = e?.source ?? null) => ({ check, severity, entityRef: e ? ref(e) : null, msg, source });
const isTodoText = (s) => /^STORY-TODO:/.test(String(s ?? ""));

// #1 every link resolves in the registry. Links are what the adapter extracted from id-typed fields.
function dangling({ registry }) {
  const out = [];
  for (const e of registry.all()) {
    for (const l of e.links) {
      if (!registry.resolve(l)) out.push(F("#1", "error", e, `${e.kind} ${e.id}: ${l.rel} -> ${l.kind} "${l.id}" does not exist`));
    }
  }
  return out;
}

const killSteps = (registry) => registry.byKind("quest_step").filter((s) => s.data.task?.type === "kill" && s.data.task.enemy_id);

// #2 a kill target spawns in the quest location, or somewhere when no location is given.
function killSpawns({ registry, hooks }) {
  const out = [];
  for (const s of killSteps(registry)) {
    const { enemy_id: enemy, location } = s.data.task;
    if (!registry.has("enemy", enemy)) continue; // #1's job
    const where = hooks.killTargetLocations(registry, enemy);
    if (location) {
      if (!registry.has("location", location)) continue; // #1's job
      if (!where.includes(location)) out.push(F("#2", "warn", s, `${s.id}: kills ${enemy} at ${location}, but ${enemy} never spawns there${where.length ? ` (spawns at: ${where.join(", ")})` : " (spawns nowhere)"}`));
    } else if (!where.length) out.push(F("#2", "warn", s, `${s.id}: kills ${enemy} but ${enemy} spawns at no location`));
  }
  return out;
}

// #5 spawn window vs default raid length; reach level vs room/skill cap.
function reachability({ registry, hooks }) {
  const out = [];
  for (const s of killSteps(registry)) {
    const { enemy_id: enemy, location, qty } = s.data.task;
    if (!registry.has("enemy", enemy)) continue;
    const locs = location ? [location] : hooks.killTargetLocations(registry, enemy);
    const wins = locs.map((l) => [l, hooks.spawnWindow(registry, l, enemy)]).filter(([, w]) => w);
    if (!wins.length) continue; // #2's job
    const late = wins.filter(([, w]) => w.defaultRaidSeconds != null && w.min >= w.defaultRaidSeconds);
    if (late.length) {
      const d = late.map(([l, w]) => `${l} ${w.min}-${w.max ?? "end"}s vs default raid ${w.defaultRaidSeconds}s`).join("; ");
      const all = late.length === wins.length;
      out.push(F("#5", all ? "warn" : "info", s, `${s.id}: kill ${enemy}${qty ? ` x${qty}` : ""} ${all ? "cannot happen in a default-length raid" : "is out of reach in a default-length raid at some locations"} (${d})${all ? "; needs an extended raid" : ""}`));
    }
  }
  for (const s of registry.byKind("quest_step")) {
    const t = s.data.task ?? {};
    if (t.type !== "reach" || !Number.isFinite(t.level)) continue;
    if (t.room) {
      const r = registry.get("room", t.room);
      const cap = r?.data.max_level;
      if (Number.isFinite(cap) && t.level > cap) out.push(F("#5", "warn", s, `${s.id}: reach ${t.room} level ${t.level}, but the room caps at level ${cap}`));
    }
    if (t.skill) {
      const cap = registry.get("skill", t.skill)?.data.max_level;
      if (Number.isFinite(cap) && t.level > cap) out.push(F("#5", "warn", s, `${s.id}: reach ${t.skill} level ${t.level}, but the skill caps at level ${cap}`));
    }
  }
  return out;
}

// #7 collisions. Only registry-style kinds take part; text/lore/voice-card ids intentionally repeat their speaker's id.
const ID_KINDS = ["trader", "squad", "enemy", "location", "room", "item", "skill", "contract", "recipe", "quest_step"];
const NAME_KINDS = ["trader", "squad", "enemy", "location", "room", "item"];
// Kinds whose names read as people: a word shared between two of them is a real naming clash. A word shared with an
// item/room is category overlap ("Scav" vs "Scav Boots", "Barrel" vs "Barrel Fire"), not an ambiguous person.
export const CHARACTER_KINDS = KIND_TABLE.defs.filter((d) => d.character).map((d) => d.kind);
const normName = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ").replace(/^(?:the|a|an) /, "");
const tokens = (s) => normName(s).split(/[^a-z0-9']+/).filter(Boolean);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order: host-independent
const byRef = (a, b) => cmpStr(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`);

function collisions({ registry }) {
  const out = [];
  for (const d of registry.duplicates) out.push(F("#7", "warn", d, `duplicate ${d.kind} id "${d.id}" (a second row reuses it; the first wins)`));
  // same id in two registries (recipe/item share ids by design: a recipe is keyed by what it makes)
  const ids = new Map();
  for (const e of registry.all()) if (ID_KINDS.includes(e.kind)) (ids.get(e.id) ?? ids.set(e.id, []).get(e.id)).push(e);
  for (const [id, es] of ids) {
    const kinds = [...new Set(es.map((e) => e.kind))];
    if (kinds.length < 2 || kinds.every((k) => k === "recipe" || k === "item")) continue;
    es.sort(byRef);
    out.push(F("#7", "warn", es[0], `id "${id}" is used by ${es.map((e) => e.kind).join(" + ")} (${es.map((e) => e.display).join(" / ")})`));
  }
  // display collisions: identical names (alias-aware), or a one-word character name that is a whole word of another
  // character's name. The word-subset clause is character-only so same-kind item chains (Coffee/Coffee Beans),
  // item-vs-room aliases (Barrel/Barrel Fire) and character-vs-item theme overlap (Scav/Scav Boots) stay quiet.
  const named = registry.all().filter((e) => NAME_KINDS.includes(e.kind));
  const names = (e) => [...new Set([e.display, ...e.aliases.filter((a) => a !== e.id)].map(normName).filter(Boolean))];
  const exact = new Map();
  for (const e of named) for (const n of names(e)) (exact.get(n) ?? exact.set(n, []).get(n)).push(e);
  const seen = new Set();
  for (const [n, es] of [...exact].sort(([a], [b]) => cmpStr(a, b))) {
    if (es.length < 2) continue;
    es.sort(byRef);
    seen.add(n);
    const same = new Set(es.map((e) => e.kind)).size === 1;
    out.push(F("#7", same ? "warn" : "info", es[0], `name "${n}" is shared by ${es.map((e) => `${e.kind} ${e.id} (${e.display})`).join(", ")}`));
  }
  const characters = named.filter((e) => CHARACTER_KINDS.includes(e.kind));
  const single = new Map();
  for (const e of named) for (const n of names(e)) if (tokens(n).length === 1) { const w = tokens(n)[0]; (single.get(w) ?? single.set(w, []).get(w)).push(e); }
  for (const [w, allOwners] of [...single].sort(([a], [b]) => cmpStr(a, b))) {
    if (seen.has(w)) continue;
    const owners = allOwners.filter((e) => CHARACTER_KINDS.includes(e.kind));
    const hits = characters.filter((e) => !owners.includes(e) && names(e).some((n) => tokens(n).length > 1 && tokens(n).includes(w)));
    if (!owners.length || !hits.length) continue;
    const all = [...owners, ...hits].sort(byRef);
    out.push(F("#7", "info", all[0], `word "${w}" is a name and also part of another name: ${all.map((e) => `${e.kind} ${e.id} (${e.display})`).join(", ")}`));
  }
  return out;
}

// #8 STORY-TODO leftovers: prefixed strings in data + `# ... STORY-TODO` comments in .gd source (needs a reader and the adapter hook).
async function storyTodo({ registry, hooks, reader }) {
  const out = [];
  for (const s of registry.byKind("quest_step")) {
    for (const f of ["title", "story"]) if (isTodoText(s.data[f])) out.push(F("#8", "info", s, `${s.id}.${f} still carries STORY-TODO: ${JSON.stringify(s.data[f].slice(11).trim().slice(0, 50))}`));
  }
  for (const l of registry.byKind("line")) {
    if (l.data.origin === "raid_story") continue;
    if (l.data.origin === "csv") {
      const nat = Array.isArray(l.data.provenance) ? l.data.provenance.find((p) => p.origin !== "csv" && p.origin !== "raid_story" && isTodoText(p.text ?? l.data.text)) : null;
      if (nat) out.push(F("#8", "info", l, `${nat.id} still carries STORY-TODO: ${JSON.stringify((nat.text ?? l.data.text).slice(11).trim().slice(0, 50))}`));
      continue;
    }
    if (isTodoText(l.data.text)) out.push(F("#8", "info", l, `${l.id} still carries STORY-TODO: ${JSON.stringify(l.data.text.slice(11).trim().slice(0, 50))}`));
  }
  if (reader && typeof hooks.sourceTodoComments === "function") {
    for (const c of await hooks.sourceTodoComments(reader)) out.push({ check: "#8", severity: "info", entityRef: null, msg: `STORY-TODO comment in ${c.path}:${c.line}: ${c.text}`, source: { path: c.path, line: c.line } });
  }
  return out;
}

export const checks = [
  { id: "#1", title: "Dangling ids", run: dangling },
  { id: "#2", title: "Kill target spawns in quest location", run: killSpawns },
  { id: "#5", title: "Spawn window / reach caps", run: reachability },
  { id: "#7", title: "Id and display collisions", run: collisions },
  { id: "#8", title: "STORY-TODO leftovers", run: storyTodo },
];
