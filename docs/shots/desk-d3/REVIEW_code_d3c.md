# Code Review · @desk D3c (`unit-desk-d3c-context-panel`, HEAD `4900d42`)

**Verdict:** `PASS 0/2/3 4900d42`
**Cause-vs-symptom gate:** PASS — Fixes the structural root cause (duplicate right column in Normal mode and missing lane supervision context next to chat) by building `src/BoringContextPanel.tsx` as the single Normal-mode right panel (`Workers | Changes | Plan | Feed | Files | Terminal`) and unmounting `AgentDrawer`'s inner `RightDock` when `vibe === "boring"`.

## Verification commands (`4900d42`)
- `npx tsc --noEmit`: exit 0 (0 errors)
- `node --test test/desk-d3c-context-panel.test.mjs test/boring-mode.test.mjs test/prefs.test.mjs`: 74/74 pass (`531ms`)
- `node --test test/css-classes.test.mjs test/ui-theme.test.mjs test/desk-d3b-toolrows.test.mjs`: 16/16 pass (`241ms`)
- `git diff --stat origin/master...HEAD`: only `src/AgentDrawer.tsx`, `src/BoringAgentHeader.tsx`, `src/BoringContextPanel.tsx`, `src/boring.css`, `test/desk-d3c-context-panel.test.mjs`, and `docs/shots/desk-d3/d3c-*.png` touched (`0` edits to `src/styles.css` or `art/**`).

## Checklist (1–8)

1. **Psycho mode (`vibe=fun`) still renders `RightDock` exactly as before:** **PASS.**
   - `src/AgentDrawer.tsx:552` branches on `vibe === "boring" && !chatOnly` for `BoringAgentHeader` vs `DrawerHeader` (`dockOpen={dockOpen}`, `onToggleDock={() => !chatOnly && setDockOpen((v) => !v)}` at `src/AgentDrawer.tsx:645-646`).
   - `src/AgentDrawer.tsx:684-688` renders `<RightDock key={agent.id} agent={agent} />` when `vibe !== "boring" && dockOpen && !chatOnly`. `src/RightDock.tsx` is untouched.
2. **Only one right column exists in Normal mode:** **PASS.**
   - `src/AgentDrawer.tsx:679-688` makes `<BoringContextPanel>` (`vibe === "boring" && !chatOnly`) and `<RightDock>` (`vibe !== "boring" && dockOpen && !chatOnly`) mutually exclusive.
3. **All existing `data-testid`s are kept:** **PASS.**
   - `BoringAgentHeader` preserves `data-testid="boring-dock-toggle"` (`src/BoringAgentHeader.tsx:199`); `BoringContextPanel` adds `boring-context-panel`, `boring-context-toggle`, `boring-context-body`, `boring-context-tab-{workers,changes,plan,feed,files,terminal}`, `boring-ctx-workers(-empty)`, `boring-ctx-worker-<id>`, `boring-ctx-plan(-empty)`, and `boring-ctx-feed(-empty)`. All 74 tests in `test/boring-mode.test.mjs` + `test/desk-d3c-context-panel.test.mjs` pass.
4. **CSS is scoped under `html[data-vibe="boring"]`; no edit to `src/styles.css` or `art/**`:** **PASS.**
   - Every rule in `src/boring.css:1061-1088` begins with `html[data-vibe="boring"]`. `0c7e8a5` removed the extra `@media` block so `boring.css` keeps its two-`@media` invariant.
5. **`openRightDockTab` routing works (file links, "Open in Changes", quick open):** **PASS (with M1/L1 notes below).**
   - `src/BoringContextPanel.tsx:141-153` stays mounted in Normal mode (even when collapsed, rendering `<aside className="boring-context-panel collapsed">`), listens to `vs:open-right-dock`, maps `Changes | Files | Terminal` via `TAB_FOR_DOCK` (`src/BoringContextPanel.tsx:53`), calls `setContextPanelOpen(true)` and `setTab(next)`, and forwards `target.file` / `target.line` / `target.nonce` to `<FilesPanel>`.
   - Commit links (`openCommit` in `src/changesNav.ts:6-9`) call `requestCommit(cwd, sha)` then `openRightDockTab("Changes")`; `<ChangesPanel>` claims the commit via `takeCommitRequest` / `onCommitRequest`.
6. **Feed fetch has no leaks or polling storms, and cleans up on unmount:** **PASS.**
   - `src/BoringContextPanel.tsx:106-116` keys the `useEffect` strictly on `[teamId]`, sets `dead = true` on cleanup, skips `setInterval` in `DEMO`, guards interval ticks with `document.hidden || load()` at `10_000ms`, and calls `clearInterval(t)` on unmount. Because `FeedTab` is conditionally mounted only when `tab === "Feed"` (`src/BoringContextPanel.tsx:173`), switching away from the `Feed` tab or collapsing the panel unmounts `FeedTab` and stops polling immediately.
7. **Collapse/persist logic is correct at the `1600px` boundary:** **PASS.**
   - `contextPanelOpen(pref, viewportWidth)` (`src/BoringContextPanel.tsx:25-30`): `const wide = viewportWidth >= 1600; if (pref === "0") return false; if (pref === "1") return true; return wide;`.
   - `useContextPanel()` (`src/BoringContextPanel.tsx:48-51`) uses `useSyncExternalStore` subscribed to `window` `"resize"` and `setContextPanelOpen`, reading `localStorage.getItem("vs.context-panel.open")`. Below `1600px` (`1599`) with no explicit pref it returns `false`; at `1600px` it returns `true`; explicit `"0"` / `"1"` overrides persist across resizes.
8. **Assessment of worker-declared known gaps (Scripts/Project tabs dropped in Normal, Plan shows only pinned todo, Feed is read-only):** **NONE is a MUST regression.**
   - **`Scripts` / `Project` tabs dropped in Normal:** Matches `docs/PLAN_DESK_UX_REDESIGN.md` line 18 (`Workers | Changes | Plan | Feed | Files | Terminal`) and line 68 (`Workers · Changes · Plan · Feed`, plus access to `Files · Terminal`). Not a MUST regression.
   - **`Plan` shows only `findPinnedTodo(entries)`:** Matches `docs/UX_REVIEW.md` §5 Step 2.8 ("reuse ... the plan/todo from `src/Timeline.tsx`"). Normal mode previously had only `PinnedTodo` in `Timeline.tsx:1601`. Not a regression.
   - **`Feed` is read-only:** In `docs/UX_REVIEW.md` §3 Direction A, the right context panel is a compact lane supervision surface showing recent log events (`DONE`, `BLOCKER`), while full `TeamFeed` with the owner composer remains accessible in Normal mode under `Overview -> Standup Feed` (`src/BoringAde.tsx:660,695`). Not a MUST regression.

## Findings (0 High / 2 Medium / 3 Low)

- **M1 (`src/BoringContextPanel.tsx:58` vs `src/pins.ts:67-70,106` — `WorkersTab` idle count includes closed workers, disagreeing with the sidebar):**
  - `WorkersTab` filters `resolve(agents)` by `m.kind === "worker" && !m.agent.archivedAt && (m.laneId ?? "").toLowerCase() === laneId.toLowerCase()`, whereas `pinsForSquad` (`src/pins.ts:68,106`) filters lane workers with `isLive` (`!m.agent.archivedAt && m.agent.status !== "closed"`). Closed (unarchived) workers are counted in `idle` in `WorkersTab` (`7 idle workers hidden`) while the sidebar (`src/BoringAde.tsx:503-505`) excludes `status === "closed"` (`▸ 6 idle`). Filter out `m.agent.status === "closed"` (or use `isLive(m)`) so both surfaces report the same idle worker count.
- **M2 (`src/AgentDrawer.tsx:663-689`, `src/boring.css:751-754` — Composer centres across full drawer width while timeline centres in `1fr - 460px`):**
  - `<BoringContextPanel>` is mounted inside `.drawer-shell` alongside `<Timeline>`, while `.composer` is a sibling below `.drawer-shell`. When the 460px context panel is open, `.timeline > *` centres inside the remaining left area, whereas `.composer > *` centres across the entire `.drawer` width (shifting ~230px right relative to the timeline column; also flagged by Art Director M1 in `docs/shots/desk-d3/REVIEW_director_d3c.md`).
- **L1 (`src/BoringContextPanel.tsx:149` — Line-only `vs:open-right-dock` event drops `line`):**
  - `RightDock.tsx:74-75` handles `else if (detail.line !== undefined) setTargetLine(detail.line)`, whereas `BoringContextPanel.tsx:149` only updates `target` when `d.filePath !== undefined`. All current callers pass `filePath`, so this has no live impact today, but matching `RightDock`'s fallback is safer.
- **L2 (`src/BoringContextPanel.tsx:34` & `src/AgentDrawer.tsx:247-256` — `vs:open-right-dock` in Normal mode mutates `vs.right-dock.open` and `dockOpen`):**
  - `AgentDrawer.tsx:251-256` still listens to `vs:open-right-dock` and sets `dockOpen(true)` (writing `vs.right-dock.open = "true"` at line 248) even when `vibe === "boring"`, and `openRightDockTab` (`src/RightDock.tsx:22-30`) sets `pendingOpen` because `dockMounted` is `0` in Normal mode. Harmless unless the user switches to Psycho within 2s of clicking a file link.
- **L3 (`src/BoringAgentHeader.tsx:68,148` — `sentenceCase("SPEC / PLAN")` produces `"Spec / plan"`):**
  - `sentenceCase` lowercases the entire remainder of `AGENT_TYPE_LABEL[p.agentType]`, which works cleanly for `"Lead"`, `"Brainstorm"`, `"Implement"`, `"Retired lead"`, etc., and turns `"SPEC / PLAN"` into `"Spec / plan"` (acceptable under UX_REVIEW §4.1 sentence-case rule).
