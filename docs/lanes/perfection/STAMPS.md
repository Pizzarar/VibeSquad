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

## Re-runs
(none yet; S3 on/after 2026-11-15)
