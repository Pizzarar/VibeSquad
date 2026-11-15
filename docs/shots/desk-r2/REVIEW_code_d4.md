# Code Review · `unit-desk-d4-polish` (`76abcc9`)

FAIL 0/1/2 76abcc9

## Scope & Verification
- Branch / HEAD: `unit-desk-d4-polish` (`76abcc9`, diff against `origin/master` `2a4a2b8`)
- Changed files: `src/BoringContextPanel.tsx`, `src/boring.css`, `test/desk-d4-polish.test.mjs`, `docs/shots/desk-r2/d4-*.png`
- Typecheck: `npx tsc --noEmit` — PASS (exit 0)
- Tests: `node --test test/desk-d4-polish.test.mjs test/desk-d3c-context-panel.test.mjs test/sky-live-fix.test.mjs test/boring-mode.test.mjs test/prefs.test.mjs` — PASS (83/83)

## Checklist
- **Composer top border stops at `BoringContextPanel` edge:** PASS (`src/boring.css:1109-1113` sets `--d4-panel-w: 460px` when `[data-open="true"]` and `36px` when `.collapsed`, drawing the top border via `::before` up to `right: var(--d4-panel-w)` and continuing the panel surface/left border via `linear-gradient` + `::after`).
- **`.boring-ctx-tabs` are 36px with a 2px accent underline:** PASS (`src/boring.css:1114-1117` sets `min-height: 36px` on `.boring-ctx-tabs`, `height: 36px` and `border-bottom: 2px solid transparent` on `.boring-ctx-tab`, and `border-bottom-color: var(--accent)` on `.boring-ctx-tab.on`).
- **`▸ N idle` line in Workers tab expands:** PASS (`src/BoringContextPanel.tsx:62-86` replaces the static footer with `button.boring-ctx-idle-toggle[data-testid="boring-ctx-idle-toggle"][aria-expanded]` and renders idle worker buttons when expanded, including when `live.length === 0`).
- **Worst-state badge on collapsed `◀ Context` rail:** FAIL — see **M1** below.
- **Plan tab hides duplicate `[data-testid="tl-pinned-todo"]` only in Normal mode while Plan tab is open:** PASS (`src/BoringContextPanel.tsx:202` sets `data-open="true" data-tab={tab}` only on the expanded panel, and `src/boring.css:1125` scopes `.drawer:has(.boring-context-panel[data-open="true"][data-tab="Plan"]) [data-testid="tl-pinned-todo"] { display: none; }` under `html[data-vibe="boring"]`).
- **`chatOnly` invariants (`test/sky-live-fix.test.mjs`):** PASS (`src/AgentDrawer.tsx:679` `vibe === "boring" && !chatOnly` is untouched; `test/sky-live-fix.test.mjs` passes 3/3).
- **`data-testid` attributes kept:** PASS (all existing testids preserved; added `boring-ctx-idle-toggle` and `boring-ctx-rail-badge`).
- **CSS scoped under `html[data-vibe="boring"]` with no new `@media`:** PASS (`src/boring.css:1107-1125`).
- **No edits to `src/styles.css` or `art/**`, Psycho mode unchanged:** PASS.

## Cause-vs-Symptom Gate
- **Does this fix the cause or hide the symptom?** Fixes the root cause for the 36px tab bar, idle worker disclosure, Plan pinned-todo deduplication, and composer/panel border seam (within the Normal-mode CSS scope constraint that forbids editing `src/styles.css` or breaking DOM child selectors in `AgentDrawer.tsx`). However, the collapsed rail badge (`M1`) has a logic bug that undercounts alerting workers when both error and attention states are present.

## Findings

### High (0)
None.

### Medium (1)
- **M1 · Collapsed rail badge counts only `err` workers when both `err` and `attn` workers exist (`src/BoringContextPanel.tsx:181-190`, `test/desk-d4-polish.test.mjs:20-25`):**
  - `src/BoringContextPanel.tsx:189` returns `err > 0 ? { tone: "err", n: err } : attn > 0 ? { tone: "attn", n: attn } : null`.
  - When a lane has 1 `err` worker and 2 `attn` workers (as in `docs/shots/desk-r2/d4-dark-collapsed-rail.png`), the badge renders `1` with `aria-label="1 need attention"`, dropping the 2 `attn` workers and contradicting the `Needs you` count (`3`).
  - Per `docs/PLAN_DESK_R2_SIDEBAR.md:29`, "worst-state badge" means the badge *colour* reflects the worst state (`tone: err > 0 ? "err" : "attn"`) while the *count* reflects total alerting workers in the container (`n: err + attn`).
  - Fix: `return err + attn > 0 ? { tone: err > 0 ? "err" : "attn", n: err + attn } : null;` and update `test/desk-d4-polish.test.mjs:21` to assert `err + attn` instead of `n: err`.

### Low (2)
- **L1 · Redundant nested block braces in `renderWorker` (`src/BoringContextPanel.tsx:89-105`):**
  - `renderWorker` has two extra `{ { ... } }` block layers around its body (`lines 90-91` and `103-104`).
- **L2 · `badge` memo runs `resolve(agents)` even while the context panel is open (`src/BoringContextPanel.tsx:181-190`):**
  - `badge` is only rendered when `!open` (`line 196`), so `useMemo` can short-circuit `if (open) return null;` with `open` in its dependency array.
