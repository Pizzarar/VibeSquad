---
id: context-guard
group: level2
level: 2
method: git
winget_id: n/a
verified: 2026-10-30 (script compiles; the low-threshold test in Setup/templates/hooks/README.md printed the soft warning once, nothing on repeat, and the hard warning on every later call)
licence: free
size: small
---

# Context guard (Claude Code only)

## When you want this
Level 2 only, and only if your provider is Claude Code: the hook runs inside Claude Code's settings and does nothing in
Codex, Gemini or OpenCode. It is an optional extra. Long agent sessions get expensive and fuzzy, because the agent re-reads everything every turn. This
small hook warns you (and the agent) when a session is getting long, so you can write a handoff and start fresh.

## Install (Windows)
Needs Python (core module) to run as `py`, not as the Microsoft Store shortcut (see the python module's advisory check). The files live in this kit:
- `Setup/templates/hooks/context_guard.py`
- `Setup/templates/hooks/settings.snippet.json`

Steps for the agent. The full steps live in `Setup/templates/hooks/README.md` (section "Install"); follow them, and show
the person the planned settings change before you make it:
1. Copy the script to `%USERPROFILE%\.claude\hooks\context_guard.py`:
   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\hooks" | Out-Null
   Copy-Item Setup\templates\hooks\context_guard.py "$env:USERPROFILE\.claude\hooks\context_guard.py"
   ```
2. **Fill in the snippet's two placeholders, then merge it.** Replace `<HOME>` with the person's real home folder as an
   absolute path with forward slashes (for example `C:/Users/<user>/`; get it from `$env:USERPROFILE`), and `<PYTHON>`
   with `py` on Windows (as in the python module) or `python3` on macOS. Never leave a `~` in the command. Why: `~`
   is not expanded on every Windows setup, so Python would look for a folder named `~` in the current project, and a
   repo could plant its own script there. Merge `Setup/templates/hooks/settings.snippet.json` into `%USERPROFILE%\.claude\settings.json`, never overwrite it.
   Back it up first. Three cases: no `"hooks"` key (add the whole object), `"hooks"` without `"PostToolUse"` (add
   the array), or `"PostToolUse"` already exists (**append** the snippet's one entry to the existing array). Then
   check the file is still valid JSON.
3. **Turn the hook on.** Without this it does nothing:
   - Level 1 (plain Claude Code): set `GUARD_ALWAYS=1` in the user environment or in the `env` section of
     `settings.json`.
   - Level 2 (VibeSquad): nothing to set. The runner gives every agent a `VS_ROLE` (`runner/runner.mjs:27-28`) and the hook warns roles listed in `GUARD_ROLES` (default `lead`; use `lead,brainstorm` to include Buddies). No Paseo CLI is needed. This hook is optional here: the VibeSquad server has its own token watcher for leads and Buddies (`server/token-watch.mjs:1`).
4. Thresholds can be changed with `GUARD_SOFT` and `GUARD_HARD` (defaults 100k and 150k tokens: plan the handoff, then hand off now). The README explains
   why those numbers.

## macOS line
`macOS: same steps with ~/.claude/hooks` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
py -I -m py_compile "$env:USERPROFILE\.claude\hooks\context_guard.py"
```
Expected: no output and exit code 0 (check with `$LASTEXITCODE`, expect `0`).

Then run the low-threshold test in `Setup/templates/hooks/README.md`, section "Test it" (it has a PowerShell and a bash
version). Expected: the 1st call prints the soft warning, the 2nd prints nothing, the 3rd and 4th print the hard
warning.

## First run (the human's steps)
1. Restart `claude` so it reads the new settings.
2. Nothing else. The warning only appears when a session grows long.

## Gotchas
- A broken settings.json stops Claude Code from loading it. Always keep a copy first
  (`Copy-Item $env:USERPROFILE\.claude\settings.json $env:USERPROFILE\.claude\settings.json.bak`).
- The hook is built to fail silently: no warning does not prove it is installed. Use the Verify test.
