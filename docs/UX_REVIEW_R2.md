# VibeSquad UX review, round 2: Normal mode

Date: 2026-11-15 · Build: `master` @ `2a4a2b8` (after D1 visual foundations, D2 attention spine, D3a header, D3b tool rows, D3c context panel).
Method: same as round 1 (`docs/UX_REVIEW.md` §0): `vite ?demo`, 3200×1800 CSS px (4K at 120%), dark theme.
Evidence: `docs/shots/ux-review-r2/` (full window + full-resolution sidebar crop for each state).
Wireframes: the "Round 2 · Sidebar" row of the Design canvas linked in `docs/UX_REVIEW.md` § Wireframes.

## What got better

- **Needs you works.** It covers every project, shows the reason, and Allow/Deny works inline. The round-1 critical (badge with nowhere to go) is fixed.
- **Header**: one line plus a 32px status strip. **Tool rows**: outcome summary, exit badge, folded output. **Right panel**: Workers / Changes / Plan / Feed / Files / Terminal.
- The overview lane table, flat surfaces, type scale, and the "Lane" / "Project desk" naming have all landed.

The main remaining problem is the **sidebar**.

## Sidebar: why it's confusing

The sidebar stacks eight blocks with different scopes, and nothing on screen says which block belongs to which project:

```
+ New lane            ← which project? (the "active" one, which isn't shown)
Needs you             ← all projects
Recent done           ← all projects
Project tree          ← every project; open ones show lanes INLINE…
Overview              ← the active project
+ New project         ← global
Project desk          ← the active project, unlabeled
Lanes                 ← the active project, unlabeled
Usage · Settings · Psycho
```

| # | Sev | Problem | Evidence |
|---|---|---|---|
| R2-1 | critical | **One tree, two shapes.** An expanded project shows its lanes under its own row, *unless* it is the "active" project. In that case its lanes and desk move below the Overview and + New project buttons, cut off from their project row. Expand a second project and the two look completely different. | `02-two-projects-two-shapes-sidebar.png`; `src/BoringAde.tsx` sidebar block (`open && !active` vs the separate `boring-core-group` / `boring-conv-list`) |
| R2-2 | critical | **The "active project" is invisible, and Ctrl+J doesn't change it.** Ctrl+J opened a VibeSquad worker, but the breadcrumb says "Main Game Project › Brainstorm". The tree then flips: VibeSquad's lanes show inline and Main Game's desk and lanes sit at the bottom. The breadcrumb is built from `view.team` and the selected role, not from the open agent (`boringBreadcrumb(...)`, `BoringAde.tsx:416`). Round-1 finding S8 is not fixed for Ctrl+J or Inbox opens. | `03-ctrlj-wrong-project.png` |
| R2-3 | major | **Two rows look selected at once.** In `04`, "Site" (a project row) and "Plugins" (a lane) both have the selected slab. Earlier, "UI Lab" stayed highlighted while VibeSquad's overview was open. Selection is stored in several places instead of derived from what's on screen. | `04-two-selected-rows-sidebar.png`, `02-…-sidebar.png` |
| R2-4 | major | **Needs you takes over the column.** Each item is 4 lines (name, reason, location, buttons), about 93px. Five items use about 480px before the project tree starts. At 10 alerts the tree is gone. | `01-home-sidebar.png` |
| R2-5 | major | **The count doesn't match the list.** The header says **4** but shows **5** cards. "★ LEAD · Plugins — finished" is listed but not counted. Finished isn't "needs you", and there's already a "Recent done" section for it. | `01-home-sidebar.png`; `BoringInbox.tsx` `KIND_RANK` includes `finished` |
| R2-6 | minor | **"Dismiss" on every card**, including questions ("pick option A or B") and errors. Dismissing a question is never what you want. | `01` |
| R2-7 | minor | **Location says "VibeSquad › VibeSquad"** for anything in the project's own lane. It should read "VibeSquad › Desk". | `01` |
| R2-8 | minor | **Rows don't line up.** Lanes with workers get a ▸ to the left of their dot ("▸ ● UI Bois"); others don't, so dots zig-zag. | `02-…-sidebar.png` |
| R2-9 | minor | **Bugs is in "Project desk"** but it's a lane, and still shows the "(@bug)" code. | `01` |
| R2-10 | minor | **Raw legacy titles in the queue**: "★ MAIN GAME ord75", "★ LEAD · Plugins". The display formatter should give "Lead · ord75". | `01` |

## The fix: one tree, one shape

Wireframes: canvas row "Round 2 · Sidebar", three boards drawn at 100%.

```
▣ VibeSquad                [⌕ Search  Ctrl+K]
Needs you ⓸                           Ctrl+J
  ● Audit · token scout              5m
    Bash: rg --stats · VibeSquad › Desk
    [Allow] [Deny]                         ← only permission rows get buttons
  ● Review · Sonnet                  9m
    Pick option A or B · VibeSquad › Desk  ← no buttons; ⋯ on hover = Snooze / Dismiss
  … max 5 rows, then "+ N more" → full list in the main area
▸ Done recently · 4                        ← finished items live here, not above
────────────────────────────────────────────
Projects                                [+] ← new project
▸ ▣ Main Game Project                    ⓵ ← badge only while collapsed
▸ ▣ Site
▾ ▣ VibeSquad                [+ lane] [⋯]   ← click name = this project's overview
    ▾ ● Desk  Overlord · RiffBot         ⓷
        ● Lead · Overlord              now
        ○ Brainstorm · RiffBot         12m
        ▸ 9 workers · 3 need you
      ○ Bugs                                 ← a lane, first in the list
    ▸ ● UI Bois                        2m    ← ▸ only when it has live workers
      ○ Plugins                        3m      (the chevron column is always there)
      ○ Art Direction                  8m
────────────────────────────────────────────
Usage & workflows · Settings · ✦ Switch to Psycho
```

**Rules**

1. **Every project renders the same way.** Its Desk, Bugs and lanes always sit under its own row. Delete the separate `boring-core-group` / `boring-conv-list` sections and the `open && !active` branch.
2. **Clicking a project name opens its overview**, and that project row is the selected row. The chevron only expands or collapses. This removes the standalone "Overview" button.
3. **+ New lane moves to the project row** (on hover/focus) and to the overview header. **+ New project** becomes the `+` on the "Projects" heading. The top "+ New lane" button goes; search takes its place.
4. **One selected row, derived from what's on screen**: the overview → its project row; an agent → its row (worker, lead or brainstorm). Its parents expand and the row scrolls into view. The breadcrumb uses the **same** derivation (fixes R2-2 and R2-3).
5. **Needs you**:
   - 2-line rows: name + age, then reason · Project › Lane.
   - Allow/Deny buttons on permission rows only. Snooze / Dismiss behind a hover ⋯.
   - At most 5 rows, then "+ N more" opens the full list in the main area.
   - The count equals the rows. Finished items go to "Done recently".
6. **A fixed 16px chevron column on every row**, so the state dots form one vertical line at each level.
7. **Badges**: a number only on a *collapsed* container, in the colour of the worst state inside it (red if any error, else amber). Expanded containers show no number, because their children show it.

## Other round-2 notes (not sidebar)

- **Overview table mixes agents into the lane list.** "Project Lead · Overlord" and "Project Brainstorm · RiffBot" appear as lane rows with "—" in every column. Show the Desk as one row with its Lead and Brainstorm in the Lead/Brainstorm columns.
- **Header strip duplication.** On the Audit worker the header shows the 93% bar *and* a strip saying "Context 93% full". Keep the bar in the header. The strip should only carry something you can act on ("Hand off ▸").
- **Breadcrumb role**: when a worker is open, the last crumb should be the worker's name, not "Brainstorm".

## Plan

| # | Change | Files | Effort |
|---|---|---|---|
| R2.1 | Derive selection + breadcrumb from the open agent / view (one function, used by both) | `src/BoringAde.tsx` (`boringBreadcrumb`, `selectedLaneId`, `activeTeamId`) | S |
| R2.2 | One tree shape: Desk/Bugs/lanes under each project; delete the active-project sections; project name → overview | `src/BoringAde.tsx` (sidebar block ~540–600), `src/boring.css` | M |
| R2.3 | Move + New lane / + New project; remove the top button | `src/BoringAde.tsx`, `src/boring.css` | XS |
| R2.4 | Needs you: 2-line rows, cap 5 + "N more", finished → Done recently, buttons on permissions only, ⋯ menu, location "Desk" | `src/BoringInbox.tsx`, `src/boring.css` | S |
| R2.5 | Chevron column, badge-on-collapsed-only, worst-state colour | `src/BoringAde.tsx`, `src/boring.css` | XS |
| R2.6 | Overview: Desk as one row; header strip doesn't repeat the context bar | `src/BoringAde.tsx`, `src/BoringAgentHeader.tsx`, `src/boringHeaderStrip.ts` | S |
| R2.7 | Clean legacy titles in Needs you via the shared display formatter | `src/BoringInbox.tsx` (use the identity display helper) | XS |

Do R2.1 first. Most of the "where am I?" confusion comes from the selection and breadcrumb disagreeing with the tree, and the other fixes depend on a single source for "what's on screen".
