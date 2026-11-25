# VibeSquad UX review, round 27: @desk B1 re-review (3), Normal-mode Back/Forward follows the URL

Date: 2026-11-25 · Build: `desk-b1-popstate` @ `577b6171` · BASE: `master` @ `4ea87deb` · Previous round: `docs/UX_REVIEW_R24.md` (FAIL 0/1/1) · Spec: `docs/PLAN_DESK_NAV_HISTORY.md` B1 done-checks.
(Numbering: R25 is used by `desk-b3-needsyou-fit` and R26 by `UX_REVIEW_R26_BOR_B15.md`, so this round is R27.)

**Verdict: PASS 0/0/1**

**Setup.** Both builds were made with `npx vite build`: the branch from its worktree, BASE from `git archive master`. Each was served by the same static harness as R22/R24, where `/api` and `/ws` return 404 and `?demo=` supplies the cast. The live server was not used. Driven with Playwright (headless Chromium) in Normal mode at 1920×1080 @1 and 3200×1800 @1.2 (CSS 2667×1500), dark and light. The R24 init script wraps `pushState`/`replaceState`/`back`/`forward` and logs every `popstate`, so each step records the history writes and `history.length`. There were 0 page errors in every run. No source edits.

The scripts are in `docs/ux-review-r27/drive/`:
- `matrix.mjs`, `flicker.mjs`, `stuck.mjs` and `stuck2.mjs` are copied unchanged from R24.
- `trail3.mjs` is new. It runs Back onto a mixed entry, then 3 clicks, then Back ×3, then Forward ×4. The last Forward must do nothing.
- `edge.mjs` is new. It covers Back onto a gone team and Back onto an unknown agent, each followed by a click and a Forward. It also covers a click in the same tick as Back, and a click 50 ms after Back.
- `reload-ghost.mjs` loads a gone-team URL from scratch, to give a reference for what Back onto that URL should show.
- `flicker-3200.mjs` runs `flicker.mjs` at 3200 light.

Logs are in `docs/ux-review-r27/`:
- `<theme>-<size>.log` and `.json`
- `trail-branch.log`, `stuck-branch.log` and `edge-branch.log`. Each holds all 4 configs, and the 4 are identical apart from the screenshot names.
- `flicker-*.log` and `reload-ghost*.log`
- `*-base-dark-1920.log` for BASE

**Summary.** R24-M1 is fixed. After Back lands on a mixed entry, the next 3 clicks push 3 entries. Back walks them in order, and the stale Forward entry (UI Lab) is gone. The project-row variant pushes as well, and so does a click after Back onto a gone team or an unknown agent. A click in the same tick as Back pushes and drops Forward, and so does a click 50 ms after Back. All R22/R24 flows still pass in 4/4 configs:
- every step has one selected row, with breadcrumb = URL = screen
- reload matches for 5 URLs
- 0 pushes during a pop
- `history.length` stays flat across every Back/Forward

The rAF sampling shows no wrong breadcrumb frame. The only open item is the carried minor m1 (idea-895), which is not B1's. The known B2 extra entries remain and are recorded below. None of them traps Back or breaks Forward.

## Status vs R24

| Item | R24 | Now | Evidence |
|---|---|---|---|
| R24-M1: after Back onto a mixed entry, clicks `replaceState` | major | **Fixed.** All 3 clicks push, and `len` goes 5→5→7→9. On the first click, `len` stays 5 because the push truncates Forward. Back×3 walks Main Game Overview and then the Review chat. Forward×3 returns to the Gemini chat. A 4th Forward does nothing, so UI Lab is dropped. 4/4 configs. | `trail-branch.log`, `*-trail-back-3.png`, `dark-1920-trail-fwd-3.png` |
| Stuck project-row variant (Back onto mixed entry via project row, then Ctrl+K "UI BOIS") | ✗ (replace) | **Pass.** `pick-uibois` pushes once, and Back returns to the Audit chat. | `stuck-branch.log` |
| Mixed Back, then click Review: push | ✗ | **Pass** | `stuck-branch.log` `click-review` |
| Back onto a gone team, then click | not run | **Pass.** The pop heals in place (`replaceState ?team=efi`) and shows Main Game Overview, the same screen a fresh load of `?team=ghostteam` shows (`reload-ghost.log`, and BASE matches). The click then pushes, and Forward does nothing. | `edge-branch.log` A-*, `dark-1920-edge-A-back-ghost.png`, `*-edge-A-click.png` |
| Back onto an unknown agent, then click | not run | **Pass.** It heals in place to `?team=vibesquad` (Overview). The click pushes `?team=efi`, and Forward does nothing. | `edge-branch.log` B-*, `dark-1920-edge-B-*.png` |
| A click right after Back (same tick, and +50 ms) | not run | **Pass.** It pushes after the pop, and a later Back lands on the popped entry. | `edge-branch.log` C/D, `dark-1920-edge-C-*.png`, `dark-1920-edge-D-*.png` |
| R22/R24 flows (f1 Inbox, f3 project row, f2/f4 Ctrl+K, f5 click after Back, f6 fast 2× Back/Forward) | pass | **Pass**, all expectations `true`, 4/4 configs. Steps are identical to R24 apart from fewer transient `replaceState`s on f1-back and f6. | `<theme>-<size>.log` |
| One `.on` row; breadcrumb = URL = screen | pass | **Pass** at every step of the matrix (26), trail (13) and edge runs in 4/4 configs (`inv=true`) | `*.log` |
| Reload of each visited URL = its screen | pass | **Pass**, 5 URLs × 4 configs | `*.log` reload rows |
| Wrong frame during a pop | none | **None.** The breadcrumb goes old → new with no intermediate crumb, at dark-1920 and light-3200. The address bar briefly shows the mixed URL on f3-back before the heal, as in R24. | `flicker-*.log` |
| R24-m1: Overview sub-tab not in the URL (idea-895) | minor | **Still open → m1** (not B1's) | reload rows `tab="Overview"` |

On BASE (`master` @ `4ea87deb`), the trail sequence breaks Back (`trail-base-dark-1920.log`):
- back-1 pushes a new entry.
- back-2 shows URL `?team=vibesquad` over the Gemini chat (`inv=false`).
- back-3 lands on the mixed `efi&agent=demo-agy-err`.
- Forward×4 are no-ops.

## Findings

### Critical
None.

### Major
None.

### Minor

#### m1 · The Overview sub-tab isn't in the URL and sticks across projects (carried from R22/R24, idea-895)
- **Job hurt:** 2. Reloading `?team=vibesquad` after Open in Inbox shows the Overview tab, not the Idea Inbox tab (reload rows `tab="Overview"`, 4/4 configs). This is pre-existing and not charged to B1.
- **Cause:** `overviewTab` is local state in `src/BoringAde.tsx` and isn't reset on a project change.
- **Files:** `src/BoringAde.tsx` · **Effort:** XS · already queued as idea-895.

## Known, deferred to B2 (not B1 findings; none traps Back or breaks Forward)
- **Mixed-entry creation and the one dead Back press.** These are unchanged from R24. A cross-project Ctrl+K pick or project-row click pushes `team=<new>&agent=<prev>` first. On Back, B1 heals that entry in place, which leaves a duplicate of the previous chat. The next Back then shows no change (`f2-back3`, `stuck-branch.log` `back2`).
- **Same family, the other direction.** A Needs-you click into another project pushes `team=<new>` and then `team=<new>&agent=<x>` (`chat3`, `trail 3-gemini`, `edge A-click`). Back from that chat lands on `<new>` Overview, a screen the owner never opened (`*-trail-back-1.png`: VibeSquad Overview after a click from Main Game Overview). The next Back walks on. BASE and R24 do the same (`chat3` rows), so this is not a B1 regression. B2's coalescing should cover both directions. Please make sure the B2 plan names this second shape, not only the `agent=<prev>` one.
- **Pre-existing load behaviour.** A fresh load of a gone-team URL pushes a fallback entry (`?team=efi`) instead of replacing (`reload-ghost.log`, and BASE matches). Back from it heals in place, which costs one dead press, and it does not trap. The fallback is the first project, not the project the owner was in. That matches load, so the reload invariant holds.
- **Transient address-bar URL.** It shows for one render during a mixed-entry heal (`flicker-dark-1920.log` f3 back). The breadcrumb never shows a wrong frame. Noted only.

## Owner decisions
- None. B1 now meets its done-checks.

## Inbox cards (for the lead to file)
- @desk B2: also coalesce the `team=<new>` → `team=<new>&agent=<x>` double push from a cross-project Needs-you/sidebar click. Today Back lands on an Overview the owner never opened (`trail-branch.log` back-1).
- @desk: m1 is already queued as idea-895; no new card.
