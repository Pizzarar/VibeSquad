# EXP8: pull-only boot on @bug-chaser leads (Phase 1: design + touch set, no code)

Lane: `@per`. Plan row: `docs/PLAN_PER_K2_1124.md` EXP8. History: `docs/lanes/perfection/EXP1.md` (ruled-out 11-09 on cost; revisit trigger = a role with p90 boot `total` > ~20k chars), `docs/PLAN_LEAN_BOOT_1109.md:19` (option 3 declined "for now").
Status: design only. Arm = @bug-chaser leads (their consent to be the arm: pending, see Open).

## 1. Where the lead boot is assembled

A lead boot = system prompt (built in the spawn hook) + first prompt (built by whoever spawns it). For a handoff successor, which is nearly every lead boot:

| Part | Built at | Bug-chaser lead avg (usage export, n=25) |
|---|---|---|
| `sys` raw profile prompt | `config.systemPrompt`, `server/lead-handoff.mjs:resolveLeadProfile` | 7.1k chars |
| `plugin` prefix = rules + profile notes + git snapshot | `injectedPrefix` `server/hooks/agent-duties.ts:1087`, `composeSpawnPromptParts` `:1100`, call `:2538-2545` | 8.0k (part of the system prompt) |
| `artifact` lane SPEC.md + TASKS.json | `laneArtifactBlock` `agent-duties.ts:916`, injected `:2615-2630` | 4.1k |
| lessons digest | `lessonsDigestBlock`, `agent-duties.ts:2633-2645` | small, not metered separately |
| `first` successor prompt | `buildSuccessorPrompt` `server/lead-handoff.mjs:473-516`, called `:866`, spawned `:906-919` | 38.5k avg, p90 ~58k |

The `first` prompt splits into (markers parsed by `measureFirstPromptParts`, `agent-duties.ts:1109`):
- `firstPacket`: `--- BEGIN HANDOFF PACKET` body, from `synthesizeHandoffPacket` (`lead-handoff.mjs:376`) or the predecessor-written packet file.
- `firstBrief`: `--- BEGIN BRAINSTORM SUMMARY` body = whole `docs/brainstorm/<lane>.md` (`readBrainstormSummary`, `server/brainstorm.mjs:105`; hard cap `MAX_SUMMARY_CHARS` 20k, `brainstorm.mjs:27`, but a larger legacy brief rides in whole on read).
- `firstPlan`: remainder (title, retirement line, the three path bullets, open workers, takeover line).

Last three bug-chaser lead boots (raw `boot-size` metrics): 11-21 23:29Z first=54.7k (packet 15.3k, brief 34.8k), 11-22 23:51Z first=57.7k (packet 14.6k, brief 38.0k, total 74.3k = the p90), then 11-23 20:36Z first=10.9k and 11-24 21:06Z first=12.5k (packet 7.7k, brief 3.4k, total 28.8k). So the p90 is set by the 11-21/22 boots where the brief was ~35-38k chars; the brief has since been compacted. Pull-only mostly buys protection against that brief/packet growth, and a recent boot is already ~7k tokens.

Other lead spawn paths that do not go through a successor prompt (fresh lane lead from `vs lane`/Roster, Buddy restart `brainstorm.mjs:995`) are out of scope for EXP8.

## 2. Does a lean / pull-only boot mode exist?

No. Searched `lean boot|leanBoot|lean-boot|PLAN_LEAN_BOOT_1109|vs.boot|boot=pull|VS_BOOT`:
- "lean" in `server/lean-tools.mjs` + `agent-duties.ts:2671` is the Claude tool deny list (tool schemas), unrelated to the boot text.
- `server/boot-roster.mjs`, `agent-duties.ts:4635` (B1 auto-archive) and `cli/vs.mjs:2140` (B3 sweep) are the PLAN_LEAN_BOOT B1-B3 pieces. B2 bounds the roster/in-flight block (4k budget) but does not touch the packet, summary or artifact.
- Option 3 (pull-only) was never built. So EXP8 builds it, opt-in only.

## 3. Minimal opt-in design

**Switch.** Lane-level, set once, not per agent: team config lane field `boot: "pull"` (read through the existing `findLaneInRegistry`/`currentTeams()` the spawn hook already uses at `agent-duties.ts:2527-2531`); `VS_BOOT=push` env or a `vs.boot=push` label forces the control. Default is `push` (today). The arm is stamped as label `vs.boot=pull|push` on every lead spawn (same mechanism as the `wf` stamp, `agent-duties.ts:2495-2512`) so @usage can group by it, and the `boot-size` metric line gets one more field `boot=pull|push` (`bootSizeMetric`, `agent-duties.ts:1185`; `readBootSizes` in `providers-catalog.mjs:2966` needs one new group key: ask @usage, not built here).
Why lane-level and not a label on the lead: the successor is spawned with fresh labels (`lead-handoff.mjs:884-893`), so a label on the old lead would not reach it without touching that file.

**Dropped (replaced by a one-line pointer each):**
- `firstPacket` body: keep the first ~1.5k chars (header, Judgment, open workers), drop the rest. Pointer: the packet path already named in the prompt (`<teamHome>/.../handoff packet path`); agent reads it with its own file tools; log tail is `vs log --since-me`.
- `firstBrief` body: keep the first ~2k chars (the top of the brief is the current decision/plan state), drop the rest. Pointer: `docs/brainstorm/<lane>.md`, already named.
- Lane artifact (system prompt, ~4k): kept in phase 1 of the trial (durable source of truth after provider switches, per the lane-artifact rule). Pull form is `vs spec show` and is a second-stage change, not part of this arm.

**Kept (the "minimal first prompt"):** identity line, retirement/takeover line, the three path bullets (packet, summary, latest plan), open workers re-pointed, steer, takeover-confirm, rules prefix, profile notes, git snapshot, artifact, lessons.

**How the agent pulls.** Nothing new to teach: the dropped bodies already have paths in the prompt, and `vs spec show`, `vs who`, `vs log --since-me`, `vs status <agent>` exist (`cli/vs.mjs:540-562`). The slimmer boot text ends with a single line: "Packet and brief are truncated here; read `<packetPath>` and `<summaryPath>` before planning." That line is the only new prose, per the "code/config, not new prompt rules" constraint.

**Mechanism (one pure function).** New `server/boot-pull.mjs` exports `pullifyHandoffPrompt(prompt, {packetHead, briefHead})`: it finds the two marker blocks (same line-start markers `measureFirstPromptParts` uses) and truncates each body, leaving the markers and a `[... N chars omitted, read <path>]` line. Pure and fully unit-testable.
Where it is applied (decide in a 30-minute spike, step 0 of the build):
- Preferred: the before.agent.create hook in `agent-duties.ts`, on `(request).prompt` when role=lead, lane arm = pull, and `vs.handoff-from` label present. Open question: whether the hook's returned `next` can replace the first prompt (no existing writer of `next.prompt` found; hook reads `request.prompt` at `:2056`, `:2584`, `:2655`).
- Fallback if the hook cannot rewrite the prompt: a 3-line call right after `buildSuccessorPrompt` at `lead-handoff.mjs:866`. This is the clash file below.

## 4. Build touch set

| File | Change | Size |
|---|---|---|
| `server/boot-pull.mjs` (new) | `pullifyHandoffPrompt`, `laneBootArm(team, lane, env, labels)` | ~70 lines |
| `server/hooks/agent-duties.ts` | read arm, stamp `vs.boot` label, apply pullify (if the hook can), add `boot=` to `bootSizeMetric` (`:1185`) and its call (`:2656`) | ~25 lines |
| `server/teams.ts` / team-config schema (lane `boot` field) | accept + validate `boot: "pull"` | ~10 lines |
| `test/boot-pull.test.mjs` (new) | pure-function cases: truncation, marker integrity, partition sum still equals length (`measureFirstPromptParts`), push default unchanged | ~80 lines |
| `test/auto-failover-spawn.test.mjs` | extend the `bootSizeMetric` shape test with `boot=` | ~6 lines |
| `docs/lanes/bug-chaser/` lane config (team JSON, not code) | `boot: "pull"` for the arm; revert = delete the field | 1 line |
| @usage inbox ask | group `bootSize` by `boot=` and report per-arm first-turn $ (already `firstTurnCostUsd`) | not built here |

**Clash flag.**
- `server/lead-handoff.mjs`: only in the fallback path (one call at `:866`). Another unit (K2a/K2c) is editing it now. Prefer the hook path; if the spike forces the fallback, wait until K2a merges and rebase, or send the 3-line patch to that unit's lead.
- `server/compact-step.mjs`, `server/token-watch.mjs`: no overlap in either path.
- `server/hooks/agent-duties.ts`, `server/teams.ts`: no known overlap with the K2 unit, but both are hot files; touch via narrow hunks and rebase before merge.
- @bug-chaser is the arm, so their lead must OK before the config line lands (plan precondition).

**Estimated build:** ~190 lines incl. tests, 4-5 files, one worker block (normal stakes; the spawn hook is invariant-adjacent, so cross-provider review). Spike 30 min, build 2-3 hrs.

## 5. Measures and verdict rule

Arms: A = pull (bug-chaser leads, config `boot: "pull"`), B = push (the same lane's leads before the switch, plus other Claude leads over the same window). Need N >= 10 lead boots per arm. At bug-chaser's current rate (25 boots in ~3 days) this fits inside ~1 week. Because the 11-21/22 brief size dominated the push sample, compare against **boots with first >= 10k chars** only (the same brief state), or hold the brief size constant by recording `firstBrief` per boot.

| Measure | Source | Notes |
|---|---|---|
| `bootSize` p90 est tokens (and `total` chars) | usage export `bootSize`, grouped by `boot=` | primary size metric |
| first-turn $ | `firstTurnCostUsd` on agentV2 (`providers-catalog.mjs:575/1353`) | pull adds a tool turn, so this is the guard for cost going UP |
| first-try review PASS of units the lead dispatches | `firstTryPassRate` (`providers-catalog.mjs:1959`; reviewRounds <= 1) filtered to merges whose dispatching lead is in an arm | proxy for "lead has enough context to write good briefs" |
| lost-context signals | per arm, per boot: (a) the successor's first-hour `vs log --since-me`/packet-read count (pull should be 1-2; 0 means it skipped the pull), (b) owner or Overlord messages in the first hour that restate packet content, (c) `needs-you` entries or a duplicate dispatch of a unit already in the packet. Hand-tagged in this doc from the agent jsonl for the 10 pull boots; no new metric. | the real risk of pull |

**Verdict (decide once both arms have N >= 10):**
- **keep** (extend to other lanes): pull p90 est tokens <= 70% of push **and** first-turn $ not above push by more than 10% **and** first-try PASS within 5 pts of push **and** lost-context signals <= 1 in 10 boots.
- **change**: size win holds but one guard fails (e.g. first-turn $ up, or 2-3 lost-context signals): adjust the head sizes or move the packet head up, re-run for 10 boots.
- **ruled-out**: size win < 20%, or first-try drops > 10 pts, or lost-context signals >= 4 in 10, or first-turn $ up more than 25%. Fits EXP1's prior (the re-read tax of an extra pull turn on a warm context), so the default expectation is that the win is real only when the push boot is large (>= ~20k chars); at ~7k tokens (11-24 boots) the saving is small and `ruled-out` is the likely outcome.
- Early stop: if the pull arm shows >= 3 lost-context signals before N = 10, revert the lane config and record `ruled-out` with n.

Verdict line (to log): `vs log decision "@per EXP8 verdict keep|change|ruled-out: n=<a>/<b> bootSize p90 <x>k vs <y>k est tok, first-turn $<x> vs $<y>, first-try <x> vs <y>, lost-context <n>/10"`.

## Open
1. @bug-chaser lead consent to be the pull arm (precondition).
2. Phase 2 spike: can the spawn hook rewrite `request.prompt`? Decides the clash outcome.
3. @usage ask: group `bootSize` by `boot=` (arm) and attribute merged-unit first-try to the dispatching lead's arm.
