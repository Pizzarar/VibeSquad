---
id: git
group: core
level: 1
method: winget
winget_id: Git.Git
verified: 2026-10-30 (2.56.0.4)
licence: free
size: small
---

# Git

## When you want this
Git saves the history of your projects, so you can undo mistakes and try ideas safely. Your agents also use it
(it provides "Git Bash", which Claude Code can use to run commands). Install this first.

## Install (Windows)
```powershell
winget install --id Git.Git --exact --accept-package-agreements --accept-source-agreements
```
Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad (or open a **new** terminal window if you are doing this by hand). Use `Git.Git`, not `Microsoft.Git`.

## macOS line
`macOS: brew install git` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
git --version
```
Expected: matches `^git version \d+\.\d+\.\d+` (for example `git version 2.56.0.windows.4`).

## First run (the human's steps)
None. Your name and email for commits are set in the logins phase.

## Gotchas
- `git` not found right after install: you're in the old window. Open a new one.
- Official download page, if winget is unavailable: https://git-scm.com/downloads/win (cited by the Claude Code docs).
