# VibeSquad UX review, round 50: @desk L3 Use all leans, full Sent text, Last sent

Date: 2026-11-27 · Build: `desk-dd-lows-l3` @ `ae39e89c` · Spec: `docs/PLAN_DESK_DD_LOWS.md` block L3 (idea-1159, idea-1160, idea-1161) · Previous @desk round: `docs/UX_REVIEW_R49_desk-lows.md` (PASS 0/0/3)

**Verdict: PASS 0/0/2** (critical/major/minor).

All three R49 minors are fixed:
- **Use all leans** counts only leans that can be sent.
- **The Sent list** shows the full option and reply text.
- **The details survive** typing and clicking as a quiet `Last sent · N ▸` line, and the next Send replaces them.

Two new minors are left, both small:
- `N need a look` is plain text. It doesn't say which cards it means, and it can't take the owner to them.
- When a summary is long, the Sent row's flex wrap leaves `@desk` alone on its own line.

## Setup
- **Build:** `npm run build` at `ae39e89c`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards.
- **Drivers:** `docs/ux-review-r50/drive/`. The Playwright location comes from the environment only.
  - `pass1`, `pass2` and `pass3` are R49's drivers, renamed for R50.
  - `pass4.mjs` is new. It is R49's pass2 plus the L3 flow:
    1. After Send, type in a card, then expand the Last sent line.
    2. Click an option on another card.
    3. Type a 300-character reply.
    4. Click Use all leans, then do a second Send and expand its list.
    5. Probe `need a look` (tag, role, title, focus).
- **Configs:** 1920x1080 and 3200x1800@1.2, dark and light.
- **Logs:** `docs/ux-review-r50/logs/pass{1,2,3,4}.json`. 0 page errors in every config.
- **Screenshots:** only the cited ones are committed. The drivers regenerate the rest.
- **Worker tests:** `node --test test/desk-c2-choices-card-e2e.test.mjs test/desk-c2-choices-card.test.mjs test/desk-d4-decision-desk.test.mjs` with the Playwright env set gives `# tests 39 # pass 39 # fail 0 # skipped 0`.

## Status vs R49
| R49 item | Status | Evidence |
|---|---|---|
| m1 / idea-1159: the Sent list cuts options at 60 characters | **Fixed.** Option `a: survivor-only — keep only listed tickers and report coverage %` and a 300-character reply both show in full, with no horizontal overflow (`overflowX: false` in all 4 configs). Wrap shape: see new m2. | `pass2.json` expanded.items; `pass4.json` afterSend2Open; `r50-*-banner-open.png`, `r50-*-send2-open.png` |
| m2 / idea-1160: the Sent list disappears on the next edit | **Fixed.** Typing in a card, or clicking an option on another card, folds the banner into `Last sent · 6 ▸`. That line expands to the same 6 rows. | `pass4.json` afterType / afterTypeOpen / afterClick / afterLongType; `r50-*-lastsent-closed.png`, `r50-*-lastsent-open.png` |
| m3 / idea-1161: Use all leans counts letter-only leans | **Fixed.** After the first send the bar reads `2 need a look · Use all leans (3)`. The 3 are cards 10-12, which have real leans. The 2 are cards 4 and 5, whose leans are B/C with no matching option. Use all leans stages the 3 and leaves 4 and 5 unpressed (`staged45: [0,0]`). | `pass2.json` summary; `pass4.json` afterUseAll |
| R46 m2 / idea-1121: `+N hidden` doesn't name the project | Open by design. | — |
| Badge = summary parity | Holds. `· 14` = `14 open · 11 here · 3 off-screen` in all 4 configs. | `pass1.json` counts |

## Brief checks
| Question | Result | Evidence |
|---|---|---|
| (1) Does `Use all leans (N)` count only sendable leans? Is `M need a look` understood, and does it lead to those cards? | **The count is right. The label partly works, and it doesn't lead anywhere.**<br>• **Count:** `Use all leans (3)` = cards 10/11/12 only. Once the owner answers card 4 by typing, `need a look` drops from 2 to 1.<br>• **Readability:** the label is muted 12px sans set just left of the button. It reads as "some leans weren't included", but nothing says *which* cards or *why*.<br>• **Navigation:** it's a `<span>` with no title, role or tabindex, and clicking it does nothing. The owner has to scroll the feed and spot the `(letter only; option not defined)` hint on each card. See m1. | `pass4.json` needLook; `r50-light-1920-lastsent-closed.png`; `r50-dark-1920-card4.png`, `r50-dark-1920-card5.png` |
| (2) Does the Sent list show full option and reply text, wrapping cleanly at 1920 and 3200@1.2, dark and light? | **Full text: yes. Clean wrap: mostly.**<br>• **Short rows:** one line each. A row slightly too long for the width, like row 1 at 1920, drops `re <question>` onto a second line, which reads fine.<br>• **Long replies:** a 300-character reply becomes a separate block. `@desk` sits alone on line 1, then 2 lines of summary, then `re …` on line 4 (80px tall). Readable, but the lane is cut off from its answer. See m2.<br>• **Colours:** `--text-1` for the summary and `--text-3` for the lane and `re`, in both themes.<br>• **Overflow:** the list scrolls inside its 160px cap (scrollH 176). The bar grows to 213px at 1920 and 190px at 3200, and Send stays centred. | `pass4.json` afterSend2Open, listBox; `r50-dark-1920-send2-open.png`, `r50-light-3200-banner-open.png`, `r50-dark-1920-banner-open.png` |
| (3) After Send, does typing or clicking keep `Last sent · N ▸`, and does it still expand? Does a new Send replace it? | **Yes, all three.**<br>• **Quiet line:** after typing, the bar reads `1 ready to send · 3 leans not included   Last sent · 6 ▸`, in `--text-3` at weight 400. It's quieter than the post-send `Details ▾` (`--text-2`, weight 500), as intended.<br>• **Expanding:** it expands to the same 6 rows (`aria-expanded` toggles). It stays after clicking an option on card 7 and after typing a long reply.<br>• **Next Send:** the second Send shows `Sent 5 answers. Details ▾`, and the list holds only the 5 new rows. The 6 old ones are gone. | `pass4.json` afterType…afterSend2Open; `r50-*-lastsent-*.png`, `r50-*-send2-open.png` |
| (4) Any R49 regressions? | **None.**<br>• **Unchanged from R49 in all 4 configs:** demo card heights, the tab sequence, the send review text, 0 clipped options, and the pass3 Show source dump.<br>• **Mock cards 1-12** render the same as R49 (pass2 per-card diff is empty).<br>• **Details ▾ toggle:** style, Tab reach (39 steps), Enter to open and Space to close are unchanged. | `pass1.json`, `pass2.json` and `pass3.json` diffed against `docs/ux-review-r49/logs/` |

## Findings

### Minor

**m1. `N need a look` doesn't say which cards it means, and can't take the owner to them.**
- **Job hurt:** 3 (respond to "needs you").
  - The label correctly separates the letter-only leans, but it's a dead end. The owner sees `2 need a look`, then has to scroll the feed to find cards whose only marker is the small `(letter only; option not defined)` hint.
  - The wording is also broader than what it counts. Card 7, which has no lean and no answer, needs the owner too but isn't counted. So "2 need a look" can read as "only 2 cards are left".
- **Evidence:** `pass4.json` needLook = `{tag: "SPAN", role: null, title: "", tabindex: null, cursor: "auto"}`; `r50-light-1920-lastsent-closed.png`.
- **Cause:** `src/BoringDecisionDesk.tsx:1464-1465` renders a bare span. The count comes from `needLookCount` (`:836-838`).
- **Fix:** make it a quiet button worded as the cause, for example `2 leans unclear ▸`, with `title="Lean names a letter no option defines"`. Clicking it scrolls to the first such card and flashes it. The Storybook `-> line` link already uses this pattern.
- **Files:** `src/BoringDecisionDesk.tsx`, `src/boring.css`.
- **Effort:** S.

**m2. A long Sent summary leaves the lane alone on its own line.**
- **Job hurt:** 3 (confirm what went out). It's mild: the text is all there. But for a 300-character reply the row reads as 4 loose lines (`@desk` / summary ×2 / `re …`), so it's harder to see which lane got which answer.
- **Evidence:** `r50-dark-1920-send2-open.png`, row 2 (80px tall).
- **Cause:** `.boring-decision-banner-item` is `display:flex; flex-wrap:wrap` (`src/boring.css:2458`), so once the summary is wider than the remaining space, the whole summary span wraps to a new row.
- **Fix:** let the row flow as text, using `display:block` with inline spans so the summary continues right after `@desk`. Alternatively, use a 2-column grid: lane in column 1, summary + `re` flowing in column 2.
- **Files:** `src/boring.css`.
- **Effort:** XS.

## Owner decisions
- None needed.

## Inbox cards (owning lane @desk)
- m1: make `N need a look` a quiet button that names the cause (for example `N leans unclear ▸`) and scrolls to and flashes the first such card.
- m2: Sent list rows should flow inline (or use a lane column grid) so long summaries don't orphan `@desk`.

PASS 0/0/2 ae39e89c
