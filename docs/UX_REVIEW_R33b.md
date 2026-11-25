FAIL 0/2/1 7f436c1f
- M1 src/boring.css:1485-1486: the drag grip now sits over the left half of the chevron. Clicks there do nothing, and the `ui:clicks` guard FAILs on it.
- M2 src/boring.css:1471-1474: at 1280×720 the Main pin shrinks to 52px. Expanding Main shows no lanes, and after Ctrl+J or a Needs-you jump the pin has no header.
- m1 src/boring.css:1471/1474: the collapsed Main pin cuts 4px off its own header at 1080 and 720. The bottom of the Open button is clipped and the pin scrolls by 4px.

# UX review R33b: PLAN_PROJECT_ORDER O1+O2 fix round 1 (Normal sidebar)

**Build:** `unit-ui-project-order` @ `7f436c1f`, vite dev on :5442. **Baseline:** merge-base `46897cb4` (/tmp/ux-po/master, vite on :5443).
**Setup:** the R33 harness (Playwright + Chromium, `?demo`; non-GET `/api/teams` stubbed, so nothing reached the registry). Viewports: 3200×1800@1.2, 1920×1080 and 1280×720, dark and light; phone 390×844. 0 page errors.
**Files:** drivers in /tmp/ux-po2/drv/ (`m.mjs`, `chev.mjs`, `rg.mjs`, `ph.mjs`), shots in docs/ux-review-r33b/, guard reports in /tmp/ux-po2/guards/.
**Lead decisions, not re-flagged:** the m4 bust goes to @art; the phone has no reorder.

## Status vs R33
| R33 | Now | Evidence |
|---|---|---|
| M1 Main name truncated | **Fixed** | Name width, Main not open / Main open: 4K 229/229px, 1080 156/156, 720 139/139 (≈15–16 ch, "Escape From Idle", never truncated). With VibeSquad as Main: 226 / 153 / 136px, full name. Line 1: dot, bust 24, name, badge. Line 2: Open, ⋯, + lane. Shots: `1080d-main-open.png`, `720d-main-open.png`. |
| M2 pin cap and footer | **4K and 1080 fixed; 720 not (→ new M2)** | Footer y is the same as master in every state: 4K 1706, 1080 986. At 1080 the expanded VibeSquad pin is 334px, the tree keeps its 64px floor and the footer stays at 986. At 4K the expanded VibeSquad pin is 855px with content 853, so nothing scrolls inside it and every lane shows. Empty space under the tree is 125px; on master it is 159px with no Main. Main now gets more room than with no Main. At 720 the footer is at 722 vs 716 on master. Master's sidebar already scrolls there too (810/720). |
| m1 grip takes row width | **Fixed for width; replaced by M1** | With no Main, every row's x and name x/width match master: efi@37 n58/168, vibesquad@37 n58/163, site n58/215 at 1080, and the same at 4K and 720. A pixel diff of the sidebar finds only the grip glyph on the selected row: 35px at y 627–634, x 21–31. Shot: `zoom-1080d-selected-row-master-vs-unit.png`. |
| m2 grip role=button with no tabIndex | **Fixed** | `aria-hidden="true"`, tabIndex −1. ⋯ is the keyboard path. |
| m3 phone picker order | **Fixed (order)** | Main set to IRL Flipper, then the site project moved up twice on desktop. The 390×844 picker now reads IRL Flipper, the site project, Escape From Idle, VibeSquad, then the folder projects. Master lists them unordered. Shot: `phd-unit-picker.png`. |
| m4 same bust | Open, owned by @art (lead decision) | none |
| m5 double frame | **Fixed** | The selected row inside the pin has border-left none and box-shadow none. Only the pin's own 1px accent border remains. Shot: `crop-4kd-hub-ctrlj.png`. |

## Regressions (all pass)
- **Drag:** the site project dropped before efi gives `efi,vibesquad,site,…` → `site,efi,vibesquad,…`. That's 1 write, and the `drop-before` line shows on efi. Same result at 1080 and 4K. Shot: `1080-drag-mid.png`.
- **Escape cancel:** drag vibesquad toward team-9 (2 drag markers), press Escape, and the markers clear at once (0). The pointer keeps moving with no tracking, and releasing over team-9 changes nothing: order unchanged, 0 writes.
- **Move up/down ends** (Main = vibesquad, the 2nd entry in the array): efi's Move up is disabled because Main is hidden in the pin. efi's Move down skips Main and swaps with the site project. team-9's Move down is disabled. Main's own ⋯ menu has no Move items. Dropping onto the Main row shows no marker and makes 0 writes.
- **Invariants:** exactly one `.on` row in every state. The breadcrumb matches the open agent: after Open it reads Escape From Idle › Desk › RiffBot (`team=efi`), and after Ctrl+J it reads VibeSquad › Desk › Worker (`agent=demo-aud`, row `boring-worker-demo-aud`, inside the pin).
- Harness note: the stubbed PUT doesn't persist, so the app's ~10s `GET /api/teams` poll puts the demo order back. Any state checked after about 7s reads as reverted. That comes from the harness, not the app.

## Findings

### M1 (major, new): the drag grip blocks the chevron. Job: expand or collapse projects (monitor, "expand two projects").
Evidence:
- On a hovered row the grip sits at x 21–29, over the 16px chevron at x 21–37 (8px overlap). Real mouse clicks at the chevron's left, centre and right: unit **grip, grip, toggle**; master **toggle, toggle, toggle**. Clicking on or left of the ▸ glyph's centre does nothing (`chev.mjs`, 1080 and 4K).
- The grip is always visible on the **selected** row, with no hover needed, so the same dead zone is there at rest. The ⠿ glyph also runs into the ▾ (`zoom-1080d-selected-row-master-vs-unit.png`, `zoom-1080d-grip-hover.png`).
- The `ui:clicks` guard **FAILs**, 1 unique hit: `boring-project-toggle-vibesquad` "Collapse VibeSquad", point 29,518 hits `boring-project-grip-vibesquad`. It hits at 1080, 4K and 1280, dark and light, on boring-home and boring-overview.

Cause: `.boring-drag-grip { position:absolute; left:0; width:8px; z-index:1 }` (`src/boring.css:1485`) sits on top of the chevron column. `:has(.boring-project-row.on)` keeps it visible on the selected row (`:1486`).
Fix: move the grip into the sidebar's left padding (for example `left:-10px`, so it sits at x 11–19 and doesn't touch the chevron), or give it its own gutter. Show it only on hover/focus, not on the selected row. Re-run `ui:clicks` and the m1 pixel diff afterwards. Files: boring.css (BoringAde.tsx is unchanged). Effort: XS–S.

### M2 (major, open part of R33 M2): at 1280×720 the Main pin shrinks to 52px. Jobs: reach the Main project's lanes, and Needs-you / Ctrl+J into Main.
Evidence at 720, dark and light:
- Main = efi, expanded: the pin is 54px with clientHeight 52 and scrollHeight 690. The 56px sticky header doesn't fit, so **no lanes show**. Open and ⋯ are cut off at the bottom, and `+ lane` is hidden. Expanding looks like nothing happened. Shot: `crop-720d-main-expanded.png`.
- Main = VibeSquad, then Ctrl+J (or Open): the pin scrolls to the selected worker and the header scrolls out, because a sticky element can't stay inside a box shorter than itself. The pin shows two lane rows and **no project name, Open or ⋯**. Shot: `crop-720d-hub-ctrlj.png`.
- Main gets **less** room than with no Main: the pin's 52px plus the tree's 64px floor, against master's 120px tree. The footer is at 722 vs 716 on master, both already below the fold.

Cause: `.boring-main-pin { flex:0 1 auto; min-height:54px }` (`src/boring.css:1471`). The pin is the item that shrinks, and its floor is smaller than its own header: `.boring-main-line` min-height 54 + 2px padding (`:1474`) + 2px border. The Needs-you inbox takes about 530px at 720, so only about 118px is left.
Fix: at 720 the sidebar already scrolls on master, so let it scroll instead of starving the pin. When the pin is expanded, give it `flex-shrink:0` and a floor of `min(content, ~160px)` (header plus about 3 rows), for example `.boring-main-pin:has(.boring-project-block.open){ min-height:160px }`. Set the collapsed floor to ≥ 58px (see m1). Re-measure 720 expanded, Ctrl+J and Needs-you. Effort: S.

### Minor
- **m1:** the collapsed Main pin clips its own header at 1080 and 720: height 54, clientHeight 52, scrollHeight 56. The bottom border of the Open button is cut (`crop-1080d-main.png`), and the pin wheel-scrolls by 4px. Cause: the same 54px floor (`boring.css:1471` vs `:1474`). Fix: `min-height:58px` (or `fit-content`). Effort: XS. The M2 fix covers it.

## Guards
- **`ui:clicks -- --vibe boring --surfaces boring-home,boring-lead,boring-brainstorm,boring-overview,boring-settings`:** **FAIL**, 1 unique hit (= M1). 2002 hit-tests, 40 popovers, 120 triggers, 0 skipped, 299s. Mobile/boring showed 0 controls. Report: /tmp/ux-po2/guards/ui-clicks-unit.md. Master wasn't run, but the only hit is the grip this unit adds.
- **`ui:overlap`:** the full run takes more than 10 minutes (stopped at 590s), so I ran a slice: squads-home, hub, focus-lead, focus-worker, sidebar-needs-hover, modal-command-palette, settings and menu-drawer-config, at 4k/1080/800/mobile, dark and light, 50 runs. **Unit = master:** 0 failing, 7 warn-only decor-suspect (@art), 47 allow-listed. The 54 unique hits are the same set on both, so there are **no new hits** and everything is the pre-existing idea-945 list. **Coverage gap:** ui:overlap forces `app.vibe=fun` (`scripts/ui-overlap.mjs:396`), so it never renders the Normal sidebar this unit changes. Its pass says nothing about the pin or the grip. → R11: queue a @bug card to add a Normal-mode pass to ui:overlap.
- Cleanup: deleted ~/uxpo-tmp and the worktree's `scratch/ui-clicks`. `scratch/{h1c-v4,h1e,overlord-v4,shots}` are dated 15:55, before this run, and were left alone. The worktree is still clean.

## Owner decisions
1. **Main at the 1280×720 floor:** when the sidebar is short, should the expanded Main take its room and push the tree/footer down (the sidebar scrolls, as master already does at 720), or shrink first? Recommendation: Main takes at least its header plus about 3 rows, and the sidebar scrolls. The owner asked for the main project "in all its glory", and the footer is already below the fold on master at 720.

## Not done
- Touch-desktop grip check (R33 `touch.mjs`) wasn't re-run. The grip's touch path is unchanged apart from aria-hidden.
- `ui:clicks` on master wasn't run (its only hit is the new grip).

> Screenshots for this round are not committed: the full-size captures show real project names.
