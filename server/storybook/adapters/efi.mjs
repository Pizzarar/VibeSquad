// Storybook adapter for Escape From Idle (SB1). Read-only: every byte comes through a pinned-sha Reader (git show / ls-tree).
// Ingests INV v1 items 1-5 (docs/PLAN_STORYBOOK_V1.md): registries, narrative units, text_review.csv as is, VOICE_BIBLE cards,
// PLAN_MAP_VIBES + CONTENT_BREADTH "look" lines as lore.
//
// Never-says: VOICE_BIBLE's "Never says" sections are prose. Quoted terms in them ("good enough", "please") are extracted as
// banned terms. Prose bans that do not extract cleanly ("no contractions", "no ballistics or spec talk") get an explicit
// term list from NEVER_SAYS_OVERRIDES below, keyed by card id. A term starting with `re:` is a case-insensitive regex source,
// anything else is a case-insensitive whole-word/phrase. card.data.neverSays = extracted ∪ override terms (deduped);
// card.data.neverSaysProse keeps the raw sentence; card.data.neverSaysExtracted / neverSaysOverride show where each came from.
import { parseCsvObjects } from "../csv.mjs";
import { entity, makeRegistry } from "../schema.mjs";

const P = {
  traders: "data/traders.json", squad: "data/squad.json", enemies: "data/enemies.json", locations: "data/locations.json",
  rooms: "data/rooms.json", items: "data/items.json", skills: "data/skills.json", contracts: "data/contracts.json",
  recipes: "data/recipes.json", questlines: "data/questlines.json", relations: "data/trader_relations.json",
  scav: "systems/ScavengingSystem.gd", raidStory: "scenes/raids/corridor/raid_story.gd", csv: "docs/review/text_review.csv",
  voice: "docs/narrative/VOICE_BIBLE.md", vibes: "docs/PLAN_MAP_VIBES.md", breadth: "docs/CONTENT_BREADTH_SPEC.md",
  audit: "docs/narrative/QUEST_AUDIT.md", art: "data/art_manifest.json",
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

const EXCEPTION_CLAUSE = /\b(?:anything but|except|other than|only)\b/i;
const STORY_TODO = /^STORY-TODO:\s*/;
const clean = (s) => String(s ?? "").replace(STORY_TODO, "").trim();
const normText = (s) => clean(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
const isTodo = (s) => STORY_TODO.test(String(s ?? ""));
const titleCase = (id) => id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const csvProduction = (status) => ({ "STORY-TODO": "placeholder", DRAFT: "ai-draft", "NEEDS-REWRITE": "needs-review", "OWNER-OK": "final" }[String(status).trim()] ?? null);

// Art manifest (F4): status -> production state. MISSING = no art, PLACEHOLDER = provisional, PIPELINE = AI-generated
// (interim), COMMISSIONED = final. The manifest only lists slots that have art; a missing slot is simply absent.
const ART_STATUS_TO_PRODUCTION = { MISSING: "missing", PLACEHOLDER: "placeholder", PIPELINE: "ai-draft", COMMISSIONED: "final" };
const artProduction = (status) => ART_STATUS_TO_PRODUCTION[String(status ?? "").trim()] ?? null;

/**
 * Resolve a manifest slot id + kind to its {slot, target}. `slot` is "portrait" | "sprite" | "other"; `target` is the
 * {kind,id} the art depicts (a character/enemy), or null for non-character art (items, rooms, ui, ...).
 * slot id shapes: enemy.<id> / trader.<id> / squad.<id> (portraits); sprite.<id> and sprite.<id>.front (raid sprites).
 */
function artTarget(slotId, kind) {
  if (kind === "enemy_portrait" && slotId.startsWith("enemy.")) return { slot: "portrait", target: { kind: "enemy", id: slotId.slice("enemy.".length) } };
  if (kind === "trader_portrait" && slotId.startsWith("trader.")) return { slot: "portrait", target: { kind: "trader", id: slotId.slice("trader.".length) } };
  if (kind === "squad_portrait" && slotId.startsWith("squad.")) return { slot: "portrait", target: { kind: "squad", id: slotId.slice("squad.".length) } };
  if (kind === "raid_sprite" && slotId.startsWith("sprite.")) {
    const rest = slotId.slice("sprite.".length);
    if (rest.startsWith("prop.")) return { slot: "other", target: null }; // prop sprites are not enemies
    if (rest.endsWith(".front")) return { slot: "sprite", target: { kind: "enemy", id: rest.slice(0, -".front".length) } };
    return { slot: "sprite", target: { kind: "enemy", id: rest } };
  }
  return { slot: "other", target: null };
}

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
    // quoted terms inside an exception clause ("no addressing the player as anything but "you"") are allowed words, not bans
    const clauses = prose.split(/[;,](?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const extracted = clauses.filter((c) => !EXCEPTION_CLAUSE.test(c)).flatMap((c) => [...c.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
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

// ---------- V1: speaker (kind,id) identity ----------
// A speaker is identified by (kind,id), never by id alone: squad member `doc` (Saint) is not trader `doc` (Doc).
// kinds: trader | squad (a squad member id) | system (UI / toast / screen text) | party (the raid-log "Squad" / callsign voice) | narrator.
// speakerSource: 'explicit' = the data/CSV names the speaker; 'inferred' = guessed from the source path (UI can show it as a guess).
const NON_ENTITY_SPEAKERS = { system: "system", squad: "party", narrator: "narrator" }; // lowercase CSV/data speaker name -> kind (id = same word, party id = "squad")
const SPEAKER_PARTY = { kind: "party", id: "squad" };

/** name -> [{kind,id}] over traders (display or id) and squad members (callsign / name only; never the id, which collides with traders). */
function speakerNameIndex(traders, squadMembers) {
  const m = new Map();
  const add = (n, kind, id) => {
    const k = clean(n).toLowerCase();
    if (!k) return;
    const arr = m.get(k) ?? m.set(k, []).get(k);
    if (!arr.some((x) => x.kind === kind && x.id === id)) arr.push({ kind, id });
  };
  for (const [id, t] of Object.entries(traders)) { add(id, "trader", id); add(t.display_name ?? titleCase(id), "trader", id); }
  for (const s of squadMembers) { add(s.callsign, "squad", s.id); add(s.name, "squad", s.id); }
  return m;
}

/** Explicit speaker name ("Popper", "Saint", "Squad", "System") -> {kind,id}, or null when empty / unknown / ambiguous. */
function resolveSpeakerName(name, nameIndex) {
  const k = clean(name).toLowerCase();
  if (!k) return null;
  if (k === "squad") return SPEAKER_PARTY;
  if (Object.hasOwn(NON_ENTITY_SPEAKERS, k)) return { kind: NON_ENTITY_SPEAKERS[k], id: k };
  const c = nameIndex.get(k) ?? [];
  return c.length === 1 ? c[0] : null;
}

/** CSV data_path is a JSON-array string like ["traders","popper","lines","wary"] or ["members",0,"bio"]; null when absent/unparsable. */
function parseDataPath(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
}

/**
 * V1.1: infer a readable screen/feature speakerId for System lines from data.group, falling back to source path.
 * Keeps speakerKind = "system" while splitting the 3,200+ System blob into distinct readable screens (e.g. "raids", "armory", "items").
 */
function slugifyScreen(raw) {
  const s = String(raw ?? "")
    .replace(/^(?:Screen|Data|System|Script|Autoload)\s*:\s*/i, "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || null;
}

export function inferSystemScreenId(row) {
  const fromGroup = slugifyScreen(row?.group);
  if (fromGroup) return fromGroup;
  const file = String(row?.file ?? "").replace(/\\/g, "/");
  let m = /^scenes\/([^/]+)\//.exec(file);
  if (m) return slugifyScreen(m[1]) ?? "system";
  m = /^data\/([^/]+)\.json$/i.exec(file);
  if (m) return slugifyScreen(m[1]) ?? "system";
  m = /^(?:systems|autoloads|scripts)\/(?:.+\/)?([^/]+)\.\w+$/i.exec(file);
  if (m) return slugifyScreen(m[1]) ?? "system";
  return "system";
}

/**
 * Speaker of a speakerless CSV row, inferred from where it lives: trader/questline data -> that trader, squad.json -> that member,
 * raid_story.gd -> the party (callsign) voice, locations long_haul -> narrator, everything else (toasts, UI, system text) -> System screen.
 */
function inferCsvSpeaker(row, { traders, squadMembers }) {
  const dp = parseDataPath(row.data_path);
  if (dp && (dp[0] === "traders" || dp[0] === "questlines") && typeof dp[1] === "string" && Object.hasOwn(traders, dp[1])) return { kind: "trader", id: dp[1] };
  if (dp && dp[0] === "members" && Number.isInteger(dp[1]) && squadMembers[dp[1]]) return { kind: "squad", id: squadMembers[dp[1]].id };
  if (row.file === P.locations && dp?.[1] === "long_haul") return { kind: "narrator", id: "narrator" };
  if (row.file === P.raidStory) return SPEAKER_PARTY;
  return { kind: "system", id: inferSystemScreenId(row) };
}

// ---------- V1.1: dev-only string exclusion ----------
const DEV_FILE_RE = /^(?:scripts\/debug|tools|tests)\//i;
const DEV_WHERE_FN_RE = /\b(?:_?validate(?:_[a-z0-9_]+)?|_[a-z0-9_]*errors?|_save_reject_reason)\(\)/i;
const DEV_CALL_RE = /\b(?:push_error|push_warning|assert|printerr|print_debug)\s*\(|(?:\berrors|\[["']errors["']\])\.append\s*\(/;
// Safe: requires both an internal _load_*() loader helper in where_seen and a pure snake_case=%d/%s debug log signature (never matches player prose/toasts).
const DEV_LOADER_WHERE_RE = /\b_load_[a-z0-9_]+\(\)/i;
const DEV_LOADER_TEXT_RE = /^(?:[a-z_]+=%[ds]\s+)+[a-z_]+=%[ds]$/i;

/** Load unique .gd files referenced by CSV rows (batched, read-only via pinned reader) for call-site checks. */
async function loadGdSourcesForCsv(reader, records) {
  const files = [...new Set(records.map(({ row }) => row.file).filter((f) => typeof f === "string" && f.endsWith(".gd")))];
  const cache = new Map();
  for (let i = 0; i < files.length; i += 16) {
    const batch = await Promise.all(files.slice(i, i + 16).map(async (f) => [f, await reader.readFile(f)]));
    for (const [f, text] of batch) if (text != null) cache.set(f, text.split("\n"));
  }
  return cache;
}

/**
 * V1.1: true when a CSV row is a developer-only / validation / push_error / assert string rather than player-facing text.
 * Checks file path, where_seen validation/error helper name, and (for .gd files) the actual call site in the pinned source.
 * Never falls back to the raw CSV line number when the text needle is not found (CSV line numbers can be stale vs pinned sha).
 */
export function isDevOnlyCsvRow(row, gdSourceCache) {
  const file = String(row?.file ?? "");
  if (DEV_FILE_RE.test(file)) return true;
  const where = String(row?.where_seen ?? "");
  if (DEV_WHERE_FN_RE.test(where)) return true;
  const text = String(row?.current_text ?? "");
  if (DEV_LOADER_WHERE_RE.test(where) && DEV_LOADER_TEXT_RE.test(text.trim())) return true;
  if (file.endsWith(".gd") && gdSourceCache?.has(file)) {
    const lines = gdSourceCache.get(file);
    const ln = Number(row?.line) || 0;
    const needle = text.split("\n")[0].slice(0, 40);
    if (needle && lines.length) {
      const center = Math.max(0, Math.min(lines.length - 1, ln > 0 ? ln - 1 : 0));
      const maxD = Math.max(center, lines.length - 1 - center);
      let hitIdx = -1;
      for (let d = 0; d <= maxD; d++) {
        const hi = center + d;
        if (hi < lines.length && lines[hi].includes(needle)) { hitIdx = hi; break; }
        const lo = center - d;
        if (d > 0 && lo >= 0 && lines[lo].includes(needle)) { hitIdx = lo; break; }
      }
      if (hitIdx >= 0) {
        const srcLine = lines[hitIdx];
        const prevLine = hitIdx > 0 ? lines[hitIdx - 1] : "";
        if (DEV_CALL_RE.test(srcLine)) return true;
        if (DEV_CALL_RE.test(prevLine) && !/\)\s*$/.test(prevLine.trim())) return true;
      }
    }
  }
  return false;
}

// ---------- V1.1: extended links (spawn locations, contracts, containers, long_haul) ----------
/** enemyId -> locationId[] (deduped, location order) from enemy_pool and boss slots. */
function buildEnemySpawnMap(locations) {
  const m = new Map();
  const add = (eid, lid) => {
    if (!eid || !lid) return;
    const arr = m.get(eid) ?? m.set(eid, []).get(eid);
    if (!arr.includes(lid)) arr.push(lid);
  };
  for (const l of locations) {
    for (const p of l.enemy_pool ?? []) add(p?.id, l.id);
    if (l.boss?.enemy_id) add(l.boss.enemy_id, l.id);
  }
  return m;
}

/** quest step (by trader + 0-based index) -> { location, enemy } from step links. */
function questStepContext(ents) {
  const m = new Map();
  for (const e of ents) if (e.kind === "quest_step") {
    const loc = e.links.find((l) => l.rel === "at_location")?.id ?? null;
    const enemy = e.links.find((l) => l.rel === "targets_enemy")?.id ?? null;
    if (loc || enemy) m.set(`${e.data.trader}:${e.data.index - 1}`, { location: loc, enemy });
  }
  return m;
}

/** V1.1: attach said_at / mentions links for CSV rows from questlines, locations (long_haul/containers), enemies, and squad synergy. */
function linkCsvRowContext(L, row, dp, { stepCtx, locations, enemies, squadMembers, enemySpawnMap }) {
  if (!dp) return;
  if (row.file === P.questlines && dp[0] === "questlines" && dp[2] === "steps") {
    const ctx = stepCtx.get(`${dp[1]}:${dp[3]}`);
    if (ctx?.location) L("said_at", "location", ctx.location);
    if (ctx?.enemy) L("mentions", "enemy", ctx.enemy);
  } else if (row.file === P.locations && Number.isInteger(dp[0]) && locations[dp[0]]) {
    L("said_at", "location", locations[dp[0]].id);
  } else if (row.file === P.enemies && dp[0] === "enemies" && typeof dp[1] === "string" && Object.hasOwn(enemies, dp[1])) {
    L("mentions", "enemy", dp[1]);
    for (const locId of enemySpawnMap.get(dp[1]) ?? []) L("said_at", "location", locId);
  } else if (row.file === P.squad && dp[0] === "members" && Number.isInteger(dp[1]) && dp[2] === "synergy" && squadMembers[dp[1]]) {
    for (const locId of squadMembers[dp[1]].synergy?.locations ?? []) L("said_at", "location", locId);
  }
}

// ---------- V1.1: entity/csv twin deduplication ----------
const NATIVE_TWIN_FIELDS = ["at_s", "kind", "band", "item_id", "qty", "requires", "field"];
const SQUAD_TWIN_FIELDS = new Set(["name", "bio", "trait_text"]);

function mergeLinks(target, extra) {
  const seen = new Set(target.map((l) => `${l.rel}|${l.kind}|${l.id}`));
  const hasSpokenBy = target.some((l) => l.rel === "spoken_by");
  for (const l of extra) {
    if (l.rel === "spoken_by" && hasSpokenBy) continue; // CSV explicit speaker wins over native default
    const k = `${l.rel}|${l.kind}|${l.id}`;
    if (!seen.has(k)) { seen.add(k); target.push(l); }
  }
}

function attachTwinProvenance(csvEnt, nativeEnt) {
  const csvProv = { origin: "csv", id: csvEnt.id, source: { path: P.csv, line: csvEnt.data.csv_line ?? null } };
  const keepNatText = isTodo(nativeEnt.data.text) || normText(nativeEnt.data.text) !== normText(csvEnt.data.text);
  const natProv = { origin: nativeEnt.data.origin, id: nativeEnt.id, source: nativeEnt.source, ...(keepNatText ? { text: nativeEnt.data.text } : {}) };
  const existing = Array.isArray(csvEnt.data.provenance) ? csvEnt.data.provenance : [csvProv];
  if (!existing.some((p) => p.origin === natProv.origin && p.id === natProv.id)) existing.push(natProv);
  csvEnt.data.provenance = existing;
  mergeLinks(csvEnt.links, nativeEnt.links);
  for (const k of NATIVE_TWIN_FIELDS) {
    if (nativeEnt.data[k] !== undefined && csvEnt.data[k] === undefined) csvEnt.data[k] = nativeEnt.data[k];
  }
  if (nativeEnt.data.speaker != null && csvEnt.data.native_speaker === undefined) csvEnt.data.native_speaker = nativeEnt.data.speaker;
  if (csvEnt.data.speakerKind === "system" && nativeEnt.data.speakerKind && nativeEnt.data.speakerKind !== "system") {
    csvEnt.data.speakerKind = nativeEnt.data.speakerKind;
    csvEnt.data.speakerId = nativeEnt.data.speakerId;
    csvEnt.data.speakerSource = nativeEnt.data.speakerSource;
  }
  if (csvEnt.production == null && nativeEnt.production != null) csvEnt.production = nativeEnt.production;
}

/**
 * Structural twin key for a CSV line row -> matches the exact native entity id it duplicates, or null for non-structural rows.
 * Prevents identical text across distinct entities (e.g. long_haul on two locations, or identical flaws on two squad members) from collapsing.
 */
function csvStructuralTwinKey(e, { locations, squadMembers }) {
  const file = e.data.file ?? e.source?.path ?? "";
  const dp = parseDataPath(e.data.data_path);
  if (!dp) return null;
  if (file === P.locations && Number.isInteger(dp[0]) && dp[1] === "long_haul" && dp[2] === "text" && locations[dp[0]]) {
    return `long_haul:${locations[dp[0]].id}`;
  }
  if (file === P.relations && dp[0] === "traders" && typeof dp[1] === "string") {
    if (dp[2] === "lines" && typeof dp[3] === "string") return `rel:${dp[1]}:${dp[3]}`;
    if (dp[2] === "encouragement" && Number.isInteger(dp[3])) return `enc:${dp[1]}:${dp[3]}`;
  }
  if (file === P.squad && dp[0] === "members" && Number.isInteger(dp[1]) && squadMembers[dp[1]]) {
    const mid = squadMembers[dp[1]].id;
    if (SQUAD_TWIN_FIELDS.has(dp[2]) && dp.length === 3) return `squad:${mid}:${dp[2]}`;
    if ((dp[2] === "flaw" || dp[2] === "synergy") && dp[3] === "text") return `squad:${mid}:${dp[2]}`;
  }
  return null;
}

/**
 * V1.1: dedupe native entity line rows against their CSV twins (same line from entity data and text_review.csv).
 * Matches data-backed lines strictly by structural key (data_path -> native entity id) and raid_story 1-to-1 by normalized text.
 * Keeps the CSV row as canonical, merges links + native metadata, and keeps both sources in data.provenance; unmatched natives stay separate.
 */
function dedupeLineTwins(ents, ctx, droppedOut) {
  const csvByStructKey = new Map();
  const csvRaidByText = new Map();
  for (const e of ents) {
    if (e.kind !== "line" || e.data.origin !== "csv") continue;
    const sk = csvStructuralTwinKey(e, ctx);
    if (sk) {
      if (!csvByStructKey.has(sk)) csvByStructKey.set(sk, []);
      csvByStructKey.get(sk).push(e);
    } else if ((e.data.file ?? e.source?.path) === P.raidStory) {
      const tk = normText(e.data.text);
      if (!csvRaidByText.has(tk)) csvRaidByText.set(tk, []);
      csvRaidByText.get(tk).push(e);
    }
  }
  const dropped = new Set();
  const claimedCsv = new Set();
  for (const e of ents) {
    if (e.kind !== "line" || e.data.origin === "csv") continue;
    if (e.data.origin === "raid_story") {
      const hits = csvRaidByText.get(normText(e.data.text));
      const target = hits?.find((c) => !claimedCsv.has(c));
      if (target) {
        claimedCsv.add(target);
        attachTwinProvenance(target, e);
        dropped.add(e);
        droppedOut?.push({ kind: "line", id: e.id, origin: e.data.origin, reason: "twin" });
      }
      continue;
    }
    const candidates = csvByStructKey.get(e.id);
    if (!candidates?.length) continue;
    const hits = e.data.origin === "encouragement"
      ? candidates.filter((c) => {
          const ct = normText(c.data.text);
          return ct && (ct === normText(e.data.title) || ct === normText(e.data.story));
        })
      : candidates.filter((c) => normText(c.data.text) === normText(e.data.text));
    if (hits.length) {
      for (const csvEnt of hits) attachTwinProvenance(csvEnt, e);
      dropped.add(e);
      droppedOut?.push({ kind: "line", id: e.id, origin: e.data.origin, reason: "twin" });
    }
  }
  return dropped.size ? ents.filter((e) => !dropped.has(e)) : ents;
}

/**
 * V1 review priority class of a text line: 'story' (read first) | 'flavor' | 'ui' (bulk-OK by group later).
 * First matching rule wins; table order matters. `line` = { origin, file, dataPath(array|null) }.
 */
const ROW_CLASS_RULES = [
  [(l) => ["trader_relations", "raid_story", "long_haul"].includes(l.origin), "story"],
  [(l) => l.origin === "squad" && ["bio", "name"].includes(l.field), "story"],
  [(l) => l.origin === "squad", "ui"],
  [(l) => l.origin === "encouragement" || (l.file === P.relations && l.dataPath?.[2] === "encouragement"), "flavor"],
  [(l) => l.file === P.questlines || l.file === P.relations || l.file === P.raidStory || l.file === P.squad && ["bio", "name"].includes(String(l.dataPath?.at(-1))), "story"],
  [(l) => l.file === P.squad && l.dataPath?.[0] === "members", "ui"],
  [(l) => l.file === P.contracts || l.file === P.traders || l.file === P.enemies || l.file === P.recipes || l.file === P.items, "flavor"],
  [(l) => /^(?:docs\/|data\/lore|scenes\/title\/)/.test(l.file ?? ""), "story"],
  [(l) => /(?:^|\/)(?:dialogue|dialog|cutscene|intro|credits)[\w.]*$/i.test(l.file ?? ""), "story"],
  [(l) => /^(?:systems|autoloads)\//.test(l.file ?? ""), "flavor"],
];
function rowClass(line) {
  for (const [test, cls] of ROW_CLASS_RULES) if (test(line)) return cls;
  return "ui";
}

/** data fields for a resolved identity; `speakerKind/speakerId/speakerSource` are what the UI keys on. */
function speakerData(who, source) {
  return who ? { speakerKind: who.kind, speakerId: who.id, speakerSource: source } : { speakerKind: null, speakerId: null, speakerSource: null };
}

/** spoken_by link only for speakers that are registry entities (trader / squad); system/party/narrator have no entity to link. */
function linkSpeaker(L, who) {
  if (who && (who.kind === "trader" || who.kind === "squad")) L("spoken_by", who.kind, who.id);
  return L;
}

// ---------- the adapter ----------
async function load(reader, sha) {
  const warnings = [];
  const src = (p, line) => ({ path: p, line: line ?? null });
  const rd = (f) => readJson(reader, f, warnings);
  const [tr, sq, en, lo, ro, it, sk, co, re, ql, rel] = await Promise.all([P.traders, P.squad, P.enemies, P.locations, P.rooms, P.items, P.skills, P.contracts, P.recipes, P.questlines, P.relations].map(rd));
  const [scavText, raidStoryText, csvText, voiceText, vibesText, breadthText, auditText] = await Promise.all([P.scav, P.raidStory, P.csv, P.voice, P.vibes, P.breadth, P.audit].map((f) => reader.readFile(f)));
  for (const [f, t] of [[P.scav, scavText], [P.raidStory, raidStoryText], [P.csv, csvText], [P.voice, voiceText], [P.vibes, vibesText], [P.breadth, breadthText], [P.audit, auditText]]) if (t == null) warnings.push(`missing ${f} at ${sha.slice(0, 8)}`);

  const ents = [];
  const droppedLines = []; // V8: rows the adapter excluded (dev strings, entity/csv twins), so "gone" can say why
  const E = (o) => { ents.push(entity(o)); };
  const traders = tr.json?.traders ?? {};
  const relTraders = rel.json?.traders ?? {};
  const squadMembers = sq.json?.members ?? [];
  const enemies = en.json?.enemies ?? {};
  const locations = Array.isArray(lo.json) ? lo.json : [];
  const bossIds = new Set(locations.map((l) => l.boss?.enemy_id).filter(Boolean));
  const enemySpawnMap = buildEnemySpawnMap(locations);
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
    for (const locId of enemySpawnMap.get(id) ?? []) L("spawns_at", "location", locId); // V1.1: enemy -> spawn locations
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
        production: isTodo(t) ? "placeholder" : null, data: { text: t, origin: "long_haul", speaker: "narrator", ...speakerData({ kind: "narrator", id: "narrator" }, "explicit"), rowClass: rowClass({ origin: "long_haul" }), at_s: l.long_haul.at_s ?? null, kind: l.long_haul.kind ?? null },
      });
    }
  }
  // rooms
  for (const [id, r] of Object.entries(ro.json?.rooms ?? {})) {
    const L = linker();
    for (const t of r.upgrade_tiers ?? []) for (const k of Object.keys(t.materials ?? {})) L("upgrade_material", "item", k);
    E({
      id, kind: "room", display: r.display_name ?? titleCase(id), aliases: [id, r.starter_display_name], source: src(P.rooms, ro.f.key(id)), links: L.links,
      data: { starter_display_name: r.starter_display_name ?? null, tiers: (r.upgrade_tiers ?? []).length, max_level: Math.max(0, ...(r.upgrade_tiers ?? []).map((t) => Number(t.max) || 0)) || null },
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
    L("spoken_by", "trader", c.trader); L("said_at", "location", c.location); // V1: who offers it, where
    if (c.enemy) {
      L("mentions", "enemy", c.enemy); // V1.1: consistent link shape
      if (!c.location) for (const locId of enemySpawnMap.get(c.enemy) ?? []) L("said_at", "location", locId);
    }
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
      L("trader", "trader", traderId); L("spoken_by", "trader", traderId); // V1
      const t = s.task ?? {};
      const stepLoc = s.task?.type === "extract" || s.task?.type === "kill" ? s.task.location : null;
      L("said_at", "location", stepLoc);
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
      E({ id: `rel:${tid}:${k}`, kind: "line", display: text.slice(0, 60), source: src(P.relations, rel.f.key(k, start - 1)), links: L.links, production: isTodo(text) ? "placeholder" : null, data: { text, origin: "trader_relations", speaker: tid, ...speakerData({ kind: "trader", id: tid }, "explicit"), rowClass: rowClass({ origin: "trader_relations" }), band: k } });
    }
    (r.encouragement ?? []).forEach((e, i) => {
      const L = linker(); L("spoken_by", "trader", tid); L("wants_item", "item", e.item_id);
      for (const q of e.requires ?? []) L("requires_skill", "skill", q?.skill);
      const text = `${e.title ?? ""}: ${e.story ?? ""}`;
      E({ id: `enc:${tid}:${i}`, kind: "line", display: (e.title ?? "") + (e.story ? ` — ${e.story.slice(0, 40)}` : ""), source: src(P.relations, rel.f.find(/"encouragement"/, start - 1)), links: L.links, production: isTodo(text) ? "placeholder" : null, data: { text, title: e.title ?? "", story: e.story ?? "", origin: "encouragement", speaker: tid, ...speakerData({ kind: "trader", id: tid }, "explicit"), rowClass: rowClass({ origin: "encouragement" }), item_id: e.item_id ?? null, qty: e.qty ?? null, requires: e.requires ?? [] } });
    });
  }
  // narrative lines: squad texts
  for (const m of squadMembers) {
    const sline = sq.f.idRow(m.id);
    for (const [field, text] of [["name", m.name], ["bio", m.bio], ["trait_text", m.trait_text], ["flaw", m.flaw?.text], ["synergy", m.synergy?.text]]) {
      if (!text) continue;
      const L = linker(); L("spoken_by", "squad", m.id);
      if (field === "synergy") for (const locId of m.synergy?.locations ?? []) L("said_at", "location", locId);
      E({ id: `squad:${m.id}:${field}`, kind: "line", display: clean(text).slice(0, 60), source: src(P.squad, sline), links: L.links, production: isTodo(text) ? "placeholder" : null, data: { text, origin: "squad", speaker: m.id, ...speakerData({ kind: "squad", id: m.id }, "explicit"), rowClass: rowClass({ origin: "squad", field }), field } });
    }
  }
  // narrative lines: raid_story templates
  parseRaidStory(raidStoryText ?? "").forEach((t, i) => {
    // actor/we/medic/victim name the sentence subject, not who speaks: the whole log is the squad's callsign voice (inferred)
    E({ id: `raid_story:${i + 1}`, kind: "line", display: t.text.slice(0, 60), source: src(P.raidStory, t.line), production: null, data: { text: t.text, origin: "raid_story", speaker: t.speaker, ...speakerData(SPEAKER_PARTY, "inferred"), rowClass: rowClass({ origin: "raid_story" }) } });
  });

  // CSV rows (V1.1: exclude dev-only/validation strings, split System by screen, extend links, dedupe entity/csv twins)
  const stepCtx = questStepContext(ents);
  if (csvText != null) {
    const { header, records } = parseCsvObjects(csvText);
    if (!header.includes("current_text")) warnings.push(`${P.csv}: no current_text column, ${records.length} rows imported with empty text`);
    const gdSourceCache = await loadGdSourcesForCsv(reader, records);
    const nameIndex = speakerNameIndex(traders, squadMembers);
    const seen = new Map();
    for (const { row, line } of records) {
      if (isDevOnlyCsvRow(row, gdSourceCache)) { droppedLines.push({ kind: "line", id: null, origin: "csv", reason: "dev-string", file: row.file ?? "", data_path: row.data_path ?? "", text: row.current_text ?? "" }); continue; }
      const base = `csv:${row.file}:${row.line}:${row.data_path}`;
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const L = linker();
      const named = resolveSpeakerName(row.speaker, nameIndex);
      const rawWho = named ?? inferCsvSpeaker(row, { traders, squadMembers });
      const who = rawWho.kind === "system" && rawWho.id === "system" ? { kind: "system", id: inferSystemScreenId(row) } : rawWho;
      linkSpeaker(L, who);
      const dp = parseDataPath(row.data_path);
      linkCsvRowContext(L, row, dp, { stepCtx, locations, enemies, squadMembers, enemySpawnMap });
      E({
        id: n === 1 ? base : `${base}#${n}`, kind: "line", display: (row.current_text ?? "").replace(/\s+/g, " ").slice(0, 60),
        source: src(row.file || P.csv, Number.isInteger(Number(row.line)) && Number(row.line) >= 1 ? Number(row.line) : null), links: L.links, production: csvProduction(row.status),
        data: { ...row, text: row.current_text ?? "", origin: "csv", csv_line: line, ...speakerData(who, named ? "explicit" : "inferred"), screen: row.group || null, rowClass: rowClass({ origin: "csv", file: row.file, dataPath: dp }) },
      });
    }
  }
  const deduped = dedupeLineTwins(ents, { locations, squadMembers }, droppedLines);
  if (deduped !== ents) { ents.length = 0; ents.push(...deduped); }

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
  // doc bodies (SB3 #3 doc<->data drift reads quotes and file:line cites from these); additive, free-form lore
  for (const [docId, file, body] of [["VOICE_BIBLE", P.voice, voiceText], ["QUEST_AUDIT", P.audit, auditText], ["PLAN_MAP_VIBES", P.vibes, vibesText]]) {
    if (body != null) E({ id: `doc:${docId}`, kind: "lore", display: `${docId} (doc)`, source: src(file, 1), data: { text: body, lore_kind: "doc", path: file } });
  }

  // Art slots (F4): read-only; one art_slot entity per manifest slot carrying its production state, linked to the
  // character/enemy it depicts only when that entity exists at this sha (reg0.has). The adapter emits no findings: missing
  // art is reported by the F2 coverage audit (registry/audit.mjs artCoverageFindings) from these entities.
  const artText = await reader.readFile(P.art);
  if (artText != null) { // optional file: a project without a manifest is unchanged (no warning, no entities)
    let artJson = null;
    let artF = finder("");
    try { artJson = JSON.parse(artText); artF = finder(artText); } catch (e) {
      warnings.push(`unparsable ${P.art}: ${String(e.message).slice(0, 120)}`);
    }
    const slots = artJson?.slots;
    if (slots && typeof slots === "object" && !Array.isArray(slots)) {
      for (const [slotId, s] of Object.entries(slots)) {
        const { slot, target } = artTarget(slotId, s?.kind);
        const L = linker();
        if (target && reg0.has(target.kind, target.id)) L(slot === "sprite" ? "sprite" : "portrait", target.kind, target.id);
        E({
          id: slotId, kind: "art_slot", display: slotId, aliases: [], source: src(P.art, artF.key(slotId)), links: L.links,
          production: artProduction(s?.status),
          data: { artKind: s?.kind ?? null, slot, status: s?.status ?? null, batch: s?.batch ?? null, path: s?.path ?? null, candidates: s?.candidates ?? null, target },
        });
      }
    } else if (artJson) {
      warnings.push(`${P.art}: no slots object, no art slots imported`);
    }
  }
  attachRenderedContracts(ents, sk.json?.mastery?.families); // V9: player-facing contract title per template (additive; own function)
  await attachItemEconomy(reader, ents, locations);
  return { entities: ents, warnings, dropped: droppedLines };
}

/**
 * V9: the player-facing title of every contracts.json template, filled with the real trader / item / enemy / location names.
 * Mirrors ContractSystem.contract_title (systems/ContractSystem.gd); qty is a roll between qty_min and qty_max, so it renders as a range.
 * Pure: reads only the entity list (and optional mastery.families map from data/skills.json). Returns Map<templateId, {title, detail, key, parts}>.
 */
export function renderTemplates(entities, masteryFamilies = null) {
  const name = (kind, id) => (id == null ? null : entities.find((e) => e.kind === kind && e.id === id)?.display ?? String(id));
  const range = (c) => (c.qty_min != null && c.qty_max != null && c.qty_min !== c.qty_max ? `${c.qty_min}–${c.qty_max}` : String(c.qty_min ?? c.qty_max ?? "?"));
  const out = new Map();
  for (const e of entities) {
    if (e.kind !== "contract") continue;
    const c = e.data ?? {};
    const trader = name("trader", c.trader) ?? "a trader";
    const q = range(c);
    const item = name("item", c.item), enemy = name("enemy", c.enemy), location = name("location", c.location);
    const rawFam = c.family ? String(c.family) : null;
    const fam = rawFam
      ? (masteryFamilies && Object.hasOwn(masteryFamilies, rawFam) && typeof masteryFamilies[rawFam] === "string" && masteryFamilies[rawFam]
        ? masteryFamilies[rawFam]
        : rawFam.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase()))
      : null;
    let title, pay;
    switch (c.type) {
      case "deliver": title = `Deliver ${q} × ${item} for ${trader}`; pay = c.unit_reward_c != null ? `${c.unit_reward_c} c each` : null; break;
      case "kill": title = `Eliminate ${q} × ${enemy} for ${trader}`; pay = c.reward_per_kill != null ? `${c.reward_per_kill} c per kill` : null; break;
      case "pack": title = `Wipe ${q} × ${enemy} packs for ${trader}`; pay = c.reward_per_pack != null ? `${c.reward_per_pack} c per pack` : null; break;
      case "mastery": title = `${fam ?? "Weapon"} practice for ${trader}`; pay = c.reward_per_1000_xp != null ? `${c.reward_per_1000_xp} c per 1000 xp` : null; break;
      default: title = `Extract from ${location} ${q} times for ${trader}`; pay = c.reward_per_extract != null ? `${c.reward_per_extract} c per extract` : null;
    }
    const req = [];
    if (c.rep_req) req.push(`rep ${c.rep_req}`);
    for (const r of c.requires ? (Array.isArray(c.requires) ? c.requires : [c.requires]) : []) if (r?.skill) req.push(`${name("skill", r.skill)} ${r.level ?? 1}`);
    out.set(e.id, { title, detail: [pay, req.length ? `needs ${req.join(", ")}` : null, c.kit ? "rush order kit" : null].filter(Boolean).join(" · "), key: e.id, parts: { trader: c.trader ?? null, item: c.item ?? null, enemy: c.enemy ?? null, location: c.location ?? null, qty: q } });
  }
  return out;
}
function attachRenderedContracts(ents, masteryFamilies) {
  const r = renderTemplates(ents, masteryFamilies);
  for (const e of ents) if (e.kind === "contract" && r.has(e.id)) e.data.rendered = r.get(e.id);
}

/**
 * V4: attach item sources/uses from optional EFI data files (nodes.json, actions.json, plants.json, power.json, camp.json)
 * and location containers onto existing entities. Kept as a separate function so parallel adapter edits merge cleanly.
 */
async function attachItemEconomy(reader, ents, locations) {
  const locById = new Map(ents.filter((e) => e.kind === "location").map((e) => [e.id, e]));
  for (const l of locations) {
    const ent = locById.get(l.id);
    if (!ent || !Array.isArray(l.containers)) continue;
    ent.data.containers = l.containers.map((c) => ({
      id: c.id ?? "",
      name: c.name ?? titleCase(String(c.id ?? "container")),
      weight: c.weight ?? null,
      rows: (c.rows ?? []).filter((r) => r?.item_id).map((r) => ({ item_id: r.item_id, quantity: r.quantity ?? 1, chance_bp: r.chance_bp ?? null })),
    }));
  }
  const itemById = new Map(ents.filter((e) => e.kind === "item").map((e) => [e.id, e]));
  if (!itemById.size) return;
  const addSrc = (itemId, rec) => {
    const it = itemById.get(itemId);
    if (!it) return;
    if (!Array.isArray(it.data.node_sources)) it.data.node_sources = [];
    if (!it.data.node_sources.some((x) => x.kind === rec.kind && x.id === rec.id)) it.data.node_sources.push(rec);
  };
  const addUse = (itemId, rec) => {
    const it = itemById.get(itemId);
    if (!it) return;
    if (!Array.isArray(it.data.extra_uses)) it.data.extra_uses = [];
    if (!it.data.extra_uses.some((x) => x.kind === rec.kind && x.id === rec.id && x.label === rec.label)) it.data.extra_uses.push(rec);
  };
  const optJson = async (file) => {
    const raw = await reader.readFile(file);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const [nodesJson, actionsJson, plantsJson, powerJson, campJson] = await Promise.all([
    optJson("data/nodes.json"), optJson("data/actions.json"), optJson("data/plants.json"),
    optJson("data/power.json"), optJson("data/camp.json"),
  ]);
  for (const [nid, n] of Object.entries(nodesJson?.nodes ?? {})) {
    for (const d of n?.drops ?? []) if (d?.item_id) addSrc(d.item_id, { kind: "node", id: nid, label: n.display_name ?? titleCase(nid), skill: "scavenging", level_req: n.level_req ?? null });
  }
  const acts = actionsJson?.actions ?? (actionsJson && !actionsJson.meta ? actionsJson : {});
  for (const [aid, a] of Object.entries(acts ?? {})) {
    if (aid === "meta" || !a || typeof a !== "object") continue;
    for (const d of a.drops ?? []) if (d?.item_id) addSrc(d.item_id, { kind: "action", id: aid, label: a.name ?? titleCase(aid), skill: a.skill ?? null, level_req: a.level_req ?? null });
  }
  for (const [pid, p] of Object.entries(plantsJson?.plants ?? {})) {
    if (p?.crop_id) addSrc(p.crop_id, { kind: "plant", id: pid, label: titleCase(pid), skill: "farming" });
    if (p?.seed_id) addUse(p.seed_id, { kind: "plant", id: pid, label: `Grow ${titleCase(p.crop_id ?? pid)}` });
  }
  for (const fuelId of Object.keys(powerJson?.fuels ?? {})) {
    addUse(fuelId, { kind: "power", id: "generator", label: "Generator fuel" });
  }
  for (const [sid, s] of Object.entries(campJson?.structures ?? {})) {
    const sname = s?.name ?? titleCase(sid);
    for (const itemId of Object.keys(s?.cost ?? {})) addUse(itemId, { kind: "camp", id: sid, label: `Build ${sname}` });
    for (const r of s?.convert?.rows ?? []) {
      if (r?.from) addUse(r.from, { kind: "camp", id: sid, label: `${sname} input` });
      if (r?.to) addSrc(r.to, { kind: "camp", id: sid, label: sname });
    }
  }
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

/** Index of the first `#` outside a string literal on one GDScript line, or -1. */
function commentStart(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "#") return i;
  }
  return -1;
}
const GD_DIRS = ["scenes", "systems", "autoloads", "scripts"];
/**
 * `STORY-TODO` code comments in .gd files (SB2 check #8). Read through the pinned reader only (ls-tree + show).
 * A hit is a line where `#` precedes STORY-TODO outside a string literal prefix; returns [{path,line,text}] sorted by path, line.
 */
async function sourceTodoComments(reader) {
  const files = [];
  for (const d of GD_DIRS) for (const e of await reader.listTree(d, { recursive: true })) if (e.type === "blob" && e.path.endsWith(".gd")) files.push(e.path);
  files.sort();
  const out = [];
  for (let i = 0; i < files.length; i += 16) {
    const batch = await Promise.all(files.slice(i, i + 16).map(async (p) => [p, await reader.readFile(p)]));
    for (const [p, text] of batch) {
      if (text == null || !text.includes("STORY-TODO")) continue;
      text.split("\n").forEach((l, n) => {
        const h = commentStart(l);
        if (h >= 0 && l.indexOf("STORY-TODO", h) > h) out.push({ path: p, line: n + 1, text: l.slice(h).trim().slice(0, 160) });
      });
    }
  }
  return out;
}

export const efiAdapter = {
  id: "efi",
  defaultRepoPath: null, // never hardcoded: the caller (SB4, from VS project config) supplies the repo path
  load,
  hooks: { spawnWindow, killTargetLocations, sourceTodoComments },
};
export default efiAdapter;
