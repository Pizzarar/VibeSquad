# VibeSquad UX review, round 39: @desk P2 rail width + stacked strip (idea-1070)

Date: 2026-11-25 · Build: `desk-p2-rail-strip` @ `4c14aca5` · Previous: `docs/UX_REVIEW_R38_desk-d4.md` (PASS 0/0/4)

**Verdict: PASS 0/0/3** (critical/major/minor)

- **R38 m2:** fixed. At 3200@1.2 the rail is 880px wide and no event text is cut off.
- **R38 m4:** fixed. Below 1900px the strip comes after the feed, is capped at 315px and scrolls inside that cap. 4 cards sit above the send bar at 1600×900.
- **R38 m1 and m3:** closed.
- **3 new minors:**
  - The strip now sits between the feed and the off-screen section.
  - The 315px cap clips the strip mid-group with no scroll cue.
  - Event text still truncates on 4 lines at 1920.

## Setup
- **Build and tests:** `npm run build` (the generated license file was restored), then `node --test test/desk-d4-decision-desk.test.mjs`: 14/14 pass.
- **Another process in this worktree:** while I worked, a second process was running `test/desk-d4-decision-desk-e2e.test.mjs` here and rewrote `docs/shots/desk-d4/*.png`. Those files are not part of this commit.
- **Drivers:** `docs/ux-review-r39/drive/`. `mock.mjs` is the R38 12-item, 3-Squad mock, unchanged.
  - `pass1.mjs`: geometry at 1600×900, 1920×1080 and 3200×1800@1.2, in dark and light, each with and without `?lanes=24`. Spot checks at 1366 and 2400.
  - `pass2.mjs`: keyboard focus order, scrolling the stacked strip and opening its quiet fold, quiet fold in the rail at 3200, lean opt-in, hover text, URL writes on a fresh load and reload of `?view=decisions`, strip vs feed Squad order.
- **Logs:** `docs/ux-review-r39/logs/`. There were 0 page errors in every run.

## Status vs R38

| R38 finding | R39 | Evidence |
|---|---|---|
| **m1:** a fresh `?view=decisions` load flashes `team=` | **Fixed.** A fresh load and a reload both make 0 `pushState`/`replaceState` calls, and the URL stays `?demo=&view=decisions`. | `logs/pass2.json` `freshViewDecisions`, `reloadViewDecisions` |
| **m2:** the rail is capped at 580px and cuts off event text at 3200 | **Fixed at 3200; some truncation remains at 1920** (see minor 3).<br>• The rail is now `clamp(520px, 44%, 920px)`.<br>• At 3200@1.2: desk 2000px, feed 1096px, rail 880px, 0 of 11 strip lines truncated.<br>• At 2400: rail 854px, 0 truncated.<br>• At 1920: desk 1533px (was 1252), feed 834px (was 648), rail 674px (was 580), 4 of 11 lines truncated. All 4 carry the full text in `title=`.<br>• The feed measure is still readable at 3200: question lines are well under 100ch inside a 1096px card. | `logs/pass1.json`, `r39-dark-3200-lanes24.png`, `r39-light-3200.png`, `r39-light-1920.png`, `logs/pass2.json` `hover` |
| **m3:** strip and feed list Squads in different orders | **Fixed.** Both now run VibeSquad → Main Game Project → Site. | `logs/pass2.json` `order`, `r39-dark-3200-lanes24.png` |
| **m4:** below 1900px the stacked strip costs the fold | **Fixed.**<br>• At 1600×900 the feed comes first, with card 1 at y=190. 4 cards sit fully above the send bar and 5 start above it (R38: 1).<br>• At 1366×768: 3 full, 4 started (R38: 0).<br>• The strip is capped at `min(320px, 35vh)`: 315px at 1600 and 269px at 1366.<br>• A mouse wheel over the strip scrolls only the strip (`scrollTop` 0→185) and leaves the page where it was.<br>• Opening `+24 quiet` in the stacked strip grows its content to 35 lines (scrollHeight 1172) while the box stays 315px. | `logs/pass1.json` `dark-1600*`, `dark-1366-lanes24`, `logs/pass2.json` `stacked-dark`/`stacked-light`, `r39-*-1600-stacked-*.png` |

## Regression checks

| Check | Result | Evidence |
|---|---|---|
| Lean opt-in visuals | **Pass.**<br>• Untouched: `aria-pressed=false`, `is-lean suggested`, dashed border, transparent background. The bar reads `6 leans not included…`, `Use all leans (6)`, `Send 0 answers`.<br>• After a tap: `✓ Lean`, `aria-pressed=true`, solid fill, and `1 ready to send · 5 leans not included`. | `logs/pass2.json` `lean`, `r39-light-1920-lean-staged-card.png` |
| Quiet-lane fold | **Pass.**<br>• Rail at 3200: `+24 quiet` expands to 35 lines, the rail ends at y=1304 of 1800, the feed stays at y=132, and the button reads `− hide 24 quiet`.<br>• Stacked: see m4 above.<br>• `?lanes=24` meta reads `35 lanes`. | `logs/pass2.json` `quiet3200`, `r39-dark-3200-lanes24-quiet-open.png`, `r39-*-1600-stacked-quiet-open.png` |
| Keyboard focus order | **Pass, with one oddity (minor 1).** Focus runs summary link → feed cards → strip (Squad heads, lane lines, `+24 quiet`) → off-screen `Mark done` → send bar → sidebar. Focus inside the capped strip scrolls it into view. | `logs/pass2.json` `focus1920`, `focus1600` |
| Light theme | **Pass.** The rail, stacked strip, dashed lean chips and amber `waiting` read clearly. | `r39-light-*.png` |

## Findings

### Minor 1 · The status strip now sits between the feed and the off-screen section
- **Job hurt:** 3 (respond). The off-screen items are owner actions such as "Sign and publish", "Playtest" and "Approve $20/mo".
- **Evidence:**
  - At 1600 the stacked order is: here-cards → `LIVE STATUS` (315px) → `OFF-SCREEN · TEST, MONEY & RELEASE` (`r39-dark-1600-stacked-strip.png`). The owner has to scroll past a status panel to reach the last 3 decisions. `jump to off-screen` still works.
  - At 1920+ the same DOM order makes keyboard focus zigzag. It goes from the left-column feed to the right rail (Tab 36–50), then back to off-screen `Mark done` in the left column (Tab 51, y=733).
- **Cause:** P2 moved the strip `<section>` after the feed (`src/BoringDecisionDesk.tsx:818`) but left it before the off-screen `<section>` (`:888`). In R38 the order was strip `:678` → feed `:747` → off-screen `:888`.
- **Fix:** render the strip after the off-screen section. `grid-area: strip` already places it in the rail at 1900+, so only the stacked order and tab order change. Add the off-screen section to the existing e2e "strip after feed" assertion.
- **Effort:** XS.

### Minor 2 · The stacked strip clips mid-group with no scroll cue
- **Job hurt:** 2 (monitor).
- **Evidence:** at 1600 the 315px box ends halfway through the `Main Game Project` group, and the cut-off line is the only hint that more is below (`r39-dark-1600-stacked-strip.png`). There is no fade, shadow or "N more lanes" line. Only 6 of 11 lines are visible.
- **Fix:** add a bottom fade/shadow while `scrollTop + clientHeight < scrollHeight`, or make the Squad heads `position: sticky`. Optionally add `overscroll-behavior: contain` so a wheel at the end doesn't jump the page.
- **Files:** `src/boring.css:2236`. **Effort:** XS–S.

### Minor 3 · Event text still truncates on 4 strip lines at 1920 (R38 m2 residual)
- **Job hurt:** 2 (monitor). This is the owner's half-screen or laptop size, not the 4K target.
- **Evidence:** Desk (`Decision Desk approved f…`, 173px shown of 312 needed), Plugins, UI Bois and Site Polish (`logs/pass1.json` `dark-1920` `lineInfo`). The full text is in `title=` (`logs/pass2.json` `hover`). Meanwhile the name column has about 150px of slack for short names like `Desk` (`r39-light-1920.png`).
- **Fix:** give the event column `1fr` and size the name and `@code` columns to their content (`max-content`, capped), or drop the `@code` column when the rail is under about 720px.
- **Effort:** XS.

## Notes (not findings)
- The R38 note stands: Main Game's strip line reads `needs you` with no count while 2 items are open (`waiting · N` is shown for other lanes).
- The P2 commit touches only the Decision Desk. The sidebar, Needs-you, history and `?agent=` sequences are unchanged since R38 and were not re-driven in full this round.

## Owner decisions
None new. R38's pending lean question is still open, and the build still implements (b), opt-in. Recommendation: keep (b).

## Inbox cards for @desk
- **m1:** render the strip after the off-screen section (`BoringDecisionDesk.tsx:818` vs `:888`). This fixes both the stacked order and the tab zigzag.
- **m2:** add a scroll cue to the stacked strip cap (`boring.css:2236`): a fade or sticky Squad heads.
- **m3:** at 1920, give the event column the slack from the name column so 4 event texts stop truncating.
