# ADE job walk: acceptance test

A repeatable, read-only walk through 64+ everyday dev tasks (41 job tasks + v2 "feels like an app" basics from row 42) in the live VibeSquad UI. It is the acceptance test for every ADE batch. Re-run it after each batch, record the score, and update the "Result" column.

**Baseline (2026-11-01, v0.1.1, 1600×1000):** **21 / 41** completable in-app. Only 3 are clean; 20 are impossible.
Source audit: `docs/audits/basics-gap-2026-11.md` (local, gitignored). The gap IDs below (B1–B7 and section names) refer to it.

## How to re-run

1. Make sure the app is up: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4180/` should return `200`.
2. Use the Playwright MCP tools (`mcp__playwright__browser_*`; load them via ToolSearch). Navigate to `http://127.0.0.1:4180/` and resize to **1600×1000** unless the task says otherwise.
3. **Safety: the owner's real team is live.** Never send prompts, spawn, stop, archive, rename, approve or deny, hand off, or save team settings. Open menus and modals, then close them with ✕, Cancel or Escape. If a task needs a mutation to finish, verify the control exists and is wired (grep `src/`), then stop. Score that as **control-present**, which counts as passing. If the batch under test adds a mutating feature, test it on a throwaway agent you spawn yourself in a scratch lane, then archive that agent.
4. For each task: follow the steps, take a screenshot to `scratch/shots/job-walk/<date>/NN-<slug>.png`, and record one of these results:
   - **clean**: the PASS criterion is met with no friction.
   - **painful**: it can be done in-app, but it's awkward, hidden or buggy.
   - **control-present**: the control exists, but the action is a mutation that wasn't executed.
   - **impossible**: you must leave VibeSquad (Paseo app, terminal, editor) or it can't be done at all.
5. If the UI looks like a feature is missing, grep `src/` before marking it impossible. A feature that exists but can't be found is **painful**, with a note saying it can't be discovered.
6. **Score** = (clean + painful + control-present) / total rows (41 before v2; 64+ from v2). Report it as `N/M (clean C, painful P, control-present K, impossible I)` with a diff against the previous run.
7. Update this file's Result column and the run log at the bottom, and commit.

## Tasks

| # | Task | Steps | PASS criterion | Result 2026-11-01 | Maps to gap |
|---|---|---|---|---|---|
| 1 | Open the app in the morning | Load `/`; dismiss any first-run modal with ✕; reload | Lands on the team view; the Setup Checklist does not come back after ✕ + reload | clean | B6 |
| 2 | Find yesterday's agent | From any team, find an agent last active yesterday in a *different* team, including archived ones | Found in under 30s through search, sort or group by date, across teams | clean | ANNOYS · Navigation |
| 3 | Search all transcripts for a phrase | Copy a phrase visible in some agent's reply; search for it from the main UI | The agent and the matching message are found, across teams; a non-match shows "no results" | clean | BLOCKS · Search transcripts |
| 4 | Read an agent's transcript | Open a tool-heavy agent (e.g. a Gemini lead); scroll its timeline | Every timeline row, including tool calls and failed tool calls, is visible (height > 0) | clean | B2 |
| 5 | Scroll back through older history | Open a long-running agent; scroll to the top of the timeline | Can load entries older than the newest 60 ("load older" or infinite scroll) | clean | BLOCKS · Full history |
| 6 | See which files an agent changed | Open an agent that edited files | A list of changed files for that agent or workspace is visible | clean | BLOCKS · Diff / changes view |
| 7 | View the diff | From task 6, open one changed file's diff | A per-file unified or split diff renders | clean | BLOCKS · Diff / changes view |
| 8 | Open a changed file | Click a file path in a transcript, feed or changes list | The file contents open in a viewer, or in an editor via "open in editor" | clean | BLOCKS · File browser |
| 9 | Git branch/status for a project | Open Workspaces; click a workspace row | Shows branch, dirty files list, ahead/behind; the row opens detail; the layout doesn't break | clean | BLOCKS · Git actions |
| 10 | Copy an agent's last message | Hover or right-click the last assistant message | A copy action puts the full message text on the clipboard | clean | ANNOYS · Reading output |
| 11 | Copy a code block | Find an assistant message with a code fence | Markdown renders (bold, code blocks); a code block has a copy button | clean | ANNOYS · Reading output |
| 12 | See context usage | Open an agent; compare the sidebar card with the drawer meter | Token meter visible; sidebar and drawer agree | clean | B7 |
| 13 | See cost | Look for $ spent per agent or session | Cost per agent is shown (from `totalCostUsd`) | control-present | POLISH · Cost |
| 14 | Switch model or effort for an agent | Open a running agent's drawer header | A model/effort picker exists and is wired to `setAgentModel`/`setAgentThinkingOption` (control-present) | control-present | ANNOYS · Agent control |
| 15 | Spawn a new agent | Open New Agent; check its defaults; Cancel | Fields are empty or sensibly defaulted (no "VS-STEP4"); cwd can be any folder | clean | B4, BLOCKS · Add a project |
| 16 | Queue or interrupt a message | Inspect the send path on a running agent (grep `activeTurnBehavior`) | Mid-turn send steers or queues by default, with an explicit "interrupt & send"; the UI shows a queued/steered state | clean | B1 |
| 17 | Rewind/undo an agent turn | Look on a past message for rewind/checkpoint | A rewind control exists (conversation / files / both), wired to `rewindAgent` | control-present | ANNOYS · Agent control |
| 18 | Command palette | Press Ctrl+K and Ctrl+Shift+P | A palette opens and can jump to an agent, team or action | clean | ANNOYS · Navigation |
| 19 | Keyboard shortcut list | Press `?`; look for a shortcuts entry | A cheat sheet lists all shortcuts | clean | ANNOYS · Navigation |
| 20 | Check app version / update | Open About | Version + channel shown, plus a "Check for updates" action | clean | [settings] |
| 21 | Logs/diagnostics when an agent errors | Find an errored or failed agent; look for logs or diagnostics | Can see the error detail and open logs or a diagnostics bundle in-app | clean | ANNOYS · Diagnostics |
| 22 | Empty state, nothing selected | Close all panes or tabs | Useful empty state; agent cards visible without scrolling past chrome | clean | POLISH · Layout |
| 23 | Small window | Resize to 900×700; open an agent | Transcript and composer are both visible and usable; nothing overlaps | clean | ANNOYS · Other |
| 24 | 4K window | Resize to 3840×2160 at 100% | Text is readable without manual scaling; the drawer uses the width sensibly | clean | POLISH · Layout |
| 25 | Zoom in/out | Ctrl+=, Ctrl+-, Ctrl+0; check Workspaces at 120% | Zoom works with feedback; no overlapping or clipped layout at 120% | clean | POLISH · Layout |
| 26 | Right-click an agent or message | Right-click a roster card and a message | A context menu with relevant actions (copy id, open folder, archive…) | clean | POLISH |
| 27 | Drag a file into the composer | Drag a .md/.log file onto the composer (inspect the drop handler if you can't drag) | Non-image files are accepted or clearly rejected with a message, not silently ignored | clean | ANNOYS · Composer |
| 28 | Mention a file with @ | Type `@` and `/` in the composer | File autocomplete on `@`; command autocomplete on `/` | clean | ANNOYS · Composer |
| 29 | See running terminals / project scripts | Look for a terminal or scripts panel for a workspace | Can list, start or stop scripts and view a terminal (control-present) | control-present | BLOCKS · Terminal, Scripts |
| 30 | View an agent's plan/task list | Open an agent that used todos | Its current plan/task list is pinned and visible regardless of scroll | clean | ANNOYS · Reading output |
| 31 | Get notified when an agent needs input | Check the alerts toggle, test push and the Needs You rail (Ctrl+J) | Notifications can be enabled; Needs You queue reachable | control-present | — (covered) |
| 32 | Answer a permission request | Inspect a pending permission card (or a question/plan request) | Shows the command, args or diff; supports allow-always, deny-with-message, and question options | clean | B3, ANNOYS · Permissions |
| 33 | Navigate back/forward | Open agent A, then B; press browser Back | Back returns to agent A inside the app; the URL reflects the current view | clean | ANNOYS · Navigation |
| 34 | Reopen a closed pane | Close a tab; try to reopen it | "Reopen closed tab" (shortcut or menu) restores it | clean | POLISH |
| 35 | Export a transcript | Look for export on an agent | Export as markdown/JSON | clean | POLISH |
| 36 | Find help/docs | Look for Help, docs or a tour | An in-app help entry or docs link exists | clean | ANNOYS · Diagnostics |
| 37 | Recover when the daemon is down | Read the code path for disconnected state (`src/App.tsx`); do NOT stop the daemon | A visible banner (also in Focus mode) with a retry/restart action; stale data marked | control-present | ANNOYS · Diagnostics |
| 38 | Work in Focus mode | Ctrl+. at 1600 wide | The chat uses the available width; no large blank area | clean | POLISH · Layout |
| 39 | Reach the composer with the LAN banner showing | With "EXPOSED ON…" visible at 1600×1000, open an agent | The composer and Send button are fully on-screen | clean | B5 |
| 40 | Find app settings | Look for global settings from any view | A clearly labelled Settings entry, visible without scrolling | clean | [settings] |
| 41 | Read the drawer header | Open a brainstorm agent's drawer | No overlap between labels, buttons and timeline; the header takes ≤ ~25% of the drawer height | clean | POLISH · Drawer header |
| 42 | Close and reopen the app | Pick a team, agent, split panes; close the tab; open `/` fresh | Back on the last team, agent, panes and split | — | v2 · State |
| 43 | Reload mid-draft | Type a draft and paste an image in a composer (throwaway agent); reload | Draft text and images survive the reload | — | v2 · State |
| 44 | Open any file type | From a chat link or Files, open a `.md`, a `.ts`, a `.png` and a binary (e.g. `.exe`/`.zip`) | `.md` rendered, code highlighted, image shown, binary handled with a message (no garbage, no blank) | — | v2 · Files |
| 45 | Open a bad path | Open a path outside the repo and a missing file (chat link or Files) | A clear message; no blank pane, no crash | — | v2 · Files |
| 46 | Close the window while agents work | Throwaway agent mid-turn; close the tab; reopen | The agent kept running and the progress shows; a visible "keeps running in background" setting or explanation exists (score what exists; tray is PLAN_DESKTOP_APP) | — | v2 · Background |
| 47 | Settings behave | Open Settings; check every control | Every setting is labelled, saves, survives reload, and can be reset to default | — | v2 · Settings |
| 48 | Add folder context | In a composer, try `@folder/` or attach a folder | A folder can be referenced or attached and is sent to the agent | — | v2 · Context |
| 49 | Project context | Look for the repo's CLAUDE.md / AGENTS.md in-app | Can see and edit them from the app, and it's clear they apply to agents in that repo | — | v2 · Context |
| 50 | Empty states | View a team with no agents / no teams (filter or scratch team) | Guidance and a next action, not a blank screen | — | v2 · Empty/Error |
| 51 | Error states | Fail a send or a spawn on a throwaway (e.g. bad cwd) | A readable error plus a retry | — | v2 · Empty/Error |
| 52 | Destructive actions confirm | Archive, close tab, stop (throwaway agent) | Each has a confirm or an undo | — | v2 · Safety |
| 53 | Keyboard-only | Switch agent, send (throwaway), open palette, close a modal, mouse unused | All doable from the keyboard with visible focus | — | v2 · Keyboard |
| 54 | Esc and focus | Open a modal on top of another (e.g. palette over drawer, confirm over settings); press Esc | Esc closes only the topmost layer; focus returns to the opener | — | v2 · Keyboard |
| 55 | Common window sizes | Resize to 1280×720 and 2560×1440 | No clipping, overflow or overlap | — | v2 · Layout |
| 56 | Select and copy transcript text | Drag-select across a message; right-click on the selection | Selection works and copies; right-click doesn't drop the selection or block native copy | — | v2 · Reading |
| 57 | Unread / needs-you in the tab | Look at the document title and favicon while something needs you | A count or marker in the title or favicon | — | v2 · Attention |
| 58 | Loading feedback | Trigger slow actions (open agent, load older, search, open diff) | Anything over ~300ms shows a spinner/skeleton; the UI never looks frozen | — | v2 · Feedback |
| 59 | Long content | View a very long message, wide code block and long path | Wraps or scrolls in place; the layout doesn't break | — | v2 · Layout |
| 60 | Zoom extremes | Ctrl+= to 150%, Ctrl+- to 80% | Layout stays readable and usable | — | v2 · Layout |
| 61 | About + update | Open About | Version shown and an update check that gives a result (up to date / available / error) | — | v2 · Settings |
| 62 | Rename inline | Rename a throwaway agent and a scratch team | Inline rename (or obvious rename action) that saves | — | v2 · Agent control |
| 63 | Find in transcript | Ctrl+F or a find box in the open transcript | Finds and highlights matches inside the open agent (incl. older loaded history) | — | v2 · Reading |
| 64 | Timestamps | Look at message and card times | Relative times ("5m ago"), hover shows the full date/time | — | v2 · Reading |

\* For tasks 15 and 32 the control exists, so they score as passing, but they still fail their full PASS criterion (B4, B3). Re-mark them **clean** only when the criterion is fully met.

**Baseline tally:** clean 1 (22) · painful 17 · control-present 3 (15, 31, 32) · impossible 20 → 21/41.
The original run counted tasks 12, 22 and 25 as clean. Under the stricter criteria here, 12 and 25 are painful (meter mismatch, layout overlap at 120%), so the tally reads 1 clean. The passing total of 21 is unchanged.

## Run log

| Date | Version / batch | Score | Clean / painful / control-present / impossible | Notes |
|---|---|---|---|---|
| 2026-11-01 | v0.1.1, baseline | 21/41 | 1 / 17 / 3 / 20 | Audit run; screenshots in `scratch/shots/gap-audit/` |
| 2026-11-01 | B0 (B1–B7) + Paseo settings | 22/41 | 7 / 12 / 3 / 19 | B1 steer/interrupt, B2 timeline flex-shrink:0 (0 collapsed rows), B3 question/plan permission actions, B4 empty modal defaults, B5 banner grid row height (Send visible at 1600×1000), B6 FirstRunModal ✕ persistence, B7 unified `usedTokens()`, Paseo 8-tab settings |
| 2026-11-01 | ADE Wave 1 (Batches A–E + Step S) | 31/41 | 18 / 9 / 4 / 10 | RightDock (Changes/Files/Terminal/Scripts), PermissionCard cmd/diff/suggestions/deny-msg, DrawerHeader mode/model/thinking/cost/reload/copy + compact 2-line chrome (19.9% height), Timeline expandable tool calls + Markdown + copy msg/code + load older + pinned todo + file links, NewAgentModal add-project/clone/worktree picker |
| 2026-11-01 | ADE Wave 2 (Batches F–I) | 41/41 | 35 / 0 / 6 / 0 | Composer slash/@ autocomplete + any-file attach + prompt history, Command Palette (Ctrl+K) + `?` shortcuts + URL routing (`popstate` Back/Forward) + cross-team transcript search + date group filter + right-click context menus, Rewind + Fork + Export (.md/.json) + Schedules/Import CLI + Reopen closed tab, DaemonStatusBanner + Diagnostics/Help modals + 900×700 / 120% zoom / Focus mode full width |
