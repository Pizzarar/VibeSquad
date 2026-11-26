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

---

## Round 2 · tip `5a020127` (fix for M1 + L2; L1/L3 accepted as-is)

- **Method:** `dist` rebuilt from `5a020127` (`UI_OVERLAP_REBUILD=1`, bundle contains `pendingRightCard`/`openOtherDormant` logic). Same multi-project demo registry as R1, plus a fully dormant lane in two projects (`Site · docs`, `Plugins · empty-p`, as in `test/bor-b18-visual.test.mjs`) so a dormant **Lead** pill exists. Start state each time: VibeSquad › `Audit - token scout` (pending Allow/Deny) on the left, split open, right picker, `Other projects` expanded. Throwaway scripts: `/tmp/uxr41/{r2,r2b,r2c,r2d,run}.mjs`.
- **Evidence:** `docs/shots/ux-r41-bor-b18ac/r2/`.

### Status vs round 1

| R1 | Status | Evidence |
|---|---|---|
| M1 dormant other-project pills switch project with no card / drop `&agent=` / fold split | **Resolved** (see the path table) | `r2/2560-dark-{efi-ui-lab-brainstorm,site-site-polish-brainstorm,site-docs-lead,site-docs-brainstorm,plugins-empty-p-lead}.png` |
| L2 dormant Trinity rows bury the live pills | **Resolved.** Dormant Overlord/RiffBot/Bugs rows are gone from Other projects (`efi-_overlord`, `efi-_bugs`, `site-_riffbot` = 0 nodes). The live `Plugins · ★ Overlord` stays. Expanded, the disclosure is now 4 compact rows (`r2/4k-light-split-expanded.png`). | pill inventory below |
| L1 4K lower canvas ~63% empty when collapsed | Accepted as-is (lane decision). Unchanged. | `r2/4k-dark-split-collapsed.png` |
| L3 dark `--text-3` on main-pin warm stop 4.69:1 | Accepted as-is. Still 4.69, unchanged. | contrast table below |

### M1: every path, measured live (2560x1440 dark, plus the ui-lab path at all 6 size/theme combos)

The Other-projects pills in the demo were: live `efi-main-game-{brainstorm,lead}`, `efi-ui-lab-lead`, `plugins-_overlord-open`, `site-site-polish-lead`; dormant `efi-ui-lab-brainstorm`, `site-site-polish-brainstorm`, `site-docs-{brainstorm,lead}`, `plugins-empty-p-{brainstorm,lead}`. **Dormant Overlord/RiffBot/Bugs pills no longer exist** under Other projects (the L2 filter keeps a Trinity row only if it is live or needs you), so the R1 split-folding path can't be reached. If a dormant Trinity row does need you, it goes through the same `openOtherDormant(tid, {key:"_overlord"|"_bugs", …})` as the lanes (`src/BoringAde.tsx:833-852`). That is the same right-card renderer the same-project dormant Overlord card uses, and that card was verified working here (`VibeSquad › Overlord`, right pane).

| Click | URL after | Breadcrumb | Panes | Left pane | Right pane |
|---|---|---|---|---|---|
| Dormant `Main Game · UI-lab · Buddy` | `?team=efi&agent=demo-aud` | `Main Game › UI-lab` | left,right | Audit (unchanged, Allow/Deny intact) | `UI-lab · No Brainstorm session… [Start Brainstorm]`, plus "Available in this lane: Lead" |
| Dormant `Site · site-polish · Buddy` | `?team=site&agent=demo-aud` | `Site › site-polish` | left,right | Audit | site-polish Brainstorm card |
| Dormant `Site · docs · Lead` | `?team=site&agent=demo-aud` | `Site › docs` | left,right | Audit | `docs · No Lead is running yet… [Switch to Brainstorm]` |
| Dormant `Site · docs · Buddy` | same | `Site › docs` | left,right | Audit | docs Brainstorm card |
| Dormant `Plugins · empty-p · Lead` | `?team=plugins&agent=demo-aud` | `Plugins › empty-p` | left,right | Audit | empty-p Lead card |
| Live `Main Game · main-game · Buddy` | `?team=efi&agent=demo-bs-efi-1` | `Main Game › main-game › Brainstorm` | left,right | Audit | live Brainstorm chat; the sidebar row is selected |
| Live `Plugins · ★ Overlord` | `?team=plugins&agent=demo-lead-pl` | `Plugins › Desk › Overlord` | left,right | Audit | live Overlord; `★ Overlord` row selected |

Follow-ons inside the cross-project card: `Switch to Brainstorm` swaps to that lane's Buddy card in the right pane (split stays). `← All lanes` returns to the **switched** project's picker (`Site › Split · pick an agent`), whose Other projects now lists VibeSquad (`5 needs you`). Both are consistent (`r2/2560-dark-cross-card-switch-to-buddy.png`, `r2/2560-dark-cross-all-lanes.png`).

**Normal project switch still clears the right card.** Cross-project card → click the `Main Game` name in the sidebar lands on `?team=efi` `Main Game › Overview` with no panes (`r2/2560-dark-switch-after-dormant.png`). Same-project dormant Overlord card → click `Site` lands on `Site › Overview`. Going back to VibeSquad's Audit then shows the split with a **fresh picker**, not the stale card.

**Back/Forward/reload:**

| Step | Dormant cross-project card | Live cross-project pill |
|---|---|---|
| Back | `?team=vibesquad&agent=demo-aud`, split + VibeSquad picker. Correct. | Back to VibeSquad; right pane keeps the live agent (pane-local, as at B17). |
| Forward | `?team=vibesquad&agent=demo-aud`, split + **VibeSquad picker**. The Site card is not restored (L4). | Restores `?team=plugins&agent=demo-lead-pl`. |
| Reload | Lands on `VibeSquad › Desk › Worker` (Audit, single pane). The split is dropped. | Split + both agents survive. |

The reload behaviour is **pre-existing, not a regression**. A split whose right side is the picker or a pane-local card doesn't survive reload at all: plain picker → reload gives `panes=""`, and same-project dormant Overlord card → reload gives `panes=""` (`r2c.mjs`). The cross-project card now behaves exactly like the same-project card, and the left agent is kept (R1 lost it, landing on `Site › Overview`). Deep-linking the intermediate URL `?team=site&agent=demo-aud` normalises to `team=vibesquad`, which is why Forward appears to do nothing.

### B18a regression (1280x720, 2560x1440, 3200x1800 @1.2 DPR; dark + light)

| Check | R1 (`3b536c80`) | R2 (`5a020127`) |
|---|---|---|
| Pin closed/open, tree closed/open, footer bottom (1280) | 60/220, 120/120, 911 | **identical** |
| same (2560) | 60/561, 649/148, 1424 | **identical** |
| same (4K) | 60/561, 1009/508, 1784 | **identical** |
| Tree fade + seam (`treeMid` scroll 168/456 at 1280) | ok | **identical** (`r2/1280-{dark,light}-sidebar-tree-mid.png`) |
| Min contrast dark: pin / open / ctx / split | 4.69 / 5.53 / 5.32 / 8.89 | **identical** at all 3 sizes |
| Min contrast light: pin / open / ctx / split | 5.07 / 6.14 / 5.33 / 4.95 | **identical** at all 3 sizes |
| Dormant ui-lab Buddy path at each size/theme | n/a (broken) | split kept, `?team=efi&agent=demo-aud`, `Main Game › UI-lab` at all 6 (`r2/{1280-dark,4k-light}-after-dormant-efi-ui-lab-brainstorm.png`) |

### Round 2 findings

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| L4 | Minor | A dormant cross-project click pushes a history entry, `?team=<other>&agent=<left agent>`, that the app can't reproduce: Forward and deep-link normalise it back to the left agent's project and show the old project's picker. Back works correctly. Harmless (nothing is lost), but Forward looks like a no-op. | Browser nav in split | Back/Forward table; `r2c.mjs` `deepLinkCross` | Optional: `replaceState` instead of `pushState` for the `onSelectSquad` from `openOtherDormant`, so the pane-local card adds no history step, matching the same-project card. Or accept it. | `src/BoringAde.tsx:833-837` (or the squad-select URL writer) | XS |

Checked, no issue: exactly one selected row on live opens. Zero selected rows on dormant cards and on the plain picker is B17 behaviour, the same as same-project cards. The breadcrumb names the switched project and lane on every dormant path. No agent is listed more than twice. No new truncation. The Other-projects badge (`1 needs you`) agrees with Main Game's `main-game · Needs you` row.

### Round 2 verdict

M1 is fixed on every reachable path: the split is kept, the left pane and `&agent=` are kept, the card shows in the right pane, and the breadcrumb names the switched project. L2 is fixed. B18a shows no regression: geometry and contrast are identical at all 6 size/theme combos. One new minor (L4, history Forward). L1/L3 were accepted by the lane.

PASS 0/0/1 5a020127
