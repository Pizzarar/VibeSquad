# Storybook v1 — EFI dry run (SB6)

Live read-only run of the Storybook engine (`server/storybook/`) against the EFI project's pinned `origin/main`.
Every byte came through the pinned-sha reader (`git show` / `git ls-tree` / `git cat-file` at one commit); nothing in the
EFI working tree was read and no fetch or write was performed.

## Pinned sha

| Field | Value |
|---|---|
| Ref | `origin/main` |
| Sha | `fd4f8c37d68ec4ec3561de2b5a6059a5d3baacc6` (`fd4f8c37`) |
| Kind | merge commit, 2026-11-24 |
| INV measured | `dea824f5` |

The tree has moved since the inventory (`docs/brainstorm/STORYBOOK_EFI_INVENTORY.md`, "INV") was written at `dea824f5`;
diffs are called out below rather than papered over.

## Summary line (raw)

```
[STORYBOOK] sha=fd4f8c37 #3=11 #4=4 #5=2 #6=6 #7=19 #8=89 #11=6 total=137
```

Check ids with no findings are absent from the line: `#1=0`, `#2=0`, `#9=0`, `#10=0` (and `#12` is not implemented).

## Per-check verdict (INV §4 expected | got | verdict)

| # | INV §4 example | Got at `fd4f8c37` | Verdict |
|---|---|---|---|
| 1 | 0 dangling ids; 13 `skill:"scavenging"` refs need a merged skill registry or raise 13 false positives | 0 findings; the adapter merges `scavenging` from `systems/ScavengingSystem.gd` into the skill registry | **reproduces** — 0 dangling, 0 scavenging false positives |
| 2 | passes today (popper_3, mechanic_2, broker_4); CB3 breaks broker_4 (future) | 0 findings; `bunker_warden` still spawns at `sealed_vault` | **reproduces** — CB3 not on `origin/main` |
| 3 | doc_2 gauze→reach, VOICE_BIBLE "gauze", vault roster (CB3 contradicts) | 11 findings incl. doc_2 and the "gauze" drift; vault roster drift = 0 | **reproduces** — doc↔data drift caught; vault roster explained (CB3 not landed) |
| 4 | 52 trader_relations rows have no speaker; card bans are prose | 4 info tallies; 52 relations rows + 44 squad rows inferred; 0 ban violations | **reproduces** — speaker inference works, no ban hits |
| 5 | fence_3 `armored_scav` ×10; broker_2 `pmc_squad` ×10 | 2 findings: broker_2 (warn), fence_3 (info) | **reproduces** |
| 6 | "Word gets around" ×6; Medic encouragement [0]==[1]; raid_story ~ long_haul | 6 findings: word ×6, medic dup, 2× long_haul identical, 2× near-dup | **reproduces** (+2 extra real duplicates) |
| 7 | `doc` trader/squad, Wrench, Foreman, Tank | 19 findings: all 4 INV clashes + 15 token/alias word-subset hits | **reproduces** (see breakdown) |
| 8 | 66 prefixed strings + 19 `.gd` comments | 89 = 66 strings + 23 comments | **reproduces** — tree moved: +4 comments |
| 9 | suppress naive Builder "him" / Fence "her" (rivals) | 0 findings | **reproduces** — referent-aware, no false positives |
| 10 | "spirits" (alcohol) false positive → context allowlist | 0 findings | **reproduces** — allowlisted |
| 11 | doc_2 "Packing Wounds" unless the DRAFT landed | 6 info findings incl. doc_2 ("Somewhere to Work" DRAFT not applied) | **reproduces** |
| 12 | needs a fact store first | not implemented (no `#12` module registered) | **explained** — deferred per INV |

## Raw CLI output (findings)

Six warnings were emitted at ingest (CB3 look rows whose enemies are not on `origin/main`):

```
CONTENT_BREADTH_SPEC look row for yard_scav (Yard Scav): no such enemy at this sha, link skipped
CONTENT_BREADTH_SPEC look row for signalman (Signalman): no such enemy at this sha, link skipped
CONTENT_BREADTH_SPEC look row for freight_crew (Freight Crew): no such enemy at this sha, link skipped
CONTENT_BREADTH_SPEC look row for archive_trooper (Archive Trooper): no such enemy at this sha, link skipped
CONTENT_BREADTH_SPEC look row for records_keeper (Records Keeper): no such enemy at this sha, link skipped
CONTENT_BREADTH_SPEC look row for strongroom_guard (Strongroom Guard): no such enemy at this sha, link skipped
```

### #3 doc ↔ data drift (11)

```
[warn]  VOICE_BIBLE says "gauze" at data/questlines.json:17-18, but the cited data no longer mentions it: "Clean bandages and gauze to keep working ("
[info]  VOICE_BIBLE says "gun bench" at data/trader_relations.json:50, but the cited data no longer mentions it: "runs a gun bench ("
[warn]  VOICE_BIBLE quotes "everyone buys food, nobody asks where it came from" at data/questlines.json:48, but it is now at data/questlines.json:49
[warn]  VOICE_BIBLE says "canned food" at data/questlines.json:48, but the cited data no longer mentions it (it is at data/questlines.json:49, the cite looks stale): "Canned food to deal with you directly ("
[warn]  quest_step:doc_2 QUEST_AUDIT scores doc_2 as "deliver gauze" but data is reach room medical_bay: type deliver -> reach, item gauze -> none (audit §4 P-doc-2 proposes this change, the score table is pre-change)
[warn]  quest_step:fence_1 QUEST_AUDIT cites fence_1 at data/questlines.json:48 but the step is now at line 49
[warn]  quest_step:fence_2 QUEST_AUDIT cites fence_2 at data/questlines.json:49 but the step is now at line 48
[warn]  quest_step:fence_3 QUEST_AUDIT scores fence_3 as "kill armored_scav" but data is kill armored_scav: qty 15 -> 10 (audit §4 P-fence-2, P-thin-template proposes this change, the score table is pre-change)
[warn]  quest_step:mechanic_2 QUEST_AUDIT scores mechanic_2 as "kill customs_depot" but data is kill depot_scav @customs_depot: enemy any -> depot_scav, qty 100 -> 8 (audit §4 P-mechanic-1 proposes this change, the score table is pre-change)
[warn]  quest_step:medic_3 QUEST_AUDIT scores medic_3 as "kill base_sentry" but data is kill base_sentry: qty 20 -> 12 (audit §4 P-medic-2, P-thin-template proposes this change, the score table is pre-change)
[warn]  quest_step:popper_3 QUEST_AUDIT scores popper_3 as "kill scav" but data is kill scav @harbor_district: location any -> harbor_district, qty 50 -> 10 (audit §4 P-popper-1, P-thin-template proposes this change, the score table is pre-change)
```

### #4 speaker inference + card bans (4, all info tallies)

```
[info]  data/questlines.json: 0 rows inferred a speaker from the data path; 50 rows already carry a speaker
[info]  data/squad.json: 44 rows inferred a speaker from the data path (doc 6, magpie 6, wrench 5, tank 6, skillet 5, patch 5, prof 6, smooth 5)
[info]  data/trader_relations.json: 52 rows inferred a speaker from the data path (popper 8, doc 8, mechanic 8, medic 10, builder 8, fence 10)
[info]  scenes/raids/corridor/raid_story.gd: 0 rows inferred a speaker from the data path; 35 rows get the actor/callsign role
```

No `warn` findings: no narrative unit violates a card's "Never says" term or the player word.

### #5 spawn window / reach caps (2)

```
[warn]  quest_step:broker_2 kill pmc_squad x10 cannot happen in a default-length raid (harbor_district 1200-2400s vs default raid 600s; railway_yard 900-2400s vs default raid 600s); needs an extended raid
[info]  quest_step:fence_3 kill armored_scav x10 is out of reach in a default-length raid at some locations (harbor_district 600-1800s vs default raid 600s)
```

Note on fence_3 severity: `armored_scav` now also spawns at `railway_yard` (300–1800 s, within the 600 s
default), so only `harbor_district` is out of reach — hence `info` ("some locations"), not `warn` ("all"). INV
described the enemy as "spawns only at 600–1800 s"; the railway row is a data change since `dea824f5`, not a check bug.

### #6 template / n-gram clustering (6)

```
[warn]  line:enc:medic:0 identical text x2: "'I'm out, and you know whose cupboard is full. {qty}. Then you get my contracts back.'" (enc:medic:0, enc:medic:1)
[warn]  line:long_haul:customs_depot identical text x2: "A supply convoy stopped at the checkpoint. The squad hit it." (long_haul:customs_depot, long_haul:military_base)
[warn]  line:long_haul:harbor_district identical text x2: "A supply drop came down nearby. The squad reached it." (long_haul:harbor_district, long_haul:railway_yard)
[warn]  line:long_haul:harbor_district near-duplicate (5-word shared run, 63% of the shorter): long_haul:harbor_district "A supply drop came down nearby. The squad reached it." ~ raid_story:30 "A supply drop came down. %s grabbed %s."
[warn]  line:long_haul:railway_yard near-duplicate (5-word shared run, 63% of the shorter): long_haul:railway_yard "A supply drop came down nearby. The squad reached it." ~ raid_story:30 "A supply drop came down. %s grabbed %s."
[warn]  line:rel:popper:word template repeated x6: "Word gets around: Popper heard about that." (rel:popper:word, rel:doc:word, rel:mechanic:word, rel:medic:word, rel:builder:word, rel:fence:word)
```

The first, second, third, and last are INV's examples (Medic duplicate, raid_story↔long_haul near-dup, "Word gets
around" ×6). The two "identical text" long_haul pairs are additional real duplicates (customs_depot = military_base,
harbor_district = railway_yard) the check surfaced on its own.

### #7 id and display collisions (19)

See the breakdown section below.

### #8 STORY-TODO leftovers (89)

Counts line: `#8=89` = **66 prefixed strings** (questline `title`+`story` 50, squad `name`+`bio` 16) + **23 `.gd` comments**.

Comment findings by file (INV counted 19 in 5 files; +4 since `dea824f5`):

```
scenes/shell/welcome_back_overlay.gd       1
scenes/traders/questline_panel.gd          2
scenes/traders/traders_view.gd            13
scripts/ui/kit/kit_destination_list.gd     2
systems/ContractSystem.gd                  3   (new since INV)
systems/QuestlineSystem.gd                 1   (new since INV)
systems/TraderSystem.gd                    1
```

The 66 string findings are the INV set verbatim: 25 questline titles + 25 stories (popper_1…broker_4), and 8 squad
names + 8 squad bios (doc, magpie, wrench, tank, skillet, patch, prof, smooth). Release needs 0; nothing here gates.

### #11 title ↔ task coherence (6, all info)

```
[info]  quest_step:broker_2 "Hired Guns" shares no word with its task (kill pmc_squad) or its story; the DRAFT rewrite "Hired Guns" does not fix it either (lexical check only, low confidence)
[info]  quest_step:doc_2 "Packing Wounds" shares no word with its task (reach room medical_bay) or its story; fixed by the DRAFT rewrite "Somewhere to Work" (csv row line 2919), not yet applied to data when status is not OWNER-OK
[info]  quest_step:fence_1 "Pantry Run" shares no word with its task (deliver canned_food) or its story; the DRAFT rewrite "Pantry Run" does not fix it either (lexical check only, low confidence)
[info]  quest_step:fence_3 "Plated Problems" shares no word with its task (kill armored_scav) or its story; the DRAFT rewrite "Plated Problems" does not fix it either (lexical check only, low confidence)
[info]  quest_step:medic_1 "Clean Stock" shares no word with its task (deliver antiseptic) or its story; fixed by the DRAFT rewrite "Clean Stock" (csv row line 2931), not yet applied to data when status is not OWNER-OK
[info]  quest_step:medic_2 "Field Hospital" shares no word with its task (extract @military_base) or its story; fixed by the DRAFT rewrite "Field Hospital" (csv row line 2933), not yet applied to data when status is not OWNER-OK
```

doc_2 is INV's example: the DRAFT rewrite "Somewhere to Work" exists in `docs/review/text_review.csv` but has not
been applied to `data/questlines.json`, so it is still flagged (as info).

## #7 breakdown (19 findings → 4 real, 15 token/alias noise)

| # | Sev | Finding (abridged) | Verdict |
|---|---|---|---|
| 1 | info | word "scav" (enemy `scav`/`armored_scav`/`depot_scav`, item `boots_l1`/`helmet_l1`/`legs_l1`/`rig_l1`) | token noise |
| 2 | info | word "foreman" — enemy `boss_sublevel5_guardian` (The Foreman) + `line_foreman` (Line Foreman) | **real** (INV: "Foreman") |
| 3 | info | word "map" — item `map` + enemy `map_room_guard` | token noise |
| 4 | info | word "tank" — squad `tank` + enemy `tank_diver` | **real** (INV: "Tank") |
| 5 | info | word "backpack" — item `backpack` + `backpack_small` | token noise (same kind) |
| 6 | info | word "barrel" — item `barrel` + room `stove` (starter name "Barrel Fire") | alias/token noise |
| 7 | info | word "kevlar" — item `kevlar` + `boots_l3`/`helmet_l3`/`legs_l3` | token noise (same kind) |
| 8 | info | word "cloth" — item `cloth` + `cloth_strips` | token noise (same kind) |
| 9 | info | word "coffee" — item `coffee` + `coffee_beans` | token noise (same kind) |
| 10 | info | word "wire" — item `copper_ore` (Copper Wire) + `wire` | token noise (same kind) |
| 11 | info | word "generator" — item `generator_parts` + room `generator` | token noise (cross-type) |
| 12 | info | word "ginseng" — item `ginseng` + `ginseng_seeds` | token noise (same kind) |
| 13 | info | word "herbs" — item `herbs` + `medicinal_herbs` | token noise (same kind) |
| 14 | info | word "intel" — item `intel` + room `intel_table` | token noise (cross-type) |
| 15 | info | word "keycard" — item `keycard` + `trophy_overseer` (Overseer's Keycard) | token noise (same kind) |
| 16 | info | word "leather" — item `leather` + `leather_strap` | token noise (same kind) |
| 17 | info | word "scope" — item `rare_scope` + `scope` | token noise (same kind) |
| 18 | info | name "wrench" — item `tool_wrench` + squad `wrench` | **real** (INV: "Wrench") |
| 19 | warn | id "doc" — squad `doc` (Saint) + trader `doc` (Doc) | **real** (INV: "doc") |

All four of INV's cross-registry clashes reproduce exactly (doc, Wrench, Foreman, Tank). The other 15 are the check's
word-subset heuristic ("a one-word name that is also a whole word of another name") firing on benign same-kind or
cross-type name overlaps (e.g. "Coffee" vs "Coffee Beans", "Barrel" vs the room `stove`'s starter name "Barrel Fire").
None is a false positive of the engine; the INV curated its "4 clashes" and did not enumerate these word-level overlaps.

## Bugs

None. Every finding above is correct, and the zero-count checks are correct behaviour, not misses:

- `#1=0` — `scavenging` is merged into the skill registry, so the 13 `skill:"scavenging"` refs resolve.
- `#2=0` — CB3's `strongroom_guard` retarget is branch-only; `bunker_warden` still spawns at `sealed_vault` on `origin/main`.
- `#3` vault-roster = 0 — CB3's vault change is not on `origin/main`, so `docs/PLAN_MAP_VIBES.md` is not yet drift.
- `#9=0` — referent resolution correctly suppresses the Builder/Fence rival-pronoun false positives.
- `#10=0` — "spirits" is caught by the alcohol-context allowlist, and no other tone term fires.

No miss or false positive is a code bug, so nothing here was fixed. Two non-bug observations for review (not dispatched
fixes):

1. **fence_3 severity is `info`, not `warn`.** `armored_scav` gained a `railway_yard` row (300–1800 s) since `dea824f5`,
   so only `harbor_district` is out of reach. This is a data change, not a check defect; if the intent is "any late
   spawn window on a no-location kill is a warn", that is a one-line policy change in
   `server/storybook/checks/structural.mjs` (the `all = late.length === wins.length` severity split).
2. **#7 is noisy for same-kind word-subset overlaps** (10 of the 15 "token noise" rows are item-vs-item, e.g.
   "Coffee" vs "Coffee Beans"). If the owner wants #7 to surface only cross-kind and cross-registry clashes, the
   word-subset clause in `server/storybook/checks/structural.mjs` (`word "... is a name and also part of another name"`)
   could be limited to mixed kinds. No change made.

## SB6b re-run

Re-ran the engine read-only at the same pinned sha (`fd4f8c37`) on branch `sb6b-tighten-7`, through the same pinned-sha
reader (`git show` / `git ls-tree`, no fetch, no EFI worktree read, no write). Only `server/storybook/checks/structural.mjs`
changed: the #7 word-subset clause now reports a word only when **every** name sharing it is a character-like kind
(`trader`, `squad`, `enemy`). Exact-name and id clashes are unchanged.

The brief's "character vs item → finding" shape cannot coexist with this target on EFI: the `scav` group
(`Scav` vs `Scav Boots`…) and the `map` group (`Map` vs `Map Room Guard`) are character-vs-item overlaps and are exactly
two of the 15 rows that must drop to reach 4. The implemented rule keeps the two character-vs-character word clashes
(`Tank` vs `Tank Diver`, `The Foreman` vs `Line Foreman`) and quiets every group that involves an item or room.

Summary line after the change:

```
[STORYBOOK] sha=fd4f8c37 #3=11 #4=4 #5=2 #6=6 #7=4 #8=89 #11=6 total=122
```

### #7 after (4: 2 word clashes + 1 exact name + 1 id)

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 1 | info | word "foreman": enemy `boss_sublevel5_guardian` (The Foreman) + enemy `line_foreman` (Line Foreman) | **real** (INV: "Foreman") |
| 2 | info | word "tank": squad `tank` (Tank) + enemy `tank_diver` (Tank Diver) | **real** (INV: "Tank") |
| 3 | info | name "wrench" is shared by item `tool_wrench` (Wrench) + squad `wrench` (Wrench) | **real** (INV: "Wrench") |
| 4 | warn | id "doc" is used by squad `doc` (Saint) + trader `doc` (Doc) | **real** (INV: "doc") |

Raw:

```
[info]  enemy:boss_sublevel5_guardian word "foreman" is a name and also part of another name: enemy boss_sublevel5_guardian (The Foreman), enemy line_foreman (Line Foreman)
[info]  enemy:tank_diver word "tank" is a name and also part of another name: enemy tank_diver (Tank Diver), squad tank (Tank)
[info]  item:tool_wrench name "wrench" is shared by item tool_wrench (Wrench), squad wrench (Wrench)
[warn]  squad:doc id "doc" is used by squad + trader (Saint / Doc)
```

The 15 former rows are gone, including all 10 item-vs-item chains (`Coffee`/`Coffee Beans`, `Kevlar`/`Kevlar Boots`, …),
the 3 item-vs-room overlaps (`Barrel`/`Barrel Fire`, `Generator`/`Generator`, `Intel`/`Intel Table`) and the 2
character-vs-item theme overlaps (`Scav`/`Scav Boots`, `Map`/`Map Room Guard`). No other check count changed; `#1`, `#2`,
`#9`, `#10` remain 0.

### SB6b minors re-run (character filter before the every() check)

The word-subset clause now filters owners and hits to character kinds (registry `character: true`) before requiring two
distinct entities, so an item sharing the word no longer silences a real character-vs-character clash. One group surfaces
that the item had been hiding: the `scav` word, shared by three enemies (`Scav`, `Armored Scav`, `Depot Scav`; the item
`Scav Boots` used to mask it). Same pinned sha:

```
[STORYBOOK] sha=fd4f8c37 #1=0 #2=0 #5=2 #7=5 #8=89 total=123
[info]  enemy:armored_scav word "scav" is a name and also part of another name: enemy armored_scav (Armored Scav), enemy depot_scav (Depot Scav), enemy scav (Scav)
```

#7 is 5 (the 4 above + `scav`); the `scav` row is an enemy-variant chain, so triage it as a likely real-but-benign row.

## Public-release hygiene

This file names the project "EFI" and uses repo-relative paths only; no absolute paths, IPs, or personal identifiers.
Verified with `node --test test/public-release.test.mjs` (see commit message for the pass/fail counts).

---

# #12 (SB7) — lore contradictions

SB7 (v1.1, last check) implements INV §4 check #12: the fact store + contradiction finder. Same read-only discipline as SB6;
every byte came through the pinned-sha reader, nothing in the EFI working tree was read, and no fetch or write was performed.

## Pinned sha

| Field | Value |
|---|---|
| Ref | `origin/main` |
| Sha | `683818e70939ff74062ebf7c8156a949fc22dbd6` (`683818e7`) |
| Measured | tree moved since SB6's `fd4f8c37`; `#3` dropped 11 → 10 (the doc_2 audit row changed), other counts unchanged |

## Summary line (raw)

```
[STORYBOOK] sha=683818e7 #3=10 #4=4 #5=2 #6=6 #7=19 #8=89 #11=6 total=136
```

`#12=0`, so it is absent from the line (only ids with findings appear). The fact store is built and registered, and the
current tree asserts no two values for the same single-valued slot.

## What was built

`server/storybook/checks/lore.mjs` exports check `#12` ("Lore contradictions (fact triples)") and is appended to
`CHECK_MODULES` in `server/storybook/checks/index.mjs` (the only line changed there). Deterministic only — no LLM.

Fact triples `(subject, slot, value)` are collected from two high-precision sources and normalised through entity aliases:

| Slot | Subject | Value | Source |
|---|---|---|---|
| `boss_of` | enemy | location | the enemy's `boss_of` link, every location's `boss` row (inverted), and PLAN_MAP_VIBES per-map "Boss" backtick id |
| `at_location` | quest step | location | `at_location` link (kill/extract task) |
| `trader` / `targets_enemy` / `wants_item` / `needs_room` / `needs_skill` | quest step | trader / enemy / item / room / skill | quest-step links |
| `seen_at` / `parent` | enemy | location / enemy | CONTENT_BREADTH_SPEC look rows (re-keyed from the `look:` lore row to the enemy it describes) |
| `spoken_by` | line | trader / squad | narrative-line speaker link |
| `produces` / `workshop` | recipe | item / room | recipe links |
| `unlocked_at` | squad member | location | squad `unlock` link |
| `first_clear_unique` | location | item | location reward link |

A contradiction is two facts that assign different values to the same `(subject, slot)`. Severity: `warn` when every
conflicting value is backed by a structured link, `info` when a value rests only on the PLAN_MAP_VIBES doc parse
("prefer precision over recall"). The `boss` → `boss_of` inversion is what makes "an enemy is boss of two locations"
detectable.

## #12 findings (raw)

```
#12 count = 0
```

## Per-check verdict (INV §4 | got | verdict)

| # | INV §4 example | Got at `683818e7` | Verdict |
|---|---|---|---|
| 12 | "Needs a fact store first; start with the doc-drift check (#3)" | 0 findings; the fact store is implemented, registered, and exercised by tests; the current tree is internally consistent | **explained** — INV row 12 carried no enumerated contradiction to reproduce, only the absence of a fact store; the store now exists and reports 0 |

## Bugs

None. `#12=0` is the same correct-behaviour class as SB6's `#1=0`/`#2=0`/`#9=0`/`#10=0`:

- The 7 bosses each map to exactly one location in `data/locations.json`, and every PLAN_MAP_VIBES per-map "Boss" backtick
  id agrees with that data (harbor→dockmaster, railway→yardmaster, customs→smuggler, military base→colonel,
  bunker→overseer). The two sublevel bosses (`boss_sublevel5_guardian`, `boss_sublevel10_guardian`) live in band rows
  (several floors each), so the check deliberately skips their band text rather than guess one floor (precision).
- The CB3 named-map look rows (`yard_scav` … `strongroom_guard`) still warn at ingest because their enemies are not on
  `origin/main`; their `seen_at`/`parent` links are skipped rather than treated as facts about a missing enemy.

The contradiction finder is exercised by `test/storybook-lore.test.mjs` on the shared fake repo: an enemy that is boss of
two locations is a `warn`; a PLAN_MAP_VIBES boss that disagrees with the data is `info`; a boss id that is not an enemy is
skipped. Character-location slots with no structured source in EFI's data (traders carry no location field; `faction` is a
reserved kind) were intentionally left unparsed rather than add a lexical guess (info-level noise, against the
precision-over-recall lean).
