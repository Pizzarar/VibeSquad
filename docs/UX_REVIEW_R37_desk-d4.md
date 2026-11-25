# VibeSquad UX review, round 37: @desk D4 Decision Desk

Date: 2026-11-25 · Build: `desk-d4-decision-desk` @ `d2a832c2` · Spec: `docs/PLAN_DESK_DECISION_DESK.md` (D4 row and done-check 5) · Previous @desk gate: `docs/UX_REVIEW_R36_desk-u3.md` (PASS 0/0/0, U3 only)

**Verdict: FAIL 0/2/4** (critical/major/minor)

The page reads well in both themes and at both sizes. The batch, Undo and Back/Forward flows work. Two problems remain in the page's main job, "ok yeah that, that, not that":
- **M1:** an untouched lean looks selected and is announced as pressed, but it isn't sent.
- **M2:** the status strip scales with lane count and pushes the decisions below the fold.

## Setup
- **Build and test:** `npm run build`, then `node --test test/desk-d4-decision-desk-e2e.test.mjs`. Result: 4/4 pass (dark/light × 1920 and 3200@1.2), 0 fail.
- **Drivers:** `docs/ux-review-r37/drive/`.
  - `mock.mjs`: the e2e's 12-item, 3-Squad mock backend, copied verbatim.
  - `pass1.mjs`: landing metrics and screenshots for the 4 configs.
  - `pass2.mjs`: lean semantics, Undo, the off-screen strip, and 6 history sequences.
  - `pass3.mjs`: strip pitch, font sizes, a strip-line click and a valid `?agent=` deep link.
- **Servers:** ports 5937–5939, all closed when each script exited.
- **Page errors:** 0 in every run.
- **Viewports:** 1920×1080 @1, and 3200×1800 @1.2 (the owner's 4K at 120%), each in dark and light.

## Status vs the previous round
R36 covered U3 only (the Needs-you location line). Nothing in R36 is reopened. The Needs-you section still reads `Needs you 5` = 5 rows, with `Done recently · 4` (`r37-dark-1920-landing.png`). This is the first gate for D4.

## What passes

| Check | Result | Evidence |
|---|---|---|
| Default landing | **Pass.** A bare `/?demo=` lands on `?view=decisions`. The breadcrumb reads `Decision Desk` and the `Decisions · 12` entry is highlighted. | `logs/pass1-*.json` (`url: "?demo=&view=decisions"`), `r37-*-landing.png` |
| Landing vs Back/Forward | **Pass.** Landing is applied with `replaceState` only, so it never adds a history entry. <br>• `?team=vibesquad` and `?team=vibesquad&agent=demo-rev` deep links are kept: landing doesn't hijack them. <br>• Sequences that return to the Desk with one POP and no push: Needs-you click → Back → Forward → Back; project A → B → Back → Back; Ctrl+J → Back. <br>• Decisions nav → Back → Forward → reload keeps `?view=decisions`. | `logs/pass2.json` (`landing-needs-back`, `proj-a-b-back2`, `ctrlj`, `team-url`), `logs/pass3.json` `deeplink` |
| Readability | **Pass.** <br>• Text sizes: the ask is 14px, choices, "Decides" and strip events are 13px, and meta (age, `@lane`, state) is 11px mono. At 120% that is 13–17 physical px. <br>• Contrast: in dark, the text on `#1d1d26` cards is `rgb(243,241,247)` for primary and `rgb(195,192,207)` for secondary. In light it is `rgb(29,26,36)` and `rgb(74,69,88)`. <br>• The Hypnospace gradient sits behind the opaque cards only. | `logs/pass3.json` `sample`, `r37-{dark,light}-3200-crop.png` |
| The lean is obvious | **Pass.** It's the first chip in a row, has a `LEAN` tag, an accent border and a tint. `Not that` is always the last chip. | `r37-dark-1920-landing.png` |
| Flipping is clear once staged | **Pass.** A staged lean is a solid accent chip with `✓ Lean`. A staged `Not that` is a red outline. Flipping moves the stage, so the count stays at 6. | `r37-dark-1920-useall-then-not.png`, `r37-dark-1920-undo.png` |
| Batch + 5s Undo | **Pass.** `Send 6 answers` → `Sending 6 answers in 5s…` with Undo and Send now. Undo dispatches 0 prompts, and the e2e checks that 3 prompts land after 5s. | `r37-dark-1920-undo.png`, `logs/pass2.json` `afterUndo.delivered: 0` |
| Off-screen strip | **Pass.** Release, playtest and money items sit in their own amber-edged strip. Each has Mark done and Dismiss, its Squad name, and the full ask + Decides. | `r37-dark-1920-offscreen.png` |
| Strip fits at demo size | **Pass** for 11 lanes: the strip is 518px tall (y 127–645) and nothing is cut. See M2 for real lane counts. | `logs/pass1-dark-1920.json` (`n: 11`, `trunc: 0`) |
| Selection | **Pass.** Exactly one sidebar entry (`Decisions`) is highlighted on the Desk. The breadcrumb matches the page. | `r37-*-landing.png` |

## Findings

### M1 · Major: an untouched lean looks chosen but isn't sent
- **Job hurt:** 3 (respond when something needs me). This is the page's core interaction: "flip what I disagree with, send the batch".
- **Evidence:**
  - **On load:** every lean chip has `aria-pressed="true"` and class `selected` (accent border, 12% accent tint), and the button reads `Send 0 answers`. `logs/pass2.json` `initial`.
  - **After the e2e's own flow (flip 2, answer 1):** the button says `Send 3 answers`. The 4 untouched leans keep their "selected" look but stay open. They only send after a separate `Use all leans (6)` click.
  - **What the owner sees:** at a glance, a lean the owner left alone looks like a choice already made. Screen readers announce it as pressed.
- **Cause:** `src/BoringDecisionDesk.tsx:643` sets `leanSelected = !sel || sel.choice === "lean"`. That drives `selected` and `aria-pressed` at `:683-685`, while `buildAnswerBatch` (`:120`) counts only `staged` entries. Styling is at `src/boring.css:1999-2002`.
- **The spec contradicts itself:** the D4 row says "lean pre-selected", but done-check 5 expects `Send 3 answers` after flipping 2 + answering 1. That count is only right if leans are *not* pre-selected.
- **Fix (pick one; the choice is Owner decision 1):**
  - **(a) Truly pre-select.** Stage every lean on load, so the button reads `Send 9 answers` (6 yes/no + 3 still empty). Drop `Use all leans`, and update the done-check to "flip 2 + answer 1 → Send 7".
  - **(b) Explicit opt-in (recommended).** An unstaged lean renders as a *suggestion*: dashed accent border, no tint, `aria-pressed="false"`, `LEAN` tag kept. The send bar spells out the gap: `Send 3 answers · 4 leans not included` next to `Use all leans (4)`.
- **Files:** `src/BoringDecisionDesk.tsx`, `src/boring.css`, `test/desk-d4-decision-desk*.test.mjs`. **Effort:** S.

### M2 · Major: the status strip grows with lane count and pushes the decisions below the fold
- **Job hurt:** 3 on every landing, and 2 (monitor).
- **Evidence:**
  - **Measured on the demo at 1920×1080:** 11 lane lines at a 32px pitch, plus ~50px per Squad header, make the strip 518px tall (y 127–645). The `Decisions` heading is at y=674. Only 2 decision cards are above the sticky send bar, and the second is cut off.
  - **Quiet lines:** 6 of the 11 lines say `No recent done/decision · idle`. `logs/pass3.json` `pitch`, `r37-dark-1920-landing.png`.
  - **Projected (not rendered; the strip's lanes come from the `?demo` cast):** VibeSquad alone has 13 lane docs (`docs/lanes/`). With 13 lanes + Desk in that Squad, the strip grows by about 8 × 32 = 256px, so its bottom lands near y≈900. The feed heading then lands near y≈930, and no decision card is visible above the send bar at 1080. With more Squads, the strip itself runs past the viewport. That breaks done-check 5 ("every lane visible without leaving the page") at the owner's real scale.
  - **Width:** at 3200 the page uses an 813px column out of a 2820px main area (`.boring-decision-desk` `max-width: 1120px`, `src/boring.css:1651-1652`, renders at 813). So there is room the strip doesn't use.
- **Fix:**
  - Fold idle lanes with no event in the last 2h into one `+N quiet` line per Squad (click to expand).
  - Put lanes with open decisions or `needs you` first.
  - When the main area is ≥ ~1600px, put the strip in a right rail next to the feed. At 3200 everything fits on one screen.
  - Optionally, cut the line pitch to ~26px.
  - Add an e2e case with ≥ 20 lanes that asserts the strip's bottom is above `innerHeight` and that ≥ 1 decision card is above the fold at 1920×1080.
- **Files:** `src/BoringDecisionDesk.tsx` (`buildStatusStrip`, `:165`; render, `:575-600`), `src/boring.css` (`.boring-decision-strip*`, `:1765`). **Effort:** M.

### m1 · Minor: strip says `idle` for lanes waiting on an open decision
- **Evidence:** `UI Bois`, `Plugins`, `Runner Pilot` and `Art Direction` each have an open item in the feed, but their strip line reads `idle`. Only `Main Game` reads `needs you`, which comes from the demo's attention state. So the strip and the feed disagree about who is waiting on the owner (`r37-dark-1920-landing.png`).
- **Fix:** if a lane has open feed items, show `N to decide` in the state column (amber). Clicking it scrolls to that lane's first card.
- **Files:** `src/BoringDecisionDesk.tsx` (`buildStatusStrip`). **Effort:** XS.

### m2 · Minor: the three counts don't explain each other
- **Evidence:** the sidebar shows `Decisions · 12`, the header says `12 open across 3 Squads`, and the feed heading reads `Oldest first · 9`. The off-screen strip shows `3` near the bottom of the page, where the owner only sees it after scrolling. The sums are right, but nothing on the first screen says 12 = 9 + 3. Right below, `Needs you 5` counts a different set (permissions and stalls), with no hint of that.
- **Fix:**
  - Header: `12 open · 9 here · 3 off-screen`, where the last part is a link to the strip.
  - Give the `Needs you` heading a tooltip: "Permissions, errors and stalls — decisions live in Decisions".
- **Effort:** XS.

### m3 · Minor: on landing, the URL briefly reads the first project before the Desk
- **Evidence:** a bare load records `replaceState /?demo=&team=efi` and then `replaceState /?demo=&view=decisions` (`logs/pass2.json` `landing-needs-back`). This doesn't affect history, but for one frame the URL and state point at a project. Any listener that reacts to `team=` in between can act on the wrong page.
- **Fix:** decide on `view=decisions` before the first-project fallback writes the URL.
- **Files:** `src/BoringAde.tsx` / `src/App.tsx` landing wiring. **Effort:** XS.

### m4 · Minor: the title is duplicated and the top of the page is airy
- **Evidence:** `Decision Desk` appears in both the topbar breadcrumb and the 20px page H1. The `Refresh` button sits alone at the top right. Together they take about 80px before `LIVE STATUS` (`r37-dark-1920-landing.png`).
- **Fix:** drop the H1, and move `12 open …` and `Refresh` onto the `LIVE STATUS` row. This also recovers space for M2.
- **Effort:** XS.

## Coverage notes (not findings)
- **Data sources don't share agents:** the feed is the e2e mock backend, and the sidebar Needs-you and the strip come from the `?demo` cast. So "badge = feed = Needs you" can only be checked as sums here, not item by item.
  - The D2 rule that agent `needs-you` labels (for example, `Review - Sonnet · drawer: pick option A or B`) also show up in the feed isn't exercised.
  - On real data, such an agent would appear twice on screen (Needs you + feed), which is within the ≤2 invariant.
- **Ctrl+K "decision":** typing `decision` in the palette from a project page doesn't navigate until a result is chosen, and I didn't check which entry it offers.

## Owner decisions
1. **Should untouched leans send automatically?** The plan says "pre-selected" and the owner's words say "that, that, not that". But merges, releases and money calls are among these rows.
   - **Recommendation:** (b) explicit opt-in. Show untouched leans as suggestions, and make `Use all leans (N)` the one-click "yes to the rest".
   - **Why:** an unread lean should never ship a merge.
   - **If you want (a):** the D4 done-check count changes from 3 to 7.
2. **Strip placement at 4K:** a right rail at wide widths versus a collapsible strip on top. **Recommendation:** the right rail at ≥ 1600px main width, folded quiet lanes everywhere (M2).

## Inbox cards for @desk
- M1: `boring-decision-choice is-lean` shows as pressed while unstaged (`BoringDecisionDesk.tsx:643/683-685`). Pick (a)/(b) after Owner decision 1.
- M2: the strip height scales with lanes and the feed falls below the fold at 1920. Fold quiet lanes, add a right rail at wide widths, add an e2e case with ≥ 20 lanes.
- m1–m4 as above.
