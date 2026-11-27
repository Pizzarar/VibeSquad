# Storybook dogfood W4: wave 4 (guide, My-marks fix, Problems 7, phone Review, live sheets) on real EFI data

I acted as the owner on `unit-sbv2-dogfood-w4 @ 6689129a` (origin `f914e081` + the W4 merges), built into `/tmp/sbdog4/dist`. The Storybook API ran from that tree on two private ports (`/tmp/sbdog4/harness/srv.mjs`, both stopped now):
- Port `4430`: read-only against real EFI, `VIBESQUAD_HOME=/tmp/sbdog4/vshome`. Used for the guide, W3 re-checks and the sheets.
- Port `4431`: read-write against a throwaway EFI clone at `/tmp/sbdog4/efi`, `origin/main` pinned to `fc7a240c` (same ref as W3). `VIBESQUAD_WORKTREES_DIR=/tmp/sbdog4/wts` kept its review worktree away from the owner's.
- Views: `1440x900` and `390x844` (phone, touch), dark. Playwright with `chromium-browser --no-sandbox`. Screenshots in `/tmp/sbdog4/shots/` (`w1440-*`, `p390-*`, not committed).
- Real EFI main and the owner's review worktree were not written by this run. The proxy to the live VS server was blocked (404).

### Numbers (`origin/main @ fc7a240c`)
- Entities 4670; text rows 3328; Review rows 3448 (3328 lines + 92 contract previews + 28 meta).
- **Problems badge 7** (was 16): `#5` Broken ×2, `#19` Inconsistent ×5. Other checks **74** (was 65; the 9 moved there are the #11 and #7 items). Coverage 322 (`#15` 232 + `#8` 90). Too long 2. Dev TODOs 23.
- **Items No story (#15) = 232**, matching the engine (was 240).
- Guide: 8 steps, 8 working "Show me" buttons.
- **Owner session (clone, 1440):** 6 Builder-story marks (3 OK, 2 Redo+note, 1 Edit+rewrite) plus 2 contract marks (1 Redo+note, 1 OK, 1 Edit; see friction 6). Session bar read `8 marked · 8 unsaved rows`, `My marks 8`. Commit `5876c2ac` on `storybook/review-2026-11-27`: "4 OK, 2 redo, 2 edit". `review_pack.py --check`: `review pack is up to date (8 files)`. `[STORY-RELEASE] TOTAL ... owner_ok=6`.
- **Progress after marks:** Home `0/3328 OK` → `6/3328 OK`. Traders `4 OK · 82 draft · 2 needs rewrite · 31 todo`. UI & system `2 OK`. The Cast Builder sheet bar showed `4 OK · 8 draft · 2 needs rewrite · 5 todo` (sums to 19), so sheet, Home and Review agree. The Problems badge stayed 7.

**Verdict: PASS against the owner's intent.** The owner can open the guide on first visit and see where each step lives. They can mark quests, quips, contracts and UI lines from Review, from a trader's Quests arc or from a Cast sheet, and every counter moves together. They can commit to an EFI review branch that passes `review_pack --check`. Every W4 target (the W3 friction fixes) holds on real data. What remains is polish and noise, plus the AI pre-review the owner still needs to clear 3328 rows. There are no blockers.

---

## 1. W3 frictions re-check

| W3 # | W3 friction | W4 result | Evidence |
|---|---|---|---|
| 1 | One contract note inflated `My marks` 5 → 40 | **FIXED.** A contract note moved `My marks` 6 → 7 (+1) | `w1440-03c-contract-noted.png`, session log |
| 2 | Problems 16 incl. 9 low-signal | **FIXED.** Badge 7 (Broken 2, Inconsistent 5), all real. Other checks 74 | `w1440-02b-problems.png`, `w1440-02c-other-checks.png` |
| 3 | Cast/World sheets showed raw chrome and stale statuses | **FIXED.** Sheet lines show OK / Redo / Edit and live marks, plus a `Review row →` link. No `STORY-TODO`, `csv` or `inferred` text in the World or Cast sheet text | `w1440-03e-cast-builder.png`, `w1440-04a-world-vault.png` |
| 4 | Home Cohesion footnote `+47 more are Too long` | **NOT FIXED** (planned for V7 polish). Home still says `+47 more are Too long notes`; only 2 are `#18` | `w1440-02a-home.png` |
| 5 | Phone Review first row below y=820 | **FIXED.** Compact `0 marked · committed` bar plus a `Filters ▸` toggle. First `OK` button at y=717 of 844 | `p390-02d-review-first.png` |
| 6 | `Contracts` chip ignores filter; Items 240 vs 232; raw contract ids | **Partly.** Items 232 fixed; World sheet shows rendered titles (`Eliminate 8–16 × Archive Trooper for Doc`). Contracts chip still shows 92 under an active filter | `w1440-04a-world-vault.png` |
| 7 | `OK (draft)` counted as `edit` in commit summary | **FIXED.** Commit read `4 OK, 2 redo, 2 edit`; Builder bar `4 OK` includes the two OK (draft) rows | `w1440-03g-after-commit.png` |
| 8 | Item node chips are dead | **NOT FIXED** (wasn't in W4). `node: Debris Pile` chips still do nothing | `w1440-04b-item-sheet.png` |

## 2. The guide (first visit)

| Check | Result |
|---|---|
| Auto-opens once on first visit | Yes, both sizes (`w1440-01a-first-visit.png`, `p390-01a-first-visit.png`) |
| Desktop | 680×860 modal, 8 steps, `Show me` on each, `Got it`. Readable |
| Phone | Full-screen 390×844, header and `Got it` pinned, steps scroll. Readable (`p390-01a-first-visit.png`) |
| Show me 1–8 | All work and close the guide. 1 → Home; 2 → Quests / Story arcs; 3 → Review; 4 → Review; 5 → Review with Contracts filter; 6 → Cast; 7 → Glossary; 8 → Home (`w1440-01b-guide-step1..8.png`) |
| Dismiss (`Got it`) and reload | Stays closed |
| Reopen from Home (`How to use`), header `?`, Esc closes | All work |
| Console errors | 0 (except the intentionally blocked proxy 404s) |

## 3. Realistic owner session (clone, EFI `fc7a240c`)
1. Home before: `0/3328 OK`. Review → Story → Builder: OK, OK, OK, Redo+note ×2, Edit+rewrite. The bar went `2 → 6 marked`; `My marks` matched the bar.
2. Contracts filter: Redo+note on one contract, OK on one, Edit on one. `My marks` went 6 → 7 → 8, never jumping.
3. `My marks` filter showed 8 rows with the typed notes and rewrites. Cast → Builder showed the same marks live (`4 OK · 8 draft · 2 needs rewrite · 5 todo`) with the voice card.
4. Home showed `6/3328 OK` and Traders and UI bars updated before commit. Problems stayed 7.
5. `End session (commit)`: `storybook review 2026-11-27: 4 OK, 2 redo, 2 edit (5876c2ac)`. The bar read `8 marked · all committed`. `review_pack.py --check`: up to date (8 files).
6. Phone: marking works at 390 (OK, Redo, Edit with the same form, bar `8 marked · 3 unsaved`). I did not run a second End session from the phone.

## 4. Review of content vs the owner's intent
- **Quests/quips:** the Builder arc reads in order, every line has its OK/Redo/Edit controls inline, and `OK all (12)` / `Redo all…` work per arc. Only 276 story rows and 861 quips exist as drafts, mostly `DRAFT` rows; there is no AI help yet to say which are weak. This is the biggest time cost left.
- **Lines linked to places and people:** the Cast sheet lists links (sells, rivals, 19 lines), the World sheet lists contracts and enemies, and `Review row →` jumps to the row. Good.
- **Coherence:** the 7 real Problems are credible (2 raid-length impossibilities, 5 lore vs roster). The Other checks list now holds the VOICE_BIBLE quote drift.
- **Items placed with story:** 232 of 249 items have no story. The Items sheet shows Sources (14) and Uses (50) for Scrap Metal but still `No description in items.json`.

## 5. New frictions

| # | Sev | Friction | Shot | One-line fix |
|---|---|---|---|---|
| 1 | minor | Home Cohesion footnote still says `+47 more are Too long notes` (2 are #18) | `w1440-02a-home.png` | Split the footnote as W3 #4 proposed (planned V7 polish) |
| 2 | minor | Contracts chip stays at 92 under an active search/filter | `w1440-03c-contract-noted.png` | Count over the active filter (planned V7) |
| 3 | minor | Guide `Show me` closes the guide, with no highlight on the target. Step 4 ("End your session") only lands on Review top; step 8 just returns Home | `w1440-01b-guide-step4.png` | Flash the End session button on step 4; add a floating "Back to guide" |
| 4 | minor | Voice card on sheets leaks the raw regex: `Never says: haggle, re:\bhaggl\w*` | `w1440-03e-cast-builder.png` | Strip the `re:` entries or show the plain word |
| 5 | minor | Phone: the `5 need you` button takes a full row and the 2-row tab bar is ~160 px, so the first row starts at ~600 px even after the compaction. The Contracts chip and `My marks` are hidden behind Filters | `p390-02d-review-first.png` | Shrink `need you` to an icon badge on ≤600px; show `My marks N` outside the Filters toggle |
| 6 | minor | Contract rows are listed under a `Flavor & quips` heading; session summary counted my contract note and Edit differently from what I clicked (`2 redo, 2 edit` vs my 3 redo, 1 edit; I cannot tell if the contract note is stored as `edit`). Needs a check | `w1440-03g-after-commit.png` | Label contracts `Contracts` and confirm how a contract note is summarized |
| 7 | minor | Item node chips remain dead (carried from W3) | `w1440-04b-item-sheet.png` | Link to the map or drop the chip styling |
| 8 | minor | Dogfood setup trap (not a Storybook bug): the review worktree path is derived from the repo folder name, so a clone named like an existing folder under `~/.vibesquad/worktrees/` got a 409 on the first mark. The refusal was shown correctly inline (`review worktree folder already exists but is not on ...`), but the OK/Redo/Edit buttons stayed live and the first click looked like a no-op | n/a | Disable the mark buttons while the session bar shows a session error |

No blockers, no majors.

## 6. Recommendation for the next wave
1. **V13 AI pre-review (owner_note suggestions on the 276 story rows + 92 contracts, never OK) is now the best value.** Marking, counters, commit and `review_pack` all work. The owner's remaining cost is deciding which of 3328 lines to look at first. Add a `Flagged` chip that leads Review and Home, with the suggestions shown as editable notes. Wait for the Claude quota reset as already planned.
2. **V7 sign-off + polish as one small unit:** Cohesion footnote (#1), Contracts chip under filter (#2), contract heading and summary (#6), voice-card regex strip (#4). All were already on the V7 list or are one-liners.
3. **Add:** phone chrome (friction 5) and the guide's End-session highlight (friction 3).
4. **Drop or park:** item node chips (#7) until the Items story work starts, and any further guide steps. The 8 steps are enough.
5. **Disable the mark buttons while the session bar shows an error** (friction 8). Cheap to fix.
