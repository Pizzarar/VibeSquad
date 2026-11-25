# UX review R18b: B14a `b7f95634` (n7 perm-stack cap + n8 strip collapse) and B14b `7e87c62a` (Overview Living Signature)

Method: `npx vite build` of each branch, `dist` served statically, Snap Chromium driven over CDP. `?demo=1&riff=1&team=vibesquad` with `&agent=demo-aud` (pending permission), `&crowd=1`, `&idle=1`, `&agent=demo-impl-1` (no permission), `&agent=demo-agy-err` (error), `&agent=demo-rev` (needs-you pick), `&agent=demo-lead-pl&team=plugins` (finished). 1280x720 and 3840x2160 (DPR 1.2; note: this is a 3840 CSS px viewport, not a true 120% browser zoom, so the 4K cells show the layout at 3840 CSS px), dark and light. Three pending permissions simulated by cloning the card (the demo cast has one). Baseline for B14a = B14b build (`ee01b16a` + overview only, same perm code as R17). Shots in `artifacts/ux-r18/` (untracked), B14a's own in its worktree `artifacts/boring-b14a/`.

## B14a: n7 + n8. Verdict **PASS 0/0/1** (critical/major/minor)

| Check | Result | Evidence (rects, 1280x720) |
|---|---|---|
| n7: 3 perms no longer crush timeline / clip Allow-Deny | **fixed** | Baseline: timeline 0px, 3rd card Allow/Deny at y=691-723 (past column bottom 623, clipped). B14a: stack capped 92-384 (`clientH 292 / scrollH 564`, `max-height 55%`), timeline 239px. |
| Allow/Deny reachable with 3 perms | **yes** | Scrolled stack to bottom: all 6 buttons inside the stack box (card 2 at 109-141, card 3 at 297-329, `inside=true`). Card 1 Allow is visible without scrolling (193-225). Sidebar Allow/Deny also still present. |
| 1 perm | **better** | timeline 343px (baseline 221px); strip hidden, card 1 at top. `scrollH == clientH` so no scrollbar. |
| n8: strip collapsed only when a perm card exists | **yes** | `data-has-perm=true`, `display:none` for `demo-aud` (also with `&idle=1`, `&crowd=1`). `data-state` stays `needs-you`. |
| Strip kept for non-permission states | **yes** | error `demo-agy-err`: strip 198-304, "Review - Gemini · retry hit an error"; pick `demo-rev`: "needs your OK", visible; finished `demo-lead-pl`: strip visible; `demo-impl-1`: busy strip visible. Same in dark and light. |
| No h-scroll / clipping, light + dark | holds | `scrollWidth == innerWidth` in all cells; light shot readable, card colours distinct. |
| Psycho | not touched | CSS scoped under `html[data-vibe="boring"]`; `.boring-perm-stack` only rendered in `boringChat` branch. |

- **a1 (minor) · Cards 2-3 are hidden behind a scroll with little cue.** At 1280x720 with 3 perms the stack shows card 1 plus the top half of card 2 (`a-perm3-dark-1280x720.png`); the only cue is the cut-off card and a thin overlay scrollbar. There is no "2 more" count. Job hurt: noticing parallel permissions (the header Needs-you count and sidebar still list them). Fix: add a small "+2 more waiting" row at the stack bottom or `scrollbar-gutter`/visible thumb. Files: `src/boring.css` (`.boring-perm-stack`). Effort: XS.

## B14b: Overview Living Signature. Verdict **PASS 0/0/3**

| Check | Result | Evidence |
|---|---|---|
| Tone-stepped card, hairline tabs, `+ New lane` | good | Dark and light both calm; needs-you rows get amber/brown left rule + pill; idle rows quiet (`b-ov-busy-dark-1280x720.png`, `b-ov-crowd-light-1280x720.png`). |
| Mini-busts on Desk/Bugs/lane rows with state | good | All 11-12 `img` loaded (`naturalWidth>0`), 22px, state word next to each (`idle`/`running`), so the cue is not colour-only. |
| Contrast (computed, composited bg) | **>= 5.86:1 in all text classes** | Dark: tab 10.08, header "Lane" 5.86, lane name 18.7, stat 11.75, age 7.36, code 6.31, badge 12.62. Light: tab 9.2, header 5.9, name 16.3, stat 8.75, age 6.5, code 6.84, badge 6.1. |
| Fit | holds | 10 rows end at y=591 of 720; no h-scroll at either size; crowd (12 needs-you on UI Bois) wraps nothing. |
| Invariants | consistent | Row counts and "Needs you" numbers agree with the sidebar for the same cast; breadcrumb `VibeSquad > Overview`; topbar untouched. |

- **b1 (minor) · Empty-role cells read as broken images.** A lane with no Brainstorm/Lead draws an empty outlined square plus "—" (UI Bois, Plugins, Bugs lead, etc.), 5+ per screen. They look like failed image loads next to real busts. Job hurt: scanning who is on a lane. Fix: drop the box for "—" or use a dashed ghost at lower opacity. File: `src/boring.css` lane-table bust slot. Effort: XS.
- **b2 (minor) · Card capped near 910px leaves 2/3 of the window empty at 3840 wide** (`b-ov-idle-dark-3840x2160.png`, card 1350-2870 of 3840 in busy/crowd metrics; table does not use width). Likely the existing measure cap; at true 120% zoom it is about 1400px of 3200. Not a regression, polish only.
- **b3 (minor) · Bugs row has an empty Age cell** while every other row shows one; "—" would match the Workers column.

Carried unchanged, out of area: R17 m3, m5, n1, n2, n4.

## Owner decisions
- None required. Recommend merging both after a1/b1 are queued to @bug as XS polish.
