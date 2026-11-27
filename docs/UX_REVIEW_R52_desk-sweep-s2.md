# VibeSquad UX review, round 52: @desk S2 Decision Desk minors (rail codes, hidden-staged names, need a look, Sent rows)

Date: 2026-11-27 · Build: `desk-crunch-k1` @ `39779107` · Spec: `PLAN_DESK_SWEEP_1127` S2 (idea-1081, idea-1121, idea-1164, idea-1165) · Previous @desk round: `docs/UX_REVIEW_R50_desk-lows-l3.md` (PASS 0/0/2). Other baselines: R45, R42.

**Verdict: PASS 0/0/2** (critical/major/minor).

All four ideas work:
- **idea-1081:** every 8-character code fits in its rail chip. Only codes of 9+ characters ellipsize, and they keep a full `title`. The 1920 Desk event is whole.
- **idea-1121:** the Send button names the hidden projects, and their pills get a dot plus a spoken `N staged hidden`.
- **idea-1164:** `N need a look` is a real button. Each click centres and flashes the next such card in turn, and it wraps around.
- **idea-1165:** Sent rows flow as text, so `@desk` never sits alone on a line.

Two small minors are left:
- At rest, `need a look` still looks like plain muted text.
- `+N hidden` next to `Send N answers` can read as "these send too".

## Setup
- **Build:** `npm run build` at `39779107`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards.
- **Drivers:** `docs/ux-review-r52/drive/`. The Playwright location comes from the environment only.
  - `pass1.mjs`: the rail at `?demo=&view=decisions&lanes=24` with the quiet fold open (R42 pass5 method: text Range width against the chip's content box). Mock backend `mock42.mjs` is copied from R42.
  - `pass2.mjs`: stage, then hide, one and then two projects (backend `common46.mjs`, copied from R46).
  - `pass3.mjs`: R50 pass4, plus 1600x1000, plus a need-a-look click probe and Sent row geometry.
  - `pass4.mjs`: a need-a-look cycle with both letter-only cards still open (before any send), then answering card 4.
  - `reg1-3.mjs`: R50 pass1-3, unchanged except for output paths, for the regression diff.
- **Configs:** 1920x1080 and 3200x1800@1.2, dark and light. pass1, pass3 and pass4 also run 1600x1000.
- **Logs:** `docs/ux-review-r52/logs/`. 0 page errors in every config and pass.
- **Screenshots:** only the cited ones are committed. The drivers regenerate the rest.

## Status vs R50
| R50 item | Status | Evidence |
|---|---|---|
| m1 / idea-1164: `N need a look` is a dead-end span | **Fixed in behaviour; half-fixed in look.** It's now a `<button>` with `title="Lean names a letter no option defines. Click to jump to the next card."`, `cursor:pointer`, a hover fill and a focus ring. Each click moves focus to the next letter-only card, centres it and flashes it with an amber ring. The wording is unchanged and there is no `▸` cue, so at rest it reads like the status text to its left. See m1. | `pass4.json` cycle; `pass3.json` needLook; `r52-dark-1920-cycle1.png`, `r52-dark-1920-bar-needlook.png` |
| m2 / idea-1165: a long Sent summary leaves `@desk` alone on its own line | **Fixed.** `laneAloneOnLine: false` for every row in all 6 configs. The 300-character reply runs straight on after `@desk option 1 "Keep beta" + reply …`: 4 lines at 1600, 3 at 1920, 2 at 3200@1.2. `overflowX: false` everywhere. | `pass3.json` send2; `r52-dark-1600-send2-open.png`, `r52-light-1920-send2-open.png`, `r52-dark-3200-send2-open.png` |
| R46 m2 / idea-1121: `+N hidden` doesn't name the project | **Fixed.** See brief check (2) and m2. | `pass2.json`; `r52-dark-1920-bar-hidden2.png`, `r52-*-pills-hidden.png` |
| R42 m1 / idea-1081: 8-character rail codes ellipsized by 0.8px | **Fixed.** See brief check (1). | `pass1.json` |

## Brief checks
| Question | Result | Evidence |
|---|---|---|
| (1) idea-1081: do 8-character codes fit unclipped? Do long slugs ellipsize with a tooltip? Is the Desk event whole at 1920? | **Yes to all three.**<br>• **8-character codes:** all 17 (`@plugins`, `@ui-bois`, `@lane-10` … `@lane-24`) measure 52.8px of text in a 52.8px box, at 1920 and 3200@1.2, both themes. 0 are ellipsized. The fit has 0px slack: it works because of `padding-inline: 4px` (`src/boring.css`, S2 block), as R42 proposed.<br>• **Long slugs:** only the 4 codes of 9+ characters ellipsize (`@art-direction`, `@runner-pilot`, `@main-game`, `@site-polish`). Each has a `title` with the full handle, and hovering `@art-di…` at 3200 shows `@art-direction`.<br>• **Desk event:** `Decision Desk approved for Normal default landing` needs 376px of a 379px column at 1920 (3px slack, the same as R42). 0 events are truncated in any config, and every rail line stays 24px.<br>• At 1600 the desk is not in wide mode, so the chip rule doesn't apply. 0 truncated events there too. | `pass1.json`; `r52-dark-1920-rail.png`, `r52-light-3200-rail.png` |
| (2) idea-1121: does `+N hidden` name the projects? Are those pills marked? Is it clear? | **Names: yes. Marks: yes. Clarity: mostly.**<br>• **Button text:** `Send 0 answers · +1 hidden (VibeSquad)`, then `Send 0 answers · +2 hidden (VibeSquad, Site)`. After re-showing VibeSquad it reads `Send 1 answer · +1 hidden (Site)`. The list is capped at 2 names plus `+N more` (`src/decisionFilter.ts:264`), so the button can't grow without limit. The tooltip says `2 staged answers hidden in: VibeSquad, Site`. Nothing is clipped (the button is 320px at 1920).<br>• **Pills:** each hidden project with a staged answer gets a 6px accent dot before its name (`aria-hidden`). The pill's `aria-label` becomes `VibeSquad, 2 open, 1 staged hidden` and its title `1 staged answer hidden`. The dot clears when the pill is pressed again. Asleep pills without staged answers get no dot.<br>• **Clarity:** see m2. `+1 hidden` right after `Send 1 answer` can read as "plus 1 more that sends". The title doesn't say these won't send, and the bar hint on the left doesn't mention them. | `pass2.json` (all 4 configs); `r52-dark-1920-bar-hidden2.png`, `r52-dark-1920-pills-hidden.png`, `r52-light-1920-pills-hidden.png`, `r52-dark-1920-staged-hidden.png` |
| (3) idea-1164: is `need a look` discoverable as a button, and does it take you to each such card in turn? | **It goes to each card in turn: yes. Discoverable: weakly.**<br>• **Navigation:** with cards 4 and 5 both letter-only, clicks go 04 → 05 → 04 → 05 → 04 in all 6 configs. Each card lands centred (top 472px at 1920, 832 at 3200, 432 at 1600), gets focus, and flashes an amber ring that clears within 1.5s (`flashAfter: 0`). Enter on the focused button works the same. After the owner answers card 4, the label drops to `1 need a look` and the next click goes to card 5.<br>• **Look at rest:** muted `--text-3` 12px text, a transparent border and no chevron. It sits next to `7 leans not included. Tap a lean…`, which uses the same colour. Only hovering shows the button fill. The tooltip explains the cause, but only after hovering. See m1. | `pass4.json` cycle, afterAnswer4; `pass3.json` lookCycle, lookEnter; `r52-dark-1920-cycle1.png`, `r52-dark-1920-bar-needlook.png`, `r52-light-1920-bar-needlook.png` |
| (4) idea-1165: do long Sent rows wrap cleanly at 1600, 1920 and 3200@1.2? | **Yes.**<br>• **Long row:** `@desk` sits on line 1, the summary runs straight on, and `re Rename the beta channel to preview?` follows inline. That's 68px (4 lines) at 1600, 51px (3) at 1920 and 34px (2) at 3200@1.2, with no horizontal overflow.<br>• **Short rows:** one line each.<br>• **Colours:** unchanged: lane and `re` in `--text-3`, the summary in `--text-1`.<br>• **List height:** 149px at 1920 and 132px at 3200, inside the 160px cap. At 1600 the list hits the cap (scrollH 164 against 160), so it scrolls by 4px. That's harmless.<br>• Wrapped lines start at the row's left edge, not under the summary. It reads fine because each row starts with the `@lane` code. | `pass3.json` send2/listBox; `r52-dark-1600-send2-open.png`, `r52-light-1920-send2-open.png`, `r52-dark-3200-send2-open.png` |
| (5) Any R50 regressions? | **None.**<br>• **reg1** (badge = summary parity `· 14` / `14 open`, card heights, tab sequence, clipped options) is byte-identical to R50 `pass1.json` in all 4 configs.<br>• **reg3** (the Show source dump) is identical too.<br>• **reg2** differs only in the timestamps inside the prompts, plus the expanded Sent list at dark-1920: it is 6px shorter (159 → 153; `barH` 213 → 207). That comes from the idea-1165 inline wrap, which is intended.<br>• The R50 L3 behaviour still holds in pass3: `Last sent · 6 ▸` appears after typing, `Use all leans (3)` skips cards 4 and 5 (`staged45: [0,0]`), and a second Send replaces the list. | `logs/reg1.json`, `reg2.json` and `reg3.json` diffed against `docs/ux-review-r50/logs/pass1-3.json` |

## Findings

### Minor

**m1. At rest, `N need a look` still looks like status text, not a button.**
- **Job hurt:** 3 (respond to "needs you"). The jump works well once found. But nothing at rest says it's clickable: no border, no fill, no chevron, and the same `--text-3` colour as the hint text beside it. The owner learns it's a button only by hovering. The wording also still doesn't say why the cards need a look (R50 m1 suggested `N leans unclear ▸`). The reason is only in the `title`.
- **Evidence:** `r52-dark-1920-bar-needlook.png` and `r52-light-1920-bar-needlook.png` (mouse away). Computed style: `border: 1px solid transparent; background: transparent; color: var(--text-3)`.
- **Cause:** `src/boring.css:2464` gives the rest state a transparent border and background. `src/BoringDecisionDesk.tsx:1526` renders the label `${n} need a look` with no cue.
- **Fix:** add a trailing `▸` (or `↓`), and give the rest state the quiet-chip look that `Use all leans` uses, or at least `border-color: var(--border)`. Optionally reword to `N leans unclear ▸`. Keep the title.
- **Files:** `src/boring.css`, `src/BoringDecisionDesk.tsx`.
- **Effort:** XS.

**m2. `+N hidden` reads as additive, and nothing says the hidden answers won't send.**
- **Job hurt:** 3 (respond and confirm what goes out). In `Send 1 answer · +1 hidden (Site)`, the `+` suggests "1 answer plus 1 more". The truth is the opposite: the Site answer is held back until Site is shown again. The tooltip (`1 staged answer hidden in: Site`) doesn't say "won't send", and neither does the left-hand bar hint. The project names, the real gap behind idea-1121, are now there. This is only the wording around them.
- **Evidence:** `pass2.json` step `vs back, site hidden`; `r52-dark-1920-bar-hidden2.png`.
- **Cause:** `formatHiddenStagedLabel` builds ` · +${total} hidden (${list})` and the title `… hidden in: …` (`src/decisionFilter.ts:264-280`).
- **Fix:** drop the `+` and say it's held, for example `Send 1 answer · 1 held in Site (hidden)`. Set the title to `1 staged answer in Site won't send until Site is shown. Click its pill to show it.`
- **Files:** `src/decisionFilter.ts` and its unit test.
- **Effort:** XS.

## Notes (not findings)
- The 8-character chip fit has exactly 0px slack at 11px JetBrains Mono. If the owner's machine falls back to a wider monospace face, `@plugins` would ellipsize again. The R42 e2e assertion (Range width ≤ content box) is the guard for that.
- The staged dot uses `--accent` (purple), which is not the project's own colour, so it can't be confused with a project colour swatch.

## Owner decisions
- None needed.

## Inbox cards (owning lane @desk)
- m1: give `N need a look` a visible rest-state affordance (`▸` plus a quiet border or chip), and consider the wording `N leans unclear ▸`.
- m2: reword the hidden-staged suffix and title so it reads as held back, not added (for example `· 1 held in Site (hidden)`), and say in the title how to release it.

PASS 0/0/2 39779107
