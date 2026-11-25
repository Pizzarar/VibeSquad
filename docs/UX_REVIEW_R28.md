# VibeSquad UX review, round 28: @desk B1 re-review (4), Normal-mode Back/Forward follows the URL

Date: 2026-11-25 · Build: `desk-b1-popstate` @ `bd7b1865` (B1 r4) · Compared against: R27 build `577b6171`, and BASE `master` @ `c9bcb197` · Previous round: `docs/UX_REVIEW_R27.md` (PASS 0/0/1) · Spec: `docs/PLAN_DESK_NAV_HISTORY.md` B1 done-checks.

**Verdict: FAIL 0/1/2**

**Scope.** This round only re-checks the history trail after r4 replaced the pop mechanism. In r4, App alone owns `popTarget`. It is cleared by the next capture-phase `pointerdown` or `keydown`, or when the screen's URL equals the popped URL. I checked:
- the R24 stuck2 trail, including Back onto a mixed `team=<prev>&agent=<new>` entry, then clicks, then a Back/Forward walk
- a fast double Back
- Back into a Storybook `?sb=` entry, then Forward/Back to Normal and a click
- keyboard-only navigation after Back
- dark and light themes, at 1920×1080 @1

**Setup.** As in R27:
- **Builds:** each was made with `npx vite build`. r4 was built from the worktree. R27 and BASE were built from `git archive`.
- **Server:** a static harness (`/api` and `/ws` return 404, `?demo=` supplies the cast). It also has one stub: `HEAD /api/storybook/*` returns 200, so the project ⋯ menu offers "Open Storybook".
- **Driving:** Playwright (headless Chromium), with the R24 init script that logs every `pushState`/`replaceState`/`back`/`go` and every `popstate`.
- **Errors and edits:** 0 page errors in every run. No source edits.

Scripts are in `docs/ux-review-r28/drive/`:
- `stuck.mjs`, `stuck2.mjs`, `trail3.mjs` and `edge.mjs` are copied unchanged from R27.
- `r4.mjs` is new. It covers double Back, the Storybook round trip and keyboard navigation.
- `fwdmixed.mjs` is new. It is the minimal repro for M1. Modes: `go2`, `pw2`, `slow2`, `gapN`.
- `sbkbd.mjs` is new. It covers Back into `?sb=`, Ctrl+J and Ctrl+K after Back.

Logs are `docs/ux-review-r28/<script>-<theme>-1920.log`, plus `fwdmixed-compare-dark-1920.log`, `sbkbd-compare-dark-1920.log` and `gap-sweep-dark-1920.log` (ports 5928 = r4, 5929 = R27, 5930 = BASE).

Screenshots: the logs record the original step names, and the kept PNGs were renamed so they have no parentheses. For example, the log's `fwd2(efi?)` is the file `*-fm-fwd2-efi.png`.

**Summary.** Everything R27 passed still passes, and so do the new keyboard and Storybook flows. Dark and light logs are line-for-line identical.

There is one new major, a Back trap. It is r4-only: R27 handles the same sequence correctly. The trigger is a Forward or Back that lands on a mixed `team=<A>&agent=<x>` entry while the screen already shows `x`'s chat. r4 ends the pop as soon as the URL equals the popped URL. Here that happens on the stale first render, before the heal. The heal then **pushes**, which drops Forward. From then on, every Back lands on the same mixed entry and pushes again, so Back can never get past that point in the session.

The trap is reached when:
- the mixed entry is skipped by a multi-step jump: `history.go(-2)`, or Chrome's long-press / right-click Back menu
- two pops arrive in one task (`gap0`)

Two separate Back presses ≥16 ms apart do not trigger it (`gap-sweep-dark-1920.log`).

## Status vs R27

| Item | R27 | Now (r4 `bd7b1865`) | Evidence |
|---|---|---|---|
| R24 stuck2 trail: Back onto a mixed entry, then 3 clicks push, then the Back/Forward walk | pass | **Pass.** The logs match R27 byte-for-byte: `back(mixed)` replaces in place, `1-review` / `2-proj-efi` / `3-gemini` push (`len` 5→5→7→9), Back×3 and Forward×3 walk in order, and `fwd-4` does nothing. The worker's `artifacts/desk-b1-r4/stuck2-dark-1920.log` agrees. | `stuck2-*.log`, `trail3-*.log`, `dark-1920-trail-back-3.png`, `*-trail-fwd-3.png` |
| Stuck project-row variant, then Ctrl+K "UI BOIS" | pass | **Pass**, identical to R27 | `stuck-*.log` |
| Edge: Back onto a gone team or an unknown agent, then a click; a click in the same tick as Back, or 50 ms after it | pass | **Pass**, identical to R27 | `edge-*.log`, `dark-1920-edge-A-click.png` |
| Fast double Back (2 separate presses, any gap ≥16 ms) | pass (f6) | **Pass.** It lands on the entry two back. Forward walks back to the tip. | `gap-sweep-dark-1920.log` gap16…gap200, `fwdmixed-*.log` slow2 |
| Fast double Back, then Forward onto the skipped mixed entry (`go(-2)` or 2 pops in one task) | not run | **✗ Back trap → M1.** Forward pushes, and every later Back re-pushes. R27 passes the same steps. | `fwdmixed-*.log` go2, gap-sweep gap0, `*-go2-fm-*.png`, `fwdmixed-compare-dark-1920.log` |
| 2 pops batched before React renders (two Playwright `goBack()` with no gap) | not run | **✗, pre-existing → m1.** Lands on VibeSquad Overview instead of the Audit chat and pushes. R27 and BASE do the same. | `fwdmixed-*.log` pw2, `dark-1920-pw2-fm-back2x.png`, `fwdmixed-compare-dark-1920.log` |
| Storybook: open (`?sb=` pushed), Back to Normal, Forward into `?sb=`, Back to Normal, then click | not run | **Pass.** Forward re-opens Storybook. After Back, the click pushes and Forward is dropped. A palette nav from inside Storybook replaces the `?sb=` entry in place (by design, `StorybookView.tsx:45`). | `r4-*.log` F-*, `sbkbd-*.log` 1–17, `dark-1920-r4-F-fwd-sb.png`, `dark-1920-sk-21-click-push.png` |
| Back into a `?sb=` entry left behind the current screen | not run | **✗, pre-existing → m2.** The URL is stripped in place and Storybook does not open. R27 and BASE do the same. | `sbkbd-*.log` 19, `dark-1920-sk-19-back-into-sb.png`, `sbkbd-compare-dark-1920.log` |
| Keyboard-only navigation after Back (Ctrl+J, Ctrl+K) | not run | **Pass.** Both push, Forward is dropped and Back returns. On BASE, Ctrl+J after Back leaves `?team=vibesquad` over the Audit chat (`inv=false`), so r4 fixes that. | `sbkbd-*.log` 28–36, `*-sk-29-ctrlj-push.png`, `sbkbd-compare-dark-1920.log` |
| One `.on` row; breadcrumb = URL = screen | pass | **Pass** at every step of every run, except the M1 trap steps, where the screen matches the URL but not the history entry. | all logs `inv=true` |
| R24-m1 / idea-895: the Overview sub-tab is not in the URL | minor | Still open, not B1's, already queued. Not re-raised or counted. | n/a |

## Findings

### Critical
None.

### Major

#### M1 · Forward or Back onto a mixed entry that shows the same agent pushes, and Back is then trapped for the session (new in r4)
- **Job hurt:** 2 (follow the work across projects). Back/Forward must walk the trail, and B1's own rule is no push during a pop.
- **Repro** (`drive/fwdmixed.mjs go2`; dark and light identical):
  1. Open the Audit chat.
  2. Click the Main Game Project row. This pushes `efi&agent=demo-aud` (the B2 mixed entry) and then `efi`.
  3. Run `history.go(-2)` (Chrome's long-press Back menu does the same). This lands on the Audit chat and leaves the mixed entry unhealed.
  4. Press Forward. Log: `POP ?team=efi&agent=demo-aud | pushState ?team=vibesquad&agent=demo-aud`, with `len` flat at 5. The push wipes the `efi` Overview entry, so the next Forward does nothing (`dark-1920-go2-fm-fwd2-efi.png` still shows the Audit chat).
  5. Press Back ×3. Each one logs `POP ?team=efi&agent=demo-aud | pushState ?team=vibesquad&agent=demo-aud`, and the screen never changes.
- **Other triggers:** the same happens with two `history.back()` calls in one task (`gap0`). The first exploratory run hit it too (`r4-*.log` `E-fwd1`), after `history.back(); history.back()`.
- **R27 vs r4:** R27 (`577b6171`) runs the identical steps correctly. `fwd1` replaces, `fwd2` reaches `efi`, and Back walks on (`fwdmixed-compare-dark-1920.log`).
- **Cause:**
  1. `src/App.tsx:1672` sets `popTarget = "?…team=efi&agent=demo-aud"`.
  2. The stale first render after `setTeamId("efi")` (`src/App.tsx:1679`) still has `urlAgentId = demo-aud`. So `next` equals `popTarget` exactly.
  3. `src/urlSync.ts:14` returns `endPop: true`, and `src/App.tsx:1872` clears `popTarget`.
  4. BoringAde then re-derives the agent's real team (vibesquad), and the sync now sees `popTarget === null` and **pushes**.

  The pop "reached" a URL that is never the settled screen. R27 avoided this by ending on BoringAde's settle, not on URL equality. That is the reason given in R27's `urlSync.ts` header comment.
- **Fix (lean):** don't end the pop on `next === popTarget`. Keep the in-place restore, but let the first real input be the only end. Every write while armed is a replace, so a lingering arm is harmless. Alternatively, compare against the healed (canonical) form of `popTarget`. Add an e2e test to `test/desk-nav-history-e2e.test.mjs`: `go(-2)` over a mixed entry, then Forward ×2 reaches the tip, then Back ×3 walks.
- **Files:** `src/urlSync.ts`, `src/App.tsx`, `test/desk-nav-history*.test.mjs` · **Effort:** S

### Minor

#### m1 · Two pops batched before a render land on the wrong screen and push (pre-existing; also on R27 and BASE)
- **Evidence:** `fwdmixed pw2` runs two `goBack()` calls with no gap, and both POPs arrive before a render. It ends on VibeSquad Overview, which is not the Audit chat the history now points at, then `pushState ?team=vibesquad`, and Forward is gone (`dark-1920-pw2-fm-back2x.png`). R27 and BASE behave the same.
- **Severity:** separate human presses ≥16 ms apart are fine (gap sweep), so this needs sub-frame input. Minor. It is still a push during a pop and falls in B1's area, so it's worth fixing alongside M1. The M1 fix (no URL-equality end) may cover it, so retest.
- **Files:** `src/App.tsx` (pop handling), `src/BoringAde.tsx` (navGen re-derive) · **Effort:** S

#### m2 · Back into a `?sb=` entry doesn't reopen Storybook (pre-existing; also on R27 and BASE)
- **Evidence:** with a real `?sb=` entry behind the current chat, Back logs `POP …&sb=vibesquad | replaceState …` without `sb`, and Normal stays on screen (`sbkbd` step 19, `dark-1920-sk-19-back-into-sb.png`). Forward into an `?sb=` entry that Storybook pushed itself does reopen it (`r4` F-fwd-sb).
- **Severity:** in normal use this entry is hard to reach, because a nav out of Storybook replaces the `?sb=` entry in place. Minor, not charged to B1.
- **Files:** `src/StorybookView.tsx` (popstate listener vs App's URL sync dropping `sb`) · **Effort:** XS–S

## Known, deferred to B2 (unchanged from R27; not findings)
- Mixed-entry creation (`team=<new>&agent=<prev>`) and the one dead Back press it causes.
- The `team=<new>` → `team=<new>&agent=<x>` double push from a cross-project Needs-you click. M1 is reachable only because that mixed entry exists, so B2's coalescing would also remove its trigger. B1 should still not push during a pop.

## Owner decisions
- None.

## Inbox cards (for the lead to file)
- @desk B1: M1. Drop the URL-equality pop end (`src/urlSync.ts:14`). Add a `go(-2)` + Forward e2e test. Retest m1 with the same change.
- @desk: m2. Back into `?sb=` should reopen Storybook. Low priority, pre-existing.

**Verdict: FAIL 0/1/2**
