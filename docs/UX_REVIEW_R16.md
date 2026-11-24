# VibeSquad UX review, round 16: Normal mode B13 "living" restyle

Date: 2026-11-24 · Build: `unit-bor-b13-living` @ `d8fb4554`, `npx vite build`, `dist/` served statically on `:4291` (live `:4180` runs master).
Passes: 3200×1800 @ dsf 1.2 (owner 4K@120%) and 1920×1080, dark and light, `?demo=1`, `&riff=1`, `&idle=1`, `&crowd=1` (30 alerts). Driven with playwright-core + snap Chromium (script in `/tmp/pwtool`, not committed). Screenshots in `artifacts/ux-r16/` (untracked). 0 page errors in every pass. Reviewed by the UX Reviewer role from `docs/UX_REVIEW_PROCESS.md` §A, with no code edits.

**Verdict at `d8fb4554`: FAIL 0/1/4 (critical/major/minor).** One major, a B13 regression: the "Working now" strip claims an agent is working while it is blocked on a permission.

## Status vs R15

R15 reviewed context refs, not B13, so there is no like-for-like table. Nothing from R15 is touched by this branch. The R15 minor (Back after "Open in Inbox") stays queued to @bor and was not re-tested here.

## Drive log (jobs 1-5)

| Drive | Result |
|---|---|
| Open project A (Main Game Project), then B (VibeSquad) | Crumb follows (`Project › Overview`), URL `?team=` follows, exactly one `.on` project row. OK |
| Ctrl+J into another project | Opens Audit in VibeSquad. Crumb `VibeSquad › Desk › Worker`, one selected row, URL has `agent=`. OK |
| Open a Needs-you item (Review, Lead 75) | Crumb, selected row and open chat agree each time. OK |
| Deep link `?agent=demo-aud` | Cold load lands on the right project and chat, 1 selected row. OK |
| Two projects expanded | Both use one shape: Desk 3-tile grid, then `LANES`. OK. Caption truncation: m1 |
| Open a worker (Desk list and Workers dock) | OK. Highlight is subtle: m4 |
| 10+ alerts (`&crowd=1`, 30) | Header 30 = Main Game 1 + VibeSquad 29. 5 rows plus "25 more". Counts agree. OK |
| Permission card Allow / Deny… | Renders warm and legible in both themes. The demo has no backend, so a click doesn't resolve and the result couldn't be verified. Not a defect |

## Invariants

- **Counts agree:** pass in all variants (5 = 1+4, 4 = 1+3, 6 = 1+5, 30 = 1+29). Each project badge equals its Desk badge plus lane badges.
- **One selected row:** pass in all 11 steps.
- **Crumb = row = agent:** pass.
- **Expanded projects share one shape:** pass.
- **No agent more than twice in the sidebar:** pass. Worst case is Needs you + Desk list, and a third copy in the Workers dock (a separate panel).
- **Contrast ≥ 4.5:1, scripted over every visible text node (1920, overview + worker):** dark has 1 failure (`Allow`, 3.52:1, m2). Light has 1 failure (`exit` badge, 4.46:1, m5). The new B13 light tokens pass everywhere else.
- **Nothing that explains WHY is truncated:** pass for reasons. Names, project suffixes and tile captions are truncated (m1, m3).

## Findings

### Major

#### M1 · "Working now" says the agent is working while it waits on a permission (B13 regression)
- **Job hurt:** job 2 (monitor) and job 3 (respond). The top-of-chat focal element, in warm "busy" styling, reads "Audit - token scout is running Bash" while the card right under it says "Needs your OK · Bash: rg --stats". A tool that is open and waiting for approval is the normal shape of every permission request, so this is the common attention state, not an edge case. It reads as "all fine, it's working".
- **Evidence:** `dark-3200-a-11-deeplink.png`, `dark-3200-perm-deny-open.png`. `light-1920-idle-worker.png` shows "is running sub-agents" over a pending "pick option A or B" banner.
- **Cause:** `src/BoringWorkingNow.tsx:15-19` `workingActivity()` has no permission or needs-you branch. `busy = rows.length > 0 || subs > 0` (line 47) skips the `idleActivity()` branch (lines 22-24, "needs your OK") whenever the agent is running or has a sub-agent call. The strip is also always styled `data-state="busy"` (`src/boring.css:1351`).
- **Fix:** when the open agent has `pendingPermissions` or an attention reason of permission/needs-you, use state `blocked`. Headline "Audit - token scout needs your OK", label "Needs you" in `--st-attn` instead of "Working now", no pulse. Keep the "running" copy only when nothing is awaiting.
- **Files:** `src/BoringWorkingNow.tsx`, `src/boring.css:1350-1360`. **Effort:** XS.

### Minor

- **m1 · Desk tile captions truncate at 1920 (B13).** "idle · just no…", "idle · 12m a…" lose the time, and worker names in the Desk list lose their distinguishing suffix ("Review - Sonnet · d…", "Review - Gemini · re…"). At 3200 they fit. Evidence: `light-1920-idle-worker.png`. Cause: `.boring-mate-cap` is `nowrap; ellipsis` at 11px (`src/boring.css:1329`) in 3 equal tiles. Fix: shorten to "idle 12m" and drop "just now" to "now", or allow 2 lines. Files: `src/BoringAde.tsx:805` and `src/boring.css:1329`. Effort: XS.
- **m2 · `Allow` button text 3.52:1 in dark (pre-existing).** White on `#9b72e8`. `.boring-needs-btn.ok` uses `color:#fff` at `src/boring.css:927` (same on master, line 925). `--on-accent` (`#14111c` dark, `#fff` light) already exists, so use it: ≈ 6:1. Primary action of job 3. Effort: XS.
- **m3 · Needs-you rows at 1920 truncate the title and drop the project.** "Review - Sonnet · dra…" and "Desk · VibeSquad" shrinks to "Desk" (`light-1920-idle-worker.png`). In a cross-project list that loses where the item lives. Likely pre-existing layout. Fix: let the project wrap onto the reason line, or elide the title first. Effort: S.
- **m4 · Selection is faint beside attention tints (B13).** The selected Desk worker row's left bar is the only cue and its fill matches the amber/red attention tint on the unselected rows, so in `dark-3200-a-11-deeplink.png` "Lead" (unselected, tinted) looks as selected as "Audit". The matching Needs-you row for the open agent isn't marked at all. Fix: add a 2px `--accent` rule plus `aria-current` to the selected row and its Needs-you twin. Files: `src/boring.css` (desk rows), `src/BoringAde.tsx`. Effort: S.
- **m5 · `exit 2` badge 4.46:1 in light.** Nearly there; `.tl-exit-badge.err` needs a slightly darker text token. Pre-existing. Effort: XS.
- **m6 · Working-now strip and permission card don't share the message column (B13).** At 3200 with the dock open the strip spans 844-1393 and the card 882-1356, while the messages sit at 700-1250. They are centred on the page, not on the timeline. Cause: `BoringWorkingNow` and `PermissionCard` are siblings outside the timeline column (`src/AgentDrawer.tsx:654-657`) and `.boring-now` centres itself with `margin: auto` (`src/boring.css:1350`). Fix: render inside the column wrapper or use the same `--measure-col` container. Effort: S.

## Regressions vs pre-existing

- **B13-introduced:** M1, m1, m4, m6.
- **Pre-existing:** m2 (`boring.css:927` same on master), m3, m5.
- **Fixture, not a defect:** the demo lead's title is the literal "★ MAIN GAME ord75" (`src/demo.tsx:96`), so the strip and message name read "MAIN GAME ord75". Real names go through `agentDisplayName`. The "Main Game" badge "1" moves onto the lane row when expanded and disappears while that lane is open (counts still sum). That follows the existing design.

## Owner decisions

1. **Blocked wording in the strip (M1).** Recommend "needs your OK" in the amber state, label "Needs you", and never "Working now". Option: keep "working" and add a warning chip. This is rejected because the headline still contradicts the card.
2. No other decisions. The visual restyle (graphite/alabaster, mascot grid, mini-avatars, 44px message avatars with Name · Role, warm permission card, light theme) reads coherently in both themes with no overflow or hscroll at either size.

## What passed

Fonts, tokens and living sky render in both themes. The Desk 3-tile grid is identical across expanded projects. Lane mini-avatars are present on every lane. Name · Role is present on messages. The permission card is warm and legible in both themes. The light theme is clean, with 1 contrast miss at 4.46:1. Counts stay consistent in demo, riff, idle and crowd.
