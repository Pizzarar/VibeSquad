# PILOT_1: implementer arm comparison (PLAN_PERFECTION_PILOT, block P3)

Nine small units from the perfection pilot, three per implementer arm, all merged to `master` on 2026-11-07 (local evening, 19:38 to 20:12 -05:00). Every unit was reviewed by `Review - Gemini`. This file holds the measurements. The lead fills in the verdicts.

Arms: **sonnet** = `Implement - Sonnet` (claude-sonnet-5-5), **dsp** = `Work Order - DSP` (opencode, deepseek-v4-pro), **gemini** = `Implement - Gemini (trial)` (antigravity-cli, gemini-4-argon).

Sources: runner logs `~/.vibesquad/runner/agents/<id>.jsonl` (`turn_done`, `usage`, `input` timestamps), the lane log `~/.vibesquad/logs/vibesquad--perfection.jsonl` (`done` entries), and the merge commits on master (`git log --grep "\[wf:"`). I read the jsonl directly because the `/__vibesquad/providers/usage` fold only sees what adapters emit (see caveats).

## Per-unit table

Diff = `git diff <merge>^1 <merge> --shortstat` (files, +/-). Turns = `turn_done` count. Work = first input to last `turn_done`. Cycle = implementer first input to merge commit on master. Review rounds = reviewer passes to PASS (code review, not env).

| unit | arm | implementer id | diff | turns | tokens in/out | cost USD | work (min) | cycle (min) | review rounds | first-try PASS | env issues | brief-following (implementer final message) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| handoff-lead-noop | sonnet | rn-3e0abaf37ba1 | 2f, +5/-0 | 2 | 949,884 / 869 | 0.239 | 1.6 | 8.2 | 1 | y (reviewer verdict line truncated, lead-audited) | none (ran tests without node_modules) | In scope; reported commit `cc73e30`, tests 27/27, cleanup check on turn 2 |
| esc-sandbox-view | sonnet | rn-e0e6c933203c | 2f, +13/-1 | 1 | 420,171 / 779 | 0.150 | 0.4 | 28.1 | 1 | y | none | In scope; reported cause, fix, and caveats (source-text test only, app not run) |
| workspace-logic-prune | sonnet | rn-4d17c49f1ec8 | 4f, +2/-329 | 1 | 463,272 / 124 | 0.173 | 0.5 | 28.1 | 1 | y | no `tsc` in worktree, said so | Grepped refs before deleting; flagged `tsc` not run; also edited a header comment (small scope add, disclosed) |
| paseo-copy-leftovers | dsp | rn-e40f6d52244f | 2f, +2/-2 | 2 | n/a (ctx 42k) | n/a | 1.1 | 7.8 | 1 | y | none | In scope; reported sha, diff stat, test 4/4, uncertainties: all asked items present |
| esc-files-menu | dsp | rn-7c4bc79c0833 | 1f, +10/-3 | 1 | n/a (ctx 42k) | n/a | 2.2 | 27.9 | 1 | y (after env FAIL) | **Env FAIL** on implementer digest: no `node_modules` in worktree, `ERR_MODULE_NOT_FOUND` (2 test files, `vite`/`qrcode`); no code FAIL | In scope; disclosed the env failures and that typecheck couldn't run; looked for AGENTS.md as asked |
| git-watch-flake | dsp | rn-b442992170b6 | 1f, +22/-4 | 2 | n/a (ctx 148k) | n/a | 21.0 | 41.3 | 1 | y (5/5 reviewer runs) | none; **duplicate dispatch**: 2 digest agents (see below) | In scope (test file only); reported sha `fa729c9`, 20/20; left vs-who-squad alone and said no repro; longest DSP run (256 tool calls) |
| esc-features-menu | gemini | rn-c311c4b0a1ce | 1f, +4/-1 | 1 | n/a | n/a | 6.7 | 27.8 | 1 | y | no `tsc` in worktree, said so | Stayed in the one allowed file; said a DOM test would need an out-of-scope edit |
| push-events-sync-retry | gemini | rn-0d495fe5fe95 | 2f, +286/-8 | 1 | n/a | n/a | 8.7 | 29.0 | 1 | y | none | In scope; reported cause/fix and kept existing regex tests intact; largest unit (+286) |
| vs-spawn-flag-spoof | gemini | rn-da2b55bd8969 | 2f, +67/-8 | 2 | n/a | n/a | 17.3 | 41.2 | 1 | y | none | In scope; reported sha `c00ee10`, test 60/60, cause and fix |

Review mapping (Review - Gemini, batched): `rn-97a2b0248b83` handoff-noop, `rn-06b3599671fa` paseo-copy, `rn-a46b8e78edee` the three esc units, `rn-d36022a6bdfc` spoof + flake, `rn-0cdae0488e64` push-events + workspace-prune. All returned PASS on the first pass, so there are 0 code-review FAIL rounds across the 9 units.

Notes on the extra entries:
- **git-watch-flake duplicate dispatch:** two `Pre-check - Flash` digest agents (`rn-ea02f0ef6018`, `rn-abf40fbd928d`) were both started for implementer `rn-b442992170b6` (inputs 8 s apart) and both logged the same PASS (lane log 00:53 and 00:55Z). It was a double dispatch of the digest, not a rework round, so I count it as waste, not as a review round.
- **esc-files-menu FAIL:** logged against implementer `rn-7c4bc79c0833` at 00:49Z (`2 fail: ERR_MODULE_NOT_FOUND`). It was env-only (no `node_modules` in the worktree) and the reviewer later passed the unit. Counted separately from code review rounds.
- Other log FAILs in the window (`rn-ba69ac581995` contrast regression) belong to PLAN_JUST_SEND_IT S5 (same lane, not a pilot unit) and are out of scope here.

## Per-arm summary (n=3 each)

Main columns first: turns, cost, cycle time, fix-after-merge.

| arm | units | turns (sum / mean) | cost USD (sum / mean) | cycle min (mean / range) | work min (mean) | fix-after-merge 24h | first-try PASS | review rounds (mean) | env issues | diff total | tokens in/out (sum) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet | 3 | 4 / 1.3 | 0.562 / 0.187 | 21.5 / 8.2-28.1 | 0.8 | pending, check 2026-11-09 | 3/3 | 1.0 | 0 (2 `tsc` not run, disclosed) | +20/-330 | 1,833,327 / 1,772 |
| dsp | 3 | 5 / 1.7 | not measurable | 25.7 / 7.8-41.3 | 8.1 | pending, check 2026-11-09 | 3/3 | 1.0 | 1 env FAIL (digest), 1 duplicate digest | +34/-9 | not measurable (final ctx 42k / 148k / 42k) |
| gemini | 3 | 4 / 1.3 | not measurable | 32.7 / 27.8-41.2 | 10.9 | **1** (push-events 8b21b60 broke `test/settings-home.test.mjs:320`; fixed ddf4eea), re-check 2026-11-09 | 3/3 | 1.0 | 0 (1 `tsc` not run, disclosed) | +357/-17 | not measurable |

## Caveats

- **Gemini reviewed Gemini.** The `gemini` arm's units were checked by the same model family that wrote them (Gemini-on-Gemini). A PASS there is weaker evidence than for the other two arms. The 3/3 first-try PASS number is shared by all arms and does not separate them.
- **n=3 per arm**, and units are not the same size or kind: sonnet's set includes a 329-line deletion; gemini's includes the one +286 feature (push-events sync). Cost and turns are not size-normalized.
- **Cycle time is mostly merge batching.** Merges landed in three clusters (19:38, 19:39, 20:09-20:12 -05:00), so cycle includes time waiting for review and the lead's merge. Work time (first input to last `turn_done`) is the better speed signal, and it still includes the idle gap before a second-turn cleanup request on 2-turn units.
- **Cost and tokens exist only for the sonnet arm.** The claude adapter emits `costUsd` on `turn_done` and per-call `usage` input/output tokens. The opencode (DSP) adapter emits only a `contextTokens` snapshot and the antigravity (Gemini) adapter emits no `usage` events, so cost for those arms is unmeasured, not zero. Sonnet's tokens are summed per-call input (cache reads included), so they read large.
- Reviewer and digest runs (Gemini / Flash) are not costed. Turns and cost cover implementers only.
- Brief-following notes come from each implementer's final message plus the merged diff scope, not a line-by-line audit. All 9 stayed in scope; the only deviation was workspace-logic-prune editing a header comment (disclosed).
- Fix-after-merge needs the 24h window to pass (merges 2026-11-08 UTC). `usage` v2 fix-after-merge detection can be run then. One hit is already known: the lead's full `npm test` after the merges failed 1 test, `settings-home.test.mjs:320`, a source-regex assert on the old `fetch(` call that push-events changed. The same implementer fixed it in ddf4eea (merge tagged `[wf:gemini]`). Per-unit reviews ran only the changed files' tests, which is why it got through.
- Sonnet work times under 1 min on 1-turn units look too short for the token counts; the first-input timestamp may be a later re-brief. Treat speed as suggestive only.

## Verdict (Per3, lead)

- sonnet (`Implement - Sonnet`): **keep** as the default implementer. It tied on quality, was the only measurable cost (~$0.19/unit), had the shortest work time and 0 fix-after-merge.
- dsp (`Work Order - DSP`): **keep** for clear-scope work orders. It tied on quality with 0 fix-after-merge. The env FAIL and the duplicate digest were dispatch problems, not the arm's. Its cost is unmeasured, which is an @usage adapter gap, not a reason to drop it.
- gemini (`Implement - Gemini (trial)`): **not promoted; inconclusive, not ruled out.** It tied on first-try PASS, but that PASS came from Gemini reviewing Gemini, it was the slowest arm, and it had the only fix-after-merge. Nothing here beats Sonnet.
- Trial profile `Implement - Gemini (trial)`: **delete**, which takes the count back to 10 (the creep guard Aub asked for). Re-create it only for a Pilot 2. Deleting a profile is a settings change, so it waits for Aub's OK via Buddy.
- **n=3 is too few to rank the arms.** It only shows that no arm failed. A Pilot 2, if wanted, needs 9 size-matched units per arm, a non-Gemini reviewer for the Gemini arm, the full suite before each merge, and @usage cost capture for opencode and antigravity.

### Data suggests

On these nine units the arms are not separable on quality: all three went first-try PASS 9/9, with no code-review FAILs, so review rounds do not discriminate. What differs is turns (1.3 / 1.7 / 1.3), working time (sonnet about 1 min, dsp and gemini about 8 to 11 min on the same kind of small edit) and cost, which only sonnet reports (about $0.19 per unit). Sonnet looks cheapest and fastest on this sample, DSP matched it on quality but had the one env FAIL and the duplicate digest, and Gemini matched on quality at the largest diff size but its self-review caveat applies. n=3 per arm is not enough to call a winner: it is enough to say none of the arms failed, not to rank them. The sonnet speed edge is large enough to be suggestive, but the units differ in size and kind, so a 9-unit-per-arm run with matched sizes and a non-Gemini reviewer for the Gemini arm is the minimum I would trust. The fix-after-merge column is still open until 2026-11-09 and could change the picture.
