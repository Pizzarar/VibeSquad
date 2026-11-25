# K2b discovery: in-place compaction for non-Claude leads/Buddies (read-only, 2026-11-24)

Scope: PLAN_PER_K2_1124 K2b. No code edited. Probes: `/tmp/acpprobe.mjs`, `/tmp/acpprobe2.mjs` (throwaway ACP clients, cwd /tmp/k2bprobe).

## TL;DR
| Provider | Compaction path | Recommendation |
|---|---|---|
| opencode (DeepSeek) | EXISTS: ACP slash command `/compact` + explicit start/completed marker | build (small), but no lead/Buddy runs on it, so low value |
| antigravity-cli (Gemini) | EXISTS: ACP slash command `/compact`, no completion marker | build (small-medium); adapter must synthesize the `compacted` boundary + post-reading |
| fallback summarize-then-restart | not needed | document only (it is the existing handoff ladder) |

## Why Claude works and why non-Claude is gated
- `server/compact-step.mjs:67-69` (`isClaudeAgent`) and `:112` (`run()` returns `skipped/non-claude`). `token-watch.mjs:177` and `lead-handoff.mjs:1433-1441` also gate on Claude.
- The step sends `/compact <focus>` through `runner.sendAgentPrompt`, then waits for a timeline event `compacted` (`compact-step.mjs:82-84`); a `turn_ended` without it = `no-boundary` = failed. `compacted` is emitted only by `runner/adapters/claude.mjs:125`. `runner/adapters/acp.mjs` has no `compact` handling at all (grep: 0 hits), so un-gating alone would fail every non-Claude attempt with `no-boundary`.
- The ACP adapter forwards any text unchanged as `session/prompt` (`acp.mjs:~266-274`), so `/compact` already reaches the CLI. It is just unrecognized on the way back.

## 1. Compaction command per CLI (live evidence)
Both CLIs advertise `compact` in an ACP `available_commands_update` right after `session/new` (probe output, opencode 2.3.2 / agy 1.5.16):
- opencode: `{"name":"compact","description":"Compact the session"}`
- agy: `{"name":"compact","description":"Compact the conversation now (summarize history to free up the context window)."}`
CLI help has no compact flag for either (`opencode --help`, `agy --help` list only run/session/acp/etc.; opencode `session` has list/delete/export/import). The path is the slash command inside a prompt turn.

Live run, 3 turns (write 1..40; `/compact`; "what was the last number?"):
- opencode (deepseek/deepseek-flash): `/compact` returned `stopReason:end_turn` and emitted `session_info_update` with `_meta["opencode/compaction"]` = `{status:"started"}` then `{status:"completed", reason:"manual"}`. Follow-up answer used the summary correctly ("40"). Marker is explicit and reliable.
- agy (gemini-4-neon-low): `/compact` returned `end_turn` with usage inputTokens 3107 + cachedRead 7408 (it makes a real summarizing model call). No start/complete marker, no `_meta`. Follow-up answered from context. Slash-command arg (focus text) not verified on either CLI; opencode's takes no documented arg, agy's unknown (test needed before promising `LEAD_COMPACT_FOCUS`).
- Both also have automatic compaction at their own limits (opencode `reason` field implies auto vs manual; agy not observed). VS caps (150k soft) sit far below both, so the manual step is the only VS-controlled one.

Caveat: the probe sessions were tiny (10-18k tokens, mostly system prompt), so the actual shrink ratio on a 150k session is unmeasured. Claude's median is 152k -> 11k (-93%). A real-size trial is the first build step.

## 2. Meter and observability of before/after
Adapter meter (`acp.mjs`): `usage_update.used` -> `contextTokens` (`:288-291`); agy sends none in some versions, so the adapter falls back to the last `PLANNER_RESPONSE` in the agy transcript (`agyTranscriptPath`, `lastPlannerContext`, `:15-37`). In this probe agy DID send `usage_update` (used 9610, size 1048576), so the transcript path is only the fallback.
- opencode: `usage_update.used` 17793 after turn 1; NO `usage_update` and no `usage` in the `/compact` response; next turn 17966. So after `/compact` the meter stays at the stale pre-compact value until the next real turn. compact-step `usedNow()` (`:90-97`) would read `after == before` and, with `after >= cap`, return `still-over`: false failure. The next-turn reading is the first true after-value.
- agy: `usage_update` after `/compact` = 10899 (> the 9610 before; that figure is the summarizer call's own prompt size), next turn 9954. So the first post-compact reading is misleading (high). Real after-value is the next turn's reading.
- Net: a before/after is observable only after the NEXT turn for both. K2b needs the success decision to rely on the boundary marker, not on `usedNow`, then record `after` lazily (next usage event) for the metric.

## 3. Fallback (summarize, then new session under same VS id)
Not needed: both CLIs compact in place. The ACP adapter also supports `session/resume`/`session/load` with a log-primed fallback (`acp.mjs:100,181-185`), but the Buddy/lead restart path already does handoff = summary + successor with a new id/labels. A same-id restart would touch: runner agent record (sessionId), labels, worktree binding, `ctxPrev/costTotal` counters in the adapter, and the usage ledger (cost resets look like a new run). Cost would be the same ~$1.04 handoff overhead (usage-export `meanHandoffOverheadCostUsd`) with none of the compaction benefit. Recommendation: do not build; keep the existing ladder as the fallthrough when `/compact` fails (already the K2 design).

## 4. Is it worth it? (7 days, 2026-11-17..24)
Sources: usage-export json, `~/.vibesquad/teams/*/log.jsonl`.
- All-time provider spend (byProvider): claude $5350 (18188 turns), antigravity-cli $2180 (11049 turns), opencode $104 (595 turns).
- byProfile lead/Buddy rows (all-time, since ~11-06): agy `former-lead` 94 runs $339 ($3.61/run); agy `former-brainstorm` 79 runs $84 ($1.06/run); agy live leads 14 runs, Buddies 15 runs. opencode: NO lead or Buddy rows at all (opencode only runs workers, 595 turns).
- 7d lead boots by provider (`boot-size role=lead`): agy 26, claude 184 (agy = 12% of lead boots). Buddy boots not emitted under that role string.
- 7d Buddy retirements `brainstorm-retired (auto-token-limit)`: 59 total, median 150k, max 379k; provider is not recoverable from the log (agent ids are not in the runner dir, successor lookup 59/59 nofile); only 1 resolved to agy. The 59 includes Claude Buddies that the compact-step already handles (compact-step events 7d: 103 total; by resolved provider 49 claude, 54 unresolved).
- agy handoff cost: lead handoff overhead Squad-wide $1.04 mean, $5.38 avg handoff run (compaction block, all-time, 338 handoffs). If agy ~12-15% of lead/Buddy handoffs and compaction is $0.18 vs $5.38, upper bound save is roughly 12% x 338 x ($5.38 - $0.18) x (1 - 0.23 fail rate) ~ $160 all-time, ~$25-30/week at current churn. Meaningful for agy, nil for opencode.
- Extra risk for agy: token-watch G1 notes agy Buddies jump 21k -> 158k in ONE turn (`token-watch.mjs:191-194`), and an agy lead carries a 35k floor (`lead-handoff.mjs:242`). Compaction is idle-only, so a one-turn spike is not preventable by compaction; only the post-turn catch applies.

Conclusion: opencode has no leads/Buddies, so documented-none for the lane budget but the adapter work is shared, so do it once. agy is worth it (about 12% of lead boots and the bulk of non-Claude handoffs).

## Proposed touch list (build)
1. `runner/adapters/acp.mjs`: detect a prompt whose text matches `/^\s*\/compact\b/i`; for opencode map `session_info_update._meta["opencode/compaction"].status==="completed"` -> `emit('compacted', {trigger:'manual'})`; for agy (no marker) emit `compacted` on that prompt's successful `end_turn` (stopReason end_turn, no error). Suppress the misleading post-compact `usage_update` as the new baseline (re-arm `ctxPrev`) so the meter re-reads on the next turn (also fixes the opencode-stale / agy-high artefacts in section 2). ~30-45 lines + tests.
2. `server/compact-step.mjs`: replace `isClaudeAgent` gate with a `COMPACT_PROVIDERS` set {claude, antigravity-cli, opencode}; make `still-over` check only when `after < before` is observable, else treat `after` as unknown and log `after=?` (current finish() already tolerates). Keep a per-provider focus text (verify the arg works first; if not, send bare `/compact`). ~15 lines + tests.
3. `server/token-watch.mjs:177`, `lead-handoff.mjs:1433`: swap `isClaudeAgent` for the shared predicate. ~4 lines.
4. Tests: acp adapter fixtures for both marker styles (opencode meta, agy end_turn-only), compact-step with non-Claude, token-watch Buddy path. No new route, no config.
5. Live check (K2 done-check style): 10 compactions per provider, okRate >= 0.9, and read the next-turn meter to measure the true drop on a >100k session.

Size: ~100 lines + ~120 test lines, 1 unit; tierA-invariant (agent lifecycle). Sequence after K2a (same files). Open question before build: does agy's `/compact` take focus args and how much does it actually shrink at 150k (needs a 150k probe, ~$1-3).
