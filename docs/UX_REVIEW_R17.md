# UX review R17: idea-748 (Bor19), `9f2b063d`

Area: Working-now strip + permission card moved into `.boring-convo-col` beside the context panel (`src/AgentDrawer.tsx:530-559,684-696`, `src/boring.css:1369-1379`); card now `--measure-col` wide (`src/boring.css:884`). Previous round: `docs/UX_REVIEW_R16.md` (R16c n5, n6).

Method: `npx vite build`, served `dist` statically (headless Chromium, snap), `?demo=1&riff=1&team=vibesquad`: `&agent=demo-aud` (permission pending), `&agent=demo-aud&crowd=1`, `&agent=demo-impl-1` (no permission; `&idle=1` on demo-aud still has the permission, so demo-impl-1 is the permission-free case). Matrix: 1280x720, 1440x900, 1920x1080, 3200x1800 @ 1.2, dark and light, context panel open and closed (32 cells per scenario; rects via `getBoundingClientRect`). Master comparison built from `9f2b063d~1` (the running :4180 is a different build, so it was not used). Shots: `artifacts/ux-r17/` (untracked).

## Status vs R16c

| Item | Status | Evidence |
|---|---|---|
| n5 card narrower than strip/messages | **fixed** | strip and card share left/right edges in all 32 cells (e.g. 1920 closed: both 656-1536; 3200 open: both 1120-2000; 1280 open: 314-796). Messages' avatars sit on the same left edge (`perm-light-1920x1080-open.png`). |
| n6 panel pushed down/squeezed by strip+card | **fixed** | panel now spans y=92..623 at 1280x720 (was 402..623), 92..803 at 1440x900, 92..983 at 1920x1080, 92..1703 at 3200 (full column height, strip and card sit beside it). No-permission agent: panel starts at 124 (below the header row only). |
| No clipping / h-scroll | **holds** | `scrollWidth <= innerWidth` for `html` and `body` in all cells. |

## Checks

- **Alignment:** strip, card, messages, composer share one left edge at every width; panel tabs/Workers list visible beside a pending permission at 1280 open (`perm-dark-1280x720-open.png`).
- **Scrolling:** with a pending permission the strip and card are fixed above the timeline; scrolling the timeline to the bottom leaves the card at y=226 (stays reachable). Only the timeline scrolls (`scrollHeight 1338 / clientHeight 180` at 1280x720).
- **Keyboard:** Tab order reaches `perm-allow-btn`, `perm-allow-session`, `perm-deny-btn` (tab stops 77-79 from page load, all in viewport at 1280x720). The 76 preceding stops are sidebar and header controls (unchanged from master; see n7).
- **Psycho (`app.vibe=fun`, pending permission, 1280x720):** identical rects on the master build and the branch build (card 807,449-1267,567; shell 795,567-1279,646), no `.boring-convo-col`. Unchanged (`psycho-master-X.png`, `psycho-branch-X.png`).
- **Invariants (§A step 3):** this change touches layout inside one agent view only; counts, selected row and breadcrumb (Desk > Worker) unchanged and consistent in every shot. No agent listed more than twice. Nothing explaining WHY is truncated in the card.

## Findings

Verdict: **PASS 0/0/2** (critical/major/minor).

- **n7 (minor) · Several pending permissions on one agent eat the timeline and the third is clipped at 1280x720.** The strip and cards are `flex: none` inside a `.boring-convo-col` with `overflow: hidden`. With one permission the timeline gets 221px (about one message plus the Plan bar), which is acceptable and better than master (183px). Simulated by cloning the card: two permissions leave the timeline 33px tall; three leave 0px and the third card (602-778) runs past the column bottom (623), so its Allow/Deny are clipped with no scroll (`colScroll 686/531, overflow hidden`; `multiperm-branch-single.png`). Master with 3 cards: 0px timeline but all three fit (cards were squeezed to 124px, which clipped the "Tell the agent..." field; `multiperm-master-single.png`). Job hurt: respond to "needs you" when an agent raises parallel tool permissions. Fix: give the strip+cards a wrapper with `max-height: 55%` and `overflow-y: auto` (or collapse the Working-now strip to a one-line chip while a permission is pending). Files: `src/boring.css:1373-1379`. Effort: XS. Real daemon rarely has 3+ pending on one agent and the sidebar Needs-you Allow/Deny and Ctrl+J remain, hence minor; not verifiable against live data from the demo cast.
- **n8 (minor, spec question) · At 1280x720 a pending permission still leaves only ~220px for the conversation.** Strip (106px) + header "Needs you" card (88px) + permission card (176px) = 380px of the 531px column are fixed. Suggest the permission card header ("Audit - token scout needs your OK" big card, `boring-now-big`) not render in full when the permission card below already says it (it repeats the same fact twice). Question for the owner, not a defect.

Carried: m3, m5 (queued to @bug), n1, n2, n4 unchanged, out of area.

## Owner decisions

- n8: merge the big "needs your OK" strip card into the permission card header at <=720px height? Recommendation: yes, when a permission card is shown.
