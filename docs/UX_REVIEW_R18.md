# VibeSquad UX review, round 18: Storybook view (SB5)

Date: 2026-11-24 · Build: `sb5-storybook-view` @ `7b6f95ab`, `npx vite build` into a scratch dir, served statically, `/api/storybook/**` mocked with Playwright `route()` to `test/fixtures/storybook/efi-mini.json` plus a stress copy (16-step Popper chain, 18 findings). Passes: 3200×1800 @ dsf 1.2 (owner 4K at 120%), 1920×1080, 390×844, dark and light, Normal and Psycho, `?demo=1`. 0 page errors in every pass. Screenshots: `docs/lanes/storybook/ux-r18/`. Reviewer role: `docs/UX_REVIEW_PROCESS.md` §A. No source edits.

**Verdict at `7b6f95ab`: FAIL 1/2/9 (critical/major/minor), plus 5 nits.**

## Status vs R17

R17 reviewed Bor19 permcol, a different area, so nothing carries over. SB5 is new and has no prior row.

## Drive log

| Drive | Result |
|---|---|
| Project ⋯ → Open Storybook (Main Game) | Opens full-window. The item is easy to find in the menu (`00-menu`). OK |
| Tabs Quest web → Locations → Characters → Findings | **Tab bar collapses to 10px on Characters at 1920×1080** (C1) |
| Hover a step chip / Mermaid node | The card opens with kind and `file:line`. OK |
| Keyboard Tab through the view | Reaches every chip, and focus opens the card. The card doesn't close on blur (m2) |
| Findings filters Broken / Missing | The toggle works and `aria-pressed` is set. Meaning isn't explained (m1) |
| Finding "→ quest step" link | Switches chain, no highlight of the target (m9) |
| Ctrl+J / Ctrl+K pick while in Storybook | **URL and selection change, the screen doesn't** (M1) |
| Browser Back | URL drops `team=`, Storybook stays open (M1, m8) |
| Refresh | POST fires. No visible result when the sha is the same (m7) |
| Project with no adapter (Site) | Dead end: "No Storybook for this project yet" (m6) |
| 18 findings / 16-step chain (stress) | Counts agree. Quest web unreadable (M2). Tab bar gone at 3200 too (C1) |
| 390 px | Tab strip overflows, header order odd (m4) |

## Invariants

- **Counts agree:** pass. Findings tab 3 = 0+1+0+2; stress 18 = 2+5+9+2. Chain and section counts match their rows.
- **Exactly one selected item per level:** pass (tabs, chain/location/character segment).
- **Header = what's shown:** **fail** after Ctrl+J/palette/browser Back. The title says "Main Game Project" while the URL is `?team=vibesquad&agent=demo-aud` (M1).
- **Expanded projects / agent duplicates:** N/A. The sidebar is hidden while Storybook is open, which is itself M1.
- **Contrast ≥ 4.5:1, scripted over every visible text node, 4 tabs × 2 themes × 2 sizes × 2 vibes:** one Storybook failure, the selected-tab count chip, 4.08:1 dark / 4.30:1 light (m5). `MERMAID` badge 1.36:1 is MermaidView (out of scope).
- **44 px targets:** pass for all Storybook buttons, chips, filters, links. `2 adapter warnings` summary is 32 px tall (inside m4/nit).
- **Nothing that explains WHY is truncated:** pass on desktop. Finding messages wrap fully (`stress-dark-3200-findings`).

## Findings

### Critical

#### C1 · The main tab bar collapses to ~10 px whenever the panel is taller than the window
- **Job hurt:** review output (job 4). Once it happens, the user can't get from Characters/Findings back to Quest web or Locations. The only visible trace is a purple hairline. Back closes Storybook entirely.
- **Evidence:** `ux-r18/collapse-dark-1920-characters.png` (1920×1080, Characters tab: `.sb-tabs` clientHeight 10, scrollHeight 54). `ux-r18/stress-dark-3200-findings.png` (owner's 3200×1800, 18 findings: same). `ux-r18/stress-light-1920-popper.png` (Quest web itself, 16-step chain). With the real EFI snapshot (3948 entities) nearly every panel is taller than the window, so on real data this is the normal state, not an edge case.
- **This is the "scroll offset after a tab switch" the author saw.** Keyboard focus on a clipped tab scrolls the 10 px strip internally (`scrollTop` 27 after Tab), so the tabs look half-scrolled.
- **Cause:** `.sb-root` is a `100dvh` flex column with `overflow:auto` (`src/storybook.css:16-17`). `.sb-tabs` has `overflow-x:auto` (`src/storybook.css:41`), which makes its automatic min-height 0, so flex-shrink squeezes it when `.sb-body` is tall.
- **Fix:** `.sb-root > * { flex-shrink: 0; }` (or `.sb-tabs { flex-shrink: 0 }` plus the head/notice/warn). Optionally make the tab bar `position: sticky; top: 0` so it stays reachable on long panels. Add a test: Characters tab, `.sb-tabs.clientHeight >= 44`.
- **Files:** `src/storybook.css` · **Effort:** XS

### Major

#### M1 · Storybook takes over the window and silently swallows navigation
- **Job hurt:** respond when something needs me (3) and intervene (5). While Storybook is open, the Needs-you list and its count are gone. Ctrl+J and Ctrl+K → agent change the selection and URL behind the view, but the screen keeps showing Storybook, so the key appears to do nothing. Browser Back does the same.
- **Evidence:** `ux-r18/nav-ctrlj.png` was taken after Ctrl+J; the URL went from `?demo=1&team=efi` to `&agent=demo-aud`, and the screen is unchanged. After a palette pick the URL is `?team=vibesquad&agent=demo-aud` while the header still reads "Storybook · Main Game Project". After Browser Back the URL is `?demo=1` and Storybook is still open.
- **Cause:** `src/App.tsx:2005` returns `<StorybookHost/>` instead of the whole cockpit, yet still mounts `{overlays}` (palette, keymap), which navigate state nobody can see. `closeStorybook()` is only called from Back.
- **Fix:** (a) call `closeStorybook()` from `onTeam` / `selectAgent` / the Ctrl+J handler / `popstate`, so navigating out of Storybook actually leaves it. (b) Until Code|Storybook tabs land, put a Needs-you count pill in `.sb-head` that runs Ctrl+J. It needs no new chrome beyond one pill.
- **Files:** `src/App.tsx`, `src/StorybookView.tsx` · **Effort:** S

#### M2 · The quest web is unreadable for any chain longer than ~5 steps
- **Job hurt:** review output (4). The headline view of SB5. A 16-step chain renders as a ~40 px-tall strip of unreadable boxes at 1920 (`ux-r18/stress-light-1920-popper.png`). The user has to hit `+` several times and pan sideways. The Steps list below carries the same data and is readable, which is the only reason this isn't critical.
- **Cause:** `chainToMermaid` emits `flowchart LR` (`src/storybookLogic.ts:210`), and MermaidView fits to width.
- **Fix:** use `flowchart TD` (or LR with a wrap every N ranks) when a chain has more than ~5 steps. Size the graph box to the content height, not 240 px. **Check against the EFI snapshot:** if real trader chains are ≤6 steps, downgrade this to minor.
- **Files:** `src/storybookLogic.ts` · **Effort:** S

### Minor

- **m1 · Nobody can learn what Broken / Inconsistent / Missing mean, or what "#2" is.** The filter buttons have no `title` or description, and there's no legend. Each finding shows a bare check id (`#2`, `#7`). The plan named in `src/StorybookView.tsx:1` (`docs/PLAN_STORYBOOK_V1.md`) isn't on the branch, and the mapping exists only in code (`src/storybookLogic.ts:61-71`). The finding message itself does explain the specific problem, which keeps this minor. **Fix:** a one-line description per category as `title` plus a small legend under the filter bar ("Broken: a reference points at nothing…"). Replace `#n` with a short check name (keep `#n` in the title). `ux-r18/boring-dark-1920-02-findings.png` · XS–S
- **m2 · The keyboard-opened card never closes on blur.** Tabbing from the last chip to Back/Refresh/tabs leaves the card floating over the panel (`ux-r18/inter-kbd.png`: the Locations tab is focused and the Workshop card is still open). The chip has `onFocus` but no `onBlur` (`src/StorybookView.tsx:113`). **Fix:** `onBlur` → hide unless focus moves into the popover. · XS
- **m3 · 1100 px column on the owner's screen.** At 3200×1800 two-thirds of the window is empty and meta text is 12 px (`ux-r18/boring-light-3200-m-findings.png`, `stress-dark-3200-findings.png`). `.sb-body { max-width: 1100px }` (`src/storybook.css:45`). **Fix:** widen to ~1600 at ≥2000 px, or give the node card a docked side panel there instead of a popover. · S
- **m4 · Phone width (390).** The tab strip overflows: Findings sits at x 447 > 390 with no scroll affordance, so the most important tab is off-screen. The header stacks Back / sha+Refresh above the title (`ux-r18/phone-dark-390-quests.png`, `phone-dark-390-findings-after-switch.png`). `2 adapter warnings` is 32 px tall. **Fix:** let tabs wrap or shrink padding under 600 px. Put the title on the first row and the sha below it. `min-height: 44px` on the summary. (The phone-shell entry itself is out of scope, F3.) · S
- **m5 · Selected-tab count chip below 4.5:1:** 4.08 dark, 4.30 light, 12 px (`.sb-count` on accent, `src/storybook.css:44`). **Fix:** use `--sb-on-accent` at full opacity on a darker chip bg, or drop the tinted bg on selected. · XS
- **m6 · "Open Storybook" is offered on every project**, and projects without an adapter land on a bare "No Storybook for this project yet" with no next step (`ux-r18/nostorybook-light.png`). `src/CommandPalette.tsx:327`. See Owner decision 2. · XS
- **m7 · Refresh gives no visible result** when the sha doesn't change (`ux-r18/refresh-after.png`): no "up to date", no checked time. **Fix:** a short status next to the sha ("up to date · checked 9:14 AM"). · XS
- **m8 · Storybook isn't in the URL.** Reload or a shared link loses it, and Browser Back changes hidden state (part of M1). **Fix:** `&view=storybook` in the URL, popstate closes it. · S
- **m9 · A finding's "→ quest step" link** switches to the right chain but doesn't scroll to, focus, or highlight the target step (`ux-r18/inter-link-jump.png`). **Fix:** scroll into view, focus the chip (which also opens its card), and flash it. · XS

### Nits

- Lore and vibe text shows raw Markdown (`**Setting:**`, backticks) (`ux-r18/boring-dark-1920-02-locations.png`).
- In Locations, the quest chip uses the trader id ("popper #2 Dock Runs") where every other view says "Popper" (`src/StorybookView.tsx:171`).
- The Characters segment mixes display names with lowercase ids (`narrator`, `actor`, `squad`) and lists 0-line speakers (`Saint 0`, `System 0`).
- Consistency with Normal: Storybook uses square boxed tabs and filter buttons, while Normal's Overview uses pill tabs (`00-menu` vs `01-quests`). The rest (tokens, type, focus ring) matches.
- The dashed "Card" button label is vague. "Open card" or an ⓘ with an aria-label reads better. The dashed border on every chip reads as a "drop zone" rather than "hover for details".

## What works

The ⋯ entry is easy to find, and Back returns cleanly. The hover card shows kind and `file:line` and is placed inside the viewport on desktop. Every Storybook control meets 44 px. Text contrast passes everywhere except m5, in both themes and both vibes. Counts agree across tab, filter and list. Mermaid nodes and step chips open the same card, so the graph has a keyboard path through the Steps list.

## Owner decisions

1. **Should Storybook keep an attention signal while it's open, before the Code|Storybook tabs land?** Recommendation: yes. Put a Needs-you count pill in the Storybook header that runs Ctrl+J, and close Storybook on any navigation (M1). It's one pill, not new chrome, so it stays within the agreed "no header chrome" placement.
2. **Show "Open Storybook" only for projects with an adapter?** Recommendation: hide it when `/api/storybook/:id` returns 404 (or there's no adapter registered), instead of offering a dead end.

## Inbox cards for @storybook

C1 (`storybook.css` flex-shrink, XS), M1 (close on navigation + needs-you pill, S), M2 (TD layout for long chains, S), then m1–m9 as one polish card.
