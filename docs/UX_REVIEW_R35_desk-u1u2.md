# VibeSquad UX review, round 35: @desk U1 + U2 re-gate after the master merge (@bor B14-16 UI)

Date: 2026-11-25 · Build: `desk-u2-history-races` @ `15ba60b0` (contains U1 `013ab3bb`, U2, and @bor B14-16 via origin/master `9f1f1f81`). Built with `npx vite build --outDir ~/r35/dist`, HEAD unchanged, tree clean · Comparison builds: R34 U2 tip `8b32c3f9` and master `9f1f1f81` (each from `git archive`) · Previous rounds: `docs/UX_REVIEW_R33_desk-u1.md` (U1 r2 PASS 0/0/2), `docs/UX_REVIEW_R34_desk-u2.md` (U2 PASS 0/0/0).

**Verdict: PASS 0/0/0** (0 critical, 0 major, 0 minor against U1/U2). One pre-existing minor (p3) is listed below. It reproduces on `8b32c3f9` and on master `9f1f1f81`, so it isn't counted.

## Why this round
The merge brought @bor's Normal-mode UI into the U1/U2 branch: the Main project pinned above the tree (`boring-main-pin`, compact row plus an `Open` button), the `CrunchToggle` pill in the topbar, project reorder (drag grip and ⋯ Move up/down, `projectOrder.ts`), and the Storybook probe changes behind the `Code | Storybook` tabs. This round re-checks the U1/U2 history contracts with that UI present.

## Setup
- **Harness:** the R34 static server (`?demo` cast, `/api` 404) for the R33/R34 drivers. There is also a new `drive/serve35.mjs` that adds an in-memory `/api/teams` (GET plus PUT with revision), so Crunch and Main writes land. An optional argv makes efi the Main project. The history log init script is the R34 `lib.mjs` (it logs every `pushState`, `replaceState`, `back`, `forward` and `POP`).
- **Configs:** 1920×1080 @1 and 3200×1800 @1.2, dark and light.
- **New driver** `docs/ux-review-r35/drive/r35.mjs` (it reuses `docs/ux-review-r34/drive/lib.mjs`):
  - `trail`: vs Overview → efi Overview → efi Inbox → Main `Open` (or the RiffBot card when there is no Main) → Site Overview → Site Standup → vs Overview. Then it walks Back to the start one entry at a time, Forward to the end, and does a 2× and a 3× `history.back()` race.
  - `crunch`: Crunch pill on/off/on over a `tab=standup` screen, then Back ×2, Forward ×2, reload.
  - `grip`: reorder-grip drag with no drop.
  - `sbtabs`: the `Storybook` project tab, the sb-head `Code` tab, Forward into the sb entry, then Esc.
- `drive/esc.mjs`: a bare Escape on Normal screens (the p3 repro).
- **The U2 e2e test**, `test/desk-nav-history-u2-e2e.test.mjs`, with `U2_LOOP=20`.

## Status vs R33/R34

| Check | R33/R34 | R35 `15ba60b0` | Evidence |
|---|---|---|---|
| **U2 e2e**, `U2_LOOP=20` | n/a | **Pass.** `# tests 6 # pass 6 # fail 0` | `logs/e2e-u2-loop20.txt` |
| **idea-983: double Back/Forward** (R34 `u2.mjs`, 29 sessions: an 8-screen trail, 0/40/150/400 ms gaps, a one-at-a-time walk, Back then click) | Pass | **Pass** in all 4 configs. 0 FAIL, 0 page errors, **0 `replaceState` during a pop.** | `logs/u2-{dark,light}-{1920,3200}.log` |
| **idea-971: a stale `?sb=` entry** (`sb-ov`, `sb-inbox`, `sb-chat`, `sb-slot`, `sb-stale-deep`, `sb-double` in `u2.mjs`) | Pass | **Pass.** Forward/Back into the old entry reopens Storybook on the same URL, Esc goes back, and the length is unchanged. | same logs |
| **R33 m2: load canonicalization replaces** (15 pasted URLs in `u2.mjs`) | Fixed in U2 | **Pass.** `replaceState` on load, `len` stays 2, and the first Back leaves the app. | same logs (`paste …`); `r35-*.log` `sbtabs` (a cold `?team=efi&tab=standup` keeps its URL with no write) |
| **R33 m3: a gone team's slot/tab after Back** | Fixed in U2 | **Pass** | same logs (`gone-back …`) |
| **U1 slot + `?tab=`**: Back/Forward/reload, project switch, Ctrl+K from a tab, Open in Inbox, Storybook over a tab (R33 `u1.mjs`, 29 sessions) | Pass | **Pass.** 0 FAIL/ERROR at dark 1920 and light 3200, and **identical to the R34 logs** apart from row ages (`diff` is empty). | `logs/r33u1-*.log` |
| R33 `r2.mjs` (Storybook/Ctrl+K leaks, cold `tab=`/`slot=` load + reload) | Pass | **Pass.** Identical to the R34 logs apart from row ages. | `logs/r33r2-*.log` |
| **New: trail through the Main pin.** The Main `Open` button pushes `?team=efi&slot=riffbot` (+1). Each step is +1. Back to the start and Forward to the end match every entry (URL, screen, crumb, one `.on` row), with 0 writes during pops. The 2×/3× Back races land on the right entry. | n/a | **Pass** in 3 Main configs (dark 1920, dark 3200, light 3200) and with no Main (light 1920) | `logs/r35-main-*.log`, `logs/r35-nomain-light-1920.log`; `shots/dark-3200-main-t3-main-open.png` |
| **New: R34 `u2.mjs` with efi as Main** (dark 1920) | n/a | **Pass, with 3 driver-only diffs.** In `gone-back` the `.on` text is `Main Game Project` vs `Main Game Project1`: the compact Main row shows its collapsed badge on first load and stays expanded after the Lead opens it. URL, screen, crumb and the single `.on` row match. Sidebar expansion isn't history state (same as R34). | `logs/u2main-dark-1920.log` |
| **New: Crunch pill** | n/a | **Pass.** Each toggle writes no URL and no history (`len` and URL unchanged, no push/replace). The state is per Squad: efi stays on across Back/Forward/reload, and Site's pill reads off. Back after toggling lands on the previous entry, so there is no dead press. | `r35-*.log` `crunch`; `shots/light-1920-nomain-crunch-on.png` |
| **New: reorder grip** (drag, no drop) | n/a | **Pass.** No URL/history write, and the screen is unchanged. | `r35-*.log` `grip` |
| **New: the `Code \| Storybook` project tabs** | n/a | **Pass.** `Storybook` pushes +1 (`&sb=efi`). The sb-head `Code` is a Back (length unchanged). Forward reopens Storybook and Esc goes back to the same tab screen. | `r35-*.log` `sbtabs`; `shots/dark-1920-main-sb-open.png` |
| One `.on` row; breadcrumb = row = screen = URL | Pass | **Pass** at every settled step outside Storybook | all logs |

## Findings

### Critical
None.

### Major
None.

### Minor
None against U1/U2.

### Pre-existing (not counted; same on `8b32c3f9` and master `9f1f1f81`)
- **p3 (minor): a bare Escape on a Normal Overview/tab pushes a dead `?view=squads` entry.**
  - Job hurt: #2 (Monitor) and #5 (Intervene). Back after Esc is a dead press, landing on the same screen. A reload or copy-link of that URL carries `view=squads`, which starts on Squads Home (`src/pinFocus.ts:56`).
  - Evidence: `logs/esc-r35.log`, e.g. `?demo&team=site&tab=inbox len=2 -> ?demo=&view=squads&team=site&tab=inbox len=3 … back -> ?demo&team=site&tab=inbox crumb=Site›Idea Inbox` (same screen). A chat (`agent=`) is unaffected, because the chat's own Esc handler takes the key. A reorder-grip drag cancelled with Esc (B14) shows the same push. That isn't new: the Esc reaches the same handler.
  - Cause: the Psycho "Esc on the squad page goes up to Squads Home" window listener (`src/App.tsx:1915-1928`) is gated on `pinLayout` but not on `vibe !== "boring"`. So in Normal it calls `enterSquadsHome()`, and URL sync (`src/App.tsx:1909`, `squadsHome: pinLayout && pinsHome && squadsHome`) pushes `view=squads` with no change on screen.
  - Fix: return early in that listener when `vibe === "boring"` (Normal has no Squads Home screen). Optionally, also drop `squadsHome` from `serializeUrlState` in Normal.
  - Files: `src/App.tsx`. Effort: XS. Owner: @desk (URL sync).

## Notes
- R34 p1 (a wrong-project URL while data loads) and p2 (no selected row inside the collapsed Backlog) were not re-run against the live server this round, because the scope was the master merge. They remain open as queued.
- The Main row at 3200×1800 wraps `Open` onto a second line under the name (`shots/dark-3200-main-t3-main-open.png`). This is @bor's layout, it's readable, and it has no history impact. It is left to @bor's own gate.
- **Public-release fix included in this commit:** the five R34 live-server logs (`docs/ux-review-r34/logs/live-{base,u2}-*.log`) held personal identifiers and tripped `test/public-release.test.mjs`, so they were removed with `git rm`. `docs/UX_REVIEW_R34_desk-u2.md` still names them as evidence, and its summary table keeps the results. The R35 logs hold only `?demo` cast data and relative URLs.

## Artifacts
- Drivers: `docs/ux-review-r35/drive/`. `serve35.mjs <dist> <port> [mainTeamId]` (needs `TEAMS_JSON=<repo>/teams.example.json`), `r35.mjs <port> <w> <h> <zoom> <theme> <main:0|1> [shotdir]`, `esc.mjs <port> <mode>`. Copy them next to `docs/ux-review-r34/drive/lib.mjs` and run with `TMPDIR=~/pwtmp`.
- Logs: `docs/ux-review-r35/logs/`. Screenshots: `docs/ux-review-r35/shots/`.

**Verdict: PASS 0/0/0** (pre-existing p3 queued to @desk, not counted)
