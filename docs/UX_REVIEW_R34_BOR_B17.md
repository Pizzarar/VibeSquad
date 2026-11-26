# UX Review R34: @bor B17 Normal-mode deadspace (idea-1052)

Scope: B17 commit `e7382b68` on top of the `48ecfc07` merge (`src/BoringPanePicker.tsx` new, `src/BoringAde.tsx` B17 hunks, the `src/boring.css` B17 block plus `--measure-col`/`--measure-prose`). The project-order/O2 hunks in `48ecfc07..e7382b68` come from the base merge and are not reviewed here.

Evidence:
- Lane shots: `artifacts/boring-b17/*.png` (4K dark+light chat/split/empty, 1280x720 dark).
- My re-renders from the built `dist` (`?demo=1&riff=1&team=vibesquad&agent=demo-impl-1`), in `artifacts/boring-b17/ux-r34/` (untracked, same as the lane shots):
  - `chat-dark-2560x1440.png`
  - `split-dark-2560x1440.png`
  - `split-light-2560x1440.png`
  - `dead-boring-pp-open-plugins-brainstorm.png`
- DOM measurements and contrast came from Playwright scripts (numbers below).
- Out of scope: BoringContextPanel Workers rows overlap (@bug idea-985).

Jobs judged: "see what needs me and act" (Needs-you → open), "open any lane/agent next to the current one" (Split), "an empty lane is not a dead end".

## Status vs previous round (R30 @bor B16)

| Prior | Status | Evidence |
|---|---|---|
| R30 L2: composer wraps to 3 rows at narrow widths | Open, minor (pre-existing) | `split-light-2560x1440.png`: in the ~780px left split pane, `Mode` drops to its own row under the provider selects. |
| R30 L5: Mode wraps at ~550px | Open, minor (pre-existing) | Same shot. |

## Part A: fluid chat column

Measured at 2560x1440, ctx panel open:
- `.timeline` is 380→2100 (1720px).
- Column (`tl-pinned-todo`, `.composer > *`) is 560→1920, which is exactly 1360px, so the margins are 180px per side. Before B17 they were (1720−880)/2 = 420px.
- `pre`/tool block is 591→1908.
- User bubble right edge is 1920, the same as the column.
- The timeline, pinned-todo, composer, perm card and tool-block edges line up (4K shot: the perm card, tool block and composer all end at x≈1400 display).

1440p, the owner's main complaint: **fixed.** The 180px margins read as normal gutters.

4K@120% (3200 CSS px): the chat area is ~2355 CSS px wide, so the 1360 cap still leaves **~500 CSS px (~600 physical px) blank on each side** (`chat-dark-3840x2160.png`: column 550→1400 of the 240→1712 area). That is better than the ~740 CSS px before, but it does not meet "4K stopped leaving 600-800px margins". See Owner decision D1.

Prose (960) vs column (1360): assistant paragraphs stop about 400px short of the tool-block and perm-card right edge. This reads as a normal reading measure next to full-width code, not as misalignment, because headers, avatars and left edges stay aligned. Acceptable; no finding.

## Findings

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| M1 | **Major** | The picker's **"Needs you · Active now"** strip leaves out most of what needs you. The sidebar shows **Needs you 6**: Audit token scout (Allow/Deny), Review-Sonnet drawer, Review-Gemini retry, Bug Runner triage, Lead 75 and more. The strip shows exactly **one** needs-you item (`Buddy · Bug Chaser`), then three "Working" items. The Desk card badge says **4**, but the picker's ★ Overlord row is not marked attn. So counts disagree across the window, and the one-click "open what needs me on the right" path, the strip's whole purpose, is missing for Desk workers. In the lane's own 4K shot, all 4 Needs-you items were Desk workers and the strip showed only `Implement - overlap guard · Working`. | Needs-you → act; split triage | `split-dark/light-2560x1440.png` vs the sidebar in the same shot; `split-dark-3840x2160.png`. Cause: `buildPickerData` (`src/BoringPanePicker.tsx:33-67`) pushes needs only from lane Lead/Brainstorm `needsYou` and core `needsYou`. Workers are pushed only when `status === "running"`, always with `needs=false` (L60), and Desk workers are never read. | Build the strip from the same `NeedsYouRow` list the sidebar Needs-you uses (current project first, optionally other projects tagged), then append Working items. Assert in a test that the strip's needs count equals the sidebar's. | `BoringPanePicker.tsx`, `BoringAde.tsx` (pass needs rows) | S |
| M2 | **Major** | Lane names in the picker grid get cut down to **one letter** at 1440p: `R.` (Runner Pilot), `B…` (Bug Chaser), and Art Direction shows only its glyph. Meanwhile the less important `@runner-pilot` code, the `No agent` status and both pills stay at full width. Measured name widths are `Art Direction 6/78px`, `Runner Pilot 12/74`, `Bug Chaser 17/72`. The name is the thing you pick by, and it is the part that gets truncated. | Pick a lane | `split-light-2560x1440.png` (right pane, rows 2-4). Cause: `src/boring.css:1531` `minmax(min(100%,340px),1fr)` gives three ~350px columns in the 1090px pane. `.boring-pp-name` (L1533) is the only shrinkable child, while `.boring-pp-code`, `.boring-pp-sub` and `.boring-pp-pills` are all `flex: 0 0 auto`. | Make the name non-shrinking (`flex: 0 1 auto; min-width: 10ch`) and let the code shrink or hide first, or use two lines per card (name + code, then status), or raise the minmax to ~420px. | `boring.css` | XS |
| M3 | **Major** | **Dead pills are silent no-ops.** In the demo, 7 of 10 lanes show a non-live `Buddy` pill (and Bugs a non-live `Open`). It looks like a button with a hover state and no disabled styling. Clicking it changes nothing: the picker stays, the breadcrumb stays `Split · pick an agent`, and there is no empty card and no toast. The plan promised "any lane opens in 1 click". In the lane's 4K shot every Desk row says `No agent` with an `Open` pill, so most of the grid is dead. | Pick a lane | Playwright: after clicking `boring-pp-open-plugins-brainstorm` and `boring-pp-open-_bugs-open`, the result is `{picker:true, crumb:"VibeSquad›Split · pick an agent", empty:null}`. Screenshot: `dead-boring-pp-open-plugins-brainstorm.png`. Cause: `pickRole` → `onOpenPin` = `focusPin`, which never spawns (`src/BoringAde.tsx:541`, comment at L297), and the right pane stays on the picker because `splitEmptyActive` is keyed only on `!activeAgentId` (L649). | Choose one: (a) a non-live pill shows that lane's empty card (with Start CTA and quick-jumps) in the pane; or (b) render it as `Start Buddy`/`Start Lead` and actually spawn; or at least (c) disable it visibly with `title="No Buddy running"`. Recommend (a): it matches what a plain sidebar click does. | `BoringAde.tsx`, `BoringPanePicker.tsx` | S |
| L1 | Minor | The lane status word ignores the Lead. `Art Direction · No agent` is shown next to a **live** (accent) `Lead` pill. The sidebar lists `Lead · 8m ago`, and the empty card offers `Open the Lead · Idle`. | Pick a lane | `split-dark-3840x2160.png` rows Art Direction / Runner Pilot / wiki. Cause: `BoringPanePicker.tsx:56-58`: `status` comes from `brainstormStatus` only. | Derive the status from both roles (e.g. `Lead idle`, `Buddy working`). | `BoringPanePicker.tsx` | XS |
| L2 | Minor | The picker has no keyboard support. Focus stays on `◫ Unsplit` after splitting. ArrowDown in the filter does nothing, Enter on a single filter match does nothing (the picker stays), and Esc neither clears the filter nor closes the split. Tab order through the buttons works. | Keyboard-driven open | Playwright: `focus after split = boring-split-toggle`; `filter "ui" → 1 match; Enter → picker still true; Esc → split still true`. | Autofocus the filter when the picker mounts. Enter opens the first match's live target. Esc clears the filter, then a second Esc closes the split. Optionally, arrows move through the cards. | `BoringPanePicker.tsx` | S |
| L3 | Minor | The filter placeholder contrast in dark is **3.91:1**, below 4.5. Light is 4.61. All other picker text measures 7.9-17:1 in both themes. | Readability | Contrast script (`.boring-pp-filter::placeholder`). | Use `--text-2` for the placeholder. | `boring.css` | XS |
| L4 | Minor | The right pane is still about 70% empty below the grid at 1440p and 4K (one project with 10 lanes). It is no longer a void (header, filter and Close split are all useful), but the lower area could hold a "Recent in this pane" list or the other projects' lanes. Tap targets: pills are 32px and cards 40-50px, fine for desktop and below 44px for touch. | Split | `split-*-2560x1440.png`, `split-dark-3840x2160.png`. | Optional: add recent agents and other projects (collapsed). | `BoringPanePicker.tsx` | M |
| L5 | Minor | The empty card's quick-jump copy mixes styles. Inside the lane the labels are verbs (`Open the Lead`), while under Other active lanes they are bare names (`UI Bois`). The head strip says `no Lead or Brainstorm running` directly above `Open the Lead · Idle`, which reads as a contradiction until you parse "idle ≠ running". The card is left-aligned with a clear hierarchy, and that part is good. | Empty lane | `empty-light-3840x2160.png`. | Use one pattern (`Lead · Idle`, `UI Bois · Working`), and change the head to `Art Direction · Lead idle · no Brainstorm`. | `BoringAde.tsx`, `BoringPanePicker.tsx` | XS |

## Checked, no issue
- Breadcrumb `Split · pick an agent` while the picker pane is active, with the sidebar selection cleared: this is consistent with the active-pane-owns-the-breadcrumb rule (`BoringAde.tsx:649-663`). Clicking a **live** target (★ Overlord `Open`, an Active strip card) opens it in the right pane. The picker disappears and the breadcrumb becomes `Desk › Overlord`.
- Filter: instant, case-insensitive, matches the name and code. The no-match message is shown.
- Light and dark text contrast on the picker: headings 8.5/10.5, sub/code 9.2/10.1, non-live pill 7.9/9.4, live pill 14.8/14.9, name 17.1/16.1.
- 1280x720: the lane shots show the column filling the pane and the picker in one column with no clipping.
- Psycho: no B17 rule outside `html[data-vibe="boring"]`.

## Owner decisions
- **D1: 4K measure cap.** At 4K@120% the 1360px cap still leaves ~500 CSS px per side. Options: (a) keep 1360 (prose is capped at 960 anyway, so only tool, code and perm blocks would gain); (b) raise `--measure-col` to `clamp(880px, 90%, 1680px)` so tool and diff blocks use the width while prose stays 960; (c) fill the leftover space with the ctx panel or a wider right dock by default at ≥3000px. **Recommend (b).** Terminal output and diffs are where width pays off. Prose stays readable, and the remaining gutter at 4K drops to ~340 CSS px.

## Verdict
M1 (Needs-you strip misses Desk/worker needs, so counts disagree), M2 (lane names truncated to one letter at 1440p) and M3 (dead pills do nothing) are open. **FAIL 0/3/5.** All fixes are XS-S and contained in `BoringPanePicker.tsx`, `boring.css` and one `BoringAde.tsx` hunk. Part A (fluid column) passes for 1440p.

---

# R34 r2: fix tip `9d37f43e`

Scope: `git diff 751078a2..9d37f43e` (`BoringPanePicker.tsx`, the B17 hunks in `BoringAde.tsx`, and `boring.css` for the picker, the container measure and the cap of 1680).

Evidence: `dist` was rebuilt from `9d37f43e` (`vite build`) and served as static files, then opened at `?demo=1&riff=1&team=vibesquad&agent=demo-impl-1` with Playwright on Chromium 158. Viewports: 1280x720, 1600x900, 2560x1440 and 3200x1800@1.2 (4K at 120%), each in dark and light. Each one was measured with the ctx panel open, then collapsed, then in a split with the right pane (no ctx panel). Shots are in `artifacts/boring-b17/ux-r34r2/` (untracked, like the lane shots): `chat-ctxopen-*`, `chat-ctxcollapsed-*`, `split-picker-*`, `split-open-*`, `ov-*` (overlays), and `pk-*` (picker flows).

## Status vs R34

| R34 | Status | Evidence |
|---|---|---|
| M1 Needs-you strip misses Desk/worker needs | **Fixed** | Strip at 2560 (all themes and sizes): 5 needs (Audit token scout, Review-Sonnet, Bug Runner, Review-Gemini, Mechanical stalled), then 12 Working. That matches the 5 VibeSquad rows in the sidebar's Needs you **6** (the 6th is `Lead 75`, Main Game Project; see N4) and the Desk badge **4** (the 4 Desk items). |
| M2 Lane names cut to one letter | **Fixed** | No lane name is truncated at any size (`scrollWidth == width`). The smallest is `Art Direction` 114px at 4K and `Runner Pilot` 118px at 1280. The riffbot card wraps its pills to a second line instead of squeezing the name. |
| M3 Dead pills are silent no-ops | **Fixed, but see M4** | Clicking `Plugins · Buddy` (dormant) shows the empty card in the pane with `← All lanes`, `Start Brainstorm`, `Available in this lane: Lead · Idle`, and `Other active lanes: Bug Chaser · Needs you` (`pk-dormant-dark-2560.png`, `pk-dormant-light-3200.png`). The quick-jumps open in the right pane and keep the split: `Plugins›Lead` and `Bug Chaser›Brainstorm`, both with split on. |
| L1 Status ignores the Lead | **Fixed** | `@plugins Lead idle`, and `@riffbot Lead working · Buddy working`. |
| L2 No keyboard | **Fixed** (one gap: N5) | The filter has focus on mount. Esc returns from the empty card to the grid, then clears the filter, then closes the split. Typing `ui-bois` + Enter opens `UI Bois›Lead` on the right. After a dormant pill, focus moves to `← All lanes` and returns to the filter on Back. |
| L3 Placeholder contrast | **Fixed** | `::placeholder` now uses `--text-2` (the same token as subs, which measured 9.2/10.1 in R34). |
| L4 Pane ~70% empty below the grid | **Open, minor** (skipped by the lane) | `split-picker-light-3200x1800.png`: the grid ends at ~40% of the pane height. |
| L5 Quick-jump copy | **Fixed** | The jumps read `Lead · Idle` / `Brainstorm · …` / `Bug Chaser · Needs you`. The lane-head strip is role-aware (`Lead idle · no Brainstorm`, `BoringAde.tsx:1230`). |
| D1 4K cap | **Applied by the lead** | See Part A. |

## Part A: container measure + cap at 1680 (column / timeline in CSS px)

| Viewport | ctx open | ctx collapsed | split, each pane |
|---|---|---|---|
| 1280x720 | 482 / 530 (gutters 24) | 880 / 954 | 447 / 495 |
| 1600x900 | 802 / 850 | 1147 / 1274 | 607 / 655 |
| 2560x1440 | 1548 / 1720 (gutters 86) | 1680 / 2144 (gutters 232) | 981 / 1090 |
| 3200x1800 (4K@120%) | **1680 / 2360 (gutters 340)** | 1680 / 2784 (gutters 552) | 1269 / 1410 |

- At every size, theme and state, the pinned-todo, composer child, perm card (right pane) and user-bubble right edges are identical, and `pre` is inset by the same ~12px. The `min(…, 100cqw − ctx − 48px)` clamp stops the column from overflowing at 1280 with the ctx open (482 inside 530), and that state is not cramped.
- **The 1680 column with 960 prose at 4K:** the tool and diff blocks use 1637px. The PowerShell block reads as a proper terminal, and the 4K ctx-open gutter (340 CSS px) reads as margin rather than void (`chat-ctxopen-dark-3200x1800.png`). Assistant prose stops 720px short of the column's right edge. That is acceptable because the left edges, avatars and headers line up, and the 960 measure is right for reading. A side effect: at 4K the user bubble (1760→2400) and the replies (778→1738) no longer overlap horizontally, so the eye zig-zags ~1000px per turn. This is not a finding; see D2.
- With the ctx panel collapsed at 4K, the gutters are 552 CSS px per side (~660 physical px), which is back in the "600-800px margins" range the owner complained about. Prose is unaffected. This is a consequence of the cap the lead chose; see D2.

## Overlays inside the container (`.drawer { container-type: inline-size }`)

- **Probe:** a `position:fixed; top:0; left:0` div appended inside `.boring-convo-col` lands at **(0,0)**, while the drawer is at (380,48). So in Chromium 158 the container is **not** the containing block for fixed descendants, and `overflow` is `visible`.
- Opened each overlay and hit-tested its centre (it must hit itself, not something covering it):

| Overlay | Position | Result |
|---|---|---|
| Header `⋯` agent menu (`boring-agent-menu`) | absolute, inside the drawer | In the viewport and hits itself at 1280, 2560 and 4K. |
| Ref popover (hover on `msg:-1`) | fixed, portalled | Correct coordinates; hits itself at all 3 sizes. |
| Timeline context menu (`custom-context-menu`) | fixed, portalled | Correct coordinates at 4K. |
| Secure-input popover, slash menu, `@` mention menu | in-flow (relative) | Render above the composer at the column width and hit themselves (`ov-secret-dark-1280.png`). |
| Model / Think / Mode | native `<select>` | Unaffected. |
| Toasts (`brainstorm-inbox-toast`) | in-flow | Unaffected. |

**No overlay regression.** Residual risk: I did not test the Tauri Linux WebKitGTK webview. Older engines applied layout containment for `container-type`, which would trap fixed overlays (`ref-popover` and `ctx-menu` are portalled, so they are safe; the menu built on `.drawer-features-menu` (`styles.css:4532`) is phone-only). Windows WebView2 is evergreen Chromium.

## New findings

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| M4 | **Major** | **`Start Brainstorm` in the right pane tears the split down.** The R34 M3 fix puts the lane's empty card in the right pane, and its primary CTA is Start. Clicking it starts the Brainstorm, but the split collapses: `split=false`, the crumb goes to `Plugins›Brainstorm`, and the left agent (`Implement - drawer crash`) is replaced. For 7 of 10 lanes in the demo that is the only way to get a running agent, so "open a lane **next to** the current one" still fails for dormant lanes. The quick-jumps in the same card do keep the split. | Split; open any lane next to the current one | `pk2` run at 4K light: `dormant → start: {"splitOn":"false","crumb":"VibeSquad›Plugins›Brainstorm","drawers":["○"]}` vs `lead-jump: {"splitOn":"true","crumb":"VibeSquad›Plugins›Lead"}`; `pk-start-light-3200.png`. Cause: the pane reuses the main-pane `emptyCard()` (`BoringAde.tsx:723-739`), whose `spec.run` → `startBrainstorm` (`:683`, `:692`) is not pane-aware. When the new agent lands, it becomes the main selection and the split state is dropped. | When the card is rendered by the picker (`renderEmpty`), run the start, then open the new Brainstorm in the **right** pane (the same path as `pickerHandlers.openAgent`), leaving the left pane as it was. Add a test: dormant pill → Start → split stays on and the right pane holds the new agent. | `BoringAde.tsx` (pass a pane-aware start into `emptyCard`, e.g. `emptyCard({ inPane: true })`) | S |
| N2 | Minor | The in-pane empty card never names the lane. After clicking `Plugins · Buddy`, the pane says `No Brainstorm session is running for this conversation yet.` The crumb stays `Split · pick an agent`, nothing in the sidebar is selected, and the only clue is the top-bar `Brainstorm \| Lead · idle` switcher, which now refers to Plugins without saying so. On a mis-click you cannot tell which lane you are looking at. | Pick a lane | `pk-dormant-dark-2560.png`; state `crumb:"VibeSquad›Split · pick an agent", sel:[]`. | Put the lane in the card head (`Plugins · @plugins · Lead idle · no Brainstorm`) next to `← All lanes`, or set the crumb to `Split › Plugins`. | `BoringPanePicker.tsx` (empty branch), `BoringAde.tsx` | XS |
| N3 | Minor | The strip labels ★ Overlord as **`Lead · Desk`**. The sidebar, the Desk card and the lanes grid all say `★ Overlord`. | Pick an agent | `split-picker-light-3200x1800.png`, strip row 2. Cause: `pickerStrip` (`BoringAde.tsx:717`) maps `kind === "lead"` to `Lead · <lane name ?? "Desk">`. | Use the shared display-name helper the sidebar uses for core agents (`★ Overlord`, `RiffBot`). | `BoringAde.tsx` | XS |
| N4 | Minor | The strip is scoped to the current project, so `Lead 75` (Main Game Project, which needs you) is in the sidebar's **6** but not in the strip's 5. The strip shows no count, so no number disagrees, but "open what needs me on the right" skips other projects. | Needs-you → act | Sidebar `boring-needs-you-count = 6` vs 5 strip needs items. `needsYouRows([view], …)` at `BoringAde.tsx:714`. | Append other projects' rows tagged `· Main Game Project`, or add `+1 in other projects`. | `BoringAde.tsx` | XS |
| N5 | Minor | When Esc closes the split, focus is dropped to `<body>` instead of returning to `◫ Split`. The next Tab starts from the top of the document. | Keyboard-driven open | `esc-close {"split":false,"focus":"BODY"}`. | `onClose` → focus `[data-testid=boring-split-toggle]` (use `captureFocusReturn`). | `BoringAde.tsx:762` | XS |
| N6 | Minor (code) | `.boring-pp-agent` declares `max-width` twice. The later `max-width: 100%` overrides the new `min(100%, 640px)`, so the claimed strip-chip cap does nothing. It is harmless today (the longest chip is ~400px, and long subs ellipsize with a `title`). | none | `boring.css:1528`. | Drop the trailing `max-width: 100%`. | `boring.css` | XS |

Still open from earlier rounds (pre-existing, not counted): R30 L2/L5. At 1280 the composer wraps `Mode` onto a second row (`ov-secret-dark-1280.png`).

## Fresh eyes on the picker
- The order works: the strip has needs items first, with an amber border, then Working items. The lanes grid comes next, then the hint. The filter gets focus on open, and the Close split control is in the head.
- 17 strip chips at 4K wrap to 5 rows, which is busy but scannable. Above ~20 items, consider folding the Working items behind `+N working`. This is not a finding.
- Dormant pills look visibly quieter than live pills (border only vs accent), and their aria-label says `(not running)`. Combined with the empty-card landing, the R34 M3 "looks clickable, does nothing" problem is gone.

## Owner decisions
- **D2: the remaining 4K gutter.** With the cap at 1680, 4K ctx-open looks right (340 CSS px gutters), but 4K ctx-collapsed is back to 552 CSS px per side. Options: (a) accept it, since collapsing the ctx panel is a choice to have more room around the chat; (b) when the ctx panel is collapsed and the viewport is ≥3000px, raise the cap to ~2000px for tool and diff blocks only (prose stays 960); (c) right-align the user bubble to the prose measure (960) instead of the column edge, which removes the ~1000px zig-zag at 4K. **Recommend (a) + (c).** (c) is a one-rule change and fixes the more noticeable 4K oddity; more width for blocks has diminishing returns because demo terminal lines are under 80 chars.

## Verdict
R34 M1, M2 and M3 are fixed, as are L1, L2, L3 and L5. The container measure is aligned at every size, theme and ctx state, and `container-type` did not break any overlay. The fix round adds **M4**: the in-pane `Start Brainstorm` collapses the split, so dormant lanes still cannot be started next to the current agent. **FAIL 0/1/6** (M4; N2-N6 + L4). The M4 fix is S and lives in one `BoringAde.tsx` hunk.

---

# R34 r3: fix tip `481bdb31`

Scope: `git diff 4e36a9f7^..481bdb31` (`BoringAde.tsx`, `BoringPanePicker.tsx`, `pinFocus.ts`, `App.tsx`, `boring.css`). `f0f0c39b` merged origin/master and is not reviewed here.

Evidence: I rebuilt `dist` from `481bdb31` (`vite build`) and drove it with Playwright on Chromium at `?demo=1&riff=1&team=vibesquad&agent=demo-impl-1`. Viewports were 1280x720, 2560x1440 and 3200x1800@1.2 (4K at 120%), in dark and light, with the ctx panel open and collapsed. Each scenario ran in a fresh context. Shots are in `artifacts/boring-b17/ux-r34r3/` (untracked, as in earlier rounds): `chat-ctxopen-*`, `chat-ctxcollapsed-*`, `split-picker-*`, `split-wiki-card-*`, `split-bugs-card-*`, `split-switch-bs-*`, `split-wiki-start-*` and `m4-start-*`. `node --test test/bor-b17-deadspace.test.mjs` passes 8/8.

## Status vs R34 r2

| r2 | Status | Evidence |
|---|---|---|
| **M4** In-pane Start collapses the split | **Still open for every Start.** Fixed for Switch to Brainstorm and the quick-jumps. | **Start Brainstorm (wiki card), live, at all 6 viewport/theme combos:** a DOM timeline shows `[0ms split=true card=true agent=demo-impl-1]`, then `[83ms split=false card=false agent=demo-bs-wiki-…]`. The crumb becomes `VibeSquad›wiki›Brainstorm` and the left agent (`Implement - drawer crash`) is replaced (`m4-start-wiki-brainstorm-dark-2560x1440.png`, `split-wiki-start-*`). **Start Brainstorm on the Bugs card** does the same at 95ms (`m4-start-_bugs-open-dark-2560x1440.png`). **Switch to Brainstorm** (dormant Bug Chaser Lead pill) keeps the split: `Bug Chaser›Brainstorm` opens on the right. The **quick-jump** `UI Bois · Lead idle` from the Bugs card also keeps the split, with `UI Bois›Lead` on the right. **Start RiffBot** cannot be reached in the demo (RiffBot is running), but by code it takes the same `spinUpPin` path, so it folds the same way. **Start Overlord** (`BoringAde.tsx:699`) opens via `openAgentInTab(id,"right")` after the spawn resolves and does not go through pinFocus. By code it is OK, but I could not verify it live. |
| N2 Card never names the lane | **Fixed** | The card head shows `wiki` / `Bugs` / `Bug Chaser` (`boring-empty-lane`), and the crumb is `VibeSquad›wiki` while the right pane is active (`split-wiki-card-light-3200x1800.png`). |
| M2 (Gemini r3) Right card is pane-local | **Fixed** | Wiki card on the right, then a click in `boring-pane-left`: the card still says `wiki` and the crumb follows the left pane (`Desk›Worker`, with `boring-worker-demo-impl-1` the only selected row). Clicking back into the right pane restores the crumb to `VibeSquad›wiki`. Same at all 6 combos. |
| N3 Strip labels | **Mostly fixed**, with a residual (N7) | The strip reads `Overlord`, `RiffBot`, and `Bug Runner · triage — Bug Chaser · Pick the batch…` (no lane repeated). `Review - Gemini · retry` gets `st-err` (red dot) while the other needs get `st-attn`. The residual is N7. |
| N4 Strip is scoped to the current project | Open (code unchanged). Not reproducible in today's demo: the sidebar shows **Needs you 5** and the strip has 5 needs items. | `pickerStrip` still calls `needsYouRows([view], …)` (`BoringAde.tsx:724`). |
| N5 Esc drops focus to body | **Fixed** | Esc → `activeElement = boring-split-toggle`, and the next Tab goes to `boring-details-toggle`. The `Close split` button also returns focus to `boring-split-toggle`. |
| N6 Duplicate max-width | **Fixed** | The computed `max-width` of `.boring-pp-agent` is `min(100%, 640px)`. |
| L4 Pane ~60% empty below the grid | Open (not addressed) | `split-picker-light-3200x1800.png` |

## D2 (lead decision): cap 1680, user bubble right-aligned to the 960 prose measure

Measured in CSS px (left, right):

| Viewport | ctx | user row | prose | `pre` |
|---|---|---|---|---|
| 2560x1440 | open | 786–1426 | 524–1484 | 497–2002 |
| 2560x1440 | collapsed | 932–1572 | 670–1630 | 643–2280 |
| 4K@120% | open | 1040–1680 | 778–1738 | 751–2388 |
| 4K@120% | collapsed | 1252–1892 | 990–1950 | 963–2600 |
| 1280x720 | both | right edge within 13px of prose | | |

**It reads well.** At 4K the bubble now sits above the reply it prompted, instead of ~1000px away at the column edge. The eye no longer zig-zags, and tool/diff blocks still use the 1637px block width (`chat-ctxopen-dark-3200x1800.png`). At ≥2560 the bubble's right edge stops **58px short** of the prose right edge, because the formula measures from the column's left edge and ignores the avatar gutter. This is cosmetic, and it is N8. The 1680 cap with ctx collapsed at 4K still leaves wide gutters, as recorded in r2. That is the lead's call, and prose is unaffected.

## Regression pass
- **Column alignment:** the lane's browser test (composer / perm card / pinned todo edges at every size, cap 1680) passes. `pre` stays inset ~27px from the prose left at every size, the same as in r2.
- **Popovers:** the header `⋯` menu (`boring-agent-menu`) and the `msg:-1` ref popover hit themselves and are in the viewport at 1280 and at 4K. The timeline context menu does the same at 4K. No page errors in any run.

## New findings

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| M4 (reopened) | **Major** | **Start Brainstorm / Start Bugs (and, by code, Start RiffBot) on the right card still fold the split and replace the left agent.** The r3 wiring (`spinUpPin(…, "right")` → `show(id,"right")`) is correct in isolation, but it never runs. `spinUpPin` first sets the pinFocus `focus` with `agentId: null, held: leftActiveId`. `quickStart` then upserts the new Buddy into the store (`pinActions.ts:140`, before it returns). `subscribePaseo(reconcile)` (`pinFocus.ts:140`) fires, and `reconcilePinFocus` returns `follow`, with `open = active(leftActiveId) !== live && !inLane`, which is true (`pinFocusLogic.ts:31`). So `reconcile` calls `show(d.agentId)` **without `into`** (`pinFocus.ts:132`), which hits `toggleSplit()` + `openAgent()`. When `spinUpPin` gets to `show(id, into)`, `f.agentId === id` already, so it is skipped. The same race happens in production, because the daemon push or `onSpawned` lands before the promise resolves. Test 5 (`r3: Start Brainstorm from the right pane keeps the split`) only regex-matches the source; no browser test clicks Start. | Split: start a dormant lane next to the current agent | DOM timeline above; `m4-start-*`, `split-wiki-start-*` at all 6 combos | Carry the target through the focus: store `into` on `focus` in `spinUpPin`, and have `reconcile` call `show(d.agentId, f.into)`. Or, for `into === "right"`, skip the pinFocus focus entirely, since Boring does not use the sky focus, and just `openAgentInTab(id,"right")` after `openPin` resolves. Add a **browser** test: demo, split, wiki Buddy pill, Start, then assert `boring-chat-split` is present, the right pane holds `demo-bs-wiki-*`, and the left pane is still `demo-impl-1` (the demo fakes the spawn, so this runs headless). Repeat for the Bugs card. | `pinFocus.ts` (`spinUpPin`, `reconcile`), `test/bor-b17-deadspace.test.mjs` | S |
| N7 | Minor | The strip shows a **`Lead · Lane`** chip for a lead with no lane label (demo `demo-lead-vs`, `★ VIBESQUAD ord1`, a lane-less Squad lead). Clicking it lands on crumb `Desk›Lead`. `Lane` is a placeholder word, not a name. | Pick an agent | `split-picker-dark-1280x720.png`, strip row 6. `memberTitle` falls back to `n ?? "Lane"` (`BoringAde.tsx:733`). | When `laneName` is null, fall back to `m.agent.title` (or `Lead · Desk` to match the crumb). | `BoringAde.tsx` | XS |
| N8 | Minor | At ≥2560 the D2 user bubble ends 58px short of the prose right edge (1426 vs 1484 at 2560, 1680 vs 1738 at 4K). The formula `(100% − col)/2 + col − prose` ignores the avatar/name gutter that offsets prose from the column's left edge. It is close enough to read as "beside the reply", but it misses by one avatar width. | none (polish) | D2 table | Subtract the prose's left inset (e.g. `− var(--tl-gutter)`), or align on the prose box. | `boring.css:1554` | XS |

## Owner decisions
None new. D2 as applied reads well (see above).

## Verdict
N2, N5, N6 and the Gemini M2 pane-locality are fixed, and so is most of N3. Switch to Brainstorm and the quick-jumps now keep the split. **M4 is still open for every Start action:** live, Start Brainstorm on the wiki and Bugs cards folds the split within ~90ms and replaces the left agent, because pinFocus `reconcile` follows the new Buddy without the `"right"` target. Its test only regex-checks the source. **FAIL 0/1/4** (M4; N4, N7, N8, L4). The fix is S, in `pinFocus.ts`, plus one headless browser test.

---

# R34 r4: fix tip `b11a63cb`

Scope: `git diff 42f27c7b..b11a63cb` (`pinFocus.ts`, `BoringAde.tsx`, `boring.css`, `test/bor-b17-deadspace.test.mjs`).

Evidence: I rebuilt `dist` from `b11a63cb` and drove it with Playwright on Chromium at 1280x720, 2560x1440 and 3200x1800@1.2 (4K at 120%), dark and light. Each run used a fresh context. Two demo setups:
- **Plain demo** (`?demo=1&riff=1&team=vibesquad&agent=demo-impl-1`, 3 projects). This is the r3 condition.
- **Routed demo** (`installRoutes`, `?demo=1`). Here RiffBot and Overlord are dormant, so their Start buttons can be reached.

A 10ms DOM poller records split, left id, right id, card and crumb for 2–2.5s after each click. Shots are in `artifacts/boring-b17/ux-r34r4/` (untracked, as before). `node --test test/bor-b17-deadspace.test.mjs` passes **9/9** (including the two browser tests and the new behavioural `spinUpPin` test). No page errors in any run.

## Status vs R34 r3

| r3 | Status | Evidence |
|---|---|---|
| **M4** Right-card Start folds the split | **Fixed** | **Start Brainstorm (wiki card): 18/18.** **Start Brainstorm (Bugs card): 18/18.** That is 3 runs at each of the 6 viewport/theme combos, in the plain demo. **Start RiffBot: 18/18 + 6** in the routed demo. In every run, the split stays on at every 10ms sample, the left pane stays `demo-impl-1` / `demo-aud` throughout, and the new agent lands in the right pane within ≤119ms. Example timeline: `[32ms s=1 L=demo-impl-1 R=null card=1 VibeSquad›wiki]`, then `[90ms s=1 L=demo-impl-1 R=demo-bs-wiki-… card=0 VibeSquad›wiki›Brainstorm]`. The crumbs are `VibeSquad›Bugs›Brainstorm` and `VibeSquad›Desk›RiffBot` (`m4-riffbot-light-3200x1800.png`, `m4-wiki-*`, `m4-bugs-*`). Cause fixed: `focus.into` is carried, and `reconcile` calls `show(id, f.into)` (`pinFocus.ts:134`). **Start Overlord** still cannot be verified live: the demo spawn never resolves, and the single-pane Start Overlord does nothing either, so this is a demo limit and not a regression. By code (`BoringAde.tsx:700`), it opens right only `if getPanes().split`. |
| Close split while a start is in flight | **OK, it does not reopen** | Close in the same tick as Start, and 40ms after Start, at all 6 combos (12 runs): `split` never returns to true. See N9 for what the single pane shows afterwards. |
| Right card resets on project switch | **Fixed** | Wiki card on the right, then a `Main Game Project` row: the right pane shows the **picker** (no card) and the crumb is `Main Game Project›Split · pick an agent`. Back on `VibeSquad`, the right pane is still the picker, not the stale wiki card (2560 dark, 4K light, 1280 light; `projswitch-efi-*`). `useEffect(…, [view?.team.id])` is at `BoringAde.tsx:654`. Ctrl+J did not open a switcher in the static demo, so I tested the sidebar path only. |
| Quick-jumps on the right card open in the right pane | **Fixed** | The wiki card's `Lead` and `UI Bois · Lead idle` rows, and the Bugs card's first jump (`UI Bois`), give `split=true`, `L=demo-impl-1`, and `R=demo-lead-wiki` / `demo-lead-ui-bois` at all 6 combos (18/18). |
| **N7** `Lead · Lane` placeholder chip | **Fixed** | No strip chip matches `· Lane` at any of the 6 combos, in either demo (17 and 14 chips). `demo-lead-vs` reads `Overlord · Working`. |
| **N8** User bubble 58px short | **Fixed, 0px** | User bubble right edge vs prose right edge: 2560 ctx-open 1484/1484, ctx-collapsed 1630/1630. 4K ctx-open 1738/1738, ctx-collapsed 1950/1950. 1280: 1207/1207 and 796/796. Dark = light. The lane test now asserts ≤1px at ≥2560. |
| N4 Strip scoped to the project | Skipped (lead decision) | — |
| L4 Empty space below the grid | Skipped (lead decision) | — |

## Regression pass (left pane / no split, and the items fixed in r3)
- **No split:** wiki → `Brainstorm` → Start opens `demo-bs-wiki-*` in the single pane at 10–44ms, with `split=0`. `Bugs` → Start Brainstorm opens `demo-bs-bugs-*`. The RiffBot row opens live RiffBot. All 6 combos.
- **Fixed in r3, still fixed:** the card names the lane (N2), the right card stays pane-local when you click the left pane (Gemini M2), Esc returns focus to `◫ Split` (N5), and Switch to Brainstorm keeps the split. All are asserted by browser test 9, which passes. Strip labels `Overlord` / `RiffBot` are still correct (N3). The CSS / Psycho-untouched test (7) passes.

## New findings

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| N9 | Minor | **If you close the split while a right-pane start is in flight, the new Brainstorm replaces your single-pane agent.** The split stays closed, as it should, but `show(id, "right")` with no split falls through to `openAgent(id)`. So `demo-impl-1` is swapped for `demo-bs-wiki-*` 10–113ms later (12/12 runs). Start Overlord on the same card does the opposite (`getPanes().split && openAgentInTab`): nothing opens. The two right-card starts disagree. It is defensible either way (you did ask for that agent), but it is a surprise focus steal after an explicit "close". | Split: back out of a start | `closeinflight-*`; for example `[8ms s=0 1=demo-impl-1]`, then `[48ms s=0 1=demo-bs-wiki-…]` | Pick one rule for both. Recommended: when `into === "right"` and the split is gone, don't navigate; the new agent stays reachable from the sidebar row. That is one line in `show()` (`pinFocus.ts:92`). | `pinFocus.ts` | XS |

**Pre-existing (not counted; queue for @bug):** split on, left pane active, sidebar `wiki`, then the top `Brainstorm` switch with a dormant Brainstorm. The crumb and switcher say `VibeSquad › wiki › Brainstorm`, but the left pane keeps showing the **wiki Lead** drawer, and no empty card or Start appears. This breaks the "breadcrumb = open agent" invariant (`split-left-start-dark-2560x1440.png`). It reproduces the same way on the merge-base `9f1f1f81` (a pre-B17 build), so B17 did not cause it.

## Owner decisions
None new.

## Verdict
M4 is fixed live: 54/54 right-pane starts (Brainstorm, Bugs, RiffBot), 3 per combo, across 1280/2560/4K in dark and light. Each one keeps the split, lands the agent on the right and leaves the left agent untouched. Closing the split mid-start does not reopen it. The right card resets on project switch, and the quick-jumps open on the right. N7 and N8 are fixed (0px at 2560 and 4K). No regressions in the no-split start paths or in the r3 fixes. Open: N9 (minor). N4 and L4 are skipped by lead decision. **PASS 0/0/1** (N9; N4 and L4 are deferred and not counted).

# R34 r5 (merged with @desk U1+U2): merge tip `8688c0e6`

Scope: the merge `8561a2b3` (origin/master `c5934bf6` with @desk U1+U2, plus B17 `b11a63cb`). It resolved 3 conflicts in `src/BoringAde.tsx`: the imports, the Overview tab state (`tabFor` / `pendingUrl0` / `overviewTab`) next to the B17 `rightCard` state, and the breadcrumb (B17 right-card `laneLabel` plus desk `tab: overviewTab`). The focus is how the two features interact.

Evidence: I rebuilt `dist` from `8688c0e6` and drove it with Playwright on Chromium at 1280x720, 2560x1440 and 3200x1800@1.2 (4K at 120%), dark and light. Each session used a fresh context. A history hook logs every `pushState` / `replaceState` / `back` / `forward` / `POP`. Each step records URL, `history.length`, split, left/right agent, right-pane content, breadcrumb, Overview tab and the selected (`.on`) sidebar rows. For attribution I also built `c5934bf6` (desk only) and `b11a63cb` (B17 only) from `git archive`. Shots are in `artifacts/boring-b17/ux-r34r5/` (untracked, as before). No page errors in any run.

Tests on the merged tree:
- `node --test test/bor-b17-deadspace.test.mjs test/desk-nav-history-u2-e2e.test.mjs`: **15/15 pass**.
- `test/desk-nav-history.test.mjs` + `test/desk-nav-history-e2e.test.mjs`: 53/55. The 2 failures, `B1 e2e (a,d)` and `(b)`, fail on the `boring-needs-open` row-text filter (`· VibeSquad`, which returns `[]`). They fail **identically on master `c5934bf6`** (31/33) and pass on `b11a63cb`, so they are pre-existing on master and the B17 merge did not cause them. See "Pre-existing" below.

## Status vs R34 r4

| r4 item | r5 (merged) | Evidence |
|---|---|---|
| **M4**: a right-card Start keeps the split | **Holds.** Wiki and Bugs Start Brainstorm: 3/3 at each of the 6 combos (36/36). RiffBot (routed demo): 6/6. The split stays on at every 10ms sample, the left agent never changes, and the new agent lands on the right. | `sc-*` / `m4` runs; `m4-*-{dark,light}-*.png` |
| Closing the split mid-start does not reopen it | Holds (0ms and 40ms, all 6 combos) | `closeinflight-*` |
| The right card resets on a project switch | Holds. A sidebar Overlord row in efi gives `Main Game Project›Split · pick an agent` with the picker on the right. Back on VibeSquad, it is still the picker, not the stale card (2560 dark, 4K light, 1280 light). | ps run |
| Quick-jumps open on the right | Holds. Wiki card `Lead` / `UI Bois`, and the first Bugs-card jump, give `split=1 L=<left> R=demo-lead-*` at all combos. | `sc-*` |
| N7 placeholder chip / N8 bubble edge | Hold. No `· Lane` chips; `demo-lead-vs` reads `Overlord · Working`. User bubble vs prose right edge is 0px at 1280/2560/4K. | `sc-*` |
| N9 (minor): closing the split mid-start steals focus | Still open, unchanged (not touched by the merge) | — |

## Merge interaction: the right card + Desk URL keys (`slot=` / `tab=`)

Results are identical, row for row, across the 5 combos in the full matrix (1280 dark/light, 2560 dark, 4K dark/light) once spawned ids are normalised.

| Sequence | Result | Verdict |
|---|---|---|
| **A**: agent → `◫ Split` → right card `wiki` → Start → Back ×2 → Fwd ×2 → reload | Split and card write **no** URL or history entry; the card crumb reads `VibeSquad›wiki`. Start pushes `agent=demo-bs-wiki-*` (+1) and the crumb reads `wiki›Brainstorm` with the wiki row on. **Back** gives `agent=demo-impl-1`, the split stays, both agents stay, and focus moves to the left pane (crumb `Desk›Worker`, worker row on). The next Back leaves the app (correct, that was the first entry). 0 `replaceState` during pops. | OK |
| **Breadcrumb for the right card** | `VibeSquad›wiki` / `VibeSquad›Bugs` while the card is up. It becomes `…›Brainstorm` after Start, and `Split · pick an agent` with the picker. The desk `tab:` argument never adds a tab segment in chat mode, including right after visiting `tab=standup`. | OK |
| **B2**: split + right Bugs card, then reload | It reloads to the single pane `demo-impl-1`; the split and the card are not restored. The card is pane-local and never in the URL (the B17 design), and the URL's agent is what comes back. Sensible. | OK |
| **C2**: `tab=standup` → wiki lane → split → Bugs card → Start → Back ×3 → Fwd ×3 → 2× Back race → Fwd | Back: the Bugs Brainstorm entry, then the wiki Lead (split kept, left focused), then `tab=standup` (Standup Feed tab on, crumb `VibeSquad›Standup Feed`), then `?team=vibesquad` (Overview). Forward replays exactly, and the split comes back with both agents. The 2× race lands on `tab=standup` (no double-pop, no lost entry), and Fwd from there restores the split. | OK |
| **D2**: `tab=inbox` → wiki lane → split → wiki card → efi header → efi Standup → vs header → Back ×4 → Fwd ×2 | The efi switch drops the card and resets to `?team=efi` (Overview). efi Standup pushes `tab=standup`, and back on vs it is the Overview tab, not Inbox (U1 reset). Back walks `efi&tab=standup` → `efi` → `vs&agent=demo-lead-wiki` (split back, picker on the right, the card reset as designed) → `vs&tab=inbox` (Idea Inbox tab on). One `.on` row at every step. | OK |
| **E**: split → needs-you strip chip → Back/Fwd; Unsplit/Split → wiki card → quick-jump `Lead` → Back/Fwd → reload | The strip chip pushes `agent=demo-aud` into the right pane. Back focuses the left pane without folding the split or dropping the right agent; Fwd returns. The quick-jump pushes `agent=demo-lead-wiki` on the right, and Back/Fwd behave the same. **Reload restores the split with both agents** (`L=demo-aud R=demo-lead-wiki`). | OK |
| **F**: split → sidebar Needs-you row 2 → row 1 → Back ×2 → Fwd ×2 | Each row opens on the right (+1 each). Back re-opens the previous one on the right; Back again focuses the left agent. Fwd replays. The split is never lost. Ctrl+J does nothing in the static demo (as in r4). | OK |

## Regression: column measure at 2560 and 4K

Values are CSS px. They match r3/r4 exactly. No horizontal scroll, dark = light.

| Viewport | ctx open: column / prose right / user right / `pre` | ctx collapsed | split: each pane |
|---|---|---|---|
| 2560x1440 | 1720 / 1484 / 1484 / 497–2002 | 2144 / 1630 / 1630 / 643–2280 | 1090 / 1090 |
| 4K@120% | 2360 / 1738 / 1738 / 751–2388 | 2784 / 1950 / 1950 / 963–2600 | 1410 / 1410 |

## New findings
None caused by the merge.

**Pre-existing (not counted; queue for @bug / @desk):**
- **P1: a dormant sidebar Desk row while split is on pushes a `slot=` the screen does not show.** Steps: split, then click the sidebar `Bugs` row (dormant).
  - With the right pane empty and active, the click is dead on screen: the picker stays and the crumb stays `Split · pick an agent`. But it pushes `?team=vibesquad&slot=bugs`.
  - Back, then Forward to that entry, gives crumb `VibeSquad›Bugs›Brainstorm` and the Bugs row on, while the panes show `demo-impl-1` plus the picker. The breadcrumb no longer matches the open agent.
  - Reloading that URL opens a single-pane Bugs card the user never saw.
  - With the left pane active, it is the same as r4's pre-existing "the crumb says Brainstorm, the pane keeps the old drawer".
  - The behaviour is **identical on desk-only `c5934bf6`**. On B17-only `b11a63cb` it pushed `?team=vibesquad`, and Forward folded to Overview. So the merge did not introduce it; it is the r4 pre-existing dormant-row-in-split issue, now with a URL key.
  - Fix direction: in split, a dormant core row should set `rightCard` / show the card in the active pane (the same as the picker's `openCore`/`openBugs`, `BoringAde.tsx:816-817`) instead of `pickBugs`/`pickCore` changing `selectedLaneId` behind the panes (`BoringAde.tsx:642-660`, `urlSlot` at `:692`).
  - Evidence: `B3-*.png`, B3/B4 logs. Effort: S.
- **P2: `test/desk-nav-history-e2e.test.mjs` B1 (a,d) and (b) fail on master `c5934bf6`.** The `.boring-needs-open` `· VibeSquad` text filter finds no rows; this looks like a stale selector, not a UX regression, since F shows the Needs-you rows work. Owner: @desk. Effort: XS.

## Owner decisions
None.

## Verdict
On the merged tree, all the B17 behaviour hold at 1280/2560/4K, dark and light: M4 (42/42 right-pane starts keep the split), the right-card reset on project switch, the quick-jumps, the strip, N7 and N8. They combine cleanly with the @desk URL keys. The right card writes no URL. Start, the strip, quick-jumps and Needs-you rows push exactly one entry each. Back/Forward never fold the split or double-pop, including the 2× race. `tab=` survives a round trip through a split session and resets on a project switch, and the breadcrumb `tab:` merge adds nothing in chat mode. Reload restores a two-agent split and drops a pane-local card (by design). The column measure is unchanged. Open: N9 (minor, from r4). P1 and P2 are pre-existing on master and not counted. **PASS 0/0/1**.

---

# R34 r6 (current master: desk D3/D4/P2): merge tip `d3c991fa`

Scope: what changed under `src` between `8688c0e6` (r5) and `d3c991fa`: @desk D3, the U3 fix, D4 Decision Desk (`src/BoringDecisionDesk.tsx`, a new `mode: "decisions"` in `BoringAde.tsx`, the `deskLandingGate` / `?view=decisions` effects in `App.tsx` + `urlSync.ts`, `.boring-decision-*` CSS) and P2 polish. The focus is how they interact with B17's measure column, context panel, split and right card.

Evidence: I rebuilt `dist` from `d3c991fa` (`npx vite build`) and drove it with Playwright on Chromium at 1280x720, 2560x1440 and 3200x1800@1.2 (4K at 120%), dark and light. Every sequence used a fresh context with a `pushState` / `replaceState` / `POP` hook. Scripts are in `/tmp/uxr34r6/` (`desk.mjs`, `ctx.mjs`, `meas.mjs`, `m4.mjs`). Shots are in `artifacts/boring-b17/ux-r34r6/` (untracked, as before). No page errors in any run.

Tests on `d3c991fa`: `test/bor-b17-deadspace.test.mjs` + `test/desk-nav-history-u2-e2e.test.mjs` **15/15 pass**; `test/desk-d4-decision-desk{,-e2e}.test.mjs` **29/29 pass**.

## Status vs R34 r5

| r5 item | r6 | Evidence |
|---|---|---|
| **M4**: a right-card Start keeps the split | **Holds.** RiffBot (routed demo): 12/12 across the 6 combos, with the split on at every 10ms sample and the left agent unchanged. Wiki card Start: 6/6 in the Desk runs (`L=demo-impl-1 R=demo-bs-wiki-*`). | `m4.mjs`, `desk.mjs` card+desk; `m4-*.png` |
| Column measure at 2560 / 4K | **Unchanged** from r3–r5, to the pixel (table below) | `meas.mjs`; `chat-ctx*-*.png`, `split-two-*.png` |
| N9 (minor): closing the split mid-start steals focus | Still open, unchanged | — |
| P1 / P2 (pre-existing, not counted) | Not re-tested; D3/D4 did not touch `pickBugs` / `pickCore` | — |

| Viewport | ctx open: column / prose right / user right / `pre` | ctx collapsed | split: each pane |
|---|---|---|---|
| 2560x1440 | 1720 / 1484 / 1484 / 497–2002 | 2144 / 1630 / 1630 / 643–2280 | 1090 / 1090 |
| 4K@120% | 2360 / 1738 / 1738 / 751–2388 | 2784 / 1950 / 1950 / 963–2600 | 1410 / 1410 |

## Decision Desk × B17

| Check | Result | Verdict |
|---|---|---|
| **Desk layout next to the measure column / container query** | The Desk renders in `.boring-main` as `.boring-dashboard-wrap.boring-decision-wrap`, outside any `.drawer`. So neither `--measure-*` nor the `.drawer` container query applies, and nothing is doubled. Widths (CSS px): at 1280 the wrap is 990 and the desk 910, single column (feed = strip = 910). At 2560 the wrap is 2180 and the desk 2000 (`is-wide`: feed 1096 + strip 880). At 4K the wrap is 2200, centred 690–2890, and the desk 2000. In every case: `scrollWidth == clientWidth`, 0 descendants outside the wrap, 0 clipped `overflow` boxes, 0 truncated ellipsis texts, no page h-scroll. Dark = light. | OK |
| **Context panel open/collapsed** | The panel is not rendered on the Desk, which is correct (it describes an agent). The collapsed/open state survives a trip through the Desk. Collapse at 2560 → Desk → Back: column 2144, user right 1630. After Desk → a Live-status lane, the new agent keeps the same state (2144/1630). At 1280 the default-collapsed toggle (open → 530/796) also survives the round trip. 4K matches (2784/1950). | OK, `ctx-after-desk-*.png` |
| **Sidebar "Decisions · 12" next to the Needs-you strip** | It is one full-width row (12–367 px, the same box as the Needs-you strip) directly above `Needs you 6 Ctrl+J`. It is `.on` on the Desk (the only `.on` row) and off elsewhere. The two counts measure different things: open decision cards (12 = 9 here + 3 off-screen, matching the Desk summary `12 open · 9 here · 3 off-screen`) vs agents blocked on a permission/turn (6). Each agrees with its own screen. At 1280x720 the Needs-you rows still push Projects below the fold. That is pre-existing (r5 shots show the same) and was not caused by the Desk row. | OK, `desk-from-split-*.png` |
| **Desk landing / pop with the split open** | Split (`L=demo-impl-1 R=demo-aud`) → `Decisions` pushes `?view=decisions` (+1), crumb `Decision Desk`. **Back** restores the split with both agents, and the crumb and `.on` row are those of the right agent. Fwd → Desk; Back → split again. Desk → sidebar worker → Back returns to the Desk. 0 `replaceState` during pops. | OK, all 6 combos |
| **Right card across the Desk** | Split + right `wiki` card → Desk → **Back**: the card is still on the right (`card:wiki`, crumb `VibeSquad›wiki`, no `.on` row). Start from it puts `demo-bs-wiki-*` on the right with the split kept. Desk → Back again keeps that two-agent split. | OK, `desk-card-*.png` |
| **Opening an agent from the Desk while the split is on** | A Live-status lane (`wiki`) opens `demo-lead-wiki` in the **right** pane (`L=demo-impl-1`), so the split comes back with the new agent where B17 puts new opens. Back → Desk. | OK, `desk-openagent-*.png` |
| **Bare load** | `?demo=1&riff=1` with no team/agent lands on the Desk (`?view=decisions`, crumb `Decision Desk`, the Decisions row on) and never writes `?team=` first. Same layout numbers as above. | OK, `desk-bare-*.png` |

## New findings
None.

Observation (not counted, owner of copy = @desk): `Decisions · 12` and `Needs you 6` sit next to each other with different counts. They are different queues and each is correct, but a first-time reader may expect them to match. Leave it unless the owner says it confuses.

## Owner decisions
None.

## Verdict
On current master, the Decision Desk and B17 combine cleanly at 1280/2560/4K, dark and light. The Desk lives outside the drawer, so the measure column and container query cannot double or clip it. The split (two agents or right card), the context-panel state and the B17 right-pane placement all survive Desk round trips and Back/Forward. M4 holds (18/18), and the column measure is pixel-identical to r5. Open: N9 (minor, from r4). **PASS 0/0/1**.
