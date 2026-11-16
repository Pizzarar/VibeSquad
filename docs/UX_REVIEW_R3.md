# VibeSquad UX review, round 3: Normal mode

Date: 2026-11-16 · Build: `master` @ `f566190` (after PLAN_DESK_R2_SIDEBAR units 1–3).
Method: as in rounds 1–2 (`vite ?demo`, 3200×1800 CSS px = 4K at 120%, dark).
Evidence: `docs/shots/ux-review-r3/`. Wireframe: canvas board "R3 · Desk worker open" (link in `docs/UX_REVIEW.md` § Wireframes).

## Round-2 findings: status

| R2 | Status | Note |
|---|---|---|
| R2-1 one tree, two shapes | **fixed** | Every expanded project now has the same shape (`03-sidebar-states.png`, first column). |
| R2-2 Ctrl+J / breadcrumb | **fixed** | Ctrl+J shows "VibeSquad › Desk › Audit · token scout" and reveals the row (`02`). |
| R2-3 two selected rows | **fixed** | Exactly one row is selected in every state checked. |
| R2-4 Needs you takes over | **fixed** | 2-line rows, capped at 5, then "+ N more". |
| R2-5 count ≠ list | **regressed in a new way** | Finished items have left the list, but see R3-2. |
| R2-6 Dismiss everywhere | fixed | Only permissions get buttons; ⋯ on hover. |
| R2-7 "VibeSquad › VibeSquad" | fixed | Now reads "VibeSquad › Desk". |
| R2-8 zig-zag dots | fixed | 16px chevron column on every row. |
| R2-9 Bugs under Desk | fixed | Bugs is a lane row. |
| R2-10 raw titles | **half** | "★ MAIN GAME ord75" is now "Mai75". See R3-4. |
| Overview Desk row, header strip | fixed | The Desk row shows real states and counts. The strip no longer repeats the context bar. |

The sidebar is now structurally right. What's left is mostly **too much in it**.

## Round-3 findings

| # | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| R3-1 | major | **Expanding the Desk dumps every worker into the tree.** Ctrl+J into a Desk worker auto-expands Desk, and the tree lists 15 live workers + "6 idle", about 550px tall. Alerting workers get tinted 2-line rows that repeat their reason. The same workers now appear **three times** on screen: Needs you, the tree, and the right panel's Workers tab. | `02-ctrlj-desk-expanded.png`, `03-sidebar-states.png` (columns 3–5) | Under Desk or a lane, the tree shows only: Lead, Brainstorm, the agent on screen, and agents that need you. Each is **one line with no reason**, because the reason is already in Needs you. Everything else folds into one row, "▸ 10 running · 6 idle", which opens the Workers tab on the right. The tree is for finding your way; the right panel is the roster. |
| R3-2 | major | **"Stalled" floods Needs you.** Stalled = running with no update for **90s** (`BORING_STALL_SECONDS`, `src/boringHeaderStrip.ts:5`, used by `stalledReason` in `src/attentionItems.ts`). In the demo, 9 of the 13 Needs-you items are "Stalled: no update for 2–6m", mostly agents that are just working. The project badges don't count stalled items (VibeSquad Desk shows 3, Main Game 1), so **13 vs 4** disagree again. *Caveat:* demo timestamps are frozen, which exaggerates this, but any real 3-minute test run or build trips it too. | `04-needs-you-expanded-sidebar.png` | Don't treat "quiet" as "needs you". Raise the threshold to ~10 min *and* skip agents with a tool call in flight (the header strip already knows the running-tool duration). Show stalled agents with the amber-ring glyph in the tree and Workers tab, but not in Needs you, unless they pass the higher threshold. The Needs-you count must equal the sum of what the badges count. |
| R3-3 | minor | **The reason gets squeezed by the location.** Line 2 puts the reason on the left and "Project › Lane" on the right, so reasons truncate ("approve the save-forma…", the Gemini error). | `03`, top rows | Move the location to line 1 after the name (muted), next to the age, and give the reason all of line 2. |
| R3-4 | minor | **"Mai75"**: the display formatter turns "★ MAIN GAME ord75" into lane code + ord, which reads like a typo. | `03`, row 3 | For Needs you and tabs, render a lead as "<Lane> · Lead 75" (e.g. "Main Game · Lead 75"). Keep the code-style title only where space is truly tight. |
| R3-5 | minor | **The sidebar header shows the current project name** ("Main Game Project", then "VibeSquad") in the brand slot above Search. It looks like the app's title and repeats the breadcrumb. | `03`, all columns | Put the fixed app mark/name here, or nothing. |
| R3-6 | minor | **The footer floats.** Usage / Settings / Switch to Psycho sit directly under the tree, so they jump up and down as projects expand and collapse (y ≈ 1040 → 905 → 1440 in `03`). | `03` | Pin the footer to the bottom of the column (`margin-top: auto`), so the tree scrolls above it. |
| R3-7 | minor | **"+ 8 more" and "Done recently (4)"** use different count styles (plus prefix vs parentheses), and "Done recently" is listed even when Needs you is expanded. | `04` | Use one pattern: "8 more" / "Done recently · 4". |

## Plan

| # | Change | Files | Effort |
|---|---|---|---|
| R3.1 | Tree under Desk/lane: Lead, Brainstorm, on-screen agent, alerting agents (one line, no reason); fold the rest into "▸ N running · M idle", which opens the Workers tab | `src/BoringAde.tsx` (Desk block ~647, lane worker rows ~611), `src/BoringContextPanel.tsx` (open on Workers), `src/boring.css` | S–M |
| R3.2 | Stall rule: ~10 min + no tool in flight; stalled out of the Needs-you count/list below that; count = sum of badges | `src/boringHeaderStrip.ts`, `src/attentionItems.ts`, `src/BoringInbox.tsx`, tests | S |
| R3.3 | Needs-you row layout: location on line 1, full-width reason on line 2 | `src/BoringInbox.tsx`, `src/boring.css` | XS |
| R3.4 | Lead display name "<Lane> · Lead N" in Needs you and tabs | `src/identity.ts` (`formatDisplayTitle` option), `src/BoringInbox.tsx` | XS |
| R3.5 | Fixed app mark in the sidebar header | `src/BoringAde.tsx` | XS |
| R3.6 | Pin the footer | `src/boring.css` | XS |
| R3.7 | Count style consistency | `src/BoringInbox.tsx` | XS |

Start with R3.1 and R3.2. Together they remove most of what still feels busy: the triple-listed workers and an alert list that's mostly agents doing their job.
