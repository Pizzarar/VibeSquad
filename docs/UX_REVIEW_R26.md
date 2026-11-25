# VibeSquad UX review, round 26: Crunch mode toggle (PLAN_CRUNCH_MODE C3)

Date: 2026-11-25 · Build: `unit-ui-crunch-toggle` @ `45a4a533` · Baseline: `docs/UX_REVIEW_R23.md` (PASS 0/0/2 @ `b79f011d`).

**Setup.** `npx vite --port 5437` from the unit worktree, with `?demo`. Playwright (Chromium) stubs `**/api/storybook/**` (it answers `vibesquad` and sends 404 for everything else). It also stubs **every non-GET to `/api/teams` and `/__vibesquad/teams`**, so no toggle reached the worktree's registry file. Vibe was forced through `vs.prefs.v1` (`app.vibe` boring/fun) plus `vs.vibeMigratedNormal=1`. Psycho runs also set `vibesquad.squadFullView=1`, because the chip only mounts there (see "Not charged"). Viewports: 3200×1800 @ dpr 1.2, then 1920×1080 and 1280×720, plus phone 390×844 @ dpr 3 (isMobile, touch). Each ran in dark and light. There were 0 page errors in every run, no source edits and no git writes. Vite was stopped afterwards. Shots are in `docs/ux-review-r26/`.

**Verdict at `45a4a533`: PASS 0/0/3** (plus 1 nit). The toggle works and stays in sync on all three surfaces, and both R23 carry-overs are fixed. The three minors are about how legible the off state is, the phone path, and one leftover font-weight mismatch.

## Status vs R23

| R23 item | R26 | Evidence |
|---|---|---|
| N1: light active segment text 3.48:1 | **Fixed** | Light active label is now `--text` `rgb(29,26,36)` on lilac, about 13.8:1, and the accent ring is kept. Dark is unchanged: accent on `#332a4a`, 5.96:1 (`1080-tabs-montage.png`). Rule at `src/boring.css:1451-1452`. |
| L1 (Gemini): sb-head pill ≠ topbar pill in Normal | **Mostly fixed** | Colours, ring, background, 28px height, padding and radius are now identical in both headers, in both themes. The one remaining difference is font weight, 600 in sb-head vs 400 in the topbar: see m3 (`1080-tabs-montage.png`). |
| m2 (R23): phone sb-head truncation | Not re-driven | Out of this unit's scope. |
| Code \| Storybook tabs | **Pass, intact** | Storybook → Code returns to `?demo=&team=vibesquad` at every desktop size. Pill x is 548 (1080) in the topbar and 347 in sb-head, the same as R23. No overflow: scrollWidth equals viewport width at every size. |

## C3 checks

| Check | Result | Evidence |
|---|---|---|
| Pill present, Normal topbar right | **Pass** | `crunch-toggle` is the first item in `.boring-topbar-actions`, before Search and Shortcuts. Positions: x=2945 (4K), 1665 (1080), 1025 (720), all at y≈70, 61×28, 12px. On the agent page Split and Details join the row on the right (see n1). |
| Readable | **Pass** | Off: dark 9.4:1, light 7.9:1. On: `--text` on the accent mix, about 10.8:1 dark and 11:1 light. |
| On/off obvious | **On yes, off weak (m1)** | On has a lilac fill and a 1px accent ring, and reads clearly. Off looks exactly like the Search and Shortcuts action buttons next to it (`1080-pill-montage.png`). |
| Tooltip | **Pass** | "Crunch mode: Lanes act on their leans until there's a tryable build; stops only for deletes, releases, money, outward actions. Click to turn on." The last sentence flips to "turn off" when on. It is clear and uses the owner's own vocabulary. It's a native `title`, so it doesn't show on touch. |
| Pill → Team Settings | **Pass** | 7 runs (4K/1080/720 × d/l). Each pill click makes exactly 1 registry write. Settings › Team › VibeSquad then shows "Crunch mode" checked (`1080d-settings-cb.png`). |
| Team Settings → pill | **Pass** | Uncheck + Save makes 1 write, and the pill drops to `aria-pressed=false` right away and stays off after Esc. Before Save the pill correctly stays on, because the settings form is a draft. While Settings is open the pill is covered by `.modal-back` / `.settings-pane`, so you can't flip it against a stale draft from this window. |
| Per-squad scope | **Pass** | With VibeSquad on, `?team=efi` shows the pill off. |
| Psycho chip | **Pass (both ways)** | Shows "Crunch off" / "Crunch on" and `aria-pressed` flips. When on it gets an accent fill: dark 5.77:1, light 4.96:1 (`ps1080-chip-montage.png`). Chip on → the Settings checkbox is checked. Settings uncheck + Save → the chip reads "Crunch off". Checked at 4K and 1080, dark and light. |
| Phone | **No pill (known). Settings path works but is slow (m2)** | `crunch-toggle` is absent at 390×844. Path: More → ⚙ Settings → Team → scroll about 1,470 px inside a 9,416 px pane to the VibeSquad block → checkbox → Save (Save is sticky) (`phd-settings.png`, `phd-drawer.png`). |

## Findings

### Critical / Major
None.

### Minor

- **m1 · The Normal pill's off state looks like an action button, not a switch that's off.**
  - **Job hurt:** "Is Crunch on for this squad?" at a glance. A plain "Crunch" pill next to "Search" and "Shortcuts" reads as a command ("run crunch") until you hover. One click writes a squad-wide autonomy policy to disk, with no confirmation.
  - **Evidence:** off state `rgb(195,192,207)` on `rgb(29,29,38)`, no ring, the same treatment as Search (`1080-pill-montage.png` rows 1 and 3). The neighbouring toggles do show state in their label ("◫ Split/Unsplit", "⋯/▾ Details"). The Psycho chip of the same control says "Crunch off"/"Crunch on". Normal is the only surface whose label doesn't change.
  - **Cause:** `src/CrunchToggle.tsx:34-36` renders a fixed "Crunch" label for `variant="boring"`.
  - **Fix:** show the state in the text, e.g. "Crunch off" / "Crunch on" to match Psycho, or a leading state glyph ("○ Crunch" / "● Crunch"). Keep the fill and ring for on.
  - **Files:** `src/CrunchToggle.tsx` · **Effort:** XS

- **m2 · On phone, Crunch takes 5 steps and a long scroll, and Settings search can't find it.**
  - **Job hurt:** the owner turns Crunch on while stepping away from the desk, which is a phone moment, and checks it from the couch. Phone shows no state anywhere, and flipping it means More → Settings → Team → scroll about 1.5k px → find the right squad's block → checkbox → Save.
  - **Evidence:** typing `crunch` in the Settings search returns "No settings match “crunch”." (1080 run). The Ctrl+K palette also has no Crunch command. `phd-settings.png` shows the target block reached only after scrolling.
  - **Cause:** there is no `EXTRA_SETTINGS` entry for Crunch (`src/prefs.ts:470-485`). The only Team anchor is `data-setting-id="teams"` on the first team block (`src/TeamSettingsModal.tsx:860`). The phone shell doesn't mount the Normal topbar (`src/PhoneCockpit.tsx`).
  - **Fix:**
    - (a) Add a "Crunch mode · <Squad>" row to the phone ⋯ drawer, next to "Usage · quota & stats" (`src/PhoneCockpit.tsx:391`). Reuse `useCrunchMode`/`setCrunchMode`, show the state in the label, and make it 44px tall.
    - (b) Add `{ id: "crunch-mode", section: "team", label: "Crunch mode", keywords: ["crunch","vibe","autonomy","lean"] }` to `EXTRA_SETTINGS`, with an anchor on the current squad's checkbox.

    (b) also helps desktop.
  - **Files:** `src/PhoneCockpit.tsx`, `src/prefs.ts`, `src/TeamSettingsModal.tsx` · **Effort:** S
  - **Judgement on the known gap:** Team Settings alone is *workable but not enough* for phone. See Owner decisions.

- **m3 · The sb-head pill is still bold (600) while the topbar pill is 400 in Normal (the rest of L1).**
  - **Job hurt:** "same control, same look" between the two headers. Small, but visible side by side (`1080-tabs-montage.png`, "Code/Storybook" in tiles 2 and 4 vs 1 and 3).
  - **Cause:** `src/storybook.css:36`. The shared layout rule still sets `font-weight: 600` for every vibe. Only the colour and border chrome moved behind `html:not([data-vibe="boring"])` (line 37).
  - **Fix:** move `font-weight: 600` into the Psycho-only rule on line 37, or add `font-weight: 400` under `html[data-vibe="boring"]`.
  - **Files:** `src/storybook.css` · **Effort:** XS

### Nit

- **n1 · The Crunch pill moves when you open an agent.** It's the first item in the action row, and Split and Details are added after it, so it shifts left 145 px: 2945→2800 (4K) and 1025→880 (720). Putting it last, or giving Split/Details a reserved slot, would keep it in one place (`src/BoringAde.tsx:1031`). Also, the Crunch "on" label uses `--text` while the active project-tab label in dark uses `--accent`. Both are readable, but the two "on" cues in the same topbar don't match (`src/boring.css:1454` vs the project-tabs `.on` rule).

## Owner decisions

- **A Crunch control on phone?** Options:
  - (a) Team Settings only, as shipped.
  - (b) A drawer row in phone ⋯ next to Usage/Storybook, showing state and flipping on tap.
  - (c) A pill in the phone header bar.

  **Recommendation: (b).** It costs the drawer one row (compact-by-default holds, and the drawer is already a list of these). It covers the away-from-desk moment, and it reuses the C3 hook. (c) competes with the squad pill and the bug pill for 390 px. If (a), at least ship m2(b), the search entry, so the setting can be found.

## Not charged to this unit

- In Psycho the chip only lives in the Toolbar, which mounts only in the FULL ("Show plumbing") view (`src/App.tsx:1339`, mounted at `:2228`). The default Psycho sky/pin hub shows no Crunch state. The old `vibe-mode-chip` had the same placement, and Psycho is retired (no new parity/polish), so I'm noting it here, not charging it.
- The sb-head page has no Crunch pill. That's acceptable: sb-head has no action row, and Code returns to the topbar.
- R23 m2 (phone sb-head truncation) and R21 m1 were not re-driven.
