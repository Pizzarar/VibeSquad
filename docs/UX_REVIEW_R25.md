# VibeSquad UX review, round 25: @desk B3 re-review, Needs-you row fit + light `--st-err`

Date: 2026-11-25 · Build: `desk-b3-needsyou-fit` @ `f55a806d`, compared with R23 (`e585fbe8`) and BASE = `master` @ `15e49a29` (the branch parent, same BASE build as R23). R24 is taken by the B1 re-review.

**Setup.** The branch was built in its worktree with `npx vite build`. BASE is the R23 `git archive` build in `/tmp/b3base`. Each `dist/` was served by an in-process static server inside the Playwright script, not the live server. Driven with playwright-core and the snap Chromium, `?demo=1&riff=1` (6 Needs-you rows, 5 shown + "1 more") and `&crowd=1` (31 rows, expanded). There were 0 page errors in every pass. No source edits.

**Name passes.** The demo bundle strings were rewritten through a route intercept; the source was untouched.

| Pass | Rewrites |
|---|---|
| stock | none |
| long (same as R23) | project `Main Game Project Overworld Remaster`, lane `Main Game Overworld Quests And Dialogue`, titles `Review - Sonnet · drawer crash regression sweep across providers`, `Audit - token scout for handoff budgets and context refs`, `Bug Runner · triage of the overnight crash reports` |
| XL | long, plus project `Main Game Project Overworld Remaster Definitive Edition Collection`, which is wider than the row on its own |

**Viewports.**
- 1920×1080 light and dark (sidebar 307px)
- 1280×900 light and dark (sidebar 290px, the floor of `clamp(290px,16vw,380px)` and the narrowest the Normal sidebar gets)
- 3200×1800 @1.2 dark (sidebar 380px)

Screenshots are in `docs/lanes/desk/ux-r25/`.

Verdict: PASS 0/0/3 (critical/major/minor). Both R23 majors are fixed and nothing critical or major is open, so the B3 area passes the UX gate. Three minors stay open: one new, one spec/owner question, and one carried from R23.

## Status vs previous round (R23)

| R23 item | Status at `f55a806d` | Evidence |
|---|---|---|
| M1 · long `Lane · Project` overflows the row and sidebar; project clipped | **Fixed.** No row's location overflows its item, and no row collides with the age column; the gap is 6px on every row. `.boring-sidebar` has no horizontal scroll in any pass (stock, long, XL, crowd) at 1280, 1920 or 3200. The project is visible on every row (0 of 31 hidden). | `head-light-1920-riff-sidebar.png`, `head-dark-3200-riff-sidebar.png`, `head-light-1280-xl-riff-sidebar.png`, `head-dark-1280-riff-crowd-exp-sidebar.png` |
| M2 · title crushed to about 6ch | **Fixed.** The title box is 195px at 1920, 178px at 290px and 268px at 3200 (R23: 68-88px). Truncated titles show 27-30 characters at 290/307px and about 42 at 380px. Crowd rows read "Audit - ui-bois task 4", "Mechanical - ui-bois task 9", "Implement - art-directio…" instead of "Audit - ui…" and "Mechani…". Stock "Audit - token scout" and "Review - Gemini · retry" are shown in full again. | `cmp-light-base-vs-head-stock-long-xl.png`, `cmp-dark-hover-1280-crowd.png` |
| m1 · geometry pinned only by CSS text-matching | **Open** (m3 below). The test was rewritten for the new rules (141 of 141 green with `test/boring-mode.test.mjs`), but it is still a CSS-string test. There is no rendered-geometry probe. | `test/desk-b3-needsyou-fit.test.mjs:5,90-125` |
| n1 · light `--st-err-bg` left on the old red | **Fixed.** `#b9264e1a` (`src/boring.css:706`) | computed `--st-err-bg` = `#b9264e1a` |

## Checks requested

| Check | Result | Measured |
|---|---|---|
| No overflow, no horizontal sidebar scroll, no age collision | **Pass** | `sbHScroll=false` and `docHScroll=false` in all 9 passes. `where.right ≤ item.right` holds on every row. The age-to-content gap is 6px on all rows. Hovering a row shows `⋯` right of the age with no overlap (`cmp-dark-hover-1280-crowd.png`, left panel). |
| Project name visible on every row | **Pass**, with m1 | Visible on 5 of 5, 31 of 31, and on the XL row. The long and XL projects are ellipsized ("· Main Game Project Overworld …"), but the start of the name, which identifies it, stays. |
| Title readable (≥ ~20ch, or location on its own line) | **Pass** | 27-30 visible chars at 290/307px, about 42 at 380px. Short titles ("Lead 75", "Review - Gemini · retry") show in full. |
| SPEC R3 #3: location muted on line 1 when it fits, reason on line 2 | **Pass by the plan's rule, but the inline case never happens** (m2) | The location is muted: `--text-3` `rgb(94,88,104)` light / `rgb(154,151,168)` dark, against a title of `rgb(29,26,36)` / `rgb(243,241,247)`. The reason sits below on 31 of 31 rows. The location wrapped to its own line on **100% of rows at every width** (5/5 at 1280, 1920 and 3200; 31/31 crowd), even with stock names. |
| Tooltip shows the full location | **Pass** | Every row's `.boring-needs-where` carries `title="<Lane> · <Project>"`, including Desk rows and the XL row (full "… Definitive Edition Collection" string). That is 0 rows without a title (R23: only in sidebar mode). The native tooltip itself isn't capturable headless, so the attribute is the evidence. |
| Regression sequences | **Pass** | Clicking the long Lead row gives the breadcrumb "Main Game Project Overworld Remaster › Main Game Overworld Quests And Dialogue › Lead" with one selected row ("Lead"). Ctrl+J and clicking the Audit row each give "VibeSquad › Desk › Worker" with one selected row. The header count of 6 matches the 5 rows plus "1 more". |

### Light-mode error colours

All values were measured in the running app, in light, against each element's effective background (alpha-blended up the ancestor chain).

| Element | BASE | R23 | Branch | Threshold |
|---|---|---|---|---|
| `.tl-exit-badge.err` "exit 2" text (on `--st-err-bg` over the timeline) | 4.46 | 4.84 | **4.82** | 4.5 text |
| `.boring-badge.err` sidebar count | 5.60 | 6.09 | 6.09 | 4.5 |
| `.boring-needs-item.attn-error` left rule | 5.60 | 6.09 | 6.09 | 3.0 |
| `.boring-dot.st-err` dots | 4.80-5.60 | — | 5.19-6.09 | 3.0 |
| Text on the `attn-error` Needs-you row (title / location / reason / age) | 14.68 / 5.86 / 7.88 / 5.86 | — | 14.61 / 5.83 / 7.84 / 5.83 | 4.5 |

- **Exit badge:** the 0.02 drop from R23 comes from n1's darker tint and is expected. It still clears 4.5:1 (`head-light-exit-badge.png` vs `base-light-exit-badge.png`).
- **Rest of the sweep:** the only other change since R23 is `--st-err-bg`. Its other users (`.boring-needs-item.attn-error` and `.boring-worker-row.needs-err`, `src/boring.css:912,1213`) moved by at most 0.07 and stay well above threshold.

There is no regression.

## Findings

### Critical / Major

None open.

### Minor

- **m1 · When the project fills the row, the lane disappears completely and leaves a stray leading "·".**
  - **Job hurt:** job 3 (respond). On the long Lead row the location reads " · Main Game Project Overworld …". The lane name appears nowhere on the row, because `roleOnlyWho` (`src/BoringInbox.tsx:34`) also strips it from the title ("Lead 75"). With two lanes in one long-named project, their leads become indistinguishable until you hover.
  - **When it happens:** only when `· <Project>` is wider than the row by itself, about 28 characters at 307px. The stock and long-lane-with-short-project cases elide the lane correctly.
  - **Evidence:** `head-light-1920-riff-sidebar.png`, `head-light-1280-xl-riff-sidebar.png`, `cmp-dark-hover-1280-crowd.png` (Lead 75 row). Measured: lane `scrollWidth > clientWidth` with a width near 0, and the project also ellipsized.
  - **Cause:** `src/boring.css:1258` `.boring-needs-proj { flex: none; max-width: 100% }` lets the project claim the whole line. `src/boring.css:1257` `.boring-needs-lane { min-width: 0 }` then gives the lane nothing. The " · " separator is part of the project span (`src/BoringInbox.tsx:182`), so it survives the lane's collapse.
  - **Fix:**
    1. Give the lane a floor, e.g. `min-width: min(6ch, 30%)`, and make the project `flex: 0 1 auto; min-width: 0`. The row then reads "Main G… · Main Game Project Overw…".
    2. Move the separator into the lane span (or a `::before` on the project shown only when the lane is non-empty), so no orphan dot is left.
  - **Files:** `src/boring.css:1257-1258`, `src/BoringInbox.tsx:182`. **Effort:** XS.

- **m2 · The inline "title + location on line 1" layout is unreachable, so every row is now three lines.**
  - **Job hurt:** job 2 (monitor). The Needs-you block is about 60px taller for 5 rows: stock 2-line rows went from 49px on BASE to 61px. That pushes Projects further down at 1080p (`cmp-light-base-vs-head-stock-long-xl.png`: the block ends about 60px lower).
  - **Upside:** every row now has the same shape, which resolves R23's "ragged rows" note.
  - **Evidence:** 0 inline rows in 5 + 5 + 5 + 31 rows at 290, 307 and 380px with stock names. Even "Review - Gemini · retry" + "Desk · VibeSquad" wraps at 380px.
  - **Cause:** `src/boring.css:1255`. The `min(20ch,100%)` floor (about 156px) plus a typical location (100-180px) is wider than the row's content box (178-268px). So the inline branch never wins, and SPEC R3 #3 / R2 #5 ("2-line rows") no longer describe the product.
  - **Fix:** this is a spec question, not a code bug. See Owner decision 1. If 3-line is accepted, simplify the code to match: give the location `flex-basis: 100%` and drop the wrap logic. Then update SPEC R3 #3 and the plan text.
  - **Files:** `src/boring.css:1254-1258`, `docs/lanes/desk/SPEC.md`. **Effort:** XS.

- **m3 · (carried from R23 m1) The geometry is still pinned only by CSS string matching.**
  - **Gap:** `test/desk-b3-needsyou-fit.test.mjs` can't see m1 or m2, and couldn't see R23's M1.
  - **Fix:** add a `?demo` Playwright probe, either in `scripts/ui-overlap.mjs`, which already has a sidebar-needs probe at :170, or as a new test. Use one long lane/project row at 290px and 307px, and assert:
    - `where.right ≤ item.right`
    - project visible and lane width > 0
    - title ≥ 15 visible chars
    - `sidebar.scrollWidth == sidebar.clientWidth`
  - **Effort:** S.

## Owner decisions

1. **Needs-you row shape: accept 3 lines on every row, or keep the 2-line inline case?** R23 decision 1 asked this. The code has now answered it as "3 lines always", while SPEC R3 #3 still says 2 lines.
   - **Option (a), recommended:** accept title / muted `Lane · Project` / reason as the fixed shape, and amend SPEC R3 #3 and R2 #5 to match. It's predictable and readable, and the cost is about 12px per row, about 60px for the 5-row cap.
   - **Option (b):** bring back inline for short pairs by lowering the floor toward 12-14ch. Measured against R23, that brings back narrower titles and ragged row shapes, for a gain that only shows on rows with very short names.

## Routing

m1, m2 (code simplification after the owner's call) and m3 belong to @desk, in the B3 unit's files (`src/boring.css:1254-1258` is B3-only, so there is no @bor hunk clash). The SPEC amendment in decision 1 is lead-owned. There is nothing for other lanes.
