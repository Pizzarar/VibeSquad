# EXP3: compact-first before restart/handoff (W3 / K2)

Lead: Per8. Opened 2026-11-09. K2 compact step went live with the runner restart at 19:11Z (with K0/K1/K4). Build: `server/compact-step.mjs`, `server/token-watch.mjs`, `server/lead-handoff.mjs` (@bug-chaser, `docs/PLAN_COMPACT_IN_PLACE_1108.md` K2).

## Question
At the soft threshold, a Claude Buddy or lead now runs `/compact` before the restart/handoff ladder. Is that better than handing off right away? It has to be cheaper and no worse in quality.

## Arms
- compact: `compact-step <kind> ... outcome=ok`. The agent keeps its id and runs on after compacting.
- handoff: `compact-step ... -> falling through to handoff`, or a handoff with no compact step (agy lanes, pre-K2 history 11-06..11-09 as the baseline).

## Measures (from the vs log + usage export, no new metrics)
1. Outcome mix: ok vs fall-through count and %. Fall-through reasons: still over the cap, failed, timed out.
2. Token drop: `before` -> `after` per ok compaction, median.
3. Runway: turns and time until the next threshold crossing after a compaction, compared with the runway of a fresh successor after a handoff.
4. Cost: the compaction turn ($ and tokens) against the handoff overhead (successor boot + takeover turns until its first `vs log decision`). The @usage `floor.restartOverheadCostUsd` bucket is the cross-check.
5. Quality guard: first-try review PASS rate and fix-after-merge for units dispatched in the 2h after a compaction, against the 2h after a handoff. Hand-kept until @usage idea-38/51 fix the round parse. Also flag repeat questions or a lost plan, where the owner or Hub has to re-send context.

## Decision rule
- **keep**: ok rate >= 70%, compact cost < handoff overhead, and the quality guard is no worse by more than 10 pts.
- **change**: ok rate < 70% (tune the threshold, the focus text or the cap in `compact-step.mjs` and file the change with @bug), or the quality guard drops by more than 10 pts. In the second case go back to handoff-first for that role.
- **ruled-out**: compactions rarely leave the agent below the cap, so it falls through to handoff anyway.

## Window
Read on/after 2026-11-11, or once there are >= 10 compact-step events, whichever comes later. Claude lanes only; agy waits until its compact path is known.

## Notes
- K4 (trimmed Claude Code base) also went live at 19:11Z, so per-turn context after that point is smaller. Don't mix pre- and post-19:11Z runway numbers without saying so. This also lowers the boot share in EXP1 further.

## Tally
| ts | agent | kind | outcome | before | after | runway (turns / h) | notes |
|---|---|---|---|--:|--:|---|---|

## Read 2026-11-11
Source: `~/.vibesquad/teams/*/log.jsonl`, `grep -h "compact-step" */log.jsonl` (type=metric lines only; the EXP3-open decision line excluded). Window 2026-11-09T22:27Z .. 2026-11-11T05:05Z, Claude lanes only (all 10 events are Claude).

| measure | result | source / query |
|---|---|---|
| 1. events | 10 (8 ok, 2 fall-through) | `grep -h compact-step */log.jsonl` |
| 1. ok rate | 80% (8/10) | same |
| 1. fall-through reasons | 1 timeout (art-direction buddy, before=152753, 125.6s), 1 failed (art-direction lead, before=158688, 2.5s); 0 "still over cap" | same |
| 2. token drop (ok) | median before 152,286 -> after 11,787 (-92%); after range 9,620..13,815 | `before=`/`after=` fields |
| 2. compact duration (ok) | median 56.8s (47.3..74.1s) | `ms=` field |
| 3. runway | not measurable: 8 ok agents are all distinct, none has hit a second threshold since compacting | no repeat `agent=` in compact-step lines |
| 4. cost | $ not in the compact-step metric (only ms). Handoff context: 25 `type=handoff` log lines since 2026-11-09T19Z. `restartOverheadCostUsd` appears only in runner agent files, not aggregated here | `grep -c '"type":"handoff"'`; `grep -rl restartOverheadCostUsd ~/.vibesquad` |
| 5. quality guard | not computed (hand-kept, idea-38/51 round parse not fixed; 10 events is too few for 2h post-windows) | n/a |

Tally: 8 ok = bug-chaser x3, vibesquad x2, ui-bois, release-desk, android-app; the 2 fall-throughs are both art-direction.

**Verdict: not-enough-data.** Outcome mix passes the keep bar (80% >= 70%) and the drop is large, but runway, compaction-turn $ vs handoff overhead and the quality guard are all unmeasured, so keep can't be called. No config change. Provisional lean is keep.

Next: re-read once an ok-compacted agent crosses the threshold again (runway) and @usage exposes compaction-turn $ (ask: add `costUsd`/`tokens` to the compact-step metric). Watch art-direction: both fall-throughs came from that lane within an hour (11-09 22:27 and 23:28).
