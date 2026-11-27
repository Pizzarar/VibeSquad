# VibeSquad UX review, round 48: @desk C2b Decision Desk answers read clearly

Date: 2026-11-27 · Build: `desk-c2b-choice-labels` @ `cded7be6` · Spec: `docs/PLAN_DESK_DD_C2B.md` block B1 · Previous @desk round: `docs/UX_REVIEW_R47_desk-c2.md` (PASS 0/0/3)

**Verdict: PASS 0/0/2** (critical/major/minor).

The owner said "i dont know what the choices are". For the common case, C2b answers that. A lean of `B`, `(b)` or `B)` now shows as a `LEAN` tag on option B's own button, with its full definition. There's no separate letter-only chip and no duplicate button. "None of these" sits at the end of the option row and reads as the way out of the list. The logged delivery summary keeps both the option and the typed reply.

Two minors are open:
- When a bare-letter lean can't be resolved, the card tells the owner to "see Show source" on cards that have no Show source.
- The on-screen confirmation after Send still says only "Sent N answers."

## Setup
- **Build:** `npm run build` at `cded7be6`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards.
- **Drivers:** `docs/ux-review-r48/drive/`.
  - `pass1.mjs` is R47's pass1 re-pointed at R48. It runs the real `?demo` fallback feed with no backend, in 4 configs, to check for regressions.
  - `pass2.mjs` is new. It runs a mock backend that uses the real `buildAnswerPrompt`/`validateAnswerBatch`, with 9 cards:
    - Bare leans `B` / `(b)` / `B)` that resolve.
    - Bare lean `B` with unlettered alts.
    - Bare lean `C` with only A/B alts.
    - A no-lean A/B/C card.
    - A no-lean card with 1 alt.
    - A classic text lean with 1 alt.
    - A plain answer card.
  - pass2 sends a 6-answer batch: the Lean-tagged option + reply, a plain option, None of these + reply, a classic lean, a typed answer, and a `B)` lean.
- **Configs:** pass1 runs 1920x1080 and 3200x1800@1.2, dark and light. pass2 runs 1920 dark, 1920 light and 3200@1.2 light.
- **Logs:** `docs/ux-review-r48/logs/pass1.json`, `pass2.json`. 0 page errors in every config.
- **Worker tests:** `node --test test/desk-c2-choices-card-e2e.test.mjs test/desk-c2-choices-card.test.mjs test/desk-d4-decision-desk.test.mjs` with the Playwright env set gives `# tests 26 # pass 26 # fail 0 # skipped 0`. Without the env, the 4 e2e tests skip and it reports 22 pass.

## Status vs R47
| R47 item | Status | Evidence |
|---|---|---|
| m1 / idea-1149: bare-letter lean reads `LEAN B` and repeats option B | **Fixed when the letter resolves.** `lean:"B"` with alts A/B/C renders three buttons, and B reads `LEAN B: SQLite in the server process with WAL mode`. There's no separate lean button. `(b)` with `a:`/`b:` alts and `B)` behave the same way. Clicking the tagged option sends `alt:1`, so the agent gets `Go with option 2: "B: …"`, one consistent answer. **Partly open when the letter doesn't resolve:** see m1 below. | `pass2.json` cards 1–3; `r48-*-card1.png`, `r48-*-card2.png` |
| m2 / idea-1150: Show source opens on nothing on the demo parry card | **Still open, deferred by the plan.** It still reads "No source message excerpt available." | `pass1.json` parrySource |
| m3 / idea-1151: `Not that` ambiguous on pick-one cards | **Fixed.** Cards with 2+ distinct options show `None of these`, and the prompt reads `Owner's answer: None of these: do NOT go with any of the options listed below.` followed by the owner's reply block. A single-option card keeps `Not that`. | `pass2.json` cards 6/7/8 + delivered[06]; `r48-*-card6-none-picked.png` |
| R46 m2 / idea-1121: `+N hidden` doesn't name the project | Open by design, as in R47. | — |
| Badge = summary parity | Holds. `· 14` = `14 open · 11 here · 3 off-screen` in all 4 configs. | `pass1.json` counts |

## Brief checks
| Check | Result | Evidence |
|---|---|---|
| Is the Lean tag clear? | **Yes.**<br>• `LEAN` is 11px, 700 weight, uppercase, and sits inline before the option text.<br>• The tagged button gets a dashed accent border (`rgb(155,114,232)` dark, `rgb(109,75,201)` light) on a transparent fill. The other options use the solid neutral chip.<br>• When picked it turns `✓ LEAN` on a solid accent fill.<br>• It reads well in both themes and at 3200@1.2. | `r48-dark-1920-card1.png`, `r48-light-1920-card1-picked.png`, `r48-light-3200-card2.png` |
| Is it obvious which option is the agent's lean? | **Yes, when the letter resolves.** The tag sits on the option itself, and A/B/C keep their order, so "B" is still second. Screen readers hear "Lean B: SQLite…" as the button name. When the letter doesn't resolve, see m1. | `pass2.json` cards[1].buttons |
| Does "None of these" read right next to the options? | **Yes.**<br>• It's the last chip in the row, the same size as the options, and wraps with them.<br>• Picked, it gets the red-tone outline, so it can't be mistaken for an option pick.<br>• It shows on 2+ option cards. A text lean + 1 alt counts as 2, which is correct. A no-lean card with 1 alt keeps `Not that`. | `r48-*-card6.png`, `r48-*-card6-none-picked.png`; `pass2.json` cards 7/8 |
| Does the delivery summary after Send show the option and the reply? | **In the log, yes. On screen, no (m2).** The logged `you` entry (`server/decisions.mjs:647`) now reads, for example:<br>• `Decision Desk: lean, option 2 "B: SQLite in the server process with WAL mode" + reply "keep export" → <agent> re "…"`<br>• `Decision Desk: none of these + reply "Neither: reject partials and log them" → …`<br>The Desk page itself confirms only `Sent 6 answers.` | Direct `choiceLabel` calls; `pass2.json` summary; `r48-dark-1920-after-send.png` |
| R47 regressions | **None.**<br>• All 11 demo card heights match R47 exactly in all 4 configs (144/184/216/256).<br>• Tab order is still toggle → excerpt → A → B → C → none → reply.<br>• Mixed B + reply still counts as `Send 1 answer`. Switching to C or unpicking keeps the reply.<br>• 0 clipped options. | `pass1.json` vs R47 `pass1.json` |

## Findings

### Minor

**m1. An unresolved bare-letter lean says "see Show source" on cards that have no Show source.**
- **Job hurt:** 3 (respond to a pick). This is the owner's exact complaint in its remaining form. The card shows `LEAN C (letter only; see Show source)` above `A: in-memory only` / `B: Redis sidecar`, with no toggle anywhere on the card, so the owner can't find out what C is.
- **Evidence:**
  - pass2 card 5 is structured, `lean:"C"`, alts A/B only. This is a likely writer shape, because the C3 rule says to leave the lean out of `--alt`.
  - pass2 card 4 is structured, `lean:"B"`, with unlettered alts.
  - Both render the hint and neither has a source toggle (`r48-*-card4.png`, `r48-*-card5.png`).
- **Cause:** the hint renders whenever `isUnresolvedBareLean(item)` is true (`src/BoringDecisionDesk.tsx:1089`). The toggle only exists when `hasSourceDisclosure` is true, meaning inferred or has context (`src/BoringDecisionDesk.tsx:187`). Structured items with alts get neither.
- **Fix:** only show "see Show source" when `hasSourceDisclosure(item)`. Otherwise either:
  - attach the logged raw line as `context` for unresolved bare leans, so Show source appears, or
  - word the hint as `(letter only: the agent didn't say what C is)` so the owner knows to reply and ask.

  The writer-side guard belongs in C3: reject `--lean` values that are just a letter, or warn on them.
- **Files:** `src/BoringDecisionDesk.tsx`, possibly `server/decisions.mjs` (context for structured items) and the C3 writer rule.
- **Effort:** XS–S.

**m2. The on-screen confirmation after Send doesn't say what was sent.**
- **Job hurt:** 3. After a 6-answer batch, the bar and banner read only `Sent 6 answers.`. The option + reply summary that idea-1152 fixed lives in the lane log, which the Desk's Live status column doesn't show (it lists done/decision events). To check what went out, the owner has to open the lane log.
- **Evidence:** `pass2.json` summary = `["boring-decision-bar: Sent 6 answers.…", "status: Sent 6 answers.", "boring-decision-banner: Sent 6 answers."]`; `r48-dark-1920-after-send.png`. In the logged text, quotes are cut at 60 characters with no ellipsis (`"…resize the stop to the filled s"`). The final `.slice(0, 240)` can also drop the closing quote of the ask (`server/decisions.mjs:647`).
- **Fix:** make the banner expandable (`Sent 6 answers ▸`) to list each `choiceLabel` line, which the server can return per result. Add `…` when `quoteLine` truncates in labels.
- **Files:** `src/BoringDecisionDesk.tsx` (banner, ~:835), `server/decisions.mjs`.
- **Effort:** S.

## Owner decisions
- None needed. For m1, I recommend the reworded hint plus the C3 writer guard. The lead can decide that.

## Inbox cards (owning lane @desk)
- m1: gate the "see Show source" hint on `hasSourceDisclosure`; reword it when there's no source; add a C3 bare-letter `--lean` guard.
- m2: make the Sent banner expandable to list per-answer summaries; add an ellipsis on truncated quotes in `choiceLabel`.
