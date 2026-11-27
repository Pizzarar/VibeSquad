# Storybook dogfood W3: wave 3 (V6, V8, V10, V12, W3 riders) on real EFI data

I acted as the owner on `unit-sbv2-dogfood-w3 @ f914e081` (all of waves 1–3 + V12), built into `/tmp/sbdog3/dist`. The Storybook API ran from that tree on two private local ports (`/tmp/sbdog3/harness/srv.mjs`, now stopped):
- Port `4420` (read-only against real EFI, `VIBESQUAD_HOME=/tmp/sbdog3/vshome`) for J2–J5 and J7–J10.
- Port `4421` (read-write against a throwaway EFI clone at `/tmp/sbdog3/efi` with `origin/main` pinned identically) for J1 and J6, so real EFI and the owner's live review branch were never modified.
- EFI ref: `origin/main @ fc7a240c` (W2 was `f3541fc9`; V8 diff test seeded a last-seen snapshot at `76bb5d90`).
- Views: `1440x900` dark and `390x844` phone dark, every job at both sizes. Playwright with `chromium-browser --no-sandbox`; 0 skips.
- Screenshots: `/tmp/sbdog3/shots/` (`w1440-*`, `p390-*`).

### Snapshot & area numbers (`origin/main @ fc7a240c`)
- **Entities (4670):** 3328 text lines, 743 art slots, 249 items, 92 contracts, 88 recipes, 41 enemies, 31 lore entries, 25 quest steps, 17 rooms, 16 locations, 16 voice cards, 9 skills, 8 squad members, 7 traders.
- **Review queue:** 3448 rows (3328 lines + 92 contract previews + 28 non-csv/meta rows).
- **Problems badge:** **16** (down from 363 in W2). Full breakdown of all 428 engine findings:
  - In **Problems (16):** `#5` impossible default-raid kill quests (2), `#7` name-word collisions (4), `#11` lexical title-vs-task mismatches (5), `#19` lore-vs-roster contradictions (5).
  - Outside the badge: **Coverage (322)** (`#15` item no-story 232 + `#8` entity STORY-TODO 90), **Other checks (65)** (`#3` 19, `#14` 6, `#16` 13, `#17` 27), **Too long (2)** (`#18`), **Dev TODOs (23)** (`#8` code).
- **Placeholder → final progress (V12, before session marks):** `0/3328 OK` overall:
  - **Traders:** 0 OK / 88 draft / 0 rewrite / 31 todo (119 text); art 0/7 (7 draft)
  - **Maps & locations:** 0 OK / 0 draft / 0 rewrite / 117 todo (117 text); art 0/16 (16 draft)
  - **Squad:** 0 OK / 55 draft / 0 rewrite / 40 todo (95 text); art 0/8 (8 draft)
  - **Items:** 0 OK / 0 draft / 0 rewrite / 250 todo (250 text); art 0/249 (249 draft)
  - **UI & system:** 0 OK / 282 draft / 0 rewrite / 2465 todo (2747 text); art 0/256 (254 draft, 2 placeholder)

**Verdict: PASS against the owner's intent.** The owner can now review every quest, quip, contract and UI line; mark OK, Redo (+ note) or Edit (+ rewrite) and commit straight to an EFI review branch that passes `review_pack.py --check` and `--apply`; jump cleanly between places, people, items and quests; catch real lore/roster and term-drift coherence bugs; see what changed since the last session; and track progress per area and per entity at both desktop and phone widths. Remaining gaps are polish and signal-tuning items for wave 4, not blockers.

---

## 1. Verdict per block

| Block | Verdict | Evidence & screenshots |
|---|---|---|
| **V6** Owner marks + badge fix | **PASS (with 1 bug)** | **End-to-end round trip verified:** Marked 5 Popper lines (2 OK, 2 Redo with notes, 1 Edit with rewrite) + 1 per-contract note (`k_doc_pmc_squad`), then clicked `End session (commit)` (`w1440-01c-review-popper-5marked.png`, `w1440-06b-contract-noted.png`). Commit `64d31456` landed on `storybook/review-2026-11-27` in a linked worktree (never `main`), regenerated the 8-file pack, passed `python3 tools/review_pack.py --check` (`review pack is up to date (8 files)`), and `review_pack.py --apply docs/review/text_review.csv` dry-run printed `[STORY-APPLY] applied=3 skipped_not_ok=304` (0 refused). Inline OK/Redo/Edit + arc-level `OK all`/`Redo all` also work inside Quests → Story arcs (`w1440-02a-quests-top.png`). **Badge fix landed:** Problems dropped 363 → **16** (`w1440-10a-problems.png`). **Bug:** leaving a per-contract note on 1 contract (`k_doc_pmc_squad`) inflated the `My marks` chip from `5` to `40` because 35 kill contracts share the `ContractSystem.gd` template row (`w1440-06b-contract-noted.png`). Minor: commit summary counted `OK (draft)` as `edit` (`1 OK, 3 redo, 2 edit` instead of `2 OK, 3 redo, 1 edit`). |
| **V8** What changed | **PASS** | **First visit:** Home leads with `"First session: everything is new — 3328 text rows at fc7a240c. Nothing is marked seen yet."` and `"Mark seen (up to fc7a240c)"` (`w1440-01-home.png`, `p390-01-home.png`). **After seeding last-seen at `76bb5d90`:** Home shows `"New / changed / gone since 2026-11-25 9:35 PM ET, 76bb5d90"` with `11 new · 0 changed · 21 gone`, explicit gone attribution (`Gone: 21 removed or rewritten in EFI`), `"Show gone rows"`, `"Review changes →"`, and `"Mark seen"` (`w1440-07c-home-changes-seeded.png`, `p390-07c-home-changes-seeded.png`). Clicking `"Review changes →"` opens Review filtered to `Changed 11`, tagging each row `NEW` (`w1440-07d-review-changed-seeded.png`). |
| **V10** Glossary + #16/#17/#19 | **PASS** | Glossary tab renders cleanly at 1440 and 390 (`w1440-08-glossary.png`, `p390-08-glossary.png`): seeded from `docs/narrative/VOICE_BIBLE.md` (read-only), player word `"runner"`, 5 canonical terms, 12 banned terms, `Only with findings` filter, `13 term findings (#16)` (`Scav` ×2, `Hideout` ×11) with `→ Review row` links, and `27 naming findings (#17)` (`exo_trooper` → `Heavy Trooper`, `bronze_sword` → `Crude Machete`, `cooked_shrimp` → `Boiled Crayfish`, etc.). **Check #19** automatically caught the exact W2 Sealed Vault contradiction (`bunker_warden` + `exo_trooper` named in vibe vs `[archive_trooper, records_keeper, strongroom_guard]` roster) plus 3 Railway Yard mismatches, visible both on the map sheet and in Problems (`w1440-03-world-sealed-vault.png`, `w1440-10a-problems.png`). |
| **V12** Progress bars | **PASS** | Home shows overall `0/3328 OK` + 5 area bars (Traders, Maps & locations, Squad, Items, UI & system) with text status segments and F4 art draft counts (`w1440-01-home.png`). Clicking any area opens Review pre-filtered to that area with an exact row match (`Maps & locations` → `117 of 3328 lines`, `Items` → `250 of 3328 lines`, `Traders` → `119 of 3328 lines`; `w1440-09b-progress-maps-click.png`). After our 5 Popper marks + 1 contract note, Home updated live to `3/3328 OK` (`Traders: 3 OK | 83 draft | 2 needs rewrite | 31 todo`, `UI & system: 1 needs rewrite`) (`w1440-01e-home-progress-after-marks.png`), and Popper's Cast sheet bar updated to `3 OK | 7 draft | 2 needs rewrite | 4 todo`. |
| **W3 riders** | **PASS (mostly)** | **Landed:** (1) Cast grouped into `TRADERS (7)`, `SQUAD (9)`, `SCREENS & SYSTEM (74)` (collapsed); (2) phone scroll-to-sheet works (`p390-04c-cast-fence-scroll.png`, Fence sheet at `y=151`); (3) Story arcs has a 7-trader jump bar, clickable task item/map/room chips, and inline OK/Redo/Edit (`w1440-02a-quests-top.png`); (4) Play order renders contract titles (`Deliver 48–94 × Bandage for Doc`) and partitions 57 ordered + 80 `"Unlock rule not in EFI data"` (`w1440-02e-play-order.png`); (5) Review search ranks exact speaker match first (`Doc 10` first), shows entity filter chips, updates `Story`/`Flavor`/`Toasts` chip counts to match search, puts title before story, and hides repeated in-group speaker chips (`w1440-05a-review-doc-clean.png`); (6) Home `Contracts` tile routes to Review `Contracts` scope and signal cards pre-filter their check ids. **Still open:** `Contracts 92` chip count ignores search/area filter; Cast/World sheet `Lines` still show raw `csv / inferred / STORY-TODO` chrome and don't reflect live V6 marks; Items `No story (#15)` still says `240` vs `#15` `232`. |

---

## 2. Per job: how-to, taps, and gaps (desktop 1440 and phone 390)

- **J1 Review Popper's arc and mark 5 lines, then end the session.**
  - **How (2 paths):**
    - *In place:* `Quests` → click `Popper 3` in the 7-trader jump bar → read all 3 steps inline and mark `OK / Redo / Edit` directly on each title/story card (or `OK all (6)` / `Redo all…`) (`w1440-02a-quests-top.png`).
    - *In queue:* `Review` → search `Popper` (or click `Popper trader` entity chip) → mark 5 rows (`OK`, `Redo` + note, `Edit` + rewrite) → click `End session (commit)` (`w1440-01c-review-popper-5marked.png`).
  - **Taps:** 2 taps to Popper's arc + 1 tap per OK (2 taps + note for Redo/Edit) + 1 tap `End session (commit)` at both 1440 and 390.
  - **Verified:** Commit `64d31456` landed on `storybook/review-2026-11-27`; Home progress moved `0/3328 OK` → `3/3328 OK` (`Traders: 3 OK | 83 draft | 2 needs rewrite | 31 todo`; `w1440-01e-home-progress-after-marks.png`).
  - **Gaps:** In Story arcs, clicking the trader name (`Popper`) on the card header navigates to Cast, while `Popper 3` in the top bar jumps to the arc — easy to confuse if scanning quickly. On an `Edited` row in Review, the `Edited` badge + action buttons wrap onto a centered second row (`w1440-01c-review-popper-5marked.png`).

- **J2 Find where a quest item comes from (`Brass Casing`).**
  - **How:** From `Quests` → `Popper 3` → click the live `Brass Casing` chip in step 1 (`deliver ×30 [Brass Casing]`), or `Items` → search `brass` → `Brass Casing`. Shows 4 sources (3 scavenge nodes + Customs Depot container loot) and 17 uses (recipes + quests).
  - **Taps:** 3 taps on desktop and phone.
  - **Gaps:** Node sources (`node: Debris Pile`, `Dumpster`, `Gun Store Counter`) are still dead text chips that don't show which maps hold those nodes. Quest uses still sit below 14 recipe ingredients. `Items` header still reads `No story (#15) 240` while `#15` has `232` findings.

- **J3 Check that Sealed Vault's text fits the map.**
  - **How:** `World` → `Sealed Vault` (`w1440-03-world-sealed-vault.png`).
  - **Taps:** 2 taps at 1440 and 390.
  - **Verified:** Sheet shows `4 draft | 8 todo | art 0/1 (1 draft)`, vibe, 3 enemy looks, roster (`Archive Trooper`, `Records Keeper`, `Strongroom Guard`), containers, 2 quests, 4 contracts, 12 text lines, and **2 `#19 lore vs roster` findings** flagging the exact `bunker_warden` and `exo_trooper` mismatch in `docs/PLAN_MAP_VIBES.md:60`.
  - **Gaps:** Contracts on the World sheet still display as raw ids (`x_fence_sealed_vault`, `k_doc_archive_trooper`, etc.) instead of rendered titles. The 12 text lines on the sheet still show `csv / inferred / STORY-TODO` chrome and the `STORY-TODO:` prefix.

- **J4 Find every line by one speaker.**
  - **How:** `Cast` → pick trader/squad chip (`TRADERS (7)` and `SQUAD (9)` sit right at the top; `SCREENS & SYSTEM (74)` is collapsed) → sheet scrolls into view on phone (`p390-04c-cast-fence-scroll.png`). Or click the entity's V12 progress bar on the sheet to jump straight to Review filtered to `Sheet: <name>`.
  - **Taps:** 2 taps at 1440 and 390.
  - **Gaps:** The Cast sheet `Lines` section still shows stale snapshot statuses (`DRAFT`, `STORY-TODO:`) even after live V6 marks are applied (its own progress bar right above it shows `3 OK | 7 draft | 2 needs rewrite | 4 todo`). Popper's Cast sheet still lists 16 lines and 8 sold items, but no contracts.

- **J5 Doc's lines vs Saint's lines.**
  - **How:** `Review` → search `Doc` (`w1440-05a-review-doc-clean.png`): `Doc 10` now ranks first, with entity chips `[Doc trader]` and `[Saint squad]` right above the list; clicking `Doc` filters strictly to Doc. Searching `Saint` returns `6 of 3448 rows`, all Saint.
  - **Taps:** 2–3 taps at 1440 and 390.
  - **Gaps:** Unfiltered substring search for `"Doc"` still returns 73 rows (including `Dockmaster's Badge`, `Documents`, `Thin the Docks`) until the user clicks the `Doc` entity chip — manageable now that `Doc` ranks first and the chip is one tap away. Saint's `name` row still reads `"Reyes"` (`DRAFT`), which the owner can now mark Redo/Edit in 1 tap.

- **J6 Review one contract and leave a per-contract note.**
  - **How:** `Home` → `92 Contracts` tile (or `Review` → `Contracts 92` chip, or search `k_doc_pmc_squad`) → read `"Eliminate 138–275 × PMC Squad for Doc · 7 c per kill · needs rep 0.3, Combat 20"` → click `Redo` → enter note → `Save note` → `End session (commit)` (`w1440-06b-contract-noted.png`, `p390-06b-contract-phone.png`).
  - **Taps:** 3–4 taps at 1440 and 390.
  - **Verified:** Note persisted on the `ContractSystem.gd` template row as `contract:k_doc_pmc_squad: ...` and survived `review_pack --write` / `--check`.
  - **Gaps:** Marking 1 contract inflated `My marks` from `5` → `40` (all 35 kill contracts sharing that template row). Contract rows still lack enemy and location navigation chips.

- **J7 "What changed since my last review" (V8).**
  - **How:** `Home` → top `Needs attention` card (`w1440-07c-home-changes-seeded.png`, `p390-07c-home-changes-seeded.png`) → click `Review changes →` to open Review on `Changed 11` (`w1440-07d-review-changed-seeded.png`), or `Show gone rows` to inspect the 21 removed/rewritten rows, or `Mark seen (up to fc7a240c)`.
  - **Taps:** 1 tap from Home to filtered Review queue (0 extra taps to read summary).
  - **Gaps:** None blocking. On first visit (`first: true`), `Changed` filter chip is rightly hidden until a baseline is marked seen.

- **J8 Glossary: spot a naming inconsistency (V10).**
  - **How:** `Glossary` tab (`w1440-08-glossary.png`, `p390-08-glossary.png`) → toggle `Only with findings` → immediately spots `Scav` (2 findings: lowercase `"scavs"` in `data/questlines.json:12` and `:50`), `Hideout` (11 findings: lowercase `"hideout"` in `data/recipes.json:278`, `wipe_dialog.gd`, `crafting_view.gd`, `settings_menu.gd`), plus 27 `#17` id↔display drifts (`exo_trooper` → `Heavy Trooper`, `bronze_sword` → `Crude Machete`, `cooked_shrimp` → `Boiled Crayfish`, `health_potion` → `Herbal Salve`). Click `→ Review row` to jump straight to the line and mark Redo/Edit.
  - **Taps:** 1–2 taps at 1440 and 390.
  - **Gaps:** Read-only (seeded from `VOICE_BIBLE.md` until EFI adds `docs/narrative/GLOSSARY.md`), so the owner can't add/approve a glossary rule from the tab yet.

- **J9 Progress: which area is furthest from final, click through (V12).**
  - **How:** `Home` → `Placeholder → final progress` (`w1440-01-home.png`). Instantly visible: **Items** (`250 todo`, 0 draft, 0 OK) and **Maps & locations** (`117 todo`, 0 draft, 0 OK) have zero drafted or OK'd lines (100% todo); **UI & system** has the largest remaining backlog (`2465 todo`, `282 draft`). Clicking `Maps & locations` opens Review with `Area: Maps & locations ×` (`117 of 3328 lines`, `w1440-09b-progress-maps-click.png`); clicking `Items` opens `250 of 3328 lines`; clicking `Traders` opens `119 of 3328 lines`.
  - **Taps:** 1 tap from Home to the exact area's Review queue at both 1440 and 390.
  - **Gaps:** On Home, area bars show counts (`117 todo`) rather than a percentage or `0/117` ratio, so comparing across areas of different sizes takes a quick mental glance.

- **J10 Problems badge — is everything in it something the owner must act on?**
  - **How:** `Problems 16` tab (`w1440-10a-problems.png`).
  - **Taps:** 1 tap.
  - **Audit of all 16 items:**
    - **7 genuinely actionable (44%):**
      - `2 × #5` (Broken): `broker_2` (`kill pmc_squad x10` impossible in 600s default raid) and `fence_3` (`kill armored_scav x10` impossible in 600s default raid).
      - `5 × #19` (Inconsistent, lore vs roster): Railway Yard vibe names `armored_scav`, `pmc_squad`, `scav` (not in roster); Sealed Vault vibe names `bunker_warden`, `exo_trooper` (not in roster).
    - **9 low-signal / noise (56%):**
      - `4 × #7` (info): `word "scav"` is a name and part of `Armored Scav` / `Depot Scav` / `Yard Scav` (intentional enemy family naming), `word "foreman"` (`The Foreman` / `Line Foreman`), `word "tank"` (`Tank Diver` / `Tank`), `name "wrench"` (item `Wrench` / squad `Wrench`).
      - `5 × #11` (info, `"lexical check only, low confidence"`): `Hired Guns`, `Boiled Rags`, `Pantry Run`, `Plated Problems`, `Steady Hands` — all 5 are strong idiomatic quest titles that intentionally don't repeat the raw task verb/noun.
  - **Verdict on J10:** Huge improvement from 363 → 16, but moving `#11` (low-confidence lexical) and `#7` enemy-family prefix matches out of the red `Problems` badge (into `Other checks`) would make `Problems` a razor-sharp **7/7 actionable** list.

---

## 3. W2 friction re-scored

| W2 # | Item | W3 | Evidence |
|---|---|---|---|
| 1 | No way to mark a line (OK/Redo/Edit) | **Fixed** | V6 OK/Redo/Edit + batch + session commit in Review & Story arcs; verified EFI round trip |
| 2 | Problems badge 363 (89% noise) | **Fixed (tuning left)** | 363 → 16; `#15` & entity `#8` moved to Coverage (322). 9 of 16 are still low-confidence `#7`/`#11` |
| 3 | Nothing says what changed | **Fixed** | V8 Changes card on Home + `Changed` Review filter + gone-row attribution |
| 4 | Cast flat wall of 90 + phone no-scroll | **Fixed** | Grouped `TRADERS`/`SQUAD`/`SCREENS & SYSTEM` (collapsed); phone scrolls sheet to `y=151` |
| 5 | Story arcs dead task items + no trader index | **Fixed** | 7-trader jump bar + clickable item/map/room chips + inline OK/Redo/Edit |
| 6 | Sealed Vault vibe vs roster unflagged | **Fixed** | V10 `#19` flags both Sealed Vault (2) and Railway Yard (3) on map sheet & Problems |
| 7 | Play order raw contract ids + unordered mix | **Fixed** | Rendered titles + 57 ordered / 80 `"Unlock rule not in EFI data"` partition |
| 8 | Filter chip counts ignore search | **Mostly** | `Story`/`Flavor`/`Toasts` update on search; `Contracts 92` still ignores search/area |
| 9 | Searching "Doc" pulls 73 rows across 9 entities | **Fixed** | Exact speaker `Doc 10` ranked first + 1-tap `Doc` entity chip filter |
| 10 | Home tiles mis-route; signal cards unfiltered | **Fixed** | `Contracts` → Review contracts; signal cards pre-filter checks. **New bug:** Cohesion card says `+47 more are Too long notes` when 45 are V10 `#16`/`#17`/`#19` |
| 11 | Story issues opens on `#4` + Saint/Doc `#7` | **Fixed** | `#4` moved to Other checks; Saint/Doc `#7` gone (replaced by `#17` in Glossary) |
| 12 | Items "No story" 240 vs `#15` 232 | **Open** | `Items` tab still displays `No story (#15) 240` vs engine `232` |
| 13 | Tall Review rows + story before title | **Fixed** | Title row first, compact rows, in-group speaker chip removed |

---

## 4. Phone-specific issues (390×844) & ranked remaining friction

**Phone-specific findings:**
- Zero horizontal overflow (`scrollWidth === 390`) on Home, Review, Quests, World, Cast, Items, Problems and Glossary (`p390-01-home.png`, `p390-01b-review-popper-phone.png`, `p390-06b-contract-phone.png`, `p390-08-glossary.png`).
- All Review marking controls (`OK`, `Redo`, `Edit`, `OK all`, `Redo all…`, `End session (commit)`) meet the 44 px touch-target floor (`h=44px`).
- **Phone chrome height on Review:** Between the top bar, 2-row tab bar, session bar, search box, wrapped filter chips and `Entities` chips, the first Review row is pushed below `y=820` on a 390×844 screen (`p390-01b-review-popper-phone.png`). Collapsing the session bar to a single compact line and collapsing filter chips behind a toggle when a search is active would bring the first 2–3 rows above the fold.

| # | Sev | Friction | Shot | One-line fix |
|---|---|---|---|---|
| 1 | major | Leaving 1 per-contract note inflates `My marks` from `5` → `40` (all 35 kill contracts sharing the template row) | `w1440-06b-contract-noted.png`, `p390-06b-contract-phone.png` | Count a contract preview as marked in `My marks` only when its own `contract:<id>` note exists (or the template row itself was directly marked without per-contract notes) |
| 2 | major | 9 of 16 `Problems` items are low-signal noise (`#11` low-confidence lexical titles ×5, `#7` enemy-family substrings like `"scav"` ×4) | `w1440-10a-problems.png` | Demote `#11` and same-family `#7` substring hits from `Problems` to `Other checks` so the red badge = 7/7 actionable |
| 3 | minor | Cast & World sheet `Lines` still show `csv / inferred / STORY-TODO` chrome, `STORY-TODO:` prefix, and stale statuses after V6 marks | `w1440-03-world-sealed-vault.png` | Render sheet line rows with the same live mark overlay and clean chrome as Review |
| 4 | minor | Home `Cohesion` signal card says `+47 more are Too long notes` when only 2 are `#18` and 45 are V10 `#16`/`#17`/`#19` | `w1440-01-home.png` | Split the footnote into `+2 Too long · +45 Glossary / lore` (or count `#18` only for "Too long") |
| 5 | minor | Phone Review pushes the first line row below `y=820` under stacked session + filter + entity chrome | `p390-01b-review-popper-phone.png` | Compact the session bar to 1 line on `≤600px` and collapse secondary filter chips behind a `Filters` toggle |
| 6 | minor | `Contracts 92` chip ignores active search/area filter; `Items` `No story (#15)` still says `240` vs engine `232`; World sheet contracts show raw ids | `w1440-09b-progress-maps-click.png`, `w1440-03-world-sealed-vault.png` | Compute `Contracts` chip count over the active filter; drop the client `#15` fallback; render contract titles on World/Cast sheets |
| 7 | minor | Commit summary counts `OK (draft)` as `edit` (`1 OK, 3 redo, 2 edit`); `Edited` row wraps action buttons centered | `w1440-01c-review-popper-5marked.png` | Track `action` vs pre-existing `DRAFT` rewrite in commit summary; keep `.sb-mark-actions` right-aligned on `Edited` rows |
| 8 | minor | Item node sources (`node: Debris Pile`) are dead chips; quest uses appear below 14 recipe ingredients | `w1440-02c-item-brass-sheet.png` | Show map location on node chips and sort quest/contract uses ahead of recipe ingredients |

---

## 5. What wave 4 should be (ranked by owner impact)

1. **V13 AI pre-review (`owner_note` suggestions on story + contracts, never OK).** Now that V6 marks and the session-commit loop work end-to-end, the biggest remaining time-saver for clearing 3328 rows (starting with the 276 story rows + 92 contracts) is pre-flagging weak lines and balance outliers (like `138–275 × PMC Squad for 7 c`) so Home leads with likely-bad lines the owner can Redo/OK in one tap.
2. **Fix `My marks` contract-template inflation + clean up `Problems 16` → `7` actionable (frictions 1 & 2).** Keep the owner's two highest-trust counters (`My marks` and `Problems`) 100% honest: per-contract notes shouldn't mark 34 sibling contracts in `My marks`, and `Problems` should only badge real breakage (`#5` ×2) and lore/roster contradictions (`#19` ×5), moving `#11` and enemy-family `#7` to `Other checks`.
3. **Phone Review above-the-fold density + compact session bar (friction 5).** Since the owner reviews in short phone sessions, collapsing the Review session bar + secondary filter chips on `≤600px` brings the first 2–3 markable lines onto the first screen without scrolling past 750 px of chrome.
4. **Live V6 marks & clean chrome on Cast / World / Item sheets + rendered contract titles on sheets (frictions 3 & 6).** Reading a trader or map sheet right after marking lines shouldn't contradict the sheet's own V12 progress bar or show `STORY-TODO:` prefixes and raw `x_fence_sealed_vault` contract ids.
5. **In-app "How to use" walkthrough + V7 final sign-off + small polish sweep (frictions 4, 6, 7, 8).** Ship the short in-app guide from `PLAN_STORYBOOK_V2` V7, fix the Cohesion `+47 Too long` footnote, align `Items` `#15` (`232` vs `240`), make `Contracts` chip count search-aware, and add editable Glossary write-back once EFI adds `docs/narrative/GLOSSARY.md`.
