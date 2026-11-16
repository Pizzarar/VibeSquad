# VibeSquad UX review, round 4: Normal mode (desk R2/R3 phase gate)

Date: 2026-11-16 · Build: `master` @ `643d61d0` (includes desk `d6cb4513`, `db6fda42`, `2346ed0a`, `f5661908`, R3-2 `e4241d30`). The served bundle was confirmed new (it carries `data-agent-id`, added after `a3a64e2a`).
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). Live UI on `:4180`, both `?demo` (fixed cast) and the **real squad** (no `?demo`). Sizes 3200×1800 (4K at 120%) and 1920×1080, light and dark. I didn't read the plan until after the first pass.
Evidence: `artifacts/ux-desk-r3/` (numbers below refer to these files). The pink "EXPOSED" and orange "Read-only" strips come from the harness, not the app.

## Round-3 findings: status

| R3 | Status | Evidence |
|---|---|---|
| R3-1 worker dump under Desk | **fixed** | After Ctrl+J, Desk shows Lead, Brainstorm, the 3 alerting workers as one-liners, then "▸ 9 running · 6 idle" (`06`). 3 shown + 9 = 12 live, matching the Overview and the Workers tab. Residual: alerting workers are still listed 3× (Needs you, tree, Workers tab). Tracked as invariant #6 / idea-271, not re-counted here. |
| R3-2 stalled floods Needs you | **open: see R4-1** | 10m threshold in place. The tool-in-flight exclusion only works for agents you've opened in this browser session. |
| R3-3 reason squeezed by location | **half** | The reason now has all of line 2. The location moved to line 1 and now truncates to nothing ("Escape F…", 55px at 1080). Error causes are still cut. See R4-3 and R4-4. |
| R3-4 "Mai75" | **fixed**, one leftover | Needs you and the header read "Main Game · Lead 75". The composer placeholder still reads "Message ★ MAIN GAME ord75…" (`05`). See R4-7. |
| R3-5 project name in brand slot | fixed | Fixed "VibeSquad" mark (`01`, `17`). |
| R3-6 floating footer | fixed | Footer top at y=1668 in every 4K state checked, including 15 alerts expanded and two projects expanded. y=948 at 1080. |
| R3-7 count styles | fixed | "▸ 10 more", "Done recently · 4". Done recently is hidden while the list is expanded (`11`). |

### Invariants (checked live, not from tests)

| Invariant | Result |
|---|---|
| Needs-you count = sum of collapsed badges | ✓ 4 = 1+3 (`02`); 15 = 1+14 (`11`); real squad 6 = 5+1 (`13`) |
| Exactly one selected row | ✓ in every state (Overview A/B, two expanded, Needs-you open, Ctrl+J, `?agent=`, real worker) |
| Breadcrumb = selected row = open agent | ✓ in the same states. The **label** disagrees with Needs you for dynamic lanes (R4-2). |
| Expanded projects share one shape | ✓ Desk, Bugs, lanes (`04`) |
| No agent listed > twice | ✗ alerting workers are listed 3× (known, idea-271) |
| WHY not truncated | ✗ error causes (R4-4). Stall/permission/question reasons fit (323px at 4K, 250px at 1080). |

## Round-4 findings

### R4-1 · major · Stall exclusion depends on which chats you've opened in this tab (R3-2 not met)

- **Job hurt:** 3 (respond when something needs me) and 2 (monitor). The Needs-you count can't be trusted.
- **Evidence:**
  - **Real squad (`13`, `14`, `15`):** Needs you showed 6. Five were EFI workers marked "Stalled: no update for 12–15m". I opened one (RAID-LENGTH-RECORD-ROW). Its header strip says **"Tool "Bash" running 16m"**, and its timeline says "The suite is running in the background with a 4200 s tool timeout. I'm waiting for it to finish." It was doing its job. Once its chat was open it dropped out, and the count went 6 → 5. The other four are the same kind of worker and are still listed. Even this reviewer showed up as "Stalled".
  - **Demo (`10`, `11`, `12`):** with the clock moved forward 11 min, Needs you = 15 (11 stalled). After I clicked each stalled item once (just viewing, no dismiss), it fell to **4**.
  - The same squad shows different counts in two tabs, on Android, or after a reload.
- **Cause:** `src/openTools.ts:1-3` (the file says it): "Agents whose timeline was never loaded this session have no data here, so they keep the plain 10-minute rule." Only `useTimeline` feeds it (`src/Timeline.tsx:1027`). Second problem: `src/boringHeaderStrip.ts:16` treats any open tool as never stalled, so a tool hung for hours never surfaces. That's the real "stuck" case, and job-walk row 77 ("find a stuck worker and its reason") depends on it.
- **Spec question:** R3-2 assumed "the header strip already knows the running-tool duration". It only knows for the agent on screen. Monitoring needs a source that every client shares.
- **Fix:** have the server/daemon track the oldest open tool call per agent from the agent event stream and put `openToolSince` on the agent summary. Then use one rule everywhere:
  - stalled = running, no update ≥ 10m, no open tool; **or**
  - an open tool older than a ceiling (e.g. 60m, or the tool's own timeout) → "Tool Bash running 75m".

  Leads waiting on workers through a blocking `vs wait` are the common false positive today.
- **Files:** `src/openTools.ts`, `src/boringHeaderStrip.ts`, `src/attentionItems.ts`, the server agent summary (`server/`). **Effort:** M. **Lane:** @desk (client), plus @own (own-daemon) for the server field.

### R4-2 · major · A dynamic lane has two names: Needs you says "Main Game", the tree and breadcrumb say "OpenRouter pipeline critique"

- **Job hurt:** 3 and 2. You read "Escape From Idle › Main Game" in Needs you and can't find a "Main Game" lane in the tree. The lit row is "OpenRouter pipeline critique @main".
- **Evidence:**
  - Opening the item (`05`) gives a breadcrumb of "Escape From Idle › OpenRouter pipeline critique › Lead", a header of "Main Game · Lead 75 · Lead · **@main-game**", and a tree code of **@main**. That's three names and two codes for one lane.
  - Reproduces in `?demo`: `demo-lead-efi` sits in lane `main-game`, whose only Buddy has topic "OpenRouter pipeline critique" (`src/demo.tsx:91-93`).
- **Cause:** two name sources.
  - The tree, breadcrumb and Overview use `pin.lane.name` (`src/BoringAde.tsx:220`), which `deriveDynamicLaneName` takes from the first Buddy's **topic** (`src/teams.ts:637-645`).
  - Needs you uses `boringLocationLane` (`src/boringLocation.ts:13-19`), which takes the registered lane or the slug.
  - The lead title uses its `lane` label.
- **Fix:** one `laneDisplayName(team, laneId)` used by the tree, breadcrumb, Overview, Needs you and the header. Name a lane by its id/registered name. Show a Buddy topic as a secondary label ("Main Game · OpenRouter pipeline critique"), never as the lane name. One code source (`@main` vs `@main-game`).
- **Files:** `src/teams.ts`, `src/boringLocation.ts`, `src/BoringAde.tsx`, `src/BoringInbox.tsx`. **Effort:** S. **Lane:** @desk.

### R4-3 · minor · The location on line 1 truncates away the lane

- **Job hurt:** 3. You can't tell which lane an item is in without hovering.
- **Evidence:**
  - Real squad at 1080 (`17`): every item reads "Escape F…". The `boring-needs-where` span is 55px. Names are cut too ("GAUZE-3PCT · impl …", 130px).
  - At 4K (`13`) it reads "Escape From I…" / "Escape From Id…". The lane (UI Raid, Economy & Balance, Platform QA…) is never visible, and the lane is the useful half.
- **Fix:** show the lane first and drop or abbreviate the project ("UI Raid · EFI"), or truncate the project before the lane (start-ellipsis on the project only). The project is already signalled by the badge.
- **Files:** `src/BoringInbox.tsx:176`, `src/boring.css`. **Effort:** XS. **Lane:** @desk.

### R4-4 · minor · Error reasons cut off the cause

- **Job hurt:** 3. To know why without a click, you need the cause.
- **Evidence:** "Post "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent": **EOF**". The cause ("EOF") is at the end and is hidden in Needs you (`01`, `06`, `11`) and in the Workers tab (`06`).
- **Fix:** condense errors before display. Strip URLs to their host, or show the cause first: "EOF · Post cloudcode-pa…". Or use a middle-ellipsis.
- **Files:** `needsYouReason` in `src/BoringInbox.tsx`, `src/attentionItems.ts`. **Effort:** XS–S. **Lane:** @desk.

### R4-5 · minor · Two "Desk" rows in one project

- **Job hurt:** 2.
- **Evidence:** VibeSquad shows the core "Desk" (Overlord · RiffBot) and a lane registered as "Desk @Des" in the tree and in the Overview (`04`, `13`).
- **Fix:** reserve "Desk" as a display name for the hub, and show a colliding lane as "Desk lane" or by its code. Or rename the lane (owner decision below).
- **Files:** `src/BoringAde.tsx` (`boringLaneLabel`). **Effort:** XS. **Lane:** @desk.

### R4-6 · minor · Ctrl+J doesn't update `?agent=`

- **Job hurt:** 5. Reload or share loses your place.
- **Evidence:** after a Needs-you click the URL is `…&agent=demo-lead-efi`. After Ctrl+J it stays `?demo=&team=vibesquad`, with "Audit - token scout" open (`06`). A reload lands on the Overview.
- **Fix:** route Ctrl+J through the same open path as the Needs-you click.
- **Files:** the Ctrl+J handler (`src/CommandPalette.tsx:412`) → `openNeedsYou` in `src/BoringAde.tsx`. **Effort:** XS. **Lane:** @desk.

### R4-7 · minor · R3-4 leftover: the composer still shows the raw title

- **Evidence:** "Message ★ MAIN GAME ord75… (Enter to send…)" under a header that reads "Main Game · Lead 75" (`05`).
- **Fix:** use the same display title.
- **Files:** composer placeholder in `src/Timeline.tsx` / `src/BoringAde.tsx`. **Effort:** XS. **Lane:** @desk.

### Outside the area under review (no effect on the gate)

- **The Overview "Last event" column shows raw telemetry:** "hook-timing hook=agent.created total=16 labels-for=13…", "brief-orphan-conflict lane=ui-bois orphan=C:\Users\…", "mcp-alias: tool=send_agent_prompt caller=…" (`04`, `13`, `17`). These are internal events, not what the lane did. → @desk (Overview), minor.
- **The "Running an older build: 2 commits behind (000228f → a3a64e2)" toast and `/api/health` `stale` are stale.** They're still showing after the frontend-only sync to 643d61d, and they're wrong about the bundle actually served (`13`, `17`). → @bug, minor.
- **Every navigation away from the page raises a `beforeunload` "leave site?" prompt**, even in read-only `?demo` with an empty composer. I hit it while driving the app and didn't dig further. → @bug, to verify.

## Plan

| # | Change | Files | Effort | Lane |
|---|---|---|---|---|
| R4.1 | Server-side `openToolSince` per agent; stall rule = quiet ≥10m and no open tool, or open tool ≥ ceiling | `server/`, `src/openTools.ts`, `src/boringHeaderStrip.ts`, `src/attentionItems.ts` | M | @desk + @own |
| R4.2 | One lane display name and code source; Buddy topic is secondary | `src/teams.ts`, `src/boringLocation.ts`, `src/BoringAde.tsx`, `src/BoringInbox.tsx` | S | @desk |
| R4.3–4.7 | Lane-first location; condensed error reasons; reserved "Desk"; Ctrl+J sets `?agent=`; composer title | `src/BoringInbox.tsx`, `src/boring.css`, `src/BoringAde.tsx`, `src/CommandPalette.tsx` | XS each | @desk |

Suggested invariant to add: **#9 "the Needs-you count doesn't change when you open and close an agent".** Open each listed agent, return to the Overview, and assert the count and badges are unchanged. It would have caught R4-1.

## Owner decisions

1. **Where the "tool in flight" signal lives (R4-1).** Option (a): server/daemon tracks open tools for every agent, so all clients agree; this needs @own work. Option (b): the client fetches a timeline tail for every running agent that's been quiet for 10m+; no server work, but more requests and still per-client. **Recommendation: (a).** Until it lands, consider (c): drop "stalled" from the Needs-you count and keep it as the amber-ring glyph only. A count that's wrong 5 times out of 6 on the real squad is worse than no stall alert.
2. **The "Desk" lane name collision (R4-5).** Rename VibeSquad's `desk` lane (e.g. "Normal UX"), or have the app reserve "Desk" and show colliding lanes by code. **Recommendation:** reserve the name in the app, so no future lane can collide.

**Verdict: FAIL 0/2/7 643d61d.** The phase gate stays closed until R4-1 and R4-2 are fixed or the owner overrides.
