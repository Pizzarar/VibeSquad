# VibeSquad Default Profile Pack (19 Profiles)

VibeSquad owns its portable 19-profile store in `~/.vibesquad/profiles.json` (`server/profiles.mjs` and `src/profiles.ts`). Every default profile note is project-agnostic (zero repo-specific paths or project names).

## Shared Note Prefix & Guardrails

- To find your current lead: run `vs who lead`. It returns the single live lead for your team and lane (never `(old)` or `former-lead`), or `NONE` / `CONFLICT`. Check existing lane Buddies with `vs who brainstorm`.
- **R1 (Search/Read):** Use your provider's native search/read tools. If you must use the shell, cap the output (`| head -50`, `-m`, `Select-Object -First`).
- **R3 (Images):** Don't re-read an image file you've already seen unless it changed. Take screenshots at the needed size, not full-page tall captures.
- **R4 (Large files):** For files over ~30k chars, grep first, then read with offset/limit. Never re-read from byte 0.
- **R6 (Waiting):** Wait on agents with `paseo wait <id> --timeout <s>` (always with a timeout). No sleep/poll loops.
- **R2/R7 (Git state):** Git state in the spawn context is a starting point only. Re-check right before commit/push/merge, not every turn. Fetch at most once per worktree per hour unless about to merge.

## Squad, Feature Lane & Buddy Model

- **Squad (`team`)**: One Squad per product card. A Squad can run multiple **Feature Lanes** (`lane`) in parallel.
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
