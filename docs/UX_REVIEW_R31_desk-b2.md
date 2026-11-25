# VibeSquad UX review, round 31: @desk B2, one history entry per navigation

Date: 2026-11-25 · Build: `desk-b2-one-entry` @ `86775348` · Compared against: B1 merge `a7fcb75b` (built from `git archive`, same harness) · Previous round: `docs/UX_REVIEW_R29.md` (B1, PASS 0/0/2) · Spec: `docs/PLAN_DESK_NAV_HISTORY.md` B2 done-check (line 29).

Round number: R30 is taken on `unit-bor-b16-composer` (`docs/UX_REVIEW_R30_BOR_B16.md`). R31 is unused on this branch, on `origin/master` and on every local or remote branch (`git for-each-ref` sweep).

**Verdict: PASS 0/0/1**

**Scope.** B2 changes one thing. App's URL-sync effect now reads the agent that BoringApp has on screen live, at effect time (`urlSyncAgent`, `src/urlSync.ts:28-31`; call site `src/App.tsx:1878-1880`). Before, it used the render-time value. The goal is that a cross-project navigation lands as one push, with no interim `team=<new>&agent=<prev>` entry.

**Setup.**
- **Builds:** `npx vite build` for both builds. `86775348` was built from this worktree (HEAD checked before and after the build). `a7fcb75b` was built from a `git archive` export. No checkout, no source edits.
- **Server:** a static harness, the same shape as R28/R29: `/api` and `/ws` return 404, `HEAD /api/storybook/*` returns 200, and `?demo=` supplies the cast (`docs/ux-review-r31/drive/serve.mjs`).
- **Logging:** an init script logs every `pushState`, `replaceState`, `back`, `go` and `POP` (R29 `lib.mjs`).
- **Errors:** 0 page errors in every run.
- **Independent driver:** I wrote `docs/ux-review-r31/drive/b2.mjs` myself and did not run the worker's `artifacts/desk-b2/drive/measure.mjs`. It differs from theirs in three ways:
  - It reaches the starting chat by a user click from the project Overview, so Back #2 has a real entry to land on.
  - It runs both directions: VibeSquad → Main Game Project, and Main Game Project → VibeSquad / Site.
  - It adds the project-row badge pill, the Desk mate tiles, a Forward ×2 walk, and a reload of every visited URL.

## Status vs R29 / B2 done-check

| Check | Before (`a7fcb75b`) | Now (`86775348`) | Evidence |
|---|---|---|---|
| **Ctrl+K agent pick across projects** | +2 entries, mixed `?team=efi&agent=demo-aud`, dead Back #2 | **Pass.** `dLen=1`, one push of the final URL, no mixed entry. Back returns to the Audit chat. Back #2 reaches the VibeSquad Overview (live). Forward ×2 mirrors both steps. Reload of start, final and Back #2 URLs matches the screen. | `logs/b2-{dark,light}-1920-{fwd,rev}.log` `ctrlk`; `dark/light-1920-b2-fwd-ctrlk-after.png` |
| **Needs-you row** | +2, mixed | **Pass**, same as above, both directions | `needs-row` lines; `dark-1920-b2-rev-needs-row-after.png` |
| **Needs-you pill** (project-row badge) | +2, mixed (see row below) | **Pass.** One push of `?team=<B>`. The Back/Forward walk is intact. | `proj-badge(pill)` lines |
| **Sidebar row** (lane row in project B; worker row in reverse) | +2, mixed | **Pass** | `sidebar-row` lines |
| **Project row** | +2, mixed | **Pass.** One push. Back returns to the chat, using only the known replace-only transient writes. | `proj-row` lines; `light-1920-b2-fwd-proj-row-after.png` |
| Desk mate tile with no agent (efi Overlord) | 2 pushes (`efi&agent=demo-aud`, then `efi`) | **1 push.** B2 fixed the push count. Forward and reload still land on the Overview → **m1**, pre-existing | `logs/mate-base-a7fcb75b.log` vs `logs/mate-b2.log` |
| 3200×1800 @1.2 (owner's 4K) | n/a | **Pass**, same as 1920 | `logs/b2-dark-3200-fwd.log`, `dark-3200-b2-fwd-needs-row-after.png` |
| Dark vs light | n/a | Identical logs, apart from the theme name | `diff` of all b2 and r29 rerun logs |
| One `.on` row; breadcrumb = URL = screen | pass | **Pass** at every step (`inv` true in every b2 run) | all logs |

The worker's numbers in `artifacts/desk-b2/after-b2.txt` (a–d: `dLen=+1`, `mixed=[]`, Back #2 live) match mine for the four required routes in both themes. The project-row Back trace is identical too: `POP efi→vs&agent=demo-aud | replace ?team=vibesquad | replace …agent=demo-aud`.

## R29 trail re-runs (B1 regression check)

I ran all 12 R29 scripts (stuck, stuck2, trail3, edge, r4, sbkbd, fwdmixed go2/pw2/slow2/gap0, noinput, matrix) on both builds, in dark and light at 1920. Logs are in `logs/r29-rerun-{b2,base}/`.

- **`sbkbd` (Storybook + keyboard):** byte-identical to base.
- **Every other script:** the only differences come from the missing mixed entries.
  - `len` is 1–3 lower.
  - Steps that used to push twice now push once.
  - The R29 "dead press on the healed mixed entry" no longer happens.
    - `trail3`: Back ×3 now walks Gemini → efi Overview → Review → Audit. Before, it went VibeSquad Overview → efi → Review. Forward ×3 mirrors it, and `fwd-4` does nothing.
    - `stuck`: `back2` now reaches the VibeSquad Overview instead of a second press on Audit.
    - `noinput` step 9: lands on Audit. Base showed Review again.
- **No regressions:**
  - No new `pushState` during any pop.
  - Forward survives in every script.
  - 15 minutes of no input and a pref change from another tab still make 0 history writes (`noinput` 5–6).
  - Ctrl+J/Ctrl+K after Back still push (`sbkbd` 28–36).
- **`fwdmixed back-c` leaves the app** (`url=""`). This is expected. The script assumed the extra mixed entry, so its third Back now goes past the first app entry to `about:blank`, which is correct history.
- **`edge plant-unk` crumb.** The crumb shows the previous project because the script calls `pushState` directly, and the app does not observe that. It's a test artifact; no user can reach it.

Not re-raised: idea-895, idea-971, idea-983. Also not re-raised: the replace-only transient URLs while a Back settles (B1, which never pushes).

## Findings

### Critical
None.

### Major
None.

### Minor

#### m1 · An empty Desk slot ("No Overlord is running…") has no URL of its own, so Forward and reload show the Overview instead (pre-existing)
- **Job hurt:** 5, Intervene (start the project's Overlord). Back/Forward lands on a different screen than the one the user left.
- **Evidence:**
  1. From the Audit chat, expand Main Game Project and click its `★ Overlord · no agent` tile. The screen shows `Main Game Project › Desk › Overlord` with the "Start Overlord" card, and the URL is `?demo=&team=efi` (`dark-1920-empty-overlord-slot.png`).
  2. Back, then Forward: the screen is the Main Game Project Overview, not the Overlord card. Reloading `?team=efi` also gives the Overview (`logs/b2-*-fwd.log` `sidebar-mate`).
  3. On `a7fcb75b` the URL was the same, plus an extra mixed push (`logs/mate-base-a7fcb75b.log`). So this is pre-existing, and B2 made it better.
- **Cause:** the empty-slot screens (`emptyKind` overlord, riffbot, lead, brainstorm; `src/BoringAde.tsx:682-691`) are BoringAde local state. `serializeUrlState` (`src/CommandPalette.tsx:41-47`) writes only `team`, `agent` and `view`, so an empty slot and the Overview share one URL. That also breaks the "one selected row = URL = screen" rule for that entry.
- **Fix:** give empty slots a URL key, e.g. `?team=efi&slot=overlord` (or `lane=<id>&role=lead`), and have the B1 pop landing restore it. The cheaper alternative is to not push for an empty-slot open: replace instead, so Forward never promises a screen it can't rebuild.
- **Files:** `src/CommandPalette.tsx` (serialize/parse), `src/BoringAde.tsx` (pop landing), `src/App.tsx` URL sync.
- **Effort:** S.
- **Lane:** @desk (Normal routing, SPEC R2 #4).

## Owner decisions
None.

## Artifacts
- **Drivers:** `docs/ux-review-r31/drive/`. Run `node serve.mjs <dist> <port>`, then `node b2.mjs <port> <w> <h> <zoom> <theme> fwd|rev [shotdir]`, and `runall.sh <port> <out>` for the R29 scripts, which come from `docs/ux-review-r29/drive/`.
- **Logs:** `docs/ux-review-r31/logs/`.
- **Screenshots:** `docs/ux-review-r31/*.png`.

**Verdict: PASS 0/0/1**
