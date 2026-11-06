# VibeSquad Default Profile Pack (19 Profiles)

VibeSquad owns its portable 19-profile store in `~/.vibesquad/profiles.json` (`server/profiles.mjs` and `src/profiles.ts`). Every default profile note is project-agnostic (zero repo-specific paths or project names).

## Shared Note Prefix & Guardrails

- To find your current lead: run `vs who lead`. It returns the single live lead for your team and lane (never `(old)` or `former-lead`), or `NONE` / `CONFLICT`. Check existing lane Buddies with `vs who brainstorm`.
- **R1 (Search/Read):** Use your provider's native search/read tools. If you must use the shell, cap the output (`| head -50`, `-m`, `Select-Object -First`).
- **R3 (Images):** Don't re-read an image file you've already seen unless it changed. Take screenshots at the needed size, not full-page tall captures.
- **R4 (Large files):** For files over ~30k chars, grep first, then read with offset/limit. Never re-read from byte 0.
- **R6 (Waiting):** Wait on agents with `paseo wait <id> --timeout <s>` (always with a timeout). No sleep/poll loops.
- **R2/R7 (Git state):** Git state in the spawn context is a starting point only. Re-check right before commit/push/merge, not every turn. Fetch at most once per worktree per hour unless about to merge.
- **R8 (Worktrees & Lanes):** Address feature lanes by their `@<code>` handle (e.g. `@bug`, `@ade`, `@uip`, `@art`). Create linked git worktrees only via `vs worktree create <unit>` (stored in the managed worktree sanctuary, never as sibling folders in the projects directory), and sweep merged worktrees with `vs worktree sweep --apply`.
- **R9 (Owner shorthand & interrupts):** Decode keyboard/phonetic shorthand silently (`dameon`→daemon, `emini`→gemini, `paseo la`→paseo ls, `gold`→hold, `sotpped`→stopped, `ahvent`→haven't). Translate mechanism suggestions into cleaner primitives (`vs who`, worktree sanctuary, role-tier failover) and record the translation in Decided. Treat `/btw` / `also` / `on another note` as separate queued units, split multi-item dumps into parallel `@lane` units, and treat short approvals (`send it`, `go for b`, `do it`) as terminal go-signals.
- **R10 (Releases):** Never run release, publish, tag or signing scripts yourself. When the owner asks for a release, send `vs log handoff "release <project> <stable|beta> <commit|branch>" -> Release Desk` plus a Paseo message to the Release Desk Buddy (`vs who brainstorm --lane release-desk`) with the change list and credits, then go back to your work. The desk versions, audits, signs, publishes and reports back.

## Squad, Feature Lane & Buddy Model

- **Squad (`team`)**: One Squad per product card. A Squad can run multiple **Feature Lanes** (`lane`) in parallel, each with a standardized `@<code>` handle.
- **Durable Lane Specs & Task Lists**: Each lane keeps `docs/lanes/<lane>/SPEC.md` and `TASKS.json` (`vs spec @<lane>`, `vs task @<lane> list|add|done`), plus recurring lessons in `docs/LESSONS.md` (`vs lesson add|search|digest`).
- **Role-Tier Failover (`vs cap`)**: Automatic multi-hop failover (`Claude → Gemini → DeepSeek`) when a provider is over quota (`>=95%`) or marked capped (`vs cap set <provider>`).
- **Buddy (`role=brainstorm`)**: Friendly mascot name for the brainstorm role (`Brainstorm - Claude`, `Brainstorm - Gemini`). Each Feature Lane has 1 live Buddy (`TALK HERE`) and 1 live Lead (`RUNS THE WORK`).
- **Shared Squad Log**: All Feature Lanes in a Squad share `~/.vibesquad/teams/<team>/log.jsonl` via `vs log --since-me`.
- **Prior-Art Check Rule** (included in both Brainstorm and Lead profile notes):
  - Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section.
- **Lead Context Management (`Lead - Claude`, `Lead - Gemini`)**:
  - Context management: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k.
- **`"Spin up a buddy (for X)"` Trigger Rule** (included in both Brainstorm and Lead profile notes):
  - When the user says `"spin up a buddy"`, `"spin up another buddy"`, or `"get me a buddy for X"`, spawn a new Buddy (`role=brainstorm`, title `BRAINSTORM · <LANE> · <topic X>`) in a new feature lane (`lane=<slug from X>`) under the same Squad (`team=<product>`).
  - First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if `X` overlaps an existing Buddy, flag the overlap and suggest using that Buddy instead.
  - Otherwise spawn the new Buddy with a 2–3 line context brief (its Lead is spawned later at plan handoff).
- **JSON Writing Rule (`Lead - Claude`, `Lead - Gemini`)**:
  - Write JSON files with `node` (e.g. `fs.writeFileSync(..., 'utf8')`), never PowerShell `Set-Content` (which writes a UTF-8 BOM that breaks JSON parsers).
- **Art Painter + Art Director Loop (`Art Painter - Opus`, `Art Director - Gemini`)**:
  - Standard for all artwork (sprites, icons, emblems, and UI screens). `Art Painter - Opus` (`agent_profile_mvwjrb2k_enr1rgj8hg5`) edits code/assets using curated palettes, renders a 4x gallery PNG (or UI screenshot), and sends the image path to `Art Director - Gemini` (`agent_profile_mvso6xcl_hk9afi1fz2r`). The Director never opens the source code, judges only the image and brief against standing visual gates, and returns numbered PASS/FAIL fixes (max 4 rounds).
