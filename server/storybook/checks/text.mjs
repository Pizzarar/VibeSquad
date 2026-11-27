// Storybook text / cohesion checks (SB3): #3 doc<->data drift, #4 speaker inference + card bans, #6 template clustering,
// #9 referent-aware pronouns, #10 tone bans with a context allowlist, #11 title<->task coherence.
// Deterministic heuristics only (no LLM). Pure functions over the SB1 registry: nothing here reads a repo.
//
// Contract (SB2's checks/index.mjs collects these): `checks = [{id, title, run(ctx) -> Finding[]}]`,
// ctx = { snapshot, registry (makeRegistry), adapter, hooks }. Findings follow schema.mjs (never changed here).
//
// Severity note: #11 is lexical only, so every #11 finding is info (low confidence); it never warns.
// Ownership notes (so two checks never report the same hit):
//  - Global tone bans (paranormal / magic / meme / "adventurer" / fourth wall) are enforced by #10 over ALL player-facing text.
//    #4 enforces only what is speaker-specific: the card's "Never says" terms and the player word.
//  - The player word: VOICE_BIBLE's default is "runner"; a card whose "Calls the player" list omits "runner" must not use it.
//  - Dedupe: csv rows (docs/review/text_review.csv, imported as `line` entities with origin "csv") that repeat a native
//    entity's text are skipped; their owner_rewrite text is always checked because that is what would ship.

const STORY_TODO = /^STORY-TODO:\s*/;
export const clean = (s) => String(s ?? "").replace(STORY_TODO, "").trim();
export const norm = (s) => clean(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ref = (e) => ({ kind: e.kind, id: e.id });
const finding = (check, severity, entity, msg, source) => ({ check, severity, entityRef: entity ? ref(entity) : null, msg, source: source ?? entity?.source ?? null });
const clip = (s, n = 90) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

const STOP = new Set("a an and are as at be but by for from had has have he her his i if in is it its me my of on or our she so than that the their them then there they this to us was we were what when where who will with you your own do does did not no up out off about into over".split(" "));
const contentWords = (s) => (norm(s).match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
export function sameStem(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= Math.min(n, 5);
}
const overlap = (aWords, bWords) => aWords.filter((a) => bWords.some((b) => sameStem(a, b)));

// ---------------------------------------------------------------------------------------------------------------------
// Shared: people, cards, speakers, text units
// ---------------------------------------------------------------------------------------------------------------------
function people(registry) {
  const byDisplay = new Map();
  for (const e of [...registry.byKind("trader"), ...registry.byKind("squad")]) byDisplay.set(e.display.toLowerCase(), e);
  return byDisplay;
}
function cardIndex(registry) {
  const m = new Map();
  for (const c of registry.byKind("voice_card")) m.set(`${c.data.speakerKind}:${c.data.speakerId}`, c);
  return m;
}
export const cardFor = (cards, speaker) => (speaker ? cards.get(`${speaker.kind}:${speaker.id}`) ?? null : null);

function pathParts(e) {
  try { const v = JSON.parse(e.data.data_path); return Array.isArray(v) ? v : null; } catch { return null; }
}

/**
 * Who is speaking this entity's text? -> {kind:'trader'|'squad'|'actor'|'narrator', id, via:'explicit'|'path'|'role'} or null.
 * 'explicit' = the data/CSV already names a speaker; 'path' = inferred from the data path (questline -> trader,
 * trader_relations -> trader, squad.json members[i] -> squad member); 'role' = a raid_story actor (callsign) or a narrator.
 */
export function inferSpeaker(e, registry) {
  const ppl = people(registry);
  if (e.kind === "quest_step") return e.data.trader ? { kind: "trader", id: e.data.trader, via: "explicit" } : null;
  if (e.kind !== "line") return null;
  const o = e.data.origin;
  if (o === "trader_relations" || o === "encouragement") return { kind: "trader", id: e.data.speaker, via: "explicit" };
  if (o === "squad") return { kind: "squad", id: e.data.speaker, via: "explicit" };
  if (o === "raid_story") return { kind: "actor", id: e.data.speaker ?? "actor", via: "role" };
  if (o === "long_haul") return { kind: "narrator", id: "narrator", via: "role" };
  if (o !== "csv") return null;
  const named = String(e.data.speaker ?? "").trim();
  if (named) {
    const hit = ppl.get(named.toLowerCase());
    if (hit) return { kind: hit.kind, id: hit.id, via: "explicit" };
    return { kind: "narrator", id: named, via: "explicit" };
  }
  const file = e.data.file ?? "";
  const p = pathParts(e);
  if (file === "data/questlines.json" && p?.[0] === "questlines" && registry.has("trader", p[1])) return { kind: "trader", id: p[1], via: "path" };
  if (file === "data/trader_relations.json" && p?.[0] === "traders" && registry.has("trader", p[1])) return { kind: "trader", id: p[1], via: "path" };
  if (file === "data/squad.json" && p?.[0] === "members" && Number.isInteger(p[1])) {
    const m = registry.byKind("squad")[p[1]];
    if (m) return { kind: "squad", id: m.id, via: "path" };
  }
  if (/raid_story\.gd$/.test(file)) return { kind: "actor", id: "actor", via: "role" };
  return null;
}

/** Text fields of one entity: [{field, text, rewrite?}] */
function fieldsOf(e) {
  if (e.kind === "quest_step") return [{ field: "title", text: clean(e.data.title) }, { field: "story", text: clean(e.data.story) }].filter((f) => f.text);
  if (e.kind !== "line") return [];
  if (e.data.origin === "encouragement") return [{ field: "title", text: clean(e.data.title) }, { field: "story", text: clean(e.data.story) }].filter((f) => f.text);
  if (e.data.origin === "csv") return [{ field: "current_text", text: clean(e.data.current_text) }].filter((f) => f.text);
  return [{ field: e.data.field ?? "text", text: clean(e.data.text) }].filter((f) => f.text);
}

/**
 * Narrative text units, native entities first, then csv rows whose text no native entity already carries.
 * unit = { entity, speaker, origin, fields:[{field,text,rewrite?}] }. owner_rewrite text is always carried (as rewrite:true).
 */
export function collectUnits(registry) {
  const units = [];
  const seen = new Set();
  const lines = registry.byKind("line");
  const natives = [...registry.byKind("quest_step"), ...lines.filter((l) => l.data.origin !== "csv")];
  for (const e of natives) {
    const fields = fieldsOf(e);
    if (!fields.length) continue;
    for (const f of fields) seen.add(norm(f.text));
    units.push({ entity: e, speaker: inferSpeaker(e, registry), origin: e.kind === "quest_step" ? "questline" : e.data.origin, fields });
  }
  for (const e of lines.filter((l) => l.data.origin === "csv")) {
    const fields = fieldsOf(e).filter((f) => !seen.has(norm(f.text)));
    const rw = clean(e.data.owner_rewrite);
    if (rw) fields.push({ field: "owner_rewrite", text: rw, rewrite: true });
    if (!fields.length) continue;
    units.push({ entity: e, speaker: inferSpeaker(e, registry), origin: "csv", fields });
  }
  return units;
}

/** Quoted speech inside a text ('…' or "…"); the whole text when it has no quotes. */
export function spokenSegments(text) {
  const out = [];
  const re = /(?:^|[\s(\[—-])'(.+?)'(?=$|[\s.,;:!?)\]—-])|"(.+?)"/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out.length ? out : [text];
}

function termRegex(term) {
  if (term.startsWith("re:")) return new RegExp(term.slice(3), "i");
  return new RegExp(`(?<![\\w'])${esc(term)}(?![\\w'])`, "i");
}

// ---------------------------------------------------------------------------------------------------------------------
// #4 speaker inference + card bans
// ---------------------------------------------------------------------------------------------------------------------
const NARRATIVE_CSV = ["data/questlines.json", "data/trader_relations.json", "data/squad.json", "scenes/raids/corridor/raid_story.gd"];

export function runSpeakers(ctx) {
  const reg = ctx.registry;
  const out = [];
  // inference tally (info): csv rows of narrative files, by file
  const tally = new Map();
  for (const e of reg.byKind("line")) {
    if (e.data.origin !== "csv" || !NARRATIVE_CSV.includes(e.data.file)) continue;
    const t = tally.get(e.data.file) ?? { explicit: 0, inferred: new Map(), unresolved: 0, role: 0 };
    tally.set(e.data.file, t);
    const hadSpeaker = String(e.data.speaker ?? "").trim() !== "";
    const sp = inferSpeaker(e, reg);
    if (hadSpeaker) t.explicit++;
    else if (!sp) t.unresolved++;
    else if (sp.via === "role") t.role++;
    else t.inferred.set(sp.id, (t.inferred.get(sp.id) ?? 0) + 1);
  }
  for (const [file, t] of tally) {
    const inferred = [...t.inferred.values()].reduce((a, b) => a + b, 0);
    const parts = [`${inferred} rows inferred a speaker from the data path`];
    if (inferred) parts[0] += ` (${[...t.inferred].map(([k, n]) => `${k} ${n}`).join(", ")})`;
    if (t.role) parts.push(`${t.role} rows get the actor/callsign role`);
    if (t.explicit) parts.push(`${t.explicit} rows already carry a speaker`);
    if (t.unresolved) parts.push(`${t.unresolved} rows could not be inferred`);
    // DOGFOOD_W2 friction 11: route #4 speaker-inference adapter diagnostics out of Story issues to snapshot.warnings.
    if (Array.isArray(ctx.snapshot?.warnings)) ctx.snapshot.warnings.push(`speaker inference (${file}): ${parts.join("; ")}`);
  }
  // bans
  const cards = cardIndex(reg);
  for (const u of collectUnits(reg)) {
    const card = cardFor(cards, u.speaker);
    if (!card) continue;
    const bans = (Array.isArray(card.data.neverSays) ? card.data.neverSays : []).map((t) => ({ t, re: termRegex(t) }));
    const callsRunner = (card.data.callsPlayer ?? []).some((c) => c.toLowerCase() === "runner");
    const forbidsRunner = (card.data.callsPlayer ?? []).length > 0 && !callsRunner;
    for (const f of u.fields) {
      const segs = spokenSegments(f.text);
      const hits = [];
      for (const b of bans) {
        const seg = segs.find((s) => b.re.test(s));
        if (seg) hits.push(`never-says "${b.t.replace(/^re:/, "/") + (b.t.startsWith("re:") ? "/" : "")}"`);
      }
      if (forbidsRunner && segs.some((s) => /(?<!\b(?:his|her|my|our|their|your|its) )(?<![\w'])runner(?![\w'])/i.test(s))) hits.push(`player word "runner" (card calls the player ${card.data.callsPlayer.map((c) => `"${c}"`).join(" / ")})`);
      for (const h of hits) out.push(finding("#4", "warn", u.entity, `${card.display} (card ${card.id}) breaks voice, ${h}, in ${f.field}: "${clip(f.text)}"`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// #6 template / n-gram clustering
// ---------------------------------------------------------------------------------------------------------------------
const TEMPLATE_ORIGINS = new Set(["questline", "trader_relations", "encouragement", "squad", "raid_story", "long_haul"]);
const PH = new Set(["<x>", "<n>", "<name>"]);
function shapeTokens(text, nameRe) {
  let s = norm(text).replace(/%[-+ 0#]*\d*(?:\.\d+)?[sdif]/g, " <x> ").replace(/\{[a-z_]+\}/g, " <x> ").replace(/\b\d+(?:\.\d+)?\b/g, " <n> ");
  if (nameRe) s = s.replace(nameRe, " <name> ");
  return s.replace(/<(x|n|name)>/g, " <$1> ").replace(/[^a-z0-9<>']+/g, " ").trim().split(" ").filter(Boolean).map((t) => (t === "<x>" || t === "<n>" || t === "<name>" ? t : t.replace(/'$/, "")));
}
function runInfo(a, b) {
  // longest common run + how many of its tokens are real words (placeholders do not count)
  let best = { len: 0, words: 0 };
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) {
      cur[j] = prev[j - 1] + 1;
      if (cur[j] >= best.len) {
        const run = a.slice(i - cur[j], i);
        const words = run.filter((t) => !PH.has(t)).length;
        if (cur[j] > best.len || words > best.words) best = { len: cur[j], words };
      }
    }
    prev = cur;
  }
  return best;
}

export function runTemplates(ctx) {
  const reg = ctx.registry;
  const out = [];
  const names = [...people(reg).keys()].filter((n) => n.length > 2).map(esc);
  const nameRe = names.length ? new RegExp(`\\b(?:the )?(?:${names.join("|")})\\b`, "gi") : null;
  const items = []; // one per story/text field of native narrative units
  for (const u of collectUnits(reg)) {
    if (!TEMPLATE_ORIGINS.has(u.origin)) continue;
    for (const f of u.fields) {
      if (f.field === "title" || f.rewrite) continue;
      if (u.origin === "squad" && !["name", "bio"].includes(f.field)) continue; // trait/flaw/synergy are stat blurbs, not prose
      const tokens = shapeTokens(f.text, nameRe);
      if (tokens.length < 4) continue;
      items.push({ u, f, tokens, shape: tokens.join(" "), raw: norm(f.text) });
    }
  }
  const grouped = new Set();
  const by = (keyFn) => { const m = new Map(); for (const it of items) { const k = keyFn(it); (m.get(k) ?? m.set(k, []).get(k)).push(it); } return m; };
  const where = (its) => its.map((i) => `${i.u.entity.id}`).join(", ");
  // identical text (different entities)
  for (const [, g] of by((i) => i.raw)) {
    const ents = new Set(g.map((i) => i.u.entity.id));
    if (ents.size < 2 || g[0].tokens.length < 5) continue;
    g.forEach((i) => grouped.add(i));
    out.push(finding("#6", "warn", g[0].u.entity, `identical text x${ents.size}: "${clip(g[0].f.text)}" (${where(g)})`));
  }
  // same template shape (names / numbers / placeholders erased)
  for (const [, g] of by((i) => i.shape)) {
    const fresh = g.filter((i) => !grouped.has(i));
    const ents = new Set(fresh.map((i) => i.u.entity.id));
    if (ents.size < 3) continue;
    fresh.forEach((i) => grouped.add(i));
    out.push(finding("#6", "warn", fresh[0].u.entity, `template repeated x${ents.size}: "${clip(fresh[0].f.text)}" (${where(fresh)})`));
  }
  // near-duplicates: a long shared word run
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const A = items[a], B = items[b];
    if (A.u.entity === B.u.entity || (grouped.has(A) && grouped.has(B))) continue;
    if (A.u.origin === B.u.origin && A.u.speaker?.id === B.u.speaker?.id) continue; // parallel asks by one speaker are intended
    const short = Math.min(A.tokens.length, B.tokens.length);
    if (short < 6) continue;
    const r = runInfo(A.tokens, B.tokens);
    if (r.words < 3) continue;
    const frac = r.len / short;
    if ((r.len >= 5 && frac >= 0.5) || (r.len >= 4 && frac >= 0.7)) {
      const run = r.len;
      out.push(finding("#6", "warn", A.u.entity, `near-duplicate (${run}-word shared run, ${Math.round(frac * 100)}% of the shorter): ${A.u.entity.id} "${clip(A.f.text, 70)}" ~ ${B.u.entity.id} "${clip(B.f.text, 70)}"`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// #9 referent-aware pronouns
// ---------------------------------------------------------------------------------------------------------------------
const PRON = { he: "he", him: "he", his: "he", himself: "he", she: "she", her: "she", hers: "she", herself: "she" };

function nameMentions(text, ppl) {
  // capitalised person names in `text` -> [{index, person}]; skips "Tank Diver"-style multiword proper names
  const out = [];
  for (const [low, person] of ppl) {
    const name = person.display;
    if (name.length < 3) continue;
    const re = new RegExp(`\\b${esc(name)}\\b(?!\\s+[A-Z][a-z])`, "g");
    let m;
    while ((m = re.exec(text))) out.push({ index: m.index, person });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function runPronouns(ctx) {
  const reg = ctx.registry;
  const out = [];
  const ppl = people(reg);
  const cards = cardIndex(reg);
  const pronOf = (p) => cardFor(cards, { kind: p.kind, id: p.id })?.data.pronoun ?? null;
  for (const u of collectUnits(reg)) {
    const sp = u.speaker;
    if (!sp || (sp.kind !== "trader" && sp.kind !== "squad")) continue;
    const subject = reg.get(sp.kind, sp.id);
    if (!subject) continue;
    const rivals = sp.kind === "trader" ? (subject.data.rivals ?? []).map((id) => reg.get("trader", id)).filter(Boolean) : [];
    for (const f of u.fields) {
      const text = f.text;
      // quote ranges (direct speech), or the whole text when the trader plainly speaks in first person
      const ranges = [];
      const re = /(?:^|[\s(\[—-])'(.+?)'(?=$|[\s.,;:!?)\]—-])|"(.+?)"/g;
      let m;
      while ((m = re.exec(text))) { const g = m[1] ?? m[2]; if (!/\s/.test(g)) continue; /* single-word quotes are scare quotes, not speech */ const s = m.index + m[0].indexOf(g); ranges.push([s, s + g.length]); }
      const firstPerson = !ranges.length && /\b(?:I|I'm|I've|I'll|me|my)\b/.test(text);
      if (firstPerson) ranges.push([0, text.length]);
      const inRange = (i) => ranges.find(([a, b]) => i >= a && i < b) ?? null;
      const mentions = nameMentions(text, ppl);
      const pr = /\b(he|him|his|himself|she|her|hers|herself)\b/gi;
      while ((m = pr.exec(text))) {
        const gender = PRON[m[1].toLowerCase()];
        const q = inRange(m.index);
        const before = mentions.filter((x) => x.index < m.index && (q ? x.index >= q[0] : !inRange(x.index)));
        let candidates; let how;
        if (before.length) { candidates = [before[before.length - 1].person]; how = `named earlier: ${candidates[0].display}`; }
        else if (q) { candidates = rivals; how = rivals.length ? `speech by ${subject.display}: refers to a rival` : ""; }
        else { candidates = [subject]; how = `the ${sp.kind} this text is about`; }
        if (!candidates.length) continue;
        const known = candidates.map(pronOf).filter(Boolean);
        if (!known.length) continue; // unset pronouns (most squad members) are never flagged
        if (known.some((k) => k === gender)) continue;
        out.push(finding("#9", "warn", u.entity, `pronoun "${m[1]}" in ${f.field} refers to ${candidates.map((c) => c.display).join("/")} (${how}) whose card pronoun is ${known.join("/")}: "${clip(text)}"`));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// #10 tone bans with a context allowlist
// ---------------------------------------------------------------------------------------------------------------------
export const TONE_TERMS = [
  { cat: "paranormal", re: /\b(?:paranormal|supernatural|ghosts?|haunted|haunting|poltergeists?|occult|s[eé]ances?|demonic|undead|zombies?|spirits?)\b/i },
  { cat: "magic", re: /\b(?:magic(?:al|ally)?|wizards?|sorcer\w+|witchcraft|spellbooks?|enchant\w*|mystic(?:al)?|mana|cast(?:s|ing)? (?:a )?spells?)\b/i },
  { cat: "meme slang", re: /\b(?:lol|lmao|rofl|yeet\w*|no cap|rizz|poggers|stonks|bruh|noobs?|n00bs?|pwn(?:ed|s)?|vibe check|skibidi)\b/i },
  { cat: "adventurer", re: /\badventurers?\b/i },
  { cat: "fourth wall", re: /\b(?:npcs?|video ?games?|fourth wall|playtest\w*|in-game|game devs?|game designers?)\b/i },
];
const ALCOHOL = /\b(?:alcohol|fuel|ethanol|distill\w*|methylated|denatured|liquor|moonshine|booze|burn(?:s|ing)?|bottle[sd]?|solvent|flask|drink|rubbing|surgical|white spirits?|mineral|proof)\b/i;
/** Context allowlist: a hit is dropped when `when(match, text, entity)` is true. */
export const TONE_ALLOWLIST = [
  { id: "spirits-alcohol", cat: "paranormal", term: /^spirits?$/i, why: "spirits = alcohol/solvent in a fuel/recipe/item context", when: (m, text, e) => ["recipe", "item"].includes(e.kind) || ALCOHOL.test(text) },
  { id: "ghost-name", cat: "paranormal", term: /^ghosts?$/i, why: "Ghost as a proper-noun callsign/unit name", when: (m, text) => /\bGhost\b/.test(text) && /\b(?:callsign|squad|unit|team)\b/i.test(text) },
];

function toneTexts(reg) {
  const items = []; // {entity, field, text}
  const seen = new Set();
  const add = (entity, field, text) => {
    const t = clean(text);
    if (!t) return;
    const k = norm(t);
    if (seen.has(k)) return;
    seen.add(k);
    items.push({ entity, field, text: t });
  };
  // native entities first so the dedupe keeps their kind (the spirits allowlist keys on recipe/item), then narrative units
  for (const e of reg.byKind("recipe")) add(e, "description", e.data.description);
  for (const e of reg.byKind("item")) add(e, "description", e.data.description);
  for (const e of reg.byKind("trader")) add(e, "description", e.data.description);
  for (const e of reg.byKind("location")) add(e, "danger_rating", e.data.danger_rating);
  for (const u of collectUnits(reg)) for (const f of u.fields) add(u.entity, f.field, f.text);
  return items;
}

/** Scan once; returns {hits, allowed} so a smoke can print the allowlisted tally too. */
export function scanTone(reg) {
  const hits = [];
  const allowed = [];
  for (const it of toneTexts(reg)) {
    for (const t of TONE_TERMS) {
      const re = new RegExp(t.re.source, "gi");
      let m;
      while ((m = re.exec(it.text))) {
        const al = TONE_ALLOWLIST.find((a) => a.cat === t.cat && a.term.test(m[0]) && a.when(m, it.text, it.entity));
        (al ? allowed : hits).push({ ...it, cat: t.cat, match: m[0], allow: al ?? null });
      }
    }
  }
  return { hits, allowed };
}
export function runTone(ctx) {
  return scanTone(ctx.registry).hits.map((h) => finding("#10", "warn", h.entity, `tone ban (${h.cat}): "${h.match}" in ${h.field}: "${clip(h.text)}"`));
}

// ---------------------------------------------------------------------------------------------------------------------
// #11 title <-> task coherence
// ---------------------------------------------------------------------------------------------------------------------
function targetWords(reg, task) {
  const names = (kind, id) => { const e = id ? reg.get(kind, id) : null; return e ? contentWords(`${e.display} ${e.id.replace(/_/g, " ")} ${(e.aliases ?? []).join(" ")} ${kind === "item" ? String(e.data?.category ?? "").replace(/_/g, " ") : ""}`) : contentWords(String(id ?? "").replace(/_/g, " ")); };
  const w = [];
  if (task.item_id) w.push(...names("item", task.item_id));
  if (task.enemy_id) w.push(...names("enemy", task.enemy_id));
  if (task.location) w.push(...names("location", task.location));
  if (task.room) w.push(...names("room", task.room));
  if (task.skill) w.push(...names("skill", task.skill));
  w.push(...contentWords(task.type ?? ""));
  return w;
}
const describeTask = (t) => `${t.type}${t.item_id ? ` ${t.item_id}` : ""}${t.enemy_id ? ` ${t.enemy_id}` : ""}${t.location ? ` @${t.location}` : ""}${t.room ? ` room ${t.room}` : ""}${t.skill ? ` skill ${t.skill}` : ""}`;

export function runTitleTask(ctx) {
  const reg = ctx.registry;
  const out = [];
  const csvById = new Map();
  for (const e of reg.byKind("line")) if (e.data.origin === "csv" && e.data.id) csvById.set(e.data.id, e);
  const coherent = (title, story, tw) => { const t = contentWords(title); return !t.length || overlap(t, [...tw, ...contentWords(story)]).length > 0; };
  for (const s of reg.byKind("quest_step")) {
    const title = clean(s.data.title);
    const story = clean(s.data.story);
    const tw = targetWords(reg, s.data.task ?? {});
    if (coherent(title, story, tw)) continue;
    const desc = `${s.id} "${title}" shares no word with its task (${describeTask(s.data.task ?? {})}) or its story`;
    const tRow = csvById.get(`${s.id}.title`);
    const sRow = csvById.get(`${s.id}.story`);
    const rewrite = clean(tRow?.data.owner_rewrite);
    if (!rewrite) { out.push(finding("#11", "info", s, `${desc}; no OWNER-OK/DRAFT rewrite exists (lexical check only, low confidence)`)); continue; }
    const status = String(tRow.data.status ?? "").trim() || "unset";
    const story2 = clean(sRow?.data.owner_rewrite) || story;
    if (coherent(rewrite, story2, tw)) out.push(finding("#11", "info", s, `${desc}; fixed by the ${status} rewrite "${rewrite}" (csv row ${tRow.data.csv_line ? `line ${tRow.data.csv_line}` : tRow.id}), not yet applied to data when status is not OWNER-OK`));
    else out.push(finding("#11", "info", s, `${desc}; the ${status} rewrite "${rewrite}" does not fix it either (lexical check only, low confidence)`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// #3 doc <-> data drift
// ---------------------------------------------------------------------------------------------------------------------
const DOCS = ["VOICE_BIBLE", "QUEST_AUDIT", "PLAN_MAP_VIBES"];
const strings = (v, acc = []) => { if (typeof v === "string") acc.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, acc)); else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, acc)); return acc; };
const dehyphen = (s) => s.replace(/-/g, " ");
const entityText = (e) => dehyphen(norm([e.display, ...strings(e.data)].join(" \n ")));

function auditRows(text) {
  const rows = [];
  const re = /^- \*\*([a-z]+_\d+)\*\* — (deliver|extract|kill|reach) · (.+?) · R1 .*?`:(\d+)`\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const [, id, type, target, cite] = m;
    const row = { id, type, line: lineOf(text, m.index), cite: Number(cite), item: null, enemy: null, location: null, room: null, skill: null, qty: null, level: null };
    let t;
    if (type === "reach") { t = /^(room|skill) (\w+) lv(\d+)$/.exec(target); if (t) { row[t[1]] = t[2]; row.level = Number(t[3]); } }
    else if (type === "deliver") { t = /^(\w+) ×(\d+)$/.exec(target); if (t) { row.item = t[1]; row.qty = Number(t[2]); } }
    else if (type === "extract") { t = /^(\w+) ×(\d+)$/.exec(target); if (t) { row.location = t[1]; row.qty = Number(t[2]); } }
    else if (type === "kill") { t = /^(?:(\w+) )?(?:@(\w+) )?×(\d+)$/.exec(target); if (t) { row.enemy = t[1] ?? null; row.location = t[2] ?? null; row.qty = Number(t[3]); } }
    row.parsed = !!t;
    rows.push(row);
  }
  return rows;
}

function auditDrift(reg, doc) {
  const out = [];
  const text = doc.data.text;
  const src = (line) => ({ path: doc.data.path, line });
  const rows = auditRows(text);
  const proposals = new Map(); // step id -> proposal ids mentioned in the same table row
  for (const m of text.matchAll(/^\| \*\*(P-[\w-]+)\*\* \| ([^|]+) \|/gm)) for (const id of m[2].match(/[a-z]+_\d+/g) ?? []) (proposals.get(id) ?? proposals.set(id, []).get(id)).push(m[1]);
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.id);
    const step = reg.get("quest_step", r.id);
    if (!step) { out.push({ check: "#3", severity: "warn", entityRef: null, msg: `QUEST_AUDIT scores ${r.id} but no such quest step exists in the data`, source: src(r.line) }); continue; }
    const t = step.data.task ?? {};
    const diffs = [];
    if (r.parsed) {
      if (r.type !== t.type) diffs.push(`type ${r.type} -> ${t.type}`);
      if (r.item && r.item !== t.item_id) diffs.push(`item ${r.item} -> ${t.item_id ?? "none"}`);
      if (r.enemy !== null && r.enemy !== (t.enemy_id ?? null)) diffs.push(`enemy ${r.enemy} -> ${t.enemy_id ?? "any"}`);
      if (r.type === "kill" && r.enemy === null && t.enemy_id) diffs.push(`enemy any -> ${t.enemy_id}`);
      if (r.location && r.location !== (t.location ?? null)) diffs.push(`location ${r.location} -> ${t.location ?? "any"}`);
      if (r.type === "kill" && !r.location && t.location) diffs.push(`location any -> ${t.location}`);
      if (r.room && r.room !== t.room) diffs.push(`room ${r.room} -> ${t.room ?? "none"}`);
      if (r.skill && r.skill !== t.skill) diffs.push(`skill ${r.skill} -> ${t.skill ?? "none"}`);
      if (r.qty !== null && t.qty !== undefined && r.qty !== t.qty) diffs.push(`qty ${r.qty} -> ${t.qty}`);
      if (r.level !== null && t.level !== undefined && r.level !== t.level) diffs.push(`level ${r.level} -> ${t.level}`);
    }
    if (diffs.length) {
      const p = proposals.get(r.id);
      const tail = p ? ` (audit §4 ${p.join(", ")} proposes this change, the score table is pre-change)` : "";
      out.push(finding("#3", "warn", step, `QUEST_AUDIT scores ${r.id} as "${[r.type, r.item ?? r.enemy ?? r.location ?? r.room ?? r.skill].join(" ")}" but data is ${describeTask(t)}: ${diffs.join(", ")}${tail}`, src(r.line)));
    }
    if (step.source.line && r.cite !== step.source.line) out.push(finding("#3", "warn", step, `QUEST_AUDIT cites ${r.id} at ${step.source.path}:${r.cite} but the step is now at line ${step.source.line}`, src(r.line)));
  }
  for (const s of reg.byKind("quest_step")) if (!seen.has(s.id) && rows.length) out.push(finding("#3", "info", s, `quest step ${s.id} is not scored in QUEST_AUDIT`, s.source));
  const cm = /\*\*(\d+) steps across (\d+) chains\*\*/.exec(text);
  if (cm) {
    const steps = reg.byKind("quest_step").length;
    const chains = new Set(reg.byKind("quest_step").map((s) => s.data.trader)).size;
    if (Number(cm[1]) !== steps || Number(cm[2]) !== chains) out.push({ check: "#3", severity: "warn", entityRef: null, msg: `QUEST_AUDIT says ${cm[1]} steps across ${cm[2]} chains, data has ${steps} steps across ${chains} chains`, source: src(lineOf(text, cm.index)) });
  }
  return out;
}

const CITE = /((?:data|docs|scenes|systems|scripts|autoloads)\/[\w./-]+\.(?:json|gd|md|csv)|[\w-]+\.json):(\d+)(?:[–-](\d+))?/g;

function citeDrift(reg, doc, idx) {
  const out = [];
  const text = doc.data.text;
  const names = claimNames(reg);
  for (const m of text.matchAll(CITE)) {
    const file = m[1].includes("/") ? m[1] : `data/${m[1]}`;
    const a = Number(m[2]);
    const b = m[3] ? Number(m[3]) : a;
    const rows = idx.get(file);
    if (!rows) continue; // no native entities for that file: cannot resolve
    const cited = rows.filter((r) => (r.line >= a && r.line <= b) || (r.line <= a && r.next > a));
    if (!cited.length) continue;
    const corpus = cited.map((r) => r.text).join(" \n ");
    // clause: from the previous sentence boundary / cite up to this cite
    const upto = text.slice(0, m.index);
    const cut = Math.max(upto.lastIndexOf("\n"), upto.lastIndexOf(". "), upto.lastIndexOf("; "), upto.lastIndexOf(") "), upto.lastIndexOf("— "));
    const clause = upto.slice(cut + 1);
    const src = { path: doc.data.path, line: lineOf(text, m.index) };
    const citeLabel = `${file}:${m[2]}${m[3] ? `-${m[3]}` : ""}`;
    const quoted = [...clause.matchAll(/"([^"]{6,}?)"/g)];
    const inQuote = (i) => quoted.some((q) => i >= q.index && i < q.index + q[0].length);
    for (const q of quoted) {
      for (const frag of q[1].split(/…|\.\.\./).map((s) => norm(s).replace(/[.,;:!?]+$/, "").trim()).filter((s) => s.split(" ").length >= 3)) {
        const fr = dehyphen(frag);
        if (corpus.includes(fr)) continue;
        // significant-word containment: a quote of a line that dropped a modifier ("gun bench" vs "the bench") is not drift
        const fw = contentWords(fr);
        if (fw.length && fw.every((w) => contentWords(corpus).some((c) => sameStem(w, c)))) continue;
        const elsewhere = idx.all.find((r) => r.text.includes(fr));
        out.push(finding("#3", "warn", null, `${doc.display.replace(" (doc)", "")} quotes "${clip(frag, 60)}" at ${citeLabel}, ${elsewhere ? `but it is now at ${elsewhere.path}:${elsewhere.line}` : "which no longer contains it (not found anywhere in the data)"}`, src));
      }
    }
    const lc = dehyphen(clause.toLowerCase());
    const missing = new Set();
    for (const n of names) {
      const mm = n.re.exec(lc);
      n.re.lastIndex = 0;
      if (!mm || inQuote(mm.index)) continue;
      if (!n.re.test(corpus)) missing.add(n.label);
      n.re.lastIndex = 0;
    }
    for (const label of missing) {
      const near = (idx.get(file) ?? []).find((r) => Math.abs(r.line - a) <= 3 && !cited.includes(r) && names.find((n) => n.label === label).re.test(r.text));
      names.find((n) => n.label === label).re.lastIndex = 0;
      const head = label.split(" ").slice(-1)[0];
      const partial = label.includes(" ") && new RegExp(`\\b${esc(head)}`, "i").test(dehyphen(corpus)); // "gun bench" vs "the bench": head noun survives -> info
      out.push(finding("#3", partial ? "info" : "warn", null, `${doc.display.replace(" (doc)", "")} says "${label}" at ${citeLabel}, but the cited data no longer mentions it${near ? ` (it is at ${file}:${near.line}, the cite looks stale)` : ""}: "${clip(clause.trim(), 100)}"`, src));
    }
  }
  return out;
}

function claimNames(reg) {
  // item/enemy/location/room names a doc clause can claim; plural-tolerant, whole-word, >= 4 chars
  const seen = new Set();
  const out = [];
  for (const kind of ["item", "enemy", "location", "room"]) for (const e of reg.byKind(kind)) {
    for (const n of [e.display, e.id.replace(/_/g, " ")]) {
      const k = dehyphen(String(n).toLowerCase());
      if (k.length < 4 || seen.has(k)) continue;
      seen.add(k);
      out.push({ label: k, re: new RegExp(`(?<![\\w'])${esc(k)}s?(?![\\w'])`, "gi") });
    }
  }
  return out;
}

function dataIndex(reg) {
  // path -> [{line, next, text, path}] over native (non-csv, non-doc) entities, sorted by line
  const byPath = new Map();
  for (const e of reg.all()) {
    if (!e.source.line || e.kind === "lore" || e.kind === "voice_card" || e.data?.origin === "csv") continue;
    (byPath.get(e.source.path) ?? byPath.set(e.source.path, []).get(e.source.path)).push({ line: e.source.line, path: e.source.path, text: entityText(e) });
  }
  const idx = new Map();
  const all = [];
  for (const [p, rows] of byPath) {
    rows.sort((x, y) => x.line - y.line);
    // merge rows sharing a start line (one cited line can hold several entities)
    const merged = [];
    for (const r of rows) { const last = merged[merged.length - 1]; if (last && last.line === r.line) last.text += ` \n ${r.text}`; else merged.push({ ...r }); }
    merged.forEach((r, i) => { r.next = merged[i + 1]?.line ?? r.line + 1; });
    idx.set(p, merged);
    all.push(...merged);
  }
  idx.all = all;
  return idx;
}

function vibeDrift(reg, hooks) {
  const out = [];
  if (!hooks?.spawnWindow) return out; // no adapter hook: cannot judge spawns
  for (const l of reg.byKind("lore")) {
    if (!["map_vibe", "band_vibe"].includes(l.data.lore_kind)) continue;
    const locs = l.links.filter((k) => k.rel === "describes" && k.kind === "location").map((k) => k.id).filter((id) => reg.has("location", id));
    if (!locs.length) continue;
    const field = l.data.lore_kind === "map_vibe" ? l.data.fields?.roster : l.data.fields?.signature_enemy;
    if (!field) continue;
    for (const id of [...field.matchAll(/`([a-z0-9_]+)`/g)].map((x) => x[1])) {
      if (!reg.has("enemy", id)) continue; // art-redo ids that are not in the data yet are not a claim about spawns
      if (locs.some((loc) => hooks.spawnWindow(reg, loc, id))) continue;
      out.push(finding("#3", "warn", l, `${l.display.replace(" (vibe)", "")}: PLAN_MAP_VIBES lists \`${id}\` but the data does not spawn it at ${locs.join("/")}`));
    }
  }
  return out;
}

export function runDocDrift(ctx) {
  const reg = ctx.registry;
  const out = [];
  const idx = dataIndex(reg);
  for (const name of DOCS) {
    const doc = reg.get("lore", `doc:${name}`);
    if (!doc) continue;
    if (name === "QUEST_AUDIT") out.push(...auditDrift(reg, doc));
    out.push(...citeDrift(reg, doc, idx));
  }
  if (reg.has("lore", "doc:PLAN_MAP_VIBES")) out.push(...vibeDrift(reg, ctx.hooks ?? ctx.adapter?.hooks));
  return out;
}

export const checks = [
  { id: "#3", title: "Doc ↔ data drift", run: runDocDrift },
  { id: "#4", title: "Speaker inference + card bans", run: runSpeakers },
  { id: "#6", title: "Template / n-gram clustering", run: runTemplates },
  { id: "#9", title: "Referent-aware pronouns", run: runPronouns },
  { id: "#10", title: "Tone bans (context allowlist)", run: runTone },
  { id: "#11", title: "Title ↔ task coherence", run: runTitleTask },
];
export default checks;
