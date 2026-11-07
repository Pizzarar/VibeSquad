# Context guard hook (Claude Code only)

`context_guard.py` warns a session when its context grows past the handoff marks. It is a Claude Code
`PostToolUse` hook: after each tool call it reads the session's latest token usage and, past a mark,
adds a short message to what the agent sees.

## Why these numbers

Every turn re-reads the whole context. Long Lead sessions that ran to 450-580k tokens were slow,
expensive and increasingly fuzzy. The rule: start planning the handoff at 100k, hand off by 150k at
the latest, and never go past 200k. You lose little by stopping there and gain a lot by not carrying
a huge context forward.
Treat 100k/150k as a starting point and tune them with `GUARD_SOFT` / `GUARD_HARD`.

- At the **soft** mark (default 100k) the warning appears **once**: stop dispatching, write the handoff.
- At the **hard** mark (default 150k) it appears on **every** tool call: hand off now.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_SOFT` | `100000` | Soft mark, in tokens |
| `GUARD_HARD` | `150000` | Hard mark, in tokens |
| `GUARD_ALWAYS` | unset | `1` = warn every session that has the hook (use this at Level 1) |
| `GUARD_ROLES` | `lead` | *(Level 2)* Comma list of `VS_ROLE` values to warn. The runner sets `VS_ROLE` on every agent it starts (`runner/runner.mjs:27-28`). A Buddy's role is `brainstorm`, so use `lead,brainstorm` to warn Buddies too. A retired agent's role label becomes `former-...` (`server/identity.mjs:70`), so it stops matching |

Without `GUARD_ALWAYS=1` and without a matching `VS_ROLE`, the hook does nothing. It never prints errors
and never blocks: if anything goes wrong it exits quietly. No Paseo CLI is needed.

VibeSquad's server also watches lead and Buddy context on its own (`server/token-watch.mjs:1`, started at `server/serve.mjs:598`), so at Level 2 this hook is optional.

## Install

1. Copy the script: `~/.claude/hooks/context_guard.py` (create the folder if needed).
2. Fill in the snippet's placeholders: `<HOME>` becomes your home folder as an absolute path with forward slashes
   (for example `C:/Users/<user>/`), `<PYTHON>` becomes `py` on Windows or `python3` on macOS. Do not leave a `~` in
   the command: it is not expanded on every Windows setup, so Python could run a `~` folder from the current project.
   Then merge `settings.snippet.json` into `~/.claude/settings.json` **without overwriting it**:
   - Back it up first: copy `settings.json` to `settings.json.bak`.
   - If the file has no `"hooks"` key, add the snippet's whole `"hooks"` object.
   - If it has `"hooks"` but no `"PostToolUse"`, add just the `"PostToolUse"` array.
   - If it already has `"PostToolUse"`, append the snippet's one entry (`{ "matcher": "*", ... }`) to
     that existing array. Do not replace the array.
   - Keep every other key as it is. Then check the result is valid JSON:
     `py -I -m json.tool <path to settings.json>` (it should print the file, not an error). In PowerShell
     write the path as `"$env:USERPROFILE\.claude\settings.json"`, because `~` is not expanded for every program.
3. Level 1: set `GUARD_ALWAYS=1` in your user environment (or in the `env` section of `settings.json`).
   Level 2: nothing to set; Leads are matched by their `VS_ROLE` (add Buddies with `GUARD_ROLES=lead,brainstorm`).
4. Run the test below, then restart Claude Code so it picks up the hook.

## Test it (low thresholds)

From any scratch folder outside this repo.

**PowerShell** (the default on Windows). `Set-Content -Encoding ascii` matters: Windows PowerShell 5's `>` writes
UTF-16, and `-Encoding utf8` adds a byte-order mark. Either one makes the hook fail silently.

```powershell
$guard = "$env:USERPROFILE\.claude\hooks\context_guard.py"   # or the path of the copy in this kit
New-Item -ItemType Directory -Force guard-test | Out-Null; Set-Location guard-test
Set-Content -Encoding ascii t.jsonl '{"message":{"usage":{"input_tokens":2000,"cache_read_input_tokens":500,"cache_creation_input_tokens":0}}}'
Set-Content -Encoding ascii hook.json '{"transcript_path":"t.jsonl","session_id":"test1"}'

Remove-Item Env:VS_AGENT_ID -ErrorAction SilentlyContinue   # else the state file is keyed by it and repeat runs print nothing
$env:GUARD_ALWAYS = '1'; $env:GUARD_SOFT = '1000'; $env:GUARD_HARD = '3000'
Get-Content hook.json | py -I $guard   # 2500 >= soft: prints the soft warning
Get-Content hook.json | py -I $guard   # same session again: prints nothing

$env:GUARD_HARD = '2000'
Get-Content hook.json | py -I $guard   # 2500 >= hard: prints the hard warning
Get-Content hook.json | py -I $guard   # and again: the hard warning repeats on every call
```

**bash or Git Bash:**

```
mkdir guard-test && cd guard-test
# a fake transcript line with 2500 tokens of usage
echo '{"message":{"usage":{"input_tokens":2000,"cache_read_input_tokens":500,"cache_creation_input_tokens":0}}}' > t.jsonl
echo '{"transcript_path":"t.jsonl","session_id":"test1"}' > hook.json

unset VS_AGENT_ID   # else the state file is keyed by it and repeat runs print nothing
export GUARD_ALWAYS=1 GUARD_SOFT=1000 GUARD_HARD=3000
python -I context_guard.py < hook.json   # 2500 >= soft: prints the soft warning
python -I context_guard.py < hook.json   # same session again: prints nothing (soft is once only)

export GUARD_HARD=2000
python -I context_guard.py < hook.json   # 2500 >= hard: prints the hard warning
python -I context_guard.py < hook.json   # and again: the hard warning repeats on every call
```

Use the real path to `context_guard.py` (for example `python -I ~/.claude/hooks/context_guard.py`).
Each warning is one line of JSON containing `additionalContext`. To repeat the test, delete the state
file folder `context_guard` inside your system temp directory, or change `session_id` in `hook.json`.
