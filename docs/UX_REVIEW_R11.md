# VibeSquad UX review, round 11: B11b, sidebar project folders, Active/Asleep, awake-only badges

Date: 2026-11-22 · Build: `unit-bor-b11b-folders-ui` @ `fbdf07db` (diff `12689ebf..fbdf07db`), vite dev on `:5411`, run from the unit worktree.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). `?demo` at 3200×1800 (4K at 120%) and 1920×1080, in light and dark.
Screenshots: `artifacts/boring-b11-4k/` (untracked, in the unit worktree). The two-digit numbers below refer to those files.

**Fixture note:** the `?demo` cast ships an empty `Backlog` folder, and in demo mode a folder change fails with `403` and a raw `alert()` (see R11-4). To exercise asleep projects, I stubbed `GET/PATCH /api/teams` with a Playwright route that put VibeSquad (4 needs-you items) into an asleep `Backlog`. The UI code under test was unchanged.

**R3 verdict at `9c09d8e2`: PASS 0/0/3** (critical/major/minor). Both R2 majors are fixed: the dark muted folder badge measures 7.81:1, and light `.err` badges are red again. Three minors stay open: R11-4, the R11-5 name alignment, and the new R11-7. See "Round 3 re-review" below.

**R2 verdict at `88d6c43e`: FAIL 0/2/2** (critical/major/minor). R11-1 and R11-3 are fixed. R11-2 is fixed in light but **still fails in dark** (1.15:1). The R11-2 CSS guard also **regressed light error badges to amber** (R11-6). See "Round 2 re-review" below.

**R1 verdict at `fbdf07db`: FAIL 0/2/3** (critical/major/minor). Two major findings are open for the sidebar and Needs-you area: Ctrl+J opens asleep work (R11-1) and the muted folder badge can't be read (R11-2). Both are XS fixes.

## Status vs round 10

| Item | Status | Evidence |
|---|---|---|
| R10-1 chevron/name jump on expand/collapse | **fixed** | The project chevron x is 21 when expanded and 21 when collapsed, at 4K (`02`) and at 1080 (`13`, measured after the toggle) |
| R10-2 truncated Desk labels have no tooltip | **fixed** | At 1080, 18 of 18 `.boring-row-label`s have a `title`. The two truncated ones ("Mechanical - renam…", "Review - Sonnet · dra…") carry their full name (`11`) |
| R8-5 worker crumb reads "Worker" | still open (minor) | `08b`, `11`: "VibeSquad › Desk › Worker" |
| R7-2 1080 reason clamp | unchanged (minor) | `11`: "…then approve the sav…" |
| R9-1 / R9-2 / R9-3 | not re-checked | out of scope |

### Invariants and tests

`node --test test/normal-invariants.test.mjs test/boring-mode.test.mjs test/boring-folders.test.mjs`: **148/148 pass, 0 fail, 0 skip** (106.9s).

## B11b checks

| Check | Result | Evidence |
|---|---|---|
| Active (unfoldered) projects on top, folder rows below | ✓ The seven unfoldered projects come first, then `Backlog · N 💤 [Asleep] ⋯` | `02`, `04` |
| Folder collapsed by default and expands cleanly | ✓ `aria-expanded=false` on load. Expanding lists its projects below the header (but see R11-5 on indent) | `04`, `05` |
| Active/Asleep pill is readable and doesn't clip | ✓ The pill is 53px at both sizes, with nothing clipped at 1080 (sidebar line 282px: row 181, pill 53, ⋯ 22). Text is `#6f6787` on white (about 5.3:1) and `#8b829f` on `#1a1624` (about 5.2:1) | `05`, `10` |
| Project ⋯ menu offers Move to / New folder… / Remove from folder | ✓ "Move to Backlog" and "New folder…" sit under a separator after Stop/Interrupt | `03` |
| Asleep project drops out of Needs-you and the title | ✓ Needs-you goes from 5 to 1 and the title from "(5)" to "(1)". Flipping the folder to Active brings back 5/(5), and flipping it to Asleep again returns 1/(1) | `04`, `06` |
| Asleep count shown muted on the folder row | ✗ It is there, but you can't read it (R11-2) | `04`, `10` |
| Ctrl+J follows the same list | ✗ It opens the asleep worker (R11-1) | `12-…-ctrlj-lands-asleep` |
| "Asleep · Wake" bar is calm and keeps chat height and the composer | ✓ One 33px strip under the crumb: `--surface-2`, text at about 9:1 in both themes. The composer bottom is at 1782/1800 at 4K and 1062/1080 at 1080, and the page doesn't scroll. Wake has an accent outline and is clearly the action | `07`, `08b`, `08c`, `11` |
| Exactly one selected row, crumb = row = open agent (asleep project) | ✓ Deep-linking `?agent=demo-aud` into the asleep project auto-opens the folder and the card, with a single `.on` on "Audit - token scout". The crumb reads VibeSquad › Desk › Worker | `11` |
| inv5: expanded projects share one shape | ✓ An expanded project inside a folder uses the same container card, chevron x (21) and Desk card as EFI at the top level | `07`, `11` |
| No agent listed more than twice | ✓ Asleep workers leave Needs-you, so each appears once (in the Desk card) | `07` |
| Zero "Hypnospace" | ✓ 0 matches in `body.innerText` + title, in all runs | none |
| Console errors | Only the demo `PATCH /api/teams` 403 (no local token in this tab, see R11-4). No page errors | none |

## Findings

### R11-1 · major · Ctrl+J opens a worker in an asleep project, while Needs-you shows only awake work
- **Job hurt:** 3, responding when something needs me. The shortcut sits next to the Needs-you header (`Ctrl+J`) and promises "Open the top NEEDS YOU agent". It now opens something that isn't in that list, and it does so in a project the owner deliberately put to sleep.
- **Evidence:** `12-1080-dark-ctrlj-lands-asleep`. With VibeSquad asleep, Needs-you shows 1 item ("Lead 75 · Main Game · Escape From Idle"). Pressing Ctrl+J from the EFI overview lands on `?team=vibesquad&agent=demo-aud` ("Audit - token scout"), with the Asleep bar showing. Pressing it again just stays there, so the owner can never reach Lead 75 with the shortcut. This breaks R6-2: Ctrl+J has to be row 0 of the same list that renders the count.
- **Cause:** `src/App.tsx:1385`. `openTopNeedsYou` calls `topNeedsYouId(derived().views, …)` with the unfiltered views. B11b filtered `useAttentionTitle` (`src/App.tsx:1551`) and the BoringInbox, but not this caller.
- **Fix:** `topNeedsYouId(filterAwakeViews(derived().views, getFolders()), nowTickValue())`. Better still, filter once inside `countedNeedsYouRows` or pass the awake list from one place, so the count, the inbox, the title and Ctrl+J can't drift apart again. Add an invariant test: the Ctrl+J target ∈ the rendered Needs-you rows when a folder is asleep.
- **Files:** `src/App.tsx`, `src/needsYouTop.ts`, `test/normal-invariants.test.mjs`. **Effort:** XS. **Lane:** @bor.

### R11-2 · major · The muted needs-you badge on an asleep folder is unreadable (about 1.1:1 light, 1.2:1 dark)
- **Job hurt:** jobs 2 and 3. This badge is the only signal left that asleep projects have work waiting. The spec says the count moves "muted on the folder row", and muted has to mean quieter, not invisible.
- **Evidence:** `04` (light) and `10-4k-dark-folder-row` (dark). Light: the text computes to `#ffffff` on a `#e6e1ef` badge at `opacity: 0.55` over white, about 1.1:1. Dark: the text is `#07040f` (`--on-accent`) on `#2c2640` at 0.55 over `#1a1624`, about 1.2:1. Both are far below the 4.5:1 gate. The "4" is barely there in both screenshots.
- **Cause:** `src/boring.css:974` sets `color: var(--text-2)` on `.boring-badge.muted`, but `src/boring.css:1180` (`[data-theme="light"] .boring-badge { color:#fff !important }`) wins in light. In dark, `.err`/on-accent text sits on a surface background. The `opacity: 0.55` then washes out whatever is left.
- **Fix:** drop the opacity. Give the muted badge outline styling instead: `background: transparent; border: 1px solid var(--border); color: var(--text-2) !important` (or `--text-3` if that still passes 4.5:1). A distinct class outside the `.boring-badge` cascade also works. For the err state, make it muted too, perhaps with a coloured outline only, so it doesn't shout but still reads.
- **Files:** `src/boring.css`, `src/BoringAde.tsx:902`. **Effort:** XS. **Lane:** @bor.

### R11-3 · minor · "Wake" on one project's Asleep bar wakes the whole folder, without saying so
- **Job hurt:** 5, intervening. In the open VibeSquad chat the owner clicks Wake, and every project in `Backlog` goes back to Active. Its needs-you items, the title count and automated wake-ups all come back.
- **Evidence:** clicking `boring-asleep-wake-btn` on VibeSquad flipped the folder pill to "Active" and moved Needs-you and the title from 1 to 5. The bar only says "Asleep · Automated wake-ups paused · Wake". `src/BoringAde.tsx:975` sends `setFolderAsleep(view.team.folder, false)`.
- **Fix:** name the scope, for example "Asleep (in Backlog) · Wake Backlog", or add `title="Wakes every project in Backlog"`. See the owner decision below on whether Wake should instead move just this project out.
- **Files:** `src/BoringAde.tsx`. **Effort:** XS. **Lane:** @bor.

### R11-4 · minor · Folder actions use native `alert()`/`prompt()`, and in `?demo` every move pops a token-jargon alert
- **Job hurt:** organising projects (supports job 2). The native dialogs block the window and don't match Normal's style.
- **Evidence:** in `?demo`, "Move to Backlog" raised `alert("Folder change failed: read-only: this loopback request has no VibeSquad local token…")`, and the console logged `403 /api/teams`. "New folder…" uses `window.prompt`. The code is in `src/CommandPalette.tsx` (`teamCtxItems`: `fail` → `window.alert`, `window.prompt`) and `src/BoringAde.tsx:829`.
- **Fix:** use an inline name field in the menu or a small modal for New folder, and the existing toast/banner for failures. In `DEMO`, apply folder ops locally so the demo and UX reviews can show folders. Also seed one foldered project in the demo cast so the asleep path is visible without stubbing.
- **Files:** `src/CommandPalette.tsx`, `src/BoringAde.tsx`, demo cast. **Effort:** S. **Lane:** @bor.

### R11-5 · minor · The folder row doesn't share the project row's geometry, and foldered projects aren't indented
- **Job hurt:** 2, scanning the tree.
- **Evidence:** `02`, `05`, `10-4k-dark-folder-row`. The folder name starts at x=43 while project names start at x=58: no dot slot, so the label sits 15px left of the column. The folder's `▸` glyph renders smaller and higher than the project chevrons. Projects inside an expanded folder start at the same x (21) as top-level projects, so you can only tell they belong to the folder from the order. Once the folder is open, the header reads like one more project row.
- **Fix:** put a 16px spacer (or a 📁/💤 glyph) where the dot goes so folder names line up at x=58. Use the same chevron element/size as `.boring-chevron-btn` on project rows. Indent `.boring-folder-projects` by about 12px, or give it a faint left rule like the Desk card.
- **Files:** `src/boring.css` (`.boring-folder-*`), `src/BoringAde.tsx`. **Effort:** XS. **Lane:** @bor.

### Noted, not findings
- When you open an asleep project, its Desk badge and Overview "Needs you · 4" stay full-strength red/amber (`07`, `11`). I think that's right: you opened it on purpose, and the Asleep bar explains the state. I'm not raising it.
- The Active/Asleep pill shows the current state but acts as a toggle. `aria-pressed` and the `title` ("Click to make Active") cover it. I'd only revisit it if the owner misreads it.
- I couldn't drive the 10+ alerts sequence, because the demo cast has 5 needs-you items. It isn't affected by B11b anyway.

## Owner decisions

1. **What does "Wake" on a single project do?** (R11-3)
   - a) Wake the whole folder (current behaviour), with the scope named on the button.
   - b) Move just this project out of the folder to Active, and leave the rest asleep.
   - **Recommendation: b.** You see the bar because you opened one project. Waking siblings you didn't look at brings back their badges and automated wake-ups, which is the noise the folder was meant to stop. The folder pill already covers "wake everything".

## Notes
- The asleep checks used a Playwright route stub for `/api/teams` because the demo can't write folders (R11-4). Everything else (badges, title, Ctrl+J, bar, layout) is the real B11b UI.

---

## Round 2 re-review: fix commit `88d6c43e` (diff `fbdf07db..88d6c43e`)

Same method and the same `/api/teams` route stub (VibeSquad in an asleep `Backlog`). I ran four passes: 3200×1800 light/dark and 1920×1080 dark/light. Screenshots are `artifacts/boring-b11-4k/r2-*`. Contrast is computed in the page: text colour × the opacity chain, composited over the first opaque ancestor background, using the WCAG formula.

### Status vs R1

| Item | Status | Evidence |
|---|---|---|
| R11-1 Ctrl+J opens asleep work | **fixed** | In all 4 passes, Ctrl+J from the EFI overview lands on `?team=efi&agent=demo-lead-efi` (Lead 75), row 0 of the visible Needs-you list (count 1). `src/App.tsx:1385` now filters through `filterAwakeViews` |
| R11-2 muted folder badge unreadable | **light fixed, dark still fails (major)** | Light: `#2b1840` on white, **16.06:1**, opacity 1, outline `1px solid #dcd6e6` (`r2-3200-light-folder-*`). Dark: `#07040f` on a transparent badge over the `#1a1624` sidebar, **1.15:1** at both 4K and 1080 (`r2-3200-dark-folder-expanded`, where the "4" is dark on dark) |
| R11-3 Wake scope unclear | **fixed** | The bar reads "Asleep · Automated wake-ups paused · **Wake Backlog**" in all 4 passes |
| R11-4 native alert/prompt, demo can't write folders | open (minor) | Not addressed in this commit. Rename and delete also still use `prompt`/`confirm` |
| R11-5 folder geometry | **mostly fixed, one part open (minor)** | The folder line is now 32px. The chevron is centred (row y 1098 h32 → chevron y 1104 h20, same centre) and the same 12px size as project chevrons. Projects in an open folder are indented (chevron x 21 → 43) under a 1px left rule. **Still open:** the folder name starts at x=43 while project names start at x=58, at both sizes |
| Wake bar keeps composer visible | ✓ | Composer bottom 1782/1800 (4K) and 1062/1080 |
| Folder count / pill contrast | ✓ | Light 5.3:1. Dark 4.89:1 (passes) |
| Title / Needs-you exclude asleep | ✓ | "(1) VibeSquad" / "Needs you 1" in all passes |
| "Hypnospace" copy | ✓ | 0 matches |

### R11-2 (still open in dark) · major · the muted badge text is `--on-pastel`, not `--text-2`
- **Evidence:** in dark, the computed `color` is `rgb(7, 4, 15)` and the background is transparent over `#1a1624`, giving **1.15:1**. The light theme only passes by luck: the same `--on-pastel` token happens to be dark ink there.
- **Cause:** `src/styles.css` has `:is(.badge, …):not(.alert):not(.label-pill):not(:where(.sidebar, …) *) { color: var(--on-pastel) !important }`. `.boring-badge` also carries `.badge`. The new muted rule at `src/boring.css:974` sets `color: var(--text-2)` *without* `!important`, so it loses. (Before R2, the light `!important` white rule hid the same problem in light.)
- **Fix:** `src/boring.css:974` → `color: var(--text-2) !important;`. Dark `--text-2` (`#b8afcb`) on `#1a1624` is about 9:1, and light (`#4c4363`) on white is about 9.6:1.
- **Files:** `src/boring.css`. **Effort:** XS. **Lane:** @bor.

### R11-6 · major (new regression in `88d6c43e`) · in light, error badges now render amber like needs-you badges
- **Job hurt:** 3, responding to errors. The red error count (for example the Desk header "4" when a worker has errored) now looks exactly like an ordinary needs-you count. That removes the error-vs-attention signal in the default light theme. Only the small status dot is still red.
- **Evidence:** `r2-3200-light-err-badges-unfoldered.png`. This was taken with no route stub and VibeSquad active (no folders involved). `.boring-trinity-head .boring-badge.err` has background `rgb(138, 87, 0)` (amber). At `fbdf07db`, the same `.err` badge in light measured `rgb(194, 42, 82)` (red, R1 run). The badge on VibeSquad inside the folder is amber too (`r2-3200-light-folder-expanded`).
- **Cause:** `src/boring.css:892`. Adding `:not(.muted)` raised `[data-theme="light"] .boring-badge:not(.muted) { background:#8a5700 }` from specificity (0,3,1) to (0,4,1), so it now beats `.boring-badge.err` (0,3,1) at `src/boring.css:1179`. Before the change they tied, and the later `.err` rule won.
- **Fix:** add `:not(.err)` to line 892 (`.boring-badge:not(.muted):not(.err)`), or add a light rule with matching specificity after it: `html[data-vibe="boring"][data-theme="light"] .boring-badge.err:not(.muted) { background: var(--st-err); }`. Add a test asserting light `.boring-badge.err` ≠ the amber background.
- **Files:** `src/boring.css`, `test/boring-mode.test.mjs`. **Effort:** XS. **Lane:** @bor.

### Still-open minors
- **R11-4** (alert/prompt/confirm, demo can't write folders). Unchanged, minor.
- **R11-5 remainder:** align the folder name with project names (x=43 vs 58). Give the folder row a 16px dot-slot spacer before the name. XS.

### Owner decision (carried)
- The R1 "what does Wake do?" question still stands. The R2 label "Wake Backlog" makes option (a) honest, so the finding is closed. I still recommend (b): wake just this project by moving it out of the folder.

**R2 verdict: FAIL 0/2/2.** Both majors are one-line CSS fixes in `src/boring.css` (974 and 892). A third round should only need the dark folder badge and the light `.err` badge re-measured.

---

## Round 3 re-review: fix commit `9c09d8e2` (diff `88d6c43e..9c09d8e2`)

Same method: the `/api/teams` route stub puts VibeSquad in an asleep `Backlog`, and a second, un-stubbed load checks badges with no folders involved. I ran four passes: 3200×1800 dark/light and 1920×1080 dark/light. Screenshots are `artifacts/boring-b11-4k/r3-*`. Contrast is computed in the page the same way as R2 (opacity chain, composited background, WCAG formula).

### Status vs R2

| Item | Status | Evidence |
|---|---|---|
| R11-2 muted folder badge (dark) | **fixed** | The class is now `boring-badge err muted` (no legacy `.badge`). Dark: `#b8afcb` (`--text-2`) on a transparent badge over the sidebar, with a `1px solid #332c47` outline: **7.81:1**. Light: `#4c4363` with a `#dcd6e6` outline: **7.92:1**. The values are identical at 4K and 1080 (`r3-*-folder.png`). Size 22×18, 13px/600, radius 999px, in line with the other sidebar badges (17×16, the extra comes from the 1px outline) |
| R11-6 light `.err` badge amber | **fixed** | Light, un-stubbed: the Desk header `.boring-badge.err` has background **`rgb(194, 42, 82)`** (`--st-err`) and white text, 5.6:1 (`r3-*-light-err-unfoldered.png`). Dark is unchanged at `rgb(255, 107, 138)`, 7.47:1. Ordinary needs-you badges are still amber `#8a5700` in light |
| R11-1 / R11-3 | stay fixed | not affected by this diff |
| R11-4 native dialogs, demo can't write folders | open (minor) | unchanged |
| R11-5 remainder: folder name x=43 vs project names x=58 | open (minor) | unchanged |

### R11-7 · minor (new, measured this round, code from B11b) · inside an asleep folder, the light error badge drops to 4.08:1
- **Job hurt:** 3, which is weak here. The owner has opened an asleep folder on purpose, and the number is still easy to read at 4K.
- **Evidence:** `r3-3200-light-folder.png`. VibeSquad's red "4" inside the open asleep folder composites to **4.08:1** (white on `--st-err` × the 0.8 parent opacity over white). The same badge outside a folder is 5.6:1. Dark is 5.77:1 (passes).
- **Cause:** `src/boring.css:980`, `.boring-folder.asleep .boring-folder-projects { opacity: 0.8; }`, which fades the whole subtree, badges included.
- **Fix:** move the fade off badges. Apply it to `.boring-project-line` names and dots only, or add `.boring-folder.asleep .boring-badge { opacity: 1.25 }`-style compensation. The cleanest option is to use `color: var(--text-3)` on the names instead of opacity.
- **Files:** `src/boring.css`. **Effort:** XS. **Lane:** @bor.

**R3 verdict: PASS 0/0/3.** No critical or major finding is open for the sidebar folders, Needs-you or the Asleep bar. Queue R11-4, the R11-5 remainder and R11-7 to the @bor inbox as minors.
