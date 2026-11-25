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
