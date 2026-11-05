---
id: gh
group: core
level: 1
method: winget
winget_id: GitHub.cli
verified: 2026-10-30 (2.103.3)
licence: free
size: small
---

# GitHub CLI (`gh`)

## When you want this
`gh` lets the agent and you talk to GitHub (log in, clone, open pull requests) without fiddling with passwords.
You need a free GitHub account to use it.

## Install (Windows)
```powershell
winget install --id GitHub.cli --exact --accept-package-agreements --accept-source-agreements
```
Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad (or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install gh` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
gh --version
```
Expected: first line matches `^gh version \d+\.\d+\.\d+`.

After the logins phase, also run:
```powershell
gh auth status
```
Expected: contains `Logged in to github.com`.

## First run (the human's steps)
1. You run `gh auth login` in your own PowerShell window (it uses arrow-key menus the agent can't answer). Choose **GitHub.com**, then **HTTPS**, then **Yes** to authenticate Git, then **Login with a web browser**.
2. Copy the one-time code it shows, paste it in the browser page, and approve.

## Gotchas
- Never paste a token into the chat. Use the browser login.
- No GitHub account yet? Make a free one in your browser first, then continue.
