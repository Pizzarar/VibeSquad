PASS 0/0/3 efb2706b

# UX Review R34: Normal-mode Main marker (@ui-bois MM1)

- **Branch / tip:** `unit-ui-main-marker` @ `efb2706b` (dist built from this worktree with `vite build`)
- **Scope:** @art's blinking googly-eye pin sprite (`src/MainMarker.tsx`, `src/MainMarker.css`), drawn in the pinned Main project row (`.boring-main-pin .boring-main-line`, row 2, grid column 2, `justify-self: end`), mounted at `src/BoringAde.tsx:1244`.
- **Reviewer:** UX Reviewer (worker). Read-only. Nothing committed.
- **Files:** shots in `docs/ux-review-r34/mm1/` (a subfolder, because `docs/ux-review-r34/` already holds the BOR B17 round). Drivers are in `docs/ux-review-r34/mm1/drive/` (`pass1.mjs` = geometry and blink frames, `pass2.mjs` = flows) and raw measurements in `docs/ux-review-r34/mm1/logs/`.
- **Names:** before each shot the driver replaces project names with "Project A/B/C". I deleted the full-window shots because the Decision Desk shows real squad names; only the pin crops are kept.

## Verdict

**PASS. 0 critical, 0 major, 3 minor.** The marker is crisp at every tested size and fits the free cell. It leaves the row height, the project name, Open, ⋯ and the chevron alone, renders exactly once, keeps the reduced-motion setting, and its hit area passes clicks through. The three minors are a size and spec mismatch, a looping animation that conflicts with the written Normal motion rule (this is an owner decision), and the marker reading as part of the action cluster.

## Method

- **App and data:** `?demo` with the R39 mock backend (copied from `docs/ux-review-r39/drive/mock.mjs`). `/api/teams` is answered by a Playwright route, so **⋯ → Make main project** sticks and isn't rolled back. The second project in the sidebar was made Main.
- **Viewports:** 3200x1800 @ dpr 1.2 (4K at 120%), 1920x1080 and 1280x720, each in dark and light. Reduced motion was checked at 4K dark and 1080 light.
- **Flows (pass 2):** make Main → select the Main row (`.on`) → hover → click on the marker spot → **Open** (Buddy chat) → **Ctrl+J** to another target → expand Main → scroll the expanded pin so the line goes sticky.
- **Pixel check:** a nearest-neighbour 8x zoom of the idle, blink0 and blink1 frames (`/tmp` only), and a diff of the rendered idle frame against `public/ui/main-marker-<theme>.png` frame 0.
- **Click guard:** `npm run ui:clicks -- --vibe boring --surfaces boring-home,boring-lead`

## Status vs the previous round

No earlier round covered the Main marker; this is the first review of MM1. These are the regression checks on the Main pin area, which BOR B18 owns (`test/bor-b18-visual.test.mjs`):

| Check | Result | Evidence |
|---|---|---|
| Main line height unchanged | **OK**. 56 px with the marker and 56 px with it hidden. When the row is selected (`+ lane` shown) it is 58 px with or without the marker, so that height was already there before this change. | pass1 `lineH`/`lineH0`, pass3 `h`/`h0` |
| Pin height unchanged | **OK**. 60 px vs 60 px when collapsed. | pass1 `pinH`/`pinH0` |
| Project name not squeezed | **OK**. Name width is the same with and without the marker: 254 px at 4K, 181 at 1080, 164 at 720. No truncation. | pass1 `nameW`/`nameW0`, `nameTrunc:false` |
| No overlap with Open, ⋯, chevron, name or + lane | **OK** at all sizes. The gap to ⋯ is 6 px. The gap to Open is 215 px at 4K, 139 at 1080 and 122 at 720. | pass1 `overlaps`, `gapToMenu`, `gapFromOpen` |
| Rendered once | **OK**. `markers: 1` at every step of every flow. | pass2 |
| Exactly one selected row | **OK**. `onRows: 1` throughout. | pass2 |
| Sticky line when Main is expanded and scrolled | **OK**. The marker stays in the sticky line. | `mm1-*-expanded-scrolled-pin.png` |
| Reduced motion | **OK**. `animation-name: none`, idle frame. | pass1 `dark-4k120-rm`, `light-1080-rm` |
| Marker click | **OK**. Inert: `elementFromPoint` hits `.boring-main-line`, and the URL and selection don't change. | pass2 `markerClick`, pass3 `hit` |
| Page errors | none | pass1/pass2 `errs: []` |
| ui:clicks (boring-home, boring-lead) | **PASS**. 0 hits from 680 hit-tests, 28 popovers and 70 triggers, 0 skipped. The demo fixture has no Main project, so this guard never reaches the marker. pass1 and pass2 cover it instead. | `scratch/ui-clicks/report.md` |

## Crispness and legibility

- **Integer scaling:** the marker is drawn at 16 device px at both 4K@120% (13.33 CSS px × 1.2 = 15.994) and 1080/720, using the 1x sheet. It matches native frame 0 **exactly** at 1080 (diff 0 over 87 opaque px). At 4K the diff is 126 (dark) and 576 (light) summed RGB over 87 px, which is under 2.3 per channel on average: a colour-management rounding, not resampling. The 8x zooms show no doubled or dropped rows or columns. `image-rendering: pixelated`, `background-size: 300% 100%`.
- **Blink frames:** blink0 (violet lid) and blink1 (closed dome) both render cleanly in both themes (`mm1-*-pin-blink0.png`, `-blink1.png`).
- **Contrast:** the marker sits in row 2, on the `.boring-main-line` fill, **not** on `.boring-project-row.on`, which is row 1. The brief's "legible against `.on`" doesn't apply as written. The surface it actually sits on is `rgb(56,44,44)`-ish in dark and `rgb(234,219,207)`-ish in light. The INK outline carries the silhouette on both (`mm1-dark-4k120-selected-pin.png`, `mm1-light-4k120-expanded-scrolled-pin.png`).

## Findings

### m1 · Minor: rendered at half the size in the art contract; at 4K the eye is about 6 physical px
- **Job hurt:** 2 (Monitor), slightly. The marker is meant to say "this is Main" at a glance, and on the owner's 4K screen it reads as a speck next to ⋯.
- **Evidence:** `public/ui/main-marker.json` says `"display": "16 kit px box = calc(var(--u3-px) * 16)"`. The brief also says "16 kit px". The implementation asks for 16 **CSS** px: `snapDeviceSize(16, 16, …)` at `src/MainMarker.tsx:14`, which gives 16 device px = 8 kit px (`--u3-px` is 2 device px). At 4K@120% that makes the marker 13.3 CSS px on screen, and the eye is 6×6 source px (`mm1-dark-4k120-pin.png`).
- **Why it was likely done:** the full 16 kit px (32 device px; 26.7 CSS px at 4K, 32 at 1080) is taller than row 2 (Open is 24 px) and would break "no row height change".
- **Fix (pick with @art):** either (a) amend the json to match the shipped 1x native size, which needs no code, or (b) use 2x only where it fits, e.g. `snapDeviceSize(16, 16, …, up=true)` at dpr ≥ 1.2 with a negative block margin so the line stays at 56 px. Re-measure `lineH` after (b).
- **Files:** `src/MainMarker.tsx:14`, `public/ui/main-marker.json`
- **Effort:** XS for (a), S for (b).

### m2 · Minor (spec conflict, owner decision): a perpetual 4 s blink loop in Normal mode
- **Job hurt:** 2 (Monitor), as peripheral motion in a screen that stays open all day. The motion itself is small: 200 ms of blink every 4 s on a 13 px sprite, and it was not distracting in review.
- **Evidence:** `src/MainMarker.css:2` sets `animation: main-marker-blink 4s steps(1, end) infinite` unconditionally. `docs/UX_REVIEW.md:375` (Normal design system) says: *"Motion: only the running pulse and a one-shot 300ms highlight… Nothing loops."* The closest precedent, the bug roach, animates only while it has state: `src/BugButton.css:10` twitches only on `.has-new`/`.pulse`.
- **Fix:** see Owner decisions D1. If the owner picks "blink on hover and on mount", play the keyframes once at mount and again on `.boring-main-line:hover`, and keep `animation: none` under reduced motion.
- **Files:** `src/MainMarker.css:2`
- **Effort:** XS

### m3 · Minor: the marker sits in the action cluster and reads as a control
- **Job hurt:** 5 (Intervene), mildly. Right-aligned 6 px from ⋯ (and next to `+ lane` when the project is active), the pin looks like a "pin/unpin" button. Clicking it does nothing: `pointer-events: none`, and the click falls through to the inert line.
- **Evidence:** `mm1-dark-4k120-selected-pin.png` and `mm1-light-720-selected-pin.png` show the pin, ⋯ and `+ lane` as one group. pass2 `markerClick` shows the URL unchanged after the click.
- **Fix:** move it to the left of the free space, next to Open (`justify-self: start; margin-left: calc(<Open width> + 8px)`), or give it a `title="Main project"` hover with `pointer-events: auto` and no action. The first keeps it decorative and clear of the actions.
- **Files:** `src/MainMarker.css:2`
- **Effort:** XS

## Owner decisions

- **D1 · Should the Main marker blink forever?** `docs/UX_REVIEW.md:375` says nothing loops in Normal mode. The 11-09 surreal-touch directive asks for a bit of surrealism from @art.
  - **Recommendation:** blink once on load and on hover; stay idle otherwise. That keeps the surreal touch and meets the motion rule.
  - Alternatives: (b) keep the 4 s loop as shipped and add an exception for decorative @art sprites to `docs/UX_REVIEW.md:375`; (c) no animation at all, idle frame only.

## Not covered / limits

- **light-720 (pass 1):** the ⋯ menu click missed once and the run was skipped. pass2, which retries the menu, covered light-720 fully: selected, hover and expanded shots, with the same geometry as dark-720.
- **Standard sequences:** "open a Needs-you item", "deep-link `?agent=`", "a worker" and "10+ alerts" were not re-driven. MM1 touches only the Main pin line; those surfaces fall under the click-guard PASS above.
- **Phone layout:** not in scope. The marker mounts only in the desktop sidebar's Main pin.
