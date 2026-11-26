# UX Review @bug R1: idea-1075 (dormant Bugs/Desk slot in Normal split)

**Verdict: FAIL 0/1/2 398c1f1a**

- **Branch:** `bug-1075-bugs-slot` at `398c1f1a`, which is 82b2fff4 merged on top of @bor B17 `334a9d4b`. B17 is not on master yet.
- **How it ran:** a `vite build` of this worktree, served on a random local port by `scripts/ui-overlap/env.mjs` (`serveDist` + `installRoutes`). It used the `?demo=1` cast in Normal mode. The live server was not touched.
- **Sizes and themes:** 1920×1080 dark, and 3200×1800@1.2 light. The state logs from the two runs are identical line for line.
- **Evidence:** everything is in `docs/ux-review-1075/`. The drivers are `drive.mjs` and `probe.mjs`. The step logs are `drive-log.txt` and `probe3-log.txt`.

## Status vs ask

| # | Sequence | Result |
|---|---|---|
| 1 | Split with both panes open → sidebar **Bugs** → Back → Forward → click agent | OK. Every step agreed: URL, crumb, screen and the single selected row. Bugs shows its empty card with the crumb `VibeSquad › Bugs › Brainstorm` and `?slot=bugs`. Back restores the split exactly (left Audit, right Review, right active). Forward shows the card again. Clicking an agent brings the split back and opens it in the active pane. Shots: `s1-bugs-02/03/05`. |
| 1b | The same, but with the **left** pane active and the right pane on the picker | **FAIL. See M1.** After the detour, the agent opens in the left pane, but the active pane flips to the right. The crumb then reads `Split · pick an agent` and no row is selected. |
| 2 | The same as 1 with **Overlord** and **RiffBot** (Desk) | OK, with the same pattern as Bugs. The crumbs are `Desk › Overlord` and `Desk › RiffBot`, and the slots are `?slot=overlord` and `?slot=riffbot`. Shot: `s1-overlord-02`. The left-active case fails the same way as 1b (probe G3). |
| 3 | Right pane active → B17 card for Bugs (and Overlord) → sidebar Bugs | OK. The B17 card stays in the right pane and the crumb reads `VibeSquad › Bugs`. The sidebar pick then clears it and shows the full card (`Bugs › Brainstorm`, `?slot=bugs`). Back returns to the split, with the right pane on the picker. The B17 card itself isn't restored, which is expected because it is pane-local and not kept in history. Clicking an agent then opens it in the right pane. Clicking the left pane moves the crumb to the left agent, and clicking back moves it to `Bugs`. Shots: `s3-bugs-01/02`. |
| 4 | Non-split mode | Unchanged. Bugs and Overlord each go card → Back → Forward → agent with matching crumb, URL and single selected row. |
| - | Reloading on `?slot=bugs` while split, and Ctrl+J from the card | OK. A reload shows the card. Ctrl+J opens the Needs-you agent and the split comes back intact. |

No `pageerror` events were logged in any run.

## Findings

### M1 (major): after a dormant-slot detour, the next agent opens in the left pane but the right pane becomes active, so the crumb and selected row stop matching what is open

- **Job hurt:** "open a worker" from split. This is step 1 of this unit: "click an agent: the screen and crumb agree each time."
- **Repro (probe G0 to G2, `probe3-log.txt`):**
  1. Turn on split, leaving the right pane on the picker.
  2. Click into the left pane (Audit). The state is `{a:"left"}`.
  3. Click sidebar **Bugs**. The card shows, and the stored state stays `{a:"left"}`.
  4. Click the Mechanical worker.
  - **Result:** `?agent=demo-mech`, with Mechanical in the **left** pane, but `activePane:"right"`. The crumb reads `VibeSquad › Split · pick an agent`, **0 rows are selected**, and the picker's filter has focus. Screenshot: `dark1920-g2-agent-after-dormant-left-active.png`.
  - The next sidebar click then lands in the right pane rather than replacing the left one.
- **Cause:** `src/BoringPanePicker.tsx:79` focuses the filter when the picker mounts (`useEffect(() => { filterRef.current?.focus(); }, [])`). The right pane's `onFocusCapture={() => setActivePane("right")}` at `src/BoringAde.tsx:892` turns that focus into an active-pane switch.
  - Before 1075, the split panes stayed mounted during a dormant pick.
  - Now `panes.split && !dormantSlot ? splitPanes : …` (`src/BoringAde.tsx:1299`) unmounts them, so returning to the split remounts the picker and it steals the active pane.
- **Not new to 1075:** the same thing happens from Project Overview → agent (probe H1/H2), which never touches 1075's code. The cause belongs to B17. But 1075 adds the main new way to reach it: a sidebar Bugs or Desk pick in split.
- **Fix (S, a few lines):** don't let the picker's mount-time focus change the active pane. Either option works:
  - (a) In BoringPanePicker, autofocus only when its pane is already active (for example a `autoFocus={panes.activePane === "right"}` prop from the host).
  - (b) In BoringAde, have the right pane's `onFocusCapture` ignore focus that isn't user-initiated. For example, use only `onMouseDownCapture`, plus focus from a keyboard Tab.
  - Option (a) is smaller and keeps keyboard focus-follow.
  - Add a browser test: split with the left pane active → sidebar Bugs → agent ⇒ `activePane==="left"`, the crumb names the agent, and exactly one row is selected.
- **Files:** `src/BoringPanePicker.tsx`, `src/BoringAde.tsx`.
- **Owner:** @bor (B17) for the cause, @bug for the regression test on the 1075 path.
- **Effort:** S.

### m1 (minor): the header shows a pressed "◫ Unsplit" over the full-screen dormant card, and clicking it quietly throws away the hidden split

- **Evidence:** in split, pick Bugs. The header shows `◫ Unsplit` even though there are no panes on screen (`s1-bugs-02`). Clicking it (probe B1 to B5) closes the split, and Back no longer brings back the two panes: `demo-rev` returns non-split.
- **Job hurt:** the owner can't tell that a split is parked behind the card. Pressing a button labelled "Unsplit" on a screen that isn't split loses the panes without warning.
- **Fix:** while `dormantSlot && panes.split`, change the pill to **"◫ Back to split"**, which reopens the last active agent. Alternatively, show it disabled with the tooltip "Split returns when you open an agent". See the owner decision.
- **File:** `src/BoringAde.tsx` (header split toggle, ~:1278).
- **Effort:** S.

### m2 (minor): Shift+click on a dormant Bugs or Desk row ignores the "open it on the right" hint

- **Evidence:** the split picker's hint reads "Shift+click any sidebar row to open it on the right." Shift+clicking sidebar **Bugs** while split (probe C1) does the same as a plain click: a full-screen card with `?slot=bugs`. B17's right-pane card for Bugs exists, but Shift+click doesn't use it.
- **Job hurt:** starting Bugs next to the agent you are watching takes three steps (split → picker → Bugs pill) when the hint promises one.
- **Fix:** in `pickBugs` / `pickCore` (`src/BoringAde.tsx` ~:655-670), if `shiftHeld()` and split is on, call `setRightCard({key})` with the right pane active instead of selecting the lane.
- **Effort:** S.

## Owner decisions

1. **What the split button shows over a dormant card (m1).** Options:
   - (a) "◫ Back to split", which reopens the parked panes.
   - (b) Hide or disable it while the card is up.
   - (c) Leave it as is.

   **Recommendation: (a).** It turns the hidden state into something the owner can see and reach in one click.

## Observations (not findings)

- When you go Back over a B17 right-pane card, the split returns with the right pane on the picker rather than on the card. That matches B17's decision to keep the card pane-local, so it isn't counted as a finding.
