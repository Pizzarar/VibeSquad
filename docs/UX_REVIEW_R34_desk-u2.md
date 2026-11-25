# VibeSquad UX review, round 34: @desk U2, history races (idea-983, idea-971, U1 UX m2/m3)

Date: 2026-11-25 · Build: `desk-u2-history-races` @ `8b32c3f9` (`npx vite build --outDir ~/r34/dist-u2`, HEAD unchanged, tree clean) · Base: `4a9f1fd8` (U2's parent), built from `git archive` · Previous round: `docs/UX_REVIEW_R33_desk-u1.md` (r2 PASS 0/0/2, with m2 and m3 handed to U2).

**Verdict: PASS 0/0/0** (0 critical, 0 major, 0 minor). Final. The three checks left open by the first pass were finished by a second reviewer (see "Completion pass"): the R33 `r2.mjs` re-run in all 4 configs, the R33 `u1.mjs` re-run at dark 3200, and a live-server deep-link check against base. None of them found a regression.

## Setup
- **Harness:** the R31/R33 static server (`/api` and `/ws` 404, `?demo=` cast). Its init script logs every `pushState`, `replaceState`, `back`, `forward` and `POP`.
- **Configs:** 1920×1080 @1 and 3200×1800 @1.2, dark and light. For `u2.mjs`, the four logs are identical apart from the theme and size header and the row-age text (`diff`). There were 0 page errors in every session.
- **New drivers** (`docs/ux-review-r34/drive/`):
  - `u2.mjs`: double Back/Forward at 0, 40, 150 and 400 ms gaps over an 8-screen trail, then a one-at-a-time walk of every entry; Back followed by an immediate click; Storybook ×6 sequences; 15 pasted URLs; gone-team URLs pasted mid-session. `THROTTLE=6` applies 6× CDP CPU throttling to the double-press block.
  - `gonepop.mjs`: plants a `?team=gone` entry (slot, tab, slot+tab, agent) in history, navigates on, then Backs into it. This is the R33 m3 repro.
  - `notif.mjs`: the service-worker notification click (`vs:select-agent` message) from a chat, on a cold load, and right after a Back.
- **Re-used drivers:** R33 `canon.mjs`, `ctrlj.mjs` and `u1.mjs`, and R31 `b2.mjs` (forward and reverse).

## Status vs R33 and the U2 brief

| Check | Base `4a9f1fd8` | U2 `8b32c3f9` | Evidence |
|---|---|---|---|
| **idea-983: double Back / Forward.** Trail vs Overview → Audit chat → efi Overlord slot → efi Overview → efi Standup → Ctrl+K UI Lab → vs Overview → vs Inbox. Then 2×Back, 2×Back, 2×Fwd, 2×Fwd, 2×Back, 3×Back, 3×Fwd, then a slow walk of all 8 entries both ways | The final screens are right in this harness, but every fast pop writes transient `replaceState`s into the popped entries, including a mixed `team=vibesquad&agent=demo-lead-ui` (23 writes in one run). This is the mechanism behind idea-983. | **Pass.** Every press lands on the expected entry (URL, screen, crumb, one `.on` row) at all 4 gaps and in all 4 configs. The history length never changes, and the walk shows no entry was overwritten. There are **0 `replaceState` writes** during pops. The same result holds under 6× CPU throttling. | `logs/u2-*.log` `double gap=*`, `logs/u2-throttle6-dark-1920.log`, `logs/first-pass/base-u2-dark-1920.log`; `shots/*-double-back-t3.png` |
| Back, then an immediate project-row click (a push while the pop is settling) | n/a | **Pass.** The push lands on top of the popped entry; Back and Back #2 walk the trail. | `back-then-click` |
| **idea-971: an old `?sb=` entry.** Over the Overview, Inbox, a chat and a slot card: open → Esc → Forward into the old entry → Esc → Forward → browser Back | Forward into the entry does not reopen Storybook; Esc there is dead or replaces | **Pass.** Opening is +1. Esc goes back. Forward reopens Storybook on the same URL, Esc then goes back again, and history length is unchanged. | `sb-ov`, `sb-inbox`, `sb-chat`, `sb-slot`; `shots/*-sb-fwd-reopen.png`, `*-sb-esc-after-fwd.png` |
| Stale `?sb=` entry deeper in history (SB over a chat, then Back ×2, Fwd ×2 into it, Esc, Back) | fail | **Pass.** Esc returns to the chat, and the next Back reaches the Overview. | `sb-stale-deep`; `shots/*-sb-stale-reopen.png` |
| 2×Fwd onto a Storybook entry, then 2×Back across it | n/a | **Pass** | `sb-double` |
| **R33 m2: pasted non-canonical / invalid URL** (15 URLs: `?demo=`, `team=nope`, `view=bogus`, `tab=bogus\|INBOX`, `slot=bogus`, `team=gone&tab\|slot`, `?slot=`/`?tab=` without a team, a team that doesn't own the agent, a duplicate `tab`, reorder-only, `?agent=` only) | `pushState` on load; the first Back lands on the raw URL, the same screen (dead press) | **Fixed.** The load cleans the URL with `replaceState` (`len` stays 2). The first Back leaves the app, and Forward returns the cleaned URL and screen. Unknown foreign keys (`foo=1`) and a reorder-only URL are left alone with no write, which is correct. | `paste …` blocks; R33 `u1.mjs` `unknown` blocks (`logs/r33u1-*.log`) |
| **R33 m3: a gone team's slot/tab after Back** (planted `?team=gone&slot=overlord\|tab=inbox\|slot=bugs&tab=standup\|agent=demo-aud` entry, popped from efi Standup and from vs Overview) | The efi Overlord card is shown (the gone slot is applied to efi) | **Fixed.** The fallback project's plain Overview shows, the URL is replaced to `?team=efi`, Back #2 returns to the start, and Forward/Forward mirror it. | `logs/gonepop-dark-1920.log` vs `logs/base-gonepop-dark-1920.log` (4 fails); `shots/dark-1920-gonepop-back.png` |
| Gone-team URL pasted mid-session, then a Needs-you row, Back ×2 / Fwd ×2 | n/a | **Pass** | `gone-back …` |
| **B2 +1-entry routes:** Ctrl+K, Needs-you row, project badge, sidebar row, sidebar mate, project row | Pass | **Pass.** 6/6 forward and 5/5 reverse in dark 1920 and light 3200. The reverse `proj-row` FAIL is the known R31 script expectation (it lands on Site; R33 notes it). | `logs/b2-*.log` |
| **Notification click** route | n/a in R31 | **Pass.** It adds +1 from a chat, from a cold load (the load's pop arming is ended by the notification, so it pushes rather than replacing the loaded entry), and right after a Back (the popped entry survives). | `logs/notif-dark-1920.log` |
| Ctrl+J → Needs-you from efi Standup, Back ×3, Fwd | Pass | **Pass**, same as R33 | `logs/ctrlj-u2.log` |
| Valid URLs on a fresh load (tab, slot, agent) | Pass | **Pass.** No write (`len=2`). | `logs/canon-u2.log` |
| Slot/tab Back/Forward/reload, project switch, Ctrl+K from a tab, Open in Inbox, Storybook over a tab (R33 `u1.mjs`, 29 sessions) | Pass | **Pass** in all 4 configs (dark 3200 added in the completion pass). Diff vs the R33 r2 log: only the removed transient `replaceState`s and the m2 change (push → replace on load). | `logs/r33u1-*.log` |
| One `.on` row; breadcrumb = row = screen = URL; no dead Back | Pass outside m2/m3 | **Pass** at every step logged | all logs |

## Findings

### Critical
None.

### Major
None.

### Minor
None new. R33 m2 and m3 are closed.

## Notes (not findings)
- **Cold load is armed like a pop until the first pointerdown or keydown** (`src/App.tsx:1628-1641`). So any URL-sync write before the first input replaces the entry. In `?demo` the cast is synchronous, so nothing changes after load. With the real server, though, views arrive over `/ws`. If an early sync rewrote `?team=X&agent=Y` before X's view had loaded, the deep link would be replaced rather than pushed behind a dead Back. Either way it is lost on that first write, so this is not a regression, but this harness can't exercise it. It is worth one live-server check: deep-link a non-first project's agent and reload.
- `Alt+←/→` isn't delivered to a headless page (it belongs to the browser chrome), so the keyboard variant couldn't be driven. `history.back()` presses with 0–400 ms gaps cover the same race.
- Base `4a9f1fd8` also lands double presses correctly in this fast synchronous harness, even at 6× throttle. idea-983's wrong-screen symptom needs a slower landing than `?demo` gives. The evidence that U2 fixes it is the mechanism: base writes into popped entries mid-race, and U2 writes 0.

## Completion pass (second reviewer, same build `8b32c3f9` and base `4a9f1fd8`)

| Check | Base `4a9f1fd8` | U2 `8b32c3f9` | Evidence |
|---|---|---|---|
| **R33 `r2.mjs` re-run** (Storybook + Ctrl+K leak to an efi agent and team, project rows, cold `?team=efi\|site&tab=` / `slot=riffbot` load + reload, Storybook over a chat and over an Overview reached from a chat). 4 configs | R33 r2 log: PASS, with transient `replaceState`s on every Back (e.g. `POP …tab=inbox \| replaceState …agent=demo-lead-ui \| replaceState …tab=inbox`) | **Pass** in all 4 configs, 0 `ERROR`, 0 page errors. The 4 logs are identical apart from the header. Diff vs `docs/ux-review-r33/logs/r2-leak-dark-1920.log`: only those transient writes are gone (7 lines); every URL, screen, crumb, `.on` row, history length and `dLen=1` matches. | `logs/r33r2-{dark,light}-{1920,3200}.log` |
| **R33 `u1.mjs` re-run at dark 3200** (29 sessions) | n/a | **Pass.** 0 `ERROR`, 0 page errors. It is identical to the dark 1920, light 1920 and light 3200 logs apart from the header. The diff vs the R33 `r2-u1-dark-3200.log` shows the same two changes as the other configs: the transient pop writes are gone, and pasted bad URLs replace on load (`len=2`, first Back leaves the app) instead of pushing. | `logs/r33u1-dark-3200.log` |
| **Live-server deep links** (not `?demo`). The U2 and base builds were served by `drive/live.mjs`, which forwards `/api` and `/__vibesquad` (HTTP, SSE, WS) to the owner's running server on `127.0.0.1:4180` (9 projects, 422 agents, read-only browsing). It ran with no delay, and again with `/api/teams` and the runner `/events` stream held back 2 s so the project data arrives well after first paint. 7 cold links to non-first projects (first is Escape From Idle): a ForgeWirk worker with and without `team=`, a Site lane lead, ForgeWirk `slot=riffbot`, Site `slot=overlord`, Site `tab=inbox`, ForgeWirk `tab=standup`. Each was loaded, its URL sampled every 100 ms for 8 s, then reloaded | Every link lands on its screen and survives reload. Before the data arrives, though, the app **pushes** 2–3 transient entries (`pushState ?team=efi \| pushState ?team=team-forgewirk \| pushState …&tab=standup`), so `len` reaches 4–6 and Back walks through dead or wrong-project entries | **Pass, 7/7 kept, no link lost that base kept.** Every agent/tab link keeps its exact URL and screen through load and reload. Both slot links become `?team=…&agent=<that slot's agent>` on the same `Desk›RiffBot` / `Desk›Overlord` screen. Base writes exactly the same URL, because a slot with a live agent canonicalizes to the agent. The driver's `LOST` label on those two rows is that strict param check, not a loss. The same transient writes now **replace** (`len` stays 2), so there are no junk entries behind the deep link. The results match at 0 ms and 2000 ms delays, in dark 1920 and light 3200. | `logs/live-{u2,base}-d{0,2000}-dark-1920.log`, `logs/live-u2-d2000-light-3200.log`; `shots/live/u2-dark-1920-live-*.png`, `shots/live/u2-d2000-light-3200-live-*.png` |

So the risk raised in the first pass's Notes doesn't happen: the cold-load replace arm never rewrites a deep link to the wrong place. Each early write is corrected to the link's own URL once the data lands, and it now replaces where base pushed. U2 is strictly better here.

### Pre-existing (seen in the live run, same on base, not counted against U2)
- **p1 (minor): wrong-project URL while data loads.** With the 2 s delay, a cold `?team=team-forgewirk&tab=standup` shows `?team=efi` in the address bar for up to 2 s (`urls seen ?team=efi -> ?team=team-forgewirk&tab=standup`). The agent links show `?team=efi&agent=…` for the same window. A reload or copy-link in that window would lose the tab link (the agent link would still resolve). On the local server the window is too short for the 100 ms sampler to catch. Fix: don't sync a fallback team into the URL until `/api/teams` has loaded (or while the URL's team is still unknown). Owner: @desk. Effort: S.
- **p2 (minor): no selected sidebar row for a project inside the collapsed `Backlog · Asleep` group.** A deep link to a ForgeWirk agent or tab shows the right crumb and screen, but `.on` is empty: the project sits in the collapsed Backlog group and nothing marks it (`shots/live/u2-dark-1920-live-0.png`). This breaks the "exactly one selected row" invariant. Fix: auto-expand Backlog when it holds the selected project, or mark the Backlog row as the selected container. Owner: @desk / @bor (sidebar shape). Effort: S.

## Artifacts
- Drivers: `docs/ux-review-r34/drive/`. Start the server with `node serve.mjs <dist> <port>`. For the live check, use `node live.mjs <dist> <port> [delayMs]` (proxies data to `127.0.0.1:4180`) and `deeplive.mjs <port> <w> <h> <zoom> <theme> [shotdir] [tag]`. Then run `u2.mjs <port> <w> <h> <zoom> <theme> [shotdir] [only]`, `gonepop.mjs`, `notif.mjs`. Use `TMPDIR=~/pwtmp`.
- Logs: `docs/ux-review-r34/logs/`. `first-pass/` holds the first U2 run and the base run. Those were made before two driver expectation fixes (Back-then-click expects t6, not t5; `foo=1` is allowed to stay), and their `gap=kbd` blocks are invalid (Alt+Arrow), so read them for base comparison only.
- Screenshots: `docs/ux-review-r34/shots/`.

**Verdict: PASS 0/0/0** (final; pre-existing p1/p2 queued to @desk, not counted against U2)
