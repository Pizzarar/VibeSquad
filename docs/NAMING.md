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

## Core Model: Squad, Feature Lane, and Buddy

- **Squad (`team`)**: The product-level umbrella (one Squad per project card, e.g. `VibeSquad` = the VibeSquad squad, `Personal Site` = the personal site squad, `Escape From Idle` = the Escape From Idle squad). Internally stored as `team` in `teams.json` (`team=` label, derived from `lane`).
- **Feature Lane (`lane`)**: The unit inside a Squad — one **Buddy** (`role=brainstorm`, `"TALK HERE"`) + one **Lead** (`role=lead`, `"RUNS THE WORK"`, spawned at plan handoff) + their **Workers** (`role=worker`), working on one feature of that product. Internally stored as `lane` in `teams.json` (`lane=` label).
- **Mascot `"Buddy"`**: The brainstorm role keeps its label (`role=brainstorm`) and title format (`BRAINSTORM · <LANE>` or `BRAINSTORM · <LANE> · <topic>`), and its mascot / friendly name is **Buddy** (shown in the UI on the Roster's `TALK HERE` card, empty card, and cast sprite labels).
- **Multiple Buddies per Squad**: A Squad can have several live Buddies and several live Leads at once — one live Buddy and one live Lead **per Feature Lane** (`(team, lane)`), plus topic-scoped Buddies (`(team, lane, topic)`). There is NO "one live brainstorm per project/squad" limit. All Feature Lanes in a Squad share the same Squad `vs log` (`~/.vibesquad/teams/<team>/log.jsonl`) so `vs log --since-me` surfaces `[decision]`, `[aub]`, and `[needs-aub]` entries across the whole Squad.
- **Trigger Phrase `"Spin up a buddy (for X)"` & `"+ ADD BUDDY"` button**:
  - When the user says `"spin up a buddy"`, `"spin up another buddy"`, `"get me a buddy for X"`, or clicks **"+ ADD BUDDY"** on a Squad card, check whether `X` overlaps an existing Buddy / Feature Lane in the Squad (`vs who brainstorm` and `vs log --since-me` for files or feature scope).
  - If it overlaps, flag the overlap and suggest using that existing Buddy instead.
  - Otherwise create a new Feature Lane (`lane=<slug>`) under the Squad (`team=<squad>`) and spawn its Buddy (`role=brainstorm`, `title: BRAINSTORM · <LANE> · <topic X>` or `BRAINSTORM · <LANE>`) with a 2–3 line context brief. Its Lead is spawned later at plan handoff (looked up via `vs who lead`).

## Roles, Labels, and Title Format

| Role | Labels | Title |
|---|---|---|
| Lead | `lane`, `role=lead`, `ord=N` (plus derived `team`) | `★ <LANE> ordN` (e.g. `★ VIBESQUAD ord1`) |
| Retired lead | same, with `role=former-lead` | `(old) <LANE> ordN` |
| Brainstorm (Buddy) | `lane`, `role=brainstorm` (plus optional `topic`) | `BRAINSTORM · <LANE>` or `BRAINSTORM · <LANE> · <topic>` (lane first, required) |
| Retired brainstorm | same, with `role=former-brainstorm` | unchanged (not rewritten) |
| Worker | `lane`, `role=worker`, `job` | `<LANE> · <job>` |

"TALK HERE" is shown in the UI on the lane's active Buddy / brainstorm card (primary top slot), and "RUNS THE WORK" is shown on the lead card (secondary style unless `needs-aub` is set). Never include `(talk here: …)` in lead or brainstorm titles.

## Lane integrity
- Each **Feature Lane** (`(team, lane)`) has at most **one live lead and one live main Buddy (`role=brainstorm`)** (plus optional topic-scoped Buddies per `(team, lane, topic)`), while a **Squad** (`team`) can run multiple Feature Lanes in parallel.
- Spawning a successor or a replacement brainstorm in the same `(team, lane, topic)` slot sets `role=former-lead` / `role=former-brainstorm` on the predecessor (slim server plugin on `agent.created`, and `spawnTeamAgent` in the UI as a fallback).
- If more than one live one is found in the same lane slot anyway, the lane shows `DUPLICATE LIVE LEAD/BRAINSTORM · RETIRE ONE` with a two-tap retire button. No extra Squad/project rows are ever created.
