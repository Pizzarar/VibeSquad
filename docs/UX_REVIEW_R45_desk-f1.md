# VibeSquad UX review, round 45: @desk F1 Decision Desk project filter pills

Date: 2026-11-26 · Build: `desk-f1-filter-pills` @ `95ec4492` · Spec: `docs/PLAN_DESK_DD_FILTER.md` (read after the first pass) · Previous @desk round: `docs/UX_REVIEW_R44_desk-p3.md` (PASS 0/0/3, different area)

**Verdict: FAIL 0/1/4** (critical/major/minor).

The pills themselves work. Every check in the brief passes at 1920x1080 and 3200x1800@1.2, in dark and light. The one major finding is a count that F1 made wrong: the sidebar `Decisions · N` badge still counts hidden on-hold projects. If only on-hold projects have items, the badge lights up and the page says "No open decisions". That is the same class of bug as the round-1 "badge 3, overview says nothing" finding, and it keeps Forework/SBB pulling the owner's attention, which is half of what the owner asked for.

## Setup
- **Build:** `npm run build` at `95ec4492`. `public/THIRD-PARTY-LICENSES.txt` restored afterwards. `docs/shots/desk-f1/` untouched (the worker e2e was not run).
- **Data:** the 5-project mock from `test/desk-f1-filter-pills-e2e.test.mjs`. VibeSquad, Main Game Project and Site are awake. Forework and SBB are in the asleep `Backlog` folder. There are 7 open items and 1 off-screen item per side. The agents and the sidebar come from `?demo`.
- **Drivers:** `docs/ux-review-r45/drive/`.
  - `common.mjs` holds the mock server, copied from the e2e.
  - `pass1`: default state, 4 configs, with the computed pill styles.
  - `pass2`: toggles, reload, presets, all-off, staged+hide/unhide, typed answer+hide+reload, Tab order, and Space/Enter.
  - `pass3`: only on-hold projects have items.
- **Logs:** `docs/ux-review-r45/logs/`. `pass2-dark-1920.json` is the full run. `pass2-light1920-dark3200-light3200.json` holds the other 3 configs, which match it step for step. 0 page errors. The only console errors are 404s from endpoints the mock doesn't serve.

## Status vs R44 (other area; not re-driven)
| R44 item | Status |
|---|---|
| m1 topbar `Lead · none` folds the split | Not in F1's area; carried, not re-checked |
| m2 reload on an empty card loses the right pane's agent | Carried, not re-checked |
| m3 (R43 m1) Overview Lead cell opens the Brainstorm | Carried, not re-checked |

## What was checked (brief items)
| Check | Result | Evidence |
|---|---|---|
| Pill readability, counts, dimmed `On hold` group | **Pass.** 12px text, 26px tall, at both sizes. ON = purple border with bright text. An awake pill turned OFF = grey border with muted text. On hold = no fill, a dashed border and muted text, after an `ON HOLD` label. Dark OFF text `#9a97a8` and light `#5e5868` are both readable. Pill counts (2+1+1+2+1=7) match the open items per project. The dashed border is nearly invisible in dark (`#2b2b38` on the page), so the dimming comes from the text colour alone. That's acceptable. | `r45-dark-1920-default.png`, `r45-light-1920-default.png`, `r45-dark-3200-default.png`, `r45-light-3200-default.png`; `logs/pass1.json` |
| `Active` / `All` presets | **Pass.** By default `Active` is pressed. A custom toggle un-presses both presets, so the preset state stays honest. `All` gives 7 open · 5 here · 2 off-screen. `Active` goes back to 4 · 3 · 1 and clears localStorage. | `logs/pass2-dark-1920.json` "All"/"Active"; `r45-dark-1920-site-off.png` |
| Toggle 3 projects, reload | **Pass.** Site OFF, Forework ON and SBB ON give `vs.decisionFilterOverrides={"site":false,"forework":true,"sbb":true}`. The same set is back after reload, and the URL stays `?demo=&view=decisions`. | pass2 "after reload"; `r45-light-1920-three-toggled.png` |
| Hidden projects absent from feed, strip and rail | **Pass** in every state. The feed squads, the off-screen ids and the rail squads all match the pressed set. The rail `N lanes` and `Oldest first · N` counts follow the filter. | pass2 every step |
| Stage, hide, `+1 hidden`, unhide | **Pass.** Text goes `Send 1 answer` → `Send 0 answers (+1 hidden)` (disabled) → unhide → `Send 1 answer`, with the lean still pressed. A typed Site answer with Site hidden gives `Send 1 answer (+1 hidden)`. Send uses `buildAnswerBatch(visibleItems, …)` (`src/BoringDecisionDesk.tsx:554`), so hidden answers never send. | pass2 "vs hidden"/"vs unhidden"/"typed site"; `r45-dark-1920-staged-hidden.png`, `r45-light-3200-staged-hidden.png` |
| Keyboard and focus | **Pass.** Tab order: Active → All → each awake pill → each on-hold pill → feed. Every pill shows a 2px `#9b72e8` outline. Space and Enter both toggle, and focus stays on the pill. The region has `aria-label="Filter by project"`, and each pill has `aria-pressed`. | pass2 "tab order"; `r45-dark-1920-focus.png`, `r45-light-3200-focus.png` |
| Fit with the page chrome | **Pass.** One 26px row between the summary line and the `DECISIONS` / `LIVE STATUS` headers. It is left-aligned to the feed column and fits on one line at 1920 with 5 projects (ends at x≈1014 of 1533). At 3200 it sits in the centred max-width column. It adds no page-level scroll. | default shots |

## Findings

### Major 1 · The sidebar `Decisions · N` badge counts hidden projects, so it disagrees with the page and still lights up for on-hold projects
- **Job hurt:** 3 (respond when something needs me).
  - The owner turns off on-hold projects so they stop asking for attention. The badge keeps counting them.
  - Default demo: the badge reads `Decisions · 7`, and the page reads `4 open · 3 here · 1 off-screen`.
  - Worst case: only Forework/SBB have items. The badge reads `· 3`, and the page reads `0 open in selected projects` / "No open decisions in the selected projects." The badge sends the owner to an empty page.
- **Evidence:**
  - `logs/pass3.json`: `nav: "· 3"`, `summary: "0 open in selected projects"`.
  - Screenshots: `r45-dark-1920-onhold-only.png`, `r45-light-3200-onhold-only.png`.
  - `logs/pass2-dark-1920.json`: `sideBadge` stays `Decisions · 7` through every filter state.
- **Cause:** `useDecisionCount()` returns `s.items.length` (`src/BoringDecisionDesk.tsx:432-440`), the unfiltered store. The filter only applies inside the page (`visibleSquadIds` / `filterDecisionItems`, `:545-554`). The comment at `:344` says the store exists to keep this badge "synced with the page". F1 broke that sync. Before F1, page and badge both showed everything, so they agreed.
- **Fix:** Have the badge count the filtered set. Read `readDecisionFilterOverrides()` plus the teams/folders asleep state in `useDecisionCount`, apply `filterDecisionItems`, and return the visible length. Both places then use the same overrides and the same `isSquadVisible` rule. Optionally, add a muted hint when the visible count is 0 and hidden items exist (see Owner decisions). Keep the pure helper as the single source so the two can't drift again, and add an e2e assert that the badge equals the summary's `N open`.
- **Files:** `src/BoringDecisionDesk.tsx` (`useDecisionCount`), maybe `src/BoringAde.tsx:470,1265`, `src/decisionFilter.ts`, test. **Effort:** S.

### Minor 1 · The empty state doesn't say anything is hidden or offer a way back
- **Job hurt:** 3. All pills off, or only on-hold items: the page says "No open decisions in the selected projects." and the rail shows `0 lanes`. The 3 (or 7) hidden items are mentioned only in the pill counts.
- **Evidence:** `r45-dark-1920-none-on.png`, `r45-dark-1920-onhold-only.png`.
- **Fix:** Add the hidden count to the summary line (`4 open · 3 hidden in on-hold projects`), and give the empty card a `Show all (3)` button that applies `All`. **Files:** `src/BoringDecisionDesk.tsx`. **Effort:** XS.

### Minor 2 · `+1 hidden` doesn't say which project holds the hidden answer
- **Job hurt:** 3. With several projects off, the owner can't tell which pill to turn back on to find a staged answer. The pill has no mark for it.
- **Evidence:** `r45-dark-1920-staged-hidden.png`: VibeSquad is OFF and has no marker; the button reads `Send 0 answers (+1 hidden)`.
- **Fix:** Put a small dot on any OFF pill that holds staged answers, plus `title="1 staged answer hidden"`. Or make `+1 hidden` a button that turns those projects back on. **Effort:** XS.

### Minor 3 · `On hold` here, `Asleep` in the sidebar, for the same thing
- The pill group label is `On hold` (`src/BoringDecisionDesk.tsx:770`). The sidebar folder shows `Backlog · 2 💤 Asleep`. Nothing on the pills says why a project is on hold, or how to change it (move it out of the asleep folder). There's no `title` on the group or the pills.
- **Fix:** Pick one word. Recommendation: label the group `Asleep` to match the folder primitive the plan reuses, or keep `On hold` and add `title="In an asleep folder (Backlog). Wake the folder to make this Active."`. **Effort:** XS.

### Minor 4 · The pill's accessible name runs the name and count together
- The name and count are adjacent `<span>`s with no separator, so the accessible name is `VibeSquad2` / `Main Game Project1`.
- **Fix:** Add `aria-label="VibeSquad, 2 open"` or a visually hidden separator. **Effort:** XS.

### Note (pre-existing, not F1)
- Staged answers don't survive a reload: a typed Site answer was gone after reload (`logs/pass2-dark-1920.json` "reload with staged"). F1's promise is only that a toggle keeps them, and it does.
- The rail lists `Desk` and `Desk lane @desk` as separate rows for the hub. This is older than F1.

## Owner decisions
1. **Should the sidebar `Decisions` badge follow the pill filter?** (This settles Major 1.)
   - **Recommend: yes.** The badge shows the visible count only, so on-hold projects stop lighting it, which is what the owner asked for.
   - Alt: the badge shows `4 · +3` (visible plus hidden). Rejected as noise: it would still advertise on-hold work.
2. **Wording for the dimmed group: `On hold` or `Asleep`?** Recommend `Asleep` (Minor 3). It is the same primitive, so it should have the same word.

## Inbox cards (@desk)
- M1: the `Decisions · N` nav badge ignores the F1 filter (`useDecisionCount`, `src/BoringDecisionDesk.tsx:432`).
- m1: empty-state hidden count + `Show all`. m2: mark OFF pills that hold staged answers. m3: `On hold` vs `Asleep` wording + tooltip. m4: pill aria-label.
