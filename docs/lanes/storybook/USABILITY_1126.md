# Storybook usability walkthrough: EFI (owner jobs)

Drove the live app at http://localhost:4180/?sb=efi on 2026-11-26 (snapshot `origin/main @ 66b3f037`), at 1440x900 dark plus one 390 phone pass. Snapshot: 3617 lines, 25 quest steps, 92 contracts, 249 items, 16 locations, 16 voice cards, and Findings 3661 (Missing 113, Broken 2, Inconsistent 38, Unreviewed 3508). Screenshots are in `/tmp/sbux/shots/`. The UI is read-only, so job 2 cannot be done here at all.

## A. How to use it today

1. **Read text (job 1):**
   - Quest text: Quest web → trader chip → click a step in the **Steps** list. The story text only appears in that popover.
   - NPC lines: Characters → speaker chip → scroll **Lines**.
   - All other UI text: Findings → **Unreviewed** (3508 rows, ordered by file path).
2. **Redo or edit (job 2):** not possible. You copy the `path:line` shown under a finding and edit the repo, or the CSV, outside VibeSquad.
3. **Links (job 3):**
   - Locations → location chip shows its quests, enemies and spawn windows, contracts and lore.
   - A step's popover shows its speaker and source.
   - The dashed edges in the Quest web diagram show item, location, room and enemy targets.
4. **Coherence (job 4):** Quest web → one trader at a time (3 or 4 steps each), plus Findings → **Inconsistent** for VOICE_BIBLE drift and duplicate lines.
5. **Quest items (job 5):** the only way in is the "wants item" chip in a quest chain, which opens a mostly empty card. There is no item view.

## B. Gaps per job

### Why it feels "jumbled" (first impression)
- **J0-1 (major) Four flat button walls and no orientation.** The view opens on Builder's quest graph, with no summary of what exists or what needs attention.
  - Every level is the same wrap-around grid of chips, with no sort the owner can see: 7 traders, 16 locations (Sublevel 1–10 take most of it), 26 characters (`03-tab-characters.png`).
  - Fix: add an Overview landing page: counts per kind, "needs you" buckets, and the story arc in order.
- **J0-2 (major) Findings is 96% noise.** The tab shows 3661, but 3508 of those are "Unreviewed" CSV rows that are really the text inventory, not problems. The real issues (153) are buried in them.
  - The default list starts with Inconsistent VOICE_BIBLE regex chatter (`03-tab-findings.png`). The Unreviewed list is **413,000 px tall** with no paging or search (`07-findings-unreviewed.png`).
  - Fix: split it into "Text to review" (the inventory) and "Problems" (the 153). Badge only the Problems count.
- **J0-3 (major) There is no search and no text filter anywhere.** The view has zero `<input>` elements. You cannot find "that line about brass."
  - Fix: add one global search box over the display, text, id and path of every entity.
- **J0-4 (minor) Developer chrome next to the prose.** Every line card repeats "csv" and "DRAFT" badges, and cards are about 90 px tall for 1–5 words (`08-finding-goto.png`). The System voice card prints raw regexes under "Never says".
  - Mermaid drops apostrophes ("Someone Else s Gear"), and contracts show as raw ids (`x_popper_harbor_district`, `03-tab-locations.png`).
  - Fix: one compact row per line, status shown as a colored dot, ids hidden behind hover, regexes rendered as plain words.

### Job 1: Review every quest, quip and line
- **J1-1 (blocker) 3083 of 3617 lines (85%) have no speaker,** so the Characters tab never shows them (`storybookLogic.ts:271` drops lines without a speaker). The Characters total is about 560.
  - The only way to reach the other 3000 is the giant Unreviewed list, with "STORY-TODO:" in front of every row.
  - Fix: add a **Text** tab grouped by screen or feature (`scenes/raids/raids_view.gd`, `data/items.json` …) with collapsible groups.
- **J1-2 (major) Quest story text is hidden in a click popover.** The Steps list shows only titles (`04-quest-step-click.png`). You cannot read a trader's arc top to bottom.
  - Fix: render each step's title, story text and objective inline, in a reading column.
- **J1-3 (major) The "→ line" jump lands in the wrong place.** On a speakerless line it opens Characters → **System** at the top, not the line (`08-finding-goto.png`). Cause: `StorybookView.tsx:503-504` falls back to the first character when the speaker is "".
  - Fix: open that line's card, or scroll to it in the Text tab.
- **J1-4 (minor) Format strings with no context.** Lines like `%d caught` and ` · used` appear with no key or screen context. Fix: show the source file and key as a subtitle.

### Job 2: Mark for redo, or edit in place
- **J2-1 (blocker, deferred in v1) No mark or edit action at all.** The Unreviewed legend says "not marked OWNER-OK", but nothing in the UI sets OWNER-OK.
  - Fix, in two steps:
    - First, a local "Redo / OK / note" marker stored per entity id in VibeSquad, with export to a CSV or an inbox card. This needs no repo writes.
    - Later, write-back to `text_review.csv`.

### Job 3: Links to location and NPC
- **J3-1 (major) A name collision merges two characters.** The squad member **Saint** has id `doc`, the same as trader **Doc**. Characters "Doc 25" mixes both sets of lines, and Saint's own chip shows 0 lines.
  - Fix: key speakers by kind and id (`squad:doc` vs `trader:doc`). Needs an adapter change plus UI.
- **J3-2 (major) Duplicate character chips.** Magpie, Patch, Prof, Skillet, Smooth, Tank and Wrench each appear twice: once with a line count, once with no lines (voice card ids are `squad-magpie`, the speaker id is `magpie`; `storybookLogic.ts:274`). See `03-tab-characters.png` and `11-phone-characters.png`. Fix: normalize voice-card ids to the speaker id.
- **J3-3 (major) No "where is this said" link.** Only 5 lines have `said_at` and 178 have `spoken_by`; 3434 have no link at all. A line card cannot show you its NPC and location.
  - Fix: infer screen and NPC links from the source path in the adapter, then show them on every line row.

### Job 4: Story coherence
- **J4-1 (major) No whole-story view.** Each trader chain shows on its own (3–4 steps). There is no cross-trader timeline, no link from progression to unlock, and no view of where contracts fit in.
  - All 25/25 steps are `placeholder` with STORY-TODO, which you can only see one popover at a time.
  - Fix: add an "Arc" page listing all chains side by side in unlock order, with a placeholder/written status per step.
- **J4-2 (minor) Useful coherence checks are scattered.** Checks #7, #11 and #4 (impossible kill quests, duplicate lines) are mixed into the same list as the regex noise. Fix: add a "Story issues" filter.

### Job 5: Quest items
- **J5-1 (blocker) There is no Items view.** 248 of 249 items have an empty description, and 53 items are never referenced by a quest, contract, recipe, trader or location. Nothing in the UI shows either fact.
  - Clicking "Brass Casing" in a chain opens only a thin card (`05-popper-step1.png`).
  - Fix: add an **Items** tab with a table of each item and its sources (location drop, trader, recipe), its quest uses, and whether it has a description. Filter it to "orphans" and "no story".

### Other
- **J0-5 (minor) Setup Checklist modal on a fresh browser profile.** It covers Storybook on a cold `?sb=` link (`01-first-load.png`, first run). The owner's own browser is unlikely to hit this.
- **J0-6 (minor) Phone layout.** The chip walls take the whole first screen, the top-bar "1 needs you" button is full width, and the Findings tab is clipped (`11-phone-characters.png`).

## C. Top 5 next units (ranked by owner value)

1. **Text tab with global search:** every line grouped by screen or feature and by speaker, one compact row each, plus a search box over all entities. Fixes J1-1, J1-3, J0-3 and J0-4. *UI-only* (it groups by `source.path`).
2. **Overview page, with Findings split into "Text to review" and "Problems (153)":** the landing page shows counts and attention buckets, and the badge shows only real problems. Fixes J0-1 and J0-2. *UI-only.*
3. **Owner marks (Redo / OK / note) stored locally, plus a filtered "My marks" view and an export to an inbox card or CSV.** Fixes J2-1, partly. *Needs write-back,* but a light version (VibeSquad-side store, no repo writes) avoids the deferred v1 scope.
4. **Items tab:** each item's sources, quest and recipe uses, whether it has a description, plus orphan and no-story filters. Fixes J5-1. *UI-only for the table; needs engine data* for location and loot placement beyond the current links.
5. **Speaker identity and link fix, plus an Arc reading view:** key speakers by kind and id (Saint≠Doc), dedupe voice cards, infer screen and NPC links from the path, and render quest story inline across chains in unlock order. Fixes J3-1, J3-2, J3-3, J1-2 and J4-1. *Needs engine data* (adapter) for the identity and links part; the Arc view is *UI-only*.

Verdict: **FAIL** for the owner's narrative-dashboard intent. 3 blockers (J1-1, J2-1, J5-1) and 9 majors are open. This is by design for v1 (read-only checks), but jobs 1, 2 and 5 are not met.
