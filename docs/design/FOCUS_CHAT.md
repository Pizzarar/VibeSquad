# Focus chat: design proposal

Status: proposal for Unit L. Nothing is built. Mockups are in `docs/design/focus-chat/`
(`default.png`, `focus.png`, `split.png`, made from the throwaway `mockups.html` with the real cast sprites).

## The rule that decides it

**In focus mode the side of the screen is an interrupt queue and a switchboard, not a roster.**
A row earns a pixel only if it answers one of two questions without a hover:
*does someone need me?* or *where is the agent I want to talk to next?*
Anything you'd read for its own sake (cards, feeds, handoff chains, folders) waits behind the toggle.

How to check it: in focus mode, time how long it takes to get from "a permission alert fires on another team"
to "that agent's chat is in front of me". The target is one click (or Ctrl+J) with no hover and no team switch.
Then count how often the user leaves focus mode to do something the rail couldn't. If that happens more than about
once per session for the same reason, that reason belongs in the rail.

## Layout

| Mode | Columns |
|---|---|
| Default (Unit L) | sidebar 265px · team page 1fr · chat column (tabs) 560px |
| Focus | **rail 264px** · chat 1fr (tabs; optional 2-pane split) |
| Phone (M2) | the same rail becomes the tab switcher sheet; one pane |

The sidebar and the team page fold into one rail. Nothing else moves: the chat area is Unit L's tabs/split,
unchanged, just wider. Focus mode on desktop is the phone layout with the rail pinned open, so it should be
built as one component.

## What's in the rail, top to bottom

1. **Header**: team switcher (emblem + name ▾) and `◂ TEAM`, which exits focus.
2. **NEEDS YOU, across all teams.** This is the only cross-team list. Rows are sorted in alert order:
   permission › needs-aub › error › finished. Each row has a 28px portrait, the agent name, and the reason on a
   second line (for example "PERM · Bash: rg --stats"). An agent from another team gets a muted team suffix.
   Show at most 5, then "+N more".
   - A click opens the owner (see Jumping, below). Ctrl+J opens the top one.
   - **An agent in this list is removed from the tree below.** When its alert clears it drops back into the tree.
     That way one agent never has two rows in the rail.
3. **Current team, one lane block per lane.**
   - The lead row, with its live workers nested one level under it. Then the brainstorm row with its own
     children.
   - Each row has a 28px portrait at 1× (crisp), the name, a status dot (cyan = running, violet = idle) and a
     3px budget bar. The token count is printed only once the agent passes 72% of its handoff budget. Under
     that, the bar alone is enough.
   - Idle and closed agents collapse to one line ("▸ 2 idle · 1 closed"). Levels deeper than one show as
     "▸ N under X", using the tree's existing expand state (`setTreeShowClosed` / open set).
   - Old leads are not shown. They belong to the team page.
4. **Other teams**: one line each with the name, alert count and running count. A click switches which team the
   rail shows. It never opens, closes or moves a tab. Their alerts are already listed in NEEDS YOU.
5. **Footer**: provider quota, **only when a provider is hot (≥85%)**. Otherwise the footer is empty.

### Out of the rail, and why

| Out | Why |
|---|---|
| Lead/brainstorm cards | The lead and brainstorm rows carry the same facts at a third of the height. |
| Team feed, handoff/chain panel | These are for reading, not for interrupting. Use the team page. |
| Live folders, archived, old leads | Housekeeping. |
| Search, Old leads/Archived/Show closed chips | These filter the roster; the rail isn't a roster. |
| `+ NEW AGENT` | It creates something. It stays in the tab bar "+" menu and on the team page, never on a rail row. |
| Team token total, per-row model/cwd | Shown in the pane header of whichever agent you open. |
| Role tags (`IMPLEMENT`, `REVIEW`…) | The portrait already says the role. |

## Jumping to another agent without leaving focus

- **Click** a rail row: if the agent is already open in a tab, focus that tab (in whichever pane holds it).
  Otherwise open it as a new tab in the **active pane**.
- **Shift+click**: open in the **other** pane. If the split is closed, this opens it. This is the only way to
  open the split from the rail.
- **Ctrl+click / middle-click**: open as a background tab without switching.
- **Ctrl+J**: open the top NEEDS YOU item. **Ctrl+1…9**: switch tabs in the active pane.
- Drag a row onto a pane: open it there. This is a later nicety, not needed for v1.
- **Nothing in the rail spawns an agent.** Alerts open their owner, the same rule the sidebar alert pills follow
  today.

## Tabs vs. rail: no double listing

The tab strip lists what's open. The rail lists who exists. An open agent is **marked** in the rail, not
listed again:
- A row whose agent is open gets a lit left edge: **cyan = left (active) pane, violet = right pane**. The same two
  colours light the top of each pane's active tab, so the eye can link a row to its pane.
- The rail has no "open tabs" section.
- In split, each pane keeps its own tab strip (Unit L). The pane you last clicked in is the active pane.

## Reading it at a glance

- Portraits are 28px (1×) in the rail and tabs, and 56px (2×) in pane headers. Never use 32 or 22 here.
- Alert rows get a hot-pink tinted box. Everything else is plain rows, so alerts are the only loud thing.
- Status is the dot. Budget is the bar. Text appears only for the exceptions: the alert reason, tokens past 72%,
  and a quota at 85% or more.
- If the window is under about 1200px wide, the rail drops to a **56px portrait strip** (portrait + alert/status
  corner pips, full name on hover). That's a fallback only; see the rejected alternative.

## The toggle

- **Where**: `▣ FOCUS` on the chat tab bar (default mode), because that's what you're about to enlarge.
  `◂ TEAM` in the rail header exits. Both are the same toggle.
- **Shortcut**: `Ctrl+.`. Chrome, Edge and Electron don't claim it, and it doesn't conflict with the composer
  (Ctrl+Enter sends). Esc does *not* exit focus, because Esc is the composer's.
- **Persistence**: **global**, one key (`vs.focus`). Focus describes how the user is working right now, not a property
  of a team. A per-team setting would flip the layout under you when you switch teams. The rail's team choice
  reuses the existing `vs.team`.
- Entering focus with no tab open opens the current team's lead (the "talk here" agent). That opens an agent; it
  doesn't spawn one. If the team has no lead, the pane shows an empty state and the rail is still there.
- Tabs, drafts (Unit D) and pasted images (Unit I) are untouched by the toggle, because tabs stay mounted.
  Toggling only changes the grid.

## My lean, and the alternative I rejected

**Lean: the 264px rail described above.** It holds a cross-team NEEDS YOU queue, the current team's lane tree one
level deep, and one line per other team.

**Rejected: a thin portrait-only strip (56px) as the focus layout.** It looks cleaner and gives the chat about
200px more. But at 28px the portraits tell you role and provider, not *which* agent: two Implement workers on
the same provider differ only by their seed colours. They also can't tell you *why* someone needs you. Every
decision would need a hover, and a hover is a context switch, which is exactly what focus mode is meant to stop.
So it stays as the narrow-window fallback only.

Also considered and dropped: keeping the team page as a collapsible band above the chat. Chat is a vertical
reading surface, so the band would cost the space the chat most needs. It would also bring back the cards and
feed that focus mode is meant to hide.

## Hand-off notes for Unit L

- **Mode switch**: build focus as a grid-template switch on `.app` (`.app.focus { grid-template-columns: 264px 1fr }`),
  not a separate route. This keeps tabs mounted.
- **Shared state**: the rail and the sidebar can share `sideAlerts`-style logic. Generalise it to "alerts across
  all teams, minus nothing", and have the tree exclude alerted agents.
- **Pane colours**: the active-pane colour (cyan/violet) needs to be in a selector the rail can read, next to
  the selection store from `fe3ab74`.
- **Art gates**: unchanged. The art is the original neon-noir cast only. No new art is needed: the rail reuses
  the existing 28px sprites and `NeonEmblem`.
