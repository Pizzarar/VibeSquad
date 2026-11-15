# D3c Review: Normal-mode Right Context Panel (`UX_REVIEW.md` §2.8, §4)

**Verdict: FAIL** (4 MUST, 5 NICE)

Reviewed at 3200×1800 CSS px (4K at 120% zoom), Dark and Light themes:
- `docs/shots/desk-d3/d3c-dark-panel-workers.png`
- `docs/shots/desk-d3/d3c-dark-panel-changes.png`
- `docs/shots/desk-d3/d3c-dark-collapsed.png`
- `docs/shots/desk-d3/d3c-light-panel-workers.png`
- `docs/shots/desk-d3/d3c-light-panel-changes.png`
- `docs/shots/desk-d3/d3c-light-collapsed.png`

---

## Criteria Scorecard

| Criterion | Verdict | Evidence |
|---|---|---|
| **1. One right column only** | **PASS** | Single `aside.boring-context-panel` renders on the right; the legacy inner `RightDock` is absent in all 6 shots. |
| **2. Tab bar legibility** | **PASS (with nits)** | `13px/20px` (`--t-ui`) tabs are clear in both dark and light themes with `--surface-3` + `600` weight on the active tab, though 6 tabs crowd the 460px header (NICE-1), bar height is ~32px instead of 36px (NICE-5), and two collapse buttons compete (MUST-4). |
| **3. 460px width balance vs 880px chat column** | **PARTIAL (FAIL on composer)** | The 460px right panel balances the 340px left sidebar and 880px centred timeline well, **except** the composer row spans under the context panel and centres across `centre + right`, shifting ~230px right of the 880px conversation column (MUST-1). |
| **4. Row rhythm (32px)** | **FAIL** | Worker rows are two-line cards at ~56–58px height (`running · 2s` repeated on line 2, plus wrapped URL on error row), and Changes file rows are ~42px tall. Neither matches the 32px desktop row rhythm of the sidebar (MUST-2, MUST-3). |
| **5. Dark and light contrast** | **PASS** | `--surface-1` (`#1a1624` dark / `#ffffff` light) against `--surface-0` (`#14111c` / `#f6f4f9`), primary names in `--text-1`, metadata in `--text-3`, and semantic status dots (`--st-run`, `--st-attn`, `--st-err`) pass AA contrast in both themes. |
| **6. Consistency with D3a header & D3b timeline** | **PARTIAL** | Header role subtitle is now sentence-case (`Brainstorm`), and typography/surfaces match D3a/D3b. However, the composer misaligns with the D3b timeline column (MUST-1), `Dock ▶` in the D3a header duplicates the panel's `▶` button (MUST-4), and the Changes tab retains legacy unpadded `RightDock` styling (MUST-3). |
| **7. Collapsed state affordance** | **PARTIAL** | The 36px collapsed rail with vertical `◀ Context` works and re-centres the timeline, but the button border/surface nearly disappears in light mode and carries no attention badge for the 3 alerting workers (NICE-4). |

---

## Required Fixes (MUST)

1. **MUST-1 · Align the composer with the 880px conversation column when the context panel is open** (`src/AgentDrawer.tsx`, `src/boring.css`):
   - **Evidence:** In `d3c-{dark,light}-panel-{workers,changes}.png`, the timeline column (`880px` max-width) centres inside the remaining middle pane (`1fr - 460px`), while `.composer` sits below `.drawer-shell` across the full width (its top border runs underneath the open context panel) and centres across `1fr + 460px` — shifting ~230px right of the message column. In `d3c-*-collapsed.png`, they align.
   - **Fix:** Place `<Timeline>` and `.composer` inside the same flex column (`.drawer-main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }`) with `<BoringContextPanel>` as a sibling in `.drawer-shell` (`flex-direction: row`), so both `.timeline > *` and `.composer > *` centre inside the exact same `1fr` column (`max-width: 880px; margin-inline: auto`).

2. **MUST-2 · Enforce 32px single-line worker row rhythm and single-line ellipsis on alert reasons** (`src/BoringContextPanel.tsx`, `src/boring.css`):
   - **Evidence:** In `d3c-{dark,light}-panel-workers.png`, every `.boring-ctx-worker` row renders two stacked lines (~56–58px tall) because `running · 2s` is placed on a second line, and `Review - Gemini - retry` wraps a raw URL across two lines (~74px tall).
   - **Fix:**
     - Style `html[data-vibe="boring"] .boring-ctx-worker` with `grid-template-columns: 14px 1fr auto; min-height: 32px; padding: 6px 12px; align-items: center; gap: 4px 8px;` and set `.boring-ctx-list { gap: 0; }`.
     - For normal running/idle rows, keep a single 32px line: status dot + worker title (`--t-ui` `13px/20px`, truncated) + right-aligned age (`--t-caption` `11px/16px`, `color: var(--text-3)`), matching the left sidebar worker rows.
     - Render `.boring-ctx-worker-meta` (`grid-column: 2 / -1; font: 400 12px/16px var(--font-sans); color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`) **only** when the worker has an active attention reason or error (`m.attention` or `status === "error"`), with the full string in `title`.

3. **MUST-3 · Apply Normal panel padding (16px), 32px row height, and non-clipped commit layout to the Changes tab** (`src/boring.css`):
   - **Evidence:** In `d3c-{dark,light}-panel-changes.png`, the branch chip and commit input sit nearly flush against the left border (`0–4px` inset), the `Commit` button is clipped on the right edge, file rows are ~42px tall, and `Keep all` / `Undo all` / `Discard` use heavy `600`-weight styling that overpowers the file paths.
   - **Fix:** Scope under `html[data-vibe="boring"] .boring-ctx-body`:
     - Add `padding: 16px; box-sizing: border-box; overflow-x: hidden;` to the Changes container (`.changes-panel` / `.right-dock-body`).
     - Set file rows to `min-height: 32px; padding: 4px 8px; align-items: center;` with file path in `--t-mono` (`13px/20px`).
     - Style per-file action buttons (`Keep all`, `Undo all`, `Discard`) at `font: 500 12px/16px var(--font-sans); color: var(--text-2); background: transparent; border: 1px solid var(--border); padding: 2px 8px;`, colouring `Discard` with `color: var(--st-err)` on hover/focus only.
     - Fix the commit row with `display: flex; gap: 8px; width: 100%; box-sizing: border-box;` where the input has `flex: 1 1 0; min-width: 0;` and the `Commit` button has `flex: 0 0 auto;` so it never clips.
     - Use `24px` vertical spacing (`--sp-5`) between the file list, commit block, and git action links (`UX_REVIEW.md` §4.2).

4. **MUST-4 · Remove the duplicate `Dock ▶` button from `.boring-agent-header` when the context panel is open** (`src/BoringAgentHeader.tsx`, `src/boring.css`):
   - **Evidence:** In `d3c-{dark,light}-panel-{workers,changes}.png`, `Dock ▶` in `.boring-agent-header` sits immediately above-left of the context panel's own `▶` collapse button (`.boring-ctx-collapse`). Both toggle the same panel, and "Dock" is legacy terminology.
   - **Fix:** Keep `.boring-ctx-collapse` (`▶`) in the context panel tab bar and `.boring-ctx-rail-btn` (`◀ Context`) on the collapsed rail as the primary toggles. In `src/BoringAgentHeader.tsx`, either hide `[data-testid="boring-dock-toggle"]` while the context panel is open (`display: none` when open) or render it as a single subtle icon toggle without the legacy `"Dock"` label.

---

## Polish Fixes (NICE)

1. **NICE-1 · Keep the 4 spec tabs (`Workers · Changes · Plan · Feed`) primary and tuck `Files · Terminal` into overflow** (`src/BoringContextPanel.tsx`, `src/boring.css`):
   - `UX_REVIEW.md` §4.3 specifies 4 tabs (`Workers · Changes · Plan · Feed`). Showing all 6 tabs leaves no room for tab counts (e.g. `Workers 11`, `Changes 3`). Keep `Files` and `Terminal` under a trailing `⋯` overflow menu (or show them dynamically when activated via `vs:open-right-dock`), preserving `data-testid="boring-context-tab-files"` and `boring-context-tab-terminal`.

2. **NICE-2 · Match the sidebar's idle worker filter (`6 idle` vs `7 idle workers hidden`) and make the footer expandable** (`src/BoringContextPanel.tsx`):
   - In `d3c-*-panel-workers.png`, the bottom caption reads `7 idle workers hidden` while the left sidebar for the same lane reads `▸ 6 idle` (`WorkersTab` includes `status === "closed"` workers that `pins.ts` excludes). Filter out `m.agent.status === "closed"` in `src/BoringContextPanel.tsx` (`WorkersTab`) and render the footer as an interactive `▸ 6 idle` disclosure button in `--t-small` (`12px/16px`, `color: var(--text-3)`).

3. **NICE-3 · Deduplicate the in-timeline `Plan / Tasks (0/3)` bar when the Context Panel `Plan` tab is open** (`src/Timeline.tsx`, `src/BoringContextPanel.tsx`):
   - Hide the inline `Plan / Tasks` bar in `Timeline.tsx` when the right context panel is open on `Plan`, or make clicking the inline bar open the `Plan` tab in `BoringContextPanel`.

4. **NICE-4 · Increase collapsed rail contrast in light mode and show an attention badge** (`src/BoringContextPanel.tsx`, `src/boring.css`):
   - In `d3c-light-collapsed.png`, `.boring-ctx-rail-btn` (`◀ Context`) is barely visible against `#ffffff`. Style `html[data-vibe="boring"] .boring-ctx-rail-btn` with `background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--text-2); padding: 12px 6px;`.
   - When the lane has alerting/errored workers (3 in the demo cast), render a compact severity pill badge (`3`, using `--st-err` or `--st-attn` per `UX_REVIEW.md` §4.5) at the top of `.boring-ctx-rail-btn`.

5. **NICE-5 · Set tab bar height to 36px with a 2px `--accent` active indicator** (`src/boring.css`):
   - Set `html[data-vibe="boring"] .boring-ctx-tabs { min-height: 36px; padding: 0 8px; align-items: center; }` and `.boring-ctx-tab { height: 28px; padding: 0 10px; }` (`UX_REVIEW.md` §4.2 fixed heights: tabs 36px), or use a `2px solid var(--accent)` bottom bar on `.boring-ctx-tab.on` to match the selected row treatment.
