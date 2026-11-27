# Storybook v2 V7 sign-off walkthrough (PLAN_STORYBOOK_V2 V7, @storybook)

**Verdict: SIGN-OFF PASS (0 blockers).** There is 1 major (a counter that does not move with marks) and 5 minors. V13 (AI pre-review, Flagged chip) is deferred to the Claude quota reset. It is the only open plan item and did not block this walk.

Known and not re-reported: idea-1169 (sibling contract OK shows no feedback) and idea-1170 (autoCommitError has no Retry). A parallel unit is fixing both.

## How it was run
- **Build:** `unit-sbv2-v7-signoff @ a6a5ba7f` (origin/master), built to `/tmp/sbsign/dist`.
- **Read-only server (port 4440):** Storybook adapter against real EFI, `origin/main @ d09ff294`. Used for every read check.
- **Read-write server (port 4441):** a throwaway EFI clone at `/tmp/sbsign/efi-sgn7`.
  - Its `origin` was repointed to a local bare repo, so no branch could reach real EFI.
  - The review worktree lived in `/tmp/sbsign/wts`, with `VIBESQUAD_HOME=/tmp/sbsign/vshome*`.
  - EFI main and the owner's review worktree were never written. Both servers are stopped.
- **Browser:** Playwright with `/usr/bin/chromium-browser --no-sandbox`, dark theme, at 1440x900 and 390x844 (touch).
- **Shots:** `/tmp/sbsign/shots/` (`w1440-*`, `p390-*`), not committed.
- **Console:** 0 page errors. The only console noise is 404s from the harness blocking the live `/api` proxy.

## Real numbers (EFI `d09ff294`)
| Thing | Value | Agrees across |
|---|---|---|
| Entities / text rows / Review rows | 4670 / 3328 / 3448 (3328 lines + 92 contract previews + 28 meta) | Home "What is in here", Review header |
| Review classes | Story 276, Flavor & quips 769, Toasts/system/UI 2311, Contracts 92, Too long 2 | chip counts equal "N of 3448 rows" when clicked |
| Problems badge | **7** (`#5` Broken 2, `#19` Inconsistent 5) | Home, tab badge, engine findings |
| Other checks | **74** (`#3` 19, `#7` 4, `#11` 5, `#14` 6, `#16` 13, `#17` 27) | sums to the engine finding counts |
| Coverage | **322** (`#15` 232, `#8` 90; plus 23 Dev TODOs) | Home, Problems tab, API (`#8` = 113 = 90 + 23) |
| Items | 249; No story (#15) **232**; Orphan (#14) 6; Unobtainable (#13) 0 | Items tab, Home Coverage, engine `#15` = 232 |
| Quests | 7 traders, 25 steps; play order 57 items plus 80 contracts under "unlock rule not in EFI data" | Quests tab |
| Cast / Glossary | 90 characters, 41 enemies, 74 screens; 13 term findings (#16) and 27 naming findings (#17) | Cast, Glossary, Other checks |
| Search | `scrap` 37, `Doc` 73, `Fence` 30, `railway yard` 7, `zzzqq` 0 (of 3448) | identical at 1440 and 390 |

## Owner session on the clone (real marks, two commits)
- **Where the marks were made.**
  - Review: story, flavor and contract rows.
  - Quests arcs: one OK, one Redo.
  - A Cast sheet (Fence): OK.
  - A World sheet (Sealed Vault enemy line): Redo.
  - An Item sheet (Scrap Metal; it surfaced a Builder encouragement line): Redo.
  - A phone session: OK, Redo, Edit, contract Note, Quests OK, Cast OK.
- **Commit 1:** `cfe2a575`, "4 OK, 5 redo, 1 edit", 10 rows, on `storybook/review-2026-11-27`.
- **Commit 2:** `4ee5f33b`, "3 OK, 2 redo, 1 edit", 5 more rows (phone). The summary reads 6 because the contract note touched an already-marked template row.
- **Counters.**
  - The bar and `My marks` agreed at every step, 4, 5, 6, 7, 10, 11, 12, 13, 15, at both sizes.
  - Home progress went `0/3328 OK` to `5/3328` to `9/3328 OK`.
  - The CSV owner_ok total is 9, so Home and the CSV agree.
- **`review_pack.py --check`:** `review pack is up to date (8 files)` after both commits. `[STORY-RELEASE] TOTAL todo=3081 draft=413 needs_rewrite=6 owner_ok=9 orphaned=8`.
  - The `orphaned=8` rows were already in `story_orphans.csv` at baseline, so they are not ours.
  - On plain `origin/main` the pack is stale (EFI's own state). The session's first commit is a separate `review_pack --write` baseline, so the mark commits stay small (20 lines).
- **`--apply` dry run:** `[STORY-APPLY] applied=8 skipped_not_ok=303`. That is the 8 OK/Edit data rows, with 0 GDScript worklist rows.
- **Committed CSV diff (`status` / `owner_note` / `owner_rewrite`, row by row, HEAD~1 to HEAD):**
  - Commit 1 changed 10 rows:

    | Row | Change |
    |---|---|
    | Builder story steps 0 and 2 | `NEEDS-REWRITE` + `owner_note` |
    | Builder titles 0 and 1, story 1 | `OWNER-OK` |
    | Builder step 1 title (Edit) | `OWNER-OK` + `owner_rewrite` |
    | Fence step 0 | `OWNER-OK` |
    | Enemy `archive_trooper` name (World sheet) | `NEEDS-REWRITE` + `owner_note` |
    | Builder `encouragement` title (Item sheet) | `NEEDS-REWRITE` + `owner_note` |
    | `ContractSystem.gd:720` template | `NEEDS-REWRITE` + `owner_note` = `contract:d_builder_scrap_metal: … \| contract:d_builder_iron: …` |
    | `ContractSystem.gd:727` template | `OWNER-OK` |

  - Commit 2 changed 6 rows: 3 `OWNER-OK`, 1 `NEEDS-REWRITE` + note, 1 Edit (`OWNER-OK` + `owner_rewrite`), and the contract note appended to `:720`'s `owner_note`.
  - **Invariant holds.** Contract notes only ever appear in `owner_note` as `contract:<id>: …` on the template row. 0 rows have contract text in `owner_rewrite`. The only non-empty `owner_rewrite` values are the two real Edits.
  - **No contract stray-edit.** A contract has a Note button, not Edit. A contract Note leaves the template row at Redo, and the sibling OK did not clear it.

## Walk, by intent
- **First visit.**
  - The guide auto-opens at both sizes: a 680x860 modal on desktop, full-screen on phone.
  - There are 8 steps and 8 working "Show me" buttons: Home; Quests/Story arcs; Review; Review with End session flashing (`sb-flash`); Review with the Contracts filter; Cast; Glossary; Home.
  - Got it, Esc, the `?` button and Home's "How to use" all work. It stays closed after a reload.
- **Home.**
  - It leads with the needs-attention tiles, which are real: Problems 7, Story issues 5, Coverage 322, Text to review 3327.
  - The Cohesion footnote is now split: `+47 more: 2 Too long, 13 term drift, 27 naming style, 5 lore vs roster`.
  - Progress bars update live after marks. Traders went `4 OK … 3 needs rewrite`, UI & system `1 OK`, Maps `1 needs rewrite`, and then Traders `8 OK`.
- **Quests.** Arcs per trader show 4/3/3/4/4/3/4 steps. Each step shows title and story inline with OK/Redo/Edit, `Review row →`, and map/item chips. The play-order list and the Quest web both render.
- **Review.**
  - All 7 chips (My marks, Contracts, Story, Flavor, Toasts, Unreviewed, Too long) filter to the stated counts. Search works, and the empty search shows 0.
  - Phone: `Filters ▸` collapses the chips and `My marks N` stays outside it. The first OK button sits at y=665 of 844. The needs-you badge is an icon (`5`).
- **Places and people links.** A place chip in Quests opens the World sheet for that map. `Review row →` and `→ <entity>` chips jump to the row or sheet. See friction 2 for the way back.
- **Coherence.** Problems 7 are all real: 2 impossible-raid-length items and 5 lore-vs-roster items. Other checks 74, with `#11`, `#7`, `#3`, `#14`, `#16` and `#17` moved there. The Glossary shows 5 canonical terms (runner, Scav, …) with their watched variants and findings.
- **Items placed and with story.** Items 249, No story 232, Orphan 6, Unobtainable 0. The No story count matches the engine `#15` exactly. An item sheet shows sources, uses and a description-missing note.
- **Contracts.** All 92 render as the player sees them (`Deliver 68–135 × Scrap Metal for Builder`), grouped `Contracts · <trader>`. The World sheet lists its 4 vault contracts by rendered title.

## V1–V12 block grades
| Block | Intent | Grade | Evidence |
|---|---|---|---|
| V1 Speaker + link identity | Every line has a real speaker; Saint is not Doc | **met** | Cast lists Doc (trader, 16) and Saint (squad, 6) separately; 74 screen/system speakers; Review rows carry a speaker and `→` entity chips |
| V2 Overview + Findings split | Opens on what needs me; badge = real problems | **met** | Home buckets; Problems badge 7 (not 3661) |
| V3 Text tab + search | Every line, grouped, one search | **met** | 3448 rows, 7 chips, search 37/73/30/7/0, identical at 390 |
| V4 Entity sheets + item checks | A sheet per map, person, enemy and item; #13–#15 | **met** | World/Cast/Items sheets; `#15` 232, `#14` 6, `#13` 0; item node chips still dead (parked, minor) |
| V5 Arc + play order | Quest story per trader plus unlock order | **met** | 7 traders / 25 steps inline; play order 57 items; 80 contracts honestly marked "unlock rule not in EFI data" |
| V6 Owner marks + edits | OK/Redo/Edit, no EFI main, `--check` clean | **met** | Two commits on `storybook/review-2026-11-27`; `--check` up to date; `--apply` dry run `applied=8` |
| V7 Re-walkthrough + guide | A real walk plus an in-app "how to use" | **met** | This document; guide 8 steps with 8 working "Show me" |
| V8 New since last review | What changed since last session | **partly** | "Mark seen" works and shows `0 new / 0 changed / 0 gone` since the saved sha. No second EFI ref was available to prove a real diff. Home also still says "First session" after two End-session commits (friction 3) |
| V9 Rendered previews | Contract templates as the player sees them | **met** | 92 rendered contract rows; World sheet shows rendered titles |
| V10 Glossary + naming style | Terms and name style | **partly** | Seeded from VOICE_BIBLE, read-only (no `GLOSSARY.md` in EFI), so there is no edit path. Findings #16 13 and #17 27 render and link back to rows |
| V11 Fits on screen | Length check | **met** | `Too long` chip = `#18` = 2 |
| V12 Placeholder → final progress | One bar per area | **met** | Home and sheet bars agree after marks (Traders `8 OK`; Cast Fence `1 OK · 12 draft · 5 todo`); CSV owner_ok = 9 = Home 9/3328 |
| V13 AI pre-review (Flagged chip) | Likely-bad lines lead | **deferred** | Waits for the Claude quota reset; not scoped into this walk |

## Friction table
| # | Sev | Friction | Shot | One-line fix |
|---|---|---|---|---|
| 1 | **major** | `Unreviewed 3327` (Review chip) and Home `Text to review 3327` do not move when you mark. They stay 3327 with 9 OK / 15 marked, while the progress bar says `9/3328 OK`. They also say 3327 against 3328 text rows, off by one with no explanation. The bar and the chips disagree on the same screen. | `/tmp/sbsign/shots/w1440-06j-after-commit.png`, `p390-08h-home.png`, `w1440-10a-home-after-sessions.png` | Compute Unreviewed and Text to review from the live marks overlay, and reconcile 3327 vs 3328 (or label the 1 excluded row) |
| 2 | minor | Sheet navigation has no way back. A place or item chip from a Quest line opens the World/Items sheet. Clicking the Quests tab resets the arc to the top. Browser Back leaves Storybook entirely (the `?sb=` push is the only history entry). | `/tmp/sbsign/shots/w1440-07d-place-sheet.png` | Push sheet and tab navigation into history, or add a `← Quests` breadcrumb that restores scroll |
| 3 | minor | Home keeps saying "First session: everything is new … Nothing is marked seen yet" after two committed review sessions. It only changes after a manual "Mark seen". | `/tmp/sbsign/shots/w1440-10a-home-after-sessions.png` | Offer or auto-run Mark seen right after End session |
| 4 | minor | Home audit tiles (Integrity 12, Cohesion 24, Sign-off 3327) are not reconciled with Problems 7 or Other checks 74 on screen, and Sign-off and Text to review repeat 3327. A new reader cannot tell which number to act on. | `/tmp/sbsign/shots/w1440-05a-home.png` | Fold the audit tiles into the needs-attention row, or add a one-line legend per tile |
| 5 | minor | The first mark of a session shows no feedback for ≥1.3 s. The bar still read "no session yet" right after the first OK, because the EFI review worktree is being created. | `/tmp/sbsign/shots/w1440-06a-review-marked.png` | Show a "starting session…" state on the bar and keep the button busy |
| 6 | minor | Item node chips are dead (carried since W3, parked by the plan). | `/tmp/sbsign/shots/w1440-06h-item.png` | Link the chip to its map or drop the chip styling (parked item) |

No blockers. Friction 1 is the only major. It is a display-count fix and does not block marking, committing, `review_pack` or the EFI branch round trip.

## What's left
- **V13 AI pre-review (Flagged chip, `owner_note` only, never OK).** This is the only open plan block. It waits for the Claude quota reset.
- **Friction 1** (live Unreviewed/Text to review). It is the only item I would fix before calling the lane fully done.
- **Minors 2–6.** idea-1169 and idea-1170 are already in flight in a parallel unit.
- **A real changed-ref check for V8.** It needs a second EFI sha and was not possible on this static clone.
