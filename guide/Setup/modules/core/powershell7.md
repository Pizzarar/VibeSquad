---
id: powershell7
group: core
level: 1
method: winget
winget_id: Microsoft.PowerShell
verified: 2026-10-30 (7.6.9.0)
licence: free
size: medium
---

# PowerShell 7

## When you want this
A newer, nicer version of PowerShell (the built-in one is "Windows PowerShell 5"). Scripts and agents behave more
predictably on it. It installs next to the old one; nothing is replaced. Recommended, but optional.

## Install (Windows)
```powershell
winget install --id Microsoft.PowerShell --exact --accept-package-agreements --accept-source-agreements
```
Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad (or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install --cask powershell` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
pwsh -v
```
Expected: matches `^PowerShell 7\.\d+\.\d+`.

## First run (the human's steps)
1. Optional: in Windows Terminal, open the tab menu and pick **PowerShell** to use the new one.

## Gotchas
- The command is `pwsh`, not `powershell`. `powershell` still starts the old version.
