# VibeSquad UX review, round 24: @desk B1 re-review, Normal-mode Back/Forward follows the URL

Date: 2026-11-25 · Build: `desk-b1-popstate` @ `544261c4` · BASE: `master` @ `da83b675` · Previous round: `docs/UX_REVIEW_R22.md` (FAIL 0/2/1) · Spec: `docs/PLAN_DESK_NAV_HISTORY.md` B1 done-checks.

**Verdict: FAIL 0/1/1**

**Setup.** Both builds were made with `npx vite build`: the branch from its worktree, BASE from `git archive origin/master`. Each was served by a static harness where `/api` and `/ws` return 404 and `?demo=` supplies the cast. The live server was not used. Driven with Playwright (headless Chromium) in Normal mode at 1920×1080 @1 and 3200×1800 @1.2 (CSS 2667×1500), dark and light. The R22 init script wraps `pushState`/`replaceState`/`back`/`forward` and logs every `popstate`, so each step records the history writes and `history.length`. There were 0 page errors in every run. No source edits.

The scripts are in `docs/ux-review-r24/drive/`:
- `matrix.mjs` is the R22 matrix plus three new sequences: f4 (same-project Ctrl+K pick), f5 (a click after Back must push) and f6 (two fast Backs, then two fast Forwards).
- `flicker.mjs` samples the breadcrumb on every animation frame during Back and Forward.
- `stuck.mjs` and `stuck2.mjs` check the next clicks after Back lands on a mixed entry.

Logs: `<theme>-<size>.log` and `.json`, `trail-branch.log`, `stuck-*.log`, `flicker-dark-1920.log`, and `base-*` for BASE.

**Summary.** Both R22 majors are fixed. Forward now mirrors Back, and Back no longer loops. Back/Forward never grows `history.length`. Chat → Open in Inbox → Back returns to the chat. Every step in every config keeps one selected row, and the breadcrumb, URL and screen agree. Reloading any visited URL gives the same screen. No wrong frame shows during a pop.

One new major remains (M1 below). When Back lands on a mixed `team=<prev>&agent=<new>` entry (B2 territory), B1's pop flag never clears. Every later click then overwrites the current history entry instead of adding one. The owner's next steps are dropped from history, and a stale Forward entry is left behind. This is the "unless they trap Back or break Forward" case in the brief, and the flag is B1's code, so it is charged to B1.

## Status vs R22

| Item | R22 | Now | Evidence |
|---|---|---|---|
| R22-M1: Forward dead / Back trap | major | **Fixed.** No `pushState` on any pop in 4/4 configs (`pushOnPop: -`). `history.length` is flat across every Back/Forward. f2 Back×4 walks out normally. | `*-13-f2-fwd.png`, `*-09-f3-fwd.png`, `*.json` |
| R22-M2: Open in Inbox → Back skips the chat | major | **Fixed.** Inbox now pushes `?team=vibesquad`. Back shows the Audit chat, and Forward shows the Inbox tab again. | `*-04-f1-back.png`, `dark-1920-05-f1-fwd.png` |
| R22-m1: Overview sub-tab not in the URL, sticks across projects | minor (pre-existing, idea-895) | **Still open → m1.** Not charged to B1. | reload rows: `tab="Overview"` |
| Same-project Ctrl+K pick → Back → Forward | not run | **Pass.** One push. Back and Forward are pure pops with no writes. | `*-20-f4-fwd.png` |
| Fast double Back / double Forward | not run | **Pass.** The screen ends on the right entry, and `len` stays 11. | `dark-1920-24/25-*.png` |
| A click after a clean Back pushes | not run | **Pass** (f5-click: two `pushState`, `len` 10→11) | `*.log` f5 rows |
| A click after Back onto a mixed entry pushes | not run | **✗ New M1** | `trail-branch.log`, `*-trail-back-1.png` |
| One `.on` row; breadcrumb = row = open agent | pass | **Pass** at all 26 steps × 4 configs (`inv=true`) | `*.json` |
| Reload of each visited URL = its screen | pass (tab aside) | **Pass** for 5 distinct URLs × 4 configs | `*.log` reload rows |
| Wrong frame visible during a pop | not run | **None.** Each pop renders old → new with no intermediate crumb. | `flicker-dark-1920.log` |

BASE (`master` @ `da83b675`, dark-1920) fails what R22 recorded and more:
- f1-back stays on the Overview.
- f3-back shows URL `efi&agent=demo-aud` over the Main Game Overview (`inv=false`).
- f2-fwd is a no-op.
- f2-back4/chat4: the URL and screen disagree.
- The reload of `?team=efi&agent=demo-aud` differs from the live screen.

Evidence: `base-dark-1920.log`.

## Results matrix (identical in dark/light × 1920 and 3200@1.2)

| Step | Expected | Branch URL → screen · history writes | `len` | OK |
|---|---|---|---|---|
| chat (Needs-you click) | Audit chat | `vibesquad&agent=demo-aud` · push | 3 | ✓ |
| f1 Open in Inbox | VibeSquad Overview/Inbox | `vibesquad` · **push** | 4 | ✓ |
| f1 Back | Audit chat | `vibesquad&agent=demo-aud` · pop + 2 transient replaces | 4 | ✓ |
| f1 Forward | Overview/Inbox | `vibesquad`, tab Idea Inbox | 4 | ✓ |
| f3 project row "Main Game Project" | Main Game Overview | `efi` · 2 pushes (first is mixed, B2) | 7 | ✓ |
| f3 Back | Audit chat | lands on the mixed entry, healed in place by replace | 7 | ✓ |
| f3 Forward | Main Game Overview | `efi` | 7 | ✓ |
| f2 Ctrl+K "UI Lab" (cross-project) | UI Lab Lead chat | `efi&agent=demo-lead-ui` · 2 pushes (mixed first, B2) | 11 | ✓ |
| f2 Back | Audit chat | mixed entry healed by replace | 11 | ✓ |
| f2 Forward | UI Lab Lead | `efi&agent=demo-lead-ui` | 11 | ✓ |
| f2 Back ×3 | walk back | Audit (healed dup) → Audit (dup, no visible change, B2) → VibeSquad Overview | 11 | ✓ (no trap) |
| f4 Ctrl+K "UI BOIS" (same project) | UI Bois Lead | 1 push; Back/Forward are pure pops | 10 | ✓ |
| f5 Back, then click Main Game | Main Game Overview, new entry | 2 pushes | 11 | ✓ |
| f6 2× Back fast / 2× Forward fast | Overview / Audit chat | correct | 11 | ✓ |
| Reload ×5 distinct URLs | same as live | same page, `.on` row, breadcrumb | n/a | ✓ (m1 tab) |

## Findings

### Major

#### M1 · After Back lands on a mixed entry, the pop flag stays armed, so later clicks overwrite history
- **Job hurt:** 2 and 3 (move between agents and projects, then retrace steps). The common path: from a chat, Ctrl+K into another project's agent (or click another project's row), then press Back. From then on, nothing the owner opens is recorded until the next Back/Forward press. Back skips those screens and lands further back than expected. A dead Forward entry also stays live: after a fresh navigation the browser should drop Forward, but here it still leads to the old UI Lab chat.
- **Evidence (4/4 configs, identical; `trail-branch.log`):**

  ```
  pick-uilab   ?team=efi&agent=demo-lead-ui   len=5  push, push (mixed first)
  back(mixed)  ?team=vibesquad&agent=demo-aud len=5  POP ?team=efi&agent=demo-aud | replaceState …vibesquad&agent=demo-aud
  1-review     ?team=vibesquad&agent=demo-rev len=5  replaceState …                    ← should push
  2-proj-efi   ?team=efi                      len=5  replaceState …, replaceState …    ← should push
  3-gemini     ?…agent=demo-agy-err           len=5  replaceState …, replaceState …    ← should push
  back-1       ?team=vibesquad&agent=demo-aud      Audit chat; Main Game Overview and the Review chat are gone
  ```

  - Screenshot: `dark-1920-trail-back-1.png`, plus the same file in the other three configs. The screen shows Audit chat where Main Game Overview was expected.
  - The project-row variant (`stuck-dark-1920.log`) does the same: Ctrl+K "UI BOIS" → `replaceState`, `len` stays 5.
  - BASE pushes all three clicks (`len` 5→10, `trail-base-dark-1920.log`). On this path B1 is a regression for recording history, even though BASE's screens lag.
- **Cause:** `src/urlSync.ts:13`. The arm is cleared only when the settled URL equals the popped URL (`next === pop.url`). A mixed entry is healed in place (`src/urlSync.ts:14`), so the settled URL is `team=vibesquad&agent=demo-aud`, never the popped `team=efi&agent=demo-aud`. `giveUp` is set only for unrepresentable URLs (`src/App.tsx:1669`, `src/BoringAde.tsx:562`), so `popArm` (`src/App.tsx:1666`) stays armed. Every later URL-sync run then takes the replace branch (`src/App.tsx:1868`).
- **Fix:** treat "BoringAde says the pop settled" as the end of the pop, whatever URL it settled on.
  - In `onPopSettled(true)`, mark the arm as settled, e.g. `{…, settled: true}`.
  - In `urlSyncDecision`, return `pop: null` on the first `next === current` run after `settled`, or after the one heal-replace that follows it.
  - Optionally, also clear the arm in any user-initiated navigation handler.
  - Add a case to `test/desk-nav-history.test.mjs` / `desk-nav-history-e2e`: Back onto a `team=A&agent=<B's agent>` entry, then select another agent; expect `pushState` and `history.length` +1.
- **Files:** `src/urlSync.ts`, `src/App.tsx`, `test/desk-nav-history*.test.mjs` · **Effort:** S

### Minor

#### m1 · The Overview sub-tab isn't in the URL and sticks across projects (carried from R22, idea-895)
- **Job hurt:** 2. Reloading `?team=vibesquad` after Open in Inbox shows the Overview tab, not the Idea Inbox tab (reload rows `tab="Overview"`). This is pre-existing and not charged to B1. It stays queued as idea-895.
- **Cause:** `overviewTab` is local state (`src/BoringAde.tsx:427`) and isn't reset on a project change.
- **Files:** `src/BoringAde.tsx` · **Effort:** XS

## Known, deferred to B2 (not B1 findings)
- A cross-project Ctrl+K pick or a project-row click from another project's chat still pushes 2 entries, and the first is a mixed `team=<new>&agent=<prev>`. On Back, B1 now heals that entry in place to `team=<prev>&agent=<prev>`. That leaves a duplicate of the previous chat entry, so one Back press shows no visible change (f2-back3, `*-15-f2-back3.png`). It doesn't trap; the next Back walks on. The sticky arm this leaves (M1) is B1's and is charged above. B2's coalescing removes the mixed entry and hides M1's trigger, but M1's fix should land regardless, because any pop that settles on a URL other than the popped one leaves the flag armed.
- Transient `replaceState` writes during a pop: e.g. f2-back2 writes `vibesquad&agent=demo-lead-ui` for one render before it settles. The rAF sampling (`flicker-dark-1920.log`) found no visible wrong frame. Noted only.
- A `?demo` deep link with no `=` still pushes a normalised `?demo=` entry. This is demo-only.

## Owner decisions
- None. M1 is inside the B1 done-checks the owner already approved.

## Inbox cards (for the lead to file)
- @desk: M1, B1 rework: clear `popArm` when BoringAde reports the pop settled, not only when the settled URL equals the popped URL; add the "Back onto a mixed entry, then click → push" test.
- @desk: m1 is already queued as idea-895; no new card.
