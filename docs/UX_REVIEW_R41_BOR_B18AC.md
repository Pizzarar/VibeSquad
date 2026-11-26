# UX Review R41 · @bor B18a + B18c (idea-928 Normal polish + picker "Other projects")

- **Branch / tip:** `unit-bor-b18-visual` @ `3b536c80`, base `e476f89e`.
- **Method:** rebuilt `dist` from the tip (`dist/index.html` 01:34 UTC, bundle contains `boring-pp-others`), plus a base build of `e476f89e` (`git archive` into `/tmp`) for before/after. The app ran with `?demo=1` and a multi-project registry: VibeSquad (pinned as Main via `team.main: true`), Main Game, Plugins and Site, the same routes as `test/bor-b18-visual.test.mjs`. Sizes: 1280x720, 2560x1440 and 3200x1800 @1.2 DPR (4K@120%), each in dark and light.
- **Evidence:** `docs/shots/ux-r41-bor-b18ac/` (`head-*` = tip, `base-*` = e476f89e). The measurement scripts were throwaway, at `/tmp/uxr41/{run,dormant}.mjs`.

## Status vs previous round (R34/R34b @bor B17)

| Prior | Status | Evidence |
|---|---|---|
| B17 L4: right pane ~70% empty below the grid | **Partly resolved, minor (see L1)** | 4K dark: the empty share is 69% at base (`base-4k-dark-split-collapsed.png`) and still ~63% at tip with the disclosure collapsed (the summary row adds ~40px). The new warm wash does make the lower area read as intentional rather than dead. Expanded, the empty share is ~42% (`head-4k-light-split-expanded.png`). At 1280x720 the picker overflows (scroll 1385/651 collapsed, 2177/651 expanded), so collapsed-by-default is right there. |
| R30 L2/L5 composer wrap | Out of scope (B18b) | Not judged here. |

## B18a: what was checked, and what holds

| Check | Result | Evidence |
|---|---|---|
| O2 floors: pin 60/220px, tree ≥120px | **Hold** at all 6 size/theme combos. Pin 60 collapsed, 220 open at 1280 and 561 open at 1440p/4K. Tree 120 at 1280 and 508-1009 at larger sizes. | `geoClosed`/`geoOpen` per size, tip vs base identical to ±1px |
| Footer position | Footer bottom is 1784 at 4K, the same as base. The new 1px `border-top` moves the footer top up 1px (1705 vs 1706) and the tree is 1px shorter. Nothing is lost. At 1280x720 the footer is below the fold (sidebar scrollHeight 927/720), exactly as at base (pre-existing; the O2 tree floor makes the sidebar scroll). | same |
| Tree 24px fade + seam | Works. A scrolled tree dissolves rows above a crisp seam, and with `padding-bottom: 24px` the last row is reachable unfaded at scroll end. The footer's `--surface-0` reads as a faint separate band (dark 18,18,24 against the sidebar's 22,22,29; light #f7f6f3 against #fff). That is acceptable and in fact helps the seam. | `head-1280-{dark,light}-sidebar-tree-mid.png` |
| Warm gradients: main pin, open project, sticky main line | Render as specified. The sticky `.boring-main-line` colour equals the pin's top stop (dark 56,44,44; light 234,219,207). The gradient is painted on the scroll box, not the content, so the top stop always sits behind the sticky line: no flat-grey clash when scrolled. | `head-1280-dark-pin-scrolled.png`, `head-4k-{dark,light}-sidebar-pin-open.png` |
| `.boring-ctx-body` wash | Present on every tab, subtle. No layout shift switching Workers/Changes/Plan/Feed/Files/Terminal. | `head-2560-{dark,light}-ctx-workers.png`, `head-4k-light-agent-ctx.png` |
| `.boring-split-empty` wash | Present, and visible in light at the bottom of the pane. | `head-4k-light-split-expanded.png` |

### Measured contrast (live computed colours, every gradient stop, text blended over the real backdrop)

Measured in the DOM (not token arithmetic). For each container I took every distinct text colour that sits directly on the new background (text on its own opaque chip, such as Trinity cards and attn rows, was excluded because B18 doesn't change those surfaces) and computed the WCAG ratio against **each** gradient stop composited over its opaque ancestor.

| Surface | Dark min (text, stop) | Light min |
|---|---|---|
| `.boring-main-pin` (top / bottom stop) | **4.69** `--text-3` "Lanes" on the warm top; 5.16 on the bottom | 5.07 `--text-3` |
| `.boring-project-block.open` | 5.53 `--text-3` | 6.14 `--text-3` |
| `.boring-ctx-body` (3 stops: warm, accent, base) | 5.32 `--text-3` "3s" (Workers) | 5.33 "◐" (Plan/Feed) |
| `.boring-split-empty` | 8.89 `--text-2` heading | 4.95 `.boring-pp-others-badge` ("N needs you", `--st-attn`) |

**All ≥ 4.5:1 in both themes at every size.** The tightest is dark `--text-3` on the main-pin warm stop (4.69), which leaves little headroom: any later bump of the warm % above ~14 should re-measure.

## B18c: what was checked

| Check | Result |
|---|---|
| Collapsed by default | Yes, at all sizes: `OTHER PROJECTS (3)` + `1 needs you` badge. |
| Auto-opens on a filter match | Yes. Filtering `site` opens the disclosure and narrows it to `OTHER PROJECTS (1)` with Site's lanes (`head-2560-light-split-filter-site.png`). Clearing the filter returns it to collapsed. |
| Live other-project agent → right pane, split kept | **Yes.** `Main Game · main-game · Buddy` → `?team=efi&agent=demo-bs-efi-1`, both panes, left keeps `Audit - token scout`. `Plugins · ★ Overlord` (live) does the same and **survives reload** (`head-2560-dark-after-live-other.png`). |
| Dormant other-project lane | **Broken, see M1.** |

## Findings

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| M1 | **Major** | **The disclosure's dormant pills do three different things, and none of them is "show that lane's card".** They are 10 of the 15 pills in the demo; every Overlord/RiffBot/Bugs `Open` reads "No agent". (a) **Dormant Buddy/Lead** (`Main Game · UI-lab · Buddy`, `Site · site-polish · Buddy`): switches the whole app to that project, the split stays, and the right pane re-mounts as *that project's* picker. No lane card appears, so the user must find and click the lane again. Zero sidebar rows are selected, and the URL drops `&agent=` (`?team=efi`) while the left pane still shows VibeSquad's Audit worker. **Reload then loses the split and the left agent** (lands on `Site › Overview`). (b) **Dormant ★ Overlord / RiffBot / Bugs** (`Main Game · ★ Overlord`, `· Bugs`): **folds the split.** The left pane's agent, here a worker with a pending Allow/Deny, disappears behind a full-screen `No Overlord is running…` card (`?team=efi&slot=overlord`). Inside the same picker, a same-project dormant pill shows its card *in the right pane* (R34 M3 fix), so the disclosure breaks the picker's own rule: "every open action on the right card lands in the right pane". The worker's note says dormant "switches project, then shows the lane's card", but live it doesn't: `rightCard` is cleared on project change and the picker is keyed by team id. To the brief's question "is this acceptable UX?": **no**. A silent context jump that loses the left pane's URL state, or folds the split, is worse than R34 M3's no-op. | Split triage; pick a lane in another project | `head-2560-dark-dormant-efi-ui-lab-brainstorm.png`, `head-2560-dark-dormant-efi-_overlord-open.png`; `/tmp/uxr41/dormant.mjs` output (`after`/`afterReload`, all 5 cases). Cause: `src/BoringAde.tsx:839-845` routes dormant pills through `pickCore` / `onSelectSquad`+`pickBugs` / `pickRoleIn`, the left-pane navigators that B17 deliberately kept out of `rightHandlers`. Then `src/BoringAde.tsx:741` (`setRightCard(null)` on `view.team.id` change) and the picker `key={view?.team.id}` (`:919`) wipe any card. `src/BoringPanePicker.tsx:175` calls `pl.onOpen` directly, bypassing `openLane`'s dormant→card path. | **Recommend (a):** in Other projects, render dormant pills as non-buttons (muted text `Buddy · not running`, or drop them) and keep only live pills clickable. That leaves one honest action: open the live agent on the right. Cross-project starts belong to that project's own view. Alternative (b): add `teamId` to `CardTarget`, render the other project's empty card in the right pane without switching `view`, and drop the project-switch path. Either way, add a browser test that a dormant other-project click never changes `panes.split` and never drops `&agent=`. | `BoringAde.tsx`, `BoringPanePicker.tsx`, `test/bor-b18-visual.test.mjs` | (a) XS, (b) S |
| L1 | Minor | **B17 L4 is only partly resolved.** At 4K with the default collapsed state the pane is still ~63% empty (69% at base). The wash makes it calm rather than dead, which meets the plan's "intentional lower canvas", but the content added to fill it is hidden by default. Fine at 1280, where the picker already scrolls. | Split | `head-4k-dark-split-collapsed.png` vs `base-4k-dark-split-collapsed.png` | Optional: auto-open the disclosure when the pane has room (e.g. the picker body is shorter than ~60% of the pane) or when another project needs you. Or accept it as-is. | `BoringPanePicker.tsx` | XS |
| L2 | Minor | Once expanded, the disclosure is mostly `No agent · Open` rows (3 Trinity rows per project, nearly all dormant), so the useful live pills are buried. This compounds M1. | Pick a lane | `head-4k-light-split-expanded.png` | Covered by M1 fix (a). Optionally also hide Trinity rows without an agent. | `BoringAde.tsx` | XS |
| L3 | Minor | Dark `--text-3` on the main-pin warm stop measures 4.69:1. It passes, but this is the tightest stop in the theme. | Readability | Contrast table above | No change needed. Note it in the @art tokens so a future warm bump re-measures. | — | — |

## Checked, no issue

- Exactly one selected row and breadcrumb = open agent: these hold for live other-project opens (`Plugins › Desk › Overlord`, sidebar row `★ Overlord` selected) and fail only on the M1 dormant paths.
- Needs-you counts: the badge `1 needs you` matches Main Game's single `main-game · Needs you` card and sidebar `Lead 75`.
- No new truncation of explanatory text. The `Open` button wrapping under `VibeSquad` in the Main line at 1280 is identical at base.
- Psycho untouched (all CSS is under `html[data-vibe="boring"]`, and the hygiene test asserts it).

## Owner decisions

- **Dormant lanes of other projects in the split picker:** (a) show them as non-clickable "not running" (live pills only), **recommended**; or (b) build a cross-project lane card in the right pane. (a) is XS and removes the only way this feature can lose your left pane. (b) is S and lets you start another project's Buddy from a split, which is rarely needed. The lane can take (a) under R13 without asking; listed here only because it narrows the plan's "1-click lane pills".

## Verdict

B18a passes: floors hold, gradients are sticky-safe, and every measured text stop is ≥4.5:1 in both themes. B18c's live path works, but dormant other-project pills switch project without the card, drop the URL agent, or fold the split (M1, Major). **FAIL 0/1/3.**
