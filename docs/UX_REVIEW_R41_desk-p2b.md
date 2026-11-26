# VibeSquad UX review, round 41: @desk P2b r2 rail subgrid (short re-check)

Date: 2026-11-26 · Build: `desk-p2b-strip-order` @ `8f740e9e` · Previous: `docs/UX_REVIEW_R40_desk-p2b.md` (PASS 0/0/1)

**Verdict: FAIL 0/1/1** (critical/major/minor)

- **R40 m1 is fixed.** Every rail column now lines up: the left-edge spread is 0px for every column at 1920 and 3200@1.2, in both themes, with the quiet fold closed and open. 0 event texts truncate.
- **The R40 wins all hold:** stacked order and Tab order, the scroll cue, no fade in rail mode, and a rail wider than 580px at 3200.
- **The subgrid added 1 major and 1 minor.**
  - **M1:** every status dot sits on top of the first letter of its lane name.
  - **m1:** lane-code chips are capped at 58px, so they wrap or clip, and lines come out at mixed heights.

## Setup
- **Build:** `npm run build`, then `public/THIRD-PARTY-LICENSES.txt` was restored.
- **Drivers:** `docs/ux-review-r41/drive/`. These are the R40 drivers retargeted to R41. `pass2.mjs` now handles the fade element being absent in rail mode. Run them from the repo root.
  - `pass1.mjs`: geometry at 1366, 1600, 1920 and 3200@1.2 in dark and light.
  - `pass2.mjs`: Tab order, the stacked scroll cue, the quiet fold, lean opt-in, and URL writes.
  - `pass3.mjs` (new): the left edge of every rail column, plus truncation, at 1920 and 3200@1.2 in dark and light, with the quiet fold closed and open.
  - `pass4.mjs` (new): dot/name overlap, code wrap and line heights, as built and with a candidate CSS fix injected in the page: first track `auto` and a 76px code slot. No source was edited.
- **Logs:** `docs/ux-review-r41/logs/`. All runs had 0 page errors.

## Status vs R40

| R40 finding | R41 | Evidence |
|---|---|---|
| **m1:** rail state and event columns ragged (spread 150px and 177px) | **Fixed.**<br>• All 6 columns (dot, name, code, state, event, age) report a left-edge spread of 0 across 11 lines, and across 35 with the quiet fold open.<br>• This holds at 1920 and 3200@1.2, in dark and light.<br>• Age spread is 7px only because the age is right-aligned (`3m` against `25m`), and the right edges are equal.<br>• Every line shares one template: `10px 81px 60px 75px 1fr 38px` at 1920, with the event column 381px at 1920 and 586px at 3200.<br>• Event truncation is 0 in every case. | `logs/pass3.json` `spreads`, `lineTemplatesDistinct=1`; `r41-dark-3200-rail-strip.png`, `r41-light-1920-rail-strip.png`, `r41-dark-3200-quiet-open.png` |

## R40 wins (regression checks)

| Check | Result | Evidence |
|---|---|---|
| Stacked DOM order feed → off-screen → strip (1366/1600) | **Pass.** `before`/`before` at every width. At 1600, off-screen starts at y=1626 and the strip at y=1954. | `logs/pass1.json` |
| Tab order | **Pass.** At both 1920 and 1600: DESK → FEED → OFFSCREEN → STRIP → BAR → body → SIDEBAR. | `logs/pass2.json` `focus1920`, `focus1600` |
| Stacked scroll cue | **Pass.**<br>• The fade shows (`data-scroll-more=true`) at the top and in the middle, and hides at the bottom (scrollTop 185/185 at 1600, 231/231 at 1366).<br>• It comes back when the quiet fold opens.<br>• The `VibeSquad` head is sticky and stays pinned mid-scroll.<br>• The fade ends on the page background in both themes.<br>• Overscroll is contained (page scrollY stays 0). | `logs/pass2.json` `stacked-*`, `r41-dark-1600-strip-mid.png`, `r41-light-1600-strip-quiet-open.png` |
| No fade in rail mode | **Pass, improved.** The fade element is no longer rendered in wide mode (`fade: absent` at 1920 and 3200). In R40 it was rendered and hidden with `display:none`. | `logs/pass1.json` `fade:null`, `logs/pass2.json` `quiet3200.fade` |
| Rail wider than 580 at 3200 | **Pass.** Rail 880px, feed 1096px. At 1920: rail 674px, feed 834px. | `logs/pass1.json` |
| Feed first below 1900 | **Pass.** At 1600: 4 cards full and 5 started above the send bar. At 1366: 3 full and 4 started. Strip cap 315px and 269px. All unchanged. | `logs/pass1.json` |
| Lean opt-in and URL writes | **Pass.** Same as R40: dashed and `aria-pressed=false` → `✓ Lean` solid. 0 `pushState`/`replaceState` calls on a fresh load or a reload. | `logs/pass2.json` `lean`, `freshViewDecisions` |

## Findings

### Major 1 · In the rail, every status dot covers the first letter of its lane name (1920 and the 3200 4K target)
- **Job hurt:** 2 (monitor). The rail is the at-a-glance board. Its colour dot is the state signal, and the lane name is the identifier. Now both blur together on every line: `Plugins` reads `●lugins`, `wiki` reads `●iki`, and `UI Bois` reads `●I Bois`.
- **Regression:** R40 had the dot column clean.
- **Scope:** every line, 11 of 11 and 35 of 35 with the quiet fold open, in both themes and at both rail sizes. Stacked mode (below 1900) is not affected.
- **Evidence:**
  - At 3200 the dot runs from x=1927 to 1935 and the name starts at x=1927, an overlap of 8px on every line (`logs/pass4.json` `rows3200`, `overlapping: 11/11`).
  - See `r41-dark-3200-rail-strip.png` and `r41-light-1920-rail-strip.png`.
- **Cause:** `src/boring.css:2266-2280`.
  - The shared template's first track is a fixed `10px`.
  - The nested subgrids (`.boring-decision-strip-squad` with `padding: 8px 10px` and a 1px border at `boring.css:1742-1749`, and `.boring-decision-strip-line` with `padding-inline: 6px` at `:2280`) add their padding and border to the edge tracks.
  - A fixed track can't grow to absorb that, so the dot is pushed about 17px right, into the name track.
  - The last track is `auto`, so it absorbs the same padding, which is why the age column looks fine.
- **Fix:** make the first track `auto` (or `27px`) in `.is-wide .boring-decision-strip-groups` (`boring.css:2268`).
  - I verified this in the page with an injected style: 0 of 11 overlapping, state and event spread still 0, and 0 event truncation at 3200. See `r41-dark-3200-candidate-fix.png` and `logs/pass4.json` `*-candidateFix`.
  - Extend the new e2e check (`test/desk-d4-decision-desk-e2e.test.mjs`, the P2b r2 `cols` block) to assert `dot.right <= name.left`. Today it only checks the state and event columns, so this slipped through.
- **Effort:** XS.

### Minor 1 · Rail lane-code chips wrap or clip, so line heights vary
- **Job hurt:** 2 (monitor) and 5 (intervene). `@handle` is how the owner addresses a lane.
  - At 1920 and 3200, 5 of 11 chips wrap to two lines (`@ui-` / `bois`, `@runner-` / `pilot`). Those lines grow to 44px against 24 to 26px for the rest.
  - 3 chips are clipped (`@art-directio`, `@plugins` missing its last 5px).
  - With the quiet fold open, 20 of 35 lines wrap.
  - The column alignment is right, but the rhythm of the rail is ragged.
- **Evidence:** `logs/pass4.json` `asBuilt.codeWrapped` and `codeClipped`, `lineH: [26,44,24]`; `logs/pass3.json` `trunc` (all 3 are `boring-decision-code-slot`, shown 58px against 63 to 69px needed).
- **Cause:** r2 lowered `.is-wide .boring-decision-code-slot { max-width }` from 116px to 58px (`src/boring.css:2289-2291`), and `.boring-decision-code` can wrap at hyphens.
  - Restoring 116px fixes the wrap but takes the slack away from the 1920 event column: Desk's event truncates.
  - At 76px the hyphenated codes still wrap.
- **Fix:**
  - In rail mode, set `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` on `.boring-decision-code`, and give it the full code as `title` (`src/BoringDecisionDesk.tsx:944`). Size the slot so the common `@xxxxxxxx` codes fit, about 72px.
  - Then confirm Desk's event still fits at 1920 (674px rail), and add a "1 line per strip row" assertion.
- **Effort:** XS.

## Notes (not findings)
- The R38/R39 notes stand: Main Game reads `needs you` with no count, and Tab reaches `body` once between the send bar and the sidebar.
- Only the Decision Desk strip changed in r2 (`git show --stat 8f740e9e`), so the sidebar, Needs-you and `?agent=` sequences were not re-driven.

## Owner decisions
None new.

## Inbox cards for @desk
- **M1 (R41):** the rail status dot overlaps the lane name on every line. Make the first track `auto` at `src/boring.css:2268`, and add a `dot.right <= name.left` e2e assertion.
- **m1 (R41):** rail lane-code chips wrap or clip at 58px. Set nowrap and ellipsis, add `title`, and use an ~72px slot (`src/boring.css:2289`, `src/BoringDecisionDesk.tsx:944`). Recheck Desk's event at 1920.
