---
id: claude-code
group: providers
level: 1
method: web
winget_id: Anthropic.ClaudeCode
verified: 2026-10-30 (winget 2.1.302; native command checked against the official docs on 2026-10-30)
licence: own
size: medium
---

# Claude Code

## When you want this
Pick this if you pay for a Claude plan. Claude Code is one provider inside VibeSquad: it is the AI that does the
work in your Buddy, Lead and worker chats. If you already installed it, this page is here so the run can verify it,
and so you can fix or update it later.

## Install (Windows)
Recommended: the native installer. Run in **PowerShell** (not CMD), no admin needed:
```powershell
irm https://claude.ai/install.ps1 | iex
```
Source (official docs, fetched 2026-10-30): https://code.claude.com/docs/en/setup

It shows no progress while downloading. When it finishes, run the PATH refresh (see `START_HERE.md`). If Verify still fails, close and reopen `claude` in the `guide` folder (or open a **new** terminal window if you are doing this by hand).

Fallback, only if the native installer fails (winget copies update by hand and can lag a few versions behind):
```powershell
winget install --id Anthropic.ClaudeCode --exact --accept-package-agreements --accept-source-agreements
```
The winget route checks the package hash before it installs.
Update later: `claude update` (native) or `winget upgrade Anthropic.ClaudeCode` (winget).

## macOS line
`macOS: curl -fsSL https://claude.ai/install.sh | bash` (from the same official docs page; UNVERIFIED: not tested on
a Mac). Homebrew alternative from the same page: `brew install --cask claude-code`.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
claude --version
```
Expected: matches `^\d+\.\d+\.\d+ \(Claude Code\)`.

Optional health check:
```powershell
claude doctor
```
Expected: prints install and settings diagnostics without starting a session.

## First run (the human's steps)
1. Run `claude` in any folder. Follow the browser login.
2. You need a Claude account on a plan that includes Claude Code (the docs list Pro, Max, Ultra, Team, Enterprise or a
   Console account; the free plan does not include it). Plans and prices: https://claude.com/pricing
3. Use your own account. Never share a login.

## Gotchas
- `claude` is "not recognized": run the PATH refresh (see `START_HERE.md`). If it still fails, see
  https://code.claude.com/docs/en/troubleshoot-install
- `The token '&&' is not a valid statement separator` or `'irm' is not recognized` means you used the wrong shell for
  the command. `irm ... | iex` is for PowerShell; the CMD version is on the docs page above.
- Git for Windows is recommended but optional per the docs: with it, Claude Code uses Git Bash for shell commands;
  without it, it uses PowerShell. This kit installs Git first anyway.
