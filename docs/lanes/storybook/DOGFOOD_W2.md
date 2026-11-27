# Storybook dogfood W2: wave 2 (V1.1, V3, V4, V5, V9) on real EFI data

I acted as the owner on `unit-sbv2-w2-push @ 88425caa`, built into `/tmp/sbdog2/dist`. The Storybook API ran from that tree against the real EFI repo (`/tmp/sbdog2/harness/srv.mjs`, port 4412, every non-GET returned 403, so the app stayed read-only; the server is stopped).
- EFI ref: `origin/main @ f3541fc9` (W1 was `66b3f037`/`204dc7ba`).
- Views: 1440x900 dark and 390x844 phone dark, every job at both sizes. Playwright with chromium-browser; no skips.
- Screenshots: `/tmp/sbdog2/shots/` (`w1440-*`, `p390-*`).
- Data at this ref: 3328 lines (W1 3617, after V1.1 dropped dev strings and twins), 92 contracts, 249 items, 25 quest steps, 388 findings. Review shows 3448 rows (lines plus contract previews).

**Verdict: FAIL against the owner's intent, as expected at this point.** The owner still can't mark a single line (V6) or see what changed (V8), and both are wave 3. **The wave-2 blocks themselves land: V1.1, V3 and V9 PASS, V4 and V5 are partial.**

Every "where is X / who said Y / does this fit" job now ends on the right sheet in 2-3 taps on desktop and phone. The biggest new problem: the **Problems badge got worse (153 → 363)**. 89% of it is item no-story #15 (232) plus STORY-TODO markers on entities (90).

## 1. Verdict per block

| Block | Fixed? | Evidence |
|---|---|---|
| **V1.1** Adapter follow-up | **Yes** | **System split:** System is split by screen: the Cast tab has 90 speaker chips (Raids 442, Items 250, Shell 191 …) instead of one 3295 blob (`w1440-13-cast-popper.png`). **Twins deduped:** Saint now has 6 rows and the "former paramedic" line appears once (`w1440-50-review-search-saint.png`). **Dev strings dropped:** #18 went from 9 to 2 and lines from 3617 to 3328. **Location links:** 141 lines carry `said_at` (W1: 25). Contracts link trader, enemy and location (`k_doc_pmc_squad` → doc, pmc_squad, harbor_district). **UX side effect:** the 90 chips are one flat wall sorted by count. The 7 traders sit between "Skill-System" and "Item-Sources", Popper is chip #40, and there are two "Squad" chips (93 and 51) plus an empty "System" chip. |
| **V3** Review queue | **Yes, with gaps** | **What works:** search over lines and entities ("popper" → 32 rows plus 4 entity chips). The queue is story-first (Story 276 / Flavor 861 / UI 2311) and grouped by speaker. Text is shown in full. Too long (2) and Dev TODOs (23) are separate scopes. "→ line" from Problems opens Review and flashes the row (row y=517 at desktop, 415 at phone; `w1440-71-toolong-line-jump.png`). Phone tabs wrap onto 2 rows, so nothing is clipped. **Gaps:** groups are alphabetical (Builder first), not in play order. Each step's story row comes before its title row. Each row is about 114 px, so 5 fit per desktop screen, and the speaker chip repeats on every row inside its own group. The filter chip counts ignore the search: "Story 276" sits above a "Story 43" section (`p390-50-review-search-doc.png`). On the phone the first row starts around y=720 under about 600 px of chrome. |
| **V4** Sheets, navigation, Items | **Partly** | **What works:** item, map, character and enemy sheets exist. Brass Casing shows 4 sources and 17 uses, and Customs Depot opens the World sheet (`w1440-23`, `p390-24`). The Quest web "Brass Casing" chip opens Items. All 14 Home tiles and the 4 signal cards are clickable. **Gaps:** some tiles land in the wrong place: Contracts → Quests, Skills → Quests, Art Slots → Cast. The signal cards open unfiltered Problems (Integrity 13 → "Problems 363"). The step task text in Story arcs ("deliver ×30 brass casing") is not a link (`w1440-22`). Node sources ("node: Debris Pile") are dead chips. On the phone, tapping a Cast chip leaves the sheet 1648 px below the viewport with no scroll. **#15 is noise:** it flags 232 of 249 items (93%), and the Items tab says 240 because `storybookLogic.ts:647` applies its own fallback rule. |
| **V5** Arcs and play order | **Partly** | **Story arcs is the best owner surface in the app:** each step shows its title, story, "after X · needs map Y" and a "Review row →" link, and it reads well on the phone (`p390-11-quests-arc-popper.png`). The Mermaid apostrophe is fixed ("Someone Else's Gear" renders). **Play order** is a list of raw ids (`d_builder_oak_log`, `k_fence_signalman`) rather than the rendered contract titles (`w1440-80-play-order.png`). 40 of 137 entries are unordered, 3 traders show "unlocked (rule not in data)", and The Broker's "Fine Tolerances" lands at #21 "from the start". |
| **V9** Contract previews | **Yes** | All 92 contracts render as rows: "Eliminate 138–275 × PMC Squad for Doc · 7 c per kill · needs rep 0.3, Combat 20" (`w1440-61-review-contract-row.png`). It already surfaces a balance question the owner would want to see (138–275 PMC kills for 7 c). **Gaps:** a row shows only the trader chip, though the data carries enemy and location links. Contract rows have no status, so V6 needs a mark target for them. |

## 2. Per job: how-to and gaps (desktop 1440 and phone 390)

- **J1 Review Popper's arc and mark 5 lines.**
  - **How:** Quests → Story arcs → scroll to Popper. All 3 steps show title and story inline. "Review row →" opens Review with that row flashed (`w1440-11`, `w1440-12`). The alternative: Review → search "popper" gives 32 rows: 10 story, 6 quips, his contracts, and Mechanic's lines that mention him (`p390-10`).
  - **Got to:** reading all 16 lines plus 5 contracts. **Marking: 0 of 5**, because there are no OK/Redo/Edit controls anywhere (0 matching buttons).
  - **Where the owner wants the button:**
    1. On each Review row as a right-edge OK / Redo / Edit trio. The phone needs a swipe or a 44 px trio.
    2. Beside each "Review row →" in Story arcs, so a whole arc is reviewed in place.
    3. As an arc-level "OK all 6 / Redo all" header on the Popper arc card and on the Review group header.
  - **Gaps:** Story arcs has no jump index to a trader (Popper is the 5th of 7; on the phone that means scrolling past Builder, Doc, Fence and Mechanic). Popper's Cast sheet lists 16 lines but no contracts.
- **J2 Find where a quest item comes from.**
  - **How:** Items → search "brass" → Brass Casing. It has 4 sources (3 scavenge nodes plus Customs Depot container loot), and its uses list Spent Brass and Make It Right (`w1440-23`, `p390-23`). The Quest web chip also gets there (`w1440-82`). 2-3 taps on both widths.
  - **Gaps:**
    - Story arcs, where the owner reads the quest, shows the item as plain text.
    - The node sources don't say where the node is.
    - The quest uses are listed after 14 recipe ingredients.
    - No sheet says "obtainable before this quest unlocks?" (#13 is 0 for every item, so it can't answer that).
- **J3 Check that Sealed Vault's text fits the map.**
  - **How:** World → Sealed Vault. The sheet shows the vibe, 3 enemy "looks", roster with spawn windows, containers, The Broker #3/#4, 4 contracts and 12 text lines (`w1440-30`, `p390-30`).
  - **What the owner would catch:** the vibe says "Roster: shares exo_trooper + bunker_warden with the Bunker, so no new sprites", but the roster is archive_trooper / records_keeper / strongroom_guard. Also an extreme map has "No boss assigned".
  - **Gaps:** the sheet reports **0 findings**. No check compares lore or vibe text against the roster.
- **J4 Find what changed since last session.** Nothing exists.
  - The only trace is the ref chip "origin/main @ f3541fc9", whose tooltip gives the generated time and is not clickable (`w1440-40-home-ref-click.png`).
  - Between W1 and W2, EFI moved 3 commits and Storybook lost 289 lines. The owner can't tell which lines went or which are new.
- **J5 Doc's lines vs Saint's lines.**
  - **How:** Review search "Saint" gives 6 rows, all Saint. Cast → Doc / Saint chips open separate sheets (`w1440-51-cast-*`).
  - **Gaps:**
    - Search "Doc" returns 73 rows across 9 entities (Saint, The Dockmaster, Documents, Thin the Docks …), because the match is a substring and Saint's id is `doc` (`p390-50-review-search-doc.png`).
    - Saint's sheet still shows #7 "id doc is used by squad + trader".
    - Saint's name row reads "Reyes" with a DRAFT tag; the owner would ask whether that is the real name.
- **J6 Review one contract as the player sees it.**
  - **How:** Review search "k_doc_pmc_squad", or open the "Contracts · Doc" group under Flavor & quips (`w1440-61`, `p390-61`). The rendered title and detail match the `ContractSystem.gd:722` template.
  - **Gaps:**
    - Contracts are filed under "Flavor & quips" with no "Contracts" filter chip.
    - The Home "Contracts" tile goes to Quests instead.
    - Rows have no enemy or location chips.
    - The row can't be marked.

## 3. W1 friction re-scored

| W1 # | Item | W2 | Evidence |
|---|---|---|---|
| 1 | #18 invisible | **Fixed** | Too long scope (2), rows flash on jump |
| 2 | Review not a queue | **Partly** | Story-first, grouped, searchable, full text. Groups are not in play order and rows are tall |
| 3 | Problems badge noise | **No, worse** | 153 → 363. Only 23 .gd TODOs moved out; the 90 entity #8 and 232 #15 inflate it |
| 4 | "→ line" lands at the top | **Fixed** | Opens Review and flashes the row |
| 5 | Dead chips and tiles | **Mostly** | Chips navigate. 3 tiles mis-route, signal cards are unfiltered, task text and node chips are dead |
| 6 | Phone tab clip | **Fixed** | Tabs wrap onto 2 rows (`p390-10`) |
| 7 | Home counts disagree | **No** | Coverage 232 vs Missing 322, Integrity 13 vs Broken 2, Cohesion 30 vs Inconsistent 39, Sign-off 4216 vs Text to review 3327 |
| 8 | Story issues has diagnostics plus the Saint/Doc #7 | **No** | 4 #4 adapter rows lead the list; #7 Saint/Doc is still there (`w1440-70-problems-story_issues.png`) |
| 9 | Line chrome | **Partly** | Review rows are clean. Cast and World line rows still show csv / inferred / STORY-TODO tags and the "STORY-TODO:" prefix (`w1440-51-cast-doc.png`) |
| 10 | Saint duplicate; Cast one wall | **Partly** | Dedupe is fixed; the wall grew to 90 ungrouped chips |

## 4. Friction, ranked

| # | Sev | Friction | Shot | One-line fix |
|---|---|---|---|---|
| 1 | blocker (W3) | No way to mark a line (OK/Redo/Edit) anywhere | `w1440-12-arc-reviewrow-jump.png` | V6: a row trio in Review plus the Story-arcs step, and arc/group batch OK |
| 2 | major | Problems badge is 363, and 89% of it is #15 item no-story plus entity STORY-TODO markers | `w1440-02-tab-problems.png` | Move #15 to the Items tab only (a coverage stat) and #8 entity markers to Text to review; badge = broken + story issues (≈41) |
| 3 | major | Nothing says what changed: EFI moved and 289 lines vanished silently | `w1440-40-home-ref-click.png` | V8: a "New / changed / gone since <sha>" bucket at the top of Home |
| 4 | major | Cast is a flat wall of 90 count-sorted chips; traders are buried, there are 2 "Squad" chips, and on the phone the sheet opens 1648 px below the tap | `w1440-13-cast-popper.png`, `p390-13-cast-popper.png` | Group as Traders / Squad / Screens (collapsed) and scroll the sheet into view on select |
| 5 | major | Story arcs, the best reading surface, has a dead task item ("deliver ×30 brass casing") and no trader index | `w1440-22-arc-spent-brass-step.png`, `p390-11` | Link the task item, enemy and map in the arc step; add a 7-trader chip row at the top |
| 6 | major | Map text vs roster contradiction (Sealed Vault vibe vs roster) is not flagged; the sheet shows 0 findings | `w1440-30-world-sealed-vault.png` | New check: roster ids named in the vibe/lore must match the location roster |
| 7 | minor | Play order shows raw contract ids; 40/137 entries are unordered | `w1440-80-play-order.png` | Use `data.rendered.title`; group the unordered entries under "rule not in data" per trader |
| 8 | minor | Filter chip counts ignore the search (Story 276 above a Story 43 section) | `p390-50-review-search-doc.png` | Count chips over the search result |
| 9 | minor | Searching "Doc" pulls in Saint, the Dockmaster and Documents (73 rows) | `w1440-50-review-search-doc.png` | Rank exact speaker/entity name matches first; the entity chip filters to that speaker |
| 10 | minor | Home tiles mis-route (Contracts / Skills → Quests, Art Slots → Cast); signal cards open unfiltered Problems | `w1440-01-home.png` | Contracts → the Review contracts scope; signal cards pre-filter their category |
| 11 | minor | Story issues still opens on 4 #4 adapter diagnostics plus the #7 Saint/Doc collision | `w1440-70-problems-story_issues.png` | Route #4 to warnings; skip #7 when the kinds differ |
| 12 | minor | Items "No story" 240 vs #15 232 | `w1440-23-item-brass-sheet.png` | Drop the client fallback at `storybookLogic.ts:647`; trust the engine |
| 13 | minor | Review rows are about 114 px with the speaker chip repeated inside its own group; story comes before title | `w1440-02-tab-review.png` | Compact rows: drop the in-group speaker chip, show the title row first |

## 5. Reshape for wave 3

- **V6 marks: the core of wave 3, ship it first.**
  - **Put the controls where the owner reads:** an OK / Redo / Edit trio on Review rows and on each Story-arcs step (title and story), with keys 1/2/3 on desktop and 44 px buttons on the phone.
  - **Batch:** "OK all" on a Review group header and an arc card. That is how the owner clears 2311 UI rows.
  - **Contract rows need a mark target:** they have no csv status today. Key them as `contract:<id>` in `text_review.csv`, or mark the template row they render from.
  - **"My marks" filter** plus a progress line per group ("Popper 4/16 reviewed").
- **V8 changes: give it a spot on Home before anything else.** Show "New / changed / gone since your last session" as the first Needs-attention card, with a Review filter. Store the last-seen sha per project. The silent 3617 → 3328 drop is exactly the case it should explain.
- **V10 glossary:** keep it lean. Fold the Doc/Saint naming case (a squad id that collides with a trader name) into #17 instead of #7. Also add a lore/roster consistency rule (friction 6), because naming and map facts are the same "does the text agree with the data" family.
- **V12 progress:** reuse V6 marks as the text half of the bar ("reviewed / total" per arc, map and trader on the sheets). Don't build progress before V6, since every bar would read 0%. Put the badge fix (friction 2) in this block: Problems = broken + story, while coverage (#15, art) becomes V12 bars instead of a red badge.
- **V13 AI pre-review: after V6 lands.** Its `owner_note` suggestions need the V6 row UI to show and accept them. Start with the 276 story rows plus the 92 contracts (balance calls like 138–275 kills are good first catches).
- **Small riders:**
  - Cast grouping plus scroll-to-sheet (friction 4).
  - Live task and item links in Story arcs (5).
  - Rendered titles in Play order (7).
  - Search-aware chip counts (8).
  - Home tile routing (10).

  Each is about a 1-file fix. Ride them with V6 (Review/arcs) and V12 (Home).
