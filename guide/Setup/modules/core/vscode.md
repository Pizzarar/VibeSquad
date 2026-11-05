---
id: vscode
group: core
level: 1
method: winget
winget_id: Microsoft.VisualStudioCode
verified: 2026-10-30 (1.143.1)
licence: free
size: medium
---

# Visual Studio Code

## When you want this
A friendly free editor for looking at and editing the files in your projects (scripts, SVGs, notes). Handy even if
you never write code.

## Install (Windows)
```powershell
winget install --id Microsoft.VisualStudioCode --exact --accept-package-agreements --accept-source-agreements
```
Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad (or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install --cask visual-studio-code` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
code --version
```
Expected: the first line matches `^\d+\.\d+\.\d+`.

## First run (the human's steps)
1. Open VS Code once from the Start menu.
2. Signing in is optional. You can skip it.

## Gotchas
- `code` not found: run the PATH refresh (see `START_HERE.md`), then restart your chat in VibeSquad if needed.
