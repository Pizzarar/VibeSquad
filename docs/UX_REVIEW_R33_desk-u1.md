# VibeSquad UX review, round 33: @desk U1, slot and tab keys in the Normal URL

Date: 2026-11-25 · Build: `desk-u1-url-keys` @ `304366f4` · Compared against: `cfb2e88c` (U1's parent: B2 merge + @bor B16), built from `git archive` · Previous round on this area: `docs/UX_REVIEW_R31_desk-b2.md` (B2, PASS 0/0/1) · Plan: `docs/PLAN_DESK_URL_COMPLETE.md` U1 (read after the first pass).

**Verdict: FAIL 0/1/2** (0 critical, 1 major, 2 minor)

The two new keys work. `?slot=` and `?tab=` restore on Back, Forward and reload in every sequence I drove. The tab resets when you switch project, Back brings back the previous project's tab, Open in Inbox lands on `tab=inbox`, and the B2 one-entry rule still holds. The fail is a side effect on **Storybook**:
- Opening Storybook now adds **2** history entries.
- Esc no longer goes back.
- After closing Storybook, Back reopens it, and the second Back press does nothing.

The cause is one line of U1 (M1).

## Setup
- **Builds:** `npx vite build` of the worktree at `304366f4` (HEAD checked before and after the build), and of `cfb2e88c` from a `git archive` export. No checkout, no source edits.
- **Server:** the R31 static harness (`/api` and `/ws` 404, `?demo=` cast). Its init script logs every `pushState`, `replaceState`, `back` and `POP`.
- **Configs:** 1920×1080 @1 and 3200×1800 @1.2 (the owner's 4K at 120%), dark and light. All four U1 logs are identical apart from the theme name (`diff`). 0 page errors in every run.
- **Driver:** `docs/ux-review-r33/drive/u1.mjs`, 9 sequences plus 19 hand-typed URLs. Extra checks: `canon.mjs` (fresh loads of valid URLs), `ctrlj.mjs`, and the R31 `b2.mjs` (7 B2 routes) re-run on U1.

## Status vs R31 / U1 done-check

| Check | Base `cfb2e88c` | U1 `304366f4` | Evidence |
|---|---|---|---|
| **R31 m1: empty Desk slot.** efi Overlord, then efi RiffBot, from the Audit chat | URL `?team=efi`. Forward and reload showed the Overview | **Fixed.** Each tile pushes one entry: `&slot=overlord`, then `&slot=riffbot`. Back, Back, Forward and Forward walk RiffBot → Overlord → Audit chat → Overlord → RiffBot. Reloading either URL shows the same card, crumb and selected tile. | `logs/u1-*.log` `slot-efi`; `dark-1920-slot-efi-overlord.png`, `light-3200-slot-efi-overlord.png` |
| VibeSquad **Bugs** tile (no agent) | Overview on reload | **Pass.** `&slot=bugs`, card + `VibeSquad › Bugs › Brainstorm`, one `.on` tile. Back, Forward and reload all match. | `slot-bugs`; `dark-1920-slot-bugs.png` |
| **Tabs:** Inbox, then Standup, then Back, Back, Forward, Forward, reload | No URL key | **Pass.** One push per tab change, and none when you click the tab you're already on. Back and Forward walk inbox ↔ overview ↔ standup, and reload matches. Clicking Overview pushes `?team=vibesquad`, and Back returns to Standup. | `tabs`; `dark-1920-tab-inbox.png`, `light-1920-tab-inbox.png`, `dark-3200-tab-standup.png` |
| **Project switch:** VibeSquad Inbox → efi row → efi Standup → VibeSquad row, then Back ×3 | n/a | **Pass.** efi opens on Overview (the tab resets). VibeSquad row → Overview (resets again). Back walks efi Standup → efi Overview → **VibeSquad Inbox**. Forward and reload match. | `proj-switch`; `dark-1920-proj-switch-{efi,back}.png` |
| **Ctrl+K agent pick from a tab** (cross-project and same-project) | n/a | **Pass.** `dLen=1`, one push, no mixed entry. Back returns to the tab (Inbox or Standup), Back #2 reaches the Overview, and Forward ×2 mirrors it. | `ctrlk`, `ctrlk-same`; `dark-1920-ctrlk-back.png` |
| Ctrl+J and a Needs-you row from efi Standup, Back ×3 | n/a | **Pass.** Every press is live, and Back #2 lands on efi Standup. | `logs/ctrlj-u1.log` |
| **Open in Inbox** (`idea-729` ref popover in the Audit chat) | Inbox shown, URL `?team=vibesquad` | **Pass.** Lands on `tab=inbox` with `dLen=1`. Back returns to the chat, Forward to the Inbox. | `open-in-inbox`; `dark-1920-ref-popover.png`, `dark-1920-open-in-inbox.png` |
| **Unknown or conflicting values** (`tab=bogus\|feed\|overview\|INBOX`, `slot=bogus\|lead\|brainstorm`, `slot+tab`, `tab+agent`, `slot+agent`, a duplicate `tab`) | Kept in the URL, Overview shown | **Pass.** They fall back to the Overview, and the junk key is dropped from the URL. Agent beats slot, and slot beats tab. `slot=overlord` on a project whose Overlord is running opens that Overlord's chat (`agent=demo-lead-vs`). | `unknown …` blocks |
| Valid U1 URLs on a fresh load | n/a | **Pass.** No history write (`len=2`) for `tab=inbox`, `tab=standup`, `slot=overlord`, `slot=riffbot`, `slot=bugs`. | `logs/canon-u1.log` |
| **B2: +1 entry on the 7 routes** | pass | **Pass.** 6/6 forward routes and 4/4 reverse routes, plus the forward set again at light 3200. The reverse `proj-row` row prints FAIL only because the R31 script expects VibeSquad, but that route goes to Site (`crossProj`). Its behaviour is identical to base, and every real check is true. | `logs/b2-u1-*.log`, `logs/b2-base-dark-1920-rev.log` |
| **Storybook opened over a tab (and over the plain Overview), then Esc** | 1 push. Esc = `history.back()`. Back afterwards leaves Storybook behind | **Regressed → M1** | `storybook`, `storybook-ov`, `storybook-url` blocks; `logs/base-dark-1920.log` |
| Exactly one `.on` row; breadcrumb = selected row = screen = URL | pass | **Pass** at every step outside Storybook. The breadcrumb does not name the sub-tab (m1). | all logs |

## Findings

### Critical
None.

### Major

#### M1 · Storybook now pushes 2 history entries and Esc no longer goes back, so Back after closing Storybook reopens it and the next Back does nothing (regression)
- **Job hurt:** 4, Review output (Storybook), and every job that uses Back afterwards. This is the brief's "no Back press does nothing" rule.
- **Evidence** (all 4 configs, `storybook-ov` block; the same happens over a tab and on a `?sb=` deep link):
  1. **Base** (`cfb2e88c`):
     - Opening Storybook makes 1 push: `?demo=&team=vibesquad&sb=vibesquad`.
     - Esc runs `back`, then `POP ?demo=&team=vibesquad`.
     - The next Back leaves Storybook behind.
  2. **U1**, opening Storybook makes 2 pushes for one action:
     - `pushState ?demo=&team=vibesquad&sb=vibesquad`
     - `pushState ?demo=&sb=vibesquad&team=vibesquad`
     - It is the same state with the keys in a different order (`len` 2 → 4).
  3. **U1, Esc:** `replaceState ?demo=&team=vibesquad`. The Storybook entries stay in history.
  4. **U1, Back:** `POP …&sb=vibesquad`. Storybook reopens, and a new `pushState` fires during the pop, which wipes Forward.
  5. **U1, Back #2:** `POP …&sb=vibesquad`. Storybook again, so the press does nothing visible.
  6. **U1, Forward:** Storybook. Only Back #3 reaches the Overview.
  7. Over a tab it is the same, and the tab itself survives Esc (`tab=inbox`): `dark-1920-storybook-over-inbox.png`, `dark-1920-storybook-esc.png`.
- **Cause:**
  1. When the Storybook takeover mounts, BoringApp unmounts and its cleanup clears the screen keys (`src/BoringAde.tsx:668`, `setBoringScreenKeys(undefined)`).
  2. `boringScreen` is new in the URL-sync effect's dependency list (`src/App.tsx:1890`), so the sync runs again.
  3. `serializeUrlState` deletes `team` and appends it again (`src/CommandPalette.tsx:51-64`), so `team` moves after `sb`.
  4. `urlSyncDecision` compares raw strings (`src/urlSync.ts:12`), sees a "different" URL and pushes it with `null` state.
  5. That push overwrites the `{sb}` state `openStorybook` wrote. `closeStorybook`'s `mine` check (`history.state?.sb === target.projectId`, `src/StorybookView.tsx:53`) now fails, so Esc falls into the `replaceState` branch (`:58`) instead of `history.back()` (`:57`).
- **Fix** (any one is enough; the first is the most robust):
  - (a) Make `urlSyncDecision` order-insensitive: compare sorted `URLSearchParams` and write nothing when they are equal.
  - (b) Have `serializeUrlState` keep the existing key positions (`p.set` on an existing key keeps its place; don't `delete` first).
  - (c) Skip the sync while Storybook is open (`storybookOpen`).
  - Add an e2e test: open Storybook, then `history.length` +1, Esc, then `history.length` unchanged and Back lands on the screen before Storybook.
  - This is separate from U2's idea-971 (Back into an *old* stale `?sb=` entry). U1 now creates that stale entry on every open, so U2 alone would hide the symptom but leave the extra entry.
- **Files:** `src/urlSync.ts`, `src/CommandPalette.tsx` (or `src/App.tsx`), plus the test.
- **Effort:** XS–S.
- **Lane:** @desk (coordinate with @storybook only if you choose fix (c)).

### Minor

#### m1 · The breadcrumb says "Overview" while the Idea Inbox or Standup tab is on screen
- **Job hurt:** 2, Monitor. Small.
- **Evidence:** on `?team=vibesquad&tab=inbox` the crumb reads `VibeSquad › Overview`, while the pill row shows `Idea Inbox (1)` as active (`light-1920-tab-inbox.png`). Now that the tab is part of the URL and a Back target, the breadcrumb no longer names the screen the URL names. "Overview" is both the page name and the first tab's name, which makes it ambiguous. This is pre-existing; U1 just makes the tab a navigation step.
- **Fix:** render the crumb as `VibeSquad › Idea Inbox` or `VibeSquad › Standup Feed` (pass `tab` to `boringBreadcrumb`). Or rename the first tab to "Lanes" so "Overview" names the page only.
- **Files:** `src/BoringAde.tsx` (crumbs ~line 688), `src/boring*.ts` breadcrumb helper.
- **Effort:** XS.
- **Lane:** @desk.

#### m2 · A hand-typed or stale URL that the app rewrites on first load pushes a second entry, so the first Back does nothing (pre-existing)
- **Job hurt:** 5, Intervene. It only hits pasted or bookmarked links.
- **Evidence:**
  - Loading `?demo=&team=vibesquad&tab=bogus` makes `pushState ?demo=&team=vibesquad`, and Back lands on the raw URL, which shows the same screen.
  - The base does the same for `?demo=`, `?team=nope`, `&foo=1` (reordered only) and `view=bogus` (`logs/base-dark-1920.log`, `unknown` blocks). U1 neither adds nor fixes it.
  - Valid U1 URLs do not push (`canon-u1.log`).
  - The same mechanism also gives `?team=efi&slot=overlord&agent=demo-aud` (team doesn't own the agent) two pushes, on base too.
- **Cause:** the first URL-sync run after mount pushes whenever the rewritten URL differs as a string (`src/urlSync.ts:12-17`, not pop-active, no first-run replace).
- **Fix:** replace instead of push on the sync's first write after load. Fix (a) of M1 already removes the reorder-only cases.
- **Files:** `src/App.tsx` URL sync / `src/urlSync.ts`.
- **Effort:** XS.
- **Lane:** @desk. Could join U2 (history edge races).

Not re-raised: the replace-only transient `team=<A>&agent=<B>` writes while a pop settles (B1, e.g. `ctrlk` back `replaceState ?demo=&team=vibesquad&agent=demo-lead-ui`). They never push and never show on screen. idea-971 and idea-983 are planned as U2.

## Spec questions
- The plan says "the tab resets on project change, except on the Open-in-Inbox path". As built, returning to a project by its row also resets the tab, while Back restores it. That's consistent and I'd keep it. I'm noting it only so the plan's text names both cases.

## Owner decisions
None.

## Artifacts
- **Drivers:** `docs/ux-review-r33/drive/`.
  - Start the server with `node serve.mjs <dist> <port>`.
  - `u1.mjs <port> <w> <h> <zoom> <theme> [shotdir] [session-prefix]` runs the main sequences; `canon.mjs <port>` and `ctrlj.mjs <port>` run the extra checks.
  - The B2 re-run used `docs/ux-review-r31/drive/b2.mjs`.
  - Use `TMPDIR=~/pwtmp`.
- **Logs:** `docs/ux-review-r33/logs/` (`u1-{dark,light}-{1920,3200}.log`, `base-dark-1920.log`, `canon-u1.log`, `ctrlj-u1.log`, `b2-*.log`).
- **Screenshots:** `docs/ux-review-r33/*.png`: all 12 dark-1920 steps, plus light-3200 and light-1920 samples.

**Verdict: FAIL 0/1/2**
