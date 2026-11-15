# Director review: @desk Unit 1 (unit-desk-r2-sidebar), round 1

Verdict: **FAIL** (4 MUST, 5 NICE)
Branch `unit-desk-r2-sidebar` @ `43e6d04`. Shots: `docs/shots/desk-r2/r2-{dark,light}-{sidebar-overview,sidebar-chat-worker,overview-table}.png`. The shots are 3200x1800 CSS px, i.e. 4K at 120%.
Bar: `docs/UX_REVIEW_R2.md` rules 1-7, `docs/PLAN_DESK_R2_SIDEBAR.md` Decided (R2.1/2.2/2.3/2.5/2.6), and art-direction SPEC U4 (WCAG >= 4.5:1, chrome readability first).

## Checklist

| Check | Result | Evidence |
|---|---|---|
| One tree shape, no detached bottom sections | PASS (only one project shown) | `Project desk` / `Lanes` / `Overview` / `+ New project` blocks are gone. Desk, Bugs and lanes sit under the VibeSquad row. None of the shots has a second project, so "every project renders the same way" can't be checked. See M4. |
| State dots on the 16px chevron column | PARTIAL | Project, Desk, Bugs and lane dots line up. Desk children are indented one level. **Worker rows under an expanded lane are not indented**: their dots sit on the lane-dot column. See M1. |
| Exactly one highlighted row, matching the breadcrumb | PASS | Overview: only the VibeSquad project row is highlighted, and the crumb reads `VibeSquad › Overview`. Chat: only the `Art Painter - Opus · neon-noir` row is highlighted, and the crumb reads `VibeSquad › VibeSquad › Art Painter - Opus · neon-noir`. |
| Worker crumb shows the worker title | PASS | The chat header crumb ends with the worker title, not "Brainstorm". |
| Badges only on collapsed containers, worst-state colour | PASS (colour) / FAIL (light contrast) | Collapsed VibeSquad lane: red `3` (it contains an error). Expanded, it shows no badge. The light-theme text fails contrast. See M2. |
| Search header, Projects [+], [+ lane] | PASS | `VibeSquad` title plus `⌕ Search  Ctrl+K`. `Projects` heading has `+`. `+ lane` shows on the selected project row. The Overview has `+ New lane`. |
| Single Desk row in the Overview table | PASS (shape) / FAIL (data) | There is one Desk row and no `_overlord`/`_riffbot` rows. The Bugs row puts the lead status in the Brainstorm column (M3), and the Desk/Bugs order differs from the tree (N1). |
| Dark contrast | PASS | Body text, ages, dots and badges are readable at 120%. |
| Light contrast | FAIL | The sidebar `3` badges and the table's `Needs you · 3` pill have dark text on dark fills. See M2. |
| Consistency with D1-D3 on master | PASS | The same flat surfaces, type scale, segmented tabs, header strip and right-panel Workers list are used. |

## MUST

1. **Worker rows are not indented under their lane.**
   - In `r2-*-sidebar-chat-worker`, the dots for `Art Painter … OpenCode · hooks` sit at the same x as the lane dots (VibeSquad, UI Bois, Art Direction): about 33 px in the 2000-wide view. Desk children (`Lead · Overlord`) sit at about 42 px. The `▸ 6 idle` chevron is off-grid at about 35 px.
   - **Fix:** in `src/boring.css`, give `.boring-worker-list` (lane and desk worker lists) the same left inset as the Desk member rows, one level = 16px (`padding-left: calc(var(--tree-indent, 16px) * 2)` or match the desk-child rule). Put the `▸ N idle` toggle on the same 16px chevron column (`width:16px; flex:0 0 16px`), so its chevron sits under the worker dots' chevron slot.
   - **Why it's a must:** without the indent, 12 workers read as sibling lanes, which brings back the "which block belongs to what" confusion this review exists to fix.

2. **Light-theme badges fail WCAG.** The text is `rgb(43,24,64)`:
   - on `#8a5700` (amber `Needs you` count and the table pill): **2.63:1**;
   - on `rgb(194,42,82)` (red `.boring-badge.err` in the tree): **2.87:1**;
   - white on the same fills would be **6.1:1** and **5.6:1**.

   **Cause:** `src/styles.css:6055` forces `.badge { color: var(--on-pastel) !important }` everywhere outside `.sidebar`. That beats the non-important `#ffffff` light rules at `src/boring.css:883` and `:1137`, and the duplicate `.boring-badge.err` light rule near `:1136`.

   **Fix (boring.css only):**
   ```css
   html[data-vibe="boring"][data-theme="light"] .boring-badge { color: #ffffff !important; }
   ```
   Then delete the duplicate `.boring-badge.err` pair, so one rule is left at `:1136-1137`.

3. **The Bugs row in the Overview table has its columns swapped.**
   - `src/BoringAde.tsx` `boringLaneTableRows`, the `bugsRow` currently sets `brainstorm: bugs.leadRunning ? "running" : "none", lead: "—"`.
   - **Fix:** set `brainstorm: "—", lead: bugs.leadRunning ? "running" : "none"` (or the real Bugs Buddy status if `bugs.pin.brainstorm` exists).
   - Same file: the Desk row reads `"—"` in Lead and Brainstorm in the shots. That's only because `?demo=1` has no hub agents. See M4.

4. **The evidence doesn't cover the done-check.** The plan's Unit 1 done-check needs "single `.on` row matching the breadcrumb **across project switches and Ctrl+J**". Every shot has one project and a Desk with no live Overlord/RiffBot. In `scratch/shoot-r2.mjs`, use `?demo=1&riff=1` so Desk's Lead/Brainstorm are live and the Desk table row is filled, inject or add a second project, and add three shots (dark + light):
   - (a) two projects expanded, showing the identical shape (the R2-1 repro, compare with `ux-review-r2/02-two-projects-two-shapes-sidebar.png`);
   - (b) after Ctrl+J opens a worker in the *other* project: the crumb and the single `.on` row are both in that project, and its parents are auto-expanded (the R2-2 repro, compare with `03-ctrlj-wrong-project.png`);
   - (c) a collapsed project with a badge.

   Also note the fixture lane named `VibeSquad @vibe` sits beside `Desk`. It's a real feature lane in `src/demo.tsx`, not a bug, but it reads as a second desk in every shot. Rename it in the fixture (e.g. `Core`) or call it out in the shot captions.

## NICE

1. **Table order should match the tree.** The tree goes Desk, Bugs, then lanes, but the table puts Desk and Bugs last. In `boringLaneTableRows`, return `[deskRow, bugsRow, ...lanes]` so the table's top-to-bottom order matches the sidebar.
2. **Container dot should match the badge.** The collapsed VibeSquad lane and the project row show an **amber** dot next to a **red** `3` badge. When a container is collapsed, tint its dot with the same worst state (`--st-err` if any error), so the dot and badge don't disagree.
3. **Desk sub-label doesn't reflect who's there.** The Desk row always shows `Overlord · RiffBot`, even when neither agent exists (both child dots are hollow). Make `.boring-desk-sub` reflect real presence, or hide it when both are absent.
4. **`+ lane` reveal is narrower than the plan.** `.boring-lane-add` only shows on hover/focus or when the project row is `.on` (`src/boring.css:1121`). The plan says "expanded/hovered project row". In the chat shot the expanded VibeSquad row has no `+ lane`. Either add `.boring-project-line.open .boring-lane-add { opacity: 1 }` or update the plan text to "selected/hovered".
5. **Search appears twice.** `Search` now sits both in the sidebar header and top-right in the main header (from D3a). Consider dropping the main-header copy in Normal mode, or styling it as an icon-only `⌕`. This one comes from master; queue it if it's out of Unit 1 scope.

## Not judged here (Unit 2 scope)
`Needs you` still has 4-line cards with Dismiss on non-permission rows, `VibeSquad › VibeSquad` locations, and `Recent done (1)`. All of these are R2.4/R2.7, owned by `unit-desk-r2-needs-you`.
