FAIL 0/2/5 c77c5d71
- M1 src/BoringAde.tsx:987 + src/boring.css:1472 — the Main row's name is truncated to nothing
- M2 src/boring.css:1470 (+ :1231 tree min-height) — the expanded Main pin has a fixed 40% cap: it pushes the footer off-screen at 1080/720 and scrolls while space below it sits empty at 4K
- m1 src/boring.css:1477 — the hidden grip still takes up width, so with no Main every row shifts 12px from master
- m2 src/BoringAde.tsx:978 — the grip is role=button but has no tabIndex
- m3 phone 390×844 — no Main, order or reorder (the phone shell has no sidebar)
- m4 src/BoringAde.tsx:983 — the bust is always the RiffBot bust, whatever the project
- m5 src/boring.css:1470/1472 — a selected row inside the pin gets a double accent frame

# UX review R33: PLAN_PROJECT_ORDER O1+O2 (Normal sidebar), DRAFT

**Status: DRAFT.** The reviewer hit the context limit. `ui:clicks` and `ui:overlap` were **not run**, see "Left". The findings below come from direct measurement.

**Build:** `unit-ui-project-order` @ `c77c5d71`, vite dev on :5442. **Baseline:** merge-base `46897cb4` (`git archive` → /tmp/ux-po/master, vite on :5443).
**Setup:** the R26 harness (Playwright + Chromium, `?demo`). Non-GET `/api/teams` is stubbed, so nothing touched the registry. Viewports: 3200×1800@1.2, 1920×1080, 1280×720, dark and light; phone 390×844@3 with touch; 1280×800 with touch. 0 page errors. Drivers are in /tmp/ux-po/drv/ and shots in docs/ux-review-r33/.

## Gate summary
| Gate | Result |
|---|---|
| Compact by default / no massive scroll | **FAIL (M2).** At 1080 the expanded pin is 419px (38.8%) and the tree drops to its 120px minimum. The sidebar footer moves from y 986 to 1127, below the 1080 viewport. At 720, the footer is off-screen (780 > 720) even with the pin **collapsed**; master keeps it at 716. |
| Dim by colour, never opacity | PASS. Grip uses `--muted` with opacity 1. Open is `--text`; name and Open contrast are 13.3 (dark) and 13.4 (light). |
| Drag works with a mouse | PASS. Dragging VibeSquad after the site project gives `efi,vibesquad,site,team-9` → `efi,site,vibesquad,team-9`. The accent drop line (inset 2px) shows. Shot: 1080d-unit-drag-mid.png. Same result at 4K. |
| Keyboard reaches Move up/down | PASS. One Tab reaches ⋯, then Enter and 3× ArrowDown reach Move up; Enter reorders. Move up is disabled on the first row. The grip itself can't take focus (m2). |
| Main never hidden by folder collapse or scroll | PASS. A Main inside the Backlog folder stays pinned after the folder collapses. Scrolling the tree leaves the pin at y 572. The pin's header is sticky while it scrolls internally. When the whole sidebar scrolls (720/1080), the pin moves up but stays on screen. |
| No Main set = master | Behaviour PASS: same order, selection, breadcrumb and footer y. Layout changed: every project row is 12px further right and names are 12px narrower (m1). |
| Touch grip | On a touch desktop (1280×800, hasTouch) the grip shows after a tap. The tap also opens that project. Touch drag works (`site` dropped before `efi`). On a phone (390) there is **no sidebar**, so no grip, no ⋯ Move up/down and no Main. The phone project picker is the same as master and doesn't follow the order or Main (m3). |
| Invariants | Exactly one selected row in every sequence. Breadcrumb = selected row = open agent for Open, the Needs-you item, `?agent=` and Ctrl+J. The Main project is listed once: it's lifted out of the tree. The Needs-you count of 5 = Main badge 1 + VibeSquad 4. |
| Open button | Opens THAT project's Buddy: `team=efi`, breadcrumb "Escape From Idle › Desk › RiffBot". For the hub it gives `agent=demo-bs-vs`. Correct. |

## Findings

### M1 (major): the Main row's name is truncated to nothing. Jobs 2 (monitor) and 3.
Evidence (`.boring-project-name` width / full width):
- Collapsed and not active: 61/106px at 1080, 44px at 720.
- **Main = the active project** (always the case after Open, and the owner's VibeSquad case): **9px at 1080, 0px at 720, 6px at 1080** with VibeSquad as Main. The row reads "V ④ Open ⋯ +lane", and at 720 only the bust shows.
- 4K: 82 of ~130px.
- Shots: 1080d-unit-open.png, c-1080l-hub-main.png, 720-pin-trio.png.

Cause: the Main line packs these into a ~290px sidebar: grip-less chevron, dot, 28px bust (`BoringAde.tsx:983`), name, badge, a 59px Open button (`:987`), ⋯ forced to `opacity:1`, and `+ lane` when active (`boring.css:1472-1476`).
Fix: put the name on its own line (54px allows two lines: name above, Open/⋯ below or on the right), or drop `+ lane` and the status dot from the pin line, and keep at least ~12ch of the name. Files: BoringAde.tsx renderProject isMain branch, boring.css O2 block. Effort: S.

### M2 (major): the fixed 40% cap on the expanded pin fights the tree. Jobs 2 and 5 (Settings/Usage reach).
Evidence:
- **1080:** pin 419px + tree minimum 120px → footer y 1127 > 1080. Usage & workflows and Settings drop off-screen whenever Main is expanded, and opening any Main-project agent auto-expands it (Needs-you, `?agent=`).
- **720:** footer is off-screen even collapsed (780).
- **4K with VibeSquad as Main:** the pin caps at 707px while its content is 849px, so the lanes scroll. Below it, a 411px tree holds 3 collapsed rows and about 300px of empty space. The owner's main project gets **less** room than with no Main (master shows the whole 1126px tree). Shot: c-4kd-hub-ctrlj.png.
- Plan says "stays compact (one row), with no extra panel". The 40% scroll box is an extra panel.

Cause: `.boring-main-pin { flex:0 0 auto; max-height:40%; overflow-y:auto }` (`boring.css:1470`), together with `.boring-project-tree { min-height:120px }` (`boring.css:1231`).
Fix: share the space by content. Pin `flex:0 1 auto; min-height:56px; max-height:none` and tree `flex:1 1 auto; min-height:min-content` (or 64px), so the footer always fits; or cap the pin at `calc(100% - <tree rows>)`. Re-measure footer y at 720 and 1080. Effort: S–M.

### Minor
- **m1:** the grip reserves 14px even when hidden (`visibility:hidden`, `boring.css:1477`). With no Main, rows sit at x 49 vs 37 on master and names lose 12px. Fix: `width:0` until hover, or put the grip in the chevron gutter.
- **m2:** the grip is `role="button"` with no tabIndex (`BoringAde.tsx:978`). It's announced as a button that can't be reached, and its `:focus-visible` rule is dead. Fix: `aria-hidden` plus a pointer-only grip (⋯ is the keyboard path), or `tabIndex=0` with ArrowUp/Down.
- **m3:** at 390×844 the Normal phone shell has no sidebar. Main, Move up/down and drag don't exist, and the picker order ignores Main and the teams order (site dragged first and Main=IRL Flipper still list as Escape From Idle, VibeSquad, …). The brief's "phones get Move up/down in ⋯" doesn't hold. → Owner decision 1.
- **m4:** the Main bust is always `bustUrl("riffbot")` (`BoringAde.tsx:983`), the same image for every project. Plan says "the project's mascot/bust".
- **m5:** a selected row inside the pin draws its own accent left edge inside the pin's accent border, which looks like a double frame (720-pin-trio.png, middle).

### Pre-existing (not charged)
- The first mouse click on a ⋯ button that sits below the tree's scroll opens nothing, because the auto-scroll closes the menu. The second click and keyboard Enter both work. Same on master (`dots.mjs`: unit 0/7/7/7, master 0/4/4/4).

## Owner decisions
1. **Phone:** should the phone project picker honour Main (pinned first) and the order, and offer Move up/down? Recommendation: honour Main and the order in the picker (cheap); skip phone reorder.
2. **Expanded Main size:** should the Main pin size itself by content and take the space it needs, or stay capped? Recommendation: size by content (M2 fix), because the owner asked for VibeSquad "in all its glory".

## Left (not done)
- `npm run ui:clicks -- --vibe boring --surfaces boring-home,boring-lead,boring-brainstorm,boring-overview,boring-settings` (`--vibe boring` is required; without it the run reports 0 controls / FAIL in 1s).
- `npm run ui:overlap` on the unit and on master to sort out new hits vs the idea-945 list.

> Screenshots for this round are not committed: the full-size captures show real project names.
