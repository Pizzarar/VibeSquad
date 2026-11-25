# EXP12 · R3 Gemini Share & Throttle Read (@per)

Read 2026-11-25 14:16Z (pooled Squads: VibeSquad, EFI, ForgeWirk, RedFrontier; DeepSeek off; quota: antigravity 6% 5h / 18% wk vs Claude 100% 5h / 51% wk).

## 3-Line Recommendation
1. **Do not flip `implement` to Gemini-first yet** (`n=1` merged Neon unit; all Gemini implementer kinds are `<10`). Keep R0 50/50 alternation (`server/exp6-arm.mjs:22`) and extend it to bare role `implement` (`server/exp6-arm.mjs:33` + `server/role-route.mjs:52`) so normal builds climb from 9.9% toward ~50% Gemini until `n>=10`/kind; then flip `ROLE_TABLE.implement.providers` (`server/role-route.mjs:52`) to `["antigravity-cli","claude","opencode"]` for kinds where Neon is within 10 pts of Sonnet on first-try PASS.
2. **Raise `VS_RUNNER_TURN_CAP_ANTIGRAVITY` from `6` to `12`** in `~/.config/systemd/user/vibesquad.service.d/runner.conf` (For3 owns): at `cap=6` steady-state, 55.8% of non-digest antigravity spawns still queue (p90 wait 16.0m, max `ahead=18`), throttling Gemini despite 6% 5h quota; `12` matches Claude's cap and fits `VS_RUNNER_MAX_LIVE=24` with DeepSeek off.
3. **Ask `@usage` for two missing metrics**: (a) `jobKind=fixer` / fix-round attribution on `merged.units` or `byProfile` (fix rounds are unmeasured), and (b) non-VibeSquad per-unit review outcome (`reviewRounds` is 0 on EFI/ForgeWirk/RedFrontier, per EXP10).

## (A) R3 Per-Kind Table (VibeSquad quality cells; `n<10` = not enough data)
Sources: `usage-export` (`merged.units[]` >=2026-11-08 excl. 11-23 22:00Z..11-24 00:10Z cap; `byProfile` all-time for `review`). `1st-try` = `reviewRounds<=1` (for `review`: `passRate` = PASS-line share). Retired `gemini-4-argon` noted as ref only.

| Kind | Arm | n | 1st-try / passRate | $/unit | fam | Status |
|---|---|--:|--:|--:|--:|---|
| implement (normal, VS) | Sonnet | 311 | 0.678 | $0.87 | 1.6% | baseline (all repos n=454, $0.92) |
| implement (normal, VS) | Opus | 8 | 0.875 | $3.00 | 0.0% | not enough data (all n=29) |
| implement (normal, VS) | Gemini 4 Neon | 1 | 1.000 | $0.94 | 0.0% | **not enough data** (24 R0 spawns in flight; Argon ref n=19, 0.632, $3.29, 10.5%) |
| implement (normal, VS) | Gemini 3.8 Flash | 0 | - | - | - | **not enough data** |
| review (normal, all-time) | Gemini 4 Neon | 141 | 0.774 (PASS) | $2.45 | 1.4% | **winner / default** ($0.64/run, 539 runs) |
| review (normal, all-time) | Sonnet | 28 | 0.627 (PASS) | $1.03 | 7.1% | fallback ($0.35/run, 83 runs) |
| review (normal, all-time) | Opus | 15 | 0.175 (PASS) | $7.44 | 6.7% | UX/special review ($1.77/run) |
| review (TierA-inv, all-time) | Gemini 4 Neon | 48 | 0.771 (PASS) | $3.91 | 0.0% | **winner / default** (Opus n=11, 0.542, $3.63, 0%) |
| review (mechanical, all-time) | Gemini 3.8 Flash | 24 | 0.789 (PASS) | $1.01 | 0.0% | **winner / default** (Sonnet n=11, 0.556, $0.33, 0%) |
| fix round | all arms | - | - | - | - | **missing metric** (not tracked in `@usage`) |
| mechanical (VS) | Sonnet | 15 | 0.733 | $0.26 | 0.0% | baseline (all repos n=24, $0.27) |
| mechanical (VS) | Gemini 3.8 Flash | 1 | 1.000 | $0.31 | 0.0% | **not enough data** (Neon n=0) |
| docs (normal, VS) | Sonnet | 15 | 0.733 | $0.47 | 0.0% | baseline (Neon n=0, Flash n=0: **not enough data**) |
| UI (normal, VS) | Sonnet | 121 | 0.678 | $1.09 | 0.8% | baseline (Opus n=4, Neon n=0, Flash n=0: **not enough data**; Argon ref n=9, 0.778) |
| Tier A (inv+sec, VS) | Opus | 106 | 0.708 | $2.81 | 0.9% | baseline (all n=135; Fable n=10, 0.300, $13.79; Sonnet n=3; Neon/Flash n=0: **not enough data**) |

## (B) Routing Split (7d `route-agent` across `~/.vibesquad/teams/*/log.jsonl`, n=6,118)
Joined to runner `created` meta to separate digests (`digestFor`) from code reviews. Top reasons (7d): `legacy-name` 4,390, `default` 908, `ladder+legacy-name` 634, `ladder` 163.

| Category | 7d Total | Claude | Gemini | DeepSeek | Gemini share (C+G only) | Last 24h Gemini (C+G) |
|---|--:|--:|--:|--:|--:|--:|
| **Build** (`implement`+`work-order`) | 1,132 | 797 (70.4%) | 30 (2.7%) | 305 (26.9%) | **3.6%** (Neon 24, Flash 6) | **9.9%** (30/304) |
| **Review** (code review only) | 959 | 103 (10.7%) | 856 (89.3%) | 0 (0.0%) | **89.3%** (Neon 789, Flash 61, Argon 6) | **84.5%** (354/419) |
| Pre-check / Scout | 1,166 | 89 (7.6%) | 1,075 (92.2%) | 2 (0.2%) | 92.4% | 100.0% (2/2) |
| Digest | 1,622 | 4 (0.2%) | 1,616 (99.6%) | 2 (0.1%) | 99.8% | 99.8% (970/972) |
| Lead / Buddy / Other | 1,239 | 558 (45.0%) | 663 (53.5%) | 18 (1.5%) | 54.3% | 7.5% (8/106) |

**Exact config/code seams**:
- **Now (gather Neon n>=10 faster)**: `server/exp6-arm.mjs:33-37` (`ARM_SOURCES`) only alternates `Implement - Sonnet`, `Worker`, `Implement - Gemini (trial)` — bare role `Implement` bypasses it and lands on Claude via `server/role-route.mjs:52`. Include role `implement` (R1 seam) so normal builds split 50/50 (~50% Gemini vs 9.9% today).
- **After `n>=10`/kind where Neon >= Sonnet - 10 pts**: flip `ROLE_TABLE.implement.providers` in `server/role-route.mjs:52` (and `LEGACY_VIA["Implement - Sonnet"]` at `:151`, `server/profiles.mjs` / `server/provider-failover.mjs`) to `["antigravity-cli","claude","opencode"]`, or set `IMPLEMENTER_ARMS = ["neon","neon","sonnet"]` in `server/exp6-arm.mjs:22` for a 2:1 Gemini-heavier default.

## (C) Throttle Analysis (`VS_RUNNER_TURN_CAP_ANTIGRAVITY=6`)
- **Where read & what it caps**: `runner/runner.mjs:239-246` (`turnCapsFromEnv`, default `DEFAULT_TURN_CAPS.antigravity = 3` at `:223`, overridden to `6` in `~/.config/systemd/user/vibesquad.service.d/runner.conf:5`, live in `systemctl --user show vibesquad`). Enforced in `Runner._fits()` (`runner/runner.mjs:884-892`): caps concurrent active non-quiet `antigravity` turns (all `antigravity-cli` spawns: reviews, digests, pre-checks, Neon builds; over-cap jobs queue FIFO with `+2` owner and `+1` digest reserves).
- **Evidence (runner `agents/*.jsonl`, 7d, cap=6 live since 2026-11-25 02:40Z restart)**:

| Antigravity Window | All queued | Non-digest queued | Non-digest `ahead` (p50/p90/max) | Non-digest wait (p50/p90/max) |
|---|--:|--:|--:|--:|
| Pre (`cap=3`, `<02:40Z`) | 1077/1716 (62.8%) | 383/484 (79.1%) | 10 / 32 / 41 | 16.8m / 64.0m / 187.7m |
| Post all (`cap=6`, `>=02:40Z`) | 307/531 (57.8%) | 90/147 (61.2%) | 6 / 27 / 31 | 3.5m / 28.3m / 35.0m |
| Post steady (`cap=6`, `>=03:15Z`) | 218/441 (49.4%) | 72/129 (55.8%) | 3 / 13 / 18 | 2.4m / 16.0m / 20.8m |

- **Verdict**: **Yes, `cap=6` throttles Gemini.** Even in steady-state (`>=03:15Z`), over half of non-digest Gemini spawns wait in queue (p90 16.0m, max 20.8m, `ahead` up to 18) while antigravity quota sits at 6% (5h) / 18% (wk).
- **Proposed value (For3 `runner.conf`)**: raise `VS_RUNNER_TURN_CAP_ANTIGRAVITY` from `6` to **`12`** (matches `DEFAULT_TURN_CAPS.claude=12`; `12+12=24` fits inside `VS_RUNNER_MAX_LIVE=24` with DeepSeek off, no disk/RAM bump needed).
