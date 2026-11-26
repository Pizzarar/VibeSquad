# UX Review @bug R2: idea-1075 re-run

**Verdict: PASS 0/0/2 1aa7d899**

- **Branch:** `bug-1075-bugs-slot` at `1aa7d899`. The r3 fix since R1 did two things:
  - All three ways a slot becomes the screen (a sidebar pick, a Back/Forward landing, and a cold load of `?slot=`) now go through one `enterSlotLane` function, which clears B17's right card.
  - The split picker only grabs focus when it mounts if the right pane is active (the new `focusOnMount` prop).
- **How it ran:** the same harness as R1. I rebuilt `dist` with `vite build`, served it on a random local port with mocked routes (`scripts/ui-overlap/env.mjs`) and the `?demo=1` cast. The live server was not touched.
- **Sizes and themes:** 1920×1080 dark, and 3200×1800@1.2 light. The state logs from the two are identical line for line, and no `pageerror` events were logged.
- **Evidence:** in `docs/ux-review-1075/`, the logs are `r2-drive-log.txt` and `r2-probe-log.txt`, and the screenshots are `r2-*.png`. The drivers `drive.mjs` and `probe.mjs` were updated in place.
- **Invariant check:** I ran an automated check over all 106 logged driver steps. Each step had to meet three conditions:
  - On a `?slot=` URL, the full card shows, the split is hidden, and the only selected row is that slot's row.
  - In split with an agent pane active, the single selected row is that pane's agent, and the URL names that agent.
  - In split with the picker active, no row is selected.

  **0 failed.**

## Status vs R1

| R1 item | Status | Evidence |
|---|---|---|
| **M1:** after a dormant detour with the left pane active, the next agent click flipped the active pane to the right | **Fixed** | Probe G2 (Bugs), G3 (Overlord), G8 (RiffBot with both panes open) and G4–G6 (the detour plus Back and Forward) all end with `activePane:"left"`, the clicked agent in the left pane, a matching crumb, and exactly that agent's row selected. The path through Project Overview (H2), which had the same cause in B17, is fixed as well. When the right pane is already active, the filter still gets focus when the picker opens (K1). Screenshots: `r2-dark1920-g2-…`, `r2-dark1920-s1b-bugs-06-…`. |
| **m1:** a pressed "◫ Unsplit" shows over the full-screen dormant card, and clicking it drops the hidden split | Open, not touched | Probe B1–B5 match R1. |
| **m2:** Shift+click on a dormant Bugs or Desk row ignores the "open it on the right" hint | Open, not touched | Probe C1 matches R1. |

## The four sequences, plus Back/Forward with B17's card open

| # | Sequence | Result |
|---|---|---|
| 1 | Split with both panes open → sidebar Bugs → Back → Forward → click agent | OK, the same as R1. |
| 1b | The same with the left pane active and the picker on the right | **Now OK.** Back brings the left pane back active, with the right pane still on the picker. The agent click opens in the left pane, and the crumb and selected row match it. |
| 2 | Desk (Overlord and RiffBot), as in 1 | OK. |
| 3 | Right pane active → B17 card → sidebar Bugs → Back → Forward → agent | OK. The sidebar pick replaces the card with the full slot card. Back now lands with the left pane active on Audit, which is the restored history entry, and the crumb and row agree. |
| 4 | Non-split mode | Unchanged and OK. |
| 5 | **B17 card open** (Bugs and Overlord) → Back → Forward → agent | OK. Back moves the left pane through its history (Mechanical, then Audit, then back to Mechanical on Forward), makes the left pane active, and the crumb and row follow it. The B17 card stays parked in the right pane because it is pane-local, and an agent click goes into the active left pane. Screenshots: `r2-dark1920-s5-bugs-01/02`. |
| - | Reload on `?slot=bugs` while split, and Ctrl+J from the card | OK. |

## Findings still open (minor)

- **m1 and m2:** these are unchanged from `docs/UX_REVIEW_bug_R1.md`, which has the details, fix and owner decision. Neither one blocks this unit.
