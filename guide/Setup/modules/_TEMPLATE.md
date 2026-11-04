---
id: example-tool
group: core            # core | providers | game | art | pixel | fab | level2
level: 1               # 1 = everyone, 2 = only if the person chose Level 2
method: winget         # winget | web | licence-pointer | git | npm | doc-only
winget_id: Publisher.Package   # or "n/a"
verified: UNVERIFIED   # "YYYY-MM-DD (version)" once `winget show --id <id> --exact` resolved, else UNVERIFIED
licence: free          # free | paid | personal | own
size: small            # small (<200 MB) | medium (200 MB to 1 GB) | large (>1 GB); detail in a # comment
---

# Example Tool

## When you want this
One or two plain sentences: what it is and why this person would want it.

## Install (Windows)
```powershell
winget install --id Publisher.Package --exact --accept-package-agreements --accept-source-agreements
```
Then run the PATH refresh from `START_HERE.md` (PATH only updates in new windows, and the agent can't open one):
```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```
If the agent's shell is Git Bash, run the check as `powershell -NoProfile -Command '<refresh>; <check>'`
(`START_HERE.md` has the exact form). If Verify still fails, restart your chat in VibeSquad.
Cite the official page for any non-winget method.
Never guess a URL: only write pages you have actually checked.

## macOS line
`macOS: brew install example`   (UNVERIFIED unless tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
example --version
```
Expected: output matching `^example \d+\.\d+` (say exactly what a good result looks like).

## First run (the human's steps)
1. Short numbered steps for what the person does in the app (sign-in, licence, "open it once").

## Gotchas
- Known traps, one line each.
