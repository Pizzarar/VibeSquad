# VibeSquad UX review, round 6: Normal mode (desk phase gate, re-review after R5 fixes)

Date: 2026-11-16 · Build: `master` @ `9563c6e0` (count `eed7be80`, strip `18d4c21f`, deeplink `b62b91ba` (`c21e225c` + `a4ca2135`), toolname `bad2ea6d`, shared-now `b4092298`). `dist/index.html` was built at 12:15, after every merge. `/api/health` reports `stale: null`.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). Live UI on `:4180`, both the **real squad** and `?demo`, at 3200×1800 and 1920×1080, dark and light.
- Every check ran in a **fresh browser context**. The only seeded state was `vs.prefs.v1 = {app.vibe: boring, app.theme}` and first-run done, so each context starts in Normal (`01` shows the first-run picker you get without them).
- Demo stall checks used Playwright's fake clock.
- I didn't read the plan before the first pass.

Evidence is in `artifacts/ux-desk-r6/` (numbers below refer to these files). The pink "EXPOSED" and orange "Read-only" strips come from the harness, not the app.

## Round-5 findings: status

| R5 | Status | Evidence |
|---|---|---|
| R5-1 `?agent=` deep link on the real squad | **NOT fixed** → R6-1 | Fresh context, `?agent=rn-38a9b5e1ee33` (★ Des3, the live Desk lead, VibeSquad) and `?agent=rn-42298bc90206` (RiffBot), 4K dark and 1080 light. Both end on **"Escape From Idle › Overview"** with URL `?team=efi` (`02`, `02-…-riffbot`, `03`). Trace: `?agent=X` → `?team=efi&agent=X` at ~230ms → panes emptied and `?team=efi` at ~1.5–2.3s. The server stream is fine: its first `roster` event (~100ms, 520 agents) contains both ids. |
| R5-2 title count leaves out stalled | **fixed** | Demo, fake clock: title "(5)/(14)/(15)" = Needs you 5/14/15 at t0/+11m/+66m (`10`–`12`). Real squad, two fresh tabs (4K dark + 1080 light), 7 samples over 3 min: "(1)" = 1 in both tabs, then later "VibeSquad" = all clear. One source in code: `needsYouTotal` (`src/attentionItems.ts:155`). Caveat: no real agent stalled during the window, so the stalled path was checked in demo only. It runs through the same function. |
| R5-3 demo per-tab stall path | **fixed** | At +66m I opened all 15 Needs-you items in turn. The count stayed **15** and the title "(15)" after every open. |
| R5-4 URL ≠ open agent on load | **fixed** | `?demo&team=efi` with a saved pane goes to "Escape From Idle › Overview", and a reload keeps it (`21`). `?demo&agent=demo-lead-efi` keeps `agent=` in the URL (`20`). After each of the 15 opens the URL carried that agent's `agent=` (for example `?demo=&team=vibesquad&agent=demo-mech`). |
| R5-5 header strip vs Needs-you reason; long tool name | **fixed** | demo-mech: Needs you says "Stalled: no update for 81m" and the strip says "No update for 81m" (`14`). demo-art-g: both say "Tool run_command running 73m". All 15 agree. The server-side short name is in `bad2ea6d`. No real long-running Gemini tool came up to re-check live. |
| R5-6 name squeezed at 1080 | **fixed** | At 1080 only the lane is shown: "Desk", "Main Game". 4 of 5 names fit; "Mechanical - rename sw…" is cut at 159px (`22`). Fine. |
| Outside: `?demo` shows live data | **fixed** | The demo EFI Overview has no live "Last event" (`12`). |

### Invariants (checked live)

| Invariant | Result |
|---|---|
| Needs-you count = collapsed badges = tab title | ✓ demo 5 = 1+4, 14 = 1+13, 15 = 1+14, title equal. ✓ real 1 = 1 = "(1)", then 0 = "VibeSquad". |
| Count unchanged by opening agents | ✓ demo +66m, 15 opens (R5-3). |
| Exactly one selected row | ✓ Needs-you opens, demo deep link, real lane (Art Pipeline Brainstorm), real worker (`36`, `37`). ✗ after Ctrl+J on the real squad, no row is selected (R6-2). |
| Breadcrumb = selected row = open agent | ✓ everywhere except the two failing paths: the real `?agent=` link (R6-1), and Ctrl+J, where the breadcrumb is just "Escape From Idle" with the UI Screens · Lead 7 chat open (R6-2, `34`). |
| Expanded projects share one shape | ✓ EFI + VibeSquad both open: Desk (Overlord · RiffBot), Bugs, then lanes with age and workers (`35`). |
| No agent listed > twice | ✗ an open worker appears in the tree row, the breadcrumb role chip and the Workers panel (`37`). Known, tracked as idea-271. Not counted here. |
| WHY not truncated | ✓ demo (all 15 reasons). ✗ real 4K: "Lead at 150k+ tokens: wrap up and hand off at a good sto…" (R6-3, `30`). |

## Round-6 findings

### R6-1 · major · `?agent=` deep links still don't open the agent on the real squad (R5-1 reopened)

- **Job hurt:** 3 (a notification or shared link should land on the agent) and 5.
- **Evidence:** `02`, `02-…-riffbot`, `03`, and the trace in the status table. It reproduces 3 times out of 3 in fresh contexts, at both sizes. Along the way the URL briefly claims `team=efi` for a VibeSquad agent.
- **Cause (traced in the bundle with a `setItem` stack):**
  - The R5-1 fix gated `useRestorePrune` on the first snapshot. A **second** startup path has the same race: `tryRestore` (`src/pinFocus.ts:322-357`).
  - It is subscribed to every store change (`:357`) and fires once `conn === "connected" && agents.size > 0` (`:325`).
  - The stream's `onopen` sets `conn` connected first. The roster snapshot is then applied **one agent at a time**, and each `applyAgent` notifies listeners (`src/paseo.ts:446`, `:91-100`).
  - So `tryRestore` runs once, after the first agent of 520. The linked agent isn't in the map yet, so `urlAgentLive` is false and `planRestore` returns `closeStale = urlAgent`. Then `closeTab(urlAgent)` runs (`:347`) and the result is `home`, which lands on Overview.
- **Why the new test passed:** `test/deeplink-live.test.mjs` doesn't load `pinFocus.ts`, and its snapshot puts the linked agent first (`:100`). It would pass even with `tryRestore` loaded.
- **Fix:**
  - Gate `tryRestore` on `ps.rosterLoaded`, not `conn`/`size`.
  - Apply a snapshot as one store update: build the map, then `set` once. This also removes ~520 listener passes per snapshot.
  - Make the test load `pinFocus.ts` and put the linked agent **last** in a multi-agent snapshot.
  - Optionally, don't write `team=` until the agent is resolved.
- **Files:** `src/pinFocus.ts`, `src/paseo.ts`, `test/deeplink-live.test.mjs`. **Effort:** S. **Lane:** @desk.

### R6-2 · major · Ctrl+J opens an agent the Needs-you list hides (a closed former lead) while the list says "All clear"

- **Job hurt:** 3. Ctrl+J is the keyboard "take me to what needs me".
- **Evidence (`34`, real squad, 4K dark):**
  - Needs you: "All clear. Nobody needs you.", title "VibeSquad".
  - Ctrl+J opens **UI Screens · Lead 7** (`rn-19b72362b3c4`) with a "NEEDS AUB · Lead at 150k+ tokens…" banner.
  - The breadcrumb is just "Escape From Idle", and no tree row is selected.
  - `vs status rn-19b72362b3c4` reports `status: "closed"`. It's a former lead whose last message says its token is invalid after the restart.
  - So three surfaces disagree: the list (0), the jump (1) and the banner.
- **Cause:**
  - `openTopNeedsYou` takes `railAlerts().list[0]` (`src/App.tsx:1361`). That is Psycho's rail list (`src/FocusRail.tsx:37`), which doesn't filter retired/closed agents and doesn't include stalls.
  - Normal's list comes from `attentionItems`, which does both.
  - `boringSelectionForAgent` finds no lane for the closed agent, so `BoringApp` ignores the event (`src/BoringAde.tsx:485-487`) and the plain `openAgent` fallback opens it with no selection.
  - This also means R4-6's "Ctrl+J opens the top Needs-you item" only holds when the two lists happen to agree.
- **Fix:**
  - In Normal, Ctrl+J opens row 0 of the list that renders `boring-needs-you-count`. Export that from the attention module, so the count and the jump share one source.
  - With an empty list, Ctrl+J does nothing (or shows a "Nothing needs you" toast).
  - Separately, `railAlerts` should drop `isRetiredAgent` members, for Psycho too.
  - Add to the invariants test: Ctrl+J target = Needs-you row 0, or nothing.
- **Files:** `src/App.tsx`, `src/FocusRail.tsx`, `src/attentionItems.ts`, `src/BoringAde.tsx`. **Effort:** S. **Lane:** @desk.

### R6-3 · minor · At 4K the real Needs-you reason is cut, and a lead's name repeats its lane

- **Job hurt:** 3.
- **Evidence (`30`):** line 1 reads "UI Shell & Hideout · Lea… UI Shell & Hideout…" and line 2 reads "Lead at 150k+ tokens: wrap up and hand off at a good sto…".
  - The full reason is in the tooltip and the agent banner. But the sidebar is ~380px at 3200 wide, and real reasons are longer than the demo ones.
  - Leads named "<Lane> · Lead N" spend half of line 1 saying the lane twice.
- **Fix:**
  - Let the reason wrap to 2 lines (clamp 2) instead of 1.
  - When the agent name already starts with the lane, show the role ("Lead 17") as the name, or drop the location.
- **Files:** `src/BoringInbox.tsx:166-175`, `src/boring.css`. **Effort:** XS. **Lane:** @desk.

## Fresh jobs-first walk (regressions)

- **Job 2, monitor:** the real EFI Overview shows lane, Brainstorm/Lead state, "N live · M idle" workers, a real "Last event" verdict line and age (`30`). It reads well at 4K.
- **Project A → B:** clicking VibeSquad lands on "VibeSquad › Overview" with `?team=vibesquad` (`33`).
- **Two projects expanded:** both have the same shape (`35`).
- **Lane, then worker:** Art Pipeline opens its Brainstorm. The worker opens from the Workers panel, and the tree expands to show it selected. Breadcrumb "Escape From Idle › Art Pipeline › ART-QUALITY-R5B…" = selected row = header (`36`, `37`).
- **Running worker header:** it shows "No update for 3m" while its Bash is open. That's the 90s hint, kept by design since R5-5. It isn't flagged in Needs you, which is correct.
- **No regressions** from the five merges except R6-2. R6-2 surfaced now because a closed lead still carries a needs-you label; the rail list never filtered it.

## Plan

| # | Change | Files | Effort | Lane |
|---|---|---|---|---|
| R6.1 | `tryRestore` gated on `rosterLoaded`; snapshot applied in one store update; test loads pinFocus with the linked agent last | `src/pinFocus.ts`, `src/paseo.ts`, `test/deeplink-live.test.mjs` | S | @desk |
| R6.2 | Normal Ctrl+J = Needs-you row 0 (none = no-op); `railAlerts` drops retired | `src/App.tsx`, `src/FocusRail.tsx`, `src/attentionItems.ts` | S | @desk |
| R6.3 | 2-line reason clamp; no lane repeated in lead names | `src/BoringInbox.tsx`, `src/boring.css` | XS | @desk |

A suggested gate for R6.1: a Playwright run against the real runner. Use a fresh context and `?agent=<a live lead that sorts late in the roster>`, then assert that the breadcrumb ends in that agent after 5s. Unit tests with a 2-agent fake roster have now missed this twice.

## Owner decisions

1. **Should a closed or retired agent that still carries a needs-you label appear anywhere in Normal (R6-2)?** **Recommendation: no.** Clear or hide it with its lane. The Needs-you list already hides it. Only Ctrl+J and the agent's own banner still surface it, and opening a dead agent can't be acted on.

## Screenshots (`artifacts/ux-desk-r6/`)

- `01` fresh context without prefs (first-run picker).
- `02` live 4K deep link, Desk lead, lands on EFI Overview; `02-…-riffbot` the same for RiffBot.
- `03` live 1080 light, the same deep link.
- `10`/`11`/`12` demo 4K light at t0, +11m and +66m.
- `13` demo 15 alerts.
- `14` demo-mech open (strip agrees).
- `20` demo 1080 deep link, dark/light.
- `21` demo `team=efi` Overview, dark/light.
- `22` demo 1080 sidebar, dark/light.
- `30` live 4K dark first load (reason cut).
- `31` live 1080 light first load.
- `33` VibeSquad Overview.
- `34` Ctrl+J opens a closed lead while "All clear".
- `35` two projects expanded.
- `36` Art Pipeline Brainstorm.
- `37` worker open.

**Verdict: FAIL 0/2/1 9563c6e.** R5-2 through R5-6 and the demo live-data issue are fixed. The phase gate stays closed: R5-1 still reproduces on the real squad (R6-1, a second startup path with the same race), and Ctrl+J has a new major issue (R6-2).
