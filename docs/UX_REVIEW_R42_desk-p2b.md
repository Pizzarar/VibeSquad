# VibeSquad UX review, round 42: @desk P2b r3 rail dot + code chips (short re-check)

Date: 2026-11-26 · Build: `desk-p2b-strip-order` @ `2b2c2188` · Previous: `docs/UX_REVIEW_R41_desk-p2b.md` (FAIL 0/1/1)

**Verdict: PASS 0/0/1** (critical/major/minor)

- **R41 M1 is fixed.** No status dot touches its lane name. There is an 8px gap on every line (11/11, and 35/35 with the quiet fold open) at 1920 and 3200@1.2, in dark and light.
- **R41 m1 is mostly fixed.** Chips never wrap, every line is exactly 24px, every chip has `title=` with the full code, and 0 events truncate.
- **New minor:** 21 of 32 chips are ellipsized, not just the long ones. Every 8-character code (`@plugins`, `@ui-bois`, `@lane-10`) misses fitting by 0.8px, so the rail reads `@plugi…` and `@ui-bo…`. Changing the chip's inline padding to 4px fixes 17 of the 21 with no cost to the event column.
- **R40/R41 wins still hold:** columns line up, stacked order and Tab order, the stacked scroll cue, and no fade in rail mode.

## Setup
- **Build:** `npm run build`, then `public/THIRD-PARTY-LICENSES.txt` was restored.
- **Drivers:** `docs/ux-review-r42/drive/`. Run them from the repo root.
  - `pass1` to `pass3` are the R41 drivers retargeted to R42.
  - `pass4` now measures the build as it ships, in both themes. It checks dot/name gap, chip wrap/clip/title, and line height.
  - `pass5` (new): exact chip ellipsis (text range width against the chip's content box), and event slack per line.
  - `pass6` (new): candidate CSS fixes injected in the page. No source was edited.
- **Logs:** `docs/ux-review-r42/logs/`. All runs had 0 page errors.
  - The first `pass4` run timed out on the quiet-fold click. It passed on rerun, and `pass5` and `pass6` wait for the button explicitly.

## Status vs R41

| R41 finding | R42 | Evidence |
|---|---|---|
| **M1:** rail status dot covers the first letter of every lane name | **Fixed.**<br>• `dot.right` is 1221 and `name.left` is 1229 at 1920, and 1925/1933 at 3200: an 8px gap with 0 of 11 overlapping, and 0 of 35 with the quiet fold open.<br>• The first track now resolves to 17px (`max-content`).<br>• The new e2e assertion `dot never overlaps lane name` covers it. | `logs/pass4.json` `overlapping:0`, `maxOverlap:-8`; `logs/pass3.json` `groups: 17px 83px 66px 77px 1fr 29px`; `r42-dark-3200-rail-strip.png`, `r42-light-1920-rail-strip.png` |
| **m1:** lane-code chips wrap or clip at 58px, so line heights vary | **Wrap and height fixed. Ellipsis overshoots (new m1 below).**<br>• 0 chips wrap and `lineH` is `[24]` everywhere: 1920 and 3200, dark and light, fold closed and open.<br>• Every chip has `title` equal to its code, and hovering `@plugins` reports `title=@plugins`.<br>• 0 event texts truncate. | `logs/pass4.json` `codeWrapped:[]`, `codeNoTitle:[]`, `lineH:[24]`, `evTrunc:[]`; `logs/pass5.json` `hoverTitle` |

## Regression checks

| Check | Result | Evidence |
|---|---|---|
| Rail columns line up | **Pass.** Dot, name, code, state and event all have a left-edge spread of 0 across 11 lines and across 35 with the fold open, at 1920 and 3200@1.2, dark and light. One template per line (`distinct=1`). Age is right-aligned, so its spread is 7px with equal right edges, as before. | `logs/pass3.json` |
| No event truncation, 1920 slack | **Pass.** 0 truncated. The tightest line is Desk at 1920 with 3.1px of slack. It is 208px at 3200. | `logs/pass5.json` `minSlack`, `logs/pass6.json` `1920-asBuilt` |
| Stacked order (1366/1600) | **Pass.** `before`/`before`. Off-screen starts at y=1626 and the strip at y=1954. At 1600, 4 cards are full and 5 started. At 1366, 3 are full and 4 started. | `logs/pass1.json` |
| Tab order | **Pass.** At 1920 and 1600: DESK → FEED → OFFSCREEN → STRIP → BAR → body → SIDEBAR. | `logs/pass2.json` `focus1920`, `focus1600` |
| Stacked scroll cue | **Pass.** The fade shows at the top and in the middle and hides at the bottom (scrollTop 185/185 at 1600, 231/231 at 1366). The sticky `VibeSquad` head stays pinned mid-scroll, and the fade ends on the page background in both themes. In stacked mode, chips stay unconstrained and show in full (`@art-direction`). | `logs/pass2.json` `stacked-*`; `r42-dark-1600-strip-mid.png`, `r42-light-1600-strip-quiet-open.png` |
| No fade in rail mode; rail wider than 580 at 3200 | **Pass.** The fade is absent. The rail is 880px at 3200 and 674px at 1920. | `logs/pass1.json`, `logs/pass2.json` `quiet3200` |
| Lean opt-in and URL writes | **Pass.** Unchanged from R41. | `logs/pass2.json` `lean`, `freshViewDecisions` |

## Findings

### Minor 1 · Every 8-character lane code is ellipsized by 0.8px, so most rail chips read as fragments
- **Job hurt:**
  - 2 (monitor), lightly: the lane name next to the chip still identifies the lane.
  - 5 (intervene): the chip is the `@handle` the owner types, and `@plugi…` or `@ui-bo…` makes them hover to read it.
- **Scope:** 21 of the 32 distinct codes are cut at both rail sizes.
  - Every 8-character code is cut (`@plugins`, `@ui-bois`, `@lane-10` to `@lane-24`). Each needs 52.8px against a 52px content box.
  - The 4 long ones are cut too (`@art-direction`, `@runner-pilot`, `@main-game`, `@site-polish`), which is expected.
  - Only codes of 7 characters or fewer fit (`@wiki`, `@ui-lab`, `@lane-1` to `@lane-9`).
  - Real lane codes are mostly 3 or 4 letters (`@bug`, `@desk`), so the owner's live rail hits this less than the `?lanes=24` demo does. That is why this is a minor and not a major.
- **Evidence:**
  - `logs/pass5.json` `ellipsized`, `needs` (`@plugins=52.8` against `box` 52).
  - In `r42-dark-3200-rail-strip.png` and `r42-light-1920-rail-strip.png`, the chips read `@plugi…`, `@ui-bo…`, `@art-d…` and `@runne…`.
- **Cause:** `src/boring.css:2290-2292` caps the slot at `max-width: 62px`. The chip keeps its base `padding: 0 5px` and a 1px border from `src/boring.css:1808`, which leaves 52px for text. An 11px JetBrains Mono character is 6.6px wide, so 8 characters need 52.8px.
- **Fix:** add `padding-inline: 4px` to `.is-wide .boring-decision-code` (`src/boring.css:2293`).
  - I tested this in the page (`logs/pass6.json` `pad4`): ellipsized chips drop from 21 to 4, event slack at 1920 stays 3.1px, event truncation stays 0, and lines stay 24px.
  - Raising the cap to 63 or 64px also gets to 4, but it costs 1 to 2px of the 1920 Desk event's 3px slack (`slot63`, `slot64`; `r42-dark-1920-candidate-slot64.png`). Padding is the better lever.
  - Extend the P2b r3 e2e block (`test/desk-d4-decision-desk-e2e.test.mjs`) to assert that an 8-character code is not ellipsized. Compare the text range width with the content box, not `scrollWidth`: `scrollWidth > clientWidth + 1` misses a 0.8px overflow.
- **Effort:** XS.

## Judgement: do 62px chips with an ellipsis read OK?
- **Yes for the long codes.** `@art-d…` sits next to `Art Direction` and `@runne…` next to `Runner Pilot`, so the name carries identity, and `title=` gives the full handle on hover (the owner's 4K desktop has a mouse).
- **Not yet for the common case.** When most chips are cut, the column reads as noise. With the 4px padding fix, only codes of 9 or more characters ellipsize, and that is a good trade for keeping the 1920 event whole.

## Notes (not findings)
- The R38/R39 notes stand: Main Game reads `needs you` with no count, and Tab reaches `body` once between the send bar and the sidebar.
- r3 touched only the Decision Desk rail (`git show --stat 2b2c2188`: `BoringDecisionDesk.tsx` +1/−1, `boring.css`, and tests). The sidebar, Needs-you and `?agent=` sequences were not re-driven.

## Owner decisions
None new.

## Inbox cards for @desk
- **m1 (R42):** 8-character rail codes are ellipsized by 0.8px. Add `padding-inline: 4px` to `.is-wide .boring-decision-code` at `src/boring.css:2293`, and add an e2e check that 8-character codes are not ellipsized, using range width rather than `scrollWidth`.
