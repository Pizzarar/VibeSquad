# VibeSquad UX review, round 43: @desk P3 lane empty card URL

Date: 2026-11-26 · Build: `desk-p3-empty-card-url` @ `f80b6a2c` · Previous: `docs/UX_REVIEW_R42_desk-p2b.md` (PASS 0/0/1, a different unit)

**Verdict: PASS 0/0/2** (critical/major/minor)

- A lane's empty card now has its own URL, and Back, Forward and reload all land on it. Each click is one `pushState`, Back and Forward push nothing, and no frame shows the Overview or another lane during a transition. Checked in dark and light, at 1600x900 and 1920x1080, with a spot check at 3200x1800@1.2.
- The selected sidebar row, the breadcrumb and the card heading agree in every step. There is exactly one selected row.
- No regressions: Desk slots (`?slot=`), the Overview tabs (`?tab=`), `?agent=`, `?view=decisions` and the split picker (B17) behave as before. The split's right-pane card writes no URL.
- 2 minors:
  - m1: the Overview's **Lead** cell on a lane with no Lead opens that lane's Brainstorm chat, while the topbar `Lead · none` pill opens the Lead card. The same intent gets two different results.
  - m2: `?slot=bugs&role=lead` on a project with no Bugs agent drops `role=lead` from the URL, but the breadcrumb still says `Bugs › Lead`.

## Setup
- **Build:** `npm run build`, then `public/THIRD-PARTY-LICENSES.txt` was restored.
- **Drivers:** `docs/ux-review-r43/drive/`. The mock backend is the R42 copy. `lib.mjs` wraps `pushState` and `replaceState`, and logs a per-frame screen signature (card heading and breadcrumb) on every `requestAnimationFrame`. That log is how a flash would be caught.
  - `pass1`: the Runner Pilot card from the Overview, then Back, Forward and reload. Also the Bug Chaser Lead/Brainstorm cells (`?riff=1`).
  - `pass2`: the topbar Lead pill, card chips and CTA, plus the slot, tab, decisions and agent regressions.
  - `pass3`: Main Game Desk slots, and the split picker's right-pane lane card.
  - `pass4`: deep-link edge cases and the 3200 shot.
- **Logs:** `docs/ux-review-r43/logs/`. There were 0 page errors in every run.
- **Fresh-eyes order:** I read no plan before the first pass. Afterwards I read only the P3 e2e test, to find the `?riff=1` fixture.

## Status vs R42

R42 reviewed a different unit (P2b rail chips). Its m1, the 8-character rail codes ellipsized by 0.8px, is out of scope here and was not re-checked (`git diff 7eea07eb f80b6a2c --stat` touches no CSS).

## What was checked

| Sequence | Result | Evidence |
|---|---|---|
| Overview → Runner Pilot **Brainstorm** cell (Lead idle, no Brainstorm) | **Pass.**<br>• 1 push, to `?demo=&team=vibesquad&lane=runner-pilot`.<br>• Card: `Runner Pilot · Lead idle · no Brainstorm`.<br>• Breadcrumb: `VibeSquad › Runner Pilot › Brainstorm`.<br>• Selected row: the `Runner Pilot` lane row, and only that one. | `logs/pass1.json`; `r43-dark-1920-A-card.png` |
| Elsewhere (Main Game Overview) → Back → Forward → Back → reload | **Pass, in all 4 theme/size combinations.**<br>• Back, Forward and Back again each produce `POP` only, with `history.length` unchanged.<br>• Frames go straight from the card to the Overview and back, with no in-between screen.<br>• Reload makes no history call. Its frames are `@ -` (blank boot), then the card. The Overview never flashes. | `logs/pass1.json` `frames`; `r43-light-1920-A-reload.png` |
| Bug Chaser chat → topbar `Lead · none` pill (`?riff=1`) | **Pass.**<br>• 1 push, to `…&lane=bug-chaser&role=lead`.<br>• Card: `Bug Chaser · Brainstorm ready · no Lead`.<br>• Breadcrumb: `… › Bug Chaser › Lead`.<br>• Back returns to the Brainstorm chat, Forward to the card, and reload keeps the card. | `logs/pass2.json`; `r43-light-1600-leadpill-card.png`, `r43-dark-1920-B-leadcard.png` |
| Card chips and CTA (`Brainstorm Idle`, `Switch to Brainstorm`, `Lead Idle`) | **Pass.** Each is one push to the agent's `?agent=`, and Back returns to the card. | `logs/pass2.json` |
| Runner Pilot: Lead pill ↔ Brainstorm pill | **Pass.** Lead pill → `?agent=demo-lead-runner`. Brainstorm pill → `?lane=runner-pilot`, which is the card. | `logs/pass2.json` |
| Desk slots on Main Game (no Overlord or RiffBot): Overlord → RiffBot → Bugs, then Back ×3, Forward, reload | **Pass.**<br>• `?slot=overlord`, then `riffbot`, then `bugs`: one push each.<br>• Back walks `riffbot` → `overlord` → the Runner Pilot lane card.<br>• Reload keeps `?slot=overlord`. | `logs/pass3.json` |
| Overview tabs, `?view=decisions`, Needs-you → `?agent=` | **Pass.**<br>• `?tab=inbox` and `?tab=standup` push once each, and Back walks them.<br>• Decisions → Back returns to the lane card.<br>• Agent → Back returns to the lane card, and Forward returns to the agent. | `logs/pass2.json` |
| Split picker: Runner Pilot `Buddy (not running)` in the right pane | **Pass (intended).**<br>• The right pane shows the lane's card, and the URL stays `?agent=demo-lead-runner` with **no** history call.<br>• `← All lanes` and `Close split` also write nothing. | `logs/pass3.json`; `r43-dark-1920-split-rightcard.png` |
| Deep-link edges | **Pass.**<br>• `lane=nope`, another project's lane (`team=efi&lane=runner-pilot`) and the Desk's own lane (`lane=vibesquad`) all land on that project's Overview, with the URL cleaned.<br>• `lane=runner-pilot&role=lead`, where the lane has a Lead, opens that Lead (`?agent=demo-lead-runner`). | `logs/pass4.json` |
| Address bar | **Reads sensibly.** `?team=vibesquad&lane=runner-pilot` and `…&role=lead` are short and stable. Key order is canonical (`team`, then `lane`, then `role`). | all logs |
| 3200x1800@1.2 | The card renders, with the same state as at 1920. (The shot is downscaled to 50% to keep the evidence small.) | `r43-dark-3200-A-card.png`, `logs/pass4.json` |

## Findings

### Minor 1 · The Overview's Lead cell on a lane with no Lead opens the Brainstorm chat, not the Lead card
- **Job hurt:** 1 (start work: Brainstorm → hand off to a Lead) and 2 (monitor). The owner clicks `—` under **LEAD** to see where the Lead stands, and lands in a Brainstorm chat.
  - The breadcrumb honestly says `Bug Chaser › Brainstorm`, so the owner isn't lost.
  - But the click doesn't do what the column says. The same intent from the topbar `Lead · none` pill shows the `Brainstorm ready · no Lead` card instead, which explains the state and offers `Switch to Brainstorm`.
- **How a user reaches the Lead card today:**
  1. Open the lane, which lands on its Brainstorm.
  2. Click the topbar `Lead · none` pill.

  The pill is the only in-app path. The Overview Lead cell, the sidebar lane row and the split picker all go elsewhere, and the Overview cell is the one the owner is most likely to try.
- **Is it confusing?** Mildly. Landing on the Brainstorm is useful, because that is where the handoff happens. But it hides the "no Lead yet" fact that the card states. Because the breadcrumb is correct, this is a minor and not a major.
- **Evidence:** `logs/pass1.json` step `Bug Chaser Lead cell (no Lead)`: URL `…&agent=demo-bugs`, breadcrumb `VibeSquad › Bug Chaser › Brainstorm`. Compare `logs/pass2.json` step `topbar Lead · none pill`: `…&lane=bug-chaser&role=lead`, card shown. Screenshot `r43-dark-1920-B-leadcell.png`.
- **Cause:**
  - `src/BoringAde.tsx:1346`: the Lead cell calls `openTarget(view, c.pin, c.laneId, { role: "lead", agentId: null })`.
  - That reaches `pickRole` (`src/BoringAde.tsx:590-598`), which falls back to `void onOpenPin(pin)` when `pin.lead` is missing. From the Overview, that opens the pin's live Brainstorm agent.
  - From an open Brainstorm chat, the same call leaves the pane on the Lead card. That is why the pill works.
- **Fix:** when the Lead cell's lane has no Lead, select the lane with role `lead` and no agent, the same screen the pill reaches. The URL becomes `?lane=<id>&role=lead`. Keep `onOpenPin` for the Brainstorm cell. Add an e2e step: Overview → Bug Chaser Lead cell → `laneHead == "Bug Chaser · Brainstorm ready · no Lead"`.
- **Files:** `src/BoringAde.tsx` (`go("lead")` at :1346 or `pickRole` at :598), `test/desk-nav-history-e2e.test.mjs`.
- **Effort:** S.

### Minor 2 · `?slot=bugs&role=lead` on a project with no Bugs agent: the URL drops `role=lead` but the breadcrumb says Lead
- **Job hurt:** 2 (monitor), and only through a shared or hand-typed link. Reloading the cleaned URL shows `Bugs › Brainstorm`, so this screen is not reload-stable.
- **Evidence:** `logs/pass4.json`: `?demo=&team=efi&slot=bugs&role=lead` loads with the URL `?demo=&team=efi&slot=bugs` and the breadcrumb `Main Game Project › Bugs › Lead`.
- **Cause:** `urlRole` requires `currentPin` (`src/BoringAde.tsx`, the P3 hunk `const urlRole = (urlLane || urlSlot === "bugs") && currentPin && selectedRole === "lead" ? …`). Main Game has no Bugs pin, so the role is never written. The landing code (`land.role`) still sets `selectedRole = "lead"`.
- **Fix:** make the two agree. Either reset `selectedRole` to `brainstorm` when `?slot=bugs&role=lead` has no Bugs pin, or drop the `currentPin` condition for the Bugs slot. The first is simpler, because a Bugs slot with no agent has no meaningful Lead vs Brainstorm split. Add a unit case.
- **Effort:** XS.

## Notes (not findings, pre-existing)
- **Lead card chip status:** on the Lead card, the `Available in this lane` chip reads `Brainstorm Idle` with a hollow ring, while that Brainstorm (`Bug Runner · triage`) is in Needs you (`Pick the batch to sweep`) with an amber dot in the topbar and the sidebar. The chip's status ignores attention.
  - This comes from `BoringPanePicker.tsx:191` (`boring-empty-here`), and P3 did not change it.
  - Worth a @bor/@desk inbox card: the card that says "ask Brainstorm to hand off" should show that the Brainstorm is waiting on the owner.
- **Split mode selection and breadcrumb (B17):** in split mode no sidebar row is selected, and the breadcrumb follows the right pane (`VibeSquad › Runner Pilot`) while the URL still names the left agent. This is by design: rightCard is transient. It is unchanged by P3.
- **Implicit role in the URL:** the Brainstorm card's URL has no `role`, so it is implicit (`?lane=x` means the Brainstorm card). That is fine, and it keeps URLs short.

## Owner decisions
None.

## Inbox cards for @desk
- **m1 (R43):** the Overview Lead cell on a lane with no Lead should open the `?lane=&role=lead` card, like the topbar pill. Today it opens the Brainstorm chat (`src/BoringAde.tsx:1346`, `:598`).
- **m2 (R43):** `?slot=bugs&role=lead` with no Bugs pin: the URL drops the role, but `selectedRole` stays `lead`, so the breadcrumb shows `Bugs › Lead` and reload changes the screen.
- **Note:** the Lead card's `Brainstorm Idle` chip hides the Brainstorm's needs-you state (`src/BoringPanePicker.tsx:191`), which is pre-existing.
