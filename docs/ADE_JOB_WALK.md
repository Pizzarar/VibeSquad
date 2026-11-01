# ADE job walk: acceptance test

A repeatable, read-only walk through 41 everyday dev tasks in the live VibeSquad UI. It is the acceptance test for every ADE batch. Re-run it after each batch, record the score, and update the "Result" column.

**Baseline (2026-11-01, v0.1.1, 1600×1000):** **21 / 41** completable in-app. Only 3 are clean; 20 are impossible.
Source audit: `docs/audits/basics-gap-2026-11.md` (local, gitignored). The gap IDs below (B1–B7 and section names) refer to it.

## How to re-run

1. Make sure the app is up: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4180/` should return `200`.
2. Use the Playwright MCP tools (`mcp__playwright__browser_*`; load them via ToolSearch). Navigate to `http://127.0.0.1:4180/` and resize to **1600×1000** unless the task says otherwise.
3. **Safety: Aub's real team is live.** Never send prompts, spawn, stop, archive, rename, approve or deny, hand off, or save team settings. Open menus and modals, then close them with ✕, Cancel or Escape. If a task needs a mutation to finish, verify the control exists and is wired (grep `src/`), then stop. Score that as **control-present**, which counts as passing. If the batch under test adds a mutating feature, test it on a throwaway agent you spawn yourself in a scratch lane, then archive that agent.
4. For each task: follow the steps, take a screenshot to `scratch/shots/job-walk/<date>/NN-<slug>.png`, and record one of these results:
   - **clean**: the PASS criterion is met with no friction.
   - **painful**: it can be done in-app, but it's awkward, hidden or buggy.
   - **control-present**: the control exists, but the action is a mutation that wasn't executed.
   - **impossible**: you must leave VibeSquad (Paseo app, terminal, editor) or it can't be done at all.
5. If the UI looks like a feature is missing, grep `src/` before marking it impossible. A feature that exists but can't be found is **painful**, with a note saying it can't be discovered.
6. **Score** = (clean + painful + control-present) / 41. Report it as `N/41 (clean C, painful P, control-present K, impossible I)` with a diff against the previous run.
7. Update this file's Result column and the run log at the bottom, and commit.

## Tasks

| # | Task | Steps | PASS criterion | Result 2026-11-01 | Maps to gap |
|---|---|---|---|---|---|
| 1 | Open the app in the morning | Load `/`; dismiss any first-run modal with ✕; reload | Lands on the team view; the Setup Checklist does not come back after ✕ + reload | painful | B6 |
| 2 | Find yesterday's agent | From any team, find an agent last active yesterday in a *different* team, including archived ones | Found in under 30s through search, sort or group by date, across teams | painful | ANNOYS · Navigation |
| 3 | Search all transcripts for a phrase | Copy a phrase visible in some agent's reply; search for it from the main UI | The agent and the matching message are found, across teams; a non-match shows "no results" | impossible | BLOCKS · Search transcripts |
| 4 | Read an agent's transcript | Open a tool-heavy agent (e.g. a Gemini lead); scroll its timeline | Every timeline row, including tool calls and failed tool calls, is visible (height > 0) | impossible | B2 |
| 5 | Scroll back through older history | Open a long-running agent; scroll to the top of the timeline | Can load entries older than the newest 60 ("load older" or infinite scroll) | impossible | BLOCKS · Full history |
| 6 | See which files an agent changed | Open an agent that edited files | A list of changed files for that agent or workspace is visible | impossible | BLOCKS · Diff / changes view |
| 7 | View the diff | From task 6, open one changed file's diff | A per-file unified or split diff renders | impossible | BLOCKS · Diff / changes view |
| 8 | Open a changed file | Click a file path in a transcript, feed or changes list | The file contents open in a viewer, or in an editor via "open in editor" | impossible | BLOCKS · File browser |
| 9 | Git branch/status for a project | Open Workspaces; click a workspace row | Shows branch, dirty files list, ahead/behind; the row opens detail; the layout doesn't break | painful | BLOCKS · Git actions |
| 10 | Copy an agent's last message | Hover or right-click the last assistant message | A copy action puts the full message text on the clipboard | impossible | ANNOYS · Reading output |
| 11 | Copy a code block | Find an assistant message with a code fence | Markdown renders (bold, code blocks); a code block has a copy button | impossible | ANNOYS · Reading output |
| 12 | See context usage | Open an agent; compare the sidebar card with the drawer meter | Token meter visible; sidebar and drawer agree | painful | B7 |
| 13 | See cost | Look for $ spent per agent or session | Cost per agent is shown (from `totalCostUsd`) | impossible | POLISH · Cost |
| 14 | Switch model or effort for an agent | Open a running agent's drawer header | A model/effort picker exists and is wired to `setAgentModel`/`setAgentThinkingOption` (control-present) | impossible | ANNOYS · Agent control |
| 15 | Spawn a new agent | Open New Agent; check its defaults; Cancel | Fields are empty or sensibly defaulted (no "VS-STEP4"); cwd can be any folder | control-present* | B4, BLOCKS · Add a project |
| 16 | Queue or interrupt a message | Inspect the send path on a running agent (grep `activeTurnBehavior`) | Mid-turn send steers or queues by default, with an explicit "interrupt & send"; the UI shows a queued/steered state | painful | B1 |
| 17 | Rewind/undo an agent turn | Look on a past message for rewind/checkpoint | A rewind control exists (conversation / files / both), wired to `rewindAgent` | impossible | ANNOYS · Agent control |
| 18 | Command palette | Press Ctrl+K and Ctrl+Shift+P | A palette opens and can jump to an agent, team or action | impossible | ANNOYS · Navigation |
| 19 | Keyboard shortcut list | Press `?`; look for a shortcuts entry | A cheat sheet lists all shortcuts | impossible | ANNOYS · Navigation |
| 20 | Check app version / update | Open About | Version + channel shown, plus a "Check for updates" action | painful | [settings] |
| 21 | Logs/diagnostics when an agent errors | Find an errored or failed agent; look for logs or diagnostics | Can see the error detail and open logs or a diagnostics bundle in-app | impossible | ANNOYS · Diagnostics |
| 22 | Empty state, nothing selected | Close all panes or tabs | Useful empty state; agent cards visible without scrolling past chrome | clean | POLISH · Layout |
| 23 | Small window | Resize to 900×700; open an agent | Transcript and composer are both visible and usable; nothing overlaps | painful | ANNOYS · Other |
| 24 | 4K window | Resize to 3840×2160 at 100% | Text is readable without manual scaling; the drawer uses the width sensibly | painful | POLISH · Layout |
| 25 | Zoom in/out | Ctrl+=, Ctrl+-, Ctrl+0; check Workspaces at 120% | Zoom works with feedback; no overlapping or clipped layout at 120% | painful (zoom works, but layout overlaps at 120%) | POLISH · Layout |
| 26 | Right-click an agent or message | Right-click a roster card and a message | A context menu with relevant actions (copy id, open folder, archive…) | impossible | POLISH |
| 27 | Drag a file into the composer | Drag a .md/.log file onto the composer (inspect the drop handler if you can't drag) | Non-image files are accepted or clearly rejected with a message, not silently ignored | painful | ANNOYS · Composer |
| 28 | Mention a file with @ | Type `@` and `/` in the composer | File autocomplete on `@`; command autocomplete on `/` | impossible | ANNOYS · Composer |
| 29 | See running terminals / project scripts | Look for a terminal or scripts panel for a workspace | Can list, start or stop scripts and view a terminal (control-present) | impossible | BLOCKS · Terminal, Scripts |
| 30 | View an agent's plan/task list | Open an agent that used todos | Its current plan/task list is pinned and visible regardless of scroll | painful | ANNOYS · Reading output |
| 31 | Get notified when an agent needs input | Check the alerts toggle, test push and the Needs You rail (Ctrl+J) | Notifications can be enabled; Needs You queue reachable | control-present | — (covered) |
| 32 | Answer a permission request | Inspect a pending permission card (or a question/plan request) | Shows the command, args or diff; supports allow-always, deny-with-message, and question options | control-present* | B3, ANNOYS · Permissions |
| 33 | Navigate back/forward | Open agent A, then B; press browser Back | Back returns to agent A inside the app; the URL reflects the current view | impossible | ANNOYS · Navigation |
| 34 | Reopen a closed pane | Close a tab; try to reopen it | "Reopen closed tab" (shortcut or menu) restores it | painful | POLISH |
| 35 | Export a transcript | Look for export on an agent | Export as markdown/JSON | impossible | POLISH |
| 36 | Find help/docs | Look for Help, docs or a tour | An in-app help entry or docs link exists | impossible | ANNOYS · Diagnostics |
| 37 | Recover when the daemon is down | Read the code path for disconnected state (`src/App.tsx`); do NOT stop the daemon | A visible banner (also in Focus mode) with a retry/restart action; stale data marked | painful | ANNOYS · Diagnostics |
| 38 | Work in Focus mode | Ctrl+. at 1600 wide | The chat uses the available width; no large blank area | painful | POLISH · Layout |
| 39 | Reach the composer with the LAN banner showing | With "EXPOSED ON…" visible at 1600×1000, open an agent | The composer and Send button are fully on-screen | painful | B5 |
| 40 | Find app settings | Look for global settings from any view | A clearly labelled Settings entry, visible without scrolling | painful | [settings] |
| 41 | Read the drawer header | Open a brainstorm agent's drawer | No overlap between labels, buttons and timeline; the header takes ≤ ~25% of the drawer height | painful | POLISH · Drawer header |

\* For tasks 15 and 32 the control exists, so they score as passing, but they still fail their full PASS criterion (B4, B3). Re-mark them **clean** only when the criterion is fully met.

**Baseline tally:** clean 1 (22) · painful 17 · control-present 3 (15, 31, 32) · impossible 20 → 21/41.
The original run counted tasks 12, 22 and 25 as clean. Under the stricter criteria here, 12 and 25 are painful (meter mismatch, layout overlap at 120%), so the tally reads 1 clean. The passing total of 21 is unchanged.

## Run log

| Date | Version / batch | Score | Clean / painful / control-present / impossible | Notes |
|---|---|---|---|---|
| 2026-11-01 | v0.1.1, baseline | 21/41 | 1 / 17 / 3 / 20 | Audit run; screenshots in `scratch/shots/gap-audit/` |
