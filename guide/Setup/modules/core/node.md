---
id: node
group: core
level: 1
method: winget
winget_id: OpenJS.NodeJS.LTS
verified: 2026-10-30 (26.13.0)
licence: free
size: medium
---

# Node.js

## When you want this
Node.js runs many agent tools and small web projects, and `npm` (installed with it) downloads them. Needed for the
optional pixel-art agent tool and the Level 2 team tools.

## Install (Windows)
```powershell
winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
```
Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad (or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install node` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
node --version
```
Expected: matches `^v\d+\.\d+\.\d+$`.
```powershell
npm.cmd --version
```
Expected: matches `^\d+\.\d+\.\d+$`.
Why `npm.cmd`: a fresh Windows PowerShell blocks scripts, so plain `npm` (a `.ps1` file) can fail with "running scripts is
disabled". `npm.cmd` works under every policy. Use it for every npm command in the kit.

## First run (the human's steps)
None.

## Gotchas
- Use `npm.cmd` (and `npx.cmd`) instead of `npm` (`npx`) in PowerShell. Do not change the execution policy.
