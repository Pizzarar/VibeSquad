// Test helper (not a test: the suite glob is test/*.test.mjs). Builds a tiny EFI-shaped git repo in a tmp dir with a local
// "origin" clone, so reader/adapter/fetch can be tested without touching the real EFI repo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FILES = {
  "data/traders.json": JSON.stringify({ meta: {}, traders: {
    popper: { display_name: "Popper", description: "A flea-market gun seller.", level_0: true, sell_ratio: 0.5, static_stock: [{ item_id: "pistol_9mm", cost: 150 }], rotating_pool: [] },
    doc: { display_name: "Doc", description: "Back-alley medic.", static_stock: [{ item_id: "bandage", cost: 10 }] },
  } }, null, 2),
  "data/squad.json": JSON.stringify({ meta: {}, squad_seats: 3, members: [
    { id: "doc", callsign: "Saint", name: "STORY-TODO: Reyes", bio: "STORY-TODO: A former paramedic.", trait_text: "Medic: meds heal 10% more", key: "medicine_effectiveness", size: 0.1, unlock: "", flaw: { key: "search_speed", size: -0.1, text: "Hauls a trauma kit" }, synergy: { locations: ["sealed_vault"], key: "medicine_effectiveness", size: 0.1, text: "Below ground, meds heal more" } },
  ] }, null, 2),
  "data/enemies.json": JSON.stringify({ meta: {}, enemies: {
    scav: { name: "Scav", hp: 60, attack: 8, defense: 2, xp: 40, loot: { scrap_metal: 1 } },
    armored_scav: { name: "Armored Scav", hp: 110, attack: 14, defense: 8, xp: 70, loot: { scrap_metal: 2 } },
    exo_trooper: { name: "Heavy Trooper", hp: 200, attack: 20, defense: 10, xp: 90, loot: {} },
    boss_dockmaster: { name: "The Dockmaster", hp: 1640, attack: 36, defense: 25, xp: 960, loot: {}, boss: true },
  } }, null, 2),
  "data/locations.json": JSON.stringify([
    { id: "harbor_district", display_name: "Harbor District", threat_tier: "low", default_raid_seconds: 600, first_clear_unique: "pistol_9mm", long_haul: { at_s: 1800, text: "A supply drop came down nearby. The squad reached it.", rows: [{ item_id: "scrap_metal", quantity: 4 }] },
      containers: [{ id: "cargo_crate", name: "Cargo crate", rows: [{ item_id: "scrap_metal", quantity: 2 }] }],
      boss: { enemy_id: "boss_dockmaster", at_seconds: 240, min_hunt_seconds: 600 },
      enemy_pool: [{ id: "scav", tier: 1, min_time_seconds: 0, max_time_seconds: 900, weight: 1 }, { id: "armored_scav", tier: 2, min_time_seconds: 600, max_time_seconds: 1800, weight: 1 }] },
    { id: "sealed_vault", display_name: "Sealed Vault", threat_tier: "high", default_raid_seconds: 1200, enemy_pool: [{ id: "exo_trooper", tier: 2, min_time_seconds: 0, max_time_seconds: 2400, weight: 1 }] },
  ], null, 2),
  "data/rooms.json": JSON.stringify({ meta: {}, rooms: { bedroom: { display_name: "Barracks", starter_display_name: "Cot", upgrade_tiers: [{ min: 1, max: 20, materials: { cloth: 2 } }] }, workshop: { display_name: "Workshop", upgrade_tiers: [] } } }, null, 2),
  "data/items.json": JSON.stringify({ meta: {}, items: [
    { id: "scrap_metal", name: "Scrap Metal", category: "material", tier: 1, weight: 0.5, base_value: 4 },
    { id: "pistol_9mm", name: "9mm Pistol", category: "weapon", tier: 1, weight: 1, base_value: 100, description: "Basic." },
    { id: "bandage", name: "Bandage", category: "medical", tier: 1, weight: 0.1, base_value: 6 },
    { id: "cloth", name: "Cloth", category: "material", tier: 1, weight: 0.1, base_value: 2 },
  ] }, null, 2),
  "data/skills.json": JSON.stringify({ meta: {}, skills: { combat: { xp: 0 }, medicine: { xp: 0 } }, mastery: {} }, null, 2),
  "data/contracts.json": JSON.stringify({ meta: {}, templates: [
    { id: "d_popper_scrap_metal", trader: "popper", type: "deliver", item: "scrap_metal", requires: { skill: "scavenging", level: 1 }, qty_min: 68, qty_max: 135 },
    { id: "x_doc_vault", trader: "doc", type: "extract", location: "sealed_vault", qty_min: 1, qty_max: 2 },
    { id: "k_popper_scav", trader: "popper", type: "kill", enemy: "scav", qty_min: 10, qty_max: 20 },
  ] }, null, 2),
  "data/recipes.json": JSON.stringify({ meta: {}, recipes: { bandage: { ingredients: { cloth: 2 }, result_id: "bandage", result_qty: 1, description: "Wrap a wound.", skill_req: "medicine", level_req: 1, required_workshop: "workshop" } } }, null, 2),
  "data/questlines.json": JSON.stringify({ meta: {}, questlines: {
    popper: { steps: [
      { id: "popper_1", title: "STORY-TODO: Spent Brass", story: "STORY-TODO: Bring thirty casings.", task: { type: "deliver", item_id: "scrap_metal", qty: 30 }, rep: 0.05 },
      { id: "popper_2", title: "Dock Runs", story: "Clear the harbor.", task: { type: "kill", enemy_id: "scav", location: "harbor_district", qty: 10 }, rep: 0.05 },
    ] },
    doc: { steps: [{ id: "doc_1", title: "Somewhere to Work", story: "Build a bench.", task: { type: "reach", room: "workshop", level: 1 }, rep: 0.05 }] },
  } }, null, 2),
  "data/trader_relations.json": JSON.stringify({ meta: {}, traders: {
    popper: { rivals: ["doc"], lines: { wary: "Popper doesn't look up from his press.", word: "Word gets around: Popper heard about that." }, encouragement: [{ item_id: "scrap_metal", qty: 100, requires: [{ skill: "scavenging", level: 30 }], title: "Restock", story: "'I'm out. {qty}.'" }] },
    doc: { rivals: ["popper"], lines: { wary: "Doc frowns.", word: "Word gets around: Doc heard about that." } },
  } }, null, 2),
  "systems/ScavengingSystem.gd": "# res://autoloads/scavenging_system.gd\n# ============\n# ScavengingSystem — Idle scavenging skill (Autoload)\nextends Node\nvar xp: int = 0\n",
  "scenes/raids/corridor/raid_story.gd": `extends RefCounted
static func lines(obs, ctx):
\tvar result: Array = []
\tresult.append("%s slip into %s." % [we, loc_name])
\tresult.append("%s checks the %s. Nothing worth taking." % [actor, container])
\tresult.append("Tripwire! -%d." % dmg)
\tresult.append("...and the raid went on.")
\tpool.append("I")
`,
  "autoloads/ItemRegistry.gd": `extends Node
func validate_attachment_definitions():
\tvar errors: Array = []
\terrors.append("Item '%s' has category '%s' but defines attachment_slot.")
\tpush_error("Bad item table")
\tassert(false, "unreachable schema state")
\treturn errors
`,
  "docs/review/text_review.csv": "﻿group,source,file,line,data_path,id,current_text,where_seen,length_budget,tags,confidence,appendix,owner_rewrite,status,speaker,owner_note,reviewed_hash\r\n" +
    'Screen: Armory,gd,scenes/armory/armory_view.gd,14,,,Build the Armory (Hideout),armory page,none,,verify,,,STORY-TODO,,,\r\n' +
    'Trader questlines,data,data/questlines.json,12,"[""questlines"", ""popper"", ""steps"", 1, ""story""]",popper_2,"Bring thirty casings,\nand ""he\'ll"" know you.",quests,,,verify,,"Bring me thirty clean casings.",DRAFT,Popper,"keep it short",\r\n' +
    'Trader relations,data,data/trader_relations.json,5,"[""traders"", ""doc"", ""lines"", ""wary""]",,Doc frowns.,relations,,,verify,,,OWNER-OK,Saint,,abc123\r\n' +
    'Trader questlines,data,data/questlines.json,20,"[""questlines"", ""popper"", ""steps"", 1, ""title""]",,Dock Runs,quests,,,verify,,,DRAFT,,,\r\n' +
    'Data: squad,data,data/squad.json,3,"[""members"", 0, ""bio""]",,A former paramedic.,squad page,,,verify,,,DRAFT,,,\r\n' +
    'Data: squad,data,data/squad.json,4,"[""members"", 0, ""trait_text""]",,Medic: meds heal more,squad page,,,verify,,,DRAFT,,,\r\n' +
    'Screen: Raids,gd,scenes/raids/corridor/raid_story.gd,30,,,%s slip into %s.,raids page,,,verify,,,DRAFT,,,\r\n' +
    'Data: locations,data,data/locations.json,10,"[0, ""containers"", 0, ""name""]",,Cargo crate,raids page,,,verify,,,DRAFT,,,\r\n' +
    'Data: enemies,data,data/enemies.json,4,"[""enemies"", ""scav"", ""name""]",,Scav,raids page,,,verify,,,DRAFT,,,\r\n' +
    'Autoload: ItemRegistry,gd,autoloads/ItemRegistry.gd,4,,,Item \'%s\' has category \'%s\' but defines attachment_slot.,text built in ItemRegistry validate_attachment_definitions(),,,verify,,,DRAFT,,,\r\n' +
    'Autoload: ItemRegistry,gd,autoloads/ItemRegistry.gd,5,,,Bad item table,text built in ItemRegistry _load(),,,verify,,,DRAFT,,,\r\n' +
    'Autoload: ItemRegistry,gd,autoloads/ItemRegistry.gd,6,,,unreachable schema state,text built in ItemRegistry _load(),,,verify,,,DRAFT,,,\r\n' +
    'Script: art_inspector,gd,scripts/debug/art_inspector.gd,12,,,ART INSPECTOR,debug tool,,,verify,,,DRAFT,,,\r\n',
  "docs/narrative/VOICE_BIBLE.md": `# Voice Bible

## How to use

- **Global bans (every speaker):** no paranormal; no modern-meme slang; no exposition dumps; never call the player "adventurer".
- The default word for the player in this world is **"runner"** (it is already used).

## Traders

<!-- NARR-VOICE-CARD popper -->
## Popper
### Who
Flea-market gun seller. Pronoun: he.

### How they talk
- **Calls the player:** "kid", or plain "you".
- **Samples:**
  - "Thirty casings. Clean, not crushed."

### Never says
Global bans, plus: no ballistics or spec talk (that is the Mechanic's register); never says "good enough".

<!-- NARR-VOICE-CARD doc -->
## Doc
### Who
Back-alley medic. Pronoun: she.

### Never says
Global bans, plus: no clinical Latin, no sterile-inventory counts.

## Squad

<!-- NARR-VOICE-CARD squad-saint -->
## Saint (squad, id \`doc\`)
### Who
Squad medic. Pronoun: not set in data.

### Never says
Global bans, plus: no panic.

<!-- NARR-VOICE-CARD system -->
## System
### Who
The game's own voice. No pronoun.

### Never says
Global bans, plus: no contractions, no "please", no addressing the player as anything but "you".
`,
  "docs/PLAN_MAP_VIBES.md": `# PLAN_MAP_VIBES

## Per map

### 1. Harbor District (\`harbor_district\`) — ANCHOR
- **Setting:** a dead container port at dusk; cranes, wet concrete.
- **Palette / light:** olive-drab, khaki-tan.
- **Roster:** \`scav\` (hooded scavenger), \`armored_scav\` (slate plate). **Boss** \`boss_dockmaster\`: greatcoat.

### 6. Sealed Vault (\`sealed_vault\`)
- **Setting:** the sealed records vault; steel shelving.

### 7-10. The Sublevels: cold-war complex, 4 bands
| Band | Floors | Setting | Palette / light | Signature enemy (redo) |
|---|---|---|---|---|
| A | 1-3 | Service levels | concrete grey | \`shaft_runner\`: a fast scavenger |

## Plan
`,
  "docs/CONTENT_BREADTH_SPEC.md": `# CONTENT-BREADTH

## 3. Data
### 3.1 Sublevel children (CB1): 2 enemies
| id | Display name | Band | Parent | Look | Loot |
|---|---|---|---|---|---|
| \`plant_heavy\` | Plant Heavy | A 1-3 | \`exo_trooper\` (t2) | a maintenance heavy in a padded suit | steel_plate |
| \`ghost_enemy\` | Not Landed | A 1-3 | \`scav\` (t1) | a look for an enemy not in data | none |

## 4. Art
`,
};

// SB3 additive fixture: QUEST_AUDIT.md (score rows + prose cites into questlines.json, computed so they stay in step with the JSON)
const lineIn = (file, needle) => FILES[file].slice(0, FILES[file].indexOf(needle)).split("\n").length;
const QL = "data/questlines.json";
FILES["docs/narrative/QUEST_AUDIT.md"] = `# Quest audit

**3 steps across 2 chains**

- **popper_2** — kill · scav @harbor_district ×10 · R1 1 pass · **9/12** · \`:${lineIn(QL, '"id": "popper_2"')}\`
- **doc_1** — reach · room workshop lv1 · R1 1 pass · **9/12** · \`:${lineIn(QL, '"id": "doc_1"')}\`

Popper's ask reads "Clear the harbor." (data/questlines.json:${lineIn(QL, '"story": "Clear the harbor."')}).
`;

// F4 additive fixture: data/art_manifest.json (tiny, so art_slot entities + coverage findings are exercised).
FILES["data/art_manifest.json"] = JSON.stringify({
  meta: { version: 1 },
  slots: {
    "enemy.scav": { kind: "enemy_portrait", batch: "B1", status: "PIPELINE", path: "res://art/pipeline/enemy_portrait/x_enemy.scav.png" },
    "enemy.boss_dockmaster": { kind: "enemy_portrait", batch: "B1", status: "PLACEHOLDER", path: "res://art/enemy_portrait/boss_dockmaster.png", candidates: ["res://art/enemy_portrait/boss_dockmaster.png"] },
    "sprite.scav": { kind: "raid_sprite", batch: "B2", status: "PIPELINE", path: "res://art/pipeline/raid_sprite/x_sprite.scav.png" },
    "trader.popper": { kind: "trader_portrait", batch: "B1", status: "PIPELINE", path: "res://art/pipeline/trader_portrait/x_trader.popper.png" },
    "squad.doc": { kind: "squad_portrait", batch: "B1", status: "PIPELINE", path: "res://art/pipeline/squad_portrait/x_squad.doc.png" },
    "item.scrap_metal": { kind: "item_icon", batch: "B9", status: "COMMISSIONED", path: "res://art/item_icon/scrap_metal.png" },
  },
}, null, 2);

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
export const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...ENV } }).trim();

/** Make a work repo with FILES committed on `main`, plus a clone at <tmp>/clone whose origin is the work repo (so origin/main exists). */
export function makeFakeRepo(files = FILES) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "sb-fake-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(origin, p)), { recursive: true });
    fs.writeFileSync(path.join(origin, p), body);
  }
  git(origin, "add", "-A");
  git(origin, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "mini efi");
  const clone = path.join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone], { env: { ...process.env, ...ENV } });
  return { root, origin, clone, sha: git(origin, "rev-parse", "HEAD"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
