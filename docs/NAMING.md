# VibeSquad Naming Standard v2 (Identity v2)

## Principle
- **Lane is the single identity fact.** An agent carries `lane`, `role` (`lead|brainstorm|worker|former-*`), and `ord` (leads), plus `profile`/`job`. Squad (`team`), current lead, and display title are derived from `lane` via the `teams.json` lane registry (`server/identity.mjs` and `src/identity.ts`).
- **Keep `ord`:** The `ord` → `gen` rename was cancelled on 2026-10-31 due to cross-project scope; `ord` remains the standard lead counter (`labels.ord`).
- **Labels are the source of truth; titles are generated from them for display only.** Nothing in plugin, server, CLI, or UI matches on agent names or title prefixes (`★`, `BRAINSTORM`, `(old)`, `ordN`) to determine role, retired status, ord, or lane. A lint *flags* titles that don't match `formatDisplayTitle`, with a `Fix title` button for live agents only. Retired, closed and archived agents are never rewritten.
- **The model or profile is never in a title.** The sprite and frame already show the provider.
- **Resolution order (`resolveAgentIdentity`):**
  1. `labels.lane` (or legacy `labels.lead`) matched against the `teams.json` lane registry (`id`, `name`, or `aliases`).
  2. `cwd` (or git worktree `.git` `gitdir:`) matched against registered lane/team `paths` (`lane-autofix`).
  3. 2-week legacy `labels.team` fallback (`team-label-fallback`).
  4. `paseo.parent-agent-id` parent chain (depth 8).
  5. Otherwise marked `orphan=1` and placed in the UI **Unassigned** tray (`_unassigned`).

## Core Model: Squad > Team > Brainstorm > Lead / Workers

UI and docs use these names (Aub, 2026-11-01). Labels, `teams.json` keys and code identifiers do **not** change: a Team is still a `lane`, a Squad is still a `team`.

- **Squad** (`team` in labels and `teams.json`): the top-level sidebar entry, one per product (e.g. `Escape From Idle`, `VibeSquad`, `Personal Site`).
- **Team** (`lane` in labels and `teams.json`): one feature inside a Squad (e.g. Scavenging UI). A Team is **pinned** automatically when it's created and stays on the squad page until Aub marks it complete (`state: "done"`, Done shelf, can be reopened). It holds one **Brainstorm**, one **Lead** (spawned at plan handoff) and the Lead's **Workers**.
- **Brainstorm** (`role=brainstorm`): the head of a Team, the one you talk to (`"TALK HERE"`). The UI says "Brainstorm", never "Buddy". Its title format is unchanged (`BRAINSTORM · <LANE>` or `BRAINSTORM · <LANE> · <topic>`).
- **Lead / Workers** (`role=lead`, `role=worker`): run the work for a Team. Hidden on the default squad page; the **FULL** toggle shows them.
- **Pin the feature, not the agent.** Clicking a Team opens its live Brainstorm, or starts a fresh one from the Team brief (`docs/brainstorm/<lane>.md`). Agent IDs, `(old)` rows, workers and worktrees are plumbing and stay behind FULL.
- **Multiple Teams per Squad**: one live Brainstorm and one live Lead **per Team** (`(team, lane)`), plus topic-scoped Brainstorms (`(team, lane, topic)`). There is no "one live brainstorm per squad" limit. All Teams in a Squad share the Squad `vs log` (`~/.vibesquad/teams/<team>/log.jsonl`) so `vs log --since-me` surfaces `[decision]`, `[you]` and `[needs-you]` entries across the whole Squad.
- **Trigger phrase `"Spin up a buddy (for X)"` and the `+ TEAM` button** (the phrase is kept so existing habits still work):
  - When the user says `"spin up a buddy"`, `"get me a brainstorm for X"`, or clicks **+ TEAM** on a squad page, check whether `X` overlaps an existing Team in the Squad (`vs who brainstorm` and `vs log --since-me` for files or feature scope).
  - If it overlaps, flag the overlap and offer that Team instead.
  - Otherwise create a new Team (`lane=<slug>`) under the Squad (`team=<squad>`) and spawn its Brainstorm (`role=brainstorm`, `title: BRAINSTORM · <LANE> · <topic X>` or `BRAINSTORM · <LANE>`) with a 2–3 line context brief. Its Lead is spawned later at plan handoff (looked up via `vs who lead`).

## Roles, Labels, and Title Format

| Role | Labels | Title |
|---|---|---|
| Lead | `lane`, `role=lead`, `ord=N` (plus derived `team`) | `★ <LANE> ordN` (e.g. `★ VIBESQUAD ord1`) |
| Retired lead | same, with `role=former-lead` | `(old) <LANE> ordN` |
| Brainstorm | `lane`, `role=brainstorm` (plus optional `topic`) | `BRAINSTORM · <LANE>` or `BRAINSTORM · <LANE> · <topic>` (lane first, required) |
| Retired brainstorm | same, with `role=former-brainstorm` | unchanged (not rewritten) |
| Worker | `lane`, `role=worker`, `job` | `<LANE> · <job>` |

"TALK HERE" is shown in the UI on the Team's active Brainstorm card (primary top slot), and "RUNS THE WORK" is shown on the lead card (secondary style unless `needs-you` is set). Never include `(talk here: …)` in lead or brainstorm titles.

## Lane integrity
- Each **Team** (`(team, lane)`) has at most **one live lead and one live main Brainstorm (`role=brainstorm`)** (plus optional topic-scoped Brainstorms per `(team, lane, topic)`), while a **Squad** (`team`) can run multiple Teams in parallel.
- Spawning a successor or a replacement brainstorm in the same `(team, lane, topic)` slot sets `role=former-lead` / `role=former-brainstorm` on the predecessor (slim server plugin on `agent.created`, and `spawnTeamAgent` in the UI as a fallback).
- If more than one live one is found in the same lane slot anyway, the lane shows `DUPLICATE LIVE LEAD/BRAINSTORM · RETIRE ONE` with a two-tap retire button. No extra Squad/project rows are ever created.
