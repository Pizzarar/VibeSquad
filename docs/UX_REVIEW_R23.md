# VibeSquad UX review, round 23: @desk B3, Needs-you row fit + light `--st-err`

Date: 2026-11-24 · Build: `desk-b3-needsyou-fit` @ `e585fbe8`, compared with BASE = `master` @ `15e49a29`. BASE is the branch's parent, so the diff is exactly the B3 commit.

**Setup.** Both trees were built with `npx vite build`. The branch was built in its worktree; master was built from a `git archive` export in `/tmp/b3base`, not a worktree. Each `dist/` was served by an in-process static server inside the Playwright script (`:4331` branch, `:4332` BASE), not the live server. Driven with playwright-core and the snap Chromium, `?demo=1&riff=1` (6 Needs-you rows) and `&crowd=1` (31 rows, expanded). There were 0 page errors in every pass.

**Long-name pass.** Playwright rewrote these demo bundle strings (route intercept; source untouched):

| Demo name | Rewritten to |
|---|---|
| project `Main Game Project` | `Main Game Project Overworld Remaster` |
| lane `Main Game` | `Main Game Overworld Quests And Dialogue` |
| `Review - Sonnet · drawer` | `… drawer crash regression sweep across providers` |
| `Audit - token scout` | `… for handoff budgets and context refs` |
| `Bug Runner · triage` | `… of the overnight crash reports` |

The **stock pass** uses the unmodified demo names.

**Viewports.**
- 1920×1080 light and dark (sidebar 307px)
- 1280×900 light and dark (sidebar at its 290px floor, the narrowest the `clamp(290px,16vw,380px)` allows)
- 3200×1800 @1.2 dark (sidebar 380px)

Screenshots are in `docs/lanes/desk/ux-r23/`. No source edits.

**Verdict at `e585fbe8`: FAIL 0/2/1 (critical/major/minor), plus 1 nit.**
- **What passes:** contrast (`.tl-exit-badge.err` 4.84:1), the global `--st-err` change (no light-mode regression), the project name on rows with typical names, and SPEC R3 #3.
- **What fails:** a long `Lane · Project` overflows the row and the sidebar (M1). The title is now crushed to about 6 characters on most rows, including stock demo names that master shows in full (M2).

## Status vs previous round (R16, the round that raised idea-740)

| R16 item | Status at `e585fbe8` | Evidence |
|---|---|---|
| m3 · Needs-you rows at 1920 truncate the title and drop the project | **Half.** The project now shows on every row with normal-length names. Master showed it on 0 of 31 rows; the branch shows it on 30 of 31. But the title shrinks much further than before (M2), and a long location overflows (M1). | `base-light-1920-stock-crop.png` vs `head-light-1920-stock-crop.png`; `head-light-1920-riff-crowd-exp-sidebar.png` |
| m5 · `exit 2` badge 4.46:1 in light | **Fixed.** Measured **4.84:1** (BASE 4.46). | `head-light-exit-badge.png` vs `base-light-exit-badge.png` |

## Checks requested

| Check | Result | Measured |
|---|---|---|
| Every row keeps the project name | **Fail** (1 of 31) | Every short or medium location keeps `· VibeSquad`. The long Main Game row's `Lane · Project` is 483px wide in a 257px row. The project starts past the sidebar edge and is clipped (`projVisible=false`) at 1920, 1280 and 3200. |
| Title elides first | **Pass, literally, but too far** (M2) | On master the title had 110-154px and the location shrank to 35px. On the branch the title gets 68-88px on 20 of 31 crowd rows ("Audit - ui…", "Mechani…", "Implement…"), and the location keeps its full width. |
| Location wraps to its own line only when needed | **Pass** | It wraps only when the location leaves less than 6ch for the title: 11 of 31 rows at 1920, e.g. "Bug Chaser · VibeSquad" and "Art Direction · VibeSquad". |
| Nothing overflows the sidebar | **Fail** (M1) | With the long names, `.boring-sidebar` `scrollWidth − clientWidth` = **214px** at 1920, and the sidebar scrolls sideways at 1920, 1280 and 3200. With stock names there's no overflow at any width. |
| SPEC R3 #3: location on line 1 muted, reason on line 2 | **Pass** | The location is `--text-3` `rgb(94,88,104)` against the title's `rgb(29,26,36)` in light. The reason sits below the title line in 31 of 31 rows. When the location wraps, it takes line 2 and the reason moves to line 3. That is what the plan asks for ("line 1 / line 2 if it doesn't fit"). |
| Narrow sidebar (290px) | **Fail** for long names, same as M1. With stock names the title drops to **71px**: "Audit - t…", "Review - G…" (`head-dark-1280-short-riff-narrow-sidebar.png`). | |
| `.tl-exit-badge.err` ≥ 4.5:1 in light | **Pass: 4.84:1** | `#b9264e` on the badge's effective background (`--st-err-bg` tint over the timeline surface) |
| Regression sweep (sequences touching Needs-you) | **Pass** | Clicking the long Main Game row gives the breadcrumb "Main Game Project Overworld Remaster › Main Game Overworld Quests And Dialogue › Lead" with one selected row ("Lead"). Ctrl+J and clicking the Audit row give "VibeSquad › Desk › Worker" with one selected row. The header count of 6 matches the rows plus "1 more". Hover shows `⋯` with no overlap on normal rows (`head-dark-1920-hover-rev.png`). |

### Light-mode error colours (global `--st-err` `#c22a52` → `#b9264e`)

All measured in the running app, in light, against each element's effective background. Every value went up, and none fell below its threshold.

| Element | BASE | Branch | Threshold |
|---|---|---|---|
| `.tl-exit-badge.err` text | 4.46 | **4.84** | 4.5 text |
| `.perm-card .btn.bad` "Deny" text + border | 5.60 | 6.09 | 4.5 |
| `.boring-badge.err` white on red (sidebar count) | 5.60 | 6.09 | 4.5 |
| `.boring-ctx-meter-pct` "93%" (crit meter) | 5.60 | 6.09 | 4.5 |
| `.bt-status` ✕ / `.bt-del` "−1" (tool rows) | 5.19 | 5.63 | 4.5 |
| `.boring-agent-glyph.st-err` ✕ | 5.60 | 6.09 | 4.5 |
| `.boring-dot.st-err` status dots | 4.17-5.60 | 4.53-6.09 | 3.0 non-text |
| `.tl-tool.failed` left rule, `.boring-needs-item.attn-error` left rule | 5.19 / 5.60 | 5.63 / 6.09 | 3.0 |
| Storybook `--sb-bad` (`.sb-err`, `.sb-dangling`, `.sb-sev-error`, `.sb-cat-broken`) | not driven | not driven | — |

Storybook was not driven, because it needs the `/api/storybook` route. `--sb-bad` is `var(--st-err)` (`src/storybook.css:14`) and sits only on light `--surface-*` backgrounds, so a darker red can only raise its contrast there. The new red is still clearly distinct from `--st-attn` amber and `--living-coral` `#c23a3a` in the sidebar shots.

## Findings

### Major

- **M1 · A long `Lane · Project` overflows the row and the sidebar, and the project is the part that gets clipped.**
  - **Job hurt:** job 3 (respond) and job 2 (monitor across projects). The row whose location is longest is exactly the one whose project you can't read. The plan's own done-check fails ("every Needs-you row shows the project name"). The whole sidebar gains a 214px horizontal scroll, so a trackpad swipe shifts every row sideways (`head-dark-1920-hover-rev.png` is captured after that shift). The location also runs under the age, so "3m" collides with "Dialogue · Ma".
  - **Evidence:** `head-dark-1920-long-crop.png` and `head-light-1920-riff-crowd-exp-sidebar.png` (Lead 75 row), `head-light-1280-riff-narrow-sidebar.png`, `head-dark-3200-riff-sidebar.png`. Measured `.boring-needs-where` right edge 520px against the item's 294px and the sidebar's 307px; `projVisible=false`.
  - **Cause:** `src/boring.css:1256` gives the location `flex: 0 0 auto; overflow: visible; text-overflow: clip`, and it still inherits `white-space: nowrap` from `src/boring.css:917-918`. Once it has wrapped onto its own line it can neither shrink nor break, so any location wider than the row spills out. `src/boring.css:1257` (`.boring-needs-proj { max-width: none }`) removes the last clamp.
  - **Fix:** keep the project and let the **lane** give way. Make `.boring-needs-where-inline` `display: flex; flex: 0 1 auto; max-width: 100%; min-width: 0`. Wrap the lane text in a span with `min-width: 0; overflow: hidden; text-overflow: ellipsis`, and give `.boring-needs-proj` `flex: none`. The row then reads "Main Game Overworld Q… · Main Game Project Overworld Remaster". If the project alone is wider than the row, let it ellipsize last. Add a Playwright invariant with long names: for every `.boring-needs-item`, `where.right ≤ item.right` and `sidebar.scrollWidth == sidebar.clientWidth`. The unit test `test/desk-b3-needsyou-fit.test.mjs` only pins CSS rule text, so it passed while this overflowed.
  - **Files:** `src/BoringInbox.tsx:182` (lane span), `src/boring.css:1254-1257`. **Effort:** S.

- **M2 · The title is crushed to about 6 characters on most rows, a regression from master even on stock demo names.**
  - **Job hurt:** job 3. The title is the row's identity ("which worker?"). On the branch, 20 of 31 crowd rows at 1920 show only a role word: "Implement…", "Review - …", "Mechani…", "Audit - ui…". Twelve different ui-bois workers become indistinguishable apart from the reason line. With unmodified demo names, "Audit - token scout" and "Review - Gemini · retry", both fully visible on master at 1920, become "Audit - toke…" and "Review - Ge…". At 290px they drop to 71px.
  - **Also:** row shapes in one list are ragged. Neighbouring rows alternate between a 70px title with an inline location and a 187px title with the location wrapped, depending only on the lane name's length.
  - **Evidence:** `head-light-1920-stock-crop.png` vs `base-light-1920-stock-crop.png`; `head-light-1920-riff-crowd-exp-sidebar.png`; `head-dark-1280-short-riff-narrow-sidebar.png`. Title widths on master were 110-154px; on the branch they are 68-88px.
  - **Cause:** `src/boring.css:1255` `.boring-needs-who { flex: 1 1 0; min-width: 6ch }`. With a zero basis, the flex line breaks only when the location leaves under 6ch for the title, so the location stays inline and squeezes the title down to that floor. "Elide the title first" is applied as "elide the title almost entirely before the location moves".
  - **Fix:** raise the title floor so the location wraps first, e.g. `min-width: min(18ch, 100%)`. Then a title keeps about 130px or the location drops to its own muted line. Measure that at least 15 characters of title show at 290px and 307px. Together with M1's fix, the lane still ellipsizes before the project.
  - **Files:** `src/boring.css:1255`. **Effort:** XS.

### Minor

- **m1 · The geometry rule is only pinned by text-matching the CSS.** `test/desk-b3-needsyou-fit.test.mjs` asserts the rule strings and the contrast maths. It can't see M1 or M2, and both pass the suite (139 of 139 green with `test/boring-mode.test.mjs`). Add a `?demo` Playwright check with one long-lane row at 290px and 307px: `where.right ≤ item.right`, the project visible, the title ≥ 15ch, and the sidebar has no horizontal scroll. Effort: S. Files: `test/` or `scripts/ui-overlap.mjs` (it already has a sidebar-needs probe).

### Nit

- **n1 · `--st-err-bg` wasn't moved with `--st-err`.** In light, `src/boring.css:706` still tints with the old `#c22a521a`. At 10% alpha the hue shift is invisible, but the token pair now disagrees. Use `#b9264e1a`. Effort: XS.

## Owner decisions

1. **Where does the location live when names are long?** The plan (B3) and SPEC R3 #3 ask for the location on line 1 and the reason on line 2, wrapping the location only when it doesn't fit. In practice the row then has three shapes (inline, wrapped, overflow). **Recommendation:** keep the plan's adaptive layout with the M1 and M2 fixes (lane elides, project kept, title floor about 18ch). That keeps 2-line rows for typical names, so the R2 #5 density holds, and gives three lines only when the names are long. The alternative is a fixed 3-line row (title / muted location / reason). It is the most predictable layout but costs about 12px per row on a list that is often 5 rows high.

## Routing

M1, M2, m1 and n1 belong to @desk (the B3 unit, same files). There is nothing for other lanes. `boring.css:1254-1257` is a B3-only block, so there's no @bor hunk clash.
