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

### S3 re-measure (run 2026-11-17, window 2026-11-08 -> now)
Commands: `node scripts/audit-owner-stamps.mjs --waste --since 2026-11-08T00:00:00Z` (window) and the same without `--since` (all-time). 5,264 transcripts. Owner-input totals are not comparable to the baseline (653): since the `owner:true` marker the script sees 5,538 inputs in the window / 6,144 all-time, so compare rates, not counts.

| Metric | Baseline (11-08) | Window 11-08 -> 11-17 | All-time (11-17) |
|---|---|---|---|
| Rubber stamps (exact phrases) | 17 of 653 = 2.6 per 100 | **8 of 5,538 = 0.14 per 100** | 25 of 6,144 = 0.41 per 100 |
| Window stamp phrases | send it 7, send 3, yes 2 ... | send it 2, yup send it 2, send 2, yes send it 1, do it 1 | |
| Real picks (a/b/c/1/3) | 16 | 11 | 24 |
| Bucket 5 fix-offered-as-question | 50 of 33,546 outputs = 0.15% | **51 of 114,365 = 0.045%** (5 are lean-asks) | 94 of 138,959 = 0.068% |
| Bucket 2 owner-as-relay (strict) | 0 | 1 | |
| Bucket 3 handoffs under 100k | 0 of 3 real | 3 of 169 real (1 self, 2 overlord) | |
| Bucket 4 units with 2+ implementers | 20 of 122 | 48 of 303 (16%, was 16%); across lanes 1; fix unit <24h after merge 1 | |

Read: stamps per 100 owner inputs fell from 2.6 to 0.14 in the window (all-time 0.41), and the absolute count in the window (8 in 9 days) is under half of the baseline's 17 over the whole history. Bucket 5 per-output rate fell about 3x (0.15% to 0.045%). Buckets 2-4 are flat. Caveat: the denominators grew mostly because of how inputs are now counted, so the per-100 drop is overstated; the absolute 8 vs 17 and the bucket-5 rate are the sturdier signals.

### Verdict on PLAN_JUST_SEND_IT: keep
Stamps and permission-asking both dropped after the plan shipped, and nothing regressed (relay 1, early handoffs 3 of 169, fix-after-merge 1). Not enough to call it solved (8 stamps in 9 days, 51 offers), but there is no evidence for a change; the remaining hits are spread (no lane over 2 stamps; bug-chaser 16 and vibesquad 11 of the 51 offers) and are already routed as audit cards. Re-measure again only if the per-100 rate rises above 1.0 or bucket 5 above 0.1%.

Trend evidence (audit cards from the 11-12 to 11-17 daily audits, 1-2 hits each over the window, trend data rather than work; archived with a pointer here):
- idea-45: 1 unit with 2+ implementers merged (unit-loop-stall); matches bucket 4 flat at 16%.
- idea-83: 2 stamps ("yes send it", "send it") of 473 inputs in one audit day; consistent with 8 in the window.
- idea-84: 1 agent turn ended asking the owner (a lean-ask, ui-screens lead); bucket 5 trend.
- idea-172: 1 self handoff under 100k (24 of 25 self handoffs at or over 100k); window 3 of 169.
- idea-173: site-polish lead asked the owner instead of fixing an in-unit overlap and relayed an out-of-lane doc fix (R11 miss, one instance; noted to the site-polish lead separately).
- idea-289: 1 strict owner relay ("Approved: Add a main ruleset ..."), the only strict relay in the window.

### bootSize p90 check (EXP1 revisit threshold: any role p90 `total` > ~20k chars)
`boot-size` metrics since 2026-11-08, 3,264 spawns (deduped like `readBootSizes`):

| Role | n | p50 chars | p90 chars | max | over 20k |
|---|---|---|---|---|---|
| worker | 3,046 | 10,536 | 13,295 | 31,353 | 20 |
| brainstorm | 68 | 6,267 | 11,510 | 48,782 | 1 |
| lead | 150 | 35,950 | **44,425** | 90,297 | 134 |
| all | 3,264 | 10,661 | 13,946 | 90,297 | 155 |

**Lead p90 is over the 20k line (44k chars, about 11k tokens, 134 of 150 leads over).** Lead average parts: sys 6.7k, plugin 10.4k, artifact 2.7k, brief 0, first-message 17.3k chars. The `first` part (lane artifact + handoff/plan text) is the largest; this is the handoff-successor boot, not the worker boot EXP1 judged. Workers and Buddies stay under the line. EXP1's verdict (pull-only ruled-out on cost) was made on the worker/Buddy boot and still holds there; the lead boot is a new, separate question. Follow-up (not done here, config/code only): inbox card to measure whether lead `first` can be trimmed (cap TASKS.json done-unit list, artifact size) via the owning lane.

