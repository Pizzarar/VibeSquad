FAIL 0/1/1 c04dd4c4
- M1 (new, regression of R33b's 1080 result) src/boring.css:1471: with the pin at `flex: 0 0 auto` and no inner scroll, an expanded Main at 1920×1080 pushes the footer from 986 to 1344–1507px (sidebar 1438–1601/1080). The other projects end up in a 64px inner scroller below the fold. The fix brief required "footer matches master" at 1080.
- m1 src/boring.css:963: the Main header drops 9px when Main expands (chevron y 584 → 593), so the row jumps under the cursor. Cosmetic: every click still toggles.

# UX review R33c: PLAN_PROJECT_ORDER O1+O2 fix round 2 (Normal sidebar), narrow re-check

**Build:** `unit-ui-project-order` @ `c04dd4c4`, vite dev on :5442. **Baseline:** merge-base `46897cb4` (/tmp/ux-po/master, vite on :5443).
**Setup:** the R33b harness (Playwright + Chromium, `?demo&team=vibesquad`). Non-GET `/api/teams` is stubbed, so nothing reached the registry. Viewports: 3200×1800@1.2, 1920×1080 and 1280×720, dark and light. 0 page errors.
**Files:** drivers in /tmp/ux-po3/drv/ (`m.mjs`, `chev2.mjs`, `mchev.mjs`, `rg.mjs`, `touch.mjs`), with raw output next to them (`m.json`, `chev2.json`, `rg.json`). Shots in docs/ux-review-r33c/. Guard report in /tmp/ux-po3/guards/ui-clicks-unit.md.
**Scope:** R33b M1, M2 and m1, plus 4K/1080 parity and a dark/light pass. Not re-flagged (lead decisions): the m4 bust, no reorder on phone, and the sidebar scrolling at 720.

## Status vs R33b
| R33b | Now | Evidence |
|---|---|---|
| M1 grip blocks chevron | **Fixed** | The grip is at x 13, 7px wide, with 0px overlap with the chevron (x 21–37) at 4K, 1080 and 720, dark and light. It shows only on hover/focus-within: at rest only the focused row shows it (`restVis2`), and the selected-row rule is gone. **Chevron sweep:** 21 real mouse clicks per row (7 x-points × 3 y-points). Non-Main rows give the **same result as master, point for point, at all three sizes**: the only misses are the 1px edge points outside the glyph that also miss on master, and the grip never appears in a miss. **Main chevron:** 9/9 clicks toggle at 4K, 1080 and 720, and every elementFromPoint in the 3×3 grid lands on the toggle (`mchev.mjs`). The Main row has no visible grip. `ui:clicks` now PASSes (below). Shots: `zoom-1080d-grip-hover.png`, `zoom-1080l-grip-hover.png`. |
| Grip still drags (mouse) | **Pass** | At 1080 and 4K, dropping the site project before efi gives `efi,vibesquad,site,…` → `site,efi,vibesquad,…`: 1 write, `drop-before@efi`. Escape mid-drag: markers 2 → 0 and 0 writes. Move up/down ends and the no-op drop on Main (0 writes) match R33b (`rg.json`). |
| Grip still drags (touch) | **Pass** | 1280×800, hasTouch. The grip is hidden before the tap and visible after tapping the row (focus-within). A CDP touch drag shows `drop-before` on efi and the order goes `efi vibesquad site …` → `site efi vibesquad …` (`touch.mjs`). |
| Rows with no Main = master | **Pass** | Row x, name x and name width are identical to master at 4K, 1080 and 720, dark and light (`rowsEq true`). Tree, footer and sidebar heights are identical too. |
| m1 collapsed pin clips header | **Fixed** | Collapsed pin: h 58, clientHeight 56 = scrollHeight 56. Nothing is clipped and there is no inner scroll. Open and ⋯ are fully visible at every size. Shot: `zoom-1080d-main-collapsed-vs-expanded.png` (top and bottom). |
| M2 720 pin starves | **Fixed** | 1280×720: an expanded Main (efi) gets a 692px pin with no inner scroll, and every lane renders. The sidebar scrolls (1454/720), as the lead decided. **Ctrl+J into a Main worker** (VibeSquad as Main): the URL is `agent=demo-aud`, the selected row `boring-worker-demo-aud` is inside the pin and on screen, and the pin header (name, Open, ⋯) is visible at y 391. The breadcrumb reads VibeSquad › Desk › Worker. Shots: `crop-720d-hub-ctrlj.png`, `crop-720l-hub-ctrlj.png`. |
| 4K footer = master, lanes not scrolling in pin | **Pass** | 3200×1800: the footer is at 1706 in every state (master 1706). The expanded VibeSquad pin is 855px, with clientHeight = scrollHeight 853, so nothing scrolls inside it. The expanded efi pin is 692px and the tree keeps 426px. |
| 1080 footer = master | **Regressed → M1** | The footer is at 986 only while Main is collapsed. With Main expanded it is at 1344 (efi) or 1507 (VibeSquad after Ctrl+J/Open), against 986 on master and in R33b. See M1. |
| Invariants | **Pass** | Exactly one `.on` row in every state. The breadcrumb matches the open agent (Open → Escape From Idle › Desk › RiffBot, `team=efi`; Ctrl+J → VibeSquad › Desk › Worker). |
| Dark / light | **Pass** | The light-theme numbers are identical to dark at every size. Accent border, grip glyph and header are legible in both (`zoom-1080l-grip-hover.png`, `crop-720l-hub-ctrlj.png`). |

## Findings

### M1 (major, new; regression of R33b's 1080 result): at 1920×1080 an expanded Main pushes the footer and the rest of the projects below the fold. Job: monitoring across projects, and reaching Settings or Usage while working in the Main project.
Evidence (1080, dark and light; `m.json`):
- Main = efi, expanded: the pin is 692px and the tree is cut to its 64px floor at y 1272 (scrollHeight 967). The footer is at **1344 (off screen)** and the sidebar is 1438/1080. Shot: `crop-1080d-main-expanded.png`.
- Main = VibeSquad, then Ctrl+J or Open (the common case when the hub is Main): the pin is 855px, the tree is at y 1435 with 64px, and the footer is at **1507**. The sidebar is 1601/1080. Shot: `crop-1080d-hub-ctrlj.png`.
- Master and R33b: the footer is at 986 and on screen, and the tree or pin scrolls inside itself.
- The result is two nested scrollers: the sidebar has to scroll about 430–520px before the other four projects appear, and they then sit in a 64px (about 1.5-row) window that scrolls on its own. The fix brief required "Keep the 4K/1080 results R33b measured: the footer matches master".

Cause: `src/boring.css:1471` changed `.boring-main-pin` from `flex: 0 1 auto; min-height: 54px; overflow-y: auto` to `flex: 0 0 auto` with no overflow. This fixed 720 by never shrinking the pin, but it also stopped the pin shrinking at 1080, where R33b's shrink was correct. Only 720's floor was wrong.
Fix: keep shrinking, and raise only the floor. For example:
`.boring-main-pin { flex: 0 1 auto; overflow-y: auto; min-height: 58px }` (full header, which keeps the m1 fix)
`.boring-main-pin:has(> .boring-project-block.open) { min-height: 220px }` (header plus about 4 rows; an expanded pin's content is always taller)
Expected result: at 1080 the pin is about 342px and scrolls inside, with the sticky header visible because 342 > 58, and the footer stays at 986. At 720 the 220px floor plus the tree floor go past the viewport, so the sidebar scrolls (the lead decision). At 4K nothing changes, since the content fits. Re-measure Ctrl+J at 1080 and 720 so the header stays put. Add the 1080 expanded case to the source test in `test/project-order.test.mjs`. Files: boring.css (+ test). Effort: S.

### Minor
- **m1:** when Main expands, its header moves down 9px (chevron y 584 → 593 at 4K and 1080, 600 → 609 at 720) and gains an inner box. That box is the open block's own padding/background inside the pin. The chevron jumps under the cursor, although every click in the sweep still toggled. Shot: `zoom-1080d-main-collapsed-vs-expanded.png` (top vs middle). Cause: `.boring-project-block.open { border:1px; padding:8px; background:var(--surface-1) }` (`src/boring.css:963`) also applies inside `.boring-main-pin`, so the header moves down by 1px border + 8px padding = 9px. Fix: `.boring-main-pin > .boring-project-block.open { border:0; padding:0 0 8px; background:transparent }` (the pin already draws the frame), so collapsed and expanded share the same header y. Effort: XS.

## Guards
- **`ui:clicks -- --vibe boring --surfaces boring-home,boring-lead,boring-brainstorm,boring-overview,boring-settings`:** **PASS, 0 unique hits.** 2002 hit-tests, 40 popovers, 120 triggers, 0 skipped, 291s. 1080, 4K and 1280 have 0 mismatches and 0 clipped in both themes. Mobile/boring shows 0 controls, the same as R33b. R33b had 1 hit (the grip over the chevron). Report: /tmp/ux-po3/guards/ui-clicks-unit.md. Env: TMPDIR=$HOME/uxpo-tmp, PLAYWRIGHT_DIR=/tmp/pwtool/node_modules, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser.
- **`ui:overlap`:** skipped as briefed. It forces fun vibe and can't see Normal mode (idea-1018).
- Cleanup: deleted ~/uxpo-tmp and the worktree's `scratch/ui-clicks`. The pre-existing `scratch/{h1c-v4,h1e,overlord-v4,shots}` were left alone. `git status` in the worktree is clean, and both vite servers are stopped.

## Owner decisions
None new. The 720 sidebar scroll is already decided. M1 is a direct miss of the brief's 1080 requirement, not a design question.

## Not done
- Phone picker order (R33b m3) wasn't re-measured; it's out of scope. The touch driver's picker read came after the harness's ~10s `GET /api/teams` poll had reverted the stubbed order, so it proves nothing either way.
- Full-size screenshots were dropped from the report folder because they show real project names. The numbers in `m.json` cover them.
