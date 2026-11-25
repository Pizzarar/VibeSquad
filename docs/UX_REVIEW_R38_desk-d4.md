# VibeSquad UX review, round 38: @desk D4 Decision Desk re-gate

Date: 2026-11-25 · Build: `desk-d4-decision-desk` @ `1d4c9a8a` (D4 r2, the R37 fixes) · Previous: `docs/UX_REVIEW_R37_desk-d4.md` (FAIL 0/2/4)

**Verdict: PASS 0/0/4** (critical/major/minor)

Both majors are closed:
- **Leans:** an untouched lean now looks like a suggestion and is announced as one.
- **Status strip:** it moves to a right rail beside the feed and folds quiet lanes. At 1920×1080, 5 decision cards sit above the send bar.

The 4 open minors are polish. One is the m3 URL flash, which is only half fixed.

## Setup
- **Build and tests:** `npm run build`, then `node --test test/desk-d4-decision-desk-e2e.test.mjs test/desk-d4-decision-desk.test.mjs`. Result: 15/15 pass. That includes the new cases "20+ lanes → card above the fold at 1920" and "right rail at 3200".
- **Drivers:** `docs/ux-review-r38/drive/`.
  - `mock.mjs` is R37's 12-item, 3-Squad mock backend.
  - `pass1.mjs` measures landing at 4 configs, each with and without `?lanes=24`.
  - `pass2.mjs` covers lean semantics, Send + Undo, the badge after Send, the quiet expand, narrow viewports, and 6 history sequences.
  - `pass3.mjs` covers a fresh `?view=decisions` load, the `?agent=` deep link, and the selection count.
  - Logs are in `docs/ux-review-r38/logs/`.
- **Servers:** ports 5947–5949. Each script closed its server on exit.
- **Page errors:** 0 in every run.
- **Viewports:** 1920×1080 @1, and 3200×1800 @1.2 (the owner's 4K at 120%), each in dark and light. Also 1600×900 and 1366×768, for coverage only.

## Status vs R37

| R37 finding | R38 | Evidence |
|---|---|---|
| **M1:** an untouched lean looks chosen | **Fixed.** <br>• On load, the lean chip has `aria-pressed="false"`, class `is-lean suggested`, a dashed border and a transparent background. <br>• The bar reads `6 leans not included. Tap a lean, pick an option, or type an answer.`, with `Use all leans (6)` and a disabled `Send 0 answers`. <br>• Tapping a lean gives `✓ Lean`, `aria-pressed="true"` and `1 ready to send · 5 leans not included`. Tapping it again un-stages it. <br>• The done-check flow (flip 2, answer 1) gives `3 ready to send · 4 leans not included` and `Send 3 answers`. <br>• `Use all leans` then gives `Send 7 answers`. | `logs/pass2.json` (`initial`, `leanClick`, `leanUnclick`, `flip2answer1`, `useAll`), `r38-dark-1920-staged3.png`, `r38-dark-1920-useall.png` |
| **M2:** the strip pushes the feed below the fold | **Fixed at the owner's sizes.** <br>• The rail is on at a viewport of 1900px or more, so the feed and strip sit side by side at both 1920 and 3200. <br>• `?lanes=24` gives `35 lanes` in the meta, 11 visible lines and `+24 quiet`. The strip doesn't grow. <br>• At 1920×1080 the first card is at y=204; 5 cards are fully above the send bar (top at 1033) and 6 start above it. At 3200@1.2 all 9 cards are above it. <br>• Expanding the quiet fold to 35 lines makes the rail 940px tall (bottom at 1072), and the feed doesn't move. <br>• Below 1900 see n3. | `logs/pass1.json` (`cardsAbove`, `strip`, `quietBtns`), `logs/pass2.json` `quietOpen`, `r38-*-lanes24-landing.png`, `r38-light-1920-lanes24-quiet-open.png` |
| **m1:** the strip says `idle` when a lane is waiting | **Fixed.** Plugins, UI Bois, Art Direction and Runner Pilot read `waiting · 1`, UI Lab reads `waiting · 2`, and Site Polish reads `waiting · 4`. All are amber. | `r38-dark-1920-landing.png` |
| **m2:** the counts don't explain each other | **Fixed.** <br>• The header reads `12 open · 9 here · 3 off-screen`, followed by a `jump to off-screen` link. <br>• The `Needs you` heading has the tooltip `Permissions, errors and stalls. Decisions live in Decisions.` | `logs/pass1.json` (`summary`, `needsTitle`) |
| **m3:** landing flashes `?team=` | **Partly fixed, so it stays open as minor 1 below.** <br>• A bare `/?demo=` now does a single `replaceState /?demo=&view=decisions`. <br>• A fresh load or reload of `?view=decisions` still writes `replaceState /?demo=&team=efi` first. | `logs/pass3.json` `fresh-view-decisions`, `logs/pass2.json` `team-url` (reload step) |
| **m4:** title and spacing | **Fixed.** There is no H1 (`h1: 0`); only the breadcrumb says `Decision Desk`. The summary and `Refresh` share one row, and `DECISIONS` starts at y=141. | `r38-dark-1920-landing.png` |

## Regression checks

| Check | Result | Evidence |
|---|---|---|
| Badge = feed | **Pass.** <br>• Before sending: `Decisions · 12`, which is 9 cards + 3 off-screen. <br>• After sending 7 with the 5s Undo: 7 prompts are delivered, the badge reads `Decisions · 5`, and the summary reads `5 open · 2 here · 3 off-screen` (2 cards). <br>• The bar reads `Sent 7 answers.` | `logs/pass2.json` `afterSend`, `r38-dark-1920-after-send.png` |
| Back/Forward/reload with `?view=decisions` | **Pass.** <br>• Needs-you click → Back → Forward → Back: each step is one POP and the Desk comes back. <br>• Project A → B → Back → Back reaches the Desk, and Forward reaches A. <br>• Ctrl+J → Back. <br>• Strip-line click (it opens the lane lead) → Back. <br>• `?team=vibesquad` → Decisions → Back → Forward → reload keeps the Desk, and Back after the reload returns to the team. | `logs/pass2.json` (all `tr` arrays), `r38-seq-*.png` |
| Reload with another view | **Pass.** `?team=efi` and `?team=vibesquad&agent=demo-rev` reload into the same view; landing doesn't hijack them. | `logs/pass2.json` `proj-a-b-back2` (reload), `landing-needs-back` (reload) |
| `?agent=` deep link | **Pass.** `?team=vibesquad&agent=demo-rev` opens that worker, highlights its row and makes no history write. | `logs/pass3.json` `deeplink`, `r38-dark-1920-deeplink-agent.png` |
| Exactly one selected row | **Pass.** <br>• On the Desk the only highlighted row is `boring-decision-nav on`. <br>• On a project, only `boring-project-row on :: Site` is highlighted, and the breadcrumb reads `Site`. | `logs/pass3.json` (`desk-selection`, `project-selection`) |
| Light theme | **Pass.** The rail, dashed suggestion chips and amber `waiting` text read clearly. | `r38-light-1920-*.png`, `r38-light-3200-*.png` |

## Findings

### Minor 1 · A fresh load of `?view=decisions` still flashes the first project in the URL (R37 m3, partly fixed)
- **Job hurt:** 3. This happens on every reload and bookmark of the Desk.
- **Evidence:** a new tab on `/?demo=&view=decisions` records `replaceState /?demo=&team=efi`, then `replaceState /?demo=&view=decisions` (`logs/pass3.json` `fresh-view-decisions`). A reload in the `team-url` sequence does the same. History isn't affected.
- **Cause:** at `src/App.tsx:1895`, `deskLandingPending` excludes `u.view === "decisions"`. That turns the guard off in exactly the case where the Desk is named in the URL.
- **Fix:** drop the `u.view !== "decisions"` clause. The guard already clears once `boringDecisionView` is true, at `:1908`.
- **Effort:** XS.

### Minor 2 · The rail cuts off event text even at 3200
- **Job hurt:** 2 (monitor).
- **Evidence:** event text is truncated on 10 of 11 strip lines at both 1920 and 3200, for example `Nightly build gr…` and `Standardiz…`. At 3200@1.2 the whole page is about 1250px wide inside a main area of about 2800px (`r38-dark-3200-lanes24-landing.png`). The full text is in `title=`, so it is reachable on hover.
- **Cause:** `src/boring.css:2212` sets `grid-template-columns: minmax(0, 1fr) minmax(500px, 580px)`, which caps the rail at 580px. On top of that, the wrap/desk render narrower than the 2000px `max-width`.
- **Fix:** let the rail grow, for example `minmax(500px, 0.8fr)`, at wide widths, or give the event column the space the name and `@code` columns don't use.
- **Effort:** XS.

### Minor 3 · The strip and the feed list Squads in different orders
- **Evidence:**
  - The feed lists VibeSquad → Main Game Project → Site.
  - The strip lists Main Game Project → Site → VibeSquad (`r38-dark-1920-landing.png`).
  - The owner's eye goes from a card across to its lane line, so the mismatch slows that scan.
- **Fix:** order the strip groups the same way as `groupFeedBySquad`, or put Squads with open items first.
- **Files:** `src/BoringDecisionDesk.tsx` (`buildStatusStrip`, `:228`). **Effort:** XS.

### Minor 4 · Below the 1900px rail threshold, the stacked strip still costs the fold
- **Evidence:** both runs use `?lanes=24`, with the strip folded and stacked on top of the feed.
  - At 1600×900, only 1 card is above the send bar.
  - At 1366×768, no cards are above it (`logs/pass2.json` `narrow1600`, `narrow1366`).
- **Why it's minor:** this isn't one of the owner's sizes. 4K at 120% gives 3200 CSS px, and even half of that is 1600×1800, which is tall.
- **Cause:** at `src/BoringDecisionDesk.tsx:31` the rail is gated on viewport width (`DECISION_RAIL_QUERY`), not on main-area width.
- **Fix:** when the strip is stacked, cap it to about 30vh with its own scroll, or put the feed first and the strip below it.
- **Effort:** S.

## Notes (not findings)
- **Main Game's count:** its strip line reads `needs you` without a count, even though 2 Main Game items are open. That's because `needs-you` takes precedence over `waiting · N` (`BoringDecisionDesk.tsx:641`). `needs you · 2` would be more consistent.
- **Deep link without a team:** `?demo=&agent=demo-rev` with no `team=` writes `team=efi&agent=demo-rev` before it settles on `team=vibesquad`. This predates D4 and is the same class of flash as minor 1.
- **Data sources:** the feed still comes from the mock backend, while the strip and Needs-you come from the `?demo` cast. So the R37 coverage note about sums versus item-by-item checks still applies.

## Owner decisions
1. **Do untouched leans send automatically?** This is still pending from R37. The build implements **(b), opt-in**, which was the R37 recommendation, and it works as designed.
   - **Recommendation:** keep (b).
   - **If you pick (a):** `Use all leans` is dropped and the D4 done-check count changes.

## Inbox cards for @desk
- **m1:** `App.tsx:1895`. Drop the `u.view !== "decisions"` exclusion so a fresh `?view=decisions` load has no `team=` flash.
- **m2:** the rail is capped at 580px (`boring.css:2212`) and event text is truncated at 3200. Let the rail grow.
- **m3:** sort strip Squads in feed order.
- **m4:** below 1900px, cap the stacked strip's height or put the feed first.
