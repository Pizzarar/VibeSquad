# VibeSquad UX review, round 51: @desk S1 empty-card navigation

Date: 2026-11-27 · Build: `desk-crunch-k2` @ `8f873269` · Spec: `docs/PLAN_DESK_SWEEP_1127.md` S1 (idea-1096, idea-1104, idea-1105) · Baselines: `docs/UX_REVIEW_R43_desk-p3.md` (PASS 0/0/2), `docs/UX_REVIEW_R44_desk-p3.md` (PASS 0/0/3)

**Verdict: PASS 0/0/0** (critical/major/minor).

S1 closes all three open R43/R44 minors:
- **Overview Lead cell:** on a lane with no Lead, the cell now opens the Lead empty card.
- **`Lead · none` pill:** the card opens in place, and the split is kept hidden instead of folded.
- **Reload on a card:** a reload keeps the right pane's agent.

No regressions turned up:
- **Screen invariants:** URL, breadcrumb, the one selected row and the screen agree in every step.
- **Configs:** the logs are identical across all 4 configs.
- **Page errors:** 0.

## Setup
- **Build:** `npm run build` at `8f873269`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards, and the tree is clean apart from this report.
- **Driver:** `docs/ux-review-r51/drive/pass1.mjs <theme> <w> <h> <dsf>`. `common`/`lib`/`mock` are copied from R44, which also records `vs.panes.v1` per step. The driver has 6 blocks:
  - **Q1:** Overview cells.
  - **Q2:** pill with a split open.
  - **Q2b:** Overview Lead cell with a split open.
  - **Q3:** reload on a card, 4 ways (`?lane=`, `?lane=&role=lead`, `?slot=`, and `?agent=` as the control).
  - **Q4:** Overview reload with a saved split, a cold load into another project, Ctrl+J, and Back/Forward.
  - **Q4b:** live and empty pills, plus Shift+click.
- **Configs:** dark 1920x1080, light 1920x1080, dark 3200x1800@1.2, light 3200x1800@1.2. That is 92 steps each.
- **Logs:** `docs/ux-review-r51/logs/pass1-<theme>-<w>.json`. Diffing each config against dark-1920 on URL, crumb, selected rows, card head, split DOM, right pane, panes state and history calls gives **0 diffs** in all 3 other configs. No step has more than one selected row. `errs` is `[]` in every block.
- **Unit tests** (the Playwright location comes from the environment): `node --test test/desk-nav-history-e2e.test.mjs test/desk-nav-history.test.mjs test/deeplink-live.test.mjs test/boring-mode.test.mjs test/normal-invariants.test.mjs` gives `# tests 239 # pass 239 # fail 0 # skipped 0`.
- **Screenshots:** only the cited ones are committed. The driver regenerates the rest.

## Status vs R43 / R44
| Item | Status at `8f873269` | Evidence |
|---|---|---|
| R43 m1 / R44 m3 (idea-1096): the Overview Lead cell on a lane with no Lead opens the Brainstorm chat | **Fixed.** The Bug Chaser Lead cell pushes one entry, `?lane=bug-chaser&role=lead`. The screen shows the card `Bug Chaser · Brainstorm ready · no Lead`, the crumb reads `VibeSquad › Bug Chaser › Lead`, and the only selected row is `boring-conv-bug-chaser`. Back returns to the Overview. | `pass1-*.json` Q1; `r51-dark-1920-Q1-leadcell-card.png` |
| R44 m1 (idea-1104): the `Lead · none` pill folds an open split | **Fixed.** Before the pill: `split=true L=demo-bugs R=demo-lead-pl`. After it, the panes are unchanged: the split is hidden behind the card, not folded. The topbar shows `Back to split`. The card's `Brainstorm` chip brings both panes back. Back/Forward moves between the card and the split view with the same panes. | Q2, Q2b; `r51-dark-1920-Q2-leadpill-card.png`, `r51-dark-1920-Q2-after-chip.png`, `r51-light-1920-Q2b-chip-split.png` |
| R44 m2 (idea-1105): a reload on an empty card loses the right agent | **Fixed.** Runs for `?lane=`, `?lane=&role=lead` and `?slot=`: after the reload the same card shows, with the same crumb and selected row, and the panes still read `R=demo-lead-pl`. Back brings the split back with Plugins Lead on the right (R44 showed `Pick an agent or lane` here). Forward and Back repeat the same states. The `?agent=` control is unchanged. | Q3; `r51-light-3200-Q3-LEADCARD-reload.png`, `r51-light-3200-Q3-LANE-back.png` |
| R44 note: the card's `Brainstorm Idle` chip doesn't show that this Brainstorm needs you | Unchanged. This is pre-existing and out of S1's scope. The Bug Runner · triage row in Needs you is that Brainstorm. | `r51-dark-1920-Q2-leadpill-card.png` |

## Brief checks
| Question | Result |
|---|---|
| (1) On a lane with no Lead, does the Overview Lead cell open the Lead card? | **Yes**, in all 4 configs, and also with a split open (Q2b). The other 3 cell combinations still work: Bug Chaser Brainstorm (live) opens `?agent=demo-bugs`, Runner Pilot Brainstorm (none) opens the `?lane=runner-pilot` card, and Runner Pilot Lead (live) opens `?agent=demo-lead-runner`. |
| (2) With a split open, does an empty Lead pill show the Lead card in place and keep the split? | **Yes.** One push. The card shows full width, and the persisted split and right agent are untouched. `Unsplit` turns into `Back to split`. |
| (3) After a reload on an empty card, is the same card in the same pane, with the right pane intact? | **Yes**, for lane, lead and slot cards. The reload makes no history calls, and the right agent comes back on the next Back. |
| (4) Any regressions in back/forward, sidebar selection, the breadcrumb, or the live-role pills? | **None found.**<br>• **R5-4 still holds:** reloading `?team=vibesquad` with a saved split shows the Overview full width. A cold `?team=efi` shows the Main Game Overview, and the right pane from the other project doesn't leak in (`r51-dark-3200-Q4-cold-efi.png`).<br>• **Ctrl+J:** jumps to `demo-aud`, and the split comes back with the right agent kept.<br>• **Live pills:** they still open their agent (Plugins Lead).<br>• **Empty Brainstorm pill:** opens the `?lane=plugins` card.<br>• **Selection:** in every step, the crumb matches the selected row and the open agent or card. The only 0-selection state is the `Split · pick an agent` picker, the same as R44. |

## Findings
None.

**Observation (not graded).** With a split open, Shift+click on an empty pill opens the card full width and stores `activePane=right`. Back then returns to the split with the left pane active. That matches R44's b path, and the screen doesn't mislead, so it isn't a finding.

## Owner decisions
None.

## Inbox cards for @desk
None. The R44 `Brainstorm Idle` chip note stays an open note, as before.

PASS 0/0/0 8f873269
