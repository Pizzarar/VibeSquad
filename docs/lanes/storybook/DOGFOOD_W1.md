# Storybook dogfood W1: wave 1 (V1, V2, V11) on real EFI data

I acted as the owner on master `a6e4f3a7`, built into `/tmp/sbdog1/dist`. The Storybook API ran from that tree against the real EFI repo (`/tmp/sbdog1/harness/srv.mjs`, port 4411, POST requests blocked, so the app stayed read-only).
- EFI ref: `origin/main @ 66b3f037`, which became `204dc7ba` partway through the session because EFI's origin moved. The counts below did not change.
- Views: 1440x900 dark and 390x844 phone dark.
- Screenshots: `/tmp/sbdog1/shots/`.
- Data at this ref: 3617 lines, 162 findings, 25 quest steps, 249 items.

## 1. Verdict per block

| Block | Gap ids | Fixed? | Evidence |
|---|---|---|---|
| **V1** Speaker and link identity | J1-1, J1-3, J3-1, J3-2, J3-3 | **Partly** | **J3-1 yes:** Saint (11 lines) and Doc (22) are now separate chips (`w1440-05-cast-Saint.png`, `-Doc.png`). **J3-2 yes:** 18 chips and no duplicate empty chips. **J1-1 partly:** every line now has a speaker, but 3295 of 3617 (91%) are inferred as "System". The Cast tab moved the blob; it did not split it. Traders only gained the 14 `trader_relations` rows. **J3-3 partly:** `said_at` is set on 25 of 3617 lines (quest steps only). The Open card popover now shows an Area breadcrumb ("armory page > armory_view > (file scope)", `w1440-04-review-opencard.png`), which is the most useful new context. **J1-3 no:** "→ line" still opens Cast → System at the top (scrollY 0, `w1440-04-review-linejump.png`). The jump never scrolls to the row (`StorybookView.tsx:539`), so it lands at the top of a 3295-line list. |
| **V2** Home and the Findings split | J0-1, J0-2, J4-2 | **Partly** | **J0-1 yes:** Home lands on "Needs attention" with counts (`w1440-01-home.png`). **J0-2 partly:** Review and Problems are now separate tabs. But 113 of Problems' 153 (74%) are #8 "STORY-TODO comment in X.gd" code markers, so the badge is still mostly noise, and the default list still opens on VOICE_BIBLE regex drift (`w1440-02-tab-problems.png`). **J4-2 partly:** the Story issues filter (14) exists, but 4 of its 14 are #4 adapter diagnostics ("0 rows inferred a speaker from the data path"), and #7 still flags Saint/Doc even though V1 fixed that. **Dead ends:** on Home, the 4 audit signal cards and 8 of the 14 "What is in here" tiles (Items, Contracts, Enemies, Recipes, Lore, Art, Rooms, Skills) are not clickable (`StorybookHome.tsx:34,50`). **Counts disagree on one screen:** Cohesion 42 vs Inconsistent 38, Integrity 7 vs Broken 2, Sign-off 4419 vs Text to review 3508. |
| **V11** #18 fits on screen | (new) | **No, as seen by the owner** | The engine emits 9 #18 findings, but `findingCategory()` (`storybookLogic.ts:64-75`) has no `#18` case, so they are dropped. No tab, filter, or badge shows them, and the "too long" filter was never built. Also, 5 of the 9 are developer validation strings ("Item '%s' has category '%s' but defines…"), not player text. Only 1 real hit stands out: "Hardcore Mode…" at 244 chars against a label cap of 60. |

## 2. Per job: what the owner can do now, and what they still can't

- **J0 Orientation:**
  - **Can:** land on Home, see what's there, and pick Problems, Story issues or Text to review.
  - **Can't:** tell what to do first. The 153 Problems are mostly code comments; the 4 audit cards don't open; Items, Contracts and Enemies can't be opened from Home.
- **J1 Review every line:**
  - **Can:** read Review top to bottom, and see each row's Area in its popover.
  - **Can't:**
    - Work through it as a queue: no search, no grouping, no next/OK, and no progress.
    - Reach the story early. Review is in file-path order, so the first story row is #578 and the first questline row is #3141 of 3508. Only 247 rows (7%) are story; 2338 (67%) are UI.
    - Read long lines in full: rows are cut at 90 chars (`storybookLogic.ts:111`).
    - Avoid the chrome: every row repeats "STORY-TODO:" plus csv/info tags, about 4 rows per phone screen.
- **J2 Mark redo or edit:** still impossible (V6 is in wave 3).
- **J3 Links:**
  - **Can:** find all of a trader's text in Cast (Popper 22: relations, encouragement and quest rows). Saint is no longer mixed into Doc's lines. A quest step shows "spoken by Popper · said at Harbor District".
  - **Can't:**
    - Go anywhere from those chips. Popper and Harbor District open a popover, not the Cast or World sheet (`w1440-06-quests-loc-jump.png`). "Said at" and "at location" repeat the same chip.
    - See Popper's contract templates (`x_popper_*`) in his line list.
    - Avoid duplicates: Saint lists "A former paramedic…" twice (the squad.json entity plus the csv row).
- **J4 Coherence:** unchanged. There is one trader chain at a time, the Mermaid diagram still drops apostrophes ("Someone Else s Gear"), and there is no arc view.
- **J5 Quest items:** unchanged. The Items tile on Home is dead and there is no Items tab. "Brass Casing" opens only the thin popover.

## 3. Friction, ranked

| # | Sev | Friction | Shot | One-line fix |
|---|---|---|---|---|
| 1 | major | #18 too-long findings are invisible in the UI | (none; data only) | Add `#18` to `findingCategory` as its own "Too long" filter in Problems, and drop `push_error`/assert strings from the inventory |
| 2 | major | Review is not a queue: file-path order, no search or grouping, story only starts at row 578 | `w1440-02-tab-review.png`, `p390-02-review.png` | Sort by V1's `rowClass` (story > flavor > ui) and group by `data.group`. This is V3 and it should come first |
| 3 | major | The Problems badge (153) is 74% #8 code-comment TODOs | `w1440-02-tab-problems.png` | Move #8 .gd-comment hits out of Problems into a "Dev TODOs" chip; badge only story and integrity findings |
| 4 | major | "→ line" lands at the top of System's 3295 lines | `w1440-04-review-linejump.png` | Scroll to and highlight the row. Better: open it in V3's Text view and stop routing to Cast |
| 5 | major | Link chips are dead ends (trader and location chips open a popover only); 8 Home tiles and the 4 signal cards are not clickable | `w1440-06-quests-loc-jump.png`, `w1440-01-home.png` | Make every chip navigate to its tab/sheet (V4), and make every Home number a link |
| 6 | major (phone) | The Problems tab, the one with the badge, is clipped off-screen at 390 (x=361, w=124) | `p390-01-home.png` | Wrap the tabs, or put Problems second, or make the overflow visible with a fade/arrow |
| 7 | minor | Home counts disagree: Cohesion 42 vs Inconsistent 38, Integrity 7 vs Broken 2, Sign-off 4419 vs 3508 | `w1440-01-home.png` | Label the signal cards as a different measure or derive them from the same set; make them open their list |
| 8 | minor | Story issues includes 4 adapter diagnostics and the now-fixed Saint/Doc #7 | `w1440-03-bucket-Story_issues.png` | Route #4 "rows inferred" to warnings; drop the #7 id collision when the kinds differ |
| 9 | minor | Line chrome: "STORY-TODO:" prefix, csv/inferred/DRAFT tags, about 90 px for a 1-word line; the System voice card shows raw regexes | `w1440-05-cast-Saint.png`, `p390-02-cast.png` | One compact row per line with a status dot (V3) |
| 10 | minor | Saint has a duplicated line; Cast mixes traders and squad in one undifferentiated wall | `w1440-05-cast-Saint.png` | Dedupe by text and source; group Cast as Traders / Squad / System |

## 4. Wave 2 reshape

- **V3 first and widest.** It is the real Review: a story-first queue sorted by `rowClass`, grouped by the `group` / Area breadcrumb, with search and no truncation. Fold in fixes 1, 3 and 4: a "Too long" filter, moving #8 code TODOs out of Problems, and "→ line" opening the row in Text. With V6 marks this is the owner's core loop, so ship V3 before V4, V5 and V9 if there's capacity for only one.
- **V4: make link chips navigate before building rich sheets.** That is a cheap win on every tab. Item sheets plus #13-#15 matter (J5 is untouched), but defer the art slot and progress-bar parts of the sheets to V12. Also wire up the dead Home tiles.
- **V5: keep it, but lean.** An inline story column per trader plus a play-order list covers J1-2 and J4-1. Skip a Mermaid timeline (it still mangles apostrophes).
- **V9: cut to contracts only, and merge it into V3 rows.** The 92 contract templates are the trader text the owner can't see today. Previewing `%s` toasts has low value while 5 of 9 #18 hits are dev validation strings: first exclude `push_error`/assert/validator strings from the inventory (an adapter fix in V1's follow-up), which also shrinks Review.
- **Add a small V1.1 adapter follow-up:**
  - Split "System 3295" by screen (use `data.group`) in Cast.
  - Dedupe entity and csv twin rows.
  - Fix the phone tab clip (cheap; ride in V3).
