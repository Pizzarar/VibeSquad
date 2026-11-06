# Handoff — VibeSquad / ui-polish (`@uip`) / `★ UIP2` (`ord=2`)

- **Outgoing Lead:** `★ UIP2 · chat header & scroll polish` (`75d8e490-ab03-4eee-8e29-b4e49d10e40a`, `Lead - Gemini`)
- **Current Live Brainstorm (`vs who brainstorm`):** `UIP Buddy` (`2bd76275-f64b-4c9d-afab-194c949e57b2`)
- **Workers in Flight in `@uip`:** **0** (all U9–U17 workers and reviewers have finished and been archived; all `@uip` worktrees have been swept via `vs worktree sweep --apply`).
- **Git / Release State:** `master`, `origin/master`, `origin/beta`, `dev/master`, and `dev/beta` include U17 (`745a4e6`); local runtime (`C:\Users\Fugma\AppData\Local\VibeSquad\runtime`) is synced; `v0.2.6` stable (`307fa60`) and `v0.2.7-beta.1` (`d33f1ff` / `e358766`) are published on GitHub Releases.

## Judgment

### Decisions
- **Units U8–U17 (`docs/PLAN_UI_POLISH.md`) ALL COMPLETE & MERGED (`745a4e6`):**
  - **U8 (`a957a02`, `cf25bc0`, `d33f1ff`):** Published beta releases (`0.2.6-beta.1`, `0.2.6-beta.2`, `0.2.7-beta.1`) via `npm run release:beta`.
  - **U9 (`35b87f1`, Review `a68d10f4` PASS):** Fixed inverted profile resolution in `src/DrawerHeader.tsx` & `server/brainstorm.mjs`, staged provider/model in top bar without immediate restart, seamlessly switched & forwarded `pendingPrompt` on next message send in `src/AgentDrawer.tsx`, and stitched predecessor timeline entries + stripped boot preamble in `src/Timeline.tsx` (`15/15` pass in `test/uip-u9-seamless-provider-switch.test.mjs`).
  - **U10 (`c96ac2a` + `cddc7af` → `028293a`, Review `2053fecf` PASS):** End-to-end control wiring audit; forwarded staged `model`/`modeId`/`thinkingOptionId` with `labels["profile-override"] = "1"` and `env.VS_PROFILE_OVERRIDE = "1"`, plus `Shift+Tab` mode cycling while staged (`20/20` pass in `test/uip-u10-control-wiring.test.mjs`).
  - **U11 (`cb40a08` + `9cdc483` → `fe1d8c0`, Review `ce377361` PASS):** Live Chromium Playwright smoke suite (`test/uip-u11-playwright-smoke.test.mjs`, `6/6` pass in ~3s over static `dist/` loopback server).
  - **U12 (`14947fe` + `9cdc483` → `c1401f4`, Review `8e6b1d55` PASS):** Swept all red tests on `master` (`1636/1636` pass, 0 failures).
  - **U13 (`307fa60`):** Published `v0.2.6` via `npm run release:stable` (syncing both `latest/download/latest.json` and `download/beta/latest.json` to `0.2.6`), and pushed `master` + `beta` branches & tags to `origin` and `dev`.
  - **U14 (`44f22a1`, Review `473c0231` PASS):** Fixed `.hard-bar` wrapping in `src/styles.css`, tightened `PROMISE_RE` in `src/antigravity.ts` (first-person intent + 110-char excerpt cap), stripped duplicate `★`/`💬`/`•` glyphs in `TeamRow` (`src/PinGrid.tsx`), and compacted Active Buddy Card in `src/DrawerHeader.tsx` behind `⋯ More` (`16/16` pass in `test/uip-u14-sidebar-audit.test.mjs`).
  - **U15 (`db8cdeb` + `e358766`, Review `473c0231` PASS):** Removed redundant `Lead: ... · N workers ▸` button from `PinFocusBar` (`src/PinRail.tsx`), deduplicated `compactIdentity` & `✕` in `drawer-head-compact`, and wrapped `Thinking ▾` + `Mode ▾` in `<details className="drawer-config-menu">` (`13/13` pass in `test/uip-u15-topbar-declutter.test.mjs`).
  - **U16 (`68e9654`, Review `f328dbc2` PASS):** Exported `noteTimelineOffers(agentId, entries)` in `src/PinGrid.tsx` and called it in `useTimeline` (`src/Timeline.tsx`), rendered inline `<SpinOffCard>` / `<SendToCard>` / `<LooksDoneCard>` beneath `vs:spin-off` / `vs:send-to` / `vs:looks-done` code blocks in `MarkdownRenderer` (`src/Timeline.tsx`) via `findPinForAgent(agentId)` (`src/PinIdeas.tsx`), included `<LooksDoneCard>` in `SendToBar`, and raised `SPIN_OFF_MAX` to `10` + accepted bare `vs:spin-off` fences + stripped `**`/`\`` from team names in `server/pin-ideas.mjs` (`22/22` pass in `test/spin-off.test.mjs` + `test/uip-u16-spinoff-button.test.mjs`).
  - **U17 (`745a4e6`, Review `4706aad1` PASS):** Added `markAgentRead` (`src/paseo.ts`), `markPinRead` & clickable `NeedsBadge` (`src/PinGrid.tsx`), `pin-rail-mark-read` (`src/PinRail.tsx`), first-class `✓ Mark read` / `Mark unread` toggle in `primaryUtils` & `NeedsYouControls` (`src/DrawerHeader.tsx`), and fixed all 4 260px right-rail menu spillages (`.brainstorm-warn-banner` / `.brainstorm-handoff-banner`, `.brainstorm-feedback-bar` / `.brainstorm-feedback-actions`, `.you-bar` / `.you-flag` / `.lint-bar`, and `.drawer-labels-list .chip` in `src/styles.css` + `src/DrawerHeader.tsx`; `17/17` pass in `test/uip-u17-mark-read-spillage.test.mjs`).

### Gotchas
- **`uip-u7-topbar-provider.test.mjs` 900-char window:** `test/uip-u7-topbar-provider.test.mjs` slices 900 chars starting at `data-testid="drawer-head-compact"` and checks that `{providerSelect}`, `{modelControl}`, `{thinkingSelect}`, `{modeSelect}`, and `<WorkingChip` appear in order. Keep `compactIdentity` extracted outside `drawer-head-compact` so the JSX block stays `< 900` chars.
- **`uip-u11-playwright-smoke.test.mjs` serves `dist/`:** Always run `npm run build` before `test/uip-u11-playwright-smoke.test.mjs` when modifying `src/` so the static `dist/` server serves the updated bundle.
- **Claude quota cap:** Claude is currently capped (`vs cap list`); use `antigravity-cli/gemini-4-argon` (`Review - Gemini` / `Lead - Gemini`) or `antigravity-cli/gemini-3.8-flash` (`Pre-check - Flash`).

### Next 3 Steps
1. All units U1–U17 in `docs/PLAN_UI_POLISH.md` are complete, merged to `master` (`745a4e6`), synced to local runtime, and pushed to `origin/master`, `origin/beta`, `dev/master`, and `dev/beta`.
2. Wait for `UIP Buddy` (`2bd76275-f64b-4c9d-afab-194c949e57b2`) to hand off any next UI Polish units from the owner.
3. If the owner requests a new beta/stable installer build with U16+U17 baked in, run `npm run release:beta` (or `npm run release:stable`) and push `HEAD` to `origin` and `dev` (`master` + `beta`).

### Don't-Do
- Do not remove `.pin-focus-plumbing` or the earlier `.pin-focus-bar { height: auto; min-height: 40px; flex-wrap: wrap ... }` rule from `src/styles.css` — `test/ui-polish-2-u1-u2-u4.test.mjs` asserts on both.
- Do not stage untracked files from other lanes (`docs/art/`, `docs/lanes/android-app/`, `docs/lanes/bug-chaser/`, `docs/research/`) when committing on `master`.
