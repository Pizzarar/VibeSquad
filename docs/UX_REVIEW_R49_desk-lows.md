# VibeSquad UX review, round 49: @desk L2 Show source and Sent details

Date: 2026-11-27 · Build: `desk-dd-lows-ui` @ `056e2c01` · Spec: `docs/PLAN_DESK_DD_LOWS.md` block L2 (idea-1150, idea-1154) · Previous @desk round: `docs/UX_REVIEW_R48_desk-c2b.md` (PASS 0/0/2)

**Verdict: PASS 0/0/3** (critical/major/minor).

Both R48 minors are fixed:
- **Show source:** it now appears only when the excerpt adds something beyond the question. The demo parry card no longer opens onto "No source message excerpt available."
- **Sent banner:** it has a `Details ▾` control that lists each answer as lane + option/reply + `re <question>`. The list is readable in both themes at 1920 and 3200@1.2.

Three minors are left:
- The Sent list cuts options at 60 characters even though it has a lot of spare width.
- The list disappears the moment the owner touches the next card.
- `Use all leans` still counts letter-only leans that point at no option. This one predates L2.

## Setup
- **Build:** `npm run build` at `056e2c01`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards.
- **Drivers:** `docs/ux-review-r49/drive/`. The Playwright location comes from the environment only.
  - `pass1.mjs` is R48's pass1. It runs the real `?demo` fallback feed with no backend, in 4 configs, to check for regressions.
  - `pass2.mjs` is R48's pass2 with additions:
    - **3 new cards:** 10 has an excerpt identical to the question. 11 has the same excerpt with different case, whitespace and line breaks. 12 has an excerpt that adds facts.
    - **Real server summary:** the mock returns `summary` from the real `choiceLabel`, the same way `server/decisions.mjs:781` does.
    - **Details probe:** it checks style, Tab reach, Enter/Space, the expanded list, and what happens after the next edit.
    - **Configs:** it now runs all 4.
  - `pass3.mjs` is new. It dumps every `?demo` card's question, toggle and excerpt.
- **Configs:** 1920x1080 and 3200x1800@1.2, dark and light.
- **Logs:** `docs/ux-review-r49/logs/pass{1,2,3}.json`. 0 page errors in every config.
- **Worker tests:** `node --test test/desk-c2-choices-card-e2e.test.mjs test/desk-c2-choices-card.test.mjs test/desk-d4-decision-desk.test.mjs` with the Playwright env set gives `# tests 33 # pass 33 # fail 0 # skipped 0`.

## Status vs R48
| R48 item | Status | Evidence |
|---|---|---|
| m1 / idea-1149 tail: "see Show source" shown on cards with no Show source | **Fixed.** Unresolved bare leans now read `LEAN C (letter only; option not defined)`, and the cards no longer point at a toggle that doesn't exist. | `pass2.json` cards 4/5 `hint`; `r49-*-card4.png`, `r49-*-card5.png` |
| m2 / idea-1154: the on-screen confirmation doesn't say what was sent | **Fixed**, with the m1/m2 follow-ups below. | `r49-*-banner-closed.png`, `r49-*-banner-open.png` |
| R47 m2 / idea-1150: Show source opens onto nothing on the parry card | **Fixed.** Card 06 has no toggle now. Its height went from 216 to 186 in all 4 configs (the toggle row is gone). | `pass1.json` parry, cardHeights; `r49-*-parry-source-open.png` (the file name comes from R48: there's no toggle to open now) |
| R46 m2 / idea-1121: `+N hidden` doesn't name the project | Open by design. | — |
| Badge = summary parity | Holds. `· 14` = `14 open · 11 here · 3 off-screen` in all 4 configs. | `pass1.json` counts |

## Brief checks
| Question | Result | Evidence |
|---|---|---|
| (1) Is Show source gone where the excerpt only repeats the question, and kept where it adds information? | **Yes on both counts.**<br>• **Demo feed:** the two cards with real excerpts keep the toggle: 13 (partial-fill, which adds the "Partial fills are the last open question" framing and the veto-window line) and 14 (U11, which adds the "before we freeze the dataset" framing). Parry 06, an inferred card with no excerpt, loses the toggle. No other demo card has one.<br>• **Mock cards:** card 10 (identical excerpt) has no toggle. Card 11 (same text, different case and whitespace) has no toggle. Card 12 (excerpt adds CPU and memory facts) shows `Show source ▾`. | `pass3.json`; `pass2.json` cards 10/11/12; `r49-*-card10/11/12.png` |
| (1b) Do the letter-only hints read right? | **Yes.**<br>• `(letter only; option not defined)` sits in muted 11px mono after `LEAN B` / `LEAN C`, inside the dashed lean chip. It reads as "the agent named a letter it didn't define", which is the truth.<br>• It shows on both shapes: unlettered alts (card 4) and a missing C (card 5).<br>• Card height is unchanged at 184. | `r49-dark-1920-card5.png`, `r49-light-3200-card4.png` |
| (2) Can the owner find the expand control on the Sent banner? | **Yes.**<br>• `Details ▾` sits 8px after the green `Sent 6 answers.`, at 12px/500 in `--text-2`. It's a borderless button that gets a fill on hover and a 2px focus ring.<br>• The caret marks it as a disclosure. `aria-expanded` and `aria-controls` are set.<br>• Tab reaches it. Enter opens it and changes the label to `Hide details ▴`. Space closes it.<br>• It's quieter than a chip, but it's the only thing next to the confirmation, so it reads as attached to it. | `pass2.json` toggleStyle, tabToToggle, spaceCollapses; `r49-*-banner-closed.png` |
| (2b) Are the option and reply lines readable? | **Yes.** Each line reads `@lane  <option "…"> + reply "…"  re <question>`:<br>• **Colours:** the summary uses `--text-1` (243/241/247 dark, 29/26/36 light); the lane and `re` parts use `--text-3`.<br>• **Font:** 12px mono, one line per answer at 1182px wide in both sizes.<br>• **Fit:** 6 answers fill 136px of the 160px max, so no scrollbar. With more answers the list scrolls inside itself (`overscroll-behavior: contain`).<br>• **Content:** None of these + reply, lean, typed reply and option + reply all read correctly.<br>• **Limits:** see m1 and m2. | `pass2.json` expanded.items; `r49-dark-1920-banner-open.png`, `r49-light-3200-banner-open.png`, `r49-dark-1920-after-send-open.png` |
| (3) Any R48 regressions? | **None.**<br>• **Card heights:** all demo heights match R48 except parry 06 (216 → 186, intended).<br>• **Tab order:** unchanged in all 4 configs: excerpt → A → B → C → None of these → reply.<br>• **Clipping:** 0 clipped options.<br>• **Banner:** when open, the Send bar grows from about 60px to 190px and the sticky footer stays in the page. The Use all leans / Send buttons stay vertically centred, with no overlap. | `pass1.json` vs R48 `pass1.json` (cardHeights, tabSeq, clipped); `pass2.json` barH |

## Findings

### Minor

**m1. The Sent list cuts options at 60 characters when it has room for all of them.**
- **Job hurt:** 3 (respond and confirm what went out). The list is there so the owner can confirm what was sent, but long options show as `option 1 "a: survivor-only — keep only listed tickers and report cove…"` on a 1182px-wide line with more than 300px free.
- **Evidence:** `pass2.json` expanded.items[1]; `r49-dark-1920-banner-open.png` line 2.
- **Cause:** the banner shows the server's `summary` (`server/decisions.mjs:781`, `choiceLabel(item, ans)` with the 60-character default caps, which suit the log). The client fallback `formatSentChoiceSummary` uses the same 60-character cap (`src/BoringDecisionDesk.tsx` `quoteShortClient`).
- **Fix:** in the banner, use the full option and reply text (for example, the client formatter with no cap, or a larger `optMax`/`replyMax` for the UI field) and let the row wrap. Keep the 60/240-character caps for the log entry only.
  - Optional: when the owner clicked the lean-tagged option, say `lean, option 2 …` so the line matches the LEAN tag they clicked.
- **Files:** `src/BoringDecisionDesk.tsx`, `server/decisions.mjs`.
- **Effort:** XS.

**m2. The Sent list disappears on the next keystroke or click on any card.**
- **Job hurt:** 3. A common flow is: send a batch, start on the next card, then want to check what went out. One character typed in any reply box clears the banner and its details (`bannerAfterEdit: 0`). The only remaining record is the lane log.
- **Evidence:** `pass2.json` bannerAfterEdit = 0 in all 4 configs.
- **Cause:** `toggleChoice` / `setReplyText` / `stageAllLeans` call `setBanner(null)` (`src/BoringDecisionDesk.tsx:852`, `:858`, `:864`). This was fine for a one-line "Sent N" toast, but it's too eager now that the banner carries the record.
- **Fix:** keep `banner.details` until the next Send, for example by folding it into a quiet `Last sent · 6 ▸` line once editing starts, instead of dropping it.
- **Files:** `src/BoringDecisionDesk.tsx`.
- **Effort:** S.

**m3 (pre-existing). `Use all leans (N)` counts and stages letter-only leans that point at no option.**
- **Job hurt:** 3.
  - After the send, the bar reads `Use all leans (5)`. That count includes cards 4 and 5, whose leans are `B` / `C` with `(letter only; option not defined)`.
  - One click would stage "lean C" for an option that doesn't exist: the exact ambiguity C2b set out to remove.
- **Evidence:** `r49-dark-1920-banner-open.png` (`Use all leans (5)`); `pass2.json` cards 4/5.
- **Cause:** `unstagedLeanIds` / `stageAllLeans` (`src/BoringDecisionDesk.tsx:825-826` filters on `yesno` + `lean` only) don't exclude `isUnresolvedBareLean(item)`.
- **Fix:** leave unresolved bare leans out of `Use all leans` and its count.
- **Files:** `src/BoringDecisionDesk.tsx`.
- **Effort:** XS.

## Owner decisions
- None needed.

## Inbox cards (owning lane @desk)
- m1: show full option and reply text in the Sent details list; keep the 60/240-character caps for the log only.
- m2: keep the Sent details available (for example, a `Last sent ▸` line) until the next Send instead of clearing them on the first edit.
- m3: leave unresolved letter-only leans out of `Use all leans (N)`.
