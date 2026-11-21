# VibeSquad UX review, round 9: B9, Normal is the default, Psycho moves to Legacy

Date: 2026-11-21 · Build: `unit-bor-b9-normal-default` @ `dfa94c39` (vite dev on `:5397`, run from the unit worktree).
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). `?demo` at 3200×1800 and 1920×1080, dark and light. Every scenario ran in a **fresh Playwright browser context** with nothing seeded, unless a step below says what it seeded.
Screenshots: `scratch/ux-r9/` (gitignored). The two-digit numbers below refer to those files.

**Verdict at `dfa94c39`: PASS 0/0/3.**

## Status vs round 8

| Item | Status | Evidence |
|---|---|---|
| R8-1 Desk needs-you lost when expanded | still fixed | invariant 2b passes |
| R8-6 stalled Overlord badge | still fixed | invariant 2c passes |
| R7-2 1080 reason clamp | unchanged (minor) | `04`: "…then approve the sav…" |
| R8-5 worker crumb reads "Worker" | not re-checked (out of scope) | none |

### Invariants

`node --test test/normal-invariants.test.mjs`: **14/14 pass, 0 fail, 0 skip** (107.1s).

## B9 checks (fresh context, no `vs.prefs.v1`)

| Check | Result | Evidence |
|---|---|---|
| Lands in Normal (`data-vibe="boring"`), no picker modal | ✓ at all 4 sizes and themes. `[data-testid^=first-run-vibe]` is absent and there are no dialogs. `vs.vibeMigratedNormal="1"` and `vs.prefs.v1="{}"` are written | `01`–`04` |
| Picker stays gone even with `vs.forceVibePicker="1"` | ✓ | scenario C |
| Sidebar footer shows "Usage & workflows" and "Settings", with no Switch to Psycho | ✓. No `boring-switch-vibespace-btn`, and "Switch to Psycho" appears nowhere in the body text. Footer bottom is at 1784/1800 at 4K and 1064/1080 at 1080p, pinned | `01`–`04` |
| Settings > App has no "Layout vibe" row | ✓. The App rows are UI density, Theme, Accent color, Confirm before closing, Reopen last view, Open in IDE | `05` |
| Settings > About has the `settings-legacy-psycho-toggle` row | ✓. It sits between Update channel and Unstick, and arrives highlighted when opened from a search hit | `08` |
| Settings search finds it | ✓. "psycho", "legacy", "vibe" and "normal" each return the single hit "Legacy: Psycho mode · About · Open →" | `06`, `07` |
| Toggle ON switches to Psycho | ✓. `vibe=fun`, `prefs={"app.vibe":"fun"}`, and Settings closes as the shell swaps | `09` |
| Psycho survives a reload (no re-migration) | ✓. Still `fun` after reload and the flag stays `"1"` | `10` |
| Psycho toolbar "Normal mode" button returns to Normal | ✓ from the Squads screen, and it persists across a reload. The button is **not shown** on the default Psycho landing (see R9-1) | `15`, `16` |
| Psycho, then gear ⚙, then Settings > About, toggle OFF | ✓. `vibe=boring` and it persists across a reload | `12`, `13` |
| Pre-migration: seed `{"app.vibe":"fun"}` with no flag, then load | ✓. The `data-vibe` trace is `init:null → interactive:boring → raf1:boring → complete:boring`, so it never shows `fun` (no Psycho flash). Afterwards `prefs={"app.vibe":"boring",…}` and `vs.vibeMigratedNormal="1"`, both stable across a reload | `14` |
| Console page errors | none in any scenario | none |

## Findings

### R9-1 · minor · The Psycho "Normal mode" button is hidden on Psycho's default landing
- **Job hurt:** getting back to Normal after trying Legacy Psycho.
- **Evidence:** `10`. After toggling Psycho on (or reloading in Psycho), the app lands on the tower/focus view and `[data-testid="toolbar-vibe-toggle"]` isn't in the DOM. It appears only after clicking "Squads" in the breadcrumb (`15`). You can still get back through ⚙, then Settings, then search "normal", then About toggle (`12`). The commit message says "Psycho keeps its toolbar Normal mode button", but in practice it's two clicks deep.
- **Cause:** `<Toolbar>` mounts only when `!focus && !pinFocused` (`src/App.tsx:2177`). This was the same before B9, but B9 removed the other obvious way back (Settings > App > Layout vibe).
- **Fix:** add a small "Normal mode" chip to the always-visible Psycho chrome, such as the bottom-left icon strip next to ⚙ or the focus breadcrumb bar. Or have the Legacy row's hint say "Turn off here to return".
- **Files:** `src/App.tsx`. **Effort:** XS. **Lane:** @bor (Psycho itself is frozen for polish, so this is an exit-path fix only).

### R9-2 · minor · Users who chose Psycho get migrated silently
- **Job hurt:** an owner or user who deliberately ran Psycho finds Normal after updating, with no hint of where Psycho went.
- **Evidence:** scenario B. The migration runs regardless of `vs.vibePicked`, so it can't tell an explicit Psycho pick from the old default. This is the intended spec behaviour, but nothing on screen explains it.
- **Fix:** if `migrateVibeToNormalOnce` actually flipped `fun → boring`, show a one-time toast: "Normal is now the default. Psycho lives in Settings › About › Legacy: Psycho mode."
- **Files:** `src/prefs.ts:236-251`, plus a toast call site. **Effort:** XS. See Owner decisions.

### R9-3 · minor · The Legacy toggle checkbox is a bare 13×13 CSS px control at 4K
- **Evidence:** `08`. The checkbox rect is `13×13` at 3200×1800, right-aligned about 470px from its label. It's hard to spot, and it's the only bare checkbox among About's buttons.
- **Fix:** make the whole row clickable (it already has `<label htmlFor>`, but only on the label text), or use the existing settings toggle/segmented style (`Off | On`), like Update channel's `Stable | Beta`.
- **Files:** `src/SettingsHome.tsx:410-425`. **Effort:** XS.

## Owner decisions

1. **Migrate everyone, or only users who never chose Psycho?** B9 flips every stored `fun` to Normal once, including people who picked Psycho in the old first-launch picker (`vs.vibePicked`). **Recommendation:** keep the blanket migration, since it matches the "Normal is the default going forward" direction, and add the one-time toast from R9-2 so nobody thinks Psycho was deleted.

## Notes
- Turning the Legacy toggle on or off closes Settings, because the shell swaps. That's fine: the user sees the result right away.
- `FirstLaunchVibePicker` / `VibePickerCards` / `shouldShowFirstLaunchVibePicker` are now dead or constant code (`src/FirstRunModal.tsx:16-19`). This is code hygiene, not UX, and it's left for the lane.
