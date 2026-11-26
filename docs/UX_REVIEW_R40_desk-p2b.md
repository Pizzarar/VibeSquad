# VibeSquad UX review, round 40: @desk P2b strip order, scroll cue, 1920 rail slack

Date: 2026-11-26 · Build: `desk-p2b-strip-order` @ `76de3d0f` · Previous: `docs/UX_REVIEW_R39_desk-p2.md` (PASS 0/0/3)

**Verdict: PASS 0/0/1** (critical/major/minor)

- **R39 m1, m2 and m3 are all fixed.**
- **No regressions** in the checks the brief listed.
- **1 new minor:** the m3 fix sizes each rail line's columns to its own content, so the state and event columns no longer line up. This shows at 1920 and also at the 3200 4K target.

## Setup
- **Build and tests:** `npm run build`, then `public/THIRD-PARTY-LICENSES.txt` was restored. `node --test test/desk-d4-decision-desk.test.mjs`: 14/14 pass.
- **Drivers:** `docs/ux-review-r40/drive/`. `mock.mjs` is the R39 mock (12 items, 3 Squads), unchanged. Run them from the repo root. Outputs go to `$R40_OUT` or `docs/ux-review-r40`.
  - `pass1.mjs`: geometry at 1366×768, 1600×900, 1920×1080 and 3200×1800@1.2. Each size runs in dark and light with `?view=decisions&lanes=24`, plus plain `?view=decisions` at 1920 and 3200.
  - `pass2.mjs`: Tab order, the stacked-strip scroll cue at the top, middle and bottom and with the quiet fold open, the quiet fold in the 3200 rail, lean opt-in, and URL writes on a fresh load and a reload.
  - `pass3.mjs`: left edges of the rail columns.
- **Logs:** `docs/ux-review-r40/logs/`. Every run had 0 page errors.
- **Housekeeping:** during pass 1, something outside this review deleted my untracked `docs/ux-review-r40/` files mid-run (no live process was visible afterwards). I re-ran everything from a scratch directory and copied the results in. `docs/shots/desk-d4/dark-1920.png` also shows as modified in this worktree. That change is not mine and is not in this commit (the same e2e side effect noted in R39).

## Status vs R39

| R39 finding | R40 | Evidence |
|---|---|---|
| **m1:** strip sits between feed and off-screen; Tab zigzags | **Fixed.**<br>• DOM order is feed → off-screen → strip at every width (`feedBeforeOff`/`offBeforeStrip` = before/before).<br>• Stacked at 1600: off-screen starts at y=1626 and the strip at y=1954.<br>• Tab order at both 1920 and 1600: DESK → FEED (Tab 3–36) → OFFSCREEN (37–42) → STRIP (43–57) → BAR → SIDEBAR.<br>• At 1920 that is one move from the left column to the rail, with no return trip. | `logs/pass1.json`, `logs/pass2.json` `focus1920`/`focus1600`, `r40-light-1600-stacked-strip.png` |
| **m2:** capped stacked strip has no scroll cue | **Fixed.**<br>• The bottom fade shows while more content is below (`data-scroll-more=true`) and hides at the bottom (scrollTop 185/185 at 1600, 231/231 at 1366).<br>• It comes back when the quiet fold opens (scrollH 1172).<br>• Squad heads are `sticky`, so `VibeSquad` stays pinned mid-scroll.<br>• The fade gradient ends on the page background in both themes (dark `rgb(18,18,24)`, light `rgb(247,246,243)`).<br>• `overscroll-behavior: contain` holds: a wheel past the end leaves page scrollY at 0.<br>• In rail mode the fade stays off (`display:none`) and the heads are `static`. | `logs/pass2.json` `stacked-*`, `r40-dark-1600-strip-mid.png`, `r40-light-1600-stacked-strip.png`, `r40-light-1600-strip-quiet-open.png` |
| **m3:** 4 event texts truncate at 1920 rail | **Fixed.** 0 of 11 lines truncate at 1920 and 3200, in both themes and with or without `?lanes=24`. With the 3200 quiet fold open, 0 of 35 truncate. This introduced minor 1 below. | `logs/pass1.json` `truncLines`, `logs/pass2.json` `quiet3200.trunc`, `r40-dark-1920-lanes24.png` |

## Regression checks

| Check | Result | Evidence |
|---|---|---|
| Rail wider than 580 at 3200 | **Pass.** Rail 880px, feed 1096px, desk 2000px. At 1920: rail 674px, feed 834px. | `logs/pass1.json` |
| Feed first below 1900 | **Pass.**<br>• Stacked at 1600: 4 cards fully above the send bar, 5 started.<br>• At 1366: 3 full, 4 started.<br>• Strip cap: 315px at 1600 and 269px at 1366.<br>All match R39. | `logs/pass1.json` `*-1600-*`, `*-1366-*` |
| Lean opt-in visuals | **Pass.**<br>• Untouched: dashed, transparent, `aria-pressed=false`. The bar reads `6 leans not included…`, `Use all leans (6)`, `Send 0 answers`.<br>• After a tap: `✓ Lean`, solid fill, and `1 ready to send · 5 leans not included`. | `logs/pass2.json` `lean` |
| Quiet fold | **Pass.**<br>• 3200 rail: `− hide 24 quiet`, 35 lines, rail bottom at y=1304 of 1800, feed stays at y=132.<br>• Stacked: content grows to 1172 inside the fixed cap and the fade comes back. | `logs/pass2.json` `quiet3200`, `stacked-*.quietOpen` |
| No `?team=` flash | **Pass.** A fresh `?demo=&view=decisions` load and a reload both make 0 `pushState`/`replaceState` calls. | `logs/pass2.json` `freshViewDecisions`, `reloadViewDecisions` |
| Light theme | **Pass.** The fade, sticky heads (`#fff` band) and off-screen rows read clearly. | `r40-light-1600-*.png` |

## Findings

### Minor 1 · Rail strip columns no longer line up (at 1920 and at the 3200 4K target)
- **Job hurt:** 2 (monitor). The owner scans the rail down the state column (`waiting · N`, `needs you`, `idle`) and the event column. Each line still reads correctly, and the coloured dot column stays aligned.
- **Evidence:** at both 1920 and 3200@1.2, the left edge of the state column varies by **150px** across the 11 lines and the event column by **177px**.
  - Example at 3200: `Desk` state at x=1995, `Art Direction` at x=2145.
  - `r40-dark-3200-rail-strip.png` shows the zigzag.
  - Computed `grid-template-columns` differs per line (`logs/pass3.json`).
  - In R39 every line used one fixed template (`10px minmax(100px,140px) minmax(88px,116px) 74px 1fr auto`), so the columns were aligned at 3200 with 0 truncation.
- **Cause:** `src/boring.css:2265-2267`. `.is-wide .boring-decision-strip-line { grid-template-columns: 10px minmax(0,max-content) minmax(0,max-content) auto minmax(0,1fr) auto }`. Each `.boring-decision-strip-line` is its own grid (`src/BoringDecisionDesk.tsx:932`), so `max-content` resolves per line.
- **Fix (pick one):**
  - **(a)** Put the column template on the container and have each line use `grid-template-columns: subgrid; grid-column: 1 / -1`. The container is `.boring-decision-strip-lanes` (`boring.css:1761`), or one level up so all Squads align. This keeps the m3 slack and aligns the columns, and Chromium/Electron support it.
  - **(b)** Use fixed rail-mode columns sized to the 1920 rail, for example `10px 112px 104px 74px minmax(0,1fr) auto`. Check that Desk's 312px event still fits at 674px.
  - Either way, add an e2e assertion that the state column's left edge is equal across strip lines in rail mode.
- **Effort:** XS–S.

## Notes (not findings)
- The R38/R39 note stands: Main Game's line reads `needs you` with no count while 2 items are open.
- The R39 note stands: Tab reaches `body` once between the send bar and the sidebar.
- Only the Decision Desk changed (`git show --stat 76de3d0f`), so the sidebar, Needs-you and `?agent=` sequences were not re-driven.

## Owner decisions
None new. R38's lean question is still open, and the build implements (b), opt-in. Recommendation: keep (b).

## Inbox card for @desk
- **m1 (R40):** rail strip columns are ragged at 1920 and 3200 (state column spread 150px). Use subgrid on the strip-lanes container, or fixed rail columns. See `src/boring.css:2265`.
