# VibeSquad UX review, round 12: B11d, per-project Wake, "Back to <folder>", R11-5/R11-7 polish

Date: 2026-11-22 · Build: `unit-bor-b11d-wake-project` @ `56c29908` (diff `32941bf0..56c29908`), vite dev on `:5412`, run from the unit worktree.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). `?demo` at 3200×1800 (4K at 120%) and 1920×1080, in light and dark.
Screenshots: `artifacts/boring-b11d-4k/` (untracked, in the unit worktree). The two-digit numbers below refer to those files.

**Fixture note:** same approach as R11. Demo mode can't write folders (R11-4), so a stateful Playwright route stub on `GET/PATCH /api/teams` puts VibeSquad and Site into an asleep `Backlog` and adds an empty Active `Parked` folder. The stub applies `setTeamFolder`/`setFolderAsleep` PATCHes for real, so Wake and Back go through the real request → `refreshTeams()` → repaint path. The UI code under test is unchanged. I reset the stub before each pass.

**Verdict at `56c29908`: PASS 0/0/1** (critical/major/minor) for the sidebar folders, Asleep bar and project ⋯ menu. All four B11d items work as specified at both sizes and in both themes, and R11-5 and R11-7 are closed. The only open minor in the area is R11-4, carried over and unchanged.

## Status vs round 11

| Item | Status | Evidence |
|---|---|---|
| R11-3 / owner decision "what does Wake do?" | **done, option (b)** | The bar reads "Asleep · Automated wake-ups paused · **Wake project**". Clicking it moves only VibeSquad to Active. Backlog goes from `· 2 💤 4` to `· 1 💤` and Site stays asleep inside it. Needs-you and the title go from 1/(1) to 5/(5). Verified in all 4 passes (`03`, `04`, `08-*`) |
| R11-5 remainder: folder name x=43 vs project names x=58 | **fixed** | The folder name is at x=57 and project names at x=58, in all 4 passes. The 1px gap isn't visible (`02`, `07-*`). Fixed by `src/BoringAde.tsx:910` and `src/boring.css:981` |
| R11-7 light err badge in an asleep folder at 4.08:1 | **fixed** | Light: white on `rgb(194,42,82)`, opacity chain 1.0, **5.6:1** (same as outside a folder). Dark: `#07040f` on `rgb(255,107,138)`, **7.47:1**. Asleep names are still calmer: `--text-2` (light `#4c4363` 9.17:1, dark `#b8afcb` 8.47:1) against `--text-1` for top-level names. Fixed by `src/boring.css:980` |
| R11-4 native `alert`/`prompt`/`confirm`, demo can't write folders | **open (minor)** | Unchanged. `src/BoringAde.tsx:840` still calls `window.alert` on failure, and `src/CommandPalette.tsx:328` does the same. The new Wake and Back actions inherit this: in un-stubbed `?demo` they fail with the token-jargon alert |
| R11-1, R11-2, R11-6 | stay fixed | Ctrl+J with VibeSquad asleep lands on Lead 75 (row 0 of a Needs-you list of 1). The muted folder badge measures 7.92:1 in light |
| R8-5 worker crumb reads "Worker" | still open (minor, outside this area) | `09`, `10`: "VibeSquad › Desk › Worker" |
| R7-2 1080 reason clamp | unchanged (minor, outside this area) | `09`: "…then approve the sav…" |

### Tests

`node --test test/normal-invariants.test.mjs test/boring-folders.test.mjs test/boring-mode.test.mjs`: **155/155 pass, 0 fail, 0 skip** (123.3s).

## B11d checks

| Check | Result | Evidence |
|---|---|---|
| 1. Wake moves ONLY this project to Active | ✓ The PATCH is `setTeamFolder {teamId, folder:null}` (`src/BoringAde.tsx:987`). Site stays in Backlog and Backlog stays asleep. VibeSquad joins the top-level list, still expanded and still selected. The bar disappears | `04`, `08-*` |
| 1. Wake remembers `lastFolder` | ✓ `localStorage["vs.boringLastFolder"]` = `{"vibesquad":"Backlog"}` after Wake, in every pass | none |
| 1. Wake label and tooltip | ✓ "Wake project" (91×24, accent outline, the clear action in a 33px bar). `title`: "Move VibeSquad out of Backlog to Active (other projects in Backlog stay asleep)" names both the scope and where the project goes | `03`, `08-*` |
| 1. Wake from a worker chat (deep link `?agent=demo-aud`) | ✓ Before: the Asleep bar shows, there is exactly one `.on` row (Audit - token scout), and the crumb reads VibeSquad › Desk › Worker. After Wake: the bar is gone, there is still exactly one `.on` row, and the URL and crumb are unchanged. Ctrl+J then lands on Audit - token scout, which is row 0 of the now-5 Needs-you list. The composer stays pinned at the bottom (1080) | `09`, `10` |
| 2. ⋯ menu shows "Back to Backlog" first, with no duplicate "Move to Backlog" | ✓ Items after the separator: **Back to Backlog** · Move to Parked · New folder…. There is no "Move to Backlog" and no "Remove from folder" (the project isn't in a folder) | `05` |
| 2. Back is one click and clears the memory | ✓ One click puts VibeSquad back in the asleep Backlog. The Asleep bar returns, Needs-you/title go back to 1/(1), and `lastFolder` becomes `{}`. Reopening the menu shows "✓ In Backlog · Move to Parked · New folder… · Remove from folder" | `06` |
| 2. The "Remove from folder" path also offers Back | ✓ Removing Site from Backlog stores `{"site":"Backlog"}`, and Site's ⋯ menu then reads "Back to Backlog · Move to Parked · New folder…" | `11` |
| 3. R11-5 alignment | ✓ The folder name is at x=57 and project names at x=58, in all 4 passes | `02`, `07-*` |
| 4. R11-7 contrast | ✓ The light badge measures 5.6:1 and the dark one 7.47:1. Asleep names stay calmer (`--text-2`) | `02`, `07-*` |
| Counts agree (Needs-you header, title, folder badge) | ✓ Asleep: 1/(1), with the folder showing a muted 4. After Wake: 5/(5), with no folder badge. After Back: 1/(1) | none |
| Expanded projects share one shape | ✓ When woken, VibeSquad uses the same card, chevron and Desk card as EFI | `04` |
| No agent listed more than twice | ✓ | `10` (Audit is listed once in Needs-you and once in the Desk card) |
| Zero "Hypnospace" | ✓ | none |
| Console errors | Only the existing demo read-only token error (1 entry). No page errors | none |

## Findings

No new critical, major or minor findings.

### R11-4 (carried) · minor · Folder actions fail through a native `alert()` with token jargon, and demo can't write folders
- **Job hurt:** 5, intervening. B11d adds two more actions (Wake project and Back to …) that go through the same `fail → window.alert` path. In `?demo` or a tab without a token, the owner's first click on "Wake project" shows "Folder change failed: read-only: this loopback request has no VibeSquad local token…".
- **Evidence:** `src/BoringAde.tsx:838-841` (`folderOp` → `window.alert`), `src/CommandPalette.tsx:328` (`fail` → `window.alert`). This is unchanged since R11.
- **Fix:** as in R11. Show failures in the existing toast/banner, apply folder ops locally in `DEMO`, and seed one foldered project in the demo cast so Wake and Back can be demoed without a stub.
- **Files:** `src/BoringAde.tsx`, `src/CommandPalette.tsx`, demo cast. **Effort:** S. **Lane:** @bor.

### Noted, not findings
- **The memory never expires.** `lastFolder` has no TTL. A project woken weeks ago still offers "Back to Backlog" for as long as it stays unfoldered (`src/boringFolders.ts:64-67`, `src/CommandPalette.tsx:330-331`). I think that's harmless and probably what the owner wants: it is one menu line, and it is accurate. The rename and delete migrations (`migrateLastFolder`) keep it from pointing at a folder that no longer exists, and `src/CommandPalette.tsx:331` also guards against that.
- **"Back to Backlog" doesn't say it puts the project back to sleep.** I'd leave it. The owner just woke the project from that folder, and the label sits right under that context.
- **At 1080, the selected row can drop below the fold after Wake.** Needs-you grows from 1 to 5 and pushes the tree down, and the sidebar doesn't scroll the `.on` row back into view (`10`). The same agent is row 0 of Needs-you, so it is still visible and reachable. Worth folding into any future "scroll selection into view" work.
- I couldn't drive the 10+ alerts sequence, because the demo cast has 5 needs-you items. It isn't affected by B11d anyway.

## Owner decisions

None new. The R11 Wake decision has been implemented as the recommended option (b).

## Notes
- The asleep-path checks used a stateful Playwright route stub for `/api/teams`, as in R11, because the demo can't write folders (R11-4). The badges, title, Ctrl+J, bar, menu, `localStorage` memory and layout are all the real B11d UI.
