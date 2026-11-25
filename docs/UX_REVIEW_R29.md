# VibeSquad UX review, round 29: @desk B1 re-review (5), Normal-mode Back/Forward follows the URL

Date: 2026-11-25 · Build: `desk-b1-popstate` @ `41f88cd4` (B1 r5) · Compared against: R28 build `bd7b1865` (r4) · Previous round: `docs/UX_REVIEW_R28.md` (FAIL 0/1/2) · Spec: `docs/PLAN_DESK_NAV_HISTORY.md` B1 done-checks.

**Verdict: PASS 0/0/2**

**Scope.** In r5 a pop stays active until the next user `pointerdown`/`keydown` or a newer pop. URL equality no longer ends it. While a pop is active, every history write is a replace-if-differs (`src/urlSync.ts:10-18` @ `41f88cd4`). This round checks:
- the R28 M1 repro (`go2`), plus `pw2`, `slow2` and `gap0`
- every R28 regression script (stuck, stuck2, trail3, edge, r4, sbkbd)
- a new probe for non-user navigation while a pop is still active

All runs are dark and light at 1920×1080 @1.

**Setup.**
- **Build:** `npx vite build` from the worktree while HEAD was `41f88cd4`. HEAD was checked in the same command as the build. `66efbbbc` (r6, the notification-click `stopPop`) landed later and was not tested, as briefed.
- **Server and logging:** the R28 static harness (`/api`, `/ws` → 404; `HEAD /api/storybook/*` → 200), with the same init script that logs every `pushState`/`replaceState`/`back`/`go`/`POP`.
- **Errors and edits:** 0 page errors in all 32 runs. No source edits.
- **Scripts:** in `docs/ux-review-r29/drive/`. They are R28's scripts, unchanged, plus the new `noinput.mjs`, which uses Playwright `page.clock` so 15 minutes can pass with no input.
- **Logs:** `docs/ux-review-r29/*.log`.

**Summary.**
- **M1 is fixed.** `go(-2)` and `gap0` over a mixed entry no longer push. Forward reaches the tip, Back walks the trail, and `len` stays flat.
- **No regressions.** Every R28 regression log is byte-identical to R28's r4 log, except the r4 `E-*` lines, which hit M1 in R28 and now pass. Dark and light are identical everywhere.
- **No non-user source overwrote a popped entry.** 15 minutes of no input (Needs-you 5 → 14) and a pref change from a second tab both made zero history writes.
- **R28's m1 is improved but still open.** It no longer pushes, but it still lands on the wrong screen.

## Status vs R28

| Item | R28 (r4) | Now (r5 `41f88cd4`) | Evidence |
|---|---|---|---|
| **M1**: `go(-2)` over a mixed entry, then Forward ×2 and Back ×3 | ✗ Back trap (push on every pop) | **Fixed.** `fwd1` does `POP efi&agent=demo-aud` then `replaceState vibesquad&agent=demo-aud`. `fwd2` reaches the `efi` Overview. Back ×3 walks: Audit chat, then one dead press on the healed mixed entry (known, B2), then VibeSquad Overview. `len` is 5 throughout and there are 0 `pushState`. | `fwdmixed-1920.log` go2 dark/light, `*-go2-fm-fwd2-efi.png` |
| M1 variant: 2 `history.back()` in one task (`gap0`) | ✗ trap | **Fixed**, same walk as `go2` | `fwdmixed-1920.log` gap0 |
| Two separate Backs 700 ms apart (`slow2`) | pass | **Pass** | `fwdmixed-1920.log` slow2 |
| r4 `E`: JS double Back, then Forward ×2, then Playwright double Back | ✗ (`E-fwd1` pushed, `E-fwd2` dead) | **Pass.** `E-fwd1` replaces, `E-fwd2` reaches the `efi` Overview, and `len` stays 6 | `r4-*.log` lines 5–7 (the only diff from R28) |
| R24 stuck2 trail; R27/R28 trail3 (Back onto a mixed entry, 3 clicks push, Back ×3 / Forward ×3, `fwd-4` does nothing) | pass | **Pass.** Byte-identical to R28. | `stuck2-*.log`, `trail3-*.log`, `dark-1920-trail-back-3.png` |
| Stuck project-row variant, then Ctrl+K | pass | **Pass**, identical | `stuck-*.log` |
| Edge: Back onto a gone team or an unknown agent, then a click; a click in the same tick as Back, or 50 ms after it | pass | **Pass**, identical | `edge-*.log` |
| Storybook round trip (`?sb=` open, Back, Forward into `sb`, Back, click pushes) | pass | **Pass**, identical | `r4-*.log` F/F2, `sbkbd-*.log` 1–17 |
| Keyboard-only navigation after Back (Ctrl+J, Ctrl+K push; Forward dropped; Back returns) | pass | **Pass**, identical | `sbkbd-*.log` 28–36, `light-1920-sk-29-ctrlj-push.png` |
| **Non-user sources while a pop is active** (brief item 3) | not run | **Pass, nothing user-visible.** See the next section. | `noinput-*.log`, `dark-1920-ni-5-15min.png` |
| R28 m1: two pops batched before a render (Playwright `goBack()` ×2, no gap) | ✗ wrong screen + push | **Improved, still open → m1.** No push, and Forward survives. It still lands on VibeSquad Overview instead of the Audit chat, and replaces the Audit entry with `?team=vibesquad`. | `fwdmixed-1920.log` pw2, `pw2-repeat-1920.log`, `dark-1920-pw2-fm-back2x.png` |
| R28 m2: Back into a planted `?sb=` entry doesn't reopen Storybook | ✗ pre-existing | **Unchanged → m2** | `sbkbd-*.log` 19 |
| One `.on` row; breadcrumb = URL = screen | pass except M1 | **Pass** at every step of every run (`inv=true`, `on=1`) | all logs |
| idea-895, idea-971 | queued | Not re-raised | n/a |

## Non-user navigation while a pop is active (brief item 3)

In r5 the pop stays active until the next input, so any state change that is not user input now replaces the popped entry instead of pushing. I probed the sources that can fire after a Back with no input:

| Source | Result | Evidence |
|---|---|---|
| Time passing: 15 min of no input. Workers cross the 10-min stall line, so Needs-you arrivals and re-ranking happen (count went 5 → 14). | **0 history writes.** The URL, screen and selected row are unchanged. A Forward/Back walk afterwards is intact. | `noinput-*.log` steps 5, 7–10; `dark-1920-ni-5-15min.png` |
| A second tab changes `vs.prefs.v1` (a `storage` event) | **0 writes** | `noinput-*.log` step 6 |
| A programmatic `vs:boring-open-agent` with no input (stand-in for "something opens an agent by itself") | Replaces the popped entry in place (`len` flat, Forward kept). The only shipped dispatcher is Ctrl+J (`src/App.tsx:1393`), and its `keydown` ends the pop first (`sbkbd` 29 pushes). So no real path reaches this. | `noinput-*.log` steps 11–15 |
| Agent events that change the derived URL (shown agent removed, lane Lead successor, project removed) | Not drivable in `?demo` (static cast, no `/ws`). From the code, these change `urlAgent`/`activeTeamId` (`src/BoringAde.tsx:625-635`, `src/App.tsx:1658-1659`). While a pop is active, r5 replaces the entry so it names what is now on screen. Before r5, the same event pushed a phantom entry. Replacing is the better behaviour here, because a later Back to that entry would heal to the same screen anyway. | code read |
| OS notification click (SW `vs:select-agent`) | Excluded per brief (known; r6 `66efbbbc` adds `stopPop`) | n/a |
| Iframes (a click inside does not reach the top window's `pointerdown`) | The only iframe is `src/FilePreview.tsx`, and it does not navigate | code read |

**Conclusion:** no source a user could hit overwrites the popped entry in a way they would notice.

## Findings

### Critical
None.

### Major
None.

### Minor

#### m1 · Two pops batched before a render land on VibeSquad Overview and overwrite the Audit chat entry (pre-existing; improved in r5)
- **Job hurt:** 2 (follow the work across projects). This only happens with sub-frame input.
- **Evidence** (`fwdmixed pw2`, two Playwright `goBack()` with no gap):
  - The log shows `POP efi&agent=demo-aud | POP vibesquad&agent=demo-aud | replaceState ?team=vibesquad | replaceState …&agent=demo-aud | replaceState ?team=vibesquad`.
  - The screen ends on VibeSquad Overview (`dark-1920-pw2-fm-back2x.png`) while history points at the Audit chat.
  - It reproduced in 13 of 14 runs (`pw2-repeat-1920.log`; the first light run in `fwdmixed-1920.log` landed correctly).
  - What r5 improved: there is no `pushState`, `len` stays 5, and Forward ×2 still reaches the `efi` Overview.
  - What remains: the Audit chat entry is rewritten to `?team=vibesquad`, so a later Back shows the Overview twice (`back-b`, `back-c`).
- **Severity:** two separate human Back presses ≥16 ms apart are fine (R28 gap sweep, `slow2`), so this stays minor.
- **Cause (lean):** the two pops collapse into one render. The final `replaceState ?team=vibesquad` comes from a mode reset that runs after BoringAde's navGen landing (`src/BoringAde.tsx:558-578`) set chat. My best guess is the `exitSquadsHome()`/`popAction` branch in `onPop` (`src/App.tsx:1680-1683`) for the first, mixed POP. I did not trace this further.
- **Fix:** in the navGen landing, re-derive from `location.search` on a microtask or `requestAnimationFrame` after the last pop. Alternatively, make `onPop` read the URL only once per batch. Add an e2e test: two `goBack()` with no gap must land on the Audit chat.
- **Files:** `src/App.tsx` (onPop), `src/BoringAde.tsx` (navGen landing) · **Effort:** S

#### m2 · Back into a `?sb=` entry doesn't reopen Storybook (pre-existing, unchanged)
- **Evidence:** in `sbkbd` step 19, the log shows `POP …&sb=vibesquad | replaceState …` without `sb`, and Normal stays on screen. This is the same as R28.
- **Files:** `src/StorybookView.tsx` · **Effort:** XS–S

## Known, deferred to B2 (not findings)
- The dead Back press on a healed mixed entry (`go2` `back-b`, `noinput` step 9).
- The `team=<new>` → `team=<new>&agent=<x>` double push.

## Owner decisions
- None.

## Inbox cards (for the lead to file)
- @desk B1 follow-up (low): m1. Batched double pop lands on the Overview and rewrites the chat entry. Add a no-gap double `goBack()` e2e test.
- @desk (low, already carded in R28): m2. Back into `?sb=` should reopen Storybook.

**Verdict: PASS 0/0/2**
