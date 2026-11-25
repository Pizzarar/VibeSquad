FAIL 0/2/1 6fbcf4f7
- M1 (new, latent since r1, exposed by r3) src/boring.css:1487: `.boring-project-line { position: relative }` overrides the Main header's `position: sticky` at :1477. Now that the pin scrolls inside, the header (name, Open, ⋯) scrolls out of the pin. At 1280×720, Ctrl+J into a Main worker leaves the header hidden (it was visible in R33c).
- M2 (regression of R33c's 4K pass) src/boring.css:1471/1475: at 3200×1800, with Main expanded and another project expanded in the tree, the pin shrinks to 459px and scrolls 213px of Main's lanes inside it. R33c gave it its full 692px.
- m1 src/boring.css:1471: at 720 the collapsed pin of the active Main project has a 58px floor for a 60px box, so it clips by 2px and scrolls 2px under the wheel.

# UX review R33d: PLAN_PROJECT_ORDER O1+O2 fix round 3 (Normal sidebar), narrow re-check

**Build:** `unit-ui-project-order` @ `6fbcf4f7` (CSS + test only vs c04dd4c4), vite dev on :5442. **Baseline:** merge-base checkout /tmp/ux-po/master on :5443.
**Setup:** the R33c drivers unchanged (`m.mjs`, `mchev.mjs`, `chev2.mjs`), plus `r4.mjs` (header, selected row and pin-scroll visibility), `fx.mjs` (the same measurements with a candidate fix injected) and `crops.mjs` (masked crops). All are in /tmp/ux-po4/drv/ with raw JSON next to them. Playwright + Chromium, `?demo`. Non-GET `/api/teams` is stubbed, so 0 writes reached the registry. There were 0 page errors. Viewports: 3200×1800@1.2, 1920×1080 and 1280×720, dark and light.
**Naming:** projects are called "the hub project" (the one Ctrl+J lands in) and "the second project". Crops mask every project name as "Project X".
**Not re-flagged (lead decisions):** m4 bust, no reorder on phone, the sidebar scrolling at 720.

## Status vs R33c
| R33c | Now | Evidence |
|---|---|---|
| M1: 1080 footer pushed off screen when Main expands | **Fixed** | 1920×1080, dark and light are identical (`m.json`). Second project as Main, expanded: the pin is 572+220 and shows 218 of its 670px of content. The tree is at 800+178 (about 5 rows, on screen) and the **footer is at 986** with the sidebar at 1080/1080. Hub as Main after Ctrl+J or Open: the pin is 330px (shows 328 of 833), the tree 910+68 and the **footer at 986**. Master is 986. No nested box sits below the fold any more. |
| m1: Main header drops on expand | **Fixed** | The Main chevron stays at y 584 → 584 at 4K and 1080, and 600 → 600 at 720. 9/9 real clicks toggle at all three sizes, and the Main row has no grip (`mchev.json`). |
| 720: full header, expanded lanes, sidebar scrolls | **Pass** | Collapsed Main: the header (589–645 or 647) is fully visible. Expanded: a 220px pin with its lanes scrolling inside, and the sidebar scrolls (982/720), as briefed. |
| 720: Ctrl+J header stays visible | **Regressed → M1** | After Ctrl+J the pin is at 501–721 and auto-scrolled 99px to show the selected worker row (688–720, visible). The header line sits at **403–461, above the pin's top edge (501), so it is hidden** (`r4.json` 720d/720l `ctrlj`). R33c had it visible at y 391. Crop: `720d-ctrlj-pin.png` shows cards and no name, Open or ⋯. |
| 4K: footer 1706 | **Pass** | 1706 in every state, the same as master. |
| 4K: lanes don't scroll in the pin | **Regressed → M2** | The hub as Main (Ctrl+J/Open) gets 835px with no inner scroll. The second project as Main, expanded while the hub project is open in the tree, gets **459px for 670px of content (scrollHeight 670 / clientHeight 457)**, and the tree gets 659/967. R33c: 692px with no inner scroll. If the tree's open project is collapsed, the pin returns to its full 672px. |
| Grip vs chevron | **Pass** | Grip at x 13, 7px wide; chevron at x 21, 16px wide; 0 overlap at every size. In the 21-point real-click sweep, non-Main rows give **the same result as master, point for point**, at 4K, 1080 and 720 (`chev2.json`). The grip never appears in a miss. |
| Rows with no Main = master | **Pass** | Row and name geometry are identical (`rowsEq true`) at every size and in both themes. |
| Invariants | **Pass** | Exactly one `.on` row in every state. The breadcrumb matches the open agent: Open gives second project › Desk › RiffBot, and Ctrl+J gives hub › Desk › Worker with `agent=demo-aud`. |
| Dark / light | **Pass** | Light numbers are identical to dark everywhere. The accent frame and header are legible in both (`1080l-main-expanded.png`, `720l-ctrlj-pin.png`). |
| ui:clicks | **Pass** | 0 unique hits (below). |

## Findings

### M1 (major): the Main header is not sticky, so it scrolls out of the pin. Job: working inside the Main project (which project am I in, and reach Open and ⋯) and answering a Needs-you item via Ctrl+J.
Evidence (`r4.json`, dark and light are identical):
- 1280×720, hub as Main, then Ctrl+J: the pin is at 501–721 with scrollTop 99, and the header line is at **403–461, outside the pin**. `headerVisible: false`. Crop: `720d-ctrlj-pin.png` (and `720l-`).
- 1920×1080, after scrolling the pin to its bottom (scrollTop 505): the header line is at y 68, far above the pin top (572), and is hidden. Crop: `1080d-pin-scrolled.png` shows lanes with no Main name, Open or ⋯ above them.
- Cause: the DOM chain is `.boring-conv-line.boring-project-line.boring-main-line` → `.boring-project-block.open` → `.boring-main-pin` (overflow auto), and its computed `position` is **relative**. `src/boring.css:1487` `html[data-vibe="boring"] .boring-project-line { position: relative; }` (added in r1 7f436c1f for the grip) has the same specificity as `:1477 .boring-main-line { position: sticky … }` and comes later, so it wins. This was latent in r1/r2 because the pin did not scroll then. r3 made the pin a scroller again (as briefed), which exposed it.
- Fix: `html[data-vibe="boring"] .boring-main-line.boring-project-line { position: sticky; }`, or scope :1487 to `:not(.boring-main-line)`. **Verified by injection** (`fx.json`): the 720 Ctrl+J header is at 502–560 inside the pin (501) and visible, and the selected row is still visible. At 1080 the header stays at 573 with the pin scrolled 557. Crop: `720d-withfix-ctrlj-pin.png`, `1080d-withfix-pin-scrolled.png`. Add a source test that the main line's computed position is sticky, or at least that no later same-specificity rule sets `position` on `.boring-project-line` without excluding the main line. Files: boring.css, test/project-order.test.mjs. Effort: XS.

### M2 (major): at 4K, an expanded Main scrolls its lanes inside the pin when another project is open. Job: monitoring the Main project's lanes on the owner's main display while a second project is open.
Evidence (`m.json` / `r4.json`, 4kd and 4kl `efiExp`): the pin is 572–1031 with scrollHeight 670 and clientHeight 457, so 213px of Main's lanes sit in a nested scroller. The tree is 659/967, a second scroller. The footer is 1706 (fine). The lead's regression check and the fix brief both required "4K unchanged (lanes don't scroll inside the pin)". R33c measured 692px with no inner scroll. Combined with M1, scrolling that pin also hides its header. Crop: `4kd-main-expanded.png` vs `4kd-withfix-main-expanded.png`.
Cause: `:1471` `flex: 0 1 auto` on the pin, with the tree also at basis auto (its content, 967px). Flex shrinks both in proportion to their content (672 : 967), so the pin gives up about 210px even though the tree could absorb it all. R33c's suggested fix assumed the tree would yield first. It doesn't.
Fix: give the tree a zero basis when a pin is present, so it only takes what is left and the pin shrinks only once the tree reaches its floor: `html[data-vibe="boring"] .boring-main-pin ~ .boring-project-tree { flex-basis: 0; min-height: 120px; }` (`:1475`). **Verified by injection** (`fx.json`, with M1's fix and m1's fix):
- 4K: the pin is 672 (670/670, no inner scroll) and the tree 446. The hub as Main is unchanged at 835.
- 1080: the footer is at 986. The pin is 278 (276 visible) and the tree 120 (about 3 rows, on screen).
- 720: the header and selected row are visible. The sidebar scrolls 1038/720 instead of 982/720 because of the 120 floor. If the lead wants 720's scroll length unchanged, keep the floor at 64: 1080 then gives about a 342px pin with a 64px tree (R33b's numbers).

Files: boring.css, test/project-order.test.mjs. Effort: XS.

### Minor
- **m1:** at 1280×720 the collapsed pin of the *active* Main project (after Open or Ctrl+J, when its header row carries the selection) is h 58 with scrollHeight 58 and clientHeight 56. It clips 2px and becomes a 2px scroller (`scrollTop = 10` → 2). At 1080 and 4K it gets 60px and is fine. Nothing readable is lost (`zoom-720d-main-active-collapsed.png`), but the wheel over the header nudges it. Cause: `:1471` `min-height: 58px` is the content height, but the 1px top and bottom borders need 60. Fix: `min-height: 60px`, verified in `fx.json` (720 `openCol` 58/58, scrollTop stays 0). Effort: XS.

## Guards
- **`npm run ui:clicks -- --vibe boring --surfaces boring-home,boring-lead,boring-brainstorm,boring-overview,boring-settings`** (foreground, R33c's environment: TMPDIR under $HOME, PLAYWRIGHT_DIR=/tmp/pwtool/node_modules, system Chromium): **PASS, 0 unique hits**. 2002 hit-tests, 40 popovers, 120 triggers, 0 skipped, 289s. 1080, 4K and 1280 have 0 mismatches and 0 clipped in both themes, and mobile/boring has 0 controls, the same as R33c. Report copy: /tmp/ux-po4/guards/ui-clicks-unit.md. Note that ui:clicks does not scroll the pin, so it cannot see M1.
- **Cleanup:** removed the worktree's `scratch/ui-clicks` and the temp profile dir. The pre-existing `scratch/{h1c-v4,h1e,overlord-v4,shots}` were left alone. Both vite servers are stopped. `git status` in the worktree is clean at 6fbcf4f7. Nothing was written to the repo.

## Owner decisions
None. M1 and M2 are misses of requirements already in the brief. The 64 vs 120px tree floor under M2 is a lead call within the decided 720 sidebar scroll.

## Not done
- Phone and touch drag weren't re-measured. They're out of scope for this CSS-only round, and the r3 diff touches neither the grip nor the phone picker.
- The 4K Ctrl+J into a worker deep in a *scrolling* pin wasn't exercised, because the hub-as-Main pin doesn't scroll at 4K.
