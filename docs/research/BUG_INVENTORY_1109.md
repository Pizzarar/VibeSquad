# Bug inventory by root-cause theme (2026-11-09)

Read-only audit for the "0.3 shippable for one friend + EFI dogfood" roadmap. No source touched.

**Method and caveats.** "Open" = inbox cards not archived (15 cards; 4 are website/security, parked), TASKS.json units not done/superseded/cancelled (bug-chaser 16, runner-pilot 7, own-daemon 7, perfection 3, art 9 blocked), team-log `blocker`/`needs-you` since 11-06 (4 blockers, 108 needs-you; most needs-you are art OK-gates, not bugs), the click-audit, brainstorm Open sections (mostly empty or "None"), `vs lesson` (38 entries), and the two live repros. Counts are hand-clustered and approximate (+-2); items touching two themes are counted in the one that owns the root cause.
Fix churn: 920 commits since 11-06, **339 (37%)** match fix|root cause|regress|hotfix (regex also hits some merge titles, so treat as an upper bound).

## Theme table

| # | Theme | Open | Examples (max 3) | Hotspot files | Lanes |
|---|---|---|---|---|---|
| 1 | Spawn / handoff / lead lifecycle | ~12 | `unit-resume-not-replace`, `unit-dedupe-lead-wake`, idea-35 (`-2` lane minted again) | `server/lead-handoff.mjs` (8), `server/brainstorm.mjs` (8), `server/backend/runner-backend.mjs` (15), `server/hooks/agent-duties.ts` (16) | bug, ove, perf |
| 2 | Runner / server restarts, runtime sync, process hygiene | ~10 | `unit-desktop-disconnect` (1.8s ping vs 6.3s loop stall), idea-62 (~20 digests stuck `queued`), `unit-run-single-runner` | `runner/runner.mjs` (14), `runner/lock.mjs`, `server/sync-runtime.mjs`, `src-tauri/src/main.rs` | bug, runner-pilot, rel |
| 3 | UI layout / clipping / scale (4K, zoom, 1080) | ~8 | idea-63 (rail/chat <1600px), `unit-slow-load-placeholders`, `unit-hub-spinup-followups` | `src/styles.css` (49), `src/SkyZones.tsx` (18), `src/skyZonesLogic.ts` (16), `src/Timeline.tsx` (11), `src/App.tsx` (11) | ui-bois, art, bug |
| 4 | Tests / suite flakiness / red master | ~7 | idea-64 (pin-remove, provider-icons, spin-up-header, team-emblem), `unit-git-watch-flake`, `unit-run-test-proc-leak` | `test/sky-gods-g6.test.mjs` (8), `test/providers-catalog.test.mjs` (8), `test/profiles.test.mjs` (6), `test/fixtures/paseo-profiles.json` (10) | bug, runner-pilot |
| 5 | Message routing / inbox / send | ~6 | `unit-inbox-send` (PLAN_INBOX_SEND_1109), `unit-d1-inline-legacy-id`, idea-20 (cross-lane ops buried in handoffs) | `server/vibesquad-api.mjs` (9), `cli/vs.mjs` (17), `server/mcp/tools.mjs` (7), `src/Timeline.tsx` | bug, ove |
| 6 | Android / remote / pairing | ~5 | **P0 blank white screen + Continue after pair**, **`/vibesquad.apk` 404**, `unit-offer-connect-fix` | `server/auth.mjs`, `src/RemotePair.tsx`, `src/remoteSession.ts`, `src-tauri/` | android-app, rel |
| 7 | Provider (Claude/Gemini/AGY/OpenCode) quirks | ~5 | `unit-agy-no-interrupt`, `unit-run-agy-split-reply`, Review-Gemini drops verdict line | `runner/acp.mjs`, `runner/claude.mjs`, `server/providers-catalog.mjs` (8), `server/profiles.mjs` (9) | runner-pilot, bug, perf |
| 8 | Context / token / compaction | ~5 | K1 meter loop (@site-polish Buddy restarted 11x), `unit-exp3-k2` (compact-first), idea-37 boot size | `server/token-watch.mjs`, `server/lead-handoff.mjs` | bug, perf, usage |
| 9 | Docs / prompt-pack / spec drift | ~4 | usa-10/19 tests pinned to old prompt text, idea-35 doc ref, @bug pack audit queued (R12) | `docs/lanes/*/SPEC.md`, prompt packs in `server/` | all |
| 10 | Art pipeline integration | ~4 live | `u3f-polish`, `f5-cast` (blocked), idea-59 (48px back-of-head) | `src/styles.css`, sprite sheets, `src/PinGrid.tsx` (6) | art, ui-bois |
| 11 | Client/server boundary and security | ~3 | idea-15 (pre-Reddit security walk), `unit-vs-spawn-flag-spoof`, SAB blank-boot (fixed `0f5c53e`, guard test exists) | `cli/vs.mjs` resolveIdentity, `server/file-lock.mjs`, `test/client-bundle-guard.test.mjs` | bug, rel |

Parked and not counted: website cards idea-29/31/34 (rosserlogic.tech), `own-daemon` 7 todo (roadmap, not defects), art units marked blocked from the superseded neon/pc98 explorations (dead branches, safe to close).

## Fix-churn hotspots (files in fix commits since 11-06)

| Count | File |
|---|---|
| 49 | `src/styles.css` |
| 18 | `src/SkyZones.tsx` |
| 17 | `cli/vs.mjs` |
| 16 | `src/skyZonesLogic.ts`, `server/hooks/agent-duties.ts` |
| 15 | `server/backend/runner-backend.mjs` |
| 14 | `runner/runner.mjs` |
| 11 | `src/Timeline.tsx`, `src/App.tsx` |
| 10 | `test/fixtures/paseo-profiles.json` |
| 9 | `src/profiles.ts`, `server/vibesquad-api.mjs`, `server/profiles.mjs` |
| 8 | `server/lead-handoff.mjs`, `server/brainstorm.mjs`, `server/providers-catalog.mjs`, 2 sky/provider tests |

Reading: CSS plus the sky/hub component trio is about 100 fix touches (theme 3). The spawn/runner/hooks cluster is about 80 (themes 1, 2, 7). `agent-duties.ts` is a single 2000+ line hook file that many lanes edit; it is the likeliest collision and regression point.

## Regression magnets (fixed 2+ times since 11-06)

- **Windows lock EPERM race**: `5064f67`, `9a3e5c0`, `848f3d9`, `a353d72`. Shipped in v0.2.8 as a known issue; fixed on master only after.
- **Takeover/hub clicks and popovers**: `70de4b5`, `50c48a4`, `da575a5`, `1d32295`, `e106a89`, `eb90602` (click-audit). Root cause was portals outside `.sky-zones` plus `overflow:hidden` on `.hub-body .agent-panes`; every new header control re-hits it.
- **Digest false "did not finish" / relay**: `7b73f40`, `413b098`, `6fd9ee2`, `2f87c35`, `5f2c0ad`. Five patches to one hook family.
- **Queue / inflight / "initializing"**: `a397e1e` (Q0), `ab7304b`, `db82ada`, `263cfc7`, `8b1eb33`. Q0 was a runner inflight leak that jammed all lanes on 11-08.
- **Lead handoff and roster CONFLICT**: `dc333d8`, `5427ac7`, `0cb6623`, `c4d023a`, `bad890d`, `7946870`, `eca9909`. `vs who lead` still shows CONFLICT after closed predecessors (log 11-08 18:33).
- **Send-to/spin-off card dismiss**: `564eb49`, `c1d1083`, `6a9a515`, `15064bd`, and `4df57e0` (stale test). Same card came back after Buddy resume.
- **Android pairing cookie/entry**: `50ea81a`, `1ddac72`, `c18fdf4`, `b9e27da`, `8a4701e`, `60413a4`. Six fixes, yet the P0 blank screen persists.
- **Blank boot from server imports in the client bundle**: `d0d0209` introduced, `0f5c53e` fixed. The 11-09 red master (25 browser tests) traced to this; lesson and `client-bundle-guard` now exist.
- **Floor/sky scale at 1080 and 4K**: `b206ded` (FF-ui Director FAIL), `66c1a16`, `8a3ca94` (angel scale), V1a/V1b guard fixes `a61586c`, `0da1aca`.

## Per-theme audit proposal and 0.3 gate

| # | Proposed AUDIT (sweep, then verify) | Blocks 0.3? |
|---|---|---|
| 1 | Enumerate every path that mints a lane/agent (`pin new`, Buddy spawn, handoff, Spin Up, wake) and the guards on each. Verify by a scripted spawn/handoff/resume matrix on the runner with `vs who` showing exactly one live lead and no `-2` lanes. Fold in `unit-vs-spawn-flag-spoof`. | **Yes.** A friend's first run is spawn and handoff. |
| 2 | Single owner for restart/sync: inventory what each merge needs live (server, runner, browser reload) and make sync-runtime auto-apply or report it. Verify by running `unit-run-single-runner` and `unit-desktop-disconnect` D0 measure with a 6s loop stall and a restart under load. | **Yes** (disconnect banner and "restart to go live" asks are the top owner interrupt). |
| 3 | Playwright matrix over every hub/sky/pin/rail/drawer control at 1280x720, 1080p, 4K@120%, light and dark, using the click-audit script plus `css-classes`, `uip-u11`, `ui-overlap`. Verify by zero `elementFromPoint` mismatches and no clipped popovers. Slow-load placeholders: take the A1 load trace first. | **Partial.** Core flows yes; polish (idea-63, art) no. |
| 4 | Fix the 4 known fails (idea-64) and the 2 load-only flakes, then make "suite green on master" a merge gate. Verify with 3 consecutive full runs plus zero leaked node processes after. | **Yes.** A red master hides real regressions. |
| 5 | Trace one message end to end (agent, inbox, `vs send`, MCP send, Send card, Overlord, Buddy) and assert delivery or a visible failure at every hop. Verify by the PLAN_INBOX_SEND S1-S3 e2e test plus the O7 unrouted-ops audit. | **Yes** (silent drops erode trust). |
| 6 | Pair flow audit on a real phone: pair, cold start, offline, wrong host, APK download route. Case-insensitive `/vibesquad.apk`, enter-hop cookies, WebView `logcat` trace (needs USB debugging). Verify on-device by a retest checklist. | **Only if the friend uses Android.** Otherwise desktop-only 0.3 and document it. |
| 7 | One provider-capability table (steer, interrupt, split replies, caps, verdict line) with a contract test per adapter. Verify with the failover path (Claude capped to Gemini) run end to end. | Partial: Claude plus Gemini must work; AGY/OpenCode/DeepSeek no. |
| 8 | Finish K1 meter correctness (tool-loop sum), then decide compact-first (K2/EXP3). Verify with a 150k lead across a real compact plus the @site-polish Buddy staying at one restart. | No (cost and noise, not correctness), except the restart loop. |
| 9 | Grep prompt packs and SPEC files for stale verbs, paths and counts; pin tests to behavior, not literal prompt text. Verify with the queued @bug pack audit. | No. |
| 10 | Close the dead blocked art units; keep only shipped-asset integration checks (sprite load, empty-frame placeholders). Verify with a cold-load screenshot. | No (slow-load placeholders overlap theme 3). |
| 11 | Bundle-boundary guard already exists; add role checks for CLI identity flags, then run idea-15's privacy/default-bind walk. Verify by `client-bundle-guard` plus a 403 test on spoofed identity. | **Yes for security walk** if the friend's machine is on a shared LAN/Meshnet. |

## Live repro addenda (11-10)

- **Android blank white screen + Continue after pairing**: a 6-fix churn area (see magnets); no logcat yet (adb sees no device). Next step is the USB trace requested in the log. Hypotheses to test: the WebView bundle error at boot (compare with SAB `d0d0209`-class crashes), or the enter-hop session not completing in the app WebView.
- **`/vibesquad.apk` 404**: `server/auth.mjs` builds URLs as `/VibeSquad.apk` (lines 775, 780, 852, 856) and the route is case-sensitive. Add a lowercase alias or lowercase the emitted URLs. Related lesson: the live :4180 server serves the APK from the runtime dir, not the repo's `dist-desktop`, so verify the served sha256.

## Suggested order for the 0.3 bar

1. Theme 6 P0 (if Android is in scope) and theme 4 (green master) in parallel.
2. Theme 1 and theme 5 audits (spawn/handoff and message delivery).
3. Theme 2 (restart and disconnect).
4. Theme 11 security walk, then theme 3 matrix.
5. Everything else after the EFI dogfood starts.
