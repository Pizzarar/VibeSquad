# Workflows (`perfection`, @per) · standing lane

Display name "Workflows"; id stays `perfection` (aliases `perfection-2`, `perf`; perfection-2 folded 2026-11-09 via `vs pin merge`). `standing: true`: never done.

## Job
"How do we know": workflow doubts become hypotheses + experiments read from @usage metrics. Each experiment closes with `vs log decision "@per EXP<n> verdict keep|change|ruled-out: <evidence>"`. New metrics = @usage inbox asks, never built here. Build work goes to the owning lane.

Revision 11-09 (Aub): @usage MEASURES, @per JUDGES, @bug FIXES. Judge on pooled data from all Squads. Verdicts ship as code/config (profiles, routing, caps, defaults), never as new prompt rules. No per-project Workflows chip or per-project workflow notes (repo quirks go in each repo AGENTS.md).

## Experiments
- EXP1 pull-only boot vs push boot (W1): blocked. Aub declined pull-only for now (`docs/PLAN_LEAN_BOOT_1109.md:19`); needs a per-spawn boot-size metric (asked of @usage 2026-11-09) + Bug12 B2.
- EXP2 routing/profiles (W2): Sonnet vs Gemini implementers, ~10 merged units each, `[wf:<arm>]` tags. Primary = first-try review PASS rate; secondary = $/merged unit; guard = fix-after-merge. Keep current routing unless an arm is within 10 pts at lower $/unit. Output `docs/lanes/perfection/EXP2.md`.
- EXP3 K2 compact-first-restart rule question (W3): gated on K1 meter fix (d5f2c5f merged, runner restart pending). Build stays @bug-chaser.

- W4 Usage Review: @per owns the prompt text (docs/lanes/perfection/USAGE_REVIEW_PROMPT.md, loaded by @usage plumbing), the interval (runner.usageReview.interval, 1d) and the verdicts (all review bullets go to the perfection inbox; engine bugs are bounced to @bug). Loader unit with Usa4.

## Dated
- Daily audit 04:17 (A3) seeded PAUSED by default (Aub G0); check first run.
- S3 stamps re-measure on/after 2026-11-15 (`STAMPS.md`, bucket5 baseline 50).

## Stakes
- `tierA-security`: auth/crypto/relay/remote-proxy.
- `tierA-invariant`: state machines/locks/data migrations.
- `mechanical`: renames/copy/docs.
- `normal`: everything else (default; no behavior change).

## Plan
`docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md` (W0 done 2026-11-09).
