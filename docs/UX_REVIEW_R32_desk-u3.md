# VibeSquad UX review, round 32: @desk U3, Needs-you location line (idea-935, R25 m1 + m3)

Date: 2026-11-25 · Build: `desk-u3-needs-loc` @ `54d56ff6` · Compared against: BASE = `749ff19d` (branch parent; built from `git archive`, same harness) · Previous round for this area: `docs/UX_REVIEW_R25.md` (B3, PASS 0/0/3) · Plan: `docs/PLAN_DESK_URL_COMPLETE.md` U3 row (line 32) and done-check (line 44). The plan exists only in the main checkout and is not committed on this branch.

**Verdict: PASS 0/0/3** (critical/major/minor)

The unit does what it set out to do. On lead rows the lane now survives, the project is what gets cut, and the orphan leading `·` is gone. With realistic lane and project names the row reads better than BASE. Three minors are open:
- The lane still loses its last glyph to a sub-pixel shrink whenever the project overflows.
- A long lane now hides the project completely, which is R25 m1 in reverse.
- The new probe never runs at 307px and uses only the stock demo names, so it can't see either problem.

## Setup

- **Builds:** `npx vite build --outDir /tmp/r32/{head,base}`. No source edits, and the worktree stayed clean.
- **Server:** the R31 static harness (`docs/ux-review-r31/drive/serve.mjs`).
- **Browser:** playwright-core plus `/usr/bin/chromium-browser`, with `?demo=1&riff=1`: 6 Needs-you items, 5 shown plus "1 more".
- **Page errors:** 0 in every run.
- **Name passes:** I rewrote the demo bundle strings through a route intercept, as in R25. The source was not touched.

| Pass | Lane on the `Lead 75` row | Project |
|---|---|---|
| stock | Main Game | Main Game Project |
| long (R25) | Main Game Overworld Quests And Dialogue | Main Game Project Overworld Remaster |
| xl (R25) | same long lane | …Overworld Remaster Definitive Edition Collection |
| longlane | long lane | Main Game Project |
| xllane | …And Side Content Pass (61ch) | Main Game Project |
| shortlane | UI | the xl project |
| real names | Playtest Overlay / Release Desk / Boring Mode / Standing Teams | Escape From Idle / SportsBallBattles / rosserlogic.tech / Windows · VibeSquad App |

- **Viewports:** 1280×900 (sidebar 290px), 1920×1080 (307px) and 3200×1800 (380px), each in dark and light, for both builds. That is 72 runs. The full windows were shot at 1920 dark and light and at 3200 @1.2 dark.
- **Psycho sidebar:** I also checked the rows with no lane, in dark and light. These are Psycho rows, where the `Desk` lane is `null`. I set `app.vibe=fun` plus `vs.vibeMigratedNormal=1`.

I did my first pass before reading the plan.

## Status vs R25

| R25 item | Status at `54d56ff6` | Evidence |
|---|---|---|
| **m1** · the lane vanishes when the project fills the row, leaving a stray leading `·` | **Fixed, with two follow-ons (m1, m2 below).** Long/xl at 290 and 307: the lane shows 27–30 characters and the project is cut (BASE: lane 0px, project 29–34 characters). No row starts with `·`: the separator is now `::before` on the project and only shows when a lane exists (`src/boring.css:1263`). | `cmp-base-vs-head-long-xl.png`, `logs/{base,head}-*-long.json` |
| m2 · every row is 3 lines (spec question) | Unchanged by U3. Row heights are identical on BASE and head (91/61/77/61/61 at 1920). The SPEC already carries the 2026-11-25 3-line amendment. | `logs/*-stock.json` `h` |
| **m3** · geometry pinned only by CSS string matching | **Half.** There is now a real-browser probe (`test/desk-u3-needs-loc.test.mjs`, 4/4 pass locally). But it never renders at 307px, and it only sees the stock names, where nothing elides (m3 below). | test run below; `artifacts/desk-u3/*.png` md5 |

## Checks the brief asked for

| Check | Result | Evidence |
|---|---|---|
| Titles keep ≥ 20ch | **Pass.** The title box is 178px at 290, 195px at 307 and 268px at 380 in all 72 runs, the same as BASE. The title CSS was not touched. Every stock title shows in full. | `logs/*.json` `whoW` |
| Location line readable | **Pass with realistic names; m1/m2 at the edges.** At 1280, lane/project reads: <br>• "Playtest Overl… · Escape Fro…" (BASE "Playtest O… · Escape From Idle") <br>• "Standing Tea… · Windows · Vi…" (BASE "S… · Windows · VibeSquad App") <br>• "Release Desk · SportsBallBatt…" <br>• "Boring Mode · rosserlogic.tech" in full | `cmp-base-vs-head-real-names-1280.png` |
| Full text in `title=` | **Pass.** Every row carries `title="<Lane> · <Project>"` (stock, long, xl and Psycho), including Desk rows. | `logs/*.json` `title` |
| Rows with no lane, and hub/Desk rows | **Unaffected.** <br>• Normal Desk rows read "Desk · VibeSquad", the same as BASE. <br>• Psycho Desk rows (lane `null`) read "VibeSquad" with `::before` = `none`, so there's no dot. <br>• Psycho lane rows render the separator, light and dark. | `head-psycho-light-nolane.png`; psycho run output in "Artifacts" |
| Invariants (counts, selection) at 1920/3200 | **Pass.** Header `6` = 5 rows + "1 more". Project badges: Desk 4 + Bug Chaser 1 + Main Game 1 = 6. Exactly one `.on` row. | `head-{dark,light}-1920-window.png`, `head-dark-3200-window.png` |

## Findings

### Critical
None.

### Major
None.

### Minor

#### m1 · Whenever the project overflows, the lane still loses its last glyph, and a short lane like "UI" becomes "U…"
- **Job hurt:** 3, Respond. On a lead row the lane is the only thing that tells two leads apart, because `roleOnlyWho` strips it from the title ("Lead 75"). U3 exists to keep the lane whole, and with realistic names it is visibly clipped.
- **Evidence:**
  - At 290px, "Standing Teams · Windows · VibeSquad App" renders "Standing Tea…" with a gap before "· Windows · Vi…". Lane box 89.69px for 90px of text.
  - "UI" + a long project renders "U. · Escape From Idle Definitiv…". Lane box 11.44px, `scrollWidth` 17.
  - See `head-lane-ellipsis-1280.png`.
  - The integer `scrollWidth`/`clientWidth` check reads 90 = 90, so the first case is invisible to the probe.
- **Cause:** `src/boring.css:1261-1262`. The lane is `flex: 0 1 auto` and the project `flex: 0 100 auto`. Flex shrink is weighted by shrink × basis, so the lane still takes a small share of the overflow. Any share above zero triggers `text-overflow: ellipsis`.
- **Fix:** don't let the lane shrink unless it alone is too wide. For example, lane `flex: 0 0 auto; max-width: calc(100% - 6ch)` and project `flex: 0 1 auto; min-width: 0`. I previewed this via `addStyleTag` (with 9ch): "Standing Teams · Windows · Vi…", "UI · Escape From Idle Definitiv…", "Playtest Overlay · Escape Fro…" (`fix-preview-1280.png`). The same rule also fixes m2.
- **Files:** `src/boring.css:1261-1262`. **Effort:** XS.

#### m2 · A long lane now hides the project completely, with no ellipsis cue (R25 m1 in reverse)
- **Job hurt:** 3, Respond, and 2, Monitor. With two long-named lanes of the same name in different projects, the row gives no hint which project it belongs to until you hover.
- **Evidence:** the longlane/long/xl/xllane passes at 290 and 307, dark and light.
  - The project is 0px wide.
  - The location reads only "Main Game Overworld Quests An…". `head-dark-1280-longlane.png`; `logs/head-*-longlane.json` `projW: 0`.
  - At 380px the project is 23px, showing only " · …".
  - BASE kept the project in every pass (R25 M1 status: "0 of 31 hidden").
- **When it happens:** only for lanes ≥ ~27 characters at 290px. None of the squad's current lane names are that long, so this is rare.
- **Cause:** same rules. `flex-shrink: 100` with `min-width: 0` lets the project collapse to nothing.
- **Fix:** the m1 fix. Capping the lane at `100% - 6ch` leaves a floor for "· Main G…" (`fix-preview-1280.png`, third panel). **Files/Effort:** as m1.

#### m3 · The new geometry probe never runs at 307px and can't see m1 or m2 (carried in part from R25 m3)
- **Gap 1, no 307px run:** the test seeds `localStorage["vibesquad.sidebarWidth"]` (`test/desk-u3-needs-loc.test.mjs:43`). The Normal sidebar ignores that key: its width is `clamp(290px,16vw,380px)`. At the test's 1600px viewport, 16vw is 256px, so both the "290" and "307" cases render at 290px. The worker's `artifacts/desk-u3/needs-you-290-*.png` and `needs-you-307-*.png` are byte-identical: md5 `0003552f…` dark, `2b08e1dc…` light. The plan's done-check ("passes at 290 and 307px", plan line 44) is therefore not actually exercised at 307.
- **Gap 2, stock names only:** nothing elides with stock names. The R25 m3 fix asked for "one long lane/project row".
- **Gap 3, assertions that can't fail:**
  - The separator assertion tests `innerText` (`:69-73`), which never includes `::before` content, so it can't fail.
  - `lane.w > 8` passes for the clipped "U…" lane.
- **Fix:**
  - Drive the widths with the viewport: 1280×900 → 290px, 1920×1080 → 307px.
  - Add one route-rewritten long-lane + long-project row, as in this review's `drive/dump.mjs`.
  - Assert `lane.scrollWidth ≤ lane.clientWidth` when `lane` fits within `100% - 6ch`, and `proj.width ≥ ~5ch`.
- **Files:** `test/desk-u3-needs-loc.test.mjs`. **Effort:** S.

## Spec question: does project-first eliding read better than SPEC R3 #3's "lane elides before project"?

**Yes, for lead rows. Recommend the lead amend SPEC R3 #3 to "the project elides first; the lane stays whole when it fits; the project keeps a small floor", once m1/m2 land.**

Reasons:
1. Lead titles have the lane stripped (`roleOnlyWho`), so the lane carries the identity. The project only adds context, which is also visible from the badged project row.
2. With the squad's real names, head keeps lane identity where BASE lost it. BASE showed "S… · Windows · VibeSquad App" and "Playtest O… · Escape From Idle"; head shows "Standing Tea… · Windows · Vi…" and "Playtest Overl… · Escape Fro…".
3. The leading-word prefix of a project ("Escape Fro…", "Main G…") identifies it about as well as the full name, because project names are few and distinct.

The spec text in `docs/lanes/desk/SPEC.md` R3 #3 still says "lane elides before project". That's lead-owned, so I didn't edit it.

## Owner decisions
None. The spec amendment above is a lead call within the lane's own rule.

## Inbox cards (for the lead)
- @desk: m1 + m2 (one CSS fix, `src/boring.css:1261-1262`, XS).
- @desk: m3 (probe widths via viewport, long-name row, real assertions; S).
- @desk lead: amend SPEC R3 #3 to project-first with a floor.

## Worker test run (this worktree, `54d56ff6`)
```
ok 1 - U3: Needs-you rows at 290px (light) …
ok 2 - U3: Needs-you rows at 307px (light) …
ok 3 - U3: Needs-you rows at 290px (dark) …
ok 4 - U3: Needs-you rows at 307px (dark) …
# tests 4  # pass 4  # fail 0
```

## Artifacts
- **Drivers** (`docs/ux-review-r32/drive/`):
  - `dump.mjs <port> <w> <h> <theme> <query> <rewritesJSON> <shot>`
  - `runall.sh <port> <tag> <outdir>`: 36 passes per build
  - `detail.mjs` and `detailfix.mjs`: sub-pixel widths and the fix preview via `FIXCSS`
  - `psycho.mjs`
  - `full.mjs`
  - `pair.py`
- **Logs:** `docs/ux-review-r32/logs/`, 88 JSON files: 72 name-pass runs plus 16 real-name runs.
- **Psycho run output** (`psycho.mjs`, head, dark), where Desk rows show only the project:
  - Desk rows: `"text":"VibeSquad","title":"Desk · VibeSquad","sep":"none"`
  - Lane rows: `"text":"Main GameMain Game Project","sep":"\" · \""`
- **Screenshots** (`docs/ux-review-r32/`):
  - `cmp-base-vs-head-long-xl.png`
  - `cmp-base-vs-head-real-names-1280.png`
  - `head-lane-ellipsis-1280.png`
  - `fix-preview-1280.png`
  - `head-dark-1280-longlane.png`
  - `head-psycho-light-nolane.png`
  - `head-{dark,light}-1920-window.png`
  - `head-dark-3200-window.png`

**Verdict: PASS 0/0/3**

## r2 re-check (2789ec41)

Date: 2026-11-25 · Build: `desk-u3-needs-loc` @ `2789ec41` (`npx vite build --outDir /tmp/r32/head2`, served by the R31 harness) · Change under review: `src/boring.css:1260-1263` (the lane is `flex: 0 0 auto; max-width: calc(100% - 6ch)`, the project is `flex: 0 1 auto`) and `test/desk-u3-needs-loc.test.mjs` (rewritten).

**Verdict: PASS 0/0/0** (critical/major/minor). m1, m2 and m3 are all closed and nothing regressed. One nit is noted below and not counted.

### Re-drive
- **Name passes:** `drive/runall.sh 5832 r2`, with the same 6 name passes as before (stock, long, xl, longlane, xllane, shortlane).
- **Coverage:** window widths 1280, 1920 and 3200, in dark and light. That is 36 runs, with 0 page errors.
  - The measured sidebar widths were 290, 307 and 380px.
  - Logs: `logs/r2-*.json`.
- **Sub-pixel detail:** `drive/detail.mjs` on the R32 real-name and stress pairs.
- **Psycho:** `drive/psycho.mjs`, in dark and light.
- **Full window:** `drive/full.mjs` at 1280 light, 1920 dark and light, and 3200 @1.2 dark.

### Status vs R32

| R32 item | Status at `2789ec41` | Evidence |
|---|---|---|
| **m1** · the lane loses its last glyph when the project overflows; "UI" became "U…" | **Closed.** <br>• "Standing Teams": the lane box is 90.08px with `scrollWidth` 90. Before it was 89.69px and clipped. It renders "Standing Teams · Windows · Vi…". <br>• "UI" + a long project: the lane box is 11.48px with `scrollWidth` 11. Before it was 11.44/17. It renders "UI · Escape From Idle Definitiv…". <br>• "Playtest Overlay · Escape Fro…" also keeps the whole lane. <br>• In the shortlane pass, `laneTrunc` is false at all 3 widths in both themes. | `r2-detail-lane-proj.png` (panels d1–d3), `r2-dark-1280-shortlane.png`, `logs/r2-*-shortlane.json` |
| **m2** · a long lane hid the project at 0px | **Closed.** The lane caps at `100% - 6ch` and ends in an ellipsis. The project keeps a 52.7px floor (the "·" separator plus about 4 glyphs) at all three widths. <br>• 290px: "Main Game Overwor… · Main …" <br>• 307px: "Main Game Overworld … · Main …" <br>• In the long, xl, longlane and xllane passes, `projW` = 53 in all 24 runs. Before it was 0 at 290/307 and 23 at 380. <br>• The location box never overflows the row (`whereOverflow` false in every run). | `r2-detail-lane-proj.png` (d4, d6), `r2-light-1280-xllane.png`, `logs/r2-*-{long,xl,longlane,xllane}.json` |
| **m3** · the probe never ran at 307px, used stock names only, and had assertions that couldn't fail | **Closed.** <br>• **Gap 1:** widths now come from the viewport (1280 → 290, 1920 → 307.2; `test/desk-u3-needs-loc.test.mjs:14-19`). Each case asserts the real sidebar width (`:60-62`), and test 5 asserts that 307 − 290 ≥ 15px. The committed artifacts now differ: 290 dark `0003552f…` vs 307 dark `3415a1b9…`, and 290 light `2b08e1dc…` vs 307 light `65650139…`. A local run regenerated them byte-identical. <br>• **Gap 2:** four stress rows are injected into the live DOM (`:94-153`): a medium lane with a long project, "UI" with a long project, a 27+ character lane, and an empty lane. <br>• **Gap 3:** the separator is now read through `getComputedStyle(…, "::before")` (`:88`, `:157`). The lane is checked against a sub-pixel text `Range` (`laneW >= laneTextW - 0.25`, `:140`, `:147`). That check catches the old "U…" case (11.44px box vs 17px text). The project floor is asserted `> 0` (`:151`), which catches the old 0px case. | test run below |

### Regression checks

| Check | Result | Evidence |
|---|---|---|
| Titles keep ≥ 20ch | **Pass.** The minimum title box is 178px at 290, 195px at 307 and 268px at 380 in all 36 runs. That matches R32 and BASE, and no title CSS changed. | `logs/r2-*.json` `whoW` |
| Desk/hub rows (Normal) | **Pass.** They read "Desk · VibeSquad" with the separator, unchanged. | `r2-dark-1920-window.png` |
| Psycho rows | **Pass. Unchanged from R32.** Psycho uses `src/styles.css`, which r2 did not touch. <br>• Desk rows show "VibeSquad" with `::before` = `none`. <br>• Lane rows have the " · " separator, in dark and light. <br>• Output matched R32 exactly. | `r2-psycho-{dark,light}.png` |
| Counts and selection | **Pass at 1280, 1920 and 3200.** <br>• The header reads `6`, which is 5 rows plus "▸ 1 more". <br>• "▸ Done recently · 4" is present. <br>• Project badges: Desk 4 + Bug Chaser 1 + Main Game 1 = 6, matching the Overview pills. <br>• Exactly one selected row (`sel: 1`). | `r2-{dark,light}-1920-window.png`, `r2-dark-3200-window.png`, `r2-light-1280-window.png` |

### Findings
**Critical:** none. **Major:** none. **Minor:** none.

**Nit, not counted:** the probe's floor assertion is `projW > 0` (`test/desk-u3-needs-loc.test.mjs:151`).
- **Risk:** a 1px "…" project would still pass. The real floor is 52.7px.
- **Optional tightening:** `projW >= 5 * chPx` would pin the 6ch cap.
- **Effort:** XS. No card.

### Spec follow-up (lead)
The R32 recommendation still stands, and r2 now delivers it. Amend SPEC R3 #3 to say that the project elides first, the lane stays whole when it fits (capped at `100% - 6ch`), and the project keeps a small floor.

### Worker probe run (this worktree, `2789ec41`, Chromium via `PLAYWRIGHT_DIR`)
```
ok 1 - U3: Needs-you rows at 290px (light): real sidebar width, stock geometry, long-name elision + project floor, empty-lane separator
ok 2 - U3: Needs-you rows at 307px (light): …
ok 3 - U3: Needs-you rows at 290px (dark): …
ok 4 - U3: Needs-you rows at 307px (dark): …
ok 5 - U3: 290px and 307px runs actually exercised distinct sidebar widths
# tests 5  # pass 5  # fail 0  # skipped 0
```
Without `PLAYWRIGHT_DIR`, all 5 tests skip ("no Playwright found"). CI needs that variable set, or the probe is silent there.

### r2 artifacts (`docs/ux-review-r32/`)
- `r2-detail-lane-proj.png`: d1 Standing Teams, d2 UI, d3 Playtest Overlay and d4 long lane, all at 1280; d6 long lane at 1920.
- `r2-dark-1280-shortlane.png`
- `r2-light-1280-xllane.png`
- `r2-{dark,light}-1920-window.png`, `r2-dark-3200-window.png`, `r2-light-1280-window.png`
- `r2-psycho-{dark,light}.png`
- `logs/r2-*.json`: 36 runs

**Verdict (r2): PASS 0/0/0**
