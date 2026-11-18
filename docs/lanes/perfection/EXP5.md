# EXP5 · lead successor boot size (W1 follow-up to EXP1)

Read 1, 2026-11-17. Verdict: **change** (build is @bug-chaser/@usage config/code, nothing built here).

## 1. Boot size per role
Source: `boot-size` metrics in `~/.vibesquad/teams/*/log.jsonl` + `logs/*.jsonl`, since 2026-11-08, deduped on lane|ts|text[:60] (same rule as `readBootSizes`). Raw chars, ~4 chars/token. Part means use only rows that carry a breakdown.

| Role | n | p50 | p90 | max | over 20k | mean sys | plugin | artifact | brief | first |
|---|---|---|---|---|---|---|---|---|---|---|
| lead | 156 (151 with parts) | 36,362 | **44,477** | 90,297 | 140 | 6,957 | 10,716 | 2,864 | 0 | **18,128** |
| brainstorm | 68 | 6,252 | 11,510 | 48,782 | 1 | no breakdown logged | | | | |
| worker | 3,260 (3,162 with parts) | 10,657 | 13,262 | 31,353 | 22 | 1,477 | 4,433 | 3,171 | 0 | 1,346 |

Brainstorm rows are old-format (`chars`/`brief` only), so their parts are unknown. Lead p90 of `first` alone is 28.7k, past the whole 20k line.

## 2. What drives lead boot over 20k
Lead `sys` (7.0k) + `plugin` (10.7k) are fixed overhead (about 17.7k, same order as a worker's 5.9k plus the lead rules). Even with `first` at 0 a lead lands near 18k. The swing is `first`: mean 18.1k, p90 28.7k, and it is 52% of the lead mean. 139 of 151 leads are over 20k, so trimming `first` alone would not clear the line for every lead, but it is the only variable part.

`first` by lane (mean chars): art-direction 63.8k (n=1), ui-bois 42.5k (n=1), bug-chaser 32.7k (n=12), vibesquad 25.3k, android-app 23.0k, perfection 22.2k, art-pipeline 17.9k, efi 14.1k. Long-lived lanes with a big TASKS.json/handoff run biggest.

Three real successor packets (`~/.vibesquad/teams/vibesquad/handoff-*.md`):

| Packet | Size | What makes it big |
|---|---|---|
| bug-chaser ord25 | 12.0k | `## Auto State` is 9.9k of it. Of that, 60 `needs-you` lines = 6.3k (56 are `(old)` stale lead lines, mostly "Lead at 150k+ tokens: wrap up..." from earlier leads), 14 `metric plugin:` lines (boot-size, hook-timing, route-agent) = 2.2k, decisions 0.7k. The real judgment is 2.4k. |
| android-app ord6 | 9.0k | Auto State 8.9k: 47 `needs-you` lines = 5.0k (38 `(old)`, some from 11-11), 16 `metric plugin:` lines = 2.6k. Judgment section is empty. |
| ui-bois ord6 | 24.0k | "Synthesized at 300k hard cap" packet: `## In flight` 13.8k (hand-pasted dated narrative lines of 300-650 chars), `Recent vs log` 5.4k, Decided 3.2k. |

So: about 70-75% of an auto-built packet's Auto State is stale `(old)` needs-you lines (about 5-6k) and plugin metric noise (about 2-2.5k) that no successor acts on. The handoff packet is only 9-24k though, and bug-chaser's `first` is 32.7k mean. The rest of `first` is the lane artifact (SPEC + TASKS.json; bug-chaser TASKS.json is 34.7k bytes on disk, perfection's 21.3k) plus plan text. I did not capture the exact `first` composition per spawn: only the total is logged. That gap is itself a finding (see request below).

## 3. Hypothesis + experiment
H: dropping `(old)`-labelled needs-you lines and `metric plugin:` lines from the handoff Auto State, and capping the TASKS.json block in the lane artifact to open units only (done units as a count, as the perfection lane already does with "45 done units"), cuts lead `first` by 25-35% (about 5-7k chars) with no change in successor first-turn quality.

Config/code change (not prompt rules), owner: **@bug-chaser** (lead-handoff.mjs packet builder, `logEntries.slice(-30)` and needs-you filter near `server/lead-handoff.mjs:404`; lane artifact TASKS rendering). Boot-size attribution metric ask goes to **@usage** inbox: split `first` into `handoff`, `taskjson`, `spec`, `plan` (current stamp has only `first`).

Yardstick (arms: before = 11-08..11-17 leads above; after = leads spawned after the change merges, same lane mix, at least 20 leads):
- Primary: lead p90 `total`, and mean `first`.
- Guard 1: successor restarts per lane in the first hour (a lead that re-asks for lost state shows as `needs-you`/repeat reads); must not rise.
- Guard 2: no lost live needs-you (spot check 5 packets: every non-`(old)` needs-you still present).

Thresholds:
- keep (change worked): `first` mean down at least 25% (<= 13.6k) and lead p90 total <= 36k with guards flat. Ship permanently.
- change again: `first` down under 10% -> the weight is in the lane artifact, not the packet; trim TASKS.json/SPEC next.
- revisit pull-only (EXP1) only if lead p90 total stays > 30k after both trims.

## 4. Verdict for this read
**change** (EXP1's "revisit if p90 > ~20k" line is crossed for leads: p90 44.5k, 140 of 156 over). Worker and Buddy boot stay under the line, so EXP1's pull-only ruling still stands for them. Evidence is adequate for "change": n=156, the stale-line share is measured on three packets, not the whole population (sample, not census). Build work: @bug-chaser (packet/artifact trim), @usage (split `first` metric). Not built here.
