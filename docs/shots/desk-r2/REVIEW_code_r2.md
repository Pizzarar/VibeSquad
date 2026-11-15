# Code Review · `unit-desk-r2-sidebar` (`43e6d04`)

**Verdict:** `FAIL 1/3/2 43e6d04` (1 High, 3 Medium, 2 Low)
**Commits reviewed:** `1c2b709`, `7e5f44d`, `43e6d04` (`origin/master...HEAD`)
**Spec:** `docs/PLAN_DESK_R2_SIDEBAR.md` (`docs/UX_REVIEW_R2.md`)

## Verification Run
- `npx tsc --noEmit`: PASS (exit 0)
- `node --test test/boring-mode.test.mjs test/prefs.test.mjs test/desk-d3c-context-panel.test.mjs test/pair-modal-scroll.test.mjs test/sync-runtime-live-needs.test.mjs`: PASS (103/103 tests)

---

## Findings

### High

1. **[H1] `scripts/ui-clicks.mjs` still references removed `boring-project-overview-btn` and unexpanded Desk child testids (`scripts/ui-clicks.mjs:64`, `src/BoringAde.tsx:603, 618-621`)**
   - `scripts/ui-clicks.mjs:64` still defines:
     ```js
     ...[["boring-overview", "boring-project-overview-btn"], ["boring-overlord", "boring-core-overlord"], ["boring-riffbot", "boring-core-riffbot"], ["boring-bugs", "boring-core-bugs"], ["boring-usage", "boring-usage-btn"], ["boring-settings", "boring-settings-btn"]].map(([id, t]) => ({ id, setup: (p) => boringClick(p, t) })),
     ```
   - `boring-project-overview-btn` was removed in `7e5f44d` (replaced by `boring-project-header-<teamId>`).
   - In addition, `boring-core-overlord` and `boring-core-riffbot` are now only rendered when `deskBlock` is expanded (`src/BoringAde.tsx:603, 618-621`), which defaults to collapsed on Overview/home (`deskOpen[key] ?? inDesk` is `false`), so `boringClick(p, "boring-core-overlord")` and `boringClick(p, "boring-core-riffbot")` will also time out unless `boring-desk-toggle` is clicked first.

### Medium

1. **[M1] `openNeedsYou` does not update `selectedWorkerId`, and parent auto-expansion does not override explicit collapse or expand idle workers (`src/BoringAde.tsx:410-417, 524, 553, 557, 603, 605`; `test/boring-mode.test.mjs:1025-1056`)**
   - In `src/BoringAde.tsx:410-417`:
     ```tsx
     const openNeedsYou = (row: NeedsYouRow) => {
       if (row.teamId !== view?.team.id) onSelectSquad(row.teamId);
       const sel = boringSelectionForAgent(row.view, row.item.id);
       setSelectedLaneId(sel?.laneId ?? null);
       if (sel && sel.role !== "worker") setSelectedRole(sel.role);
       setMode("chat");
       openAgent(row.item.id);
     };
     ```
     Unlike the `activeAgentId` `useEffect` (`src/BoringAde.tsx:368-369`), `openNeedsYou` never sets `setSelectedWorkerId(sel?.role === "worker" ? row.item.id : null)`. If `activeAgentId` in `panes` was already `row.item.id` (e.g., user viewed that worker, clicked the project row to visit Overview, then clicked the worker in `Needs you`) or on the render before `useEffect` fires, `selectedWorkerId` stays stale (`null`), causing `agentId` (`src/BoringAde.tsx:442-449`) to resolve to `null` (for `_desk` hub workers) or the lane's Brainstorm/Lead instead of the worker.
   - Parent auto-expansion (`src/BoringAde.tsx:524, 553, 603, 605`) relies solely on nullish coalescing (`projectOpen[id] ?? ...`, `laneOpen[key] ?? isSel`, `deskOpen[key] ?? inDesk`, `deskWorkersOpen[key] ?? ...`). Once a user collapses a project, Desk, or lane (`false` stored in state), jumping to an agent inside it via `Ctrl+J` or `Needs you` leaves the parent collapsed and the `.on` row hidden. Moreover, `idleWorkersOpen` (`src/BoringAde.tsx:557`: `const idleOpen = Boolean(idleWorkersOpen[key]);`) has no selection fallback at all, so selecting an idle worker (e.g., an `unread` worker) never reveals its row.
   - **Unit test gap:** `test/boring-mode.test.mjs:1041-1056` (`"R2.1 sidebar: exactly one row is .on and the breadcrumb agrees (Overview, worker, project switch)"`) only mounts a single project (`squad(...)`) and manually clicks `boring-conv-toggle-ade` then `boring-worker-w1`. It does not test `Ctrl+J`, `openNeedsYou`, switching projects in `<BoringApp>`, or parent auto-expansion (only the pure `boringActiveSelection` helper is tested with cross-project args at lines `1025-1039`).

2. **[M2] Clicking `Bugs` under a non-active expanded project opens the old project's Bugs agent (`src/BoringAde.tsx:425-432, 636-640`)**
   - In the unified project tree, every expanded project renders `bugsRow(v, m)`:
     ```tsx
     const bugsRow = (v: TeamView, m: ReturnType<typeof boringSidebarModel>) => {
       const b = m.core.bugs;
       const openBugs = () => { if (v.team.id !== activeTeamId) onSelectSquad(v.team.id); pickBugs(); };
     ```
   - `pickBugs()` (`src/BoringAde.tsx:425-432`) reads `if (core.bugs.pin && core.bugs.agentId) openAgent(core.bugs.agentId);` from the current `view` closure (`core = model.core`) instead of the clicked project's `m.core.bugs` (`b`). Clicking `Bugs` under a second expanded project opens the *first* project's Bugs agent, which then triggers `useEffect([activeAgentId])` (`src/BoringAde.tsx:366`) and snaps the Squad selection back to the first project.
   - Additionally, `bugsRow` delegates to `laneRow(v, { laneId: "_bugs", ... })` (`src/BoringAde.tsx:559, 561`), which hardcodes `data-testid="boring-conv-_bugs"` and `data-testid="boring-conv-toggle-_bugs"` without `suffix(v, ...)`, duplicating those testids whenever multiple projects are expanded.

3. **[M3] Sidebar Search trigger advertises `Ctrl+K` but opens transcript search instead of Command Palette (`src/BoringAde.tsx:647-649`, `src/keymap.ts:23, 29, 33`)**
   - `src/BoringAde.tsx:647-649` renders:
     ```tsx
     <button type="button" className="boring-search-trigger" data-testid="boring-sidebar-search-btn" title="Search all transcripts" aria-label="Search (Ctrl+K)" onClick={() => openOverlay("search")}>
       <span aria-hidden="true">⌕</span><span>Search</span><kbd className="boring-kbd">Ctrl+K</kbd>
     </button>
     ```
   - **What `Ctrl+K` actually does today:**
     - Global scope (`src/keymap.ts:23`, `src/CommandPalette.tsx:496-499, 581`): `{ id: "palette", label: "Command palette", defaults: ["Ctrl+K", "Ctrl+Shift+P"] }` — opens the **Command Palette** (`mode = "palette"`).
     - `files-editor` scope (`src/keymap.ts:33`, `src/FilesPanel.tsx:561`): `{ id: "inlineEdit", label: "Inline edit the selection (Files editor)", defaults: ["Ctrl+K"], scope: "files-editor" }`.
     - Transcript search (`src/keymap.ts:29`: `{ id: "search", label: "Search all transcripts", defaults: [] }`) has **no default shortcut**.
   - While `[⌕ Search  Ctrl+K]` came from the R2 wireframe (`docs/UX_REVIEW_R2.md:50`, `docs/PLAN_DESK_R2_SIDEBAR.md:24`), wiring the button to `openOverlay("search")` while labelling it `Ctrl+K` means clicking the button and pressing `Ctrl+K` open two different overlays.

### Low

1. **[L1] Collapsed project badge uses `v.needsYou ?? 0` instead of `m.totalNeedsYou`, and `coreRow` badge omits `err` tint (`src/BoringAde.tsx:210, 595, 668`)**
   - `boringSidebarModel` computes `totalNeedsYou = Math.max(view?.needsYou ?? 0, hubNeedsYou + laneTotal + core.bugs.needsYou)` (`src/BoringAde.tsx:210`), but the collapsed project row (`src/BoringAde.tsx:668`) renders `badge(v.needsYou ?? 0, m.projectErr)` instead of `badge(m.totalNeedsYou, m.projectErr)`.
   - `coreRow` (`src/BoringAde.tsx:595`) calls `badge(needsYou)` without passing the member's error state (`err`), so an errored Overlord or RiffBot row inside an expanded Desk shows an amber badge instead of `--st-err`.

2. **[L2] Dead CSS selectors in `src/boring.css` (`src/boring.css:155, 167, 169, 176, 192, 656, 766, 879`)**
   - `.boring-core-group`, `.boring-trinity-card`, and `.boring-new-conv-btn` remain in earlier rules of `src/boring.css` after their JSX elements were removed in `7e5f44d`.

---

## Focus Checklist Summary

1. **`boringActiveSelection` pure derivation & unit tests:** Pure selector implemented at `src/BoringAde.tsx:139-157`; at most one `.on` row and worker title in last crumb verified. However, `openNeedsYou` misses `setSelectedWorkerId`, parent auto-expansion does not clear explicit `false` state in `projectOpen`/`laneOpen`/`deskOpen` or open `idleWorkersOpen`, and `test/boring-mode.test.mjs:1041-1056` does not test cross-project `Ctrl+J`/`Needs you` jumps or parent auto-expansion on `<BoringApp>` (**M1**).
2. **One tree shape:** Detached `boring-core-group` / `boring-conv-list` and `open && !active` split are removed; project name click calls `openProject` (`mode = "project"`) and chevron calls `toggleProject`. Clicking `Bugs` in a non-active expanded project has a closure bug (**M2**).
3. **Removed testids grep (`test/`, `src/`, `scripts/`):** `scripts/ui-clicks.mjs:64` still references `boring-project-overview-btn` (and unexpanded `boring-core-overlord` / `boring-core-riffbot`) (**H1**).
4. **Overview `_desk` row & `boringHeaderStrip` context dedup:** Single `_desk` row implemented at `src/BoringAde.tsx:297-301, 768-773`; `boringHeaderStrip` suppresses `"Context N% full"` when `meterShown && !canHandoff` (`src/boringHeaderStrip.ts:28`, `src/BoringAgentHeader.tsx:121-130`).
5. **Collapsed-only worst-state badges:** Implemented on project, Desk, and lane containers with `.boring-badge.err` (`--st-err`); minor `totalNeedsYou` / `coreRow` `err` discrepancy (**L1**).
6. **CSS scoping & Psycho isolation:** All new rules in `src/boring.css:1099-1137` are scoped under `html[data-vibe="boring"]` with no `@media` rules; no edits to `src/styles.css` or `art/**`.
7. **Search `Ctrl+K` label:** Button opens `openOverlay("search")` ("Search all transcripts", unbound by default) while `Ctrl+K` is bound to `"palette"` (Command Palette) globally and `"inlineEdit"` in `files-editor` (**M3**).

## Cause-vs-Symptom Gate
- **Does this fix the cause or hide the symptom?** The one-tree refactor and `boringActiveSelection` selector address the architectural root cause of the split sidebar and desynchronised breadcrumb, but the incomplete `openNeedsYou` / auto-expand state transitions (**M1**), non-active project `Bugs` closure (**M2**), and broken `scripts/ui-clicks.mjs` surface definitions (**H1**) must be resolved before merge.
