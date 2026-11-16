# VibeSquad UX review, round 5: Normal mode (desk R2/R3 phase gate, re-review after R4 fixes)

Date: 2026-11-16 · Build: `master` @ `3d924978` (R4-1 (a) `fb3a4c16`/`5f29caa1`, interim `0fcad217`, R4-2..7 `23372258` + `0022a64e`). Runtime restarted at 3d92497; `/api/health` `stale: null`.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). Live UI on `:4180`, both the **real squad** and `?demo`, at 3200×1800 and 1920×1080, dark and light. I used fresh browser contexts for the real-squad and two-tab checks. Demo stall checks used Playwright's fake clock (`page.clock.fastForward`). I didn't read the plan before the first pass.
Evidence: `artifacts/ux-desk-r4b/` (numbers below refer to these files). The raw runner roster snapshots used to cross-check the UI are in `artifacts/ux-desk-r4b/data/agents-*.json`, with the summariser `run.cjs`. The pink "EXPOSED" and orange "Read-only" strips come from the harness, not the app.

## Round-4 findings: status

| R4 | Status | Evidence |
|---|---|---|
| R4-1 stall depends on opened chats | **fixed on the real squad.** Residual in `?demo`: see R5-3 | All 385 live real agents carry `openToolSince` (null or a number; `data/agents-1.json`). Running Bash/shell/grep tools showed with name and timeout. ART-QUALITY-R4 had a Bash open for 9m and was **not** listed (count 0 at 15:29Z). Two fresh real-squad tabs agreed every 30s for 3 min (0/0), then 1/1 with the title "(1)" (`20`, `21`, `30`). Demo at +11m: demo-art-g (quiet 12m, server tool open 7m) is **not** stalled, and demo-mech (server: no tool) is. At +66m the ceiling fires: "Tool run_command running 73m" (`05`). Opening demo-mech and demo-art-g never changed the count. Caveat: no real agent went quiet ≥10m without a tool during the window, so the quiet branch was checked in demo only. |
| R4-2 two lane names | **fixed** | Tree "Main Game", breadcrumb "Escape From Idle › Main Game › Lead", header "Main Game · Lead 75 · Lead · @Mai", Overview "Main Game @Mai" (`02`, `11`). One name, one code. |
| R4-3 location truncates the lane | **fixed** | The lane comes first: "Desk · VibeSq…", "Main Game · E…" at 1080 (`10`). The lane is visible in every row. New squeeze on the agent name: R5-6. |
| R4-4 error cause cut | **fixed** | "EOF · Post cloudcode-pa.googleapis.com", 250/250px, not truncated (`02`, `10`). |
| R4-5 two "Desk" rows | **fixed** | The VibeSquad tree shows "Desk" (hub) and "Desk lane" (`04`). |
| R4-6 Ctrl+J doesn't set `?agent=` | **fixed** | Ctrl+J → `?demo=&team=vibesquad&agent=demo-aud`, and a reload keeps it (`08`). Ctrl+J always opens the *top* item (`src/App.tsx:1360`), so pressing it again stays put. That's by design. |
| R4-7 composer raw title | **fixed** | "Message Main Game · Lead 75… (Enter to send…)" (`11`). |
| Out of area: Overview "Last event" telemetry | fixed | It now shows verdict lines ("FAIL: Worker stopped before…", "PASS 0/0/0 …") (`20`). |
| Out of area: stale build toast | fixed | No toast; health `stale: null`. |
| Out of area: `beforeunload` prompt | by design, one note | The pref is Settings › App › "Confirm before closing while agents run" (`src/App.tsx:1508-1514`). It still fires in read-only `?demo`, where nothing can be lost. → @bug, minor, not gated. |

### Invariants (checked live)

| Invariant | Result |
|---|---|
| Needs-you count = sum of collapsed badges | ✓ demo 5 = 1+4 (`02`); +66m 15 = 1+14 (`05`). Real squad 1 = 1 (`30`). |
| Needs-you count = **tab title / favicon** | ✗ demo "(4) VibeSquad" while Needs you shows 5, 14 and then 15 (`02`, `03`, `04`). **R5-2** |
| #9 count unchanged by opening agents | ✓ real squad. ✓ demo at t0 (5 → 5 across all 5 opens). ✗ demo at +66m: 15 → 7 while opening 15 agents. **R5-3** (fixture gap, not the real path) |
| Exactly one selected row | ✓ in every state checked (Overview, Needs-you open, Ctrl+J, demo `?agent=`, Brainstorm) |
| Breadcrumb = selected row = open agent | ✓ on screen. ✗ for the **URL** on load (R5-4), and the real-squad `?agent=` link never opens (R5-1). |
| Expanded projects share one shape | ✓ where seen (`04`, `24`). I didn't re-run the dedicated two-expanded sequence. |
| No agent listed > twice | ✗ demo-mech appears in Needs you, the tree and the Workers tab, 3× (`04`). Known, tracked as idea-271. |
| WHY not truncated | ✓ every reason 250/250px at 1080 and fits at 4K. Risk: R5-5 (tool "name" can be a whole script). |

## Round-5 findings

### R5-1 · major · `?agent=` deep links don't open the agent on the real squad

- **Job hurt:** 3 (respond: a push notification or shared link should land on the agent) and 5 (intervene).
- **Evidence:**
  - Fresh context, `?agent=rn-9332105a3905` (★ Art25, idle EFI lead) and `?agent=rn-efc3a8daa785` (a running EFI worker), with and without `team=efi`. Every attempt ends on "Escape From Idle › Overview" with `?team=efi`. Waiting 10.5s doesn't change it (`22`, `23`).
  - Navigation trace: `?agent=X` → `?team=efi&agent=X` → `?team=efi`. `vs.panes.v1` goes from the opened tab to `{"leftTabs":[],…,"leftActiveId":null}` within ~500ms.
  - The same link works in `?demo`, where the roster is present instantly (`07`). That's probably why R4's ✓ didn't catch it.
- **Likely cause (verify):** `useRestorePrune` (`src/QuickWinsUi.tsx:237-248`) runs once when `rosterLoaded` turns true. `rosterLoaded` turns true when the runner link comes up (`src/paseo.ts:458`), which can be before the agent list is applied. The prune then sees an empty map, drops the deep-linked tab, and `exitSquadsHome()` lands on the grid.
- **Fix:**
  - Prune only tabs restored from storage, never the tab the URL asked for (`initialUrlAgent`, `src/pinFocus.ts:53`).
  - Gate the prune on the first agent snapshot being applied, not on the connection.
  - Add a live-mode test: a deep link to an agent that arrives 1s after connect.
- **Files:** `src/QuickWinsUi.tsx`, `src/paseo.ts`, `src/panes.ts`. **Effort:** S. **Lane:** @desk (or @bug if @desk is busy).

### R5-2 · major · The tab title and favicon count leave out stalled agents

- **Job hurt:** 3 and 2. With the tab in the background, the title is the only signal. It says 4 while Needs you says 15.
- **Evidence:**
  - Demo t0: title "(4)", Needs you 5.
  - +11m: "(4)" vs 14.
  - +66m: "(4)" vs 15 (`02`–`05`).
  - Same squad, two numbers. This also contradicts the "one stall rule for Needs you, its count and every badge" comment in `src/boringHeaderStrip.ts:16`.
- **Cause:** `useAttentionTitle(views)` (`src/App.tsx:1515` → `src/QuickWinsUi.tsx:67`) sums `views[].needsYou` from the teams model. That model only counts Paseo/label attention. The Normal sidebar adds `stalledCount(...)` (`src/BoringAde.tsx:198,218`), but the title never does.
- **Fix:** feed the title and favicon the same list that renders `boring-needs-you-count`: one `needsYouTotal(members, now)` used by both. Add it to invariant #1.
- **Files:** `src/QuickWinsUi.tsx`, `src/App.tsx`, `src/attentionItems.ts`. **Effort:** XS–S. **Lane:** @desk.

### R5-3 · minor · Demo fixtures still use the old per-tab stall path, so invariant #9 fails in `?demo`

- **Job hurt:** none for the owner directly. It hurts review and test fidelity, since `?demo` is where reviewers and tests check this.
- **Evidence:** at +66m I opened all 15 Needs-you items in turn. The count went 15 → 15 … 14 → 13 → … → 7, one step behind each timeline load. Only demo-mech and demo-art-g held steady: they're the only fixtures with explicit `openToolSince` (`src/demo.tsx:68,71`).
- **Cause:** fixtures with no field fall back to the timeline hint (`src/attentionItems.ts:62-67`), which is the R4-1 per-tab behaviour.
- **Fix:** give every demo agent `openToolSince: null` by default (or a value where the timeline shows a running tool), so demo matches the live runner. Consider deleting the hint fallback now that the runner is the only backend (`server/backend/` has only `runner-backend.mjs`).
- **Files:** `src/demo.tsx`, `src/attentionItems.ts`, `src/openTools.ts`. **Effort:** XS. **Lane:** @desk.

### R5-4 · minor · On load, the URL doesn't match what's open

- **Job hurt:** 5 (reload, share).
- **Evidence:**
  - Loading `?demo&team=efi` lands on **VibeSquad › Desk › Art Painter** (the last tab saved in `vs.panes.v1`) and rewrites the URL to `?demo=&team=vibesquad` with no `agent=` (`06`). The requested project is ignored and the URL doesn't name the open agent.
  - The demo deep link `?demo&agent=demo-lead-efi` opens the right agent but leaves the URL at `?demo=&team=efi` with `agent=` dropped.
  - Opening 15 agents leaves 15 restored "tabs" in `vs.panes.v1`, even though Normal has no tab strip.
- **Fix:** an explicit `team=` in the URL should beat the saved pane. After any open, including restore and deep link, write `agent=` through the same URL sync as the Needs-you click.
- **Files:** `src/pinFocus.ts`, `src/panes.ts`, the URL sync in `src/App.tsx`. **Effort:** S. **Lane:** @desk.

### R5-5 · minor · The two stall sources still disagree on one screen, and a Gemini "tool name" is the whole script

- **Job hurt:** 3. You need to read why without guessing.
- **Evidence:**
  - Demo-mech at +66m: Needs you says "Stalled: no update for 80m" (server: no open tool). The header strip of the same agent says **"Tool "Agent" running 87m · Cancel & resume"** (`04`).
  - The header strip shows a hung tool at 7m/21m, while Needs you uses the 60m ceiling.
  - Real roster: ART-QUALITY-R4 · review (Gemini) publishes `openToolName` as a 12-line PowerShell script (`$iso = Join-Path $env:TEMP … git status --short`, `data/agents-6.json`). Past the ceiling, the Needs-you reason would read "Tool $iso = Join-Path … running 61m".
- **Cause:**
  - The header strip reads `audit.a3HungTool` from the loaded timeline (`src/BoringAgentHeader.tsx:108,152-154`), not `openToolOf()`.
  - `runner/open-tools.mjs:41` takes `e.name` as-is, and for ACP/Gemini that's the command text.
- **Fix:**
  - The header strip uses `openToolOf()` and the same ceiling. Keep the 90s "No update" hint as is.
  - Normalise the tool name on the server: the ACP tool kind, or the first word of the command, capped at ~24 chars.
  - Also consider a small grace over the tool's own timeout (e.g. +60s), so a Bash isn't flagged the moment it's about to time out by itself.
- **Files:** `src/BoringAgentHeader.tsx`, `runner/open-tools.mjs`, `src/boringHeaderStrip.ts`. **Effort:** S. **Lane:** @desk + @own.

### R5-6 · minor · At 1080 the agent name is squeezed to ~10 characters

- **Job hurt:** 3.
- **Evidence:** "Audit - token sc…", "Review - Sonnet…", "Main Game · Le…", "Mechanical - re…" (`10`, `11`). The R4-3 fix put the location inline on line 1, so the name and location now split ~180px. At 4K it's fine.
- **Fix:** at narrow widths, drop the project from line 1 (lane only, since the project is on the badge), or move the location to the end of line 2 after the reason.
- **Files:** `src/BoringInbox.tsx:169-172`, `src/boring.css`. **Effort:** XS. **Lane:** @desk.

### Outside the area under review (no effect on the gate)

- **`?demo` shows live data in the EFI Overview.** Registered EFI lanes show the real squad's "Last event" ("FAIL: no completed successful run containing e2d72f50…", "PASS 0/0/0 88128882…") (`10`). Demo is supposed to be a fixed cast. → @desk, minor.
- **`beforeunload` in read-only `?demo`** (see the status table). → @bug, minor.

## Plan

| # | Change | Files | Effort | Lane |
|---|---|---|---|---|
| R5.1 | Deep link survives the restore-prune; prune gated on the first agent snapshot | `src/QuickWinsUi.tsx`, `src/paseo.ts`, `src/panes.ts` | S | @desk |
| R5.2 | Title/favicon use the Needs-you list count | `src/QuickWinsUi.tsx`, `src/App.tsx`, `src/attentionItems.ts` | XS–S | @desk |
| R5.3 | Demo fixtures carry `openToolSince`; drop the hint fallback | `src/demo.tsx`, `src/attentionItems.ts` | XS | @desk |
| R5.4 | URL `team=` beats the saved pane; `agent=` always written | `src/pinFocus.ts`, `src/panes.ts`, `src/App.tsx` | S | @desk |
| R5.5 | Header strip on `openToolOf()`; short tool names; timeout grace | `src/BoringAgentHeader.tsx`, `runner/open-tools.mjs` | S | @desk + @own |
| R5.6 | Lane-only location at narrow widths | `src/BoringInbox.tsx`, `src/boring.css` | XS | @desk |

Suggested test additions:
- Invariant #1 should also assert `document.title` and the count agree.
- A live-mode (non-demo) e2e should check that `?agent=<id>` lands on that agent once the roster arrives late.

## Owner decisions

1. **Should the tab title and favicon count stalled agents (R5-2)?** Option (a): yes, one number everywhere. Option (b): no, the title counts only "you must act" items (permission, question, error), and the sidebar shows the same split, e.g. "Needs you 4 · Stalled 11". **Recommendation: (a).** The R4-1 decision put stalls in the count; two numbers that disagree are worse than either rule.
2. **Should `?demo` ever show live squad data (Outside #1)?** **Recommendation: no.** Demo is the fixed cast reviewers and tests rely on.

## Screenshots (`artifacts/ux-desk-r4b/`)

`01` live 4K first load · `02` demo 4K light first load · `03` demo +11m · `04` demo +66m, demo-mech open (header vs Needs-you reason) · `05` demo +66m, 15 alerts expanded · `06` `?team=efi` lands on VibeSquad agent · `07` demo `?agent=demo-lead-efi` · `08` Ctrl+J · `10` 1080 dark/light demo Overview · `11` 1080 dark/light Lead 75 open · `20`/`21` live 4K dark, two tabs · `22`/`23` live deep link fails (worker / lead) · `24` live Art Pipeline Brainstorm · `30` live 1080 light, VibeSquad.

**Verdict: FAIL 0/2/4 3d92497.** R4-1 through R4-7 are fixed. The phase gate stays closed on R5-1 (real-squad deep links) and R5-2 (title count disagrees), unless the owner overrides.
