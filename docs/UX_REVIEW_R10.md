# VibeSquad UX review, round 10: B10, expanded project card and the Trinity header renamed "Desk"

Date: 2026-11-22 · Build: `unit-bor-b10-project-card` @ `8efd5562` (diff `3961eb83..8efd5562`), vite dev on `:5410`, run from the unit worktree.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). `?demo` at 3200×1800 (4K at 120%) and 1920×1080, in light and dark.
Screenshots: `artifacts/boring-b10-4k/` (untracked, in the unit worktree). The two-digit numbers below refer to those files.

**Verdict at `8efd5562`: PASS 0/0/2** (critical/major/minor). Two minor findings are new in B10. No critical or major finding is open for the sidebar.

## Status vs round 9

| Item | Status | Evidence |
|---|---|---|
| R8-2 "Core" vs "Desk" | **fixed** | The Trinity header reads "Desk" in all 4 runs (`.boring-trinity-head` = "Desk" / "Desk4"). `document.body.innerText` has 0 matches for `\bCore\b`. The sidebar header, the breadcrumb ("VibeSquad › Desk › Worker"), the Needs-you sub-labels ("Desk · VibeSquad") and the Overview table row ("Desk") now all agree (`02`, `05`, `07`) |
| R9-1 Psycho "Normal mode" button hidden on landing | open (minor, out of scope) | not re-checked |
| R9-2 silent fun → Normal migration | open (minor, owner decision) | not re-checked |
| R9-3 bare 13px Legacy checkbox | open (minor, out of scope) | not re-checked |
| R8-5 worker crumb reads "Worker" | still open (minor) | `07`: "VibeSquad›Desk›Worker" |
| R7-2 1080 reason clamp | unchanged (minor) | `05`: "…then approve the sav…" |

### Invariants

`node --test test/normal-invariants.test.mjs test/boring-mode.test.mjs`: **143/143 pass, 0 fail, 0 skip** (103.8s).

## B10 checks

| Check | Result | Evidence |
|---|---|---|
| Expanded project is one container card (header, Desk card and Lanes inside) | ✓ `.boring-project-block.open`: bg `--surface-1`, `1px solid` border, 14px radius, 8px padding, at both sizes and in both themes | `02`, `03`, `04` |
| Collapsed projects stay flat rows | ✓ bg transparent, border 0, padding 0, height 32px | `02`, `08` |
| Expanded vs collapsed is easy to tell apart | ✓ in light (border `#dcd6e6` on white). In dark the border is `#332c47` on `#1a1624`, about 1.3:1. That's faint but it still reads at 4K, helped by the Desk card's accent rule and the Lanes divider | `03`, `04` |
| Trinity (`--surface-2`) nests inside the project card (`--surface-1`) | ✓ The Desk card sits at x=37 inside a block at x=12 and is tinted one step darker or lighter than the card in both themes (light `#f0edf5` on `#fff`, dark `#221d2f` on `#1a1624`) | `03`, `04` |
| inv5: expanded projects share one shape | ✓ EFI and VibeSquad expanded together have the same chevron x (21), header x (37), Desk card x/width (37/321) and card styling | `03`, `04` |
| Two expanded cards stay separate | ✓ They have their own borders with about 6px between them | `03` |
| Exactly one selected row, crumb = row = open agent | ✓ After opening the "Audit - token scout" worker, the single `.on` row and the crumb both say VibeSquad › Desk. Collapsing VibeSquad moves `.on` to the project row (idea-523). A deep-link reload with `?agent=demo-aud` reopens VibeSquad with that one row selected | `07`, `08`, `09` |
| Counts agree | ✓ Needs-you 5 = VibeSquad Desk badge 4 + EFI Main Game 1. The collapsed VibeSquad row shows 4 | `03`, `08` |
| No agent listed more than twice | ✓ Each worker shows once in Needs-you and once in the Desk card | `03` |
| Console page errors | none (only the React DevTools info line) | none |

## Findings

### R10-1 · minor · The project chevron and name jump 9px when a project expands or collapses
- **Job hurt:** monitoring parallel work (job 2), which means flipping projects open and shut.
- **Evidence:** expanded projects have the chevron at x=21 and the name text at x=58. Collapsed projects have the chevron at x=12 and the name at x=49 (both measured at 4K and 1080). The card's `padding: 8px` plus the 1px border push the header in. So the 16px chevron button moves out from under the pointer after one click, and a second click at the same spot lands 1px outside the button. You can also see project names line up differently in `02` and `03`: the expanded EFI/VibeSquad names start at a different x from rosserlogic.tech and the rows below.
- **Cause:** `src/boring.css:964`. Padding on `.open` only, with no matching offset.
- **Fix:** keep the header where it is by pulling the card out by the same amount: `.boring-project-block.open { margin-inline: -9px; }`. The sidebar has 12px of side padding, so this fits. Alternatively, put the same inset on collapsed rows with a transparent 1px border and 8px padding, so both states share one box.
- **Files:** `src/boring.css`. **Effort:** XS. **Lane:** @bor.

### R10-2 · minor · At 1080 the card's inset truncates Desk worker names, with no tooltip
- **Job hurt:** spotting which worker is which in the Desk (jobs 2 and 3).
- **Evidence:** `06`. At 1920×1080 the sidebar is 307px wide and `.boring-row-label` on Desk workers gets 115px. "Review - Sonnet · drawer" (131px) now shows as "Review - Sonnet · d…". Before B10 the label had about 18px more room, so this one would have fit. "Mechanical - rename sweep" (148px) was already cut off. Neither truncated label has a `title` or `aria-label` on itself or any ancestor. The *reason* text is still whole in Needs-you, so this only loses the identity suffix, not any WHY.
- **Fix:** add `title={label}` on the row label in `workerList` and the core and lane rows (cheap, and it fixes every truncation). If R10-1's negative margin is used, that also gives back 18px.
- **Files:** `src/BoringAde.tsx` (`workerList` row label), `src/boring.css`. **Effort:** XS. **Lane:** @bor.

### Noted, not B10
- On a collapsed project row, the hover ⋯ button covers the needs-you badge (`08`: the VibeSquad "4" is half hidden under "…" while hovered). This came with idea-528 ("project ⋯ overlays the row edge") and only shows on hover. Queue it to @desk if the owner finds it bothers them.
- Opening a VibeSquad worker collapsed the manually expanded EFI card (`opens: 0` after collapsing VibeSquad). That's existing accordion behaviour and B10 didn't change it.

## Owner decisions

None. R8-2 was closed by Aub ("Desk"), and this round confirms the change shipped everywhere.

## Notes
- The dark-theme card border is low contrast (about 1.3:1), but the card is a decorative grouping, not a control, and it still reads at 4K. If the owner wants it crisper, use `--border-strong` (or the equivalent token) on `.open` in dark only. That's a polish call, not a finding.
