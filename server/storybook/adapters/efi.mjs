// Storybook adapter for Escape From Idle (SB1). Read-only: every byte comes through a pinned-sha Reader (git show / ls-tree).
// Ingests INV v1 items 1-5 (docs/PLAN_STORYBOOK_V1.md): registries, narrative units, text_review.csv as is, VOICE_BIBLE cards,
// PLAN_MAP_VIBES + CONTENT_BREADTH "look" lines as lore.
//
// Never-says: VOICE_BIBLE's "Never says" sections are prose. Quoted terms in them ("good enough", "please") are extracted as
// banned terms. Prose bans that do not extract cleanly ("no contractions", "no ballistics or spec talk") get an explicit
// term list from NEVER_SAYS_OVERRIDES below, keyed by card id. A term starting with `re:` is a case-insensitive regex source,
// anything else is a case-insensitive whole-word/phrase. card.data.neverSays = extracted ∪ override terms (deduped);
// card.data.neverSaysProse keeps the raw sentence; card.data.neverSaysExtracted / neverSaysOverride show where each came from.
import os from "node:os";
import path from "node:path";
import { parseCsvObjects } from "../csv.mjs";
import { entity, makeRegistry } from "../schema.mjs";

const P = {
  traders: "data/traders.json", squad: "data/squad.json", enemies: "data/enemies.json", locations: "data/locations.json",
  rooms: "data/rooms.json", items: "data/items.json", skills: "data/skills.json", contracts: "data/contracts.json",
  recipes: "data/recipes.json", questlines: "data/questlines.json", relations: "data/trader_relations.json",
  scav: "systems/ScavengingSystem.gd", raidStory: "scenes/raids/corridor/raid_story.gd", csv: "docs/review/text_review.csv",
  voice: "docs/narrative/VOICE_BIBLE.md", vibes: "docs/PLAN_MAP_VIBES.md", breadth: "docs/CONTENT_BREADTH_SPEC.md",
};

/** Adapter-side term lists for prose bans that do not extract cleanly. Keyed by voice-card id (marker name). */
export const NEVER_SAYS_OVERRIDES = {
  popper: ["ballistics", "muzzle velocity", "ballistic coefficient"],
  doc: ["sterile", "protocol", "re:\\b(?:contraindicat|prophylaxis|etiology)\\w*"],
  mechanic: ["where did you get", "where'd you get"],
  medic: ["good enough", "re:\\bimprovis\\w*"],
  builder: ["haggle", "re:\\bhaggl\\w*"],
  fence: ["supplier", "my source"],
  broker: ["please", "re:\\bhaggl\\w*"],
  "squad-saint": ["panic", "re:\\bhospital[- ]ward\\b"],
  "squad-magpie": ["re:\\bleave (?:it|that) behind\\b"],
  // weak, best-effort lists for prose bans that name no words; [] = reviewed, nothing safely extractable
  "squad-wrench": ["re:\\bcame from\\b"],
  "squad-tank": ["hero", "re:\\bi carried\\b"],
  "squad-skillet": ["re:\\bi(?:'ll| will) (?:kill|fight)\\b"],
  "squad-patch": ["improvise", "re:\\bclinic\\b"],
  "squad-prof": ["re:\\bi guess\\b", "re:\\bprobably\\b"],
  "squad-smooth": [],
  system: ["please", "re:\\b(?:\\w+n't|I'm|I'll|I've|it's|we're|you're|you'll|that's|there's|let's)\\b", "lol", "haha", "re:\\b(?:sorry|oops|whoops)\\b"],
};
/** Global bans (VOICE_BIBLE "How to use"): paranormal, modern-meme slang, "adventurer". Expansions are ours, the prose is theirs. */
export const GLOBAL_BAN_TERMS = ["paranormal", "supernatural", "ghost", "magic", "spell", "wizard", "adventurer", "adventurers", "lol", "lmao", "yeet", "no cap"];

const STORY_TODO = /^STORY-TODO:\s*/;
const clean = (s) => String(s ?? "").replace(STORY_TODO, "").trim();
const isTodo = (s) => STORY_TODO.test(String(s ?? ""));
const titleCase = (id) => id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const csvProduction = (status) => ({ "STORY-TODO": "placeholder", DRAFT: "ai-draft", "NEEDS-REWRITE": "needs-review", "OWNER-OK": "final" }[String(status).trim()] ?? null);

function linker() {
  const links = [];
  const seen = new Set();
  const fn = (rel, kind, id) => {
    if (id == null || id === "") return fn;
    const k = `${rel}|${kind}|${id}`;
    if (!seen.has(k)) { seen.add(k); links.push({ rel, kind, id: String(id) }); }
    return fn;
  };
  fn.links = links;
  return fn;
}

/** Best-effort 1-based line of the first regex hit at/after `from` (0-based line index). */
function finder(text) {
  const lines = String(text ?? "").split("\n");
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    lines,
    find(re, from = 0) {
      for (let i = Math.max(0, from); i < lines.length; i++) if (re.test(lines[i])) return i + 1;
      return null;
    },
    key: (k, from = 0) => this_find(new RegExp(`"${esc(k)}"\\s*:`), from),
    idRow: (id, from = 0) => this_find(new RegExp(`"id"\\s*:\\s*"${esc(id)}"`), from),
  };
  function this_find(re, from) {
    for (let i = Math.max(0, from); i < lines.length; i++) if (re.test(lines[i])) return i + 1;
    return null;
  }
}

async function readJson(reader, file, warnings) {
  const text = await reader.readFile(file);
  if (text == null) { warnings.push(`missing ${file} at ${reader.sha.slice(0, 8)}`); return { text: "", json: null, f: finder("") }; }
  try { return { text, json: JSON.parse(text), f: finder(text) }; } catch (e) {
    warnings.push(`unparsable ${file}: ${String(e.message).slice(0, 120)}`);
    return { text, json: null, f: finder(text) };
  }
}

// ---------- markdown helpers ----------
function splitSections(lines, startRe) {
  const out = [];
  lines.forEach((l, i) => { if (startRe.test(l)) out.push(i); });
  return out.map((s, k) => ({ start: s, end: k + 1 < out.length ? out[k + 1] : lines.length }));
}

function parseVoiceBible(text, warnings, traderIds, squadIds, relRivals) {
  const lines = text.split("\n");
  const cards = [];
  // default player word: **"runner"** in How to use
  const pw = /default word for the player[^"]*\*\*"([^"]+)"\*\*/.exec(text);
  const playerWordDefault = pw ? pw[1] : "runner";
  if (!pw) warnings.push("VOICE_BIBLE: default player word not found, assuming 'runner'");
  const gb = /\*\*Global bans[^*]*\*\*\s*([^\n]+)/.exec(text);
  const globalBansProse = gb ? gb[1].trim() : "";
  const globalBans = [...new Set([...GLOBAL_BAN_TERMS, ...[...globalBansProse.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase())])];
  for (const sec of splitSections(lines, /^<!-- NARR-VOICE-CARD /)) {
    const marker = /^<!-- NARR-VOICE-CARD ([\w-]+) -->/.exec(lines[sec.start]);
    if (!marker) continue;
    const cid = marker[1];
    const body = lines.slice(sec.start + 1, sec.end);
    const heading = body.find((l) => /^## /.test(l)) ?? "";
    const hm = /^## (.+?)(?: \(squad, id `([\w]+)`\))?\s*$/.exec(heading);
    const display = hm ? hm[1].replace(/^The /, "The ") : titleCase(cid);
    const sect = {};
    let cur = null;
    for (const l of body) {
      const h = /^### (.+)$/.exec(l);
      if (h) { cur = h[1].trim(); sect[cur] = []; } else if (cur) sect[cur].push(l);
    }
    const sectText = (name) => (sect[name] ?? []).join("\n").trim();
    let speakerKind = "trader";
    let speakerId = cid;
    if (cid === "system") { speakerKind = "system"; speakerId = "system"; }
    else if (cid.startsWith("squad-")) {
      speakerKind = "squad";
      speakerId = hm?.[2] ?? cid.slice(6);
    }
    const who = sectText("Who");
    const pm = /Pronoun:\s*([^.\n]+)\./.exec(who);
    const pronounRaw = pm ? pm[1].trim() : "";
    const pronoun = /^(he|she|they)$/i.test(pronounRaw) ? pronounRaw.toLowerCase() : null;
    const talk = sectText("How they talk");
    const calls = /\*\*Calls the player:\*\*\s*([^\n]+)/.exec(talk);
    const callsPlayer = calls ? [...calls[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    const samples = [...(/\*\*Samples:\*\*([\s\S]*)$/.exec(talk)?.[1] ?? "").matchAll(/^\s*-\s*"(.+)"\s*$/gm)].map((m) => m[1]);
    const prose = sectText("Never says").replace(/^Global bans, plus:\s*/i, "");
    const extracted = [...prose.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const override = NEVER_SAYS_OVERRIDES[cid] ?? [];
    if (!(cid in NEVER_SAYS_OVERRIDES) && !extracted.length && prose) warnings.push(`VOICE_BIBLE card ${cid}: "Never says" has no extractable terms and no override (prose only)`);
    const neverSays = [...new Set([...extracted, ...override])];
    const rivals = speakerKind === "trader" ? relRivals[speakerId] ?? [] : [];
    const links = linker();
    if (speakerKind !== "system") links("speaker", speakerKind, speakerId);
    for (const r of rivals) links("rival", "trader", r);
    if (speakerKind === "trader" && !traderIds.has(speakerId)) warnings.push(`VOICE_BIBLE card ${cid}: no trader ${speakerId}`);
    if (speakerKind === "squad" && !squadIds.has(speakerId)) warnings.push(`VOICE_BIBLE card ${cid}: no squad member ${speakerId}`);
    cards.push({
      id: cid, display, line: sec.start + 1, links: links.links,
      data: {
        speakerKind, speakerId, pronoun, pronounRaw, playerWord: playerWordDefault, callsPlayer,
        globalBans, globalBansProse, neverSays, neverSaysProse: prose, neverSaysExtracted: extracted, neverSaysOverride: override,
        rivals, who, wants: sectText("Wants"), distinctFrom: sectText("Distinct from"), samples,
      },
    });
  }
  return cards;
}

function parseMapVibes(text, warnings) {
  const lines = text.split("\n");
  const out = [];
  const perMap = lines.findIndex((l) => /^## Per map/.test(l));
  const secs = splitSections(lines, /^### /).filter((s) => s.start > perMap && perMap >= 0);
  for (const s of secs) {
    const head = lines[s.start];
    const body = lines.slice(s.start + 1, s.end);
    const m = /^### (\d+)\. (.+?) \(`([\w]+)`\)/.exec(head);
    if (m) {
      const fields = {};
      for (const l of body) {
        const f = /^- \*\*([^:*]+):\*\*\s*(.*)$/.exec(l);
        if (f) fields[f[1].trim().toLowerCase().replace(/[^a-z]+/g, "_")] = f[2].trim();
      }
      out.push({ id: `map:${m[3]}`, display: `${m[2]} (vibe)`, locationIds: [m[3]], line: s.start + 1, text: body.join("\n").trim(), fields, mentions: [...body.join("\n").matchAll(/`([a-z0-9_]+)`/g)].map((x) => x[1]), kind: "map_vibe" });
      continue;
    }
    if (/^### 7-10\./.test(head)) {
      body.forEach((l, i) => {
        const r = /^\|\s*([A-D])\s*\|\s*([\d-]+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(l);
        if (!r) return;
        const [a, b] = r[2].split("-").map(Number);
        const floors = [];
        for (let n = a; n <= (b || a); n++) floors.push(`deep_${n}`);
        out.push({
          id: `band:${r[1]}`, display: `Sublevels band ${r[1]} (vibe)`, locationIds: floors, line: s.start + 2 + i, kind: "band_vibe",
          text: l, fields: { floors: r[2], setting: r[3], palette_light: r[4], signature_enemy: r[5] },
          mentions: [...r[5].matchAll(/`([a-z0-9_]+)`/g)].map((x) => x[1]),
        });
      });
    }
  }
  if (!out.length) warnings.push("PLAN_MAP_VIBES: no per-map blocks parsed");
  return out;
}

function parseBreadthLooks(text, warnings) {
  const lines = text.split("\n");
  const out = [];
  let table = null;
  lines.forEach((l, i) => {
    const h = /^### (3\.\d)\b/.exec(l);
    if (h) { table = h[1]; return; }
    if (/^##\s/.test(l) && !/^### /.test(l)) table = null;
    if (!table || !/^\| `[a-z0-9_]+` \|/.test(l)) return;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) return;
    const id = cells[0].replace(/`/g, "");
    const parent = (/`([a-z0-9_]+)`/.exec(cells[3]) ?? [])[1] ?? null;
    out.push({ enemyId: id, display: cells[1], where: cells[2], parentId: parent, look: cells[4], line: i + 1 });
  });
  if (!out.length) warnings.push("CONTENT_BREADTH_SPEC: no enemy look rows parsed");
  return out;
}

function parseRaidStory(text) {
  const out = [];
  text.split("\n").forEach((l, i) => {
    const m = /result\.append\(\s*"((?:[^"\\]|\\.)*)"\s*(?:%\s*(.*))?\)\s*$/.exec(l.trim());
    if (!m) return;
    const args = m[2] ?? "";
    const speaker = /\bactor\b/.test(args) ? "actor" : /\bwe\b/.test(args) ? "squad" : /\bmedic\b/.test(args) ? "medic" : /\bvictim\b/.test(args) ? "victim" : "narrator";
    out.push({ text: m[1].replace(/\\"/g, '"'), line: i + 1, speaker });
  });
  return out;
}

// ---------- the adapter ----------
async function load(reader, sha) {
  const warnings = [];
  const src = (p, line) => ({ path: p, line: line ?? null });
  const rd = (f) => readJson(reader, f, warnings);
  const [tr, sq, en, lo, ro, it, sk, co, re, ql, rel] = await Promise.all([P.traders, P.squad, P.enemies, P.locations, P.rooms, P.items, P.skills, P.contracts, P.recipes, P.questlines, P.relations].map(rd));
  const [scavText, raidStoryText, csvText, voiceText, vibesText, breadthText] = await Promise.all([P.scav, P.raidStory, P.csv, P.voice, P.vibes, P.breadth].map((f) => reader.readFile(f)));
  for (const [f, t] of [[P.scav, scavText], [P.raidStory, raidStoryText], [P.csv, csvText], [P.voice, voiceText], [P.vibes, vibesText], [P.breadth, breadthText]]) if (t == null) warnings.push(`missing ${f} at ${sha.slice(0, 8)}`);

  const ents = [];
  const E = (o) => { ents.push(entity(o)); };
  const traders = tr.json?.traders ?? {};
  const relTraders = rel.json?.traders ?? {};
  const squadMembers = sq.json?.members ?? [];
  const enemies = en.json?.enemies ?? {};
  const locations = Array.isArray(lo.json) ? lo.json : [];
  const bossIds = new Set(locations.map((l) => l.boss?.enemy_id).filter(Boolean));
  const relRivals = Object.fromEntries(Object.entries(relTraders).map(([k, v]) => [k, v.rivals ?? []]));

  // traders
  for (const [id, t] of Object.entries(traders)) {
    const L = linker();
    for (const r of relRivals[id] ?? []) L("rival", "trader", r);
    for (const row of [...(t.static_stock ?? []), ...(Array.isArray(t.rotating_pool) ? t.rotating_pool : [])]) L("sells", "item", row?.item_id);
    E({
      id, kind: "trader", display: t.display_name ?? titleCase(id), aliases: [id], source: src(P.traders, tr.f.key(id)), links: L.links,
      data: { description: t.description ?? "", level_0: !!t.level_0, sell_ratio: t.sell_ratio ?? null, rivals: relRivals[id] ?? [] },
    });
  }
  // squad
  for (const m of squadMembers) {
    const L = linker();
    for (const loc of m.synergy?.locations ?? []) L("synergy_at", "location", loc);
    if (m.unlock) L("unlocked_at", "location", m.unlock);
    const texts = [m.name, m.bio, m.flaw?.text, m.synergy?.text, m.trait_text];
    E({
      id: m.id, kind: "squad", display: m.callsign ?? clean(m.name), aliases: [m.id, clean(m.name)], source: src(P.squad, sq.f.idRow(m.id)), links: L.links,
      production: texts.some(isTodo) ? "placeholder" : null,
      data: { callsign: m.callsign ?? "", name: m.name ?? "", bio: m.bio ?? "", trait_text: m.trait_text ?? "", key: m.key ?? "", size: m.size ?? null, unlock: m.unlock ?? "", flaw: m.flaw ?? null, synergy: m.synergy ? { text: m.synergy.text, key: m.synergy.key, size: m.synergy.size, locations: m.synergy.locations ?? [] } : null },
    });
  }
  // enemies
  const lookByEnemy = new Map();
  for (const l of parseBreadthLooks(breadthText ?? "", warnings)) lookByEnemy.set(l.enemyId, l);
  for (const [id, e] of Object.entries(enemies)) {
    const L = linker();
    for (const k of Object.keys(e.loot ?? {})) L("drops", "item", k);
    for (const r of e.rare_loot ?? []) L("drops", "item", r?.id);
    const bossLoc = locations.find((l) => l.boss?.enemy_id === id);
    if (bossLoc) L("boss_of", "location", bossLoc.id);
    E({
      id, kind: "enemy", display: e.name ?? titleCase(id), aliases: [id], source: src(P.enemies, en.f.key(id)), links: L.links,
      data: { boss: bossIds.has(id) || e.boss === true, boss_of: bossLoc?.id ?? null, hp: e.hp ?? null, attack: e.attack ?? null, defense: e.defense ?? null, xp: e.xp ?? null, group: e.group ?? null, loot: e.loot ?? {} },
    });
  }
  // locations
  for (const l of locations) {
    const L = linker();
    for (const p of l.enemy_pool ?? []) L("spawns", "enemy", p.id);
    if (l.boss?.enemy_id) L("boss", "enemy", l.boss.enemy_id);
    L("first_clear_unique", "item", l.first_clear_unique);
    for (const k of Object.keys(l.kill_valuables ?? {})) L("kill_valuable", "item", k);
    L("key_drop", "item", l.key_drop?.item_id);
    for (const r of l.locked_room ?? []) L("locked_room_loot", "item", r?.item_id);
    for (const c of l.containers ?? []) for (const r of c.rows ?? []) L("container_loot", "item", r?.item_id);
    for (const r of l.long_haul?.rows ?? []) L("long_haul_loot", "item", r?.item_id);
    const line = lo.f.idRow(l.id);
    E({
      id: l.id, kind: "location", display: l.display_name ?? titleCase(l.id), aliases: [l.id], source: src(P.locations, line), links: L.links,
      data: {
        unlock_order: l.unlock_order ?? null, threat_tier: l.threat_tier ?? null, danger_rating: l.danger_rating ?? "",
        default_raid_seconds: l.default_raid_seconds ?? null, max_raid_seconds: l.max_raid_seconds ?? null,
        enemy_pool: (l.enemy_pool ?? []).map((p) => ({ id: p.id, tier: p.tier ?? null, min_time_seconds: p.min_time_seconds ?? null, max_time_seconds: p.max_time_seconds ?? null, weight: p.weight ?? null })),
        boss: l.boss ? { enemy_id: l.boss.enemy_id, at_seconds: l.boss.at_seconds ?? null, min_hunt_seconds: l.boss.min_hunt_seconds ?? null, max_fight_seconds: l.boss.max_fight_seconds ?? null } : null,
        long_haul_text: l.long_haul?.text ?? "", first_clear_unique: l.first_clear_unique ?? null,
      },
    });
    if (l.long_haul?.text) {
      const t = l.long_haul.text;
      const lhLine = lo.f.key("long_haul", line ? line - 1 : 0);
      E({
        id: `long_haul:${l.id}`, kind: "line", display: t.slice(0, 60), source: src(P.locations, lhLine), links: linker()("said_at", "location", l.id).links,
        production: isTodo(t) ? "placeholder" : null, data: { text: t, origin: "long_haul", speaker: "narrator", at_s: l.long_haul.at_s ?? null, kind: l.long_haul.kind ?? null },
      });
    }
  }
  // rooms
  for (const [id, r] of Object.entries(ro.json?.rooms ?? {})) {
    const L = linker();
    for (const t of r.upgrade_tiers ?? []) for (const k of Object.keys(t.materials ?? {})) L("upgrade_material", "item", k);
    E({
      id, kind: "room", display: r.display_name ?? titleCase(id), aliases: [id, r.starter_display_name], source: src(P.rooms, ro.f.key(id)), links: L.links,
      data: { starter_display_name: r.starter_display_name ?? null, tiers: (r.upgrade_tiers ?? []).length },
    });
  }
  // items
  const itemList = Array.isArray(it.json?.items) ? it.json.items : [];
  for (const i of itemList) {
    E({
      id: i.id, kind: "item", display: i.name ?? titleCase(i.id), aliases: [i.id], source: src(P.items, it.f.idRow(i.id)),
      data: { category: i.category ?? null, tier: i.tier ?? null, weight: i.weight ?? null, base_value: i.base_value ?? null, description: i.description ?? "" },
    });
  }
  // skills (+ scavenging merge)
  const skillIds = Object.keys(sk.json?.skills ?? {});
  for (const id of skillIds) {
    E({ id, kind: "skill", display: titleCase(id), aliases: [id], source: src(P.skills, sk.f.key(id)), data: { defined_in: P.skills } });
  }
  if (scavText != null) {
    const sf = finder(scavText);
    const data = { defined_in: P.scav, merged_from: P.scav, note: "scavenging lives in ScavengingSystem.gd, not skills.json; merged so skill refs resolve" };
    const existing = ents.find((e) => e.kind === "skill" && e.id === "scavenging");
    if (existing) Object.assign(existing.data, data);
    else E({ id: "scavenging", kind: "skill", display: "Scavenging", aliases: ["scavenging"], source: src(P.scav, sf.find(/ScavengingSystem/)), data });
  }
  // contracts
  const ctx = co.json?.templates ?? [];
  for (const c of ctx) {
    const L = linker();
    L("trader", "trader", c.trader); L("item", "item", c.item); L("enemy", "enemy", c.enemy); L("location", "location", c.location);
    for (const r of c.requires ? (Array.isArray(c.requires) ? c.requires : [c.requires]) : []) L("requires_skill", "skill", r?.skill);
    const { id, ...rest } = c;
    E({ id, kind: "contract", display: id, aliases: [], source: src(P.contracts, co.f.idRow(id)), links: L.links, data: { type: c.type ?? null, trader: c.trader ?? null, ...Object.fromEntries(Object.entries(rest).filter(([k]) => !["trader", "balance_note"].includes(k))) } });
  }
  // recipes
  for (const [id, r] of Object.entries(re.json?.recipes ?? {})) {
    const L = linker();
    L("produces", "item", r.result_id ?? id);
    for (const k of Object.keys(r.ingredients ?? {})) L("ingredient", "item", k);
    L("requires_skill", "skill", r.skill_req);
    L("workshop", "room", r.required_workshop);
    E({
      id, kind: "recipe", display: r.description ? `${titleCase(id)}` : titleCase(id), aliases: [id], source: src(P.recipes, re.f.key(id)), links: L.links,
      data: { result_id: r.result_id ?? id, result_qty: r.result_qty ?? 1, ingredients: r.ingredients ?? {}, description: r.description ?? "", skill_req: r.skill_req ?? "", level_req: r.level_req ?? null, required_workshop: r.required_workshop ?? "" },
    });
  }
  // quest steps
  for (const [traderId, chain] of Object.entries(ql.json?.questlines ?? {})) {
    (chain.steps ?? []).forEach((s, idx) => {
      const L = linker();
      L("trader", "trader", traderId);
      const t = s.task ?? {};
      if (t.type === "deliver") L("wants_item", "item", t.item_id);
      if (t.type === "extract") L("at_location", "location", t.location);
      if (t.type === "kill") { L("targets_enemy", "enemy", t.enemy_id); L("at_location", "location", t.location); }
      if (t.type === "reach") { L("needs_room", "room", t.room); L("needs_skill", "skill", t.skill); }
      E({
        id: s.id, kind: "quest_step", display: clean(s.title), aliases: [], source: src(P.questlines, ql.f.idRow(s.id)), links: L.links,
        production: isTodo(s.title) || isTodo(s.story) ? "placeholder" : null,
        data: { trader: traderId, index: idx + 1, title: s.title ?? "", story: s.story ?? "", task: t, rep: s.rep ?? null },
      });
    });
  }
  // narrative lines: trader_relations
  for (const [tid, r] of Object.entries(relTraders)) {
    const start = rel.f.key(tid) ?? 1;
    for (const [k, text] of Object.entries(r.lines ?? {})) {
      const L = linker(); L("spoken_by", "trader", tid);
      E({ id: `rel:${tid}:${k}`, kind: "line", display: text.slice(0, 60), source: src(P.relations, rel.f.key(k, start - 1)), links: L.links, production: isTodo(text) ? "placeholder" : null, data: { text, origin: "trader_relations", speaker: tid, band: k } });
    }
    (r.encouragement ?? []).forEach((e, i) => {
      const L = linker(); L("spoken_by", "trader", tid); L("wants_item", "item", e.item_id);
      for (const q of e.requires ?? []) L("requires_skill", "skill", q?.skill);
      const text = `${e.title ?? ""}: ${e.story ?? ""}`;
      E({ id: `enc:${tid}:${i}`, kind: "line", display: (e.title ?? "") + (e.story ? ` — ${e.story.slice(0, 40)}` : ""), source: src(P.relations, rel.f.find(/"encouragement"/, start - 1)), links: L.links, production: isTodo(text) ? "placeholder" : null, data: { text, title: e.title ?? "", story: e.story ?? "", origin: "encouragement", speaker: tid, item_id: e.item_id ?? null, qty: e.qty ?? null, requires: e.requires ?? [] } });
    });
  }
  // narrative lines: squad texts
  for (const m of squadMembers) {
    const sline = sq.f.idRow(m.id);
    for (const [field, text] of [["name", m.name], ["bio", m.bio], ["trait_text", m.trait_text], ["flaw", m.flaw?.text], ["synergy", m.synergy?.text]]) {
      if (!text) continue;
      const L = linker(); L("spoken_by", "squad", m.id);
      E({ id: `squad:${m.id}:${field}`, kind: "line", display: clean(text).slice(0, 60), source: src(P.squad, sline), links: L.links, production: isTodo(text) ? "placeholder" : null, data: { text, origin: "squad", speaker: m.id, field } });
    }
  }
  // narrative lines: raid_story templates
  parseRaidStory(raidStoryText ?? "").forEach((t, i) => {
    E({ id: `raid_story:${i + 1}`, kind: "line", display: t.text.slice(0, 60), source: src(P.raidStory, t.line), production: null, data: { text: t.text, origin: "raid_story", speaker: t.speaker } });
  });

  // CSV rows as is
  const speakerLookup = () => {
    const m = new Map();
    for (const e of ents) if ((e.kind === "trader" || e.kind === "squad")) for (const n of [e.display, ...e.aliases]) { const k = n.toLowerCase(); (m.get(k) ?? m.set(k, []).get(k)).push(e); }
    return m;
  };
  if (csvText != null) {
    const { records } = parseCsvObjects(csvText);
    const spk = speakerLookup();
    const seen = new Map();
    for (const { row, line } of records) {
      const base = `csv:${row.file}:${row.line}:${row.data_path}`;
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const L = linker();
      const cands = row.speaker ? (spk.get(row.speaker.trim().toLowerCase()) ?? []) : [];
      if (cands.length === 1) L("spoken_by", cands[0].kind, cands[0].id);
      E({
        id: n === 1 ? base : `${base}#${n}`, kind: "line", display: row.current_text.replace(/\s+/g, " ").slice(0, 60),
        source: src(row.file || P.csv, Number.isInteger(Number(row.line)) && Number(row.line) >= 1 ? Number(row.line) : null), links: L.links, production: csvProduction(row.status),
        data: { ...row, text: row.current_text, origin: "csv", csv_line: line },
      });
    }
  }

  // voice cards
  const traderIds = new Set(Object.keys(traders));
  const squadIds = new Set(squadMembers.map((m) => m.id));
  if (voiceText != null) {
    for (const c of parseVoiceBible(voiceText, warnings, traderIds, squadIds, relRivals)) {
      E({ id: c.id, kind: "voice_card", display: c.display, aliases: [c.data.speakerId], source: src(P.voice, c.line), links: c.links, data: c.data });
    }
  }

  // lore
  const reg0 = makeRegistry(ents);
  if (vibesText != null) {
    for (const v of parseMapVibes(vibesText, warnings)) {
      const L = linker();
      for (const loc of v.locationIds) L("describes", "location", loc);
      for (const id of v.mentions) if (reg0.has("enemy", id)) L("mentions", "enemy", id);
      E({ id: v.id, kind: "lore", display: v.display, source: src(P.vibes, v.line), links: L.links, data: { text: v.text, fields: v.fields, lore_kind: v.kind } });
    }
  }
  for (const l of lookByEnemy.values()) {
    const L = linker();
    // CB3 trios exist only in the spec until their branch lands; a link to a missing enemy would be a false #1 hit, so warn and skip it
    if (reg0.has("enemy", l.enemyId)) L("describes", "enemy", l.enemyId);
    else warnings.push(`CONTENT_BREADTH_SPEC look row for ${l.enemyId} (${l.display}): no such enemy at this sha, link skipped`);
    if (reg0.has("enemy", l.parentId)) L("parent", "enemy", l.parentId);
    if (reg0.has("location", l.where)) L("seen_at", "location", l.where);
    E({ id: `look:${l.enemyId}`, kind: "lore", display: `${l.display} (look)`, source: src(P.breadth, l.line), links: L.links, data: { text: l.look, lore_kind: "enemy_look", where: l.where, parent: l.parentId } });
  }
  return { entities: ents, warnings };
}

// ---------- hooks (computed from entity data) ----------
function poolRows(loc, enemyId) {
  const rows = (loc.data.enemy_pool ?? []).filter((p) => p.id === enemyId);
  return rows;
}
/**
 * Where/when `enemyId` can spawn at `locationId`. Pool rows for the same enemy are merged (min of mins, max of maxes,
 * summed weight, first tier). Boss slot: {boss:true, min: min_hunt_seconds, max:null, weight:null, tier:null}. null = never spawns there.
 */
function spawnWindow(registry, locationId, enemyId) {
  const loc = registry.get("location", locationId);
  if (!loc) return null;
  const rows = poolRows(loc, enemyId);
  const dflt = loc.data.default_raid_seconds ?? null;
  if (rows.length) {
    const mins = rows.map((r) => r.min_time_seconds ?? 0);
    const maxs = rows.map((r) => r.max_time_seconds);
    return {
      min: Math.min(...mins), max: maxs.some((m) => m == null) ? null : Math.max(...maxs),
      tier: rows[0].tier ?? null, weight: rows.reduce((a, r) => a + (r.weight ?? 0), 0), defaultRaidSeconds: dflt, boss: false,
    };
  }
  if (loc.data.boss?.enemy_id === enemyId) {
    return { min: loc.data.boss.min_hunt_seconds ?? loc.data.boss.at_seconds ?? 0, max: null, tier: null, weight: null, defaultRaidSeconds: dflt, boss: true };
  }
  return null;
}
/** Location ids whose enemy pool or boss slot contains `enemyId` (registry order). */
function killTargetLocations(registry, enemyId) {
  return registry.byKind("location").filter((l) => poolRows(l, enemyId).length || l.data.boss?.enemy_id === enemyId).map((l) => l.id);
}

export const efiAdapter = {
  id: "efi",
  defaultRepoPath: path.join(os.homedir(), "projects", "Escape-From-Idle"),
  load,
  hooks: { spawnWindow, killTargetLocations },
};
export default efiAdapter;
