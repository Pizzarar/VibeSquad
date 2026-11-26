# UX Review R42: @bor B18 merged tree (B18a/b/c/d/e + @desk P3)

- **Tip:** `5841f7b0` on `bor-b18-merge`. That is B18b composer, B18d/e split, and B18a/c visual, merged after @desk P3 `ba6b2ede`.
- **Prior per-unit passes:** `docs/UX_REVIEW_R39_BOR_B18B.md`, `docs/UX_REVIEW_R40_BOR_B18DE.md`, `docs/UX_REVIEW_R41_BOR_B18AC.md` (r2).
- **Scope:** a focused regression pass on how the units interact with each other and with P3 (`?lane=` / `&role=` URL keys, and `?lane=` exiting the split like a Desk slot).

## Method
- **Build:** I rebuilt `dist` from the tip (`npx vite build`) and served it as static files.
- **App setup:** Playwright Chromium, `?demo=1`, Normal mode. I used R41's multi-project registry: VibeSquad pinned as Main, plus Main Game, Plugins (with `empty-p`) and Site (with the fully dormant `docs` lane).
- **Navigation scenarios:** 1280x720, 2560x1440 and 3200x1800 @1.2 DPR (4K@120%), in dark and light, with a fresh context per scenario.
  - Start state: the VibeSquad `Audit - token scout` worker (pending Allow/Deny) on the left, split open, and the picker on the right.
  - **Every navigation result was identical at all 6 size/theme combos**, and there were 0 page errors.
- **Composer rows:** I measured 10 layouts × 2 themes with the context panel forced open (`vs.context-panel.open=1`; it is collapsed by default at 1280). Each run clustered the visible controls into rows and checked whether Mode shares its row.
- **Scripts:** throwaway, in `/tmp/uxr42/{probe,probe2,probe3}.mjs`. Raw JSON is in `/tmp/uxr42/{comp2,nav,nav2}.json`.
- **Shots:** `docs/shots/ux-r42-bor-b18/`.

## Status vs the per-unit rounds

| Check | Unit round | Merged tree | Evidence |
|---|---|---|---|
| Composer ≤2 rows at 1280x720, ctx panel open | R39 fixed | **Holds.** 456px bar, 2 rows, 79px. | `compctx-1280-open-dark.png` |
| No orphaned Mode at about 550px | R39 fixed | **Holds.** The 542px bar (1366, ctx open) has 2 rows. Mode is never alone on a row in any of the 30 bars. | table below |
| R39 L2: 1280 split (421px panes) has 4 rows (3 when idle) | Minor, open | **Unchanged** (m2) | `compctx-1280-split-light.png` |
| Dormant other-project pill → right card, split and `&agent=` kept | R41 r2 fixed | **Holds.** `?team=efi&agent=demo-aud`, panes `left,right`, `UI-lab` card on the right, left pane is Audit with Allow/Deny intact. | `A-other-dormant-3200-light.png` |
| Same-project dormant pill → right card | B17 | **Holds.** The `UI Bois` Brainstorm card is on the right, the split is kept, and the URL is unchanged. | `B-same-dormant-2560-dark.png` |
| Shift+click on a dormant Bugs or Overlord row (same project), split open | R40 m2 fixed | **Holds.** The right card shows, breadcrumb `VibeSquad › Bugs` / `› Overlord`, no `slot=`. | `C-shift-bugs-1280-dark.png` |
| Shift+click RiffBot while the right pane is live | R40 | **Holds.** The RiffBot card replaces the right pane, and the left pane is kept. | nav.json `G_shiftRiff` |
| Plain click on a Bugs row while split → `slot=bugs` card → "◫ Back to split" | R40 m1 | **Holds.** Back to split restores `L=demo-aud`, the picker, `◫ Unsplit` pressed, and `&agent=demo-aud`. | nav.json `F_*` |
| **P3:** plain click on a dormant lane row while split → `?lane=` card that exits the split | P3 (R44) | **Holds, and it interacts correctly with B18d.** `?team=site&lane=docs` shows the full-screen `Site › docs › Brainstorm` card. The toggle reads `◫ Back to split`, and the `docs` row is selected. Back to split restores `?team=vibesquad&agent=demo-aud` with both panes and the Audit row selected. | `H-lane-card-1280-light.png`, `H-back-to-split-3200-dark.png` |
| Browser Back/Forward across `?lane=` ↔ split | P3 + B18d | **Correct in both directions.** Back gives `lane=docs` card, then split. Forward gives card, then split. URL, breadcrumb, selected row and panes agree at every step. | nav2.json `hBack*`/`hFwd*` |
| Cold load `?team=site&lane=docs&role=lead` | P3 | **Correct.** The `Site › docs › Lead` card shows, the `docs` row is selected, and there is no split toggle (no split open). | nav2.json `coldLaneLead` |
| Back/Forward after a dormant other-project card | R41 L4, minor accepted | **Unchanged.** Back is correct. Forward lands on the VibeSquad picker, not the card (m3). | nav.json `A_back`/`A_fwd` |
| Sidebar O2 floors | R41 hold | **Hold.** At 1280 the pin is 220 and the tree 120, collapsed and open. At 4K the pin is 563 and the tree 506. | `sidebar-3200-light.png` |
| Tree fade | R41 | **Present.** The computed `mask-image` linear-gradient is on the tree; the pin has none. | probe `side*` |

### Composer rows, ctx panel open (identical in dark and light)

| Viewport | Bar px | Rows | Mode alone? |
|---|---|---|---|
| 1280x720 | 456 | 2 | no |
| 1366x768 | 542 | 2 | no |
| 1440x900 | 616 | 2 | no |
| 1600x900 | 776 | 2 | no |
| 2560x1440 | 1522 | 1 | no |
| 4K@120% | 1654 | 1 | no |
| Split 1280x720 | 421 / 421 | 4 / 3 | no |
| Split 1400x800 | 481 / 481 | 2 / 2 | no |
| Split 1920x1080 | 732 / 732 | 2 / 2 | no |
| Split 4K@120% | 1243 / 1243 | 1 / 1 | no |

## Findings

No critical or major findings.

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| m1 | Minor | **Shift+click ignores Shift on two kinds of dormant row:** feature-lane rows in any project, and other-project Trinity rows. The picker says "Shift+click any sidebar row to open it on the right." Two cases, both while split:<br>• Shift+click `docs` (Site, no agents) behaves like a plain click: the full-screen `?team=site&lane=docs` card, with the split folded.<br>• Shift+click Main Game's Bugs or Overlord row does the same: `?team=efi&slot=bugs` / `slot=overlord`, full screen.<br>Nothing is lost, because `◫ Back to split` restores both panes in one click. But the hint is wrong for these rows, and the picker's own dormant pills (same-project and, since B18c, other-project) open the same cards on the right. This gap became visible with the merge: P3 made the lane empty card a URL screen that exits the split. B18d's m2 fix covered only Bugs/Desk in the current project. | Split triage: queue a dormant lane next to a live agent | `I-shift-lane-1280-dark.png`, `J-shift-other-bugs-2560-dark.png`; nav2.json `shiftLane`, probe3 output. **Cause:** `pickRole` (`src/BoringAde.tsx:597-608`) has no `shiftHeld()` branch for an empty member and goes straight to `onOpenPin`. `pickCore` and `pickBugs` (`:694`, `:700`) only take the right-card path when `teamId` is the current project. | In `pickRole`, when `!m && panes.split && shiftHeld()`, open the right card: `setRightCard({ key: laneId, pill: role })` for the current project, or `openOtherDormant(tid, …)` (`:873`) for another project. Drop the same-team guard in `pickCore`/`pickBugs` and route other teams through `openOtherDormant`. Add a browser test: Shift+click a dormant lane row while split keeps `panes.split` and `&agent=`. | `src/BoringAde.tsx`, `test/bor-b18-*.test.mjs` | XS–S |
| m2 | Minor | Carry-over from R39 L2: at 1280x720 split (421px panes), the composer bar is 4 rows (155px) running and 3 rows idle. The Think/Mode pair stays together, so this is not an orphaned-Mode case. | Two-pane chat on a laptop | `compctx-1280-split-light.png` | As R39: below about 480px, render ⇄Switch icon-only. | `src/BoringComposerBar.tsx`, `src/boring.css` | XS |
| m3 | Minor | Carry-over from R41 L4: Forward after Back from a dormant other-project card lands on the VibeSquad picker, not on the card. Nothing is lost. | Back/Forward | nav.json `A_fwd` | As R41. | `src/BoringAde.tsx` | XS |

## Checked, no issue
- **Invariants:**
  - On every split, card and lane-card screen, the URL, breadcrumb and selected row agree. One exception is the cross-project right card: the breadcrumb `Main Game › UI-lab` shows alongside `&agent=demo-aud`, which is R41 r2's accepted design.
  - At most one row is selected. Right-pane cards select no row, as at B17.
- **Counts:** Needs you `5` = VibeSquad's 4 + Main Game's Lead 75.
- **Browser Back from a same-project right card** leaves the split for the project Overview. The card pushes no history entry, so Back goes to the entry before the agent opened. This is the B17 pane-local design, not a regression.
- **Plain click on a lane row whose Lead is live, while split:** it opens the Lead in the active pane (`G_plainLaneWhileLive`). P3's split exit applies only to dormant lane cards, as specified.

## Owner decisions
None. m1 is a lane fix under R13.

## Verdict
The merged tree keeps every per-unit fix: composer ≤2 rows with no orphaned Mode, dormant other-project pills keep the split and `&agent=`, Shift+click on same-project Bugs/Desk goes to the right pane, Back to split works, and the O2 floors and fade hold. P3's `?lane=` split exit composes correctly with B18d's Back to split and with browser Back/Forward. There is one new minor gap (m1, Shift on dormant lane rows and other-project Trinity rows) and two carry-over minors.

PASS 0/0/3 5841f7b0
