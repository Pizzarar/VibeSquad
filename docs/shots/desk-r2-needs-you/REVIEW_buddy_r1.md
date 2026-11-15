# Desk Buddy Look-Check R1 — `unit-desk-r2-needs-you` (`f32e7e8`)

**Verdict:** FAIL (2 visual MUSTs visible in all 6 screenshots, 2 small NICEs)

Reviewed all 6 screenshots at 4K@120% dark + light:
- `needs-you-dark-sidebar.png` / `needs-you-light-sidebar.png`
- `needs-you-dark-expanded.png` / `needs-you-light-expanded.png`
- `needs-you-dark-hover-menu.png` / `needs-you-light-hover-menu.png`

## What's working well
- **2-line compact rows & cap 5 + `+ N more` (`R2.4`):** Non-permission rows are 2 lines (`who + age` on line 1, `reason + location` on line 2); only quick permissions render inline `[Allow]` / `[Deny]` buttons; list caps at 5 with `▸ + 7 more` / `▾ Show fewer`.
- **Count matches rows & `finished` moved to `Done recently` (`R2-5`):** `Needs you` badge count (`12`) equals the rows in `Needs you` (5 shown + 7 folded); `finished` items are excluded from `Needs you` and routed to `Done recently`.
- **Hover `⋯` menu (`R2-6`):** `needs-you-{dark,light}-hover-menu.png` confirms `⋯` appears on row hover/focus with `Snooze 2h` (and `Dismiss` on non-permission rows).
- **Worst-state container dots & Unit 1 carry-overs (`R2.5`):** `VibeSquad` project dot and `Desk` dot both show red (`st-err`) matching the worst state inside, and `.boring-desk-children > .boring-worker-list { padding-left: 0; }` is in place.

---

## MUSTs (block merge)

### MUST 1 — Hub location still renders `"VibeSquad › VibeSq..."` & `"VibeSquad › vibesquad"` instead of `"VibeSquad › Desk"`, and dynamic lanes render raw slugs like `"VibeSquad › ui-bois"` (`R2-7` / `R2.4`)
- **Evidence in shots:**
  - In all 6 shots, every VibeSquad hub row in `Needs you` reads `VibeSquad › VibeSq...` on line 2 instead of `VibeSquad › Desk`.
  - In `needs-you-{dark,light}-expanded.png` (row 10, `Implement - overlap guard`), the location reads `VibeSquad › ui-bois` (raw slug) instead of `VibeSquad › UI Bois`.
  - In all 6 shots, the `Done recently (1)` row reads `VibeSquad › vibesquad · 14m` instead of `VibeSquad › Desk · 14m`.
- **Root cause & fix (`src/BoringInbox.tsx:59-61, 82`, `src/boring.css:1172-1173`):**
  1. In `needsYouRows` (`src/BoringInbox.tsx:59-61`), `isHubLane(view.team, laneDef)` returns `false` for `lane.id === view.team.id` (`"vibesquad"`) whenever the live `teams.json` also has an explicit `hub: true` lane (such as `riffbot`) or when `vibesquad` is a dynamic lane not in `view.team.lanes`. Meanwhile `BoringAde.tsx:78-79, 180, 202` treats both `isHubPin` and `lane.id === view.team.id` as `Desk`.
     - Treat `!member.laneId || member.laneId.toLowerCase() === view.team.id.toLowerCase() || (laneDef ? isHubLane(view.team, laneDef) : false)` as `hub = true` (`lane = "Desk"`).
     - For non-hub lanes, look up the lane in both `view.team.lanes` and `view.lanes` (`view.lanes?.find((l) => l.lane.id.toLowerCase() === member.laneId?.toLowerCase())?.lane`) and format with `boringLaneLabel(...)` so `ui-bois` renders as `"UI Bois"`.
  2. In `doneRecently` (`src/BoringInbox.tsx:82`), `d.entry.lane` is interpolated raw (`` `${d.project}${d.entry.lane ? ` › ${d.entry.lane}` : ""}` ``), producing `VibeSquad › vibesquad`. Map `d.entry.lane` through the same hub/lane-name resolver so hub entries (`!d.entry.lane || d.entry.lane.toLowerCase() === d.teamId.toLowerCase()`) read `VibeSquad › Desk`.
  3. In `src/boring.css:1172-1173`, set `.boring-needs-reason { flex: 1 1 0; min-width: 0; }` and `.boring-needs-why .boring-needs-where { flex: 0 0 auto; max-width: 55%; text-align: right; }` so `VibeSquad › Desk` is never truncated by a long reason string on the left.

### MUST 2 — `Done recently` log row stacks the blue `.st-done` dot on its own line above the text (`src/boring.css:1186-1187`)
- **Evidence in shots:**
  - In all 6 shots, under `▾ Done recently (1)`, the blue `.boring-dot.st-done` sits on a separate line *above* `PASS step4 team actions: build green, 3 files tou...` instead of inline to the left of the text.
- **Root cause & fix (`src/boring.css:1186-1187`, `src/BoringInbox.tsx:191-195`):**
  - `src/boring.css:1186-1187` sets `.boring-done-row { grid-template-columns: 1fr auto; }` and `.boring-done-row > .boring-dot, .boring-done-row > .boring-done-text { grid-column: 1; }`, which places both the dot and the text into column 1 of the grid, stacking them vertically in two grid rows.
  - Fix: in `src/BoringInbox.tsx:191-195`, wrap the dot + text in `<div className="boring-needs-line"><span className="boring-dot st-done" /><span className="boring-done-text">{d.text}</span></div>` (matching the structure of `d.row` items), or set `.boring-done-row` to align dot and text inline on row 1 with `.boring-needs-where` indented (`padding-left: 14px`) on row 2.

---

## NICEs (easy polish while touching `src/BoringInbox.tsx` / `src/attentionItems.ts`)

1. **`legacyLeadTitle` with uppercase lane name (`src/attentionItems.ts:87`, `R2-10`):**
   - `legacyLeadTitle` currently matches `/^(?:★\s*)?(?:lead\s*·\s*)?ord(\d+)\s*(?:·\s*(.+))?$/i`, which handles `"Lead · ord75"` and `"★ Lead · ord75"`, but misses `"★ MAIN GAME ord75"` / `"★ UI BOIS ord9"` where the v1 lane name sits between `★` and `ord<N>`. Broadening the optional middle group to `(?:[a-z0-9_-]+(?:\s+[a-z0-9_-]+)*\s+)?` catches `"★ MAIN GAME ord75"` while keeping `"Fix the login bug"` untouched.
2. **Permission reason when command is in `p.title` (`src/BoringInbox.tsx:35-38`):**
   - In `needs-you-{dark,light}-sidebar.png`, `Audit - token scout` shows `Bash` instead of `Bash: rg --stats` (`docs/UX_REVIEW_R2.md:53`) because `src/demo.tsx:75` has `name: "Bash", title: "Bash: rg --stats"` with no `input.command`. If `!arg && p.title && p.title.startsWith(tool)`, returning `p.title` displays `Bash: rg --stats`.
