# VibeSquad UX review, round 36: @desk U3 re-run after master merge (Needs-you location line, idea-935)

Date: 2026-11-25 · Build: `desk-u3-needs-loc` @ `436d5dfb` (merges `9f1f1f81` @bor B14–16 and `1af4421a`) · Previous gate: `docs/UX_REVIEW_R32_desk-u3.md` r2 at `2789ec41`, PASS 0/0/0 (rn-52d5d1cdc3f7) · Scope: the Needs-you location line only.

**Verdict: PASS 0/0/0** (critical/major/minor)

The master merge did not change the U3 location line. Every geometry number from R32 r2 reproduces exactly at 290, 307 and 380px, in dark and light. Nothing in the merged @bor sidebar CSS overrides the U3 rules.

## Setup
- **Build:** `npx vite build --outDir /tmp/r36/head` from this worktree with no source edits. The probe also rebuilt `dist/`, which is gitignored.
- **Harness:** the R31/R32 drivers (`docs/ux-review-r31/drive/serve.mjs` and `docs/ux-review-r32/drive/*`), run unchanged on port 5836. I stopped the server afterwards.
- **Demo data:** `?demo=1&riff=1`, which gives 6 Needs-you items.
- **Name passes:** the same 6 route-rewrite passes as R32: stock, long, xl, longlane, xllane and shortlane.
- **Viewports:** 1280×900 (sidebar 290px), 1920×1080 (307.19px) and 3200×1800 (380px), each in dark and light. That is 36 runs with 0 page errors.
- **Extra checks:**
  - `detail.mjs` with the R32 real-name pairs at 1280 and 1920
  - `psycho.mjs`
  - `full.mjs` at 1280 light, 1920 dark and light, and 3200 @1.2 dark
  - a new `drive/cascade.mjs` that reads the computed styles

## What the merge touched
`git diff 782242c1 436d5dfb -- src/boring.css` changes three things:
- **Line 1278:** split-toggle colour, `--bg` → `--on-accent`.
- **Lines 1552–1593:** the project-tabs light rule, the C3 Crunch pill, and the PLAN_PROJECT_ORDER O2 Main pin and drag grip.

None of these lines select `.boring-needs-*`. After line 1263, the only `needs` matches in `boring.css` are the `.boring-now[data-state="needs-you"]` drawer rules (1364–1425). `src/BoringInbox.tsx` is not in the merge diff.

The `src/styles.css` changes contain no `needs` selectors. The Psycho rules at `styles.css:6645-6647` are unchanged.

## Scope checks

| Check | Result | Evidence |
|---|---|---|
| The project elides first and the lane stays whole | **Pass.** `laneTrunc` is false for every lane shorter than 27 characters, in all 36 runs. <br>• "Standing Teams": the lane box is 90.08px with `scrollWidth` 90. The project is cut at 88px and reads "Windows · Vi…". <br>• "UI": the lane box is 11.48px with `scrollWidth` 11. It reads "UI · Escape From Idle Definitiv…". <br>• "Playtest Overlay": the lane is whole at 92.47px and the project is cut, reading "Escape Fro…". <br>These numbers are identical to R32 r2. | `r36-detail-lane-proj.png` (panels 1–3), `logs/r36-*-shortlane.json` |
| The lane is capped at `calc(100% - 6ch)` and the project keeps a floor | **Pass.** The computed lane `max-width` is `calc(100% - 52.7043px)`. <br>• For a 39-character lane, the lane box is 125px at 290, 143px at 307 and 215px at 380. <br>• `projW` = 53 in all 24 long/xl/longlane/xllane runs. <br>• `whereOverflow` is false in all 36 runs. | `r36-detail-lane-proj.png` (panels 4–5), `logs/r36-*-{long,xl,longlane,xllane}.json` |
| The `::before` separator appears only when there is a lane | **Pass.** <br>• Normal rows with a lane: `content` is `" · "`. <br>• Psycho Desk rows, where the lane is `null`: `content` is `none`, so there's no leading dot. <br>• Psycho lane rows: `" · "`. <br>• The branch probe injects an empty-lane row and asserts `::before` = `none` (test run below). | `drive/cascade.mjs` output, `r36-psycho-dark.png` |
| No override from the merged @bor sidebar | **Pass.** The computed styles on the `Main Game` lead row at 290 and 307 match `src/boring.css:1261-1262` exactly. <br>• Lane: `flex 0 0 auto`, `min-width 0px`, `max-width calc(100% - 52.7043px)`, `ellipsis`/`nowrap`. <br>• Project: `flex 0 1 auto`, `max-width 100%`, `text-indent 0px`. The 1245 `text-indent: 0.3em` and its clamp are overridden as intended. <br>• Location: `display flex`, `flex-basis 100%`. | cascade output below |
| Titles keep ≥ 20ch | **Pass.** The minimum `whoW` is 178px at 290, 195px at 307 and 268px at 380, the same as R32. | `logs/r36-*.json` |
| Counts and selection | **Pass** at 1280, 1920 and 3200. <br>• The header reads `Needs you 6`, which is 5 rows plus "▸ 1 more". "▸ Done recently · 4" is also present. <br>• Badges: Desk 4 + Bug Chaser 1 + Main Game Project 1 = 6, matching the Overview pills. <br>• Exactly one selected row (`sel: 1`). | `r36-{dark,light}-1920-window.png`, `r36-light-1280-window.png`, `r36-dark-3200-window.png` |

Cascade output (`drive/cascade.mjs`, 1280×900):
```
{"sidebarW":290,"lane":{"flex-grow":"0","flex-shrink":"0","flex-basis":"auto","min-width":"0px","max-width":"calc(100% - 52.7043px)","overflow":"hidden","text-overflow":"ellipsis","white-space":"nowrap","display":"block","text-indent":"0px"},"proj":{"flex-grow":"0","flex-shrink":"1","flex-basis":"auto","min-width":"0px","max-width":"100%","overflow":"hidden","text-overflow":"ellipsis","white-space":"nowrap","display":"block","text-indent":"0px"},"where":{"display":"flex","flex-basis":"100%","max-width":"100%","overflow":"hidden"},"sepLead":"\" · \""}
```
The 1920×1080 output is the same, with `sidebarW` 307.1875.

## Status vs R32 r2

| R32 item | Status at `436d5dfb` |
|---|---|
| m1 · the lane loses its last glyph | Still closed. The numbers are byte-for-byte the same as r2. |
| m2 · the project hidden at 0px | Still closed. The project floor is 53px. |
| m3 · the probe never ran at 307px | Still closed. 5/5 pass, see below. |
| Nit · the probe asserts `projW > 0` | Still open and still not counted. `projW >= 5ch` would pin the floor. XS. |

## Findings
**Critical:** none. **Major:** none. **Minor:** none.

**Coverage note, not a finding:** the merged O2 Main pin (`src/boring.css:1566-1593`) does not render in `?demo`, because no Main project is set. So this round could not observe whether the pin's `min-height: 220px` squeezes the Needs-you section on short windows. That sits outside the U3 scope and belongs to whoever gates @ui-bois O2.

## Owner decisions
None.

## Branch probe (`436d5dfb`, after `npx vite build`)
```
ok 1 - U3: Needs-you rows at 290px (light): real sidebar width, stock geometry, long-name elision + project floor, empty-lane separator
ok 2 - U3: Needs-you rows at 307px (light): …
ok 3 - U3: Needs-you rows at 290px (dark): …
ok 4 - U3: Needs-you rows at 307px (dark): …
ok 5 - U3: 290px and 307px runs actually exercised distinct sidebar widths
# tests 5  # pass 5  # fail 0  # skipped 0
```

## Artifacts (`docs/ux-review-r36/`)
- `r36-detail-lane-proj.png`: five panels. At 1280: Standing Teams, UI, Playtest Overlay and the 39-character lane. At 1920: the 39-character lane.
- Full-window shots: `r36-light-1280-window.png`, `r36-dark-1920-window.png`, `r36-light-1920-window.png`, `r36-dark-3200-window.png`.
- `r36-psycho-dark.png`
- `logs/`: 36 JSON dumps (`r36-<theme>-<vw>-<pass>.json`).
- `drive/cascade.mjs`. The other drivers are in `docs/ux-review-r32/drive/`.

**Verdict: PASS 0/0/0**
