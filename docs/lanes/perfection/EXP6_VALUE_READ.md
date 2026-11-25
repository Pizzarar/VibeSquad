# EXP6 value read: what the silent DSP swap bought (all Squads, read 2026-11-25)

Question (owner, via EFI hub): the EXP6 A/B swapped `Implement - Sonnet` spawns to `Work Order - DSP` (DeepSeek v4 pro) without anyone asking, and DeepSeek credit is nearly gone (~$7 of ~$100 left). Was it worth it? Read-only analysis; no code or config touched. Stakes of the read: normal.

`*` = n < 5, not significant. `~` = n 5-9, weak. Every figure below has its n beside it.

## 1. Method and sources
- **Swap events**: team logs `~/.vibesquad/teams/*/log.jsonl`, metrics `exp6-arm swap:` (20, first 2026-11-23 19:22Z, the idea-440 alternation) and `exp6-default:` (165, from the 11-23 22:05Z "DSP default" commit 82dd8b63 to 11-25 02:38Z). 185 metric lines, each matched 1:1 to a created `Work Order - DSP` worker (same team + lane, created within -4s..+20s of the metric). The metric carries the spawning lead as `agent` and has no worker ref, so the match is by time and lane (185 of 185 matched).
- **Spawn records**: runner agent jsonl `~/.vibesquad/runner/agents*/rn-*.jsonl` (11,426 agents, 11-06..11-25): `created` meta/labels, `turn_done.costUsd` (cumulative per session, so I take the max, not the sum; summed DeepSeek spend = $127.7, matches usage-export `byModel` deepseek-v4-pro $127.2), first tool/output timestamp.
- **Merged units**: `GET /__vibesquad/providers/usage-export?format=json` (exportedAt 2026-11-25T05:26Z) `merged.units[]`, grouped by `implementerModel` + `stakes`; first-try = `reviewRounds <= 1`; cap window 11-23 22:00Z..11-24 00:10Z excluded (EXP10 method). Caveat carried from EXP10: `reviewRounds` is only real for the VibeSquad repo; other game repos read ~100% first-try because merge subjects carry no review marker. Where it matters I show VibeSquad-repo-only.
- **Review verdicts and H/M/L**: last `PASS|FAIL H/M/L <hash>` line in each reviewer agent's output (1,052 reviewers parsed), attached to an implementer by shared worktree (`cwd` under `/worktrees/`). Unit = worktree; arm = first implementer spawned there. First-pass = the first review after the implementer was created. This reaches 453 worktree units (131 matched to a merged unit); implementers working in the main checkout are not covered. The digest lines in team logs are free text from leads and not tied to an author, so I did not use them.
- **Windows**: swap window = 2026-11-23 18:52Z .. 11-25 02:43Z (idea-440 server-side arm until B0 `d8e3947d` put normal implementers back on Sonnet). Pre-swap = 11-08 .. 11-23.
- Scripts in `/tmp/exp6v/` (not committed).

## 2. Swapped vs kept, by stakes tier (item 1)
Requested family = spawns of `Implement - Sonnet` / `Implement` / `Worker` (plus the swapped DSP workers), non-digest workers, swap window.

| Outcome | normal | mechanical | tierA-invariant | tierA-security |
|---|--:|--:|--:|--:|
| swapped to DSP | **185** | 0 | 0 | 0 |
| kept on Sonnet (all carry explicit `wf=sonnet`; 4 `ab=pin`, 1 `ab=off`) | **114** | 33 | 0 | 0 |
| kept on Opus (stakes ladder) | 0 | 0 | 107 | 7 |

- Of 299 normal Sonnet requests, 185 (62%) went to DSP and 114 (38%) stayed because the lead explicitly opted out (`wf`/`ab=pin`). No label on the 185 says they were swapped: they carry `wf=dsp`, which looks like an explicit lead choice.
- By day (UTC): 11-23 20, 11-24 143, 11-25 22. By team: RF 68, EFI 62, VibeSquad 38, team-9 13, sportsballbattles 2, forgewirk 2.
- Explicit DSP (not swapped) in the window: 14 (9 normal, 5 mechanical).
- Owner's no-DSP order (needs-you 11-25 02:36Z) landed after 4 more swaps; 5 swapped agents created 02:30Z+ never started, and several lanes respawned pinned on Claude.

## 3. Quality and flow per arm (item 2), normal stakes, swap window
Two instruments: A = usage-export merged units (rounds, cost, cycle); B = worktree-matched reviews (verdict, H/M/L, re-dispatch).

| Metric | DSP swapped | Sonnet kept |
|---|--:|--:|
| A: merged units attributed (n) | 9 (7 in VibeSquad repo) | 16 (13) |
| A: first-try PASS (reviewRounds<=1) | 8/9 = 0.89 ~ | 14/16 = 0.88 |
| A: fix-after-merge | 0/9 | 1/16 |
| A: median cycle (unitCycleMs) | 25 min | 76 min |
| B: units with a review (n) | 62 | 44 |
| B: first-pass PASS | 50/62 = **0.81** | 31/44 = **0.70** |
| B: findings per first review H / M / L | 0.23 / 0.35 / 1.40 (14/22/87 total) | 0.16 / 0.61 / 1.34 (7/27/59 total) |
| B: mean reviews per unit | 1.40 | 1.41 |
| B: worktrees with a 2nd implementer (re-dispatch / fix round) | 36/113 = 32% | 11/60 = 18% |
| Spawns that never started (0 turns, 0 token) | 28/185 = **15%** | 0/114 |
| Median time to first tool/output | **7.2 min** (n=164) | 0.1 min (n=114) |
| Spawns waiting > 30 min before first activity | **60/164 = 37%** | 0/114 |
| Median agent wall (spawn to last event) | 71 min (n=157) | 12 min (n=114) |

Reading it:
- Quality, when DSP actually runs: not worse. B first-pass 0.81 vs 0.70 and A 0.89~ vs 0.88 both favour DSP slightly; H/M/L per review is the same order (H 0.23 vs 0.16, M lower, L equal). The two instruments disagree on Sonnet (0.70 vs 0.88), so the arm gap is inside the noise of the method, not a DSP win.
- Flow is where DSP lost: 15% of swapped spawns never started, 37% sat over 30 min in the single `opencode` queue (`status queued ahead 12` in the agent logs), median wall 71 vs 12 min. The 32% re-dispatch figure is inflated: 72 swapped agents had a later Claude implementer in the same worktree, many of them the 11-25 respawn-on-Claude after the owner's order. Treat re-dispatch as unreliable; zero-start and queue wait are clean.
- Pre-swap baseline (11-08..11-23, all repos, normal, A): DSP n=61 first-try 0.79, Sonnet n=407 0.78; VibeSquad repo only DSP n=58 0.78 vs Sonnet n=271 0.67; fix-after-merge DSP 2/61, Sonnet 3/407. The swap did not change the conclusion EXP6 E2 reached (DSP not worse on first-try); it only spent the credit.
- Mechanical (A, 11-08..11-23): DSF n=16 first-try 0.94 at $0.01/unit; DSP n=16 0.88 at $0.40; Sonnet n=21 0.86 at $0.29. In the swap window mechanical n is 3 (DSF) and 2 (Sonnet)* so no read.

## 4. Spend per merged unit (item 3)
| Arm | Spend | Per unit | Source |
|---|---|---|---|
| DeepSeek, all time | $127.7 (usage-export byModel $127.2, 619 turns) | n/a | agent jsonl max-per-session / byModel |
| DeepSeek, swapped agents | **$75.7 of the $127.7 (59%)**; 11-24 alone $74.2 for all DeepSeek | $0.41 per spawn, $0.48 per started spawn (n=157) | agent jsonl |
| DSP merged units, swap window (A) | n=9 | $0.58/unit (n=9, cost coverage 9/9) | export |
| DSP all normal merged 11-08..11-23 (A) | n=61 | $0.30/unit | export |
| DSP swapped, per unit that got a passing review (B) | $70.7 over 113 worktree units, 56 passed | ~$1.26 per PASS unit | derived |
| Sonnet kept, per unit that got a passing review (B) | $35.9 list-equivalent over 37 units, 29 passed | ~$1.24 per PASS unit | derived |
| Sonnet merged normal 11-08..11-23 (A) | n=407 | $0.92/unit | export |

- The headline $0.30 vs $0.92 per merged unit (pre-swap) is real but only counts runs that finished. In the swap window the cheap per-run cost was eaten by long sessions: cost per PASS unit is equal (~$1.26 vs ~$1.24, derived and rough, n=56 and 29). 19.0 of the $75.7 went to swapped agents whose worktree later got a Claude implementer.
- Claude "quota share" is not a dollar figure: Claude is on a plan with a 5h/weekly percentage, and the export shows claude weekly usedPct 0 and 5h 1 right now (weekly just reset). The API-list equivalent for the 114 kept Sonnet normal agents is $59 ($0.52 each); that is what DSP's $75.7 displaced at most. No data ties a quota percentage to individual units, so the "DeepSeek $ vs Claude quota share" comparison stops at list-equivalent dollars.
- The $100 DeepSeek credit was spent mostly on the swap day: $127.7 total spend of which $74.2 on 11-24.

## 5. Task classes where DSP matched Sonnet (item 4)
VibeSquad repo only, 11-08..11-25, cap window excluded, normal + mechanical stakes, class from `git diff --name-only` of the merge (EXP10 files.json; 382 units with files). Source A.

| Task class | DSP n / first-try / $ | DSF n / first-try / $ | Sonnet n / first-try / $ |
|---|---|---|---|
| code, <= 3 non-doc files | 43 / 0.79 / $0.26 | 7~ / 1.00 / $0.01 | 168 / 0.69 / $0.62 |
| code, > 3 files | 11 / **0.45** / $0.70 | 2* / 0.50 | 100 / 0.62 / $1.30 |
| tests only | 14 / 0.93 / $0.32 (fam 2) | 3* / 1.00 | 14 / 0.93 / $0.47 |
| docs only (.md/.txt) | 5~ / 1.00 / $0.08 | n/a | 15 / 0.67 / $0.38 |
| data-only (.json) | no units (n=0) | n/a | n/a |

- DSP as good as or better than Sonnet: small code (n=43 vs 168), tests-to-spec (n=14 each, tie 0.93; DSP had 2 fix-after-merge vs 0), docs (n=5~, 5/5). DSF is better still on mechanical (n=7~ and 16 in the baseline window, 0.94).
- DSP worse: multi-file code (> 3 files) n=11, 0.45 vs 0.62. Keep L-size and multi-file units off DSP.
- Data-only: no merged unit to read (n=0).

## 6. Haiku comparison (item 5)
- `Check - Haiku` (claude-haiku-5-5) = 108 spawns 11-14..11-24; 107 are digest agents, 1 is a review (n=1*). No Haiku implementer, no first-pass PASS data, no H/M/L. Spend $0.61 total, mean $0.006 per spawn.
- Reliability vs the other digest tier: Haiku 19/107 = 18% zero-turn spawns; `Pre-check - Flash` 313/6197 = 5%. So Haiku digests miss more often than the Gemini flash digests, at a trivial cost.
- Nothing here supports or rejects Haiku for implementer/check work: n=1.

## 7. Is the swap visible now? (R0 `e4d30f2d`, merged to master 2026-11-25 04:25Z)
Confirmed in code (`server/mcp/tools.mjs:508-547`, `server/exp6-arm.mjs` `ARM_LABEL`/`ARM_REASON_LABEL`):
- Spawn reply: `result.ab = { arm, reason, model, profile, swapped, counts, requested?, capped? }` and `result.route = "arm=<arm> reason=<reason> model=<model> (<requested> -> <shown>)"`.
- Worker labels: `vs.arm`, `vs.arm-reason`, `vs.model` stamped on the spawned agent.
- Log metric: `implementer-arm: <requested> -> <shown> arm=... reason=... model=... lane=... counts=...` for alternation / capped / fail-open picks.
- Pre-R0 the lead already got `ab.swapped=true` in the reply, but leads read it late (decisions 11-24 20:56Z "spawn says ab arm dsp swapped (DeepSeek A/B?)") because nothing said why or that it was a policy default.

Still missing:
1. **No live proof yet.** Zero `implementer-arm:` metrics and zero agents with `vs.arm` in the logs read today: the daemon restart at 04:03Z predates the 04:25Z merge. Needs one post-restart spawn to confirm; I did not spawn.
2. **Opt-outs and pins write no metric** (`pin`/`wf`/`override` are filtered at tools.mjs:546), so "lead overrode the default" is not countable from the log.
3. **The metric has no worker ref** (`refs` empty; `agent` is the spawning lead). Joining swap to outcome needed time+lane matching here. Put the new agent id in `refs`.
4. **No arm field in merged units**: `usage-export` cannot tell a swapped DSP unit from an explicit DSP one (both `wf=dsp`). Add `vs.arm`/`vs.arm-reason` to the unit row (an @usage ask).
5. **No spend guard**: no per-provider credit threshold alert; the ~$100 credit ran down to $7 with no needs-you until the owner asked. A cap probe exists for quota caps, not for prepaid credit.
6. **No per-lane stall signal for queue wait**: 37% of swapped spawns waited > 30 min and no metric flagged it.

## 8. Arm x metric table (normal stakes unless noted)
| Arm | n (spawn / unit) | first-pass PASS | findings H/M/L per review | re-dispatch | never started | wall to first activity | $ per unit |
|---|---|---|---|---|---|---|---|
| DSP swapped (swap window) | 185 / 62 reviewed, 9 merged | 0.81 (B), 0.89~ (A) | 0.23 / 0.35 / 1.40 | 32% (inflated, see s3) | 28 (15%) | 7.2 min median, 37% > 30 min | $0.58 (n=9); ~$1.26 per PASS unit |
| Sonnet kept (swap window) | 114 / 44 reviewed, 16 merged | 0.70 (B), 0.88 (A) | 0.16 / 0.61 / 1.34 | 18% | 0 | 0.1 min | $0.53 (n=16); ~$1.24 per PASS unit |
| DSP pre-swap (11-08..11-23) | 61 merged | 0.79 (A) | not measured | n/a | n/a | n/a | $0.30 |
| Sonnet pre-swap | 407 merged | 0.78 (A) | not measured | n/a | n/a | n/a | $0.92 |
| DSF mechanical (11-08..11-23) | 16 merged | 0.94 (A) | 0.09 / 0.00 / 0.18 (n=11 reviewed) | 2/20 | 1/20 | n/a | $0.01 |
| Haiku (Check) | 108 (107 digests, 1 review*) | n=1*, none | none | none | 19/107 (18%) | n/a | $0.006 per spawn |

## 9. Answers
1. **Is DeepSeek worth keeping, and at what tier?** Yes, but only as an opt-in tier, not a default: `Mechanical - DSF` (n=16 merged, 0.94 first-try, $0.01/unit) and DSP for small-to-medium single-purpose work orders: small code (n=43, 0.79 vs Sonnet 0.69), tests-to-spec (n=14, tie 0.93), docs (n=5~). Not for stakes tierA, not for units over ~3 files (n=11, 0.45). Quality did not drop in the swap window, but the swap itself cost more than it saved: 59% of all DeepSeek spend ($75.7) went to swapped runs, 15% never started, 37% queued over 30 min, and cost per passing unit came out equal (~$1.26 vs ~$1.24). Default stays Sonnet; DSP by explicit request only (current B0/R0 state).
2. **Should Haiku take more of the mechanical/check tier?** The data cannot say: Haiku has 107 digest spawns and 1 review (n=1*), no unit outcomes. It misses more often than the flash digest tier (18% vs 5% zero-turn). Run a small deliberate trial first (n>=10 mechanical/check units with verdicts) before moving work onto it; DSF already owns mechanical at $0.01/unit.
3. **Do the numbers show lower-tier models could take more work than we route now?** Yes for a bounded slice: DSF/DSP matched or beat Sonnet on mechanical (0.94 vs 0.86), small code, tests-only and docs (all with n >= 14 except docs n=5~), at 30-70% of the cost, with first-pass and fix-after-merge in the same range. No for multi-file code and anything stakes-tiered. The limit is not quality but queueing: the `opencode` single queue stalled 37% of swapped spawns, so more work to lower tiers needs a parallel-capacity or fail-over rule, a visible arm/reason in the unit row, and a credit alert before it scales.

## 10. Caveats
- A (export) is only reliable for the VibeSquad repo; the swap window has n=9 (DSP) and n=16 (Sonnet) merged units, small. B (worktree match) covers worktree units only and misses implementers working in the main checkout.
- B's DSP first-pass includes zero-start spawns only if a review followed; zero-start cancellations drop out of the PASS rate and show up only as the 15% never-started line.
- Claude cost is API-list equivalent, not plan quota; DeepSeek cost is the provider-reported `costUsd`, which matched the usage-export total within $0.5.
- Re-dispatch (s3) is contaminated by the 11-25 pin-and-respawn on Claude.
