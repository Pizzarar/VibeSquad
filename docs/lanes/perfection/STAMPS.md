# Owner rubber-stamp audit

## Method
`node scripts/audit-owner-stamps.mjs [--dir <path>] [--since <ISO>] [--until <ISO>] [--json]` reads `~/.vibesquad/runner/agents/*.jsonl` (read-only). Owner inputs are `input` events whose text does not start with "From " or "You are " and is at most 400 chars. Short inputs are 4 words or fewer; the agent's role comes from `meta.role` on the `created` event. Short inputs are classified by whole-phrase patterns in `BUCKET_PATTERNS` (top of the script; S3 reuses them): **rubber stamp** (send it / do it / yes / ok-style), **real pick** (a/b/c/1/2/3, "go for b"), **reply ok** (@bug test pings, excluded), **other**. Patterns were not tuned to hit the plan's hand count.

## Baseline (run 2026-11-08 ~00:40Z)
Live data: 1,060 transcripts, 653 owner inputs, 91 short, 76 short to brainstorms.

| Bucket (short inputs) | Count | Top phrases |
|---|---|---|
| rubber stamp | 17 | send it 7, send 3, yes 2, yeah send it, yup send it, go for a send, do it, yes send it |
| real pick | 16 | a 7, b 3, 1 2, 3 2, c 2 |
| reply ok | 11 | reply ok 11 |
| other | 47 | check in 3, restart complete 3, (image) 3, singletons |

Rubber stamps per 100 owner inputs: 17 / 653 = 2.6.

### Versus the plan's hand count (646 / 91 / ~25)
- Totals: 91 short and 76 to brainstorms match exactly. Owner inputs are 653 vs 646 because transcripts are live (1,060 now vs 1,053 then); `--until 2026-11-08T00:30Z` gives 633 / 90 / 75, so the plan's 646 was taken later than that cutoff and the script cannot reproduce it to the unit.
- Stamps: 17 vs "about 25". The script is stricter (whole-phrase match only). The "other" bucket holds a few likely stamps it does not match (typo'd "yes pelase …", "1 yeah yeah", "thats perfect", "should be good"); I left them out rather than bend the patterns. Real picks (16 vs ~18) and reply ok (11) match closely.

## Waste report (S2b): `--waste [--repo <git dir>]`
Baseline run 2026-11-08 ~01:00Z. Markers used, found by reading the transcripts:
- **Forwarded/system inputs** arrive as plain `input` events with no dedicated marker (even `owner:true` is set on them), so they are excluded by prefix (`SYSTEM_PREFIXES`: "New team log event", "Idea sent over", "Report to ★", "Context check:", …). `owner:true` only exists on inputs since 2026-11-07T17:56Z.
- **Handoff fixtures**: a lead run whose `cwd` contains `handoff-test`. Handoff links come from the labels `vs.handoff-from` / `vs.handoff-trigger`; predecessor size is its peak `contextTokens` from `usage` events.

| # | Bucket | Count | Notes |
|---|---|---|---|
| 1 | Rubber stamps | 17 of 661 owner inputs | as S2 |
| 2 | Owner-as-relay | **0** strict; 126 unmarked upper bound | strict = `owner:true` and report-shaped ("<Agent>: … PASS/merged/hash/rn-…"), prefixes above excluded (152 system/forwarded dropped). The 126 pre-marker inputs look identical to agent-to-agent sends, so they are an upper bound, mostly agent sends rather than owner pastes. The naive 382 does not reproduce; the real figure is near zero. |
| 3 | Unneeded lead handoffs | **0** under 100k, of 3 real handoffs | 76 lead runs, 43 are handoff-test fixtures (hub `vibesquad` 31 of 31, `site-polish` 12), so the hub's 31 runs with <5 outputs are tests, not spawn churn or wake pings. Real handoffs: auto-250 x2 (251k, 262k), self x1 (170k). Real lane churn (non-fixture): bug-chaser 10 runs (9 fresh, 1 successor), runner-pilot 6, art-direction 5, ui-bois 4, usage 3; only 3 runs overall had <5 outputs. |
| 4 | Fixers passed around | 30 of 131 units had 2+ implementers; 1 bounced between lanes; 0 fix units <24h after a merge | Top: resolver-test-runner 7, dormant-pin-picker 6, buddy-spawn-lead 6, ui-sky-gods 6, mcp-scope 5. Lane bounce: ui-sky-gods (art-direction, ui-bois). Fix-after-merge is a heuristic (fix-named unit whose base name matches a merged branch within 24h) and matched none of the 6 fix-named units. "2+ implementers" includes legitimate retries and fix rounds after review. |

Limits: relay cannot be proven for pre-marker data; bucket 4's unit id is the first `unit-…` token in the worker's first input; reviewers are excluded by profile/ROLE.

## Re-runs
(none yet; S3 on/after 2026-11-15)
