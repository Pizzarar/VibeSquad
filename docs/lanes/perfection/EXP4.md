# EXP4: review catch rate, Gemini vs Claude reviewers (idea-81, PLAN_PER_POST03 P3)

Stakes: normal. Docs/analysis only. No config or code changed.

## Hypothesis
H1: Gemini reviewers miss Highs/Mediums that Opus/Sonnet (or Fable) reviewers catch on the same unit.
Null: miss rates are comparable, so routing reviews to Gemini by default is fine.

## Data and its limits
- Window: merges since 2026-11-10 (`git log --since=2026-11-10`, 203 merge commits). Verdict lines `PASS|FAIL c/h/m/l <sha>` read from merge subjects.
- Excluded: rn-02c7022d… (idea-81: an "Opus" review that actually ran Sonnet).
- **Limit 1:** `vs log` for a worker only returns the caller's own recent entries (`--since-me`), and raw log files were off limits. So `done` verdict lines were not available; merge subjects are the sole source.
- **Limit 2:** the reviewer is named in only ~108 of 203 merge subjects (all Gemini). 5 "Tier A" merges name no reviewer. Only 3 `[wf:]` tags per reviewer exist (tag is the implementer arm, not the reviewer, and started 11-10/11-17).
- **Limit 3:** no $/review exists for reviewers. Not computable here. Filed as **idea-300** (@usage).
- Fix-after-merge was inferred from follow-up fix commits that cite the same idea after a Gemini PASS merge. That is a proxy, not a measurement of what a second reviewer would have caught.

## Table

| Arm | Units reviewed (n) | Units with a High/Medium found in any round | Fix-after-merge on a PASSed unit (guard) | $/review |
|---|---|---|---|---|
| Gemini (named in subject) | 108 | 20 (about 19%; 37 had a round-1 FAIL, many Lows only) | 3 units: idea-160 (R2 PASS, then R3 fix), idea-162 (PASS, then P0 idle-input fix), idea-178 (PASS, then pt2 fix) | no data |
| Claude/Fable, unpaired | 0 named (5 unnamed "Tier A" merges, reviewer unknown) | n/a | 1: boot-fold-regress Tier A PASS, then roster-no-refold needed 2H/2M | no data |
| Paired (Gemini + Claude/Fable on the same unit) | 4 | see below | 0 seen | no data |

Paired units:

| Unit | Gemini | Claude-family reviewer | Delta |
|---|---|---|---|
| unit-and-end-e5-wire | R1 0/0/1L, R2 0/0/0 | Fable high R1 FAIL 1M/2L | Fable found 1 Medium Gemini passed |
| unit-and-prove-local | R1 0/0/1L, R2 0/0/0 | Fable high PASS | none |
| unit-and-end-e4b | R2 PASS 0/0/0 | Fable high R2 PASS | none (R1 not in subject) |
| unit-per-wf-stamp (9783f252) | PASS 0/0/0/1 | Sonnet PASS 0/0/0/4 | none on H/M; Sonnet found 3 more Lows |

Fable is not Opus/Sonnet, and the `stakes-ladder` now routes tierA-security to Opus, so the Fable pairs are only a proxy.

## Reading
- Paired H/M catches: Claude-family 1, Gemini 0, across n=4. One event. This is noise-level, not a rate.
- Gemini also caught real Highs unaided: 9 merges show a round-1 Gemini FAIL with H or M (e.g. restart-health-wait 1/2/0, restart-launcher-pid 1/2/0, digest-gaps-fix 2/1/0, sync-runtime 3H/2M/1L). So it is not blind to H/M.
- Guard: 3 Gemini-PASSed units needed a follow-up fix within about a day, against 1 for the only unnamed Tier A PASS. With about 108 vs 5 units that is 2.8% vs 20%, but n=5 is useless and the Gemini follow-ups may be new findings rather than misses.
- Confound: Tier A and Fable reviews were assigned to riskier units (auth, relay, locks), so more H/M there is expected regardless of reviewer.

## Verdict
**not-enough-data**, lean **keep** (Gemini default for normal stakes). Paired n=4 with 1 disagreement, no per-reviewer cost, reviewer identity missing from about half the verdict lines. Do not change routing on this.

## What a change would be (only if more data supports it)
- Tier A (tierA-invariant and tierA-security) reviews: add or switch to Opus (stakes-ladder config), keep Gemini for normal and mechanical. Evidence for it: the one paired miss (e5-wire, a security unit) and the unnamed Tier A units that FAILed after PASS.
- Trigger to re-run: >= 10 paired units with named reviewers, or idea-300 landing (reviewer=<profile> on verdict lines plus $/review).

## Follow-ups
- idea-300 (@usage): per-reviewer-profile $/review in byProfile, and reviewer=<profile> on verdict lines.
- P5 gate: this verdict (not-enough-data, keep) does not block P5; role-only profiles keep model from the stakes ladder either way.

Credits: none (original).
