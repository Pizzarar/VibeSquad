---
id: codex
group: providers
level: 1
method: web
winget_id: n/a
verified: 2026-11-01 (install commands read from https://github.com/openai/codex; not run on this PC; npm package @openai/codex 0.166.0 was seen 2026-10-30)
licence: own
size: small
---

# OpenAI Codex CLI

## When you want this
Pick this if you already pay for ChatGPT (Plus, Pro, Business, Edu or Enterprise). Codex is one provider inside
VibeSquad. You bring your own account; this page only shows how to get the tool.

## Install (Windows)
Official page (fetched 2026-11-01): https://github.com/openai/codex

Recommended, in **PowerShell**:
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```
Alternative if you have `node` (core module): `npm.cmd install -g @openai/codex`

Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad
(or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install --cask codex` or `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (both from the same
official page; UNVERIFIED: not tested on a Mac).

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
codex --version
```
Expected: a version matching `^\d+\.\d+\.\d+` (a `codex` prefix is fine).

## First run (the human's steps)
1. Run `codex` once. Choose **Sign in with ChatGPT**. The official page recommends this for the plans listed above.
2. An API key also works but needs extra setup (see the official page). Never paste an API key into the chat or a
   file. Enter it only in the tool's own prompt.
3. Then in VibeSquad, make a profile for it under **⚙ SETTINGS**, **AGENT PROFILES** (**PROVIDER** and **MODEL**), and pick that profile in **PROFILE** (**+ NEW AGENT**) or **BRAINSTORM PROFILE** (**+ TEAM**) when you start a chat. You cannot change the provider of a chat that is already running. Whether the `PROVIDER` list shows Codex under that name: UNVERIFIED.

## Gotchas
- In PowerShell use `codex.cmd` if a command says "running scripts is disabled".
- Codex plans and limits change. Check your ChatGPT plan before you rely on it.
- Versions move fast; the number above was current on 2026-10-30.
