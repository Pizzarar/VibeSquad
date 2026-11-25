# VibeSquad UX review, round 26c: Crunch toggle r2 re-check (PLAN_CRUNCH_MODE C3 r2)

Date: 2026-11-25 · Build: `unit-ui-crunch-toggle` @ `19277594` · Baseline: `/tmp/ux-c3r2/docs/UX_REVIEW_R26b.md` (FAIL 0/1/2 @ `1b6f4f08`).

**Setup.** Same as R26b. `npx vite --port 5439 --strictPort` from the unit worktree, `?demo&team=…`, Playwright/Chromium. `**/api/storybook/**` stub (vibesquad 200, else 404). All non-GET `/api/teams` + `/__vibesquad/teams` go to a stateful stub (delay / 503 switchable). Nothing reached the registry. Viewports: 1920×1080, phone 390×844 @dpr3 (touch), dark + light; 3200×1800 @1.2 for the pill shots. 0 page errors. No source edits, no git writes; vite stopped afterwards. Drivers: `/tmp/ux-c3r3/drv/*.mjs`. Shots: `docs/ux-review-r26c/` (montages `m-palette.png`, `m-pill.png`, `m-phone.png`).

Scope: the r2 fixes only (R26b M1, m1, m2, n1, n2).

**Verdict at `19277594`: PASS 0/0/1** (+2 nits carried). M1, m1 and m2 are fixed. One new minor finding: partial-name queries rank another Squad above the current one. The two phone nits are still open: the CSS added for them loses to the Normal `.btn` reset.

## Status vs R26b

| R26b item | R26c | Evidence |
|---|---|---|
| **M1** Ctrl+K "crunch" + Enter flips the first Squad | **Fixed** | On VibeSquad, `crunch` lists only `Turn Crunch on · VibeSquad` (selected) + `Settings: Crunch mode`. Enter = 1 write, VibeSquad pill → `aria-pressed=true`. Reopening shows `Turn Crunch off · VibeSquad` (`1080d-pal-vs.png`, `1080d-pal-vs-on.png`). `crunch escape` shows only `Turn Crunch on · Escape From Idle`; Enter flips efi and leaves VibeSquad alone (`1080d-pal-other.png`). From an agent page (`&agent=demo-bs-vs`) and from the Storybook view (`&sb=vibesquad`) the only Crunch row is VibeSquad, and Enter makes 1 write to it (`1080l-pal-agent.png`, `1080d-pal-sb.png`). The label now reads as an action. |
| M1: "no current Squad → nothing unless named" | **Not reachable in UI; unit-tested** | `src/App.tsx:1654-1655`: `view` falls back to `sidebarViews[0]`, so the current Squad is only null with zero Squads. `?team=hub` and `?demo` with no team resolve to a Squad, and the breadcrumb, pill and palette all name the same one (EFI / VibeSquad). So palette target = breadcrumb holds. The null branch is covered by `test/crunch-palette.test.mjs:29-30`. |
| M1: `crunch efi` | **Shows nothing** | Matching is on display name only, so `efi` (the id / initials) matches no Squad. See **m1**. |
| **m1** Settings search "Open →" lands on the first Squad | **Fixed** | On VibeSquad, the VibeSquad checkbox is in view at y=512 with the anchor. On efi, the efi checkbox is at y=479. Both 1080 themes; phone lands on VibeSquad at y=468 (`1080d/1080l-search-open.png`, `phd/phl-search-open.png`). The checkbox doesn't get focus (optional; not charged). |
| **m2** sb-head pill 14px vs topbar 13px | **Fixed** | `tabsTop` and `tabsSb` are both 13px/400 at 1080 and 4K, dark and light (`m-pill.png`). |
| n1 "Save failed" red hidden while hovered | **Fixed** | With the pointer still on the pill: dark `rgb(255,127,147)`, light `rgb(185,38,78)`, the same as after the pointer leaves (6.9:1 / 5.3:1) (`4kd/4kl-fail-hover.png`). Timeline unchanged: on 250 ms → Save failed 1.3–4.5 s → off 6.5 s. |
| n2a phone failure label not in error colour | **Still open** | "Couldn't save · try again" is computed `rgb(243,241,247)` dark / `rgb(29,26,36)` light, i.e. `--text` (`phd-drawer-fail.png`). See n1 below. |
| n2b phone on vs tap-highlight look the same | **Still open** | `on`: bg `rgb(38,38,50)`, border `rgb(155,114,232)`, box-shadow `none`. Off after tapping back: **identical** bg/border, box-shadow `none`. Light is the same pattern (`rgb(230,227,221)` / `rgb(154,127,224)`). Only the word on/off differs (`m-phone.png`, rows 2 vs 3 and 5 vs 6). |
| 4K pill | OK | Off 80×28 12px/400, 9.4:1 dark / 7.9:1 light; on: lilac fill + ring (`4kd-off.png`, `4kd-on.png`). |
| Write count | OK | 1 write per click, tap or palette Enter on every surface. |

## Findings

### Critical
None.

### Major
None.

### Minor

- **m1 · Partial or short-code Crunch queries put another Squad first, and `crunch efi` finds nothing.**
  - **Job hurt:** "turn Crunch on for project X from the keyboard". This is the fallback R26b asked for, and it works with full names, but it's brittle mid-typing.
  - **Evidence:** on VibeSquad (`1080d-pal-partial.png`, `pal3.mjs`):
    - `crunch e` → `*Turn Crunch on · Escape From Idle` (selected), VibeSquad 2nd, then <site Squad>, Squadz Meet, SportsBallBattles. `crunch s` gives the same list.
    - So typing `crunch s…` toward "Squadz" and pressing Enter early flips **Escape From Idle**.
    - `crunch on` / `turn crunch on` also list RedFrontier, because the token "on" is used as a name filter.
    - `crunch efi` / `efi crunch` → no Crunch row at all.
    - Bare `crunch` is safe: the current Squad only.
  - **Cause:** `src/crunchMode.ts:39-42`.
    - Any non-"crunch" token of 1+ chars substring-matches `s.name`.
    - Results keep sidebar order with no current-first sort.
    - Words like turn/on/off count as name tokens.
    - The Squad id isn't matched.
  - **Fix:**
    - Sort the current Squad first.
    - Drop `turn|on|off|mode` tokens.
    - Match word-prefix (≥2 chars) on name, plus exact id/initials (`efi`).
    - Extend `test/crunch-palette.test.mjs`.
  - **Files:** `src/crunchMode.ts`, `test/crunch-palette.test.mjs` · **Effort:** XS

### Nits

- **n1 (carried from R26b n2) · The phone failure colour and on-edge added in r2 never apply in Normal.**
  - **Cause:** in Normal, `html[data-vibe="boring"] .btn` (specificity 0,2,1) beats both new `.phone-crunch-btn…` rules (0,2,0):
    - `src/boring.css:67` sets `color: var(--text)`. It overrides `src/styles.css:5936` `[data-failed] { color: var(--st-err) }`.
    - `src/boring.css:37,48` sets `box-shadow: none`. It overrides the inset bar at `src/styles.css:5935`.
  - **Result:** the failure text is plain `--text`. The on state looks the same as the sticky hover/tap state after you tap it off.
  - **Fix:** move both rules into `boring.css` under `html[data-vibe="boring"] .phone-crunch-btn.on` / `[data-failed]`, or raise their specificity. Also stop the hover fill from looking like on (e.g. `@media (hover:hover)` for the hover bg). Add the Squad name to the failed label if it fits.
  - **Effort:** XS.
- **n2 · Settings "Open →" scrolls to the right checkbox but doesn't focus it.** Keyboard users then Tab from the top of the modal. Optional `focus()` on the anchored input. XS.

## Owner decisions
None new. R26b's palette-scope recommendation, (a) current Squad only with a named-Squad fallback, is what shipped. m1 only tightens the fallback.

## Inbox cards (for @ui-bois)
1. m1: Crunch palette matching (current first, ignore turn/on/off, prefix ≥2 chars, id/initials) (`src/crunchMode.ts:39-42`). XS.
2. n1: phone Crunch on/failed rules lose to `html[data-vibe=boring] .btn` (`src/styles.css:5935-5936` vs `src/boring.css:37-48,67`). XS.
3. n2: focus the Crunch checkbox after Settings "Open →" (`src/TeamSettingsModal.tsx:881`). XS.
