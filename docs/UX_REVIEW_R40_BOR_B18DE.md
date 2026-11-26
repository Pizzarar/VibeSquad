# UX Review R40: @bor B18d+e (idea-1085): Back to split, Shift+click on a dormant row, N9

- **Branch:** `unit-bor-b18-split`
- **Tip:** `a1511918`
- **Base:** `e476f89e`
- **Origins:** m1 and m2 come from `docs/UX_REVIEW_bug_R1.md` / `docs/UX_REVIEW_bug_R2.md`, and N9 from `docs/UX_REVIEW_R34_BOR_B17.md`.

## How I tested
- I rebuilt `dist` from `a1511918` (`npx vite build`) and served it with `scripts/ui-overlap/env.mjs`, using `?demo=1` in Normal mode on Playwright Chromium.
- Six combos: 1280x720, 2560x1440 and 3200x1800 at DPR 1.2 (4K at 120%), each in dark and light. Every scenario ran in a fresh context.
- After each step I logged:
  - the URL and `history.length`
  - whether the split is open
  - the left agent and the right agent, card or picker
  - the active pane
  - the toggle's label, `aria-pressed` and `.on` state
  - the breadcrumb
  - the selected (`.on`) sidebar rows
  - `document.activeElement`
- The probe scripts and the full log (`probe.mjs`, `n9.mjs`, `m3.mjs`, `full.log`) are in `artifacts/boring-b18/ux-r40/`, with 24 screenshots. Four key shots are committed, and the rest stay untracked, as in earlier rounds.
- **Every scenario gave identical results at all 6 combos** once spawned ids were normalised. There were no page errors.

## Status vs. the previous rounds

| Item | Previous | R40 |
|---|---|---|
| **m1:** "◫ Unsplit" over the full-screen dormant card throws the split away | Open (bug R1/R2) | **Fixed** |
| **m2:** Shift+click on a dormant Bugs or Desk row ignores the "open on the right" hint | Open (bug R1/R2) | **Fixed** |
| **N9:** closing the split mid-start steals the single-pane agent | Open (B17 R34) | **Fixed** |
| B17 M4: a right-pane Start keeps the split | Fixed | Still fixed |
| Plain click on a dormant row, no split | OK | Still OK |
| Back/Forward and reload with `slot=` | OK | Still OK |

## m1: Back to split (6/6 combos)

**Both panes live: Audit on the left, UI Bois Lead on the right (A0).** I picked Bugs, then Overlord, then RiffBot from the sidebar.
- **Card:** each pick shows its full-screen card, and the URL changes to `slot=bugs`, `slot=overlord` or `slot=riffbot`.
- **Header button:** it reads `◫ Back to split` with `aria-pressed=false` and no `.on` styling.
- **After Back to split:** the screen returns to `L=demo-aud`, `R=demo-lead-ui-bois`, right pane active.
  - The breadcrumb reads `VibeSquad›UI Bois›Lead` and the selected row is `boring-lead-ui-bois`.
  - The toggle reads `◫ Unsplit` again with `pressed=true`.
  - Focus stays on the toggle.
- **History:** browser Back from the restored split returns to the slot card, and Back again returns to the split. Forward works the same way. No entry is lost.

**Left pane active, right pane on the picker (P0–P2), then sidebar Overlord.** Back restores `L=demo-aud` with the right pane still on the picker and the left pane active. This is exact.

**Keyboard (K1–K4).** I pressed Enter on the Bugs row, then Tab until focus reached the toggle, then Enter, and separately Space. Both keys restore the full split. Focus stays on the toggle, so a second press would act as `◫ Unsplit`. That is expected and matches the label.

**Discoverability (shots A1 and A2).**
- **Discoverable:** the pill sits in the toolbar where `◫ Unsplit` was, unpressed and in the same style as Search and Shortcuts.
- **Not noisy:** it is not accent-filled and adds no new chrome.
- See L1 for the 4K case.

## m2: Shift+click on a dormant row while split (6/6 combos)
- **Right pane on the picker, then Shift+click Bugs (M1):**
  - The split stays open, the left pane keeps `demo-aud`, and the right pane shows the B17 card `Bugs`.
  - The right pane is active and the breadcrumb reads `VibeSquad›Bugs`.
  - There is **no `slot=` in the URL**, and `history.length` doesn't change.
- **Right pane live (UI Bois), then Shift+click RiffBot (M3):** the split and the left pane are kept, and the right pane shows the `RiffBot` card. See **m1-R40** below for what is left behind.
- **← All lanes** from the card goes back to the picker (M4). Shift+click Overlord followed by browser Back keeps the card in the right pane and makes the left pane active (M5). That matches B17's pane-local card rule.
- **Start from the right card (S1, B17 M4):** `R=demo-bs-bugs-*` lands on the right, the left pane keeps `demo-aud` and the split stays open.
- **Without a split, Shift+click Bugs (R2)** acts as a plain click: a full-screen card with `slot=bugs`. That is correct, because there is no right pane to open it in.

## N9: closing the split mid-start (live: 54 runs, 40 of them truly mid-flight)

- **Code:** `src/pinFocus.ts:93`. `show(id, "right")` now returns without calling `openAgent` when the split is gone, which matches `Start Overlord`.
- **Method:** I ran the right-card Start for Bugs, RiffBot and Overlord, then clicked `Close split` in the same task after 0, 8 or 25 ms, for every combo.
- **Mid-flight runs:** in every run where `Close split` was still on screen (the start had not landed yet), the single pane kept `demo-aud` and the URL `agent=demo-aud`. That is **40/40**.
- **The other 14 runs** are not mid-flight. The demo start had already landed on the right, so the probe pressed `◫ Unsplit`, and `collapseSplit("active")` correctly kept the active right agent. This is not N9 behaviour. R34 had **12/12 steals** in this sequence.

## Findings

### m1-R40 (minor): Shift+click over a live right agent leaves that agent's switcher and URL on screen
- **Job hurt:** "breadcrumb = open agent", and sharing or reloading what you see. The rule is that the screen, the URL and the switcher name the same thing.
- **Evidence (M3, 6/6 combos; `m3.mjs`; shot `M3-shift-riffbot-1280x720-light.png`):**
  - With split on and UI Bois Lead live on the right, Shift+click RiffBot. The right pane shows the RiffBot card, and the breadcrumb reads `VibeSquad›RiffBot`.
  - But the URL still reads `agent=demo-lead-ui-bois`.
  - The toolbar still shows UI Bois's `○ Brainstorm | Lead · idle` switcher, with Lead pressed. UI Bois is no longer on screen.
  - Clicking that `Brainstorm` drops `agent=` from the URL and changes nothing on screen.
  - A reload brings UI Bois back on the right instead of the RiffBot card.
- **Compare M1:** the same Shift+click from the picker is clean. It shows no switcher, and the URL names the left agent, as B17 already does.
- **Cause:** `src/BoringAde.tsx:665`. `openRightSlotCard` clears `selectedLaneId` only when it is a slot lane (`LANE_SLOT[cur] ? null : cur`), so the UI Bois lane selection outlives its agent. `clearRightPane()` (`src/panes.ts:266`) hides the tab without moving the URL off it.
- **Fix:** in `openRightSlotCard`, set `setSelectedLaneId(null)` unconditionally and clear the worker selection too. The screen then matches the picker case (M1), and the URL falls back to the left agent the way B17's card already does. Add an M3 assertion to `test/bor-b18-split.test.mjs` for the switcher being absent and the URL not naming the hidden agent.
- **Files:** `src/BoringAde.tsx`, plus the test.
- **Effort:** XS.

### L1 (low): Back to split is quiet at 4K
- **Evidence:** at 3840 px it is about 90 px wide at the far right of the toolbar, in the same grey as Search and Shortcuts (`A1-bugs-card-3200x1800@1.2-*`). The card body gives no hint that a split is parked.
- **Assessment:** this is within "discoverable but not noisy". The owner sees the label where the Split/Unsplit button always sits.
- **Optional fix:** a one-line note under the card, "Your split is parked · ◫ Back to split", only when `panes.split`.
- **Effort:** XS. Not required.

### L2 (low): Back to split is not exact in two edge cases
- **(a) Right pane active on the picker (P3–P5):** Back restores the panes, but the **left** pane becomes active. `backId` falls back to `leftActiveId` (`src/BoringAde.tsx:1287`), and `openHere` then focuses the left pane.
- **(b) B17 card parked on the right (C0–C2):** after a sidebar slot pick, Back returns the right pane to the **picker**, not the parked card. This is because `enterSlotLane` clears `rightCard` on purpose (idea-1075 r3).
- **In both cases** nothing is lost: there is no agent in that pane, and one click restores it.
- **Optional fix for (a):** when the active pane has no tab, `setSelectedLaneId(null)` plus `setActivePane(panes.activePane)` instead of reopening the left agent.
- **Effort:** XS.

### L3 (low): the keyboard path from the sidebar to Back to split takes 31 Tabs
- **Evidence (K2):** after Enter on a Bugs row, focus stays on the row, and Back to split is 31 Tab presses away at all sizes.
- **Mitigation:** browser Back (Alt+←) also restores the split (A3/A4), so a quick keyboard path exists.
- **No action needed** unless a shortcut is wanted.

## Regressions checked
- **Plain click on a dormant row, no split (R1/R3):**
  - Full-screen card, `slot=` in the URL, and the selected row is the slot.
  - Back/Back/Forward walks `slot=overlord → slot=bugs → agent=demo-aud → slot=bugs` correctly.
  - A reload on `slot=bugs` comes back as the Bugs card.
- **B17 M4:** right-card Start keeps the split (S1, 6/6).
- **History with `slot=` around Back to split:** OK (A3–A5).
- **Sidebar selection:** exactly one selected row whenever the left or full screen owns it. When a right card or picker is active, there are zero selected rows, which is B17 behaviour and unchanged.
- **Pre-existing (not counted, unchanged):** the breadcrumb casing after a right-pane start that races a close (`VibeSquad›bugs›Brainstorm` with the `boring-conv-bugs` row, seen in my first slow probe) is the race-path landing on the lane row rather than the slot. It is cosmetic and was not reproduced in the mid-flight runs.

## Owner decisions
None. m1(a) "Back to split" was the recommended option in bug R1 and is what shipped.

## Verdict
- m1, m2 and N9 are fixed live at all 6 combos (1280, 2560 and 4K@120%, dark and light), with no regressions in plain-click, history/`slot=` or the B17 M4 paths.
- One minor finding is open: m1-R40, the stale switcher and URL after Shift+click over a live right agent. Three lows (L1–L3) are not blocking.
- There is no critical or major finding, so the gate passes.

PASS 0/0/1 a1511918
