# EXP6 · DSP vs Sonnet on normal implementer units (W2 follow-up to EXP2)

Owner: Per12 (lane perfection). Plan: `docs/PLAN_EXP6_DSP_IMPLEMENTER.md` (gitignored). Card: idea-314. Block E0 (baseline + protocol), written 2026-11-19. Status: **CLOSED 2026-11-23, verdict CHANGE** (section 4, E2). Follow-up plan: `docs/PLAN_EXP6_DSP_DEFAULT.md`.

## 1. Baseline since 2026-11-08 (before any alternation)
Sources, all read 2026-11-19:
- **U** = `GET http://127.0.0.1:4180/__vibesquad/providers/usage-export?format=json` (exportedAt 2026-11-19T22:22Z): `merged.units[]` (470 units merged since 2026-11-08 00:00 -05:00, filtered by `mergedAtMs`, grouped by `implementerModel`/`implementerProfile` + `stakes`) and the all-time `byWorkflow` rollup.
- **S** = runner agent jsonl `~/.vibesquad/runner/agents/rn-*.jsonl`, first line `type:created`, `meta.profile` + `meta.labels` (`stakes`, `wf`, `vs.route`, `job`): 750 Sonnet/DSP implementer spawns created since 2026-11-08. (The `route:` / `route-agent:` vs-log metrics were not parsed; the `vs.route` label on created.meta carries the same stakes.)
- **G** = `git log --since=2026-11-08` `[wf:]` subject tags.

Definitions: first-try PASS = `reviewRounds <= 1` (EXP2; trap F1 still applies, do not use `passRate`). $/unit = mean unit `costUsd`. Fix-after-merge = unit `fixAfterMerge` (same predicate as audit bucket 4: fix unit on the same lane within 24h).

### 1a. Merged units since 11-08 (source U)
Arm = model that ran the unit. `Implement - Sonnet` with an Opus/Fable model is the stakes ladder, so rows group by model, not profile name.

| Arm | Stakes | n merged | first-try PASS | rate | $/unit (n with cost) | fix-after-merge |
|---|---|--:|--:|--:|--:|--:|
| Sonnet | **normal** | 80 | 51 | **0.637** | **$1.15** (80) | 4 (5.0%) |
| DSP (`Work Order - DSP`, deepseek-v4-pro) | **normal** | 12 | 10 | **0.833** | **$0.32** (12) | 1 (8.3%) |
| Sonnet (model sonnet, tierA-invariant) | tierA-invariant | 15 | 10 | 0.667 | $3.04 | 0 |
| Sonnet profile, Opus/Fable model | tierA-security | 10 | 4 | 0.400 | $9.61 | 0 |
| DSP | mechanical | 3 | 1 | 0.333 | $0.31 | 0 |
| Sonnet, tag only (`[wf:sonnet]`, no profile/stakes on the ledger row) | unknown | 19 | 12 | 0.632 | none on row | n/a |
| DSP, tag only | unknown | 1 | 0 | 0.000 | none on row | 0 |

The decision cells are the two **normal** rows. DSP n=12 is just over the 10-unit floor; Sonnet n=80 is not balanced against it and is a different job mix (gaps 3, 4).

### 1b. All-time `byWorkflow` rows the card quoted (source U, no date filter)
| workflowMode | units | firstTryPassRate | $/unit | costCoverage | fixAfterMergeRate |
|---|--:|--:|--:|--:|--:|
| claude-sonnet-5-5 · normal -> gemini-review | 168 | 0.702 | 1.173 | 0.976 | 0.024 |
| deepseek/deepseek-v4-pro · normal -> gemini-review | 21 | 0.714 | 0.184 | 0.429 | 0.095 |
| deepseek/deepseek-v4-pro · mechanical -> gemini-review | 3 | 0.333 | 0.307 | 1.0 | 0 |

### 1c. Spawned (source S, created since 11-08)
| Profile / model | stakes label | n spawned |
|---|---|--:|
| Implement - Sonnet / sonnet-5-5 | normal | 348 |
| Implement - Sonnet / sonnet-5-5 | none (pre-stakes) | 170 |
| Implement - Sonnet / sonnet-5-5 | mechanical | 29 |
| Implement - Sonnet / opus-5-5 | tierA-invariant | 79 |
| Implement - Sonnet / opus-5-5 | tierA-security | 10 |
| Implement - Sonnet / fable-5-1 | tierA-security | 15 |
| Work Order - DSP / deepseek-v4-pro | normal | 22 |
| Work Order - DSP | mechanical | 38 |
| Work Order - DSP | none | 32 |
| Work Order - DSP | tierA-invariant | 4 |

Normal: Sonnet 348 spawned vs 80 merged, DSP 22 vs 12. Spawns include retries, fixers, stalled respawns and reviewers briefed as Implement - Sonnet (audit bucket 4: 52 units with 2+ implementers since 11-14 alone), so spawned is not units attempted.

### 1d. Use split (work order vs implementer)
- DSP normal spawns whose `job` label says "work order"/"WO": 7 of 22; the other 15 are free-text titles (e.g. "ART-PIPE-T1-CHROME-WIRE · impl (DSP)", "overlap reds r2", "sq-row clip"). Over all 96 DSP spawns the title test hits 17 and misses 79.
- All 348 Sonnet normal spawns are implementer use.
- No label separates work order from implementer (`job` is free text), so this split is a title-based estimate.

### 1e. `[wf:]` tags in merge history (source G, first-parent, since 11-08)
`[wf:sonnet]` 29, `[wf:gemini]` 10, `[wf:opus]` 4, **`[wf:dsp]` 0** (the 2 commits matching `wf:dsp` are the R0 stakes unit mentioning the tag in prose). On spawn labels, 1 DSP spawn carries `wf=dsp` (first seen 2026-11-18T04:58Z) vs 75 normal Sonnet spawns with `wf=sonnet`. The P1 label exists but DSP is barely stamped.

## 2. Protocol (from the plan's Decided section)
- **Arms:** `stakes=normal` implementer units alternate between `Implement - Sonnet` (`[wf:sonnet]`) and `Work Order - DSP` (`[wf:dsp]`), odd/even by dispatch order in each lane. `tierA-*` units never go to DSP. `mechanical` units are out of scope.
- **Yardstick** (EXP2's): primary first-try review PASS rate; secondary $/merged unit; guard fix-after-merge (audit bucket 4). **Change** if DSP is within 10 pts on pass rate, at lower $/unit, and no more than +5 pts on fix-after-merge. **Not-enough-data** if either arm has fewer than 10 merged units at read time. *(2026-11-25 update: replaced by the best-use yardstick; see docs/PLAN_PER_BEST_USE_1125.md).*
- **No code:** explicit profile at spawn, P1 `wf` label stamps the arm, merges carry `[wf:]`, read through @usage `byWorkflow` (`docs/lanes/usage/SPEC.md:28-42`). Ove12 relays the alternation to lane leads (as Hub3 did for the EXP2 arms).
- **E1 check 2026-11-21 (48h):** both `wf` values appear on new normal implementer spawns (`get_agent_status` labels); nudge lanes that do not alternate.
- **E2 read on/after 2026-11-26 or at 10 merged per arm:** table in this file, `vs log metric`, `vs log decision "@per EXP6 verdict keep|change|not-enough-data: ..."`, and on "change" a `vs task @perfection` for the P5 role-table edit.
- **Config stays read-only until the verdict.** A "change" lands as Implement's provider order in the P5 role table (`docs/PLAN_PROFILES_ROLE_ONLY.md`), its own unit, after Aub's OK on P5c. No interim profile edit.
- **Arm picked server-side since idea-440** (server/exp6-arm.mjs, branch unit-ab-arm-440): spawn_worker swaps normal Implement - Sonnet / Work Order - DSP to the lane's lagging arm (counts since 11-19, tie keeps the request); leads no longer alternate by hand. Opt out with `labels.ab=pin` or an explicit `wf` label. Closes at the EXP6 verdict decision or VS_EXP6_END (default 2026-11-27).

## 3. Gaps and caveats
1. **Card figures reproduced, with a date difference.** $0.18/unit with 0.714 (DSP) and $1.17/unit with 0.702 (Sonnet) are the all-time `byWorkflow` normal rows (1b), not since 11-08. Since 11-08 (1a): DSP $0.32 / 0.833 / n=12, Sonnet $1.15 / 0.637 / n=80, so the cost gap is about 3.6x, not 6.4x. The all-time DSP $0.18 is also thin: costCoverage 0.429 means only 9 of 21 units carry cost; in 1a all 12 do.
2. **Unit cost is the implementer's run only.** Reviewer is Gemini for both arms and its cost is not in either number (and is on a different basis, EXP2 risk). Cycle time is `byWorkflow.avgUnitCycleMs`, not read here.
3. **DSP is a work-order profile.** Its merged units are scoped for DSP; the Sonnet pool holds the full implementer mix including L-size units. U has no size field, so pairing by size is impossible. Alternation within a lane fixes the mix going forward; this baseline does not.
4. **Use split is title-based** (1d).
5. **n spawned is inflated** (1c). Use merged n for rates.
6. **Stakes leak:** 4 DSP spawns carry `tierA-invariant` and 32 carry no stakes label; 170 Sonnet spawns predate the label. Check before E2 that no tierA unit sits in the DSP arm.
7. **Tag-only rows:** 19 Sonnet + 1 DSP merged rows have `[wf:]` tags but no profile/stakes on the ledger row, so they cannot be placed in the normal split and carry no cost.
8. **Guard is one unit wide:** DSP fix-after-merge 1 of 12 (8.3%) vs Sonnet 4 of 80 (5.0%) is +3.3 pts, inside the +5 pt guard, but a second DSP fix flips it.
9. `reviewRounds` derives from commit subjects ("review rN") and EXP2 found it can under-count; compare arms to each other, not to absolutes.
10. `byProfile.mergedUnits` is all-dates and was not used.

## 3b. E1 live arms check (2026-11-21, Scout rn-24519db40f39)

Normal-stakes implementer spawns since 11-19, by `wf` arm:

| lane | sonnet | dsp | no wf |
|---|--:|--:|--:|
| bug-chaser | 14 | 4 | 0 |
| perfection | 10 | 0 | 0 |
| ui-bois | 5 | 1 | 0 |
| desk | 2 | 0 | 0 |
| wiki | 2 | 0 | 0 |
| usage | 1 | 0 | 0 |
| boring-mode | 1 | 0 | 0 |
| android-app | 0 | 1 | 0 |
| **total** | **35** | **6** | **0** |

- Verdict: BOTH-ARMS, but skewed 35/6. bug-chaser alternated 4 pairs under Bug26/27, then ran 7 Sonnet in a row under Bug28/29; @per itself (Per12/Per13) ran 10/0.
- Root cause: alternation is a relayed instruction, so it is lost at every lead handoff. It is not in the spawn path.
- P5c (merged 11-21) did not change either arm: route-agent shows claude-sonnet-5-5 and deepseek/deepseek-v4-pro.
- Action: nudge relayed via the Overlord; DSP-first for the next normal implementer units until dsp catches up; E2 read stays >=11-26 or 10 merged/arm, extend if dsp is still short.
- Note (2026-11-25, Aub): The "within 10 pts + cheaper" change rule is replaced by the best-use yardstick ("used best, not to save any one quota": first-try review PASS first, fix-after-merge guard, fit per task kind, $/merged unit only as tiebreak; see docs/PLAN_PER_BEST_USE_1125.md). Closed-EXP6 normal implementers return to Sonnet default via interim B0.

## Acks
- 11-19 Ove12: relayed to Bug26 (@bug), Des4 (@desk), hub workers.
- 11-19 Bug26: Sonnet odd / DSP even from next dispatch, explicit wf=, [wf:] in merge subject. **Exclude** pre-EXP6 in-flight idea-349, idea-342 (Sonnet, unlabeled) from the tally.
- 11-19 Des4 (@desk): #1 Sonnet wf=sonnet, #2 DSP wf=dsp, alternating; explicit wf, [wf:] merge tags; tierA/mechanical/reviewers/fixers excluded.

## 4. E2 read (2026-11-23, gate "10 merged/arm" met early)
Source: usage-export 2026-11-23 `merged.units`, first-try = `reviewRounds <= 1` (section 1). Cost backfill usa-42 live (5f9acccd), costCoverage in brackets.

| Window | Stakes | Arm | n | first-try | $/unit (cov) | fix-after-merge |
|---|---|---|--:|--:|--:|--:|
| >=11-19 | normal | DSP | 29 | 0.62 | 0.42 (1.00) | 0 |
| >=11-19 | normal | Sonnet | 85 | 0.67 | 0.76 (1.00) | 0 |
| >=11-08 | normal | DSP | 55 | 0.69 | 0.38 (0.84) | 2 (3.6%) |
| >=11-08 | normal | Sonnet | 273 | 0.66 | 0.89 (1.00) | 5 (1.8%) |
| >=11-19 | mechanical | DSF | 8 | 0.88 | 0.02 | 0 |
| >=11-19 | mechanical | Sonnet | 8 | 0.88 | 0.21 | 0 |

- Rule (section 2): change if DSP within 10 pts on first-try, lower $/unit, fix-after-merge <= +5 pts. Met in both windows: -5 / +3 pts, 45-57% cheaper, fam +1.8 pts. *(2026-11-25: Replaced by best-use yardstick in docs/PLAN_PER_BEST_USE_1125.md).*
- **Verdict: CHANGE** (logged 2026-11-23 22:00Z). Normal-stakes implementer default -> `Work Order - DSP`, `Implement - Sonnet` first failover. tierA-* and mechanical unchanged.
- **Mechanical cut (idea-582, DSF 0.40 vs Sonnet 1.0): ruled out.** Not reproduced on current data (0.88 vs 0.88, n=8 each). Mechanical keeps DSF.
- Ships as code, not the P5 role-table edit planned in section 2: the verdict decision closes the `server/exp6-arm.mjs` alternation, which left normal spawns on the requested `Implement - Sonnet`. D1 makes the closed-experiment default DSP at that site.
- Guard (D3, re-read on/after 2026-12-07): revert to Sonnet if DSP normal first-try drops >10 pts below this baseline or fix-after-merge goes past +5 pts.
- Caveat: DeepSeek balance ran out 2026-11-23 22:00Z (deepseek capped), so DSP spawns fail over to Sonnet until it is topped up. Exclude the capped window from the D3 read.
