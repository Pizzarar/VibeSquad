# EXP13 · Gemini Carbon vs Neon as Implement arms (quality trial)

Owner: Per (lane perfection). Plan: `docs/PLAN_PER_CRUNCH_1127.md` block X2 (idea-1118). Opened 2026-11-27. Status: **open, collecting**.

This is a quality trial, not a quota shift. The owner said (11-27) "neon and carbon have been really reliable". The question is whether Carbon matches or beats Neon as a stakes=normal implementer.

## Hypothesis
H1: Gemini Carbon (`gemini-4-carbon`) reaches a first-try review PASS rate within 10 pts of Neon (`gemini-4-neon`) on stakes=normal Implement units, with no worse fix-after-merge rate.
H0: Carbon trails Neon by more than 10 pts on first-try PASS, or has a higher fix-after-merge rate.

## Arms (server/exp6-arm.mjs, from X2)
| arm (`vs.arm`) | provider | model | weight |
|---|---|---|--:|
| sonnet | claude (agy-claude first for role spawns) | ladder mid rung (claude-sonnet-5-5) | 1 |
| neon | antigravity-cli | ladder mid rung (gemini-4-neon) | 1 |
| carbon | antigravity-cli | `gemini-4-carbon` (the arm's own model; agy picks the `-medium` variant) | 1 |

- Weights 1:1:1 keep G1's Claude:Gemini split (1:2). Carbon takes half of Neon's old share, never Sonnet's.
- Only stakes=normal spawns of the role name `Implement` can get Carbon. Old names (`Implement - Sonnet`, `Worker`) have no Carbon profile: they fold carbon into neon (weights sonnet 1 : neon 2, the G1 split).
- tierA-invariant, tierA-security and mechanical spawns get no arm and keep today's ladder. An inherited `vs.arm=carbon` on a tierA or mechanical respawn keeps the rung model too (spawn-route `armModel` applies only at stakes=normal).
- Carbon and Neon share one quota family: a `vs cap` on antigravity-cli, live quota >=95%, or the soft line caps both. The pick then goes to Sonnet (reason `capped:<family>` or soft).
- Model source: `agy models` on 2026-11-27 lists `gemini-4-carbon-{low,medium,high}` (no xhigh). Carbon is not a ladder rung.

## Yardstick (owner rule 11-25, PLAN_PER_BEST_USE_1125)
1. **First-try review PASS** (primary): `reviewRounds <= 1` on the merged unit (EXP10 definition).
2. **Fix-after-merge** (guard): `fixAfterMerge` (a fix unit in the same lane within 24h). An arm with a higher fam rate cannot win on (1) alone.
3. **Fit per task kind**: server / ui / docs, bucketed by changed files (EXP10 §1).
4. **$/merged unit**: tiebreak only. Gap: `runner/adapters/pricing.mjs` has no `gemini-4-carbon` price, so Carbon runs carry no `costUsd` until one is added from a dated source (no guessed price). If it is still missing at read time, report $ as n/a and decide on 1 to 3.

## Read gate
- At least **10 merged units per arm** (carbon and neon), stakes=normal, VibeSquad repo (first-try is only measurable there, EXP10 §2), outside any capped window.
- Fewer than 10 on either arm: `not-enough-data`, re-read later. No early verdict.

## How to count
- Source: `GET /__vibesquad/providers/usage-export?format=json`, `merged.units[]`, pooled across Squads, `mergedAt >= 2026-11-27`.
- **Group by `implementerArm`** (the `vs.arm` label on the implementer run; usa-66 carries it onto merged rows). Do not group by profile name: role spawns are all `Implement`.
- Cross-check against `implementerModel` (base model, effort suffix stripped): a `carbon` arm row must show `gemini-4-carbon`. A carbon pick that failed over (model is not Carbon) is excluded from both arms and listed separately. `wf` is `carbon` only when Carbon really ran (wf-label.mjs).
- Exclude `implementerArmReason` values other than `alternation` (capped, soft, pin, override, fail-open): those were not random picks.
- Units with `implementerShares` count by share (usa-68).

## Verdict
Close with `vs log decision "@per EXP13 verdict keep|change|ruled-out: <n per arm, first-try, fam, $>"`:
- **keep** (Carbon stays an arm at 1:1:1): Carbon within 10 pts of Neon on first-try and fam no worse.
- **change** (weights or Carbon replaces Neon): Carbon better by >=10 pts on first-try with fam no worse.
- **ruled-out** (remove `carbon` from IMPLEMENTER_ARMS, Neon back to weight 2): Carbon trails by >10 pts or fam is worse.
