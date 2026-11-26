# PLAN · Boring Mode B17 — Fix Deadspace in Agent Windows (`idea-1052`, UI Priority #1)

Lead: ★ Bor3 (`@bor`, `rn-e21bad032958`).

## Owner decision (2026-11-25, UI Priority #1)
> Owner GO on UI Priority #1: fix deadspace in agent windows ("the pick a lane ui thing") — eliminate the excessive left/right blank margins in wide agent chat windows (`src/boring.css`) AND replace the empty `Split · pick an agent` / empty-lane void (`src/BoringAde.tsx:662, 703-748, 1198`) with an actionable inline lane/agent picker and lane context. Coordinate `BoringAde.tsx` edits with `@desk` (Priority #2 Decision Desk).

## Decided
- **Part A — Responsive fluid chat column measure (eliminate wide-screen deadspace margins):**
  - Replace the cramped static `--measure-col: 880px; --measure-prose: 760px` (`src/boring.css:682-683`) with a fluid, wide-monitor-friendly measure:
    - `--measure-col: clamp(880px, 86%, 1360px)` (fills 100% cleanly on 1280×720 and split panes; expands to 1280–1360px on 1440p/4K instead of leaving 600–800px of blank void on each side).
    - `--measure-prose: min(100%, 960px)` (comfortable readable paragraph width while ~26% wider than 760px).
  - Keep `.timeline > *`, `.composer > *`, `.perm-card`, and `[data-testid="tl-pinned-todo"]` aligned on `--measure-col` so left/right edges stay crisp (`n5` invariant).
  - Tool blocks, code blocks, diffs, terminal output, permission cards, and the B16 composer bar use the full `--measure-col` width.
  - Update `test/boring-mode.test.mjs:714` to match the new fluid measure tokens.
- **Part B — Inline Lane / Agent Picker in `Split · pick an agent` (`src/BoringPanePicker.tsx` + `src/BoringAde.tsx`):**
  - Extract a dedicated `src/BoringPanePicker.tsx` component (keeps `BoringAde.tsx` diff tiny for clean coordination with `@desk` Priority #2).
  - Render `<BoringPanePicker>` inside `data-testid="boring-split-empty"` (preserving `boring-split-empty`, `boring-split-close`, and the `"Split · pick an agent"` breadcrumb for existing tests in `test/boring-mode.test.mjs:1632,1689,1692,1829-1835`).
  - Picker contents (filling the pane cleanly instead of a tiny centered text blurb):
    - **Header:** `"Pick an agent or lane"` + instant filter input (`Filter lanes or agents…`) + `Close split` button (`data-testid="boring-split-close"`).
    - **Needs you / Active now strip** (when any agents are running or need attention): 1-click cards showing bust/status dot, name, lane code, and short status/reason — clicking opens that agent directly into the active split pane.
    - **Project lanes grid** (Desk: Overlord, RiffBot, Bugs + all project lanes): 2-column responsive grid (1-column on narrow widths) with lane name, status dot, and direct **Buddy** / **Lead** quick-open pills so any lane opens in 1 click without hunting in the sidebar.
    - Compact footer hint: `"Shift+click any sidebar row to open it on the right."`
- **Part C — Enriched Empty-Lane View (`boring-empty-card` & `boring-lane-no-agent`):**
  - Preserve `data-testid="boring-empty-card"`, `data-testid="boring-empty-cta"`, `data-testid="boring-lane-no-agent"`, `data-testid="boring-lane-no-agent-head"`, and the existing status strings (`"No Brainstorm session..."`, `"No Lead is running yet"`, `"No Overlord is running"`, `"RiffBot is sleeping."`) so existing tests (`test/boring-mode.test.mjs:288-354,690-703,1887-2022`) stay green.
  - Widen and ground `.boring-empty-card` (`max-width: 720px`, left-aligned structured card with clean hierarchy instead of a tiny 440px box floating in a sea of void):
    - Primary status + Start CTA (`Start Brainstorm` / `Start Overlord` / `Start RiffBot` / `Switch to Brainstorm`).
    - **Available in this lane:** if the sibling role (Lead or Brainstorm) or live workers exist in this lane, show 1-click cards to jump straight to them.
    - **Other active lanes:** compact quick-jump row of currently active lanes in the project so an empty lane is never a dead end.
- **Theme, contrast & Psycho isolation:**
  - Scope every CSS rule under `html[data-vibe="boring"]` in `src/boring.css`; no `!important` or top-level `@keyframes` after the idea-528 block; never edit `src/styles.css` or `art/**`.
  - Dark + light WCAG ≥4.5:1 across all picker cards, filter input, pills, and empty-lane cards.
  - Preserve `@ui-bois` O2 measured sidebar constraints (60px/220px pin floor, 120px tree floor, master 1080 footer y).
- **Sequencing, coordination & provider:**
  - Coordinated with `@desk`: Priority #2 Decision Desk (`src/BoringDecisionDesk.tsx`, `Mode` union ~41, Needs-you sidebar entry, `.boring-decision-*`) is completely disjoint. **Real clash:** `@desk` U1 (`desk-u1-url-keys`, `b138d29b`) merges right after our B14–B16 push and rewrites `BoringAde.tsx ~682-691` to write a `slot=` key in the URL. Sequence: B14–B16 push → `@desk` U1–U3 merge → rebase B17 onto U1 and **preserve U1's `slot=` URL write in the empty-card path**.
  - Branch on top of B14+B15+B16 (`8b93a1fb` / latest `master` including O2 `1ccde974`), then rebase onto U1 once merged.
  - Use Claude (`Implement - Sonnet`, `{ ab: "pin" }`) during the owner's Claude-first window (through Thu 11-26 8:00 AM ET / 13:00Z).
- **Checked primitives:** `BoringAde` (`src/BoringAde.tsx:660-748, 1193-1201`), `boringSidebarModel`, `openTarget`, `pickCore`, `openLane`, `bustUrl` (`src/boringBusts.ts`), `boringStateGlyph`, `src/boring.css:682-683, 754-765, 802, 1265-1276`, `test/boring-mode.test.mjs:288-354, 714, 1632-1695, 1829-2022`. No new server endpoints, CLI verbs, or settings needed.

## Plan
| Block | Touches | Clashes with | Type |
|---|---|---|---|
| B17a Fluid chat column measure | `src/boring.css`, `test/boring-mode.test.mjs` | B14–B16 (`src/boring.css` — build on top of B14–B16 + O2) | Root cause |
| B17b Inline `Split · pick an agent` picker + enriched empty-lane view | `src/BoringPanePicker.tsx` (new), `src/BoringAde.tsx` (~703-748, ~1193-1201), `src/boring.css`, `test/boring-mode.test.mjs` | `@desk` Priority #2 Decision Desk (if touching `BoringAde.tsx` — surgical hunks only; picker isolated in `BoringPanePicker.tsx`) | Root cause |

Order: B17a + B17b together in one unit (or B17a → B17b on one branch `unit-bor-b17-deadspace`).

Done-check:
- Full test suite + `test/boring-mode.test.mjs` + `test/normal-invariants.test.mjs` green; typecheck clean.
- WCAG ≥4.5:1 in dark + light themes.
- Screenshots sent to Buddy (`rn-534c1cd1c774`) for look-check PASS:
  - 4K@120% (`3840x2160`) dark + light: **active chat window** (proving wide fluid column eliminates the huge left/right deadspace margins while prose stays crisp), **Split · pick an agent** (showing the inline lane/agent picker filling the right split pane), and **empty-lane view** (showing the enriched card with lane context).
  - 1280×720 dark: active chat window + Split picker confirming clean responsive fit with zero clipping/overflow.
- **UX Reviewer gate** (0 critical/major) + **Review-Gemini PASS** before merge & push to `origin/master`.

## Open
- None.

## Out of scope
Decision Desk / one-stop shop (`@desk` Priority #2), `idea-928` visual/gradient polish (B18, waiting on `@art` tokens), Psycho mode (`src/styles.css`), `art/**`.
