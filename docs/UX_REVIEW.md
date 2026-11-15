# VibeSquad UX review: Normal mode

Date: 2026-11-15 · Scope: **Normal mode** (`app.vibe = "boring"`, `src/BoringAde.tsx` + `src/boring.css`). Psycho mode is the owner's art playground and is only cited where it already solves something Normal lacks.
Priorities: flow and information architecture first, visuals second.

## 0. Method and caveats

- `docs/VIBESQUAD_BRIEF.md` does not exist on any branch. I used `README.md`, `docs/NAMING.md`, `docs/WORKFLOWS.md`, `docs/ADE_JOB_WALK.md` and `docs/design/FOCUS_CHAT.md` instead.
- The UI ran under `vite` with `?demo` (a fixed cast, no daemon). The viewport was **3200×1800 CSS px**, which is a 4K screen at 120% zoom. I checked both themes and used dark as the default.
- The orange "Read-only: no local token" strip at the top of every screenshot comes from the demo harness. It isn't a finding.
- Evidence screenshots, downscaled to 1600×900, are in `docs/shots/ux-review/`:

| # | File | State |
|---|---|---|
| 01 | `01-normal-light-home.png` | Light theme, first load |
| 02 | `02-overview-cards.png` | Project Overview, Cards |
| 03 | `03-overview-map.png` | Project Overview, Map |
| 04 | `04-lane-empty.png` | Lane selected, no Brainstorm running |
| 05 | `05-lead-chat-header.png` | Lead chat: header, stall banner, timeline |
| 06 | `06-permission-ctrlj.png` | Worker with a pending permission, reached by Ctrl+J |
| 07 | `07-tool-calls-expanded.png` | Tool-call group and a sub-agent expanded |
| 08 | `08-usage.png` | Usage & Workflows |
| 09 | `09-psycho-focus-rail-reference.png` | Psycho Focus rail (reference only) |

---

## 1. Model of the app

### 1.1 Entities

```
Project (UI "Project" in Normal · "Squad" in docs · `team` in teams.json)
 ├─ Project-level agents ("TRINITY · COMMAND" in Normal)
 │    ├─ Overlord  = lead of the hub lane
 │    ├─ RiffBot   = brainstorm of the hub lane
 │    └─ Bugs      = the standing @bug lane (its Brainstorm/Lead)
 └─ Lane (UI "Lane" in the sidebar, "Conversation" in the button/breadcrumb, "Team" in docs, `lane` in labels)
      ├─ Brainstorm ("Buddy"): the one you talk to; plans, parks ideas
      ├─ Lead (★, ord N): spawned at plan handoff; dispatches workers; hands off to a successor near budget
      │    └─ Workers: one task each; report back to the Lead as digests; can have sub-workers
      ├─ Topic brainstorms, former leads/brainstorms (history)
      └─ Brief, spec, tasks, worktrees
Agent (Paseo agent): provider · model · status · labels · context used · cost · pendingPermissions · attention
 └─ Timeline: user msg · assistant msg · tool-call groups · sub-agents · todo/plan · notes · permission cards
Project-wide: Idea Inbox cards · Standup Feed (vs log: you/done/decision/blocker/needs-you/handoff/metric) · Usage
```

The data model is sound. `attentionItems()` (`src/attentionItems.ts:47`) already sorts every alert in the order permission › needs-you › unread › error › finished. Psycho's Focus rail uses `railAlerts()` (`src/FocusRail.tsx:34`) for the same thing. **Normal uses neither.**

### 1.2 Screens (Normal) and how you move between them

```
┌ Sidebar (380px) ───────────────┐  ┌ Topbar: breadcrumb · [Brainstorm|★Lead·state|Check in] · 🔍 ? Details ┐
│ + New Conversation             │  │                                                                        │
│ ▾ Project A  (badge)           │  │ main = one of:                                                         │
│ ▸ Project B  (badge)  ← click = switch project (accordion, one open)                                    │
│ Project Overview → mode=project│  │   chat     : one AgentDrawer, centred column (max 1360px)              │
│ + New Project                  │  │   project  : tabs Overview[Cards|Map] · Idea Inbox · Standup Feed      │
│ TRINITY · COMMAND              │  │   usage    : UsageDashboard                                            │
│   ★ Overlord / RiffBot / Bugs  │  │   empty    : "X is sleeping" + Start CTA                                │
│ LANES                          │  │                                                                        │
│   Lane row → opens Brainstorm  │  │                                                                        │
│     [Brainstorm][Lead] (active)│  │                                                                        │
│ 📊 Usage · ⚙ Settings · ✦ Psycho│  └────────────────────────────────────────────────────────────────────────┘
```

Overlays: Ctrl+K palette, transcript search, `?` shortcuts, Settings, New Project, Add Buddy (behind "+ New Conversation"), Diagnostics.
**Hidden paths:** Ctrl+J opens the top needs-you agent, and `?agent=<id>` deep-links. Neither is shown anywhere in Normal.
**Missing from Normal** (it exists in Psycho): any list of workers, a cross-project NEEDS YOU queue, tabs, split panes, and the team feed next to the chat.

### 1.3 Main user jobs

1. **Start work on a feature:** new lane → talk to its Brainstorm → plan → hand off to a Lead.
2. **Monitor parallel work** across lanes and projects: who's running, stuck, or done.
3. **Respond when something needs me:** a permission, a question or pick, an error, a stall.
4. **Review output:** diffs, changed files, worker digests, reviewer verdicts.
5. **Intervene:** message, interrupt, stop, hand off, switch provider or model.

### 1.4 Agent states and where Normal shows them today

| State | Source | Sidebar | Overview | Chat |
|---|---|---|---|---|
| Running | `status=running` | teal dot | teal dot / pulse node | dot in header |
| Idle | `status=idle` | grey dot | grey dot | — |
| **Waiting on permission** | `pendingPermissions`, `attention.tone=permission` | amber count only, and only if the agent is a pinned lane's member | count only | pink card at the top of the timeline |
| **Needs you (pick/question)** | `needs-you` label | amber count | count | — (only in the label) |
| **Error** | `status=error`, `lastError` | **grey dot, same as idle** (`.boring-dot` only styles `.running`) | — | error text in the timeline |
| **Stalled** | long-running tool | — | — | pink "Tool running for 1260s" bar (05) |
| Context high / over budget | usage vs budget | — | — | thin bar in header |
| Finished, unread | `attention.tone=finished` | — | — | "Mark read" chip |
| Closed / archived | `status=closed` | hidden | "none" | — |

The four states that call for action (permission, needs-you, error, stalled) look alike or don't show at all, and the overview doesn't tell you what each one is.

---

## 2. Critique

Severity: **critical** = blocks or misleads a core job; **major** = large, repeated friction; **minor** = polish.

### 2.1 Structural

#### S1 · Critical: Normal has no attention surface, and its badge points to nothing
- **Evidence:** 02. VibeSquad shows a needs-you badge of **3**, but Project Overview says "Nothing needs you right now." None of the sidebar rows (Trinity, Lanes) carries a badge.
- **Cause:** `boringSidebarModel` (`src/BoringAde.tsx`) builds Overlord/RiffBot rows from those two members' attention only, and drops the hub pin from `conversations` (`!isHubPin`). Workers in the hub lane (`pins.ts:188` `needsYou: inHub…`) are counted in the project badge but appear in no row, no card and no map node. Feature-lane workers are only counted, and never named.
- **Why it matters:** job 3 is the reason a supervisor UI exists. A badge with nowhere to go teaches users to ignore badges.
- **Fix:** add an **Inbox** section at the top of the Normal sidebar, built from `attentionItems()` over **all** projects. Each row shows who, why (for example "Bash: rg --stats"), the project and lane, how long it has waited, and inline Allow/Deny when `quickPermission` is set. Every badge in the app should open this list, filtered. Fixing the hub-lane count bug alone is a 1-line change and should ship first (plan step 2.1).

#### S2 · Critical: workers are invisible in Normal
- **Evidence:** 03. The Map shows running workers only, and only for feature lanes. In 05 the only way to reach a worker is through the Lead header's truncated chips ("Implement - dr…", "Imple…"). 06 was only reachable by Ctrl+J.
- **Why it matters:** in job 3, the agent asking for permission is usually a worker. In job 4, worker output is what you review. Hiding workers "because the Lead runs them" works until one gets stuck, which happens constantly.
- **Fix:** a lane row in the sidebar expands to show **live workers only**, one line each: state glyph, short title, reason when there's an alert. Idle and closed workers collapse to "▸ 3 idle". This is FOCUS_CHAT.md's rail rule ("an alert row earns a pixel"), without the art.

#### S3 · Major: one concept has three names, and the hierarchy is presented inconsistently
- **Evidence:** "+ New Conversation" creates a lane (via `onAddBuddy`). The sidebar heading says "LANES". The breadcrumb and empty state say "Conversation". The docs say "Team". A project is "Project" here and "Squad" everywhere else. "TRINITY · COMMAND", "RiffBot", "Overlord" and "Check in" are unexplained.
- **Why it matters:** with no fixed names there's no mental model. A new user can't predict what "+ New Conversation" will spawn, or whether to talk to RiffBot, Overlord or a lane Brainstorm (ADE walk row 67 is still "painful").
- **Hierarchy verdict:** keep **Project → Lane** as the navigation tree, because it is the data model and matches how features are planned. **Do not** make agents a third navigation level. Agents show up as **state inside a lane** (Brainstorm / Lead / live workers), and alerts go to a flat cross-project Inbox. The project-level agents (Overlord, RiffBot, Bugs) are the project's own lane, so render them as the first lane under the project ("Project desk"), not as a separately branded group.
- **Fix:** pick one name per concept and use it everywhere in Normal: **Project · Lane · Brainstorm · Lead · Worker**. Rename "+ New Conversation" to "+ New lane". Rename "TRINITY · COMMAND" to the project's own lane, with RiffBot as "Project Brainstorm" and Overlord as "Project Lead". Personas can still appear as small subtitles.

#### S4 · Major: you land on an empty state, not on what matters
- **Evidence:** 01 and 04. On load the main area shows "RiffBot is sleeping. [Start RiffBot]" in a 2800px-wide field. Selecting a lane opens its Brainstorm even when the lane's badge comes from a worker.
- **Fix:** the default view is **Inbox if it's non-empty, otherwise Project Overview**. A lane click opens the lane on its **most urgent member**, otherwise its last-viewed member. Empty states stay, but as a fallback.

#### S5 · Major: one centred chat wastes ~45% of a 4K screen and can't show supervision context
- **Evidence:** 05 and 06. The column is 1120px wide in a 2820px main area, and the ~850px gutters on each side are empty. Meanwhile workers, changes, plan and feed are each a click away, or don't exist in Normal.
- **Is one chat pane per agent the right core view?** For *talking*, yes: the Brainstorm conversation is the primary interaction. For *supervising*, no: the chat should be the detail view inside a layout whose spine is attention and lane state. See §3.
- **Fix:** a three-column layout. Inbox and tree on the left, the conversation in the centre at a readable measure, and a **lane context panel** on the right (live workers, changes/diffs, plan, recent feed).

#### S6 · Major: the agent header is a control dump (~30% of the column before the first message)
- **Evidence:** 05. The rows hold, in order: provider select, model select, cwd, copy, age, subs, id chip, mode select, effort select, "7 working", worker chips (truncated), Sandbox, context bar. Then Switch to Claude, Search, Reload, Mark unread, Stop, Dock, ✕. Then the Lead handoff bar, the stall banner, More, Fork, Export and Plan/Tasks.
- **Why it matters:** the controls you use rarely (provider, model, effort) come first and are the biggest. The ones you need under pressure (Stop, Interrupt, Approve) share their weight, and Stop sits next to Mark unread. Teal "Mark read" in 06 looks like the primary action.
- **Cause:** Normal reuses Psycho's `DrawerHeader.tsx` (1593 lines, 37 inline style objects) and hides parts of it with CSS. It can't re-prioritise.
- **Fix:** a Normal-specific header with **one line**: state glyph · name · role/lane · context meter (as text when ≥72%) · [Interrupt] [Stop] · ⋯ (everything else). Banners (stall, handoff due) become one **status strip** below it, which only appears when it has something to say.

#### S7 · Major: tool calls, diffs and errors give no signal when collapsed
- **Evidence:** 07. "▸ 5 tool calls · Grep, PowerShell, Edit…" is a 14px muted row. Expanded rows show the verb and target but no outcome, duration or diff stats. "Bash vs who lead" expands to the command only. Timestamps are ~10px.
- **Why it matters:** in job 4 you scan for "what changed and did anything fail". The collapsed group hides both, and each edit takes a click to see.
- **Fix:** the collapsed group summary should show outcomes: `▸ 5 tools · 2 edits (+41 −7) · 1 failed · 18s`. Each row gets a glyph by kind, a mono target, a ✓/✕/spinner and a duration. A failed call **auto-expands**. An edit row shows `+12 −3 src/pixel.tsx` and expands to the existing `DiffView` (capped at 400px, with "Open in Changes"). Output folds at 12 lines.

#### S8 · Major: selection state and breadcrumb drift away from what's on screen
- **Evidence:** 06. Ctrl+J opened a VibeSquad worker, but the breadcrumb says "Main Game Project › Conversation" and no sidebar row is selected. The same happens on `?agent=` deep links. `selectedLaneId` is local state that only sidebar clicks update.
- **Fix:** derive the selection from the active agent (agent → lane → project). The breadcrumb becomes `Project › Lane › Agent` and each part is clickable.

#### S9 · Minor: the overview is a status dump without status
- **Evidence:** 02 and 03. Cards print raw enums ("Brainstorm · none · ★ Lead · idle"). Five idle lanes hide behind "Show 5 idle lanes". The Map spends its space on bezier curves and dashed "none" nodes.
- **Fix:** use one dense **lane table**: Lane · Brainstorm · Lead · Workers (running / needs-you) · Last event (from the feed) · Age. Sort by urgency, then recency. Drop the Map from Normal, or keep it as Psycho flavour.

#### S10 · Minor: hidden power features
Ctrl+J, Ctrl+K and focus have no affordance in Normal. Show `Ctrl+J` on the Inbox header and `Ctrl+K` in the search pill. The topbar's 🔍 and `?` circles are unlabeled.

#### S11 · Structural (implementation): Normal is a skin fighting Psycho
`boring.css` holds **100 `!important`** overrides on top of `styles.css` (58 more there), and the TSX has **383 inline `style={{}}`** objects (`PairDeviceModal` 57, `DrawerHeader` 37, `Timeline` 27, `PermissionCard` 25). Every Psycho change can regress Normal, and a token system can't land cleanly. This isn't user-facing, but it caps how far the fixes above can go. Plan: give Normal its own header and row components, and move shared components onto tokens (§5, phase 3).

### 2.2 Cosmetic

| # | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| C1 | major | **Line length**: assistant text is 18px in a 1064px box, ~115 chars per line. | 05, measured | Message measure `max-width: 72ch` (~760px at 15px); the composer aligns to the same column. |
| C2 | major | **Type scale chaos**: boring.css uses 16 font-size values including 6 different `clamp(…vw…)`; styles.css has 30 values, with 9px ×27 and 10px ×54. Messages are 18px but the composer is 14px. Timestamps are ~10px. | `src/boring.css`, `src/styles.css` | 7-step fixed scale (§4.1). Remove vw clamps: they grow text with window width, fight the user's own zoom, and double-scale at 120%. |
| C3 | major | **Teal means everything**: running dot, primary CTA, selected outline, "Mark read", Queue, Allow. | 05, 06 | Split action colour (accent) from status colours (§4.6). |
| C4 | major | **Decoration louder than alerts**: the TRINITY card's pink gradient and the magenta corner gradient on the main canvas compete with the pink permission border and the amber badges. | 02, 05 | Flat surfaces. Gradient only as a 1px brand hairline and in empty states. |
| C5 | major | **Light theme is mauve on mauve**: `--panel #ebe0e8` on `--bg #e0d1dc` is ~1.1:1, so surfaces disappear and the gradient washes everything out. | 01 | Neutral light surfaces (§4.6). |
| C6 | minor | **Psycho vocabulary leaks**: "MAIL://BUG-AND-PERFECTION", "[ALL] 0" brackets, uppercase tracked labels, and emoji as icons (📊 ⚙ ✦ 💬 ★ ⚙ 🔍 📋). | 08, 03 | Plain labels, one 16px line-icon set, sentence case. |
| C7 | minor | **Permission card**: Deny is a filled pink pill with the same weight as Allow. The "Tell the agent what to do instead" field is ~110px and truncated. A redundant "1 permission request(s)" bar sits above it. | 06 | Allow (accent), Allow for session (secondary), Deny (secondary, danger text). A full-width reason field appears on Deny. Drop the count bar. |
| C8 | minor | **40px touch-sized rows** in the sidebar and topbar, inherited from mobile goals. At 4K / 120% they're fine but sparse, and the sidebar shows only one project's lanes anyway. | 02 | 32px desktop rows, 40px under the `coarse` pointer media query. |
| C9 | minor | **Role pills duplicated**: [Brainstorm][Lead] appear under the active lane row and again in the topbar. | 04 | Keep the topbar tabs only. The lane row expands to members (S2). |
| C10 | minor | **Status as raw strings**: "none", "idle", "running" in cards and map nodes. | 02, 03 | Glyph plus human wording ("not started", "idle 12m", "working"). |
| C11 | minor | **Empty card scale**: a 440px card centred in a 2800×1700 void. | 01, 04 | Put empty states in the centre column at the message measure, with a next action *and* a short explainer (S3). |

---

## 3. Layout directions (whole window)

### Direction A: Inbox + conversation + lane context *(attention-first)*

```
┌──────────────────────────┬──────────────────────────────────────────────┬──────────────────────────┐
│ ▣ VibeSquad      ⌕ Ctrl+K│ VibeSquad › UI Bois › Lead ★ord9   ● working │ LANE · UI Bois           │
│──────────────────────────│ [Brainstorm] [Lead] [Implement·overlap ●]  ⋯│──────────────────────────│
│ INBOX  3          Ctrl+J │──────────────────────────────────────────────│ Workers (2 live)         │
│ ! Audit·token scout  5m  │  ┌ status strip: Lead at 74% · Hand off ▸ ┐ │ ● Implement·overlap  4m  │
│   Bash: rg --stats       │                                              │ ! Audit·token scout      │
│   VibeSquad › hub        │  You                                         │   waiting · permission   │
│   [Allow] [Deny] [Open]  │  Run the neon-noir Painter + Director loop…  │ ▸ 3 idle                 │
│ ? Review·Sonnet      9m  │                                              │──────────────────────────│
│   pick option A or B     │  Lead ★ord9 · gemini-4                       │ Changes  (+41 −7, 3)     │
│ ✕ Review·Gemini      2m  │  Dispatching Art Painter and Art Director…   │  M src/pixel.tsx  +12 −3 │
│   EOF from provider      │  ▸ 5 tools · 2 edits +41 −7 · 1 failed · 18s │  M src/ui.tsx     +29 −4 │
│──────────────────────────│  ▾ ✕ Bash  vs who lead            1.2s       │  A docs/x.md      +0  −0 │
│ PROJECTS                 │     exit 1 · "no lead for lane"              │──────────────────────────│
│ ▾ VibeSquad          ●3  │                                              │ Plan  1/3                │
│   ◦ Project desk         │                                              │  ◐ Duet builds           │
│   ● UI Bois          2m  │                                              │  ☐ Cross-critique        │
│     ● Implement·overlap  │                                              │──────────────────────────│
│   ◦ Plugins          3m  │                                              │ Feed                     │
│   ◦ Art Direction    8m  │                                              │  DONE  step4 build green │
│ ▸ Main Game Project  ●1  │──────────────────────────────────────────────│  BLOCKER Atlassian auth  │
│ ▸ Site                   │ [ Message Lead ★ord9…               ] Send ▾ │                          │
│ ─────────── ⚙ ◐ ✦ ────── │                                              │                          │
└──────────────────────────┴──────────────────────────────────────────────┴──────────────────────────┘
  320px                      1fr, text measure 760px                         380px (collapsible)
```

**Key state: a worker is waiting for approval** (Inbox row selected or Ctrl+J):

```
│ INBOX  3                 │ VibeSquad › hub › Audit·token scout   ! waiting on you            ⋯ │
│▌! Audit·token scout  5m  │──────────────────────────────────────────────────────────────────────│
│   Bash: rg --stats       │ ┌──────────────────────────────────────────────────────────────┐   │
│   [Allow] [Deny] [Open]  │ │ ! Permission · Bash                                    waited 5m │   │
│                          │ │   rg --stats docs/handoffs                                       │   │
│                          │ │   "Count tokens per handoff"                                     │   │
│                          │ │   [Allow]  [Allow for session]  [Deny…]          ▸ Always allow…│   │
│                          │ └──────────────────────────────────────────────────────────────┘   │
│                          │  (the conversation continues below, scrolled to the request)       │
```

- **Optimises:** jobs 3 and 5 first, then 2. The question "who needs me and why" is answered without a click, and simple permissions without leaving your current chat.
- **Trade-offs:** three columns need ≥1600px, so the right panel collapses below that. The Inbox has to be trustworthy (S1), or it becomes noise. It builds on the existing `attentionItems`, `railAlerts`, `AgentDrawer`, `ChangesPanel` and `panes.ts`.

### Direction B: Mission board *(monitoring-first)*

```
┌────────┬───────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ VS   │ VibeSquad ▾   filter: [All] [Needs me 3] [Running 11] [Idle]            ⌕   Ctrl+J       │
│        │──────────────────────────────────────────────────────────────────────────────────────────│
│ Proj.  │ PROJECT DESK        │ UI BOIS             │ PLUGINS             │ ART DIRECTION          │
│ ● VS 3 │ ● Lead  ord1 134k   │ ◦ Brainstorm        │ ◦ Brainstorm        │ ◦ Brainstorm           │
│ ● MG 1 │ ◦ RiffBot           │ ● Lead ord9         │ ◦ Lead ord2         │ ◦ Lead ord4            │
│ ◦ Site │ ! Audit · perm  5m  │ ● Implement·overlap │                     │                        │
│        │ ? Review · pick 9m  │   last: editing     │                     │                        │
│        │ ✕ Review · EOF  2m  │   src/ui.tsx        │                     │                        │
│        │ ● Art Painter   4s  │                     │                     │                        │
│        │ ● Implement ×4      │                     │                     │                        │
│        │──────────────────────────────────────────────────────────────────────────────────────────│
│        │ ▸ click any card → conversation slides over from the right (960px), board stays behind  │
└────────┴───────────────────────────────────────────────────────────────────────────────────────────┘
```

Key state: the card turns amber and floats to the top of its column. Its Allow/Deny show on the card, and the slide-over opens on click.

- **Optimises:** job 2, seeing the whole squad at a glance.
- **Trade-offs:** reading and talking, the user's main activity with the Brainstorm, becomes a secondary overlay. Ten or more lanes means horizontal scroll. Cross-project attention still needs its own surface. It also duplicates what Psycho's squad page already does with art.

### Direction C: Tiled cockpit *(deep work with 2–4 agents)*

```
┌──────┬───────────────────────────────────┬───────────────────────────────────┐
│ !3   │ UI Bois · Brainstorm        ● ⋯ ✕ │ UI Bois · Lead ord9     ● 74% ⋯ ✕ │
│ ──── │                                   │                                   │
│ VS   │  (chat)                           │  (chat)                           │
│  ●UI │                                   │                                   │
│  ◦Plu│                                   ├───────────────────────────────────┤
│ MG   │                                   │ Implement·overlap        ● ⋯ ✕    │
│      │                                   │  (chat, compact)                  │
│      │ [composer]                        │ [composer]                        │
└──────┴───────────────────────────────────┴───────────────────────────────────┘
 64px icon rail with alert pips
```

Key state: a permission raises an amber pip on the rail. Clicking it opens the agent in the focused tile, replacing what was there.

- **Optimises:** job 5 and watching a Brainstorm and a Lead side by side during a handoff.
- **Trade-offs:** every tile is narrow, and the 64px rail can't say *why* something needs you (FOCUS_CHAT.md rejected it for this reason). Lots of panes means lots of chrome. Monitoring and review are poor.

### Recommendation: **Direction A**

- It matches how the owner actually works: you talk to a Brainstorm or Lead, and everything else is supervision. A keeps the conversation central and moves supervision to the edges, where it can be scanned without a click.
- It fixes the two critical findings (S1, S2) directly, and the data layer already exists (`attentionItems`, `quickPermission`, `railAlerts`, `ChangesPanel`).
- It uses the 4K width for context, not empty gutters.
- B's board can live inside A as the centre view when no agent is selected (the lane table from S9). C's split can come later as a toggle on the centre column (`panes.ts` already supports it). A is the base layout; the other two can be added inside it later.

---

## 4. Design spec (Direction A, Normal mode)

All sizes are CSS px at zoom 100%. The 4K / 120% setup gets sharper rendering from zoom, not bigger text from vw. **No `vw` in type.**

### 4.1 Type scale

Font: system sans (`Segoe UI Variable` on Windows), with JetBrains Mono for code (already bundled).

| Token | Size / line height | Weight | Used for |
|---|---|---|---|
| `--t-caption` | 11 / 16 | 500 | timestamps, metadata, keyboard hints. Sentence case, no tracking. |
| `--t-small` | 12 / 16 | 500 | badges, section labels, tag chips |
| `--t-ui` | 13 / 20 | 400 · 500 for names | sidebar rows, buttons, tabs, tool rows, table cells |
| `--t-body` | 15 / 24 | 400 | messages, composer, permission text |
| `--t-mono` | 13 / 20 | 400 | code, commands, paths, diffs |
| `--t-title` | 17 / 24 | 600 | agent name in the header, panel titles |
| `--t-page` | 20 / 28 | 600 | overview / settings page titles |

Only three weights (400, 500, 600). Messages and the composer share `--t-body`. A user-set chat size (`--chat-font-size`) scales only `--t-body` and `--t-mono` inside the timeline.

### 4.2 Spacing (8px grid, 4px half-step)

Use the existing `--sp-1…--sp-6` (4, 8, 12, 16, 24, 32), plus 48.

| Space | Where |
|---|---|
| 4 | icon ↔ label, badge padding, between a glyph and its text |
| 8 | row inner gap; between tool rows; between stacked buttons |
| 12 | horizontal padding of rows and buttons; gap between header items |
| 16 | panel padding (sidebar, context panel, cards); between messages in one turn |
| 24 | between turns (You → Agent); between context-panel sections; composer padding |
| 32 | overview page padding; gap between overview sections |
| 48 | empty-state padding |

Fixed heights: topbar/header 48, tabs 36, sidebar and table rows 32 (40 under `pointer: coarse`), status strip 32, composer min 56, max 40vh.
Column widths: left 320 (resizable 280–400), right 380 (collapsible; auto-collapses under 1600 viewport), centre `1fr` with the content measure at 760.

### 4.3 Navigation structure

```
Left column
  Brand row: ▣ VibeSquad · ⌕ Search (Ctrl+K)
  INBOX  n   Ctrl+J          ← hidden when n = 0 (shows "All clear" caption)
    attention rows, ordered: permission › question/pick › error › stalled › finished-unread
  PROJECTS
    ▾ Project   ●badge        ← many can be expanded (not an accordion)
      Project desk            ← Overlord / RiffBot / Bugs live here as members
      Lane                    ← click → lane opens on its most urgent member, else last viewed
        live worker rows      ← only while running or alerting; "▸ n idle" collapses the rest
  Footer: ⚙ Settings · ◐ Theme · ✦ Psycho (icon buttons, tooltips)
Centre: header (breadcrumb + member tabs) · status strip · timeline · composer
Right: lane context: Workers · Changes · Plan · Feed (each collapsible; remembers state)
```

**Row states** (sidebar, inbox, member tabs, worker list):

| State | Treatment |
|---|---|
| Default | `--text-2` label, transparent background, 8px state glyph slot on the left |
| Hover | `--surface-3` background; trailing actions (⋯, Open) fade in |
| Focus (keyboard) | 2px `--focus` outline, inset, radius 6 |
| Selected | `--surface-3` background + 2px `--accent` bar on the left edge; label `--text-1` 500 |
| Running | teal dot `--st-run`, 2s opacity pulse (0.55↔1); no pulse with `prefers-reduced-motion` |
| Needs attention | amber filled dot `--st-attn` + row tint `--st-attn-bg` (8% alpha) + reason on the second line in `--text-2` |
| Error | `--st-err` ✕ glyph + tint `--st-err-bg`; the reason is the first line of `lastError` |
| Stalled | amber hollow ring + "stalled 4m" caption |
| Idle | hollow ring `--text-3` |
| Finished / unread | 6px `--st-done` dot; label weight 500 until opened |
| Closed | no glyph, `--text-3`, only visible under "▸ n idle/closed" |

### 4.4 Message and output layout

- **Measure:** content max-width 760px (~72ch at 15px), left-aligned inside the centre column with 32px side padding. Header, status strip and composer align to the same left edge.
- **Turns, not bubbles.** Each turn starts with a 12px-caption line: `You · 1h` or `Lead ★ord9 · gemini-4 · 1h`. Turns are 24px apart.
  - **Your messages:** `--surface-2` background, 12px/16px padding, radius 8, a 2px `--accent` left rule. Full measure, not right-aligned, so long prompts read the same as replies.
  - **Agent messages:** no background, `--t-body` on the canvas. This is the calmest state, because it's most of the text.
- **Code blocks:** `--surface-sunken`, `--t-mono`, radius 6, 12px padding, horizontal scroll (no wrap). The copy button shows on hover/focus, top-right. A language label is a caption.
- **Tool calls (collapsed by default, one group per turn):**
  ```
  ▸ 5 tools · 2 edits +41 −7 · 1 failed · 18s
  ```
  Expanded, one 32px row per call:
  ```
  ✓  Grep     palette                         0.3s
  ✓  Edit     src/pixel.tsx          +12 −3   ▸
  ✕  Bash     vs who lead                     1.2s   ← failed rows auto-expand
       exit 1 · no lead for lane
  ◌  Agent    [Explore] check handoff budget  running 21m  ← stall amber after threshold
  ```
  - Expanding a row shows its input (mono) and its output folded at 12 lines ("Show all 240 lines").
  - **Edits** expand to a unified diff with a max height of 400px. Added lines `--diff-add-bg`, removed `--diff-del-bg`, mono 13/20, gutter line numbers in `--text-3`. Each diff has "Open in Changes ▸" (right panel).
  - **Sub-agents** are an indented card (16px left rule) with their own status glyph. They collapse automatically when done.
- **Permission / question / plan requests** are pinned **above** the timeline under the status strip, and also anchored inline at the point they occurred. Card: `--st-attn` 1px border + `--st-attn-bg` tint, title `--t-ui` 600, then the command or diff preview in mono. Buttons: [Allow] (accent) · [Allow for session] (secondary) · [Deny…] (secondary; on click it reveals a full-width reason field, and Enter sends).
- **Errors** in the timeline: `--st-err-bg` row with the first line of the message, plus "Details ▸" and "Retry" when available.
- **Long assistant output** (>40 lines) folds at 24 lines with a "Continue reading" control.

### 4.5 Status and attention system

- **One glyph vocabulary everywhere** (sidebar, inbox, tabs, workers, table): ● running · ! needs you · ? question/pick · ✕ error · ◌ stalled · ○ idle · • finished-unread.
- **Badges:** numbers only on *collapsed* containers (a project row, a collapsed lane). Use the **highest-severity colour** in the container (error > attention > done), never teal. Max "9+".
- **Motion:** only the running pulse and a one-shot 300ms highlight when a row enters the Inbox. Nothing loops while it needs attention, and the colour carries it instead. Everything respects `prefers-reduced-motion`.
- **Notifications:**
  - OS notification and the tab-title count (existing `QuickWinsUi.tsx`) for permission, question and error.
  - "Finished" raises an in-app toast only when you aren't viewing that agent. Stalls show in the Inbox only, never as an OS notification.
  - Quiet hours and per-kind toggles go in Settings.

### 4.6 Colour (semantic tokens)

Working surfaces are flat and near-neutral, tinted toward the brand violet. Hue lives in **status** and **accent**, and nowhere else.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--surface-0` | `#14111c` | `#f6f4f9` | app canvas (flat, no gradient) |
| `--surface-1` | `#1a1624` | `#ffffff` | sidebar, context panel, header |
| `--surface-2` | `#221d2f` | `#f0edf5` | your messages, cards |
| `--surface-3` | `#2c2640` | `#e6e1ef` | hover, selected |
| `--surface-sunken` | `#0f0c16` | `#ece8f2` | code, diffs, inputs |
| `--border` | `#332c47` | `#dcd6e6` | hairlines |
| `--border-strong` | `#4a4064` | `#c4bcd3` | inputs, focusable cards |
| `--text-1` | `#efeaf7` | `#1f1830` | primary text |
| `--text-2` | `#b8afcb` | `#4c4363` | secondary |
| `--text-3` | `#8b829f` | `#6f6787` | captions (≥4.5:1 on `--surface-1`) |
| `--accent` | `#9b72e8` | `#6d4bc9` | primary buttons, selection bar, links. **Not status.** |
| `--focus` | `#c3a8ff` | `#6d4bc9` | focus ring |
| `--st-run` | `#4fd6cf` | `#16857f` | running |
| `--st-attn` | `#ffc46c` | `#a86a00` | needs you / permission / stalled |
| `--st-err` | `#ff6b8a` | `#c22a52` | error, destructive |
| `--st-done` | `#8fb3ff` | `#3a64c9` | finished-unread |
| `--st-ok` | `#79dfa8` | `#1f7a4c` | ✓ tool success |
| `--st-*-bg` | the status colour at 10% | at 10% | row and card tints |
| `--diff-add-bg` / `--diff-del-bg` | `#79dfa81f` / `#ff6b8a1f` | `#1f7a4c1a` / `#c22a521a` | diff lines |

The hues come from the existing Midnight Mall palette (`styles.css:7`), so Normal and Psycho still feel like one product.

**The Hypnospace touch, kept off the working surfaces:**
- A 2px brand hairline on the very top edge of the window using the existing `--titlebar` gradient (violet → pink → peach). That's the only gradient on screen during work.
- Project monograms in a soft pastel square, using the project colour from `teams.json`.
- Empty states (no lanes, Inbox clear, no Lead yet) reuse the eye/horizon motif already in `BoringAde.tsx`, at 160px, plus a faint Bayer dither patch (`--bayer`) behind it and one wry line ("All quiet on the mall floor. Nobody needs you.").
- The skeleton loading shimmer uses the titlebar gradient at 6% alpha.
- The "✦ Psycho" switch in the footer previews the Psycho palette on hover.
- Easter-egg copy in tooltips and the About dialog ("VIBE OS // 199X"), never in labels you have to understand.

---

## 5. Plan

Effort: **XS** <2h · **S** ≈½ day · **M** 1–2 days · **L** 3–5 days. Every item stays inside Normal (`html[data-vibe="boring"]` or Normal-only components) unless noted, so Psycho is untouched.

### Phase 1: quick visual wins (≈3–4 days total)

| # | Change | Files | Effort | Fixes |
|---|---|---|---|---|
| 1.1 | Flat canvas: remove the main-area gradient and the TRINITY gradient card; add the 2px brand hairline | `src/boring.css` | XS | C4 |
| 1.2 | Type tokens §4.1; replace every `clamp(…vw…)` and stray px size in boring.css; composer = body size | `src/boring.css` | S | C2 |
| 1.3 | Message measure 760px; align composer and header to it | `src/boring.css` | XS | C1 |
| 1.4 | Colour tokens §4.6 as aliases in boring.css; accent ≠ status; light theme neutral surfaces | `src/boring.css` | S | C3, C5 |
| 1.5 | State glyph classes (`run/attn/err/stalled/idle/done`) on sidebar and overview dots, from the agent's status + attention | `src/BoringAde.tsx` (`boringSidebarModel`, `boringNodeStateClass`), `src/boring.css` | S | §1.4 table, partial S1 |
| 1.6 | Copy pass: Project · Lane · Brainstorm · Lead · Worker; "+ New lane"; Trinity → "Project desk"; drop `MAIL://`, `[ALL]`, uppercase labels; emoji → line icons | `src/BoringAde.tsx`, `src/UsageDashboard.tsx` (Normal branch), `src/boring.css` | S | S3, C6 |
| 1.7 | Permission card: button hierarchy, full-width deny reason, remove the count bar (Normal scope) | `src/PermissionCard.tsx` (move inline styles to classes), `src/boring.css` | S | C7 |
| 1.8 | Show `Ctrl+J` / `Ctrl+K` hints; label the 🔍 and ? pills | `src/BoringAde.tsx` | XS | S10 |
| 1.9 | 32px rows on fine pointers, 40px on coarse | `src/boring.css` | XS | C8 |

### Phase 2: structural, attention first (≈2 weeks)

| # | Change | Files | Effort | Fixes |
|---|---|---|---|---|
| 2.1 | **Bug:** hub-lane and worker alerts are counted but not shown. Include `zones.hub.needsYou` and worker alerts in Normal rows and the overview | `src/BoringAde.tsx`, `src/pins.ts` (read only) | XS | S1 |
| 2.2 | **Inbox** section: cross-project `attentionItems()` with reason, age, project/lane, and inline Allow/Deny via `quickPermission`; Ctrl+J opens the top row; badges filter it | new `src/BoringInbox.tsx`; reuse `src/attentionItems.ts`, `railAlerts` in `src/FocusRail.tsx`; `src/BoringAde.tsx` | M | S1, S4 |
| 2.3 | Selection derived from the active agent; breadcrumb `Project › Lane › Agent`, clickable | `src/BoringAde.tsx`, `src/panes.ts` (read) | S | S8 |
| 2.4 | Lane rows expand to live workers (alert rows show their reason); multiple projects expanded at once; lane click opens its most urgent member | `src/BoringAde.tsx` (`boringSidebarModel`), `src/pins.ts` (read) | M | S2, S3, S4 |
| 2.5 | Member tabs in the header (Brainstorm · Lead · live workers) replace the sidebar role pills and the Lead header chips | `src/BoringAde.tsx` | S | S2, C9 |
| 2.6 | **Normal agent header**: one line + ⋯ menu + status strip (stall, handoff due, context ≥72%). Build it as a new component, don't CSS-hide `DrawerHeader` | new `src/BoringAgentHeader.tsx`; `src/AgentDrawer.tsx` (header slot prop); `src/DrawerHeader.tsx` (extract the action handlers to reuse) | L | S6 |
| 2.7 | Tool-call rows §4.4: group summary with outcomes, ✓/✕/duration, edit `+/−` stats, failed rows auto-expand, output fold | `src/Timeline.tsx` (tool group + `DiffView` at :545), `src/boring.css` | M–L | S7 |
| 2.8 | Right **lane context panel**: Workers · Changes · Plan · Feed; collapses below 1600px | new `src/BoringContextPanel.tsx`; reuse `src/ChangesPanel.tsx`, `src/TeamFeed.tsx`, the plan/todo from `src/Timeline.tsx` | L | S5 |
| 2.9 | Overview → lane table sorted by urgency (Map stays in Psycho) | `src/BoringAde.tsx` | M | S9 |
| 2.10 | Default landing: Inbox if non-empty, otherwise the overview | `src/BoringAde.tsx` | XS | S4 |

### Phase 3: foundations, ongoing

| # | Change | Files | Effort |
|---|---|---|---|
| 3.1 | Move inline `style={{}}` in shared components (`PermissionCard`, `Timeline`, `DrawerHeader`, `FilePreview`) to token classes, so Normal stops needing `!important` | those files, `src/styles.css`, `src/boring.css` | L |
| 3.2 | Cut `boring.css` `!important` from 100 to <10; add a lint/test that counts them | `src/boring.css`, `test/` | M |
| 3.3 | Optional 2-pane split of the centre column (Direction C as a toggle), using `panes.ts` | `src/BoringAde.tsx`, `src/panes.ts` | M |
| 3.4 | Extend `docs/ADE_JOB_WALK.md` with Normal-mode rows for jobs 2–4 (e.g. "permission from a hub worker in another project → answered in ≤1 click") | `docs/ADE_JOB_WALK.md` | S |

### Decisions needed from the owner
1. **The single name for a lane in the UI:** "Lane" (recommended: it's the code word and already a heading in Normal) or "Team" (per `NAMING.md`). "Conversation" should go either way.
2. **Inline approval from the Inbox:** allow it for plain Bash/Edit permissions, or always open the agent first? I recommend inline for `quickPermission` only (no questions or plans), since `attentionItems` already makes that distinction.
3. **Whether Overlord, RiffBot and Bugs keep their persona names in Normal.** I recommend keeping them as subtitles under role names ("Project Brainstorm · RiffBot").
