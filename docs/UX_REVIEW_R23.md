# VibeSquad UX review, round 23: Code | Storybook tabs (idea-834 T1 + T2)

Date: 2026-11-25 · Build: `unit-ui-sb-tabs` @ `b79f011d` · Baseline: `docs/UX_REVIEW_R22.md` (FAIL 0/1/3 @ `82a64189`).

**Setup.** Same as R22. `npx vite --port 5436` from the unit worktree, with `?demo`. A Playwright `page.route('**/api/storybook/**')` answers `vibesquad` (HEAD 200, GET SB1 snapshot) and sends 404 for every other project. Chromium at 1280×720, 1920×1080, 3200×1800 @ dpr 1.2, and phone 390×844 @ dpr 3 (isMobile + touch), each in dark and light. There were 0 page errors in every run, no source edits, and no git writes. Shots are in `docs/ux-review-r23/`.

**Verdict at `b79f011d`: PASS 0/0/2.** M1 is closed: see the judgement below, and there's an optional owner call. m1, m3 and T2 are fixed. m2 is only partly fixed. The m1 fix adds one new light-mode contrast minor.

## Status vs R22

| R22 item | R23 | Evidence |
|---|---|---|
| M1: pill jumps sides between headers | **Closed (judgement below)** | The sb-head pill sits at x=347 at every desktop size, right after "Storybook · VibeSquad" (h2 right edge 335). The topbar pill is at 530 (720p), 548 (1080p) and 620 (4K), right after the breadcrumb. Both are on the same side, in the same "title → pill" slot. The old 840 to 2000 px cross-screen jump is gone (`1080d-pill-compare.png`, `1080l-pill-compare.png`). |
| m1: active segment indistinct / inverted in light | **Fixed** | Active is now `--accent` text plus a 1px `--accent` inset ring. Dark: `rgb(155,114,232)` on `#332a4a`, 5.96:1. Inactive keeps `opacity: 1` and reads by colour only. The active segment is obvious in both themes. See new minor N1 for light-mode text contrast. |
| m2: phone title "Storyb…" hides the project | **Partly fixed (still open, minor)** | `.sb-word` is `display:none` at ≤600px, but the h2 still ellipsizes: it renders `◉ · VibeSq…` in a 90px box, with a leading orphan "·" (`phd-sb-head-crop.png`). |
| m3: phone pill 28px | **Fixed** | Both segments are 40px tall at 390×844 (pill box x=230, y=10, w=150). |
| Navigation (Storybook click, Code = Back, Ctrl+J) | **Pass, unchanged** | Code from Storybook leaves `history.length` 4→4 and returns to `?team=vibesquad`. On the agent page the pill shows after `VibeSquad › Desk › Worker`. Storybook adds `&sb=`, and Ctrl+J leaves Storybook with `sb` cleared. |
| Compact / overflow | **Pass** | scrollWidth equals the viewport and scrollHeight equals the viewport at all 8 size/theme combos. |

## T2 and phone checks

| Check | Result | Evidence |
|---|---|---|
| ⋯ project menu no longer has "Open Storybook" | **Pass** | `vibesquad` ⋯ shows: Stop All Running (12)…, Interrupt All Running (12)…, Move to Backlog, New folder… `efi` shows the same set (`1080d-menu.png`). |
| Palette "Open Storybook: <project>" | **Pass** | Typing `storybook` lists exactly `Open Storybook: VibeSquad`. The 404 projects (`efi`, `site`, …) are correctly absent (`1080d-palette.png`). Starting from `?team=efi`, Enter opens VibeSquad's Storybook (`&sb=vibesquad`, history +1, tabs present). Esc returns to `?team=efi`. An empty palette query does not list Storybook items, so the default list stays compact. |
| Phone: no pill in the Normal phone shell | **Pass (as decided)** | `.project-tabs` is absent on the phone home (`phd-home.png`). |
| Phone ⋯ → `phone-storybook-btn` | **Pass** | The drawer shows "Open Storybook · VibeSquad" (44px tall, 318px wide) (`phl-drawer.png`). Tapping it opens Storybook with the pill on row 1. Tapping Code returns to `?team=vibesquad` with sb closed (`phd-sb.png`, `phl-sb.png`). |

## M1 judgement: "same spot"

The pill is no longer in the identical pixel spot. It sits 183 px (720p), 201 px (1080p) and 273 px (4K) further left in Storybook, and about 11 px higher. I'm closing M1 anyway, for three reasons:

1. **The topbar pill isn't fixed either.** It moves with breadcrumb length: x=548 on `VibeSquad › Overview` and x=600 on `VibeSquad › Desk › Worker` (same 1080p window). A literal "same pixel" rule can't hold even within one header unless the pill is anchored to a fixed slot.
2. **The relationship is now consistent.** In both headers the order is "where am I" text, then the Code | Storybook pill, on the left. The R22 failure was the pill leaving for the opposite edge, about 2000 px away at 4K. That's gone.
3. **Exact alignment means coupling layouts.** sb-head has no sidebar. Matching x would need either (a) a left zone in Storybook sized to the sidebar width, or (b) Storybook rendering inside the Normal shell under the regular topbar. Both are design changes beyond an XS fix.

This needs a quick owner yes/no (see Owner decisions). It doesn't block.

## Findings

### Critical / Major
None open.

### Minor

- **N1 (new) · Light-mode active segment text is 3.48:1.**
  - **Job hurt:** orientation and legibility in light theme. The ring keeps the state readable, so this is minor.
  - **Evidence:** `rgb(109,75,201)` (`--accent` light, `#6d4bc9`) on the active background `color(srgb .913 .890 .973)` gives 3.48:1, below the 4.5:1 AA threshold for text of this size. Dark is 5.96:1 and passes. Shot: `1080l-pill-compare.png`.
  - **Cause:** `src/boring.css:1439` sets `color: var(--accent)` on top of the inherited `.boring-switch-pill.on` lilac fill.
  - **Fix:** keep the `--accent` ring but use `--text` (or a darker accent-text token) for the label in light mode, or lighten the active fill. Colour pairing goes to **@art** per lane SPEC.
  - **Files:** `src/boring.css` · **Effort:** XS

- **m2 (carried, partly fixed) · Phone sb-head still truncates the project name: `◉ · VibeSq…`.**
  - **Job hurt:** orientation on phone. "VibeSquad" is short, so longer project names will lose almost everything.
  - **Evidence:** h2 box is 90 px wide (right edge 218), with the pill at x=230 and w=150 in a 390 px viewport. The leading "·" is now orphaned because the word before it is hidden (`phd-sb-head-crop.png`).
  - **Cause:** `src/storybook.css:111` hides `.sb-word` but leaves the " · " separator inside `.sb-proj` (`src/StorybookView.tsx:480`). `← Back` (about 80 px with its label) and the 150 px pill leave about 90 px for the title.
  - **Fix:** at ≤600px, hide the separator (split `·` into its own span, or use a `::before`), and shrink `← Back` to a 44px `←` icon button with `aria-label="Back"`. That recovers about 50 px, enough for most names. Alternatively, let the title take its own row under Back + pill.
  - **Files:** `src/storybook.css` (600px block, 104-116), `src/StorybookView.tsx:478-480` · **Effort:** XS

## Owner decisions

- **"Same spot" for the Code | Storybook pill.** Options:
  - (a) Accept "pill follows the title" in both headers, as shipped. The offset is 183 to 273 px, same side.
  - (b) Pin both pills to a fixed x, by giving sb-head a sidebar-width left zone.
  - (c) Render Storybook inside the Normal shell under the regular topbar, so the pill literally never moves.

  **Recommendation: (a).** The topbar pill already shifts with breadcrumb length. The consistent left-side "title → pill" pattern is what makes the control findable, and (b)/(c) cost layout coupling for about 200 px of travel. If the owner wants (c), queue it as a post-T2 unit, not a fix to this one.
- (Carried from R22, already decided) No pill in the phone Normal shell. Phone uses ⋯ → Open Storybook. Verified working.

## Not charged to this unit

- R21 m1 (dead Back press after a forward pick out of Storybook) and the R21 double-Esc nit were not re-driven.
- Pre-existing `ui:overlap` hits (idea-945).
- Psycho-mode palette was not isolated: the `vibe=psycho` param didn't switch vibe in `?demo`. The palette command ran and opened Storybook regardless of vibe.
