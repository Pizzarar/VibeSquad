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

## r2 re-check (b138d29b)

Date: 2026-11-25 · Build: `desk-u1-url-keys` @ `b138d29b` (`npx vite build`, HEAD checked before and after, tree clean) · Same static harness and drivers as above. The R33 `u1.mjs`, `canon.mjs`, `ctrlj.mjs` and R31 `b2.mjs` were re-run unchanged. A new `drive/r2.mjs` covers the leak scenarios (Storybook then Ctrl+K to an agent / a team item, slot or tab then project rows, cold `?team=gone`, `?team=<non-first>&tab=`, Storybook over an Overview reached from a chat, Storybook over a chat).

**Verdict: PASS 0/0/2** (0 critical, 0 major, 2 minor: m2 carried to U2, plus new m3 in the same stale-entry path, also for U2)

The four configs (dark/light × 1920@1 / 3200@1.2) produce identical logs apart from the theme name (`diff`), for both `u1.mjs` and `r2.mjs`. There were 0 page errors in all 29 + 12 sessions per config.

### Status vs the first pass

| Item | `304366f4` | `b138d29b` | Evidence |
|---|---|---|---|
| **M1** Storybook +2 entries; Esc doesn't go back; Back reopens it | Open | **Closed.** Opening is 1 push (`len` 2→3). Esc runs `back` → `POP ?demo=&team=vibesquad`. The next Back leaves Storybook behind. This matches base `cfb2e88c` line for line (`storybook-ov` block, `base-dark-1920.log`). Over Inbox: Esc → `tab=inbox`, Back → Overview, Forward → Overview. | `logs/r2-u1-*.log` `storybook*`; `r2/dark-1920-storybook-esc.png`, `r2/light-3200-storybook-over-inbox.png` |
| `?sb=` deep link + tab | 1 extra push on load | **Better than base.** No write on load (`len=2`). Esc replaces to `…&tab=standup` and shows Standup Feed. | `storybook-url` |
| Storybook over an Overview reached from a chat (pre-existing SB5 close-on-open) | n/a | **Pass.** Storybook stays open (`dLen=1`). Esc → `?team=vibesquad` Overview; Back → Audit chat; Forward → Overview. Storybook over a chat: Esc → the chat; Back → Overview. | `logs/r2-leak-*.log` `sb over …`; `r2/*-r2-sb-from-chat.png` |
| **m1** breadcrumb says Overview on Inbox/Standup | Open | **Closed.** The crumb reads `VibeSquad › Idea Inbox` / `› Standup Feed` (and `Main Game Project › Standup Feed`, `Site › Idea Inbox`) at every step, including on Back/Forward/reload. It says `Overview` on the Overview tab. | `tabs`, `proj-switch`, `ctrlj`; `r2/dark-1920-tab-standup.png` |
| **Leak:** Storybook over vs Standup → Ctrl+K "Main Game squad team" | stale tab (Gemini Major 1) | **Fixed.** `?team=efi`, Overview tab, crumb `Main Game Project › Overview`. Storybook's entry is replaced (SB5 forward-nav close), so Back → vs Standup Feed. | `leak sb+ctrlk team`; `r2/light-3200-r2-leak-ctrlk-team.png` |
| Storybook over vs Inbox → Ctrl+K "UI Lab" (agent) / efi Overlord slot → Ctrl+K "VibeSquad squad team" | n/a | **Pass.** `?team=efi&agent=demo-lead-ui` chat / `?team=vibesquad` Overview, with no slot or tab carried. Back lands on the pre-Storybook screen (`tab=inbox` / `slot=overlord` card). | `leak sb+ctrlk agent`, `leak sb+ctrlk proj` |
| vs Standup → efi row → efi Overlord → vs row, Back ×3 | n/a | **Pass.** Each row lands on the Overview with no slot or tab. Back walks efi Overlord card → efi Overview → vs Standup Feed. | `leak rows` |
| **Cold** `?team=gone&tab=inbox`, `?team=gone&slot=overlord`, `?slot=overlord`, `?tab=inbox` | `slot`/`tab` applied to the fallback project (efi card / efi Inbox) | **Fixed.** Main Game Project Overview, URL `?demo=&team=efi`, and reload matches. | `cold …`; `r2-u1-*.log` `unknown` |
| Cold reload of a tab on a non-first project (`team=efi&tab=inbox\|standup`, `team=site&tab=inbox`), slot `team=efi&slot=riffbot` | n/a | **Pass.** No write (`len=2`), and reload keeps the tab or card and its crumb. | `cold …`, `logs/r2-canon.log` |
| B2 +1-entry routes | Pass | **Pass, no change.** 6/6 forward and 4/4 reverse in dark 1920 and light 3200. The reverse `proj-row` FAIL is the known script expectation (it lands on Site, the same as base). Diff vs the R33 U1 logs: empty (reload lines and crumb text aside). | `logs/r2-b2-*.log` |
| Slot/tab Back/Forward/reload; Ctrl+K from a tab; Ctrl+J/Needs-you; Open in Inbox | Pass | **Pass, no change** (only crumb text differs in the log diff). | `r2-u1-*.log`, `r2-ctrlj.log` |
| One `.on` row; breadcrumb = row = screen = URL | Pass outside Storybook | **Pass** everywhere except the stale-entry path in m3 | all logs |
| m2 pasted non-canonical URL pushes | Open (moved to U2) | **Partly better.** A reorder-only URL (`?demo=&foo=1&team=vibesquad`) no longer pushes. Bad values (`tab=bogus`, `team=nope`, `team=gone…`) still push one entry. Out of scope (U2). | `unknown …`, `cold …` |

### New minor

#### m3 · Back into the stale entry that m2 leaves behind applies `?slot=` to the fallback project, and for `?tab=` it leaves a URL that names a gone team
- **Job hurt:** 5, Intervene. It only hits pasted or bookmarked bad links, and only after the first Back.
- **Evidence** (`cold` blocks, all 4 configs):
  - Load `?team=gone&slot=overlord`. The app shows the efi Overview and pushes `?team=efi` (m2). Back runs `POP ?demo=&team=gone&slot=overlord`, then `replaceState ?demo=&team=efi&slot=overlord`. The screen is the **efi Overlord card** (`Main Game Project › Desk › Overlord`), the gone project's slot applied to efi. This is the leak r2 fixed for cold load, coming back by pop.
  - Load `?team=gone&tab=inbox`, then Back: the screen is the efi Overview, but the URL stays `?demo=&team=gone&tab=inbox` (no replace). URL ≠ screen. On `304366f4` the same Back replaced the URL to `?team=efi`.
- **Cause:** `boringLandingFromUrl` returns `{mode:"slot", teamId: team}` without checking that the team exists (`src/BoringAde.tsx:128`). The pop handler then sets the slot lane on the current view (`src/BoringAde.tsx:609-613`), since `onSelectSquad("gone")` at `:605` changes nothing. For the tab case, no derived state changes on that pop, so the URL sync has nothing to rewrite the gone team with.
- **Fix:** in `boringLandingFromUrl`, return the slot or tab only when `team` is a known view (otherwise `{mode:"project", tab:null}` of the fallback), and have the pop path replace the URL whenever the landed team ≠ the URL team. Fixing m2 (replace on the first sync write after load) removes the stale entry and both symptoms with it.
- **Files:** `src/BoringAde.tsx`, `src/App.tsx`/`src/urlSync.ts`. **Effort:** XS. **Lane:** @desk U2, with m2.

### Artifacts (r2)
- `docs/ux-review-r33/drive/r2.mjs` (`node r2.mjs <port> <w> <h> <zoom> <theme> [shotdir]`).
- Logs: `docs/ux-review-r33/logs/r2-*.log` (force-added; `*.log` is gitignored).
- Screenshots: `docs/ux-review-r33/r2/` (U1 sequence shots dark-1920 and light-3200, plus `*-r2-*` leak and Storybook shots). The R33 first-pass PNGs are unchanged.

**Verdict (r2): PASS 0/0/2**
