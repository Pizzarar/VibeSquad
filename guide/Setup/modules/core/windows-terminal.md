---
id: windows-terminal
group: core
level: 1
method: winget
winget_id: Microsoft.WindowsTerminal
verified: 2026-10-30 (1.25.2733.0)
licence: free
size: small
---

# Windows Terminal

## When you want this
A nicer window for typing commands, with tabs. It comes with Windows 11, so this is usually just a check.

## Install (Windows)
Check first (see Verify). Only if it is missing:
```powershell
winget install --id Microsoft.WindowsTerminal --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
macOS: n/a (macOS has its own Terminal app).

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
Get-AppxPackage Microsoft.WindowsTerminal | Select-Object -ExpandProperty Version
```
Expected: matches `^\d+\.\d+\.\d+\.\d+$` (for example `1.24.12741.0`). Any version is fine. Empty output means it
is not installed.

## First run (the human's steps)
1. Press the Windows key, type **Terminal**, and open it. This is where you will run commands by hand when a module asks you to.

## Gotchas
- A newer version in winget than on your PC is normal: the Store updates it for you.
