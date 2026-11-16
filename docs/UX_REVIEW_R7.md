# VibeSquad UX review, round 7: Normal mode (desk phase gate, re-review after R6 fixes)

Date: 2026-11-16 · Build: `master` @ `d7e1cd77` (deeplink `b8408627`, ctrlj `bd38479f`, reason `ac43acac`). `dist/index.html` was built at 12:59, after the last merge (12:58). `/api/health`: `ok`, `stale: null`.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). Live UI on `:4180`, both the **real squad** (523-agent roster) and `?demo`, at 3200×1800 and 1920×1080, dark and light.
- Every check ran in a **fresh browser context**, seeded only with `vs.prefs.v1 = {app.vibe: boring, app.theme}` and `vs.firstRunDone`. Without them, the first-run picker opens (`00`).
- Demo stall checks used Playwright's fake clock.
- I didn't read the plan before the first pass.

Evidence is in `artifacts/ux-desk-r7/` (numbers below refer to these files). The pink "EXPOSED" and orange "Read-only" strips come from the harness, not the app.

## Status vs round 6

| Item | Status | Evidence |
|---|---|---|
| R6-1 `?agent=` deep link on the real squad | **fixed** | **18/18 runs land.** Each was a fresh context, 3 tries per target per size: 3200 dark and 1920 light. The targets were picked to sort **late** in the 523-agent roster snapshot: EFI lead UIR4 `rn-ea0ce58df96c` (#474), EFI worker `rn-fe847768e038` (#517) and VibeSquad Release Desk Buddy `rn-fc6209feac8c` (#512). The state after 6s, the same on every try: <br>• **EFI lead:** URL `?team=efi&agent=rn-ea0ce58df96c`, breadcrumb "Escape From Idle › UI Raid › Lead", header "UI Raid · Lead 4", one selected row "UI Raid" (`01-deeplink-efi-lead-*`). <br>• **EFI worker:** "Escape From Idle › Platform, QA & Security › QA-SNAP-RAID-TOKEN-REVIEW2 · review (Gemini)", with the worker row selected (`01-deeplink-efi-worker-*`). <br>• **VibeSquad agent:** `?team=vibesquad&agent=…`, "VibeSquad › Release Desk › Brainstorm", Release Desk selected (`01-deeplink-vs-buddy-*`). <br>Each agent stays open, and nothing goes back to Overview. There's one loading blemish, R7-1. |
| R6-2 Ctrl+J vs the Needs-you list | **fixed** | **Empty list** (real squad, "All clear. Nobody needs you."): Ctrl+J from EFI Overview and from an open agent changed nothing (URL, breadcrumb and selection are the same before and after, `10`). Closed UIA7 `rn-19b72362b3c4` no longer surfaces. **Non-empty** (demo, 4K light, count 5): Ctrl+J opens row 0, "Audit - token scout". The URL is `team=vibesquad&agent=demo-aud`, the breadcrumb is "VibeSquad › Desk › Audit - token scout", there's one selected row, and the count stays 5 (`11`). Caveat: the live list stayed empty the whole session, so the non-empty path was only checked in demo. |
| R6-3 reason clamp, lane repeated in lead name | **fixed at 4K; partial at 1080** → R7-2 | 4K: the 103-char "Lead at 150k+ tokens: … approve the save-format merge" wraps to 2 lines and is not cut (`22`). The name reads "Lead 75" with location "Main Game · Escape From Idle", so the lane is no longer repeated. 1080: the same reason needs 3 lines and is cut at "…then approve the sav…" (`30`). |
| R5-2 title count incl. stalled | **holds** | Demo, fake clock: title "(5)/(14)/(15)" = count 5/14/15 at t0/+11m/+66m. Real squad: 0 = "VibeSquad". |
| R5-3 demo per-tab stall path | **holds** | At +66m I opened the 5 visible items in turn. The count stayed 15 and the title "(15)" after every open. |
| R5-4 URL = open agent | **holds** | Every open carried its `agent=` (for example `team=efi&agent=demo-lead-efi`). `?demo&team=efi` loads "Escape From Idle › Overview" and keeps it after a reload (`31`). |
| R5-5 header strip vs reason | **holds** | demo-mech: Needs you says "Stalled: no update for 80m" and the strip says "No update for 80m". demo-lead-efi: the banner says "NEEDS <OWNER> · Lead at 150k+ tokens…" and the strip line below says "No update for 69m" (`22`). These are two facts, not a conflict. |
| R5-6 name at 1080 | **holds** | All 5 Needs-you names fit at 264px. "Mechanical - rename sw…" is cut, as in R6 (`30`). |

### Invariants (checked live)

| Invariant | Result |
|---|---|
| Needs-you count = badges = tab title | ✓ demo 5/14/15. ✓ real 0 = "VibeSquad". |
| Count unchanged by opening agents | ✓ (R5-3). |
| Exactly one selected row | ✓ after every deep link (18), every Needs-you open, Ctrl+J, project A → B. |
| Breadcrumb = selected row = open agent | ✓ in the settled state everywhere. ✗ for 1.4–3.8s while a deep link loads (R7-1). |
| Expanded projects share one shape | ✓ EFI + VibeSquad both open: Desk (Overlord · RiffBot), Bugs, then lanes with age (`33`). |
| No agent listed > twice | Known open worker triple (idea-271), not re-counted. |
| WHY not truncated | ✓ 4K. ✗ 1080, 3-line reasons (R7-2, minor: the full text is in the banner one click away). |

## Round-7 findings

No critical or major findings.

### R7-1 · minor · A deep link shows the default project's Overview for 1.4–3.8s before the agent opens

- **Job hurt:** 3 (a notification link should land straight on the agent).
- **Evidence:** I traced the EFI worker link (4K, fresh context) every 100ms:
  - At 1421ms: URL `?team=efi&agent=rn-fe847768e038`, breadcrumb "Escape From Idle › Overview".
  - At 3813ms: breadcrumb "Escape From Idle › Platform, QA & Security › QA-SNAP-…".
  - The VibeSquad link shows "**Escape From Idle** › Overview" at 1.5s, the wrong project, before it lands on "VibeSquad › Release Desk".
  - At 1.5s, 13 of 18 runs were still on Overview.
- **Cause:** this is correct gating. `tryRestore` and `boringUrlAgent` now wait for `rosterLoaded` (`src/pinFocus.ts:327`, `src/pinFocusLogic.ts:123-124`). While they wait, the main pane renders the default team's Overview, and on a 523-agent roster the snapshot takes ~1.5–4s.
- **Fix:** while the URL has `agent=` and `!rosterLoaded`, render a neutral "Opening agent…" placeholder (or a skeleton) with a bare breadcrumb, not a project Overview.
- **Files:** `src/BoringAde.tsx` (main-pane choice near `:532`). **Effort:** XS. **Lane:** @desk.

### R7-2 · minor · At 1080 a long Needs-you reason is still cut at 2 lines

- **Job hurt:** 3.
- **Evidence (`30`):** "Lead at 150k+ tokens: wrap up and hand off at a good stopping point, then approve the sav…" at 264px. At 4K it fits in full.
- **Fix:** clamp to 3 lines below ~1400px, or accept the clamp as is. The full reason is in the agent banner, one click away.
- **Files:** `src/boring.css`. **Effort:** XS. **Lane:** @desk.

## Jobs-first walk (regressions)

- **Job 2, monitor:**
  - The real VibeSquad Overview lists every lane with Brainstorm/Lead state, "N live · M idle", a Last-event line ("desk: R6 merged d7e1cd77 …") and age (`33`). It reads well at 4K.
- **Project A → B:**
  - Clicking VibeSquad goes from `?team=efi` "Escape From Idle › Overview" to `?team=vibesquad` "VibeSquad › Overview", with one selected row (`32`).
  - Both projects stay expanded, with the same shape (`33`).
- **Lead, then worker:**
  - Lead: the deep link to QA6 opens "Platform, QA & Security › Lead".
  - Worker: the worker deep link (above) expands the tree and selects the worker row (`34`, `01-deeplink-efi-worker-*`).
- **Real 1080 light, first load:** EFI Overview, nothing broken (`35`).
- **No regressions** from the three merges.

## Owner decisions

1. **Two "Desk" rows under VibeSquad.** The tree and Overview show both "Desk" (the Overlord · RiffBot hub block, "1 live · 4 idle") and "Desk lane @Des" (the desk feature lane) (`33`). Is that the intended name for the lane? **Recommendation:** keep the hub block as "Desk". Show the feature lane by its purpose, for example "Desk (Normal mode)", or by its handle alone, so the two don't read as duplicates. This isn't counted as a finding.

## Screenshots (`artifacts/ux-desk-r7/`)

- `00` fresh context without prefs (first-run picker).
- `01-deeplink-{efi-lead,efi-worker,vs-buddy}-{3200-dark,1920-light}` deep-link results, try 1 of 3.
- `10` real Ctrl+J with an empty list (no-op).
- `11` demo Ctrl+J with a non-empty list (opens row 0).
- `20` demo Needs-you at t0, 4K dark; `21` demo 15 alerts at +66m.
- `22` demo-lead-efi open, 2-line reason in full, banner and strip.
- `30` demo 1080 light sidebar; `31` demo `team=efi` after a reload.
- `32` real A → B; `33` two projects expanded.
- `34` real QA lead open; `35` real 1080 light first load.

**Verdict: PASS 0/0/2 d7e1cd77.** R6-1, R6-2 and R6-3 are fixed (R6-3 in full at 4K), and R5-2 through R5-6 still hold. The two open findings are minor (R7-1, R7-2). Neither blocks the Normal-mode phase gate.
