# VibeSquad UX review, round 26b: Crunch toggle r1 re-check (PLAN_CRUNCH_MODE C3 r1)

Date: 2026-11-25 · Build: `unit-ui-crunch-toggle` @ `1b6f4f08` · Baseline: `/tmp/ux-c3/docs/UX_REVIEW_R26.md` (PASS 0/0/3 @ `45a4a533`).

**Setup.** Ran `npx vite --port 5438 --strictPort` from the unit worktree with `?demo&team=vibesquad`, driven by Playwright (Chromium). Stubs:
- `**/api/storybook/**` answers `vibesquad` and sends 404 for everything else, the same as R26.
- Every non-GET to `/api/teams` and `/__vibesquad/teams` goes to a **stateful stub**: it keeps the last body and serves it back on the following GETs. It can also add a delay or return a 503. Nothing reached the real registry file.

Viewports: 3200×1800 @ dpr 1.2, 1920×1080, and phone 390×844 @ dpr 3 (isMobile, touch). Each ran in dark and light. There were 0 page errors; the only console errors were the stubbed 404/503s. No source edits and no git writes. Vite was stopped afterwards. Shots are in `docs/ux-review-r26b/`, with montages `m-pill.png` and `m-phone.png`.

Scope: only the r1 changes (R26 m1/m2/m3/n1, busy state, failed save). Nothing else was re-driven.

**Verdict at `1b6f4f08`: FAIL 0/1/2** (plus 2 nits). The four R26 items are fixed or mostly fixed, and busy/rollback behave well. But the new **Ctrl+K Crunch command flips the wrong Squad** when you press Enter on "crunch".

## Status vs R26

| R26 item | R26b | Evidence |
|---|---|---|
| m1: off pill reads like an action button | **Fixed** | Label is "Crunch off" / "Crunch on". Off uses the `--muted` label colour: dark `rgb(195,192,207)` 9.4:1, light `rgb(74,69,88)` 7.9:1. On keeps the lilac fill and accent ring. Both are readable at a glance next to Search/Shortcuts (`m-pill.png`, rows 1–3). |
| m2: phone path is 5 steps; search and palette can't find it | **Fixed, with 2 new issues** | The phone ⋯ drawer has a "Crunch mode off · VibeSquad" row: 44px tall, 318px wide, at y=293, the 2nd action row with no scroll needed. Tapping it flips the setting (1 write) and the drawer stays open (`m-phone.png`). Settings search for `crunch` returns "Crunch mode (per-Squad auto-pilot) · Team · Open →" on desktop and phone. Ctrl+K has Crunch commands. **But** the palette's top hit is the wrong Squad (**M1**), and "Open →" scrolls to the wrong Squad's checkbox (**m1**). |
| m3: sb-head pill weight 600 vs topbar 400 | **Weight fixed, size regressed** | Both are weight 400 now. But the sb-head pill went from 13px to **14px**, while the topbar stays 13px. All 4 runs show this; it's visible side by side in `m-pill.png` (`1080l-tabs-top` vs `1080l-tabs-sb`). See **m2**. |
| n1: pill shifts when an agent opens | **Fixed** | The pill is now the last item in the row. Opening an agent adds Split and Details to its left, and the pill doesn't move: 4K x=3106 → 3106, 1080 x=1826 → 1826. The only movement is ±2px from the width change between "off" (80px) and "on" (78px). |
| n1 tail: on-cue colour differs from project-tab `.on` | Unchanged | Both readable, not re-charged. |

## r1 behaviour checks

| Check | Result | Evidence |
|---|---|---|
| Busy while saving (3 s delayed write) | **Pass** | The pill shows the target state straight away and sets `disabled` + `aria-busy=true` with `cursor: progress`. Opacity stays 1 and the colour doesn't change. It looks like a normal pill, not a broken one (`1080d-busy.png`). A second forced click while busy made 0 extra writes. Phone: the row goes `--muted` with a dashed focus ring and stays legible (`phd-drawer-busy.png`). |
| Failed save (503 on both endpoints) | **Pass** | Timeline: optimistic "Crunch on" at 250 ms, then "Save failed" at 1.3 s with `aria-pressed=false` (rolled back to the disk state) and the tooltip "Couldn't save Crunch mode, try again.", then "Crunch off" again at 6.5 s. Red `--st-err` label: dark 6.9:1, light 5.3:1 (`4kd/4kl-fail-away.png`). The pill width only goes 80 → 82px. Phone: "Couldn't save · try again", then back to "Crunch mode off · VibeSquad" (`phd-drawer-fail.png`). See n1/n2 for polish. |
| Write count | **Pass** | 1 write per click or tap, on every surface. |

## Findings

### Critical
None.

### Major

- **M1 · In Ctrl+K, "crunch" + Enter flips Crunch for the first Squad in the list, not the one you're in.**
  - **Job hurt:** "turn Crunch on for this squad, from the keyboard". This is the most natural keyboard path, and it silently writes a squad-wide autonomy policy (plus the C2 wake wave) to a *different* project.
  - **Evidence:** I was on `?team=vibesquad` and typed `crunch`. The list came back as:
    - `*Crunch mode: on (Escape From Idle)` (selected)
    - `Crunch mode: on (VibeSquad)`
    - `… (<site Squad>)`, `… (Squadz Meet)`, and the other Squads, 8+ rows in all

    After Enter there was 1 write. VibeSquad stayed `aria-pressed=false`, and `?team=efi` now showed **true** (`1080d-palette.png`, `pal.mjs` output). There was no confirmation or toast to say which Squad changed. The label "Crunch mode: on (X)" also reads as a *state* ("it's on") when it really means "turn on".
  - **Cause:**
    - `src/CommandPalette.tsx:650-653` builds one command per `props.views`, in sidebar order, with no ranking for the current Squad.
    - `src/CommandPalette.tsx:715-717` runs `setCrunchMode` for whichever row is selected.
  - **Fix:**
    - Put the current Squad's command first. Better still, list only the current Squad unless the query names another one (e.g. "crunch efi").
    - Word it as an action that also shows the current state, e.g. "Turn Crunch on · VibeSquad (now off)".
    - After it runs, show a one-line toast naming the Squad.
  - **Files:** `src/CommandPalette.tsx` · **Effort:** S

### Minor

- **m1 · Settings search "Open →" lands on the first Squad's Crunch checkbox, not the current Squad's.**
  - **Job hurt:** finding the setting for the squad I'm in, especially on phone, which was the point of R26 m2(b).
  - **Evidence:** I was on VibeSquad. After "Open →", the Escape From Idle checkbox (efi) is in view at y=468–479. VibeSquad's checkbox is about 1,184 px further down on desktop and about 1,264 px on phone, and nothing is focused (`1080d-search-open.png`, `phd-search-open.png`). Each block is headed by its Squad name, and you still have to Save, so it's less risky than M1. But it's the same wrong-squad trap.
  - **Cause:** `src/TeamSettingsModal.tsx:878` sets `data-setting-id={i === 0 ? "crunch-mode" : undefined}`.
  - **Fix:** anchor on the current Squad's block, which means passing the active team id into the modal, and fall back to `i === 0`. Optionally focus that checkbox.
  - **Files:** `src/TeamSettingsModal.tsx` (+ caller) · **Effort:** S

- **m2 · The sb-head Code|Storybook pill is now 14px; the topbar's is 13px.**
  - **Job hurt:** "same control, same look" across the two headers, the rest of R26 m3. This is a regression the r1 fix introduced.
  - **Evidence:**
    - `tabsTop` is 13px/400 and `tabsSb` is 14px/400 in all 4 desktop runs.
    - R26 had 13px for both.
    - Visible in `m-pill.png` (`4kd-tabs-top` vs `4kd-tabs-sb`).
  - **Cause:** `src/storybook.css:36-37`. r1 moved `font: inherit; font-size: 13px` into the Psycho-only rule along with the weight, so Normal now inherits the sb-head's 14px.
  - **Fix:** keep `font-size: 13px` (and `font: inherit`) in the shared rule on line 36. Move only `font-weight: 600` behind `html:not([data-vibe="boring"])`.
  - **Files:** `src/storybook.css` · **Effort:** XS

### Nits

- **n1 · The red "Save failed" colour doesn't show while the pointer is still on the pill,** which it always is right after a click. The text says "Save failed" in `--text`, and it only turns red once the mouse leaves (`4kd-fail-hover.png` vs `4kd-fail-away.png`).
  - **Cause:** the hover rule at `src/boring.css:1457` has higher specificity than `[data-failed]` at `:1459`, because of `:hover:not(:disabled)`.
  - **Fix:** add `:not([data-failed])` to the hover rule.
  - Effort XS.
- **n2 · On phone, the "on" fill looks the same as the tap-focus fill.** Once you tap the row back to off, it still has the raised fill and accent border until focus moves elsewhere. Only the text ("off") tells you the state (`phd-drawer-on.png` vs `phd-drawer-fail.png`, and the `afterBusy` metrics).
  - The failure label "Couldn't save · try again" is also plain `--text`, with no error colour and no Squad name.
  - **Cause:** `src/styles.css:5935-5936`. `.on` uses the `--cyan-*` tokens, which in Normal come out as the same surface tint.
  - **Fix:** give "on" a distinct cue, e.g. an accent left bar or a "●" glyph. Add an error colour to the failed row.
  - Effort XS.

## Owner decisions

- **How wide should the palette Crunch command be?** Options:
  - (a) Current Squad only.
  - (b) Current Squad first, others below.
  - (c) All Squads, as shipped.

  **Recommendation: (a)** with a fallback where typing another Squad's name surfaces that Squad. Crunch is a per-Squad autonomy switch with no confirmation, so the default Enter should never be able to reach a project you aren't looking at.

## Inbox cards (for @ui-bois)

1. M1: palette Crunch command targets the first Squad (`src/CommandPalette.tsx:650-653,715-717`). S.
2. m1: Settings search anchor → current Squad (`src/TeamSettingsModal.tsx:878`). S.
3. m2: sb-head pill font-size 13px (`src/storybook.css:36-37`). XS.
4. n1+n2: failed-state hover colour; phone on-cue and failed colour (`src/boring.css:1457`, `src/styles.css:5935`). XS.
