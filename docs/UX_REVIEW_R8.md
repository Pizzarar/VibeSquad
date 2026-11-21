# VibeSquad UX review, round 8: Normal mode, B8a Trinity sidebar

Date: 2026-11-21 · Build: `unit-bor-b8-trinity-sidebar` @ `2a0b2e05` (vite dev on `:5391`, from the unit worktree).
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). `?demo` with the real project registry (EFI, VibeSquad and 5 more), at 3200×1800 and 1920×1080, dark and light. The prefs were seeded with `app.vibe = boring` and `vs.vibePicked`. I didn't read `PLAN_BORING_MODE_B8.md` until after the first pass. The orange "Read-only" strip comes from the harness (the page has no local token), not the app.
Screenshots: `scratch/ux-r8/` (gitignored). The numbers below refer to those files.

**Verdict at `2a0b2e05`: FAIL 0/1/4.** The sidebar no longer counts the Desk's needs-you items or shows its errors anywhere (R8-1).
**Re-check at `fd6812ad`: PASS 0/0/4.** R8-1 and R8-3 are fixed. One new minor, R8-6, came in with the R8-1 fix. See "Re-check" at the end.

## Status vs round 7

| Item | Status | Evidence |
|---|---|---|
| R7-1 deep link shows Overview first | settled state OK; load timing not re-traced this round | `?demo&agent=demo-lead-efi` lands on "Escape From Idle › Main Game › Lead", with one selected row (`09`) |
| R7-2 1080 reason clamp | unchanged (minor) | `11`/`12`: "Lead at 150k+ tokens… approve the sav…" |
| Owner principle idea-446: Overlord/RiffBot always visible | **done** | Every expanded project shows a "Core" card with Lead · Overlord, Brainstorm · RiffBot and Bugs, with no toggle (`01`, `02`, `10`–`12`) |
| Owner principle idea-446: Trinity visually separate from lanes | **done** | Card has `--surface-2` fill, a 3px accent left rule and a "Lanes" divider. It reads well in dark (`rgb(34,29,47)` on `rgb(26,22,36)`) and light (`rgb(240,237,245)` on white) |

### Invariants

`node --test test/normal-invariants.test.mjs`: **12/12 pass, 0 skip** (108.6s).

| Invariant | Result (live) |
|---|---|
| Counts agree | ✗ when expanded: Overview says "Desk · Needs you · 4", but the expanded VibeSquad tree shows 0 (R8-1). ✓ all collapsed. ✓ title (5) = list 5 |
| Exactly one selected row | ✓ Overview, Overlord, Ctrl+J worker, Needs-you lead, deep link, empty EFI Overlord |
| Breadcrumb = selected row = open agent | ✓ project and lane. The worker crumb reads "Worker", not the name (pre-existing, R8-5) |
| Expanded projects share one shape | ✓ EFI and VibeSquad both show Core card → Lanes divider → lanes |
| No agent listed > twice | ✓ |
| WHY not truncated | ✓ 4K. 1080 as R7-2 |

## Findings

### R8-1 · major · The expanded sidebar no longer shows the Desk's needs-you count or its error
- **Job hurt:** 2 (monitor) and 3 (respond). In the demo, 4 of the 5 needs-you items and the only error are Desk workers.
- **Evidence:** `02`, `11`, `12`. With VibeSquad expanded, its project badge "4" is hidden (badges show only on collapsed rows, by design). Nothing in the Core card carries it: Overlord and RiffBot show no badge, the fold reads "12 running · 6 idle" with no needs-you or error count, and Bugs shows none. The Overview row for the same project says "Desk · Needs you · 4". The Review-Gemini error (red in Needs you) has no red mark in the card either.
- **Cause:** `2a0b2e05` deleted the old `deskBlock` row, which carried `badge(m.hubNeedsYou, m.deskErr)` and a needs-you/error glyph on its dot. `trinityCard` (`src/BoringAde.tsx:681-694`) has no replacement. `m.hubNeedsYou` and `m.deskErr` are still computed (`:226`, `:249`) but nothing in the expanded tree reads them. The plan (§1, line 14-17) only lists rows and styling, so this is a spec gap, not an implementation slip.
- **Fix:** show `badge(m.hubNeedsYou, m.deskErr)` on the Core card's header (right-aligned, like the lane badges). Or add "· 4 need you" in amber to the fold label. Then add an invariant: with a project expanded, the badges on its children add up to its collapsed badge.
- **Files:** `src/BoringAde.tsx`, `test/normal-invariants.test.mjs`. **Effort:** XS. **Lane:** @bor.

### R8-2 · minor · Sidebar says "Core", everything else says "Desk"
- **Job hurt:** 2 and 3 (finding where an item lives).
- **Evidence:** in the Needs-you location ("Desk · VibeSquad"), the breadcrumb ("VibeSquad › Desk › Overlord", `04`, `13`), the Overview's first row ("Desk", `02`) and the label on the Ctrl+J worker, the group is called "Desk". The sidebar card that holds the same agents is headed "CORE", and the word "Desk" no longer appears anywhere in the sidebar. (The spec calls it "Trinity".)
- **Fix:** pick one name and use it everywhere: `trinityCard` head `:687`, breadcrumb `:542`, Overview row `:338`, and the Needs-you location. See Owner decisions.
- **Effort:** XS.

### R8-3 · minor · Desk workers sit inside the card at Trinity-member level
- **Evidence:** `06` and `04`. The fold "▸ 12 running · 6 idle" sits between RiffBot and Bugs, and after Ctrl+J the selected worker "Audit - token scout" does too, at the same indent and weight as Overlord and RiffBot. That makes the worker look like a fourth Trinity member, or a child of RiffBot (it belongs to the Overlord's lane).
- **Fix:** either indent Desk worker rows one level under Lead · Overlord and render them at worker weight (not the card's 500/`--text-1`), or put the fold after Bugs with a "Desk workers" prefix.
- **Files:** `src/BoringAde.tsx:681-694`, `src/boring.css:1223-1226`. **Effort:** XS.

### R8-4 · minor · The card costs ~130px per expanded project at 1080
- **Evidence:** `11`/`12`. With two projects expanded, the Projects pane is 428px tall with 1313px of content. The VibeSquad card fills the visible bottom, and its lanes sit below the fold. Before B8a, the collapsed Desk was one row.
- **Fix:** none required, since this is the owner's choice (always visible). A cheaper option would be to drop the "CORE" eyebrow and fold Bugs into the card's last row. Watch for it if the 1080 job walk complains.

### R8-5 · minor · pre-existing, not B8a · The worker breadcrumb ends with "Worker", not the name
- **Evidence:** after Ctrl+J, the breadcrumb reads "VibeSquad › Desk › Worker", while the header reads "Audit - token scout" (`06`). R7 recorded the name here.
- **Cause:** `boringSelectionForAgent` returns no `label` for hub workers (`src/BoringAde.tsx:73`), so `agentLabel` falls back to "Worker" (`:162`).
- **Lane:** @desk/@bor queue, not part of this gate.

Also pre-existing and outside this unit: EFI's sidebar lane order puts the active lanes (Main Game, which needs you, and UI Lab) last, while the Overview lists them first (`01`).

## Spec note
The SPEC calls for a "sunset-tinted" Trinity card. The plan and the build use the neutral accent tokens (`--surface-2` and a purple left rule) instead. The separation works in both themes, so I don't rate it a finding. Update the SPEC wording, or ask @art-direction for a sunset tint later.

## Owner decisions
1. **What to call the Overlord + RiffBot + Bugs group: "Desk", "Core" or "Trinity"?** Recommendation: **"Desk"**. It's already the label in 4 places (Needs-you location, breadcrumb, Overview, `vs` copy), and only the card header would change. "Trinity" is an internal word.

## Re-check: `fd6812ad` (2026-11-21)

Live on vite dev (`:5391`) from this worktree, `?demo`, with EFI and VibeSquad both expanded, at 3200×1800 and 1920×1080, dark and light. `node --test test/normal-invariants.test.mjs`: **13/13 pass, 0 skip**, including the new 2b.
Screenshots: `scratch/ux-r8/r2-*`.

| Item | Status | Evidence |
|---|---|---|
| R8-1 Desk needs-you/error missing when expanded | **fixed** | In all 4 size/theme runs, the Core header shows a red `4` (`badge boring-badge err`). VibeSquad expanded: the badges add up to 4, matching the collapsed badge of 4 (`r2-*-two-expanded`, `r2-card-dark`). |
| R8-2 "Core" vs "Desk" | open (minor, owner decision) | The breadcrumb still reads "VibeSquad › Desk › …" |
| R8-3 Desk workers at Trinity-member level | **fixed** | Order is now Overlord → fold/workers (indented) → RiffBot → Bugs. After Ctrl+J, "Audit - token scout" sits indented under Lead · Overlord (`r2-card-dark-ctrlj`). One selected row; URL `agent=demo-aud`. |
| R8-4 card height at 1080 | open (minor) | unchanged |
| R8-5 worker breadcrumb "Worker" | open (minor, pre-existing) | "VibeSquad › Desk › Worker" after Ctrl+J |

### R8-6 · minor · new in `fd6812ad` · The Overlord's (or RiffBot's) own needs-you is counted twice in the card
- **Job hurt:** 2 (counts agree).
- **Evidence:** I ran the demo with Playwright's fake clock and moved it forward 66m, so the Overlord stalls. The VibeSquad Core header shows **13**, and the Lead · Overlord row shows its own **1** (`r2-card-dark-66m`). With one lane at 1, the expanded badges add up to **15**. Collapsed, the VibeSquad badge reads **14**. At t0 nothing double-counts (4 = 4), which is the only state 2b tests.
- **Cause:** the header shows `m.hubNeedsYou` (`src/BoringAde.tsx:687`). That's `pinNeeds(zones.hub)` (`:226`, `:196`), and the hub pin's members are the Overlord (lead) and RiffBot (brainstorm). `coreRow` also badges each of them with its own `needsYou` (`:676`). Before B8a this was harmless: the Desk badge showed only while its children were hidden.
- **Fix:** have the header count only what has no row of its own: `m.hubNeedsYou - m.core.overlord.needsYou - m.core.riffbot.needsYou` (Desk workers, plus folded desk pins). Or drop the member-row badges. Extend 2b to also run after `clock.fastForward('01:06:00')`, as 1b and 9 already do.
- **Files:** `src/BoringAde.tsx`, `test/normal-invariants.test.mjs`. **Effort:** XS. **Lane:** @bor.
- **Why minor:** nothing is hidden, and every item is still reachable from Needs you and the card. It's an overcount by one per stalled or waiting Desk member.
