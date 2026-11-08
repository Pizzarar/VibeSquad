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
| 4 | Fixers passed around (implementers only, corrected 2026-11-08) | 20 of 122 units had 2+ implementers; 0 bounced between lanes; 0 fix units <24h after a merge | By class (units / extra implementers): **respawn after stall 8 / 8** (queued-never-ran or still "running": floor-model, floor-tower, runner-autorestart, usage-v2-api, p5-drop-paseo, own-b8, own-b10, sky-gods); review-fix round 8 / 14; duplicate dispatch 2 / 3 (ui-theme, paseo-cut-p1); lead re-dispatch 1 / 1 (cast-icons-s2); follow-up 1 / 2 (ui-squads-p4b). The first S2b run said 30 of 131 because digest agents, Art Painter/Director, verify/triage runs and units named only in prose were counted as implementers. Biggest fixable waste: respawn after stall. |

Limits: relay cannot be proven for pre-marker data; bucket 4's unit id comes from the runner job label, else a branch/worktree/TASK cue in the first input; implementers are picked by profile and job labels (digestFor, Review/Pre-check/Art Painter/Art Director/Lead profiles, verify/triage/probe jobs), text only as fallback. A worker whose job label and input name no unit (e.g. unit-mcp-scope's first worker) is not counted. Class rules: classifySuccessor in the script.

## Bucket 5 baseline (2026-11-08): fix offered as a question
`--waste` now prints `(5)`; `--json` has `waste.fixOffers` (`total`, `outputs`, `byLane`, `byRole`, `byLaneRole`, `examples`). Counts agent `output` events whose closing two paragraphs (last ~450 chars) ask permission for a fix/step: "want me to / should I / shall I / can I …?", "Okay with that?", "Go on spawning …?", "Send it? / Send M3?", "say so/say the word and I'll …", "I can … if you'd like". Patterns: `OFFER_PATTERNS` in the script.
Calibrated on @ui-bois transcripts (a naive "want me to / the real fix" regex had found only 5 and none from @ui-bois). Trimmed real snippets are fixtures in `test/audit-owner-stamps.test.mjs`.

**Total: 50 of 33,546 agent outputs** (live data, run 2026-11-08; grows with the transcripts).

| Lane | Hits | | Role | Hits |
|---|---|---|---|---|
| bug-chaser | 23 (brainstorm 20, worker 3) | | brainstorm | 45 |
| art-direction | 12 (all brainstorm) | | worker | 4 |
| ui-bois | 9 (brainstorm 8, lead 1) | | lead | 1 |
| runner-pilot | 3 (brainstorm 2, worker 1) | | | |
| release-desk | 3 (brainstorm) | | | |

Example hits (tails):
- ui-bois/brainstorm: "The deadlock is a VibeSquad bug: a Buddy can't replace a live lead. Want me to send it to @bug?"
- ui-bois/brainstorm: "…the fix itself isn't affected. Should I send the timestamp fix to the lead?"
- bug-chaser/brainstorm: "…the two don't touch the same files. Send it?"

Excluded on purpose: A/B option lists with no stated lean ("I lean …" / "I'd go with …" keeps the hit, since the agent already decided); questions that restart with ", or …" / "or should I …"; closing paragraphs mentioning risky steps (delete, force-push, release, publish, sign, overwrite, replace the app, spend/cost); owner approvals ("Do you OK P4b?"), "Which one?" and messages under 40 chars.

Known false positives: "Send it?" on a finished plan is counted (art-direction 9 hits are mostly this) and is arguably an approval request rather than a skipped fix, so treat it as an upper bound; "Okay with that?" after a lean; worker "should I continue with B4?" scope checks.
Known false negatives: offers not in the last 450 chars or not in the last two paragraphs; offers without a question mark or the listed phrasings ("If useful I could …", "Let me know and I'll …", "tell me and I'll check", deliberately dropped as too noisy); questions with a comma+or that are really fix offers; offers wrapped in a code fence; multi-chunk outputs where the ask is a separate event.

## Re-runs
(none yet; S3 on/after 2026-11-15)
