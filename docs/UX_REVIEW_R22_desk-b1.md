# VibeSquad UX review, round 22: @desk B1, Normal-mode Back/Forward follows the URL

Date: 2026-11-24 · Build: `desk-b1-popstate` @ `cd42ba45` · BASE: `master` @ `15e49a29` · Spec: `docs/PLAN_DESK_NAV_HISTORY.md` B1 done-checks.

**Setup.** Both builds were made with `npx vite build` from their own trees (branch worktree; BASE from `git archive 15e49a29`). Each was served by a static harness (`/api` returns 404, and `?demo=1` supplies the cast), not the live server. Driven with Playwright (headless Chromium) in Normal mode at 1920×1080 @1 and 3200×1800 @1.2 (CSS 2667×1500), dark and light. An init script wraps `history.pushState/replaceState` and logs `popstate`, so each step records the exact history writes and `history.length`. There were 0 page errors in every run. No source edits. The drive scripts are in `docs/ux-review-r22/drive/`. Per-step JSON for each config is in `docs/ux-review-r22/<theme>-<size>.json`.

Sequences start on `?demo=&team=vibesquad` (Overview). The chat is opened by clicking the "Audit - token scout" Needs-you row, which is the realistic way in (it pushes an entry). Deep-linking straight to `?demo&team=…&agent=…` hides finding M2: the app's `?demo` → `?demo=` normalisation push adds a spare chat entry.

**Verdict at `cd42ba45`: FAIL 0/2/1 (critical/major/minor).** B1 fixes the core symptom: after every Back or Forward, the URL, screen, sidebar selection and breadcrumb agree (they didn't on BASE). Two B1 done-checks still fail. Forward never mirrors Back, and after a cross-project pick Back gets stuck on one entry (M1). Chat → Open in Inbox → Back doesn't return to the chat (M2).

## Status vs previous rounds

| Item | Previous | Now | Evidence |
|---|---|---|---|
| R14-2: Back after "Open in Inbox" restores the chat | open (minor; patched in `4403ac7d` with `replaceState`) | **Still open → M2.** Back now skips the chat entirely. | `*-04-f1-back.png` |
| R21 pre-existing / idea-844: after a Ctrl+K pick, Back changes the URL but not the screen | open | **Fixed for screen/URL agreement.** Back from the pick shows the previous chat, and the URL agrees. **Regressed** on history: see M1. | `dark-1920-12-f2-back.png`, `*-15-f2-back3.png` |
| Chat → project row → Back = chat | BASE: URL `?team=efi&agent=demo-aud`, screen Main Game Overview (disagree) | **Fixed** (chat shown, URL agrees) | `dark-1920-08-f3-back.png` vs `base-dark-1920-08-f3-back.png` |
| SPEC R2 #4: one `.on` row, breadcrumb = selected row = open agent, after each Back/Forward | BASE fails at f3-back (`inv=false`) | **Pass** in all 4 configs, every step | `*.json` → `inv: true` on all rows |
| Reload of every visited URL matches its screen | BASE: `?team=vibesquad` reload ≠ live screen | **Pass** on page and selection in all 4 configs. Only the Overview sub-tab differs (m1). | matrix output below |

## Results matrix (identical in dark/light × 1920/3200@1.2)

| Step | Expected | Branch URL → screen | OK |
|---|---|---|---|
| chat (Needs-you click) | Audit chat | `team=vibesquad&agent=demo-aud` → chat | ✓ |
| f1 Open in Inbox | VibeSquad Overview, Idea Inbox tab | `team=vibesquad` → Overview/Inbox (**replaceState**) | ✓ |
| f1 Back | Audit chat | `team=vibesquad` → Overview/Inbox (the chat entry was overwritten) | **✗ M2** |
| f1 Forward | Inbox | `team=vibesquad` → Inbox | ✓ (trivially) |
| f3 project row "Main Game Project" | Main Game Overview | `team=efi` → Overview (2 pushes; the 1st is a mixed `team=efi&agent=demo-aud`, which is B2) | ✓ |
| f3 Back | Audit chat | `team=vibesquad&agent=demo-aud` → chat, **then 2 new pushes** | ✓ screen, ✗ history |
| f3 Forward | Main Game Overview | no-op: stays on chat | **✗ M1** |
| f2 Ctrl+K "UI Lab" → Enter | UI Lab Lead chat | `team=efi&agent=demo-lead-ui` → chat | ✓ |
| f2 Back | Audit chat | `team=vibesquad&agent=demo-aud` → chat, **then 1 new push** | ✓ screen, ✗ history |
| f2 Forward | UI Lab Lead chat | no-op: stays on Audit chat | **✗ M1** |
| f2 Back ×3 more | walk back through history | stuck: each Back pops the mixed entry and re-pushes the Audit URL; `history.length` stays 9 | **✗ M1** |
| Reload ×4 distinct URLs | same page as live | same page, same `.on` row, same breadcrumb | ✓ (m1 tab) |

BASE on the same f2 sequence: Back ×4 walks `efi&agent=demo-aud` → `vibesquad&agent=demo-aud` → `vibesquad` (the screen lags, which B1 targets), and it never traps.

## Findings

### Major

#### M1 · Back/Forward re-derivation pushes new history entries, so Forward is dead and Back can trap
- **Job hurt:** 2 and 3 (move between agents and projects and retrace steps). Browser Back/Forward is how the owner retraces a detour. After one cross-project Ctrl+K pick or project-row click, Forward does nothing and Back loops on the same chat forever. The only way out is to click in the sidebar. This is a regression vs BASE, where history stayed walkable and only the screen lagged.
- **Evidence (all 4 configs):**
  - Forward no-op: `dark-1920-09-f3-fwd.png`, `dark-1920-13-f2-fwd.png`, `light-3200-13-f2-fwd.png` (still on the Audit chat; Forward should be UI Lab › Lead).
  - Back trap: `dark-1920-15-f2-back3.png`. The history log for each Back: `POP ?team=efi&agent=demo-aud | pushState ?team=vibesquad&agent=demo-aud`, and `history.length` stays at 9.
  - Clean entries also push: chat → same-project row → Back → Forward gives `POP ?team=vibesquad | pushState …&agent=demo-aud | pushState ?team=vibesquad`. `history.length` goes 3→5 on one Forward, so every Forward adds two duplicate entries.
- **Cause:**
  - The App URL-sync effect always uses `pushState` when the derived state differs from `location` (`src/App.tsx:1857-1860`). That includes the renders that follow a `popstate`.
  - After a pop, the derived state passes through stale values before B1's re-derivation settles. `onPop` (`src/App.tsx:1665-1673`) sets the team, `boringShown` still holds the old agent, and then `BoringAde`'s B1 effect (`src/BoringAde.tsx:556-573`) switches mode.
  - On a mixed B2 entry (`team=<prev>&agent=<new>`), `src/BoringAde.tsx:561` also calls `onSelectSquad(<agent's real team>)`, which changes `activeTeamId` again. Each of these transient states gets pushed, and every push wipes the Forward stack.
- **Fix:**
  - In `onPop`, set a "popping" flag (or record the popped `location.search`). While it's set, the URL-sync effect must use `replaceState` and must never push. Clear it once BoringAde's B1 effect has run (for example, at the end of that effect or on the next `navGen` render).
  - This makes the mixed-entry case self-heal in place (the entry is rewritten to the agent's real team), so the trap goes away even before B2.
  - Add a test that asserts `history.length` is unchanged across Back and Forward. The `desk-nav-history` test covers only `boringLandingFromUrl`.
- **Files:** `src/App.tsx`, `src/BoringAde.tsx`, `test/desk-nav-history.test.mjs` · **Effort:** S

#### M2 · Chat → "Open in Inbox" → Back doesn't return to the chat (R14-2 done-check)
- **Job hurt:** 4 (review output). The loop is: hover a ref → open the card → go back to the conversation. After Back, the screen doesn't change at all: still VibeSquad › Overview on the Idea Inbox tab (`dark-1920-04-f1-back.png`, `light-3200-04-f1-back.png`). The chat entry is gone from history, so a second Back goes to whatever came before the chat. If the chat was opened from a deep link or notification, Back leaves the app.
- **Cause:** `src/RefPopover.tsx:266-276` (the R14 patch, `4403ac7d`) overwrites the chat's own history entry with `replaceState(?team=…)`. At the time, that kept the URL honest because Normal's mode didn't follow popstate. B1 makes the screen follow popstate, so the workaround now defeats B1's own done-check.
- **Fix:** delete the `replaceState` block in `openInbox`'s Normal branch and let App's URL sync push `?team=` as for any other navigation. B1's popstate re-derivation then returns the chat on Back. This depends on M1's fix so the pop doesn't re-push.
- **Files:** `src/RefPopover.tsx` (owner lane for the trigger: @ui-bois, per R14) · **Effort:** XS

### Minor

#### m1 · The Overview sub-tab (Overview / Idea Inbox / Standup Feed) isn't in the URL, and it sticks across projects
- **Job hurt:** 2. Reloading `?team=vibesquad` after Open in Inbox shows the Overview tab, not Idea Inbox (reload row in the matrix, `tab="Overview"` vs live `"Idea Inbox (1)"`). After opening the Inbox in VibeSquad, clicking "Main Game Project" opens Main Game on its Idea Inbox tab (`dark-1920-07-f3-proj.png`). Back/Forward between two entries of the same project can't restore the tab, which is part of why M2's Back press looks dead.
- **Cause:** `overviewTab` is local BoringAde state (`src/BoringAde.tsx:1091-1093`) and isn't reset on a project change. This is pre-existing and not charged to B1.
- **Fix:** reset `overviewTab` to `"overview"` when the project changes, except for the Open-in-Inbox path. Optionally serialise a `tab=inbox` query param.
- **Files:** `src/BoringAde.tsx` · **Effort:** XS

## Known, out of scope for B1 (B2 next)
- A project-row click from another project's chat and a Ctrl+K cross-project pick each push two entries, and the first is a mixed `?team=<new>&agent=<prev>` (`pushState ?team=efi&agent=demo-aud | pushState ?team=efi…`). That's B2's coalescing work. M1 is still charged to B1: on BASE the same mixed entries never trap Back, and the push-on-pop is B1's handler.
- On a `?demo` deep link with no `=`, the first render pushes a normalised `?demo=` duplicate. This is demo-only.

## Owner decisions
- None. Both majors are inside the B1 done-checks the owner already approved in `docs/PLAN_DESK_NAV_HISTORY.md`.

## Inbox cards (for the lead to file)
- @desk: M1 (B1 rework: no push while handling popstate), M2 (drop the R14 `replaceState`; coordinate the `src/RefPopover.tsx` hunk with @ui-bois), m1 (reset the overview tab on a project change).
