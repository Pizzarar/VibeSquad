# EXP10 · best-use routing read (provider x stakes x task kind)

Owner: Per (lane perfection). Plan: `docs/PLAN_PER_BEST_USE_1125.md` block B1. Read 2026-11-25 (~02:45Z). Data-only: no source changed, no metric built.

Rule (owner, 11-25): judge on **first-try review PASS** first, then **fix-after-merge (fam)** as a guard, then fit per task kind. $/merged unit is only a tiebreak; no arm wins because it saves a quota.

## 1. Method
- **Source U**: `GET http://127.0.0.1:4180/__vibesquad/providers/usage-export?format=json` (exportedAt 2026-11-25T02:41Z), `merged.units[]`, all Squads pooled (VibeSquad + EFI squads: repos VibeSquad, EFI, ForgeWirk, RedFrontier).
- **Window**: `mergedAt >= 2026-11-08` -> 937 units. Kept units with `implementerModel` (727 of 937; the other 210 are tag-only/`unattributed` rows with no model, no stakes, no cost, so they cannot be placed). **Excluded** the capped window 11-23 22:00Z..11-24 00:10Z by `mergedAt` (20 attributed units) -> **n = 707**.
- **Provider** from `implementerModel` (not profile name; `Implement - Sonnet` with an Opus/Fable model is the stakes ladder): Sonnet = claude-sonnet-5-5, Opus = claude-opus-5-5, Fable = claude-fable-5-1, DSP = deepseek-v4-pro, DSF = deepseek-flash, Gemini = gemini-4-argon (trial).
- **first-try PASS** = `reviewRounds <= 1` (EXP2/EXP6 definition; `passRate` is not used). **fam** = `fixAfterMerge` (fix unit same lane within 24h). **$/unit** = mean `costUsd` of the implementer run (reviewer not included; n with cost in parentheses; all rows had cost).
- **Task kind** (not a field in U, derived): per unit, `git diff --name-only <sha>^1 <sha>` in the unit's repo, files bucketed: ui = `.tsx/.css/.html/src/*`; game = `.gd/.tscn/.lua/.cfg`; server = `server/ runner/ bin/ scripts/` or `.mjs/.mts/.py/.sh/.rs/.yml`; docs = `.md/.txt/.json` only; assets (png/import/uid/aseprite/tres) and test files do not vote unless nothing else does. Unit kind = bucket with most code files (ui/game/server), else docs/assets. Lane family was not used: `lane` is null on 1546 of 1882 export rows (all of EFI and most VibeSquad rows) so files are the only usable signal.
- Runner logs (`~/.vibesquad/runner/agents*/*.jsonl`) were not needed: `implementerModel`, `stakes` and `costUsd` are already joined onto U (EXP6 had to join them; U now carries them). Scripts in `/tmp/exp10/`, not committed.
- `*` = n < 10 (not usable for a decision).

## 2. Blocking data gap: first-try is not measurable outside the VibeSquad repo
`reviewRounds` is parsed from merge-subject text ("review rN"). By repo, rounds {0,1,2,3+}:
VibeSquad 320/30/132/26; **EFI 139/1/1/0; ForgeWirk 36/0/0/0; RedFrontier 22/0/0/0**.
So every game-repo unit reads as first-try PASS (163 of 163 "game" kind, 100%) because those repos' merge subjects do not carry the review-round marker, not because review passed. **Game/Godot first-try and any game-kind provider comparison is therefore uninformative.** Missing field: a real per-unit review outcome (reviewer verdict or round count read from the review/verdict log, e.g. `vs verdict` records keyed by unit) for non-VibeSquad repos. That is the @usage ask; do not build here.

Consequence: quality cells below are computed on the **VibeSquad repo only** (server/ui/docs). Game-kind rows are shown for n and $ only.

## 3. Table A: VibeSquad repo, by provider x stakes x kind (n=394 incl. small cells)
| Provider | Stakes | Kind | n | first-try | rate | fam | fam rate | $/unit |
|---|---|---|--:|--:|--:|--:|--:|--:|
| Sonnet | normal | server | 159 | 106 | 0.67 | 4 | 0.03 | $0.72 |
| Sonnet | normal | ui | 111 | 76 | 0.68 | 0 | 0.00 | $1.08 |
| Sonnet | normal | docs | 11 | 8 | 0.73 | 0 | 0.00 | $0.42 |
| DSP | normal | server | 48 | 36 | 0.75 | 2 | 0.04 | $0.31 |
| DSP | normal | ui | 12 | 10 | 0.83 | 0 | 0.00 | $0.42 |
| DSP | normal | docs | 4* | 4 | 1.00 | 0 | 0.00 | $0.08 |
| Gemini | normal | server | 10 | 5 | 0.50 | 1 | 0.10 | $1.19 |
| Gemini | normal | ui | 9* | 7 | 0.78 | 1 | 0.11 | $5.63 |
| Opus | normal | server/ui/game | 7* | 6 | 0.86 | 0 | 0 | $1.65-$5.10 |
| Sonnet | mechanical | server | 10 | 8 | 0.80 | 0 | 0.00 | $0.26 |
| Sonnet | mechanical | docs | 4* | 2 | 0.50 | 0 | 0.00 | $0.29 |
| DSP | mechanical | server | 5* | 4 | 0.80 | 0 | 0.00 | $0.62 |
| DSP | mechanical | docs / ui | 3* | 2 | 0.67 | 0 | 0.00 | $0.08 |
| DSF | mechanical | server | 7* | 7 | 1.00 | 0 | 0.00 | $0.02 |
| DSF | mechanical | ui | 4* | 3 | 0.75 | 0 | 0.00 | $0.01 |
| Opus | tierA-invariant | server | 69 | 47 | 0.68 | 1 | 0.01 | $2.74 |
| Opus | tierA-invariant | ui | 3* | 3 | 1.00 | 0 | 0.00 | $3.67 |
| Sonnet | tierA-invariant | server | 2* | 0 | 0.00 | 0 | 0.00 | $1.12 |
| Opus | tierA-security | server | 15 | 10 | 0.67 | 0 | 0.00 | $2.48 |
| Fable | tierA-security | server | 10 | 3 | 0.30 | 0 | 0.00 | $13.79 |
| Sonnet | tierA-security | server | 1* | 0 | 0.00 | 0 | 0.00 | $0.49 |

## 4. Table B: game repos (EFI, ForgeWirk, RedFrontier), n and $ only (first-try invalid, section 2)
| Provider | Stakes | n | $/unit | fam |
|---|---|--:|--:|--:|
| Sonnet | normal | 139 (EFI 101, ForgeWirk 25, RedFrontier 13) | $0.61-$1.15 | 0 |
| Opus | tierA-invariant | 25 | $0.79-$4.23 | 0 |
| DSP | mechanical | 8* (EFI) | $0.39 | 0 |
| DSP | normal | 5* | $0.38-$0.72 | 0 |
| DSF | mechanical | 8* (ForgeWirk) | $0.01 | 0 |
| Sonnet | mechanical | 9* | $0.14-$0.43 | 0 |
All-kinds totals (n=707): server 363, game 163, ui 143, docs 33, assets 5*.

## 5. Reading
- **normal / server (decision cell)**: Sonnet 0.67 (n159) vs DSP 0.75 (n48): DSP +8 pts first-try, fam 3% vs 4% (both under the guard). One standard error on DSP is about 6 pts, so the gap is ~1.3 sigma, not a clear quality gap. DSP is a work-order profile (EXP6 caveat 3: DSP gets scoped units, Sonnet gets the L-size mix), so it is also confounded by unit size, which U does not carry.
- **normal / ui**: Sonnet 0.68 (n111) vs DSP 0.83 (n12): +15 pts but n=12 is one-sided and barely over the floor (SE ~11 pts). Suggestive, not decisive.
- **normal / docs**: Sonnet n=11, DSP n=4*. No comparison.
- **Gemini** as implementer (trial): server 0.50 first-try with fam 10%, ui n=9*; worst quality of any n>=10 cell and highest cost. No case for routing to it.
- **tierA**: Opus tierA-invariant 0.68 (n69) and tierA-security 0.67 (n15) sit at the same level as normal Sonnet; Fable tierA-security 0.30 (n10) at $13.79 is the worst cell in the table (fam 0). Out of scope here (tierA routing stays Opus per the plan); flagged for the lead.
- **mechanical**: DSF 7/7 and 3/4 first-try at ~$0.02 vs Sonnet 0.80 at $0.26, but all DSF cells are n<10; no decision.
- fam is 0-4% in every cell, so it does not separate any pair.

## 6. Verdicts per kind (normal stakes unless noted)
- **server/runner**: **keep Sonnet.** DSP is +8 pts first-try (n48), fam equal, but not a clear gap and size-confounded; cost is only the tiebreak and does not decide. Re-read at n(DSP) >= 100 or with a size field.
- **UI/frontend**: **keep Sonnet.** DSP 0.83 (n12) vs 0.68 (n111) is the only gap near 15 pts; flag as the first candidate if it holds at n>=25 DSP.
- **docs/mechanical**: **keep Sonnet** (docs n=11 vs DSP 4*). Mechanical DSF/DSP look good (DSF 10 of 11 first-try, n<10 per cell) but need n>=10 per cell; keep current mechanical route, do not widen.
- **Godot/game**: **keep Sonnet.** No signal: first-try is unmeasurable for game repos (section 2).
- Gemini: not recommended (server 0.50, n10, fam 10%). Opus/Fable tierA: unchanged by this read.

B2 consequence: no cell has n>=10 on both arms and a clear quality winner, so the per-kind table ships as **all Sonnet** for normal (consistent with the B0 interim), with DSP kept as Work Order and failover.

## 7. @usage ask (the one missing field)
Per-unit review outcome for non-VibeSquad repos: first-try PASS cannot be read from `reviewRounds` there (parsed from "review rN" in merge subjects, which EFI/ForgeWirk/RedFrontier merges lack). Needed: round count or first-review verdict keyed by unit/sha from the review/verdict log. Secondary: a unit size field (LOC bucket is in U as `locAdded/locDeleted`, usable; not yet used here, a size-matched re-read of server normal is the cheap next step).
