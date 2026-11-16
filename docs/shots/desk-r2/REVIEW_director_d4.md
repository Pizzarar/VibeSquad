# D4 Review: Normal-mode right panel and composer seam polish

**Verdict: FAIL** (1 MUST, 4 NICE)

Reviewed at 3200×1800 (4K at 120%), dark and light:
`docs/shots/desk-r2/d4-{dark,light}-{panel-workers-idle,panel-plan,collapsed-rail}.png`.
Follow-up to the NICE items in `desk-d3/REVIEW_director_d3c.md`. Gate: chrome readability (art-direction SPEC).

## D3c NICE carry-over scorecard

| D3c item | Result | Evidence |
|---|---|---|
| Composer border stops at panel edge | **PASS** | The composer's top hairline ends at the context panel's left border in both themes, and the composer centres under the 880px timeline column. |
| 36px tab bar + 2px accent underline | **PASS** | The active `Workers` / `Plan` tab has a 2px `--accent` underline. The bar is about 36px. Inactive tabs are `--text-2` and read cleanly on both surfaces. |
| `▸ N idle` expands | **PASS** | `▾ 6 idle workers` expands to 6 rows with hollow glyphs and dimmed names, so they are clearly secondary to the live rows. The count matches the sidebar `6 idle`, which fixes the D3c 7-vs-6 mismatch. |
| Worst-state badge on collapsed rail | **FAIL** (MUST-1) | The badge is there, with `--st-err` fill and readable contrast in both themes. Its count is wrong (see MUST-1). The light-mode rail button now has a visible surface and border. |
| Plan tab hides the duplicate pinned todo | **PASS** | With `Plan` active, the inline `Plan / Tasks (0/3)` bar is gone from the timeline. It returns on the Workers tab and when collapsed, as intended. |

## MUST

1. **The rail badge must count everyone who needs attention, not only the worst tier** (`src/BoringContextPanel.tsx:181-190`).
   - Evidence: `d4-*-collapsed-rail.png` shows a red **`1`**, but the lane has 3 alerting workers (1 err: Review · Gemini · retry; 2 attn: Review · Sonnet · drawer and Audit · token scout). `Needs you` shows **3**. The `aria-label` reads "1 need attention", so the badge and Needs you contradict each other, which is the "badge that points to nothing" problem from UX_REVIEW S1.
   - Fix: `return err + attn > 0 ? { tone: err > 0 ? "err" : "attn", n: err + attn } : null;`. The colour stays the worst state (R2.6) and the number becomes the total. Add a test in `test/boring-mode.test.mjs` with 1 err + 2 attn that expects `n === 3` and tone `err`.

## NICE

1. **Make the idle disclosure chevron the same size as the sidebar's.** The `▾` / `▸` before `6 idle workers` is about 5px and hard to see at 4K. Give it the 16px chevron column from R2.6 (`.boring-ctx-idle-toggle::before { width:16px; display:inline-grid; place-items:center; }`) so it lines up with the 14px status-dot column above. Match the sidebar label (`6 idle`) or use `6 idle workers` in both places.
2. **Remove the second toggle when the panel is collapsed.** In the collapsed shots the header still shows `Dock ◀` (`BoringAgentHeader.tsx:199`) right next to the rail's `◀ Context`, and "Dock" is legacy wording (D3c MUST-4). Hide `[data-testid="boring-dock-toggle"]` in Normal mode in both states, so the rail button is the only opener and the tab-bar `▶` the only closer.
3. **Remove or label the stray glyph in the composer.** There is a small `◂` glyph left of `Send`, next to the textarea resize grip, in all shots. It has no label and reads as noise. Remove it, or give it a 16px icon box with a `title`/`aria-label`.
4. **Lower the weight of the tab-bar collapse button.** The boxed `▶` at the right end of the tab bar has a full border and draws more attention than the active tab. Make it a borderless `--text-3` icon button with a hover surface, so it still reads as chrome rather than a call to action.

## Notes (no action)
- In the Plan tab, the historical TodoWrite card (`Duet builds / Cross-critique / Show user 2 options`) still appears in the timeline. It is a past tool result rather than the pinned bar, so keeping it is fine.
- The sidebar still has the separate `Project desk` / `Lanes` blocks. That is out of scope here and is tracked by `unit-desk-r2-sidebar`.
