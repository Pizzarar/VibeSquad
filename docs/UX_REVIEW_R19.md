# VibeSquad UX review, round 19: Storybook view (SB5) re-review

Date: 2026-11-24 · Build: `sb5-storybook-view` @ `9ff20530` (fixes on `7b6f95ab`). `npx vite build` went into a scratch dir outside the repo and was served statically. `/api/storybook/**` was mocked with Playwright `route()`, using the same approach as R18: `test/fixtures/storybook/efi-mini.json` plus the R18 stress copy (16-step Popper chain, 18 findings). For the m6 check, every other project returned 404. Passes: 3200×1800 @ dsf 1.2 (the owner's 4K at 120%), 1920×1080, and 390×844 @ dsf 3, in dark and light, Normal and Psycho, all with `?demo=1`. There were 0 page errors in every pass. Screenshots are in `docs/lanes/storybook/ux-r19/`. No source edits.

**Verdict at `9ff20530`: FAIL 0/2/2 (critical/major/minor), plus 4 nits.** C1 and M2 are fixed. M1 is mostly fixed, but palette picks are still swallowed in Normal. A new major: Esc inside Storybook changes hidden state, and Back then takes 3 clicks.

## Status vs R18

| R18 | Status | Evidence |
|---|---|---|
| **C1** tab bar collapses | **Fixed** | `.sb-tabs` is 54 px tall on every tab in all 6 runs (Normal/Psycho × dark/light × 1920/3200, mini + stress). It is also sticky: scrolled to the bottom of 18 findings, the tabs sit at `top 0` (`c1-m3-stress-dark-3200-findings-scrolled.png`, `c1-dark-1920-characters-scrolled.png`). |
| **M1** navigation swallowed | **Partly fixed, still open (major, narrower)** | Fixed: Ctrl+J (Normal and Psycho) leaves Storybook and opens `demo-aud` (`m1-ctrlj.png`). The new `5 need you` pill matches the cockpit count of 5, is 44 px tall, and opens the same item (`m1-needs-you-pill.png`). Storybook Back and Browser Back both close it. Psycho palette picks leave Storybook (`m1-palette-psycho-ok.png`). **Still open:** in Normal, a Ctrl+K pick of an agent or a squad does nothing visible. See M1 below. |
| **M2** long chain unreadable | **Fixed** | The 16-step chain now lays out top-down. At 100% the nodes are legible, and the graph box scrolls (`m2-stress-light-1920-popper.png`, `m2-psycho-light-3200-popper.png`). Edge labels overlap once (nit). |
| m1 category meaning / `#2` | **Fixed** | Each filter has a `title`, and a legend under the filters explains all 4 categories. `#2` now reads "dangling reference", with `Check #2` in the title (`m1-findings-legend.png`). |
| m2 card stays open on blur | **Fixed** | Focusing the Workshop chip opens its card. After Tab, the card is gone (`m2-blur.png`). |
| m3 1100 px column on 4K | **Fixed** | At 3200 the column is about 1600 CSS px wide, and the meta text is 14 px (`c1-m3-stress-dark-3200-findings-scrolled.png`). |
| m4 phone 390 | **Fixed** | Tabs wrap (Findings moves to row 2 at x 10–115, and the doc is 390 wide). Back and the title share row 1. The warnings summary is 44 px (`m4-phone-dark.png`, `m4-phone-light-findings.png`). |
| m5 selected count chip contrast | **Fixed** | 5.30:1 dark and 6.00:1 light, in both Normal and Psycho. |
| m6 dead-end "Open Storybook" | **Partly fixed, still open (minor)** | The no-adapter page now says what's missing and who to ask (`m6-none.png`). But the first time a 404 project's ⋯ menu opens, it still offers "Open Storybook" (`m6-menu-first-open.png`). The item hides only from the second open on (`m6-menu-second-open.png`). |
| m7 Refresh gives no result | **Fixed** | "Up to date · checked 6:39 PM" now appears next to the sha (`m7-refresh.png`). |
| m8 not in URL | **Fixed** | `?sb=efi` is written on open and survives a reload, and Back/Forward follow it. One side effect is new minor N1 below (raw id after reload). |
| m9 jump doesn't highlight | **Fixed** | Finding → quest step switches to the Popper chain. "2. Dock Runs" is in view, focused, and flashing (`m9-jump.png`). |
| Nits (markdown, trader id, lowercase ids, 0-line speakers, dashed chips, "Card") | **Fixed** | Lore shows "• Setting: …" without `**`. The Locations chip reads "Popper #2 Dock Runs". Characters reads "Narrator 3 · Actor 1 · Squad 1 · Saint · System". Chips have solid borders, and the button says "Open card" (`nits-locations.png`, `nits-characters.png`). |
| Nit: square vs pill tabs | Not addressed | This one is a style call, so I'm leaving it as is. |

## Invariants

- **Counts agree:** pass. Findings 3 on the mini fixture and 18 on stress. The pill count matches the cockpit's `boring-needs-you-count` (5).
- **Exactly one selected item per level:** pass.
- **Header = what's shown:** **fail** in Normal after a palette pick (M1). It also fails after Esc, where the URL says `view=squads` behind the Storybook screen (M3). After a reload the header shows the raw id instead of the project name (N1).
- **Contrast ≥ 4.5:1 / 44 px targets:** pass, including the new pill, legend and status.
- **Nothing that explains WHY is truncated:** pass. Finding messages wrap, and the legend is full text.

## App.tsx hunk (freeze exception: additive only)

`git diff 7b6f95ab 9ff20530 -- src/App.tsx` adds 4 things:
1. An import.
2. `closeStorybook()` in `openTopNeedsYou` (`src/App.tsx:1390`).
3. The `sbNav` effect on `activeTeamId|urlAgentId` (`src/App.tsx:1850-1854`).
4. The `needsYou` / `onNeedsYou` props on `<StorybookHost/>` (`src/App.tsx:2012`).

`closeStorybook()` returns at once when no Storybook is open (`src/StorybookView.tsx:36-37`), so items 2 and 3 do nothing outside Storybook. Item 4 is computed only inside the Storybook branch. I also checked this in the browser: Ctrl+J from the cockpit (no Storybook) produces the same URL and screen as before. **Pass: additive, no behaviour outside the Storybook view.**

Two notes, neither attributed to this hunk:
- The Browser Back sequence after Ctrl+J leaves the URL and screen out of step **in the cockpit too, with Storybook never opened**. It's pre-existing and outside this unit.
- The new module-level `popstate` listener and the `?sb=` read on load live in `StorybookView.tsx`, not App.tsx. They act only when `?sb` is present or Storybook is open.

## Findings

### Major

#### M1 (R18, still open) · In Normal, a Ctrl+K pick of an agent or squad is swallowed while Storybook is open
- **Job hurt:** intervene (5) and switch project (2). The owner presses Ctrl+K, picks "Audit – token scout" or the "VibeSquad" squad, and the palette closes, but the URL and screen don't change (`m1-palette-swallowed-normal.png`). The pick is stored in hidden state: pressing Back afterwards lands on the Audit agent, not where the owner came from. Psycho is fine, and Ctrl+J and the pill are fine.
- **Cause:** in Normal, the URL agent is derived from BoringApp's shown agent (`src/App.tsx:1844`). BoringApp isn't mounted during the Storybook takeover, so `activeTeamId|urlAgentId` never changes and the new `sbNav` effect (`src/App.tsx:1850`) never fires. The palette's `onPaletteAgent` → `onAgent` (`src/App.tsx:1925`, `1748`) and `onTeam` (`1677`) don't call `closeStorybook()` themselves.
- **Fix:** call `closeStorybook()` at the top of `onAgent` and `onTeam`, the same way `openTopNeedsYou` does. Add a test: Normal, Storybook open, palette agent pick → `storybook-view` gone and `agent=` in the URL.
- **Files:** `src/App.tsx` · **Effort:** XS

#### M3 (new) · Esc inside Storybook changes hidden state, then Back takes 3 clicks
- **Job hurt:** leaving Storybook (every job). Esc is the reflex "leave" key. In Storybook it does nothing visible, but it pushes `view=squads` behind the view. After that, Storybook Back appears dead twice: the first click goes to `?sb=efi&team=efi` and Storybook stays, the second click does the same, and only the third leaves (`new-esc-back-stuck.png`). Run log: `after Esc ?sb=efi&view=squads&team=efi | SB` → `Back 1 ?sb=efi&team=efi | SB` → `Back 2 ?team=efi&sb=efi | SB` → `Back 3 ?team=efi | cockpit`. Any other history push made while Storybook is open has the same trap.
- **Cause:**
  - The Squads-Home Esc handler (`src/App.tsx:1856-1866`) still runs during the takeover. Its guard checks for `.modal-back`/`[role=dialog]`, not Storybook.
  - `closeStorybook()` uses `history.back()` whenever it pushed an entry (`src/StorybookView.tsx:38`). That assumes Storybook's entry is still on top. Once anything else has pushed, `back()` lands on Storybook's own entry, and the `popstate` handler keeps it open.
- **Fix:**
  - (a) Make Esc in Storybook mean Back: handle `keydown` Escape on `.sb-root` (when no card is open) → `closeStorybook()` and `preventDefault`, so the Squads-Home handler skips it.
  - (b) In `closeStorybook()`, call `history.back()` only while `history.state?.sb` is our entry on top. Otherwise use `replaceState` to strip `sb` and close.
- **Files:** `src/StorybookView.tsx`, optionally `src/App.tsx` (the guard) · **Effort:** S

### Minor

- **m6 (R18, still open) · A 404 project still offers "Open Storybook" the first time its menu opens.** `probeStorybook` starts the fetch while the menu is being built and returns `false` until the fetch resolves (`src/StorybookView.tsx:58-64`), so the first open shows the item and the next ones hide it (`m6-menu-first-open.png` vs `m6-menu-second-open.png`). The landing page now explains itself, which keeps this minor. **Fix:** run the probe for all projects once the views load (or keep it in the views payload), so the menu is right on first open. · XS
- **N1 (new) · After a reload, a shared `?sb=` link, or a Psycho URL open, the header reads "Storybook · efi" (the raw project id).** It should read "Main Game Project" (`new-reload-raw-id.png`, `m4-phone-dark.png`). `target = { projectId: id0, name: id0 }` (`src/StorybookView.tsx:45`). **Fix:** have `StorybookHost` resolve the name from `views` (team name by id) and fall back to the id. · XS

### Nits

- After a finding → quest-step jump, the mouse is still where the link was, so it hovers whatever lands under it. In `m9-jump.png` the "Spent Brass" hover card opens over the graph while focus and the flash are on "2. Dock Runs". A short hover suppression after `goTo` would avoid the wrong card.
- In the TD layout, the step-2 edge labels "targets enemy" and "at location" overlap ("targets ener at location", `m2-stress-light-1920-popper.png`).
- `probeStorybook` does a full snapshot `GET` just to learn the status. With the real EFI snapshot (3948 entities) that's a heavy request per project. A HEAD request or a list of registered adapters would be cheaper.
- The MermaidView canvas stays dark in the light theme. That belongs to the shared MermaidView, not this unit.

## What works

C1 is properly fixed: the tab bar is sticky and 54 px everywhere, so the user can always switch tabs on real-size data. The quest web is readable on long chains. The Needs-you pill puts the attention signal back with one control, and its count agrees with the cockpit. Ctrl+J, the pill, Storybook Back and Browser Back all leave cleanly. Reload keeps you in Storybook. The legend and check names make Findings self-explanatory. Refresh always shows a result. The jump-to-step lands, focuses and flashes the step. Phone layout works, and contrast and target sizes pass everywhere I checked.

## Owner decisions

1. **What should Esc do in Storybook?** Recommendation: Esc = Back (leave Storybook). It's the reflex everywhere else in the app, and it removes the hidden Squads-Home push (M3).

## Inbox cards for @storybook

M1 (`closeStorybook()` in `onAgent`/`onTeam`, XS), M3 (Esc = Back + `closeStorybook` history guard, S), then m6 + N1 + nits as one polish card.
